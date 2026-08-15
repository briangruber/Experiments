#!/usr/bin/env node
// Render the episode to a video file without recording the screen.
//
//   node tools/render.mjs --cut trailer --out dist/trailer.mp4
//   node tools/render.mjs --cut episode --fps 30 --w 1280 --h 720
//
// On real hardware (not a headless CI box with no GPU), add:
//
//   --gpu     use the machine's real GPU for the three.js rendering step
//             instead of software rasterisation. This is the actual
//             bottleneck — frames are stepped and captured one at a time,
//             so rendering speed IS render speed. Off by default because
//             the default args force software rendering unconditionally,
//             which is correct on a box with no GPU and merely slow on one
//             that has a good one.
//   --hw      encode with the GPU's hardware H.264 encoder (VideoToolbox on
//             macOS) instead of libx264. Much faster; slightly less
//             efficient per bit at the same bitrate, so --hwbitrate defaults
//             high to compensate. Silent no-op if this ffmpeg has no
//             hardware encoder.
//
// Screen recording asks the browser to hand frames to an encoder in real time
// while the page stays visible and keeps up. This does not: the world is
// stepped by a fixed amount per frame, every frame is captured, and the
// soundtrack is rendered separately through an OfflineAudioContext against the
// same clock. Slower than watching it, and it cannot drop a frame.
//
// Needs ffmpeg. Playwright ships one and it will be found automatically.

import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };

const CUT = opt('cut', 'trailer');
const FPS = +opt('fps', 30);
const WIDTH = +opt('w', CUT === 'trailer' ? 1280 : 960);
const HEIGHT = +opt('h', CUT === 'trailer' ? 720 : 540);
const CRF = +opt('crf', 20);          // lower is better; 16-18 is near-transparent
const PRESET = opt('preset', 'medium'); // x264 speed/efficiency: slow, slower, veryslow
const ABR = opt('abr', '160k');         // audio bitrate for the mux
const LIMIT = +opt('seconds', 0);       // cap the render, for trying settings out
const VBR = opt('vbr', '4M');           // VP8 only; VP9 and x264 use --crf
// Write the rendered soundtrack next to the video even when this ffmpeg has no
// audio encoder to mux it with — a silent file plus a WAV can still be joined
// somewhere else, which beats losing half the piece.
const KEEP_WAV = args.includes('--wav');
// The page is asked first whether it can encode the file itself (WebCodecs
// H.264 + AAC, muxed in-page — see engine/exporter.js); --pipe skips that and
// forces the JPEG→ffmpeg pipe, for comparing the two or distrusting one.
const FORCE_PIPE = args.includes('--pipe');
const KBPS = +opt('kbps', 0);           // WebCodecs path only; 0 = pick from size
const USE_GPU = args.includes('--gpu');
const USE_HW_ENCODE = args.includes('--hw');
const HWBITRATE = opt('hwbitrate', '14M');   // VideoToolbox has no --crf equivalent worth trusting
const OUT = resolve(ROOT, opt('out', `dist/corazon-de-gallina-${CUT}.mp4`));

function findFfmpeg() {
  if (process.env.FFMPEG) return process.env.FFMPEG;
  const candidates = [
    '/opt/pw-browsers/ffmpeg-1011/ffmpeg-linux',
    ...(process.env.PLAYWRIGHT_BROWSERS_PATH
      ? [join(process.env.PLAYWRIGHT_BROWSERS_PATH, 'ffmpeg-1011', 'ffmpeg-linux')] : []),
    '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg',
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return 'ffmpeg';   // hope it is on PATH
}
const FFMPEG = findFfmpeg();

// What can this ffmpeg actually do? Playwright ships a stripped build with VP8
// and nothing else, which is worth finding out now rather than by watching a
// pipe stall.
function ffCan() {
  const { execFileSync } = require('node:child_process');
  try {
    const out = execFileSync(FFMPEG, ['-hide_banner', '-encoders'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    // Frames arrive as JPEG on stdin, so the DEcoder matters as much as the
    // encoders. Playwright's bundled build has neither, and without this check
    // the failure arrives as "Could not find codec parameters for stream 0"
    // several seconds into a render.
    const dec = execFileSync(FFMPEG, ['-hide_banner', '-decoders'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return {
      mjpeg: /\bmjpeg\b/.test(dec),
      x264: /\blibx264\b/.test(out),
      videotoolbox: /\bh264_videotoolbox\b/.test(out),
      aac: /\baac\b/.test(out),
      vp9: /\blibvpx-vp9\b/.test(out),
      vpx: /\blibvpx\b/.test(out),
      opus: /\blibopus\b/.test(out),
    };
  } catch {
    return null;
  }
}

async function loadPlaywright() {
  for (const c of ['playwright', '/opt/node22/lib/node_modules/playwright/index.mjs',
    '/usr/lib/node_modules/playwright/index.mjs', process.env.PLAYWRIGHT_PATH].filter(Boolean)) {
    try { return await import(c); } catch { /* next */ }
  }
  throw new Error('playwright not found; npm i -D playwright, or set PLAYWRIGHT_PATH');
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css', '.mp3': 'audio/mpeg',
};
const server = createServer(async (req, res) => {
  try {
    const url = decodeURIComponent(req.url.split('?')[0]);
    const path = join(ROOT, url === '/' ? 'index.html' : url);
    if (!path.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    res.writeHead(200, { 'content-type': MIME[path.slice(path.lastIndexOf('.'))] || 'application/octet-stream' });
    res.end(await readFile(path));
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({
  args: USE_GPU
    // Let Chromium pick its real GPU backend (Metal on macOS, whatever ANGLE
    // finds elsewhere) instead of forcing software. Not verified against real
    // hardware from here — this sandbox has none — so if the canvas comes back
    // black, rerun without --gpu and file it as a bug.
    ? ['--ignore-gpu-blocklist', '--enable-webgl', '--disable-gpu-sandbox',
      '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required']
    : ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist',
      '--enable-webgl', '--disable-gpu-sandbox', '--disable-dev-shm-usage',
      '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error('page error:', (e.stack || e.message).slice(0, 300)));

await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__telenovela, null, { timeout: 30000 });
// The modelled props load after the first frame; without this the opening
// seconds render a courtyard that is missing its fountain.
await page.evaluate(() => window.__telenovela.dressed);

// How long is this cut? The trailer's shot list and the episode's length both
// live in the page, so ask rather than duplicate them here. The episode's
// length is measured (fullSeconds), not summed from dur/pace: slow-motion
// cues stretch wall time, and the naive sum truncated exports mid-credits.
const seconds = await page.evaluate((cut) => {
  const T = window.__telenovela;
  if (cut === 'episode') return T.fullSeconds();
  return null;   // the trailer is driven segment by segment below
}, CUT);

const trailer = CUT === 'trailer';
const segments = trailer
  ? await page.evaluate(() => window.__telenovela.CUTS.trailer.segments)
  : null;
const totalSeconds = trailer ? segments.reduce((a, s) => a + s[2], 0) : seconds;

// --- in-page WebCodecs first -------------------------------------------------
// If the browser can encode H.264 itself, the whole export runs inside the
// page — same stepped world, frames handed to a VideoEncoder as VideoFrames
// instead of being toDataURL'd (which measured as 99% of frame time), muxed by
// engine/mp4.js — and ffmpeg is never involved. This is the exact code path
// the export button uses, so a file made here is a file the button would make.
const probe = FORCE_PIPE ? null : await page.evaluate(
  (o) => window.__telenovela.exportProbe(o),
  { width: WIDTH, height: HEIGHT, fps: FPS },
).catch(() => null);
if (probe && probe.ok) {
  console.log(`${CUT}: ${totalSeconds.toFixed(1)}s at ${FPS}fps, ${WIDTH}x${HEIGHT}`);
  console.log(`render: ${USE_GPU ? 'GPU (hardware WebGL)' : 'software (SwiftShader) — try --gpu on a machine with a real GPU'}`);
  console.log(`encode: in-page WebCodecs ${probe.video}${probe.audio ? ' + AAC' : ' — no AAC encoder; silent mp4 + WAV beside it'}`);

  // Fire and poll rather than awaiting: a full episode is minutes of work and
  // a single evaluate that long is a connection timeout waiting to happen.
  await page.evaluate((o) => { window.__telenovela.exportRun(o); return true; }, {
    cut: CUT, fps: FPS, width: WIDTH, height: HEIGHT,
    seconds: LIMIT || 0, videoBitrate: KBPS ? KBPS * 1000 : 0,
  });
  let st = null;
  const t0 = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 500));
    st = await page.evaluate(() => window.__telenovela.exportStatus());
    if (!st || st.state !== 'running') break;
    const rate = st.done / ((Date.now() - t0) / 1000);
    process.stdout.write(st.phase === 'audio'
      ? `\r  soundtrack…                                   `
      : `\r  ${st.done}/${st.total} frames (${((st.done / Math.max(1, st.total)) * 100).toFixed(0)}%) · ${rate.toFixed(1)} fps   `);
  }
  process.stdout.write('\n');
  if (!st || st.state !== 'done') {
    console.error(`in-page export failed: ${st ? st.error : 'no status'}`);
    await browser.close(); server.close();
    process.exit(1);
  }

  // Pull the file out in slices: one evaluate returning the whole thing blows
  // the CDP message limit. ~6 MB of bytes is ~8 MB of base64 per round trip.
  const pull = async (kind, size, path) => {
    const STEP = 6 * 1024 * 1024;
    const parts = [];
    for (let off = 0; off < size; off += STEP) {
      const b64 = await page.evaluate(
        ([k, o, n]) => window.__telenovela.exportSlice(k, o, n), [kind, off, STEP]);
      parts.push(Buffer.from(b64, 'base64'));
    }
    await writeFile(path, Buffer.concat(parts));
  };
  await mkdir(dirname(OUT), { recursive: true });
  const outPath = OUT.replace(/\.(mp4|webm)$/i, '') + '.mp4';
  await pull('video', st.size, outPath);
  if (st.silent && st.wavSize) {
    const wavPath = outPath.replace(/\.mp4$/, '.wav');
    await pull('wav', st.wavSize, wavPath);
    console.log(`${wavPath}\n  the soundtrack, unmuxed — this browser has no AAC encoder`);
  }
  await browser.close();
  server.close();
  const info = await stat(outPath);
  console.log(`${outPath}\n  ${st.frames} frames · ${(st.frames / FPS).toFixed(1)}s · ${(info.size / 1048576).toFixed(1)} MB`);
  process.exit(0);
}
if (!FORCE_PIPE) {
  console.log(`WebCodecs: ${probe && probe.reason ? probe.reason : 'unavailable'} — falling back to the JPEG→ffmpeg pipe`);
}

const can = ffCan();
if (!can) {
  console.error(`could not run ffmpeg at ${FFMPEG}.\nInstall one (brew install ffmpeg / apt install ffmpeg) or set FFMPEG=/path/to/ffmpeg`);
  await browser.close(); server.close();
  process.exit(1);
}
if (!can.mjpeg) {
  console.error(`the ffmpeg at ${FFMPEG} cannot decode JPEG, which is how frames reach it.`);
  console.error('This is Playwright\'s bundled build; it ships an encoder or two and little else.');
  console.error('Install a real one (brew install ffmpeg / apt install ffmpeg) and either put it');
  console.error('on PATH or run with FFMPEG=/path/to/ffmpeg.');
  await browser.close(); server.close();
  process.exit(1);
}
const VIDEO_ONLY = args.includes('--silent') || !can.aac;
if (USE_HW_ENCODE && !can.videotoolbox) {
  console.warn('--hw requested but this ffmpeg has no h264_videotoolbox; using software encode.');
}
// --hw first, if it is actually available. Otherwise best software encoder:
// VP9 at the same CRF is close to x264 and far better than VP8, which is the
// last resort rather than the fallback.
const HW = USE_HW_ENCODE && can.videotoolbox;
const VCODEC = HW
  ? ['-c:v', 'h264_videotoolbox', '-b:v', HWBITRATE, '-profile:v', 'high']
  : can.x264
    ? ['-c:v', 'libx264', '-preset', PRESET, '-crf', String(CRF), '-profile:v', 'high', '-level', '4.1']
    : can.vp9 ? ['-c:v', 'libvpx-vp9', '-crf', String(CRF), '-b:v', '0', '-row-mt', '1']
      : can.vpx ? ['-c:v', 'libvpx', '-b:v', VBR] : null;
if (!VCODEC) {
  console.error(`the ffmpeg at ${FFMPEG} has no usable video encoder (needs libx264, libvpx-vp9 or libvpx).`);
  await browser.close(); server.close();
  process.exit(1);
}
const H264 = HW || can.x264;
const CONTAINER = H264 ? 'mp4' : 'webm';
const VLABEL = HW ? `H.264 VideoToolbox (hardware) ${HWBITRATE}`
  : can.x264 ? `H.264 crf ${CRF} preset ${PRESET}` : can.vp9 ? `VP9 crf ${CRF}` : 'VP8';
const OUT_PATH = OUT.replace(/\.(mp4|webm)$/i, '') + '.' + CONTAINER;

console.log(`${CUT}: ${totalSeconds.toFixed(1)}s at ${FPS}fps, ${WIDTH}x${HEIGHT}`);
console.log(`render: ${USE_GPU ? 'GPU (hardware WebGL)' : 'software (SwiftShader) — try --gpu on a machine with a real GPU'}`);
console.log(`ffmpeg: ${FFMPEG} (${VLABEL}${VIDEO_ONLY ? ', no audio encoder — video only' : `, AAC ${ABR}`})`);
if (VIDEO_ONLY && !args.includes('--silent')) {
  console.warn('  this ffmpeg cannot encode audio; the result will be silent.');
}

// The OfflineAudioContext is allocated for exactly this many seconds and has
// to render every one of them, whether or not there is a video frame to match
// — passing the untrimmed episode length here meant a --seconds 20 test still
// paid to render all ~309 seconds of audio, most of it a looping bed nothing
// was ever going to use.
const renderSeconds = LIMIT > 0 ? Math.min(LIMIT, totalSeconds) : totalSeconds;
const begun = await page.evaluate(
  (o) => window.__telenovela.offlineBegin(o),
  { fps: FPS, width: WIDTH, height: HEIGHT, seconds: renderSeconds, quality: +opt('jpeg', 0.95) },
);
if (!begun.ok) { console.error('could not start:', begun.error); process.exit(1); }

await mkdir(dirname(OUT), { recursive: true });
const videoOnly = OUT_PATH.replace(/\.(mp4|webm)$/, '.video.' + CONTAINER);
const wavPath = OUT_PATH.replace(/\.(mp4|webm)$/, '.wav');

const ff = spawn(FFMPEG, [
  // -vcodec mjpeg is not optional: without it ffmpeg tries to probe a pipe it
  // cannot seek, gives up with "Could not find codec parameters for stream 0",
  // and writes a file with no streams in it. That is why this never produced a
  // video, and it was never the missing encoder it looked like.
  '-y', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-framerate', String(FPS), '-i', 'pipe:0',
  ...VCODEC, '-pix_fmt', 'yuv420p',
  ...(CONTAINER === 'mp4' ? ['-movflags', '+faststart'] : []),
  VIDEO_ONLY ? OUT_PATH : videoOnly,
], { stdio: ['pipe', 'ignore', 'pipe'] });
let ffErr = '';
let ffDead = null;
ff.stderr.on('data', (d) => { ffErr += d.toString(); });
ff.on('error', (e) => { ffDead = e; });
ff.on('close', (code) => {
  if (code !== 0 && ffDead === null) {
    ffDead = new Error(`ffmpeg exited ${code}. It may lack the mjpeg decoder this needs.\n${ffErr.slice(-900)}`);
  }
});

// If ffmpeg dies, the pipe stops draining; without this the loop waits forever.
const write = (buf) => new Promise((res, rej) => {
  if (ffDead) { rej(ffDead); return; }
  const onErr = (e) => rej(e);
  ff.stdin.once('error', onErr);
  if (ff.stdin.write(buf)) { ff.stdin.off('error', onErr); res(); }
  else ff.stdin.once('drain', () => { ff.stdin.off('error', onErr); res(); });
});

// Step the world and collect frames. For the trailer, jump to each beat first.
const total = Math.ceil((LIMIT > 0 ? Math.min(LIMIT, totalSeconds) : totalSeconds) * FPS);
let done = 0, segIndex = -1, segFramesLeft = 0;
const t0 = Date.now();
for (let i = 0; i < total; i++) {
  if (trailer && segFramesLeft <= 0) {
    segIndex++;
    const seg = segments[segIndex];
    if (!seg) break;
    segFramesLeft = Math.round(seg[2] * FPS);
    // seg[0] is a scene id; the page's dir.goTo resolves it (indices work too).
    await page.evaluate(([s, t]) => { window.__telenovela.dir.goTo(s); window.__telenovela.seekWithin(t); }, [seg[0], seg[1]]);
  }
  const b64 = await page.evaluate(() => window.__telenovela.offlineFrame());
  if (!b64) break;
  try {
    await write(Buffer.from(b64, 'base64'));
  } catch (e) {
    console.error(`\nffmpeg stopped accepting frames: ${e.message}`);
    console.error(`Install a full ffmpeg (brew install ffmpeg) and set FFMPEG=/path/to/ffmpeg.`);
    await browser.close(); server.close();
    process.exit(1);
  }
  segFramesLeft--;
  done++;
  if (done % FPS === 0 || done === total) {
    const pct = ((done / total) * 100).toFixed(0);
    const rate = done / ((Date.now() - t0) / 1000);
    process.stdout.write(`\r  ${done}/${total} frames (${pct}%) · ${rate.toFixed(1)} fps   `);
  }
}
process.stdout.write('\n');

ff.stdin.end();
await new Promise((res, rej) => {
  if (ff.exitCode !== null) return ff.exitCode === 0 ? res() : rej(new Error(`ffmpeg exited ${ff.exitCode}\n${ffErr.slice(-1500)}`));
  ff.on('close', (code) => (code === 0 ? res() : rej(new Error(`ffmpeg exited ${code}\n${ffErr.slice(-1500)}`))));
});

const wav = (VIDEO_ONLY && !KEEP_WAV) ? null : (console.log('rendering the soundtrack…'),
  await page.evaluate(() => window.__telenovela.offlineAudio()));
await browser.close();
server.close();
if (wav) await writeFile(wavPath, Buffer.from(wav, 'base64'));
if (wav && VIDEO_ONLY) {
  console.log(`${wavPath}\n  the soundtrack, unmuxed — this ffmpeg has no audio encoder`);
}

// Mux. Copy the video through untouched; only the audio needs encoding.
if (wav && !VIDEO_ONLY) {
  await new Promise((res, rej) => {
    const mux = spawn(FFMPEG, [
      '-y', '-i', videoOnly, '-i', wavPath,
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', ABR, '-shortest',
      '-movflags', '+faststart', OUT_PATH,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    mux.stderr.on('data', (d) => { err += d.toString(); });
    mux.on('close', (code) => (code === 0 ? res() : rej(new Error(`mux failed ${code}\n${err.slice(-1500)}`))));
  });
  await rm(videoOnly, { force: true });
  await rm(wavPath, { force: true });
}

const info = await stat(OUT_PATH);
console.log(`${OUT_PATH}\n  ${done} frames · ${(done / FPS).toFixed(1)}s · ${(info.size / 1048576).toFixed(1)} MB`);
