#!/usr/bin/env node
// Screenshot the room with the annotation overlay on.
//
//   node tools/annot.mjs            # -> shots/annot.png
//
// Tracing a walk area over a generated painting is the one job that replaced
// the blockout, and it needs an image of the mask sitting on the art to be
// checkable at all. The editor already draws it; this just captures it.

import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { ROOT, launch, serve } from './harness.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const OUT = resolve(ROOT, opt('out', 'shots/annot.png'));

const { port, close } = await serve();
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`http://127.0.0.1:${port}/index.html?editor=1`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__monkey, null, { timeout: 15000 });
await page.waitForTimeout(1200);
await mkdir(dirname(OUT), { recursive: true });
await page.locator('#stage').screenshot({ path: OUT });
await browser.close();
close();
if (errors.length) { console.error('errors:\n  ' + errors.join('\n  ')); process.exit(1); }
console.log(`annotations -> ${OUT.replace(ROOT + '/', '')}`);
