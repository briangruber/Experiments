#!/usr/bin/env node
// Bake a rigged character into a sprite atlas the 2D engine can blit.
//
//   node tools/cast-sprites.mjs bonny
//
// Writes assets/cast/<key>-sheet.png and <key>-sheet.json. See tools/sprites.html
// for why this is baked rather than rendered live.

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT, launch, serve } from './harness.mjs';

const args = process.argv.slice(2);
const key = args[0] || 'bonny';
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const FRAME_H = opt('frame-h', '230');
const YAW = opt('yaw', '0');

const CLIPS = [
  { name: 'idle', url: `../assets/cast/mixamo-idle.fbx`, frames: 12 },
  { name: 'walk', url: `../assets/cast/mixamo-walk.fbx`, frames: 16 },
];

const { port, close } = await serve();
const browser = await launch({
  args: ['--disable-dev-shm-usage', '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
    '--ignore-gpu-blocklist', '--enable-webgl'],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

const url = `http://127.0.0.1:${port}/tools/sprites.html`
  + `?model=${encodeURIComponent(`../assets/cast/${key}-rigged-mixamo.glb`)}`
  + `&clips=${encodeURIComponent(JSON.stringify(CLIPS))}`
  + `&frameH=${FRAME_H}&yaw=${YAW}`;
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => window.__ready, null, { timeout: 120000 });

const manifest = await page.evaluate(() => window.__manifest);
const png = await page.locator('#sheet').screenshot({ omitBackground: true });
await browser.close();
close();
if (errors.length) { console.error('errors:\n  ' + errors.join('\n  ')); process.exit(1); }

const dir = join(ROOT, 'assets/cast');
await mkdir(dir, { recursive: true });
await writeFile(join(dir, `${key}-sheet.png`), png);
await writeFile(join(dir, `${key}-sheet.json`), JSON.stringify(manifest, null, 1) + '\n');
const frames = Object.values(manifest.clips).reduce((n, c) => n + c.count, 0);
console.log(`atlas -> assets/cast/${key}-sheet.png  ${manifest.cellW}x${manifest.cellH} x ${frames} frames  ${(png.length / 1024).toFixed(0)} KB`);
console.log(`        clips: ${Object.entries(manifest.clips).map(([k, v]) => `${k}(${v.count})`).join(' ')}  feet at y=${manifest.feetY}`);
