#!/usr/bin/env node
// Render the 3D-vs-puppet comparison sheet.
//
//   node tools/cast-sheet.mjs
//   node tools/cast-sheet.mjs --src ../assets/cast/bonny-idle.glb --out shots/idle.png

import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { ROOT, launch, serve } from './harness.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const SRC = opt('src', '../assets/cast/bonny-walk.glb');
const OUT = resolve(ROOT, opt('out', 'shots/cast-sheet.png'));

const { port, close } = await serve();
// WebGL in headless needs the software rasteriser flags the ocean harness uses.
const browser = await launch({
  args: ['--disable-dev-shm-usage', '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
    '--ignore-gpu-blocklist', '--enable-webgl'],
});
const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
await page.goto(`http://127.0.0.1:${port}/tools/cast-sheet.html?src=${encodeURIComponent(SRC)}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__ready, null, { timeout: 60000 }).catch(() => {});
await mkdir(dirname(OUT), { recursive: true });
await page.locator('#sheet').screenshot({ path: OUT });
await browser.close();
close();
if (errors.length) { console.error('errors:\n  ' + errors.join('\n  ')); process.exit(1); }
console.log(`cast sheet -> ${OUT.replace(ROOT + '/', '')}`);
