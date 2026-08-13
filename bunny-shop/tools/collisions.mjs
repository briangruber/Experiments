#!/usr/bin/env node
// Report where rabbits walk into the furniture.
//
//   node tools/collisions.mjs [--minutes 10]
//
// Runs the shop unattended and samples every rabbit's walking circle against
// every solid prop's real footprint, printing which prop, how often, how deep,
// and during which phase of a customer's visit. Exits non-zero if anything
// actually penetrates.
//
// This exists because the footprints are not what they look like: the shelf
// model turns out to be 2.68m deep, which put two queue positions and three
// loitering spots inside shelves. Guessing at the layout is how that happened;
// measuring it is how it got fixed.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const MINUTES = +(args[args.indexOf('--minutes') + 1] || 10);

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.glb': 'model/gltf-binary' };

const server = createServer(async (req, res) => {
  try {
    const path = join(ROOT, req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
    if (!path.startsWith(ROOT)) return res.writeHead(403).end();
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const { chromium } = await import('playwright');
const browser = await chromium.launch({
  ...(existsSync(CHROME) ? { executablePath: CHROME } : {}),
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 520 } });
page.on('pageerror', (e) => console.error('page error:', e.message));

await page.goto(`http://127.0.0.1:${port}/index.html`);
await page.waitForFunction(() => !document.querySelector('#start')?.disabled, { timeout: 180000 });
await page.click('#start');

const report = await page.evaluate((minutes) => {
  const g = window.__game;
  const THREE = window.__THREE;
  const solids = window.__shop.solids.map((o) => ({
    name: o.userData.prop,
    box: new THREE.Box3().setFromObject(o),
  }));

  const worst = {};
  const sample = () => {
    for (const sh of g.shoppers) {
      const p = sh.body.pos;
      const r = sh.body.radius;
      for (const s of solids) {
        const dx = Math.min(p.x + r, s.box.max.x) - Math.max(p.x - r, s.box.min.x);
        const dz = Math.min(p.y + r, s.box.max.z) - Math.max(p.y - r, s.box.min.z);
        if (dx <= 0 || dz <= 0) continue;
        const rec = (worst[s.name] ||= { frames: 0, depth: 0, phases: {} });
        rec.frames++;
        rec.depth = Math.max(rec.depth, +Math.min(dx, dz).toFixed(3));
        rec.phases[sh.phase] = (rec.phases[sh.phase] || 0) + 1;
      }
    }
  };

  let samples = 0;
  for (let i = 0; i < 60 * 60 * minutes; i++) {
    g.update(1 / 60);
    if (i % 4 === 0) {
      sample();
      samples++;
    }
  }
  return { worst, samples, day: g.day };
}, MINUTES);

await browser.close();
server.close();

const rows = Object.entries(report.worst);
console.log(`${MINUTES} minutes unattended, ${report.samples} samples, reached day ${report.day}\n`);

if (!rows.length) {
  console.log('  no contact with any prop');
} else {
  for (const [name, r] of rows.sort((a, b) => b[1].depth - a[1].depth)) {
    const phases = Object.entries(r.phases)
      .sort((a, b) => b[1] - a[1])
      .map(([p, n]) => `${p} ${n}`)
      .join(', ');
    console.log(`  ${name.padEnd(14)} ${String(r.frames).padStart(5)} frames  depth ${r.depth.toFixed(3)}  (${phases})`);
  }
}

// Grazing at exactly zero depth is the separation pass doing its job — a rabbit
// held against a shelf it was walking into. Anything deeper is a real overlap.
const penetrating = rows.filter(([, r]) => r.depth > 0.02);
if (penetrating.length) {
  console.log(`\n${penetrating.length} prop(s) actually penetrated`);
  process.exit(1);
}
console.log('\nno penetration');
