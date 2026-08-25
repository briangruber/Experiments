#!/usr/bin/env node
// Headless capture + smoke test.
//
//   node tools/shot.mjs --out shots/a.png --scene encuentro --at 14 --w 1280 --h 720
//   node tools/shot.mjs --contact shots/contact   # one frame per declared beat
//
// Exits non-zero on any WebGL/JS error or on a flat/black frame, so it works
// as the test suite for this prototype.

import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { dirname, join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function loadPlaywright() {
  const candidates = [
    'playwright',
    '/opt/node22/lib/node_modules/playwright/index.mjs',
    '/usr/lib/node_modules/playwright/index.mjs',
    process.env.PLAYWRIGHT_PATH,
  ].filter(Boolean);
  for (const c of candidates) {
    try { return await import(c); } catch { /* next */ }
  }
  throw new Error('playwright not found; set PLAYWRIGHT_PATH');
}

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : dflt;
};

// Scene references are ids ('bofetada') or indices ('4') — the page's
// dir.goTo takes both, so pass indices through as numbers and ids as strings.
const sceneRef = (s) => (/^\d+$/.test(s) ? +s : s);

const OUT = opt('out', 'shots/frame.png');
const SCENE = sceneRef(String(opt('scene', 0)));
const AT = +opt('at', 6);
const WIDTH = +opt('w', 1280);
const HEIGHT = +opt('h', 720);
const CONTACT = opt('contact', null);
const NO_UI = !args.includes('--ui');
// --csp serves under roughly the published page's content policy. The artifact
// viewer blocks connect-src, which means fetch() — including fetch of a data:
// URI — so the bundled soundtrack has to load without it.
const CSP = args.includes('--csp');
const CSP_HEADER = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' 'self'; "
  + "style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; "
  + "font-src data:; connect-src 'none'; worker-src blob:;";

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
};

const server = createServer(async (req, res) => {
  try {
    const url = decodeURIComponent(req.url.split('?')[0]);
    const path = join(ROOT, url === '/' ? 'index.html' : url);
    if (!path.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    const body = await readFile(path);
    const headers = { 'content-type': MIME[extname(path)] || 'application/octet-stream' };
    if (CSP) headers['content-security-policy'] = CSP_HEADER;
    res.writeHead(200, headers);
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({
  args: [
    '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
    '--ignore-gpu-blocklist', '--enable-webgl', '--disable-gpu-sandbox',
    '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required',
  ],
});
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });

const errors = [];
const logs = [];
// The CSP probe below deliberately trips the policy; its complaint is the
// point, not a failure.
const PROBE_NOISE = /data:text\/plain;base64,YQ==/;
page.on('console', (m) => {
  logs.push(`${m.type()}: ${m.text()}`);
  if (m.type() === 'error' && !PROBE_NOISE.test(m.text())) errors.push(m.text());
});
page.on('pageerror', (e) => errors.push('pageerror: ' + (e.stack || e.message)));

// --page lets the harness smoke-test the bundled single file as well as the
// module build it was built from.
const PAGE = opt('page', '/');
await page.goto(`http://127.0.0.1:${port}${PAGE.startsWith('/') ? PAGE : '/' + PAGE}`, { waitUntil: 'load' });

try {
  await page.waitForFunction(() => !!window.__telenovela, null, { timeout: 25000 });
  // The modelled props arrive after the first frame; wait for them, or half
  // the contact sheet is of a courtyard that no longer exists.
  await page.evaluate(() => window.__telenovela.dressed);
} catch {
  errors.push('window.__telenovela never appeared — startup failed');
}

// Sampling happens inside the page's own render frame — see main.js.
async function measure() {
  return page.evaluate(() => window.__telenovela.measure());
}

async function seek(scene, at) {
  await page.evaluate(([s, t]) => window.__telenovela.goTo(s, t), [scene, at]);
  // A few real frames so the springs settle and the render targets fill.
  await page.waitForTimeout(420);
}

const results = [];
let audio = null;
if (!errors.length) {
  await page.evaluate(() => {
    window.__telenovela.score.setEnabled(false);
    document.getElementById('start').classList.add('gone');
  });
  if (NO_UI) await page.evaluate(() => document.body.classList.add('no-ui'));

  // The soundtrack is half the piece; check it actually decodes rather than
  // silently falling back to the synth.
  audio = await page.evaluate(async () => {
    const T = window.__telenovela;
    // Prove the policy is really biting before trusting the result below.
    let fetchBlocked = false;
    try { await fetch('data:text/plain;base64,YQ=='); } catch { fetchBlocked = true; }
    // Press play the way a viewer does, and check the opening bed survives
    // startup. startAudio() used to force 'theme' once the soundtrack came up,
    // which crossfaded the sung titles out a beat after they started — audible
    // only on a replay, never on first play, and invisible to every other
    // check here because they all start the soundtrack directly.
    document.getElementById('play')?.click();
    await T.soundtrack.start();
    await new Promise((r) => setTimeout(r, 2500));
    const openingBed = T.soundtrack.bed ? T.soundtrack.bed.name : null;
    // Not start()'s return value: pressing play already started it, so a
    // second call returns whatever `ready` happened to be mid-decode.
    const ok = T.soundtrack.ready && !T.soundtrack.failed;
    // The music beds are the last to finish decoding; sampling at a fixed 2.5s
    // reported five clips short on every single run and looked like a failure.
    const total = Object.keys(T.soundtrack.manifest).length;
    for (let i = 0; i < 60 && T.soundtrack.buffers.size < total; i++) {
      await new Promise((r) => setTimeout(r, 250));
    }
    // Music beds must never stack. Ask for the same bed twice while it is
    // still decoding, then switch — the shape that once left the opening theme
    // looping under the whole episode.
    T.soundtrack.setMood('storm', 0.2);
    T.soundtrack.setMood('storm', 0.2);
    T.soundtrack.setMood('tragedy', 0.2);
    await new Promise((r) => setTimeout(r, 2500));
    const beds = T.soundtrack.beds ? T.soundtrack.beds.size : -1;
    T.soundtrack.setMood('silence', 0.2);
    return {
      ok, ready: T.soundtrack.ready, failed: T.soundtrack.failed,
      clips: Object.keys(T.soundtrack.manifest).length,
      decoded: T.soundtrack.buffers.size,
      missing: Object.keys(T.soundtrack.manifest).filter((n) => !T.soundtrack.buffers.has(n)),
      openingBed, wantOpeningBed: T.soundtrack.manifest['mus-opening'] ? 'mus-opening' : null,
      fetchBlocked, beds,
    };
  });
  await page.evaluate(() => window.__telenovela.soundtrack.setEnabled(false));

  // e.g. --frames 0:3,encuentro:16.5,5:35 — a scene id or index, then a time.
  const FRAMES = opt('frames', null);
  const list = FRAMES
    ? FRAMES.split(',').map((p) => {
      const i = p.lastIndexOf(':');
      return [sceneRef(p.slice(0, i)), +p.slice(i + 1)];
    })
    // The contact sheet is the episode's own list of beats worth looking at —
    // each scene module declares them in its meta, so this tool has no scene
    // knowledge of its own.
    : CONTACT ? await page.evaluate(() => {
      const E = window.__telenovela.episode;
      return E.order.flatMap((id) => E.beats[id].map((t) => [id, t]));
    })
      : [[SCENE, AT]];
  for (let i = 0; i < list.length; i++) {
    const [s, t] = list[i];
    await seek(s, t);
    // Pin the frame before judging it. measure() samples the canvas inside
    // the page's own render loop, but page.screenshot() is a separate CDP
    // round trip that can land seconds later on a contended CPU — long
    // enough for the scene's wall clock to run on into a fade, so the report
    // would swear a frame was lit while the saved PNG was black. Pausing the
    // Director stops the scene clock (no new cues, no scene advance) and
    // parking the caption clock keeps the card that was measured on screen;
    // the springs have already settled during seek()'s real-frame wait, so
    // nothing this freezes was still in flight.
    await page.evaluate(() => {
      const T = window.__telenovela;
      T.dir.paused = true;
      const titles = T.dir.ctx.titles;
      if (!titles.__realUpdate) { titles.__realUpdate = titles.update; titles.update = () => {}; }
    });
    const stats = await measure();
    const out = list.length > 1
      ? join(CONTACT || dirname(OUT), `${String(i).padStart(2, '0')}-${s}-t${String(t).replace('.', '_')}.png`)
      : OUT;
    await mkdir(dirname(join(ROOT, out)), { recursive: true });
    await page.screenshot({ path: join(ROOT, out), timeout: 60000, animations: 'disabled' });
    await page.evaluate(() => {
      const T = window.__telenovela;
      T.dir.paused = false;
      const titles = T.dir.ctx.titles;
      if (titles.__realUpdate) { titles.update = titles.__realUpdate; delete titles.__realUpdate; }
    });
    results.push({ out, scene: s, at: t, ...stats });
  }
}

await browser.close();
server.close();

const lit = results.filter((r) => r.stdLuma > 2 && r.maxLuma > 24);
// Music beds load on demand — that is deliberate, they are the big files. But
// every one-shot must be resident, because a dialogue line that failed to
// decode is a character who silently does not speak, and nothing else in the
// frame would tell you.
const audioOk = !audio || audio.clips === 0
  || (audio.ready && audio.beds === 1
    && (audio.missing || []).every((n) => n.startsWith('mus-'))
    && (!audio.wantOpeningBed || audio.openingBed === audio.wantOpeningBed));
const report = {
  ok: errors.length === 0 && results.length > 0 && lit.length === results.length && audioOk,
  frames: results.length,
  lit: lit.length,
  audio,
  results,
  errors: errors.slice(0, 12),
};
console.log(JSON.stringify(report, null, 2));
if (!report.ok) {
  if (!audioOk) console.error('\nSOUNDTRACK PROBLEM (every non-music clip must decode, exactly 1 bed, and the opening bed must survive startup): ' + JSON.stringify(audio));
  if (!errors.length && lit.length !== results.length) console.error('\nDARK/FLAT FRAMES: ' + results.filter((r) => !lit.includes(r)).map((r) => r.out).join(', '));
  console.error(logs.slice(-40).join('\n'));
  process.exit(1);
}
