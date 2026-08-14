#!/usr/bin/env node
// Headless capture + smoke test.
//
//   node tools/shot.mjs --out shots/a.png --scene 2 --at 14 --w 1280 --h 720
//   node tools/shot.mjs --contact shots/contact          # one frame per beat
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

const OUT = opt('out', 'shots/frame.png');
const SCENE = +opt('scene', 0);
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

// One frame from each act, chosen to land on a beat worth looking at.
const CONTACT_SHEET = [
  [0, 5], [0, 12], [0, 19], [0, 24],
  [1, 3], [1, 20], [1, 27],
  [2, 1.5], [2, 3], [2, 6], [2, 14], [2, 26], [2, 39],
  [3, 10], [3, 16.5], [3, 22], [3, 28], [3, 34],
  [4, 5], [4, 14.2], [4, 18], [4, 27],
  [5, 8], [5, 14], [5, 20], [5, 27], [5, 40],
  [6, 6], [6, 13], [6, 29], [6, 35], [6, 40],
  [7, 2], [7, 11], [7, 21], [7, 30], [7, 47],
];

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
    const ok = await T.soundtrack.start();
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
      fetchBlocked, beds,
    };
  });
  await page.evaluate(() => window.__telenovela.soundtrack.setEnabled(false));

  const FRAMES = opt('frames', null);   // e.g. --frames 0:3,2:16.5,5:35
  const list = FRAMES
    ? FRAMES.split(',').map((p) => p.split(':').map(Number))
    : CONTACT ? CONTACT_SHEET : [[SCENE, AT]];
  for (let i = 0; i < list.length; i++) {
    const [s, t] = list[i];
    await seek(s, t);
    const stats = await measure();
    const out = list.length > 1
      ? join(CONTACT || dirname(OUT), `${String(i).padStart(2, '0')}-s${s}-t${String(t).replace('.', '_')}.png`)
      : OUT;
    await mkdir(dirname(join(ROOT, out)), { recursive: true });
    await page.screenshot({ path: join(ROOT, out), timeout: 60000, animations: 'disabled' });
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
  || (audio.ready && audio.beds === 1 && (audio.missing || []).every((n) => n.startsWith('mus-')));
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
  if (!audioOk) console.error('\nSOUNDTRACK PROBLEM (every non-music clip must decode, beds must be exactly 1): ' + JSON.stringify(audio));
  if (!errors.length && lit.length !== results.length) console.error('\nDARK/FLAT FRAMES: ' + results.filter((r) => !lit.includes(r)).map((r) => r.out).join(', '));
  console.error(logs.slice(-40).join('\n'));
  process.exit(1);
}
