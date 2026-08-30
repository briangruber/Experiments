#!/usr/bin/env node
// Render the walk cycle as a contact sheet.
//
//   node tools/pose.mjs                 # -> shots/pose-player.png
//   node tools/pose.mjs --who grout
//
// Animation is the one thing in this prototype that cannot be checked by
// asserting on a value, and cannot be judged from a single screenshot of the
// game either — the character is 35px of head in the corner of a room. A sheet
// of the whole stride at 2.4x is the only way to see whether the feet slide,
// whether the knees bend the right way, and whether the body has any weight.

import { mkdir } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { ROOT, launch, serve } from './harness.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const WHO = opt('who', 'player');
const OUT = resolve(ROOT, opt('out', `shots/pose-${WHO}.png`));

const { port, close } = await serve();
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 640 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`http://127.0.0.1:${port}/tools/pose.html?who=${WHO}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__ready, null, { timeout: 10000 });
await mkdir(dirname(OUT), { recursive: true });
await page.locator('#c').screenshot({ path: OUT });
await browser.close();
close();

if (errors.length) { console.error('pose errors:\n  ' + errors.join('\n  ')); process.exit(1); }
console.log(`pose sheet -> ${OUT.replace(ROOT + '/', '')}`);
