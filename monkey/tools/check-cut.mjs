#!/usr/bin/env node
// Prove the cutter enforces the two alignment rules.
//
//   node tools/check-cut.mjs
//
// docs/asset-pack.md turns on two claims: the feet land on the same row in
// every cell, and the figure on the same column. Those are the rules that show
// up as MOTION when broken — bobbing and sliding — rather than as something
// visible in a still, which is exactly the class of fault that has cost the
// most in this project.
//
// So the check builds a sheet designed to break them: a uniform grid whose
// figures deliberately vary in height and in where they sit inside their cell,
// runs it through the real cutter, and asserts the output has zero spread. A
// synthetic input is the point — a real sheet that happens to be well aligned
// proves nothing about the code.

import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ROOT, launch } from './harness.mjs';

const run = promisify(execFile);
const TMP = join(ROOT, 'dist/cut-fixture.png');

const browser = await launch();
const page = await browser.newPage();
const url = await page.evaluate(() => {
  const c = document.createElement('canvas');
  c.width = 1280; c.height = 1280;
  const g = c.getContext('2d');
  for (let i = 0; i < 25; i++) {
    const cx = (i % 5) * 256 + 128, cy = ((i / 5) | 0) * 256;
    // Height varies by 12px and vertical placement by 18px between frames,
    // which is roughly what the generated sheets actually did.
    const h = 180 + (i % 3) * 12, top = cy + 40 + (i % 4) * 6;
    g.fillStyle = '#c0392b'; g.fillRect(cx - 14, top + 30, 28, h - 60);
    g.fillStyle = '#f0c27b'; g.fillRect(cx - 10, top, 20, 28);
    g.fillStyle = '#2c3e50'; g.fillRect(cx - 12, top + h - 30, 10, 30);
    g.fillStyle = '#2c3e50'; g.fillRect(cx + 2, top + h - 30, 10, 30);
  }
  return c.toDataURL('image/png');
});
await browser.close();
await writeFile(TMP, Buffer.from(url.split(',')[1], 'base64'));

const { stdout } = await run('node', [
  join(ROOT, 'tools/sheet-cut.mjs'), TMP, '--name', '_cutcheck', '--grid', '5x5', '--down', '4',
], { cwd: ROOT });

const line = stdout.split('\n').find((l) => l.startsWith('verified:'));
console.log(stdout.split('\n').filter((l) => /frames|verified|atlas/.test(l)).join('\n'));

await unlink(TMP).catch(() => {});
await unlink(join(ROOT, 'assets/cast/_cutcheck-sheet.png')).catch(() => {});
await unlink(join(ROOT, 'assets/cast/_cutcheck-sheet.json')).catch(() => {});

// "feet spread" was renamed "ground spread" when the cutter stopped pinning
// each frame's lowest pixel and started pinning the row it stands on. Both are
// accepted so this check reads either vintage of the tool.
const m = line?.match(/(\d+) cells, (?:feet|ground) spread (\d+)px, head spread (\d+)px/);
if (!m) { console.error('FAILED: the cutter reported no verification line'); process.exit(1); }
const [, cells, feet, head] = m.map(Number);
const ok = cells === 25 && feet === 0 && head <= 1;
console.log(`\n  ${ok ? 'ok  ' : 'FAIL'}  a misaligned sheet comes out aligned  `
  + `(${cells} cells, feet ${feet}px, head ${head}px)`);
process.exit(ok ? 0 : 1);
