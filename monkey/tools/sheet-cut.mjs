#!/usr/bin/env node
// Turn a generated sprite sheet into an atlas the engine can load.
//
//   node tools/sheet-cut.mjs assets/spriteoff/seedream.px.png --name bonny
//
// docs/asset-pack.md asks for two things that no image model will give you
// reliably: the feet on the same row in every cell, and the figure on the same
// column. Rather than hope, this measures each frame and then rebuilds the
// sheet with both rules enforced — which turns "the model nearly got it right"
// into a usable asset.
//
// The alignment references are the ground (the lowest opaque pixel) and the
// HEAD centre, not the bounding-box centre. In a walk cycle a swinging arm
// moves the bounding box without moving the character, so centring on the box
// makes the figure slide back and forth by a few pixels a stride.

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { ROOT, launch, serve } from './harness.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
// Sources may be bare paths or `clip=path`, so several sheets become one atlas
// with named clips — idle and walk are separate exports but one character, and
// the loader takes a single sheet per body.
const SOURCES = args
  .filter((a) => !a.startsWith('--') && (/^https?:/i.test(a) || /\.(png|jpe?g|webp)$/i.test(a) || a.includes('=')))
  .map((a) => {
    const eq = a.indexOf('=');
    return eq > 0 && !/^https?:/i.test(a.slice(0, eq))
      ? { clip: a.slice(0, eq), path: a.slice(eq + 1) }
      : { clip: null, path: a };
  });
const src = SOURCES[0]?.path;
if (!src) {
  console.error('usage: node tools/sheet-cut.mjs <sheet.png|url> [--name key] [--grid CxR] [--down N]');
  process.exit(1);
}
const NAME = opt('name', 'cast');
const TARGET_H = +opt('height', 48);
// image2pixel returns blocks at their original scale — a 16px block in a
// 2040px image. Reducing by the block size with nearest-neighbour turns that
// back into native pixels, which is the only form the engine can draw without
// resampling the art it was given.
const DOWN = +opt('down', 1);
// The sheet is handed to the page as a data URI rather than served, so it can
// live anywhere — an uploads directory, /tmp, another checkout — instead of
// having to be inside the repo before it can be cut.
// A sheet can arrive as a path or as a URL. The URL case matters because an
// image pasted into a chat is rendered, not saved — the bytes never reach this
// filesystem — so a public link is often the shortest route from "here is the
// sheet" to a cut atlas.
async function readSource(path) {
  const isUrl = /^https?:\/\//i.test(path);
  const abs = isUrl ? path : (isAbsolute(path) ? path : join(ROOT, path));
  const bytes = isUrl
    ? Buffer.from(await (await fetch(path)).arrayBuffer())
    : await readFile(abs);
  if (isUrl) console.log(`fetched ${(bytes.length / 1024).toFixed(0)} KB from ${path}`);
  const mime = bytes.subarray(0, 4).toString('hex') === '89504e47' ? 'image/png' : 'image/jpeg';
  return {
    url: `data:${mime};base64,` + bytes.toString('base64'),
    shown: isUrl ? path : abs.replace(ROOT + '/', ''),
  };
}

const { port, close } = await serve();
const browser = await launch();
const page = await browser.newPage();
await page.goto(`http://localhost:${port}/tools/sheet-cut.html`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__ready === true);

// --grid CxR is the path for a sheet that is already a uniform grid with the
// background removed — which is what a purpose-built sprite service returns,
// and what docs/asset-pack.md asks for. Everything else is for rescuing a
// sheet a general image model drew.
const GRID = opt('grid', null);
const clips = {};
let meas = { frames: [], w: 0, h: 0 };
for (const source of SOURCES) {
  const { url, shown } = await readSource(source.path);
  const one = GRID
    ? await page.evaluate(([u, o]) => window.__grid(u, o), [url, {
        down: DOWN,
        cols: +GRID.split('x')[0], rows: +GRID.split('x')[1],
        keyWhite: !args.includes('--no-key-white'),
      }])
    : await page.evaluate(([u, o]) => window.__cut(u, o), [url, {
        down: DOWN,
        keyMargin: +opt('keymargin', 28),
        frames: +opt('frames', 8),
      }]);
  const at = meas.frames.length;
  meas = { w: one.w, h: one.h, frames: meas.frames.concat(one.frames) };
  if (source.clip) clips[source.clip] = { start: at, count: one.frames.length };
  console.log(`${shown}  ${one.w}x${one.h}  ->  ${one.frames.length} frames`
    + `${source.clip ? `  [clip ${source.clip}]` : ''}  [${GRID ? 'uniform grid ' + GRID : 'connectivity'}]`);
}

// Slices at the ends of a sheet catch stray artefacts — a few pixels of a
// light bloom, half a figure the model added past the eighth — and a cell
// holding four pixels is worse than no cell. Anything far off the median
// height is not a frame, and saying which were dropped is the difference
// between a filter and a fudge.
const med = [...meas.frames.map((f) => f.h)].sort((a, b) => a - b)[meas.frames.length >> 1];
const kept = [], dropped = [];
meas.frames.forEach((f, i) => (f.h >= med * 0.7 ? kept : dropped).push({ ...f, i }));
if (dropped.length) {
  console.log(`  dropped ${dropped.length} slice(s) as junk: `
    + dropped.map((f) => `#${f.i + 1} (h ${f.h}, median ${med})`).join(', '));
}
await page.evaluate((keep) => {
  window.__state.frames = window.__state.frames.filter((_, i) => keep.includes(i));
}, kept.map((f) => f.i));
// Dropping a junk slice shifts every later clip, so the clip table is rebuilt
// against the surviving frames rather than left pointing at old indices.
if (dropped.length) {
  for (const [name, c] of Object.entries(clips)) {
    const before = dropped.filter((f) => f.i < c.start).length;
    const inside = dropped.filter((f) => f.i >= c.start && f.i < c.start + c.count).length;
    clips[name] = { start: c.start - before, count: c.count - inside };
  }
}
meas.frames = kept;
const hs = meas.frames.map((f) => f.h);
const bots = meas.frames.map((f) => f.y1);
const spread = (a) => Math.max(...a) - Math.min(...a);
console.log(`  height  ${Math.min(...hs)}–${Math.max(...hs)}px  (spread ${spread(hs)})`);
console.log(`  ground  rows ${Math.min(...bots)}–${Math.max(...bots)}  (spread ${spread(bots)} — this is the bob if left uncorrected)`);
for (const [i, f] of meas.frames.entries()) {
  console.log(`   frame ${String(i + 1).padStart(2)}  x ${String(f.x0).padStart(4)}–${String(f.x1).padStart(4)}  w ${String(f.x1 - f.x0 + 1).padStart(3)}  h ${String(f.h).padStart(3)}  head cx ${f.headCx.toFixed(0)}`);
}

// The cell is sized off the widest and tallest frame, with a little air, and
// the figures are then scaled as a set so the character lands at TARGET_H.
const maxW = Math.max(...meas.frames.map((f) => f.x1 - f.x0 + 1));
const maxH = Math.max(...hs);
const cell = { w: maxW + 8, h: maxH + 8 };
const feetY = cell.h - 4;
const dataUrl = await page.evaluate(([c, o]) => window.__pack(c, o),
  [cell, { cols: meas.frames.length, feetY }]);

await mkdir(join(ROOT, 'assets/cast'), { recursive: true });
const outPng = join(ROOT, `assets/cast/${NAME}-sheet.png`);
await writeFile(outPng, Buffer.from(dataUrl.split(',')[1], 'base64'));

// Measure each clip's cycle length off the packed atlas, so the engine can map
// one stride of travel onto one stride of animation rather than onto however
// many the generator happened to sample.
const atlasUri = 'data:image/png;base64,' + Buffer.from(dataUrl.split(',')[1], 'base64').toString('base64');
for (const [name, c] of Object.entries(clips)) {
  const r = await page.evaluate(([u, cl, cols, clip, fy, fh]) => window.__period(u, cl, cols, clip, fy, fh),
    [atlasUri, cell, meas.frames.length, c, feetY, maxH]);
  c.framesPerCycle = r.period;
  console.log(`  clip ${name.padEnd(6)} ${c.count} frames, cycle every ${r.period}`
    + `  [${r.signal}, ${r.peaks} peaks]`);
}

const manifest = {
  cellW: cell.w, cellH: cell.h, cols: meas.frames.length,
  figureH: maxH, feetY,
  clips: Object.keys(clips).length
    ? Object.fromEntries(Object.entries(clips).map(([k, c]) => [k, { ...c, fps: +opt('fps', 12) }]))
    : { idle: { start: 0, count: 1, fps: 4 }, walk: { start: 0, count: meas.frames.length, fps: +opt('fps', 12) } },
  sources: SOURCES.map((x) => x.path), targetHeight: TARGET_H,
};
await writeFile(join(ROOT, `assets/cast/${NAME}-sheet.json`), JSON.stringify(manifest, null, 2) + '\n');

// Check the file that was actually written. Enforcing a rule and verifying it
// are different things, and only the second one survives a refactor.
const v = await page.evaluate(([u, c, cols, n]) => window.__verify(u, c, cols, n),
  ['data:image/png;base64,' + Buffer.from(dataUrl.split(',')[1], 'base64').toString('base64'),
   cell, meas.frames.length, meas.frames.length]);
await browser.close();
await close();

console.log(`\natlas -> assets/cast/${NAME}-sheet.png  ${cell.w}x${cell.h} cells x ${meas.frames.length}`);
console.log(`manifest -> assets/cast/${NAME}-sheet.json  figureH ${maxH}, feetY ${feetY}`);
console.log(`verified: ${v.cells} cells, feet spread ${v.feetSpread}px, head spread ${v.headSpread}px`);
if (v.feetSpread > 0 || v.headSpread > 1) {
  console.error('FAILED: the atlas does not satisfy its own alignment rules'
    + ' (feet must be one row, figure within a pixel of one column)');
  process.exit(1);
}
