#!/usr/bin/env node
// Bench harness for the Tripo character spike: renders the same beats twice —
// once with the shipping procedural Esteban, once with him possessed by the
// BoneActor (engine/bone-actor.js) driving the rigged Tripo model — into
// shots/bench/<beat>-proc.png / -tripo.png pairs, in the real courtyard with
// the real scene lighting. Nothing about the shipping page changes: the swap
// happens by importing bone-actor.js into the live page after load.
//
//   node tools/bench-shot.mjs                 # both variants, all beats
//   node tools/bench-shot.mjs --only tripo    # just the swapped pass
//   node tools/bench-shot.mjs --beat gemelo-31 --opts '{"faceUp":0.05}'
//
// The revelacion beat re-triggers Esteban's denial line after the seek (a
// seek hushes everyone) and screenshots on an open-beak frame of the baked
// envelope, so the pair shows the lip sync actually working.

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
const ONLY = opt('only', null);            // 'proc' | 'tripo'
const BEAT = opt('beat', null);            // one beat by name
const RIG_OPTS = JSON.parse(opt('opts', '{}'));
const OUTDIR = opt('outdir', 'shots/bench');

// [name, scene, sceneSeconds, extras]
const BEATS = [
  ['encuentro-2_8', 'encuentro', 2.8, {}],            // mid-walk, entrance
  ['encuentro-6', 'encuentro', 6, {}],                // the strut, low angle
  ['encuentro-9_8', 'encuentro', 9.8, {}],            // mid-crow (extra)
  ['encuentro-14', 'encuentro', 14, {}],              // reverse close-up
  // Seek past the whip-pan settle (the cut lands at 36.0) or the frame is
  // motion smear in the dark; the line itself starts at 36.4.
  ['revelacion-36', 'revelacion', 36.8, { speak: 'dlg-2g' }],  // the denial, lip sync
  ['gemelo-31', 'gemelo', 31, {}],                    // the accuse gesture
  ['two-shot', 'encuentro', 19.5, {}],                // with Rosalinda, for scale
  // The denial beat proves the wiring but plays in near-darkness; this one is
  // the same lip sync under the warm reverse close-up, where a beak is legible.
  ['lipsync-cu', 'encuentro', 14, { speak: 'dlg-1c' }],
];

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.glb': 'model/gltf-binary', '.mp3': 'audio/mpeg',
};

const server = createServer(async (req, res) => {
  try {
    const url = decodeURIComponent(req.url.split('?')[0]);
    const path = join(ROOT, url === '/' ? 'index.html' : url);
    if (!path.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream' });
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

const report = { ok: true, variants: {}, errors: [] };
const variants = ONLY ? [ONLY] : ['proc', 'tripo'];
const beats = BEAT ? BEATS.filter((b) => b[0] === BEAT) : BEATS;

for (const variant of variants) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + (e.stack || e.message)));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__telenovela, null, { timeout: 25000 });
  await page.evaluate(() => window.__telenovela.dressed);
  await page.evaluate(() => {
    window.__telenovela.score.setEnabled(false);
    document.getElementById('start').classList.add('gone');
    document.body.classList.add('no-ui');
  });

  let swap = null;
  if (variant === 'tripo') {
    swap = await page.evaluate(async (opts) => {
      const m = await import('/engine/bone-actor.js');
      return m.benchSwapEsteban(window.__telenovela, opts);
    }, RIG_OPTS);
  }

  const shots = [];
  for (const [name, scene, at, extra] of beats) {
    await page.evaluate(([s, t]) => window.__telenovela.goTo(s, t), [scene, at]);
    await page.waitForTimeout(450);
    if (extra.speak) {
      // A seek hushes every actor; restart the line and wait for the beak.
      await page.evaluate(async (clip) => {
        const { TIMING } = await import('/episodes/e01-corazon/dialogue-timing.js');
        const t = TIMING[clip];
        if (t) window.__telenovela.actors.esteban.speak(t.env, t.dur);
      }, extra.speak);
      await page.waitForFunction(
        () => (window.__telenovela.actors.esteban.jaw ?? 0) > 0.5,
        null, { timeout: 3000 },
      ).catch(() => {});
    }
    const stats = await page.evaluate(() => window.__telenovela.measure());
    const out = join(OUTDIR, `${name}-${variant}.png`);
    await mkdir(dirname(join(ROOT, out)), { recursive: true });
    await page.screenshot({ path: join(ROOT, out), timeout: 60000, animations: 'disabled' });
    shots.push({ out, scene, at, meanLuma: stats.meanLuma, stdLuma: stats.stdLuma, shot: stats.shot });
  }
  report.variants[variant] = { swap, shots, errors: errors.slice(0, 8) };
  if (errors.length) report.ok = false;
  await page.close();
}

await browser.close();
server.close();
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exit(1);
