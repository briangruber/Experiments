#!/usr/bin/env node
// Bench harness for the Tripo cast: renders the same beats twice — once with
// the shipping procedural cast (?proc-cast keeps the upgrade off), once with
// the twins possessed by BoneActors driving the rigged Tripo model, exactly as
// the shipping page does it — into shots/bench/<beat>-proc.png / -tripo.png
// pairs, in the real courtyard with the real scene lighting.
//
//   node tools/bench-shot.mjs                 # both variants, all beats
//   node tools/bench-shot.mjs --only tripo    # just the swapped pass
//   node tools/bench-shot.mjs --beat gemelo-31
//   node tools/bench-shot.mjs --gestures accuse,gasp,laugh   # legibility pass
//
// Each shot reports whole-frame luma stats and `faceLuma`: the mean luma of
// the centre box (0.30–0.70 × 0.22–0.78), which is where every close-up puts
// the face — the bench gate compares that number proc vs tripo.
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
const GESTURES = opt('gestures', null);    // comma list; gesture legibility pass
const OUTDIR = opt('outdir', 'shots/bench');
const GACTOR = opt('gactor', 'esteban');

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
  ['gemelo-34', 'gemelo', 34, {}],                    // Ricardo's laugh, mid-shot
  ['two-shot', 'encuentro', 19.5, {}],                // with Rosalinda, for scale
  // The denial beat proves the wiring but plays in near-darkness; this one is
  // the same lip sync under the warm reverse close-up, where a beak is legible.
  ['lipsync-cu', 'encuentro', 14, { speak: 'dlg-1c' }],
];

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.glb': 'model/gltf-binary', '.mp3': 'audio/mpeg', '.jpg': 'image/jpeg',
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

// Mean luma of the centre box of a saved frame — the face region of every
// close-up — measured by handing the PNG back to the page.
async function faceLuma(page, pngPath) {
  const b64 = (await readFile(join(ROOT, pngPath))).toString('base64');
  return page.evaluate(async (uri) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = uri; });
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const x = Math.floor(img.width * 0.30), w = Math.floor(img.width * 0.40);
    const y = Math.floor(img.height * 0.22), h = Math.floor(img.height * 0.56);
    const d = g.getImageData(x, y, w, h).data;
    let sum = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      n++;
    }
    return +(sum / n).toFixed(2);
  }, `data:image/png;base64,${b64}`);
}

for (const variant of variants) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + (e.stack || e.message)));
  await page.goto(`http://127.0.0.1:${port}/${variant === 'proc' ? '?proc-cast' : ''}`, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__telenovela, null, { timeout: 25000 });
  // `dressed` covers the cast upgrade too; `castReady` says what actually swapped.
  await page.evaluate(() => window.__telenovela.dressed);
  const swap = await page.evaluate(() => window.__telenovela.castReady);
  await page.evaluate(() => {
    window.__telenovela.score.setEnabled(false);
    document.getElementById('start').classList.add('gone');
    document.body.classList.add('no-ui');
  });
  if (variant === 'tripo' && !swap.ok) errors.push('tripo cast did not swap: ' + JSON.stringify(swap));

  const shots = [];
  if (GESTURES) {
    // Gesture legibility: park the named actor on a lit mark, fire each
    // gesture and shoot near its apex.
    for (const name of GESTURES.split(',')) {
      await page.evaluate(([actorKey]) => {
        const T = window.__telenovela;
        T.goTo('encuentro', 18.5);
        const est = T.actors.esteban;
        const a = T.actors[actorKey];
        if (a !== est) {
          // Stand in on Esteban's lit mark, facing his way, so the camera's
          // framing carries over.
          a.setVisible(true);
          a.place(est.pos.x, est.pos.z, est.yaw);
          est.setVisible(false);
        }
        a.clearGestures();
      }, [GACTOR]);
      await page.waitForTimeout(350);
      const apex = await page.evaluate(([actorKey, gname]) => {
        const T = window.__telenovela;
        const a = T.actors[actorKey];
        a.gesture(gname, gname === 'accuse' ? { side: 1 } : {});
        const g = a.gestures.find((x) => x.name === gname);
        return g ? Math.min(1.4, (g.dur || 2) * 0.42) : 0.8;
      }, [GACTOR, name]);
      await page.waitForTimeout(apex * 1000);
      const out = join(OUTDIR, `gesture-${name}-${GACTOR}-${variant}.png`);
      await mkdir(dirname(join(ROOT, out)), { recursive: true });
      await page.screenshot({ path: join(ROOT, out), timeout: 60000, animations: 'disabled' });
      shots.push({ out, gesture: name });
    }
  }
  for (const [name, scene, at, extra] of (GESTURES ? [] : beats)) {
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
    const face = await faceLuma(page, out);
    shots.push({ out, scene, at, meanLuma: stats.meanLuma, stdLuma: stats.stdLuma, faceLuma: face, shot: stats.shot });
  }
  report.variants[variant] = { swap, shots, errors: errors.slice(0, 8) };
  if (errors.length) report.ok = false;
  await page.close();
}

await browser.close();
server.close();
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exit(1);
