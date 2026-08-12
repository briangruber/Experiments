#!/usr/bin/env node
// Smoke test for the Three.js examples.
//
//   node tools/check-examples.mjs [--wait 12000] [--shots shots/]
//
// Loads each examples/*.html in a headless browser, fails on any JS or WebGL
// error, and fails on a frame that came out blank or uniform - which is what a
// broken shared-context integration usually looks like rather than a thrown
// error.
//
// The examples reference Three from a CDN, because that is what a reader wants to
// copy. Reaching the network from a test is a different matter, so requests to
// the CDN are fulfilled from the locally installed `three` instead. That keeps the
// example honest and the test hermetic. Run `npm install` first.

import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { launchChromium } from './browser.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const WAIT = +argOf('wait', 12000);
const SHOTS = argOf('shots', join(ROOT, 'shots'));
const W = +argOf('w', 640), H = +argOf('h', 400);

const PAGES = ['water-and-sky.html', 'water-only.html', 'sky-only.html'];

// three's package.json is not in its exports map, so require.resolve cannot find
// the package root. Walk up looking for the install instead.
function resolveThree() {
  let dir = ROOT;
  for (let i = 0; i < 6; i++) {
    const cand = join(dir, 'node_modules', 'three');
    if (existsSync(join(cand, 'build', 'three.module.js'))) return cand;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error('three is not installed. Run `npm install` in ocean/ first.');
}

const THREE_DIR = resolveThree();

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
    res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const browser = await launchChromium();

await mkdir(SHOTS, { recursive: true });
const report = [];

for (const name of PAGES) {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + (e.stack || e.message)));

  // Serve the CDN's three from node_modules.
  await page.route('https://unpkg.com/**', async (route) => {
    const u = new URL(route.request().url());
    const rel = u.pathname.replace(/^\/three@[^/]+\//, '');
    try {
      route.fulfill({ status: 200, contentType: 'text/javascript', body: await readFile(join(THREE_DIR, rel)) });
    } catch (e) {
      route.fulfill({ status: 404, body: 'not vendored: ' + rel });
    }
  });

  await page.goto(`http://127.0.0.1:${port}/examples/${name}`, { waitUntil: 'load' });
  try {
    await page.waitForFunction(() => !!window.abyssalExample, null, { timeout: 30000 });
  } catch {
    errors.push('window.abyssalExample never appeared - the module failed to start');
  }
  await page.waitForTimeout(WAIT);

  // preserveDrawingBuffer is off on a stock THREE.WebGLRenderer, so a screenshot
  // taken between frames reads a cleared buffer. Sample inside the frame instead.
  const stats = await page.evaluate(() => new Promise((done) => {
    requestAnimationFrame(() => {
      const c = document.querySelector('canvas');
      const s = document.createElement('canvas');
      // Full canvas resolution: these captures double as the screenshots in the
      // README, and a thumbnail is enough to pass the blank-frame check while
      // hiding everything a human would notice.
      s.width = Math.min(c.width, 1600); s.height = Math.round(s.width * c.height / c.width);
      const g = s.getContext('2d');
      g.drawImage(c, 0, 0, s.width, s.height);
      const d = g.getImageData(0, 0, s.width, s.height).data;
      let sum = 0, sum2 = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) {
        const y = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        sum += y; sum2 += y * y; n++;
      }
      const mean = sum / n;
      done({ mean: +mean.toFixed(2), std: +Math.sqrt(Math.max(sum2 / n - mean * mean, 0)).toFixed(2), png: s.toDataURL() });
    });
  }));

  await writeFile(join(SHOTS, name.replace('.html', '.png')),
    Buffer.from(stats.png.split(',')[1], 'base64'));

  // A frame that is uniform is a frame that did not draw. Both failure modes seen
  // while building this - a lost context and a framebuffer left bound by the
  // simulation - produce exactly that rather than an exception.
  const blank = stats.std < 3;
  report.push({ page: name, ok: errors.length === 0 && !blank, meanLuma: stats.mean, stdLuma: stats.std, errors });
  await page.close();
}

await browser.close();
server.close();

console.log(JSON.stringify(report, null, 2));
const failed = report.filter((r) => !r.ok);
for (const f of failed) {
  console.error(`\nFAIL ${f.page}: ${f.errors.length ? f.errors.join('; ') : `blank frame (stdLuma ${f.stdLuma})`}`);
}
process.exit(failed.length ? 1 : 0);
