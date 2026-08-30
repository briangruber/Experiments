#!/usr/bin/env node
// Render tools/ui-sheet.html to a PNG the director can actually look at.
//
//   node tools/ui-sheet.mjs
//
// The rule in this repo is that the user is the eyes, which does not mean
// shipping questions unanswered — it means producing the one image the
// question needs and handing it over.

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT, launch, serve } from './harness.mjs';

const { port, close } = await serve();
const browser = await launch();
const page = await browser.newPage();
await page.setViewportSize({ width: 1700, height: 620 });
await page.goto(`http://localhost:${port}/tools/ui-sheet.html`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });
const el = await page.$('#c');
const png = await el.screenshot();
await mkdir(join(ROOT, 'dist'), { recursive: true });
const out = join(ROOT, 'dist/ui-sheet.png');
await writeFile(out, png);
await browser.close();
await close();
console.log(`grid sheet -> dist/ui-sheet.png  ${(png.length / 1024).toFixed(0)} KB`);
