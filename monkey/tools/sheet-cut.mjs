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
  // Not the value of a flag. `clip=path` and `--fps-of idle=10` look alike to
  // a filter that only reads one argument at a time, and the second was read
  // as a sheet called "10,talk=15,asleep=9".
  .filter((a, i) => !(i > 0 && args[i - 1].startsWith('--')))
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
// Which frames came from which sheet. The junk filter below needs it: a
// slice is plausible relative to the sheet it came from, not to the atlas.
const segments = [];
let meas = { frames: [], w: 0, h: 0 };
for (const source of SOURCES) {
  const { url, shown } = await readSource(source.path);
  const one = GRID
    ? await page.evaluate(([u, o]) => window.__grid(u, o), [url, {
        down: DOWN,
        cols: +GRID.split('x')[0], rows: +GRID.split('x')[1],
        keyWhite: !args.includes('--no-key-white'),
        // Cut the enclosed patches of generator backdrop that the service's
        // matte fills in — see the long note in sheet-cut.html.
        cutHoles: !args.includes('--keep-holes'),
      }])
    : await page.evaluate(([u, o]) => window.__cut(u, o), [url, {
        down: DOWN,
        keyMargin: +opt('keymargin', 28),
        frames: +opt('frames', 8),
      }]);
  const at = meas.frames.length;
  meas = { w: one.w, h: one.h, frames: meas.frames.concat(one.frames) };
  segments.push({ from: at, to: at + one.frames.length, clip: source.clip });
  if (source.clip) clips[source.clip] = { start: at, count: one.frames.length };
  console.log(`${shown}  ${one.w}x${one.h}  ->  ${one.frames.length} frames`
    + `${source.clip ? `  [clip ${source.clip}]` : ''}  [${GRID ? 'uniform grid ' + GRID : 'connectivity'}]`
    // Said out loud, because a pass that silently deletes parts of a character
    // is the most dangerous thing in the packer.
    + `${one.holesCut ? `  [cut ${one.holesCut}px of filled hole]` : ''}`);
}

// Which end of the character to hold still — for a sheet that needs rescuing.
//
// A sheet cut by connectivity (`__cut`) has frames that were never in register
// with each other, and something has to decide what to line them up on. The
// head was that anchor everywhere, on the reasoning that a swinging arm moves
// the bounding box without moving the character. True of a walk, false of a
// character standing still whose head sways.
//
// A clip with a gait moves its feet on purpose and is pinned by the head; a
// clip without one has feet standing on the floor and is pinned by them.
// Whether a clip has a gait is read off its own frames: the figure's width just
// above the ground swings through a walk and is flat through an idle.
//
// None of this applies to a --grid sheet, which is copied rather than aligned
// — see IN PLACE below.
const sd = (a) => {
  if (a.length < 2) return 0;
  const m = a.reduce((x, v) => x + v, 0) / a.length;
  return Math.sqrt(a.reduce((x, v) => x + (v - m) ** 2, 0) / a.length);
};
for (const seg of segments) {
  const mine = meas.frames.slice(seg.from, seg.to);
  if (!mine.length) continue;
  const w = mine.map((f) => f.footW);
  const hi = Math.max(...w) || 1;
  const swing = (hi - Math.min(...w)) / hi;
  const gait = swing >= 0.3;
  const pick = gait ? 'head' : 'foot';
  for (const f of mine) f.anchor = pick;
  seg.gait = gait;
  if (!GRID) {
    console.log(`  ${(seg.clip || 'frames').padEnd(7)} ${gait ? 'has a gait' : 'no gait   '}`
      + ` (feet swing ${(swing * 100).toFixed(0)}%) -> anchor on the ${pick}`);
  }
}
await page.evaluate((anchors) => {
  window.__state.frames.forEach((f, i) => { f.anchor = anchors[i]; });
}, meas.frames.map((f) => f.anchor));

// Slices at the ends of a sheet catch stray artefacts// Slices at the ends of a sheet catch stray artefacts — a few pixels of a
// light bloom, half a figure the model added past the eighth — and a cell
// holding four pixels is worse than no cell. Anything far off the median
// height is not a frame, and saying which were dropped is the difference
// between a filter and a fudge.
// The median is taken PER SOURCE. Taken across the whole atlas it compares a
// clip against the other clips, and a character does not stay the same height
// between them: a seated sleeping man is a little over half as tall as the
// same man standing, so a global median dropped every frame of the sleep clip
// as junk and left a body with a clip pointing at nothing. What makes a slice
// junk is being unlike its own sheet.
const kept = [], dropped = [];
for (const seg of segments) {
  const mine = meas.frames.slice(seg.from, seg.to);
  if (!mine.length) continue;
  const med = [...mine.map((f) => f.h)].sort((a, b) => a - b)[mine.length >> 1];
  mine.forEach((f, k) => (f.h >= med * 0.7 ? kept : dropped).push({ ...f, i: seg.from + k, med }));
}
if (dropped.length) {
  console.log(`  dropped ${dropped.length} slice(s) as junk: `
    + dropped.map((f) => `#${f.i + 1} (h ${f.h}, median ${f.med})`).join(', '));
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

// IN PLACE. A --grid sheet is copied cell for cell, not re-aligned.
//
// The alignment machinery above exists for sheets whose frames were never in
// register. A sheet that arrives as a uniform grid already is — it was
// extracted from a single video — so every frame's position inside its cell is
// exactly where the animator put it, and re-deriving that position from the
// pixels can only add error. It did: wherever background removal left a soft
// smear under the boots the detected ground row wandered up to three pixels,
// and frames that were in register came out bobbing. It showed as Grout
// hopping once a loop, and it does not happen on the generator's own preview,
// because the generator's own preview does not do this.
//
// The unit of registration is the CLIP, not the atlas. One video is one
// coordinate frame; two videos are two. So inside a clip nothing moves at all,
// and between clips the ground rows and horizontal centres are brought
// together — which is the only part that does need deciding, since a seated
// sleeping man and a standing one were never filmed against a common floor.
// Whether the frames are ALREADY in register is measured, not assumed.
//
// The first version of this keyed off --grid, on the reasoning that a uniform
// grid comes from one video. Some do; some are a general image model's output
// that merely happens to be on a grid, with the figure landing wherever it
// landed in each cell — and tools/check-cut.mjs builds exactly that as a
// fixture, with placement varying 18px, to prove the aligner works. Copying
// that in place preserves a fault instead of fixing one.
//
// So: if each frame's ground row already sits in the same place inside its own
// cell, the sheet is registered and must not be touched. If it does not, the
// sheet needs the aligner. The two cases are half an order of magnitude apart
// — nothing to nought for a generator's own export, eighteen pixels for the
// fixture — so the threshold is not delicate.
const registered = (() => {
  if (!GRID || !meas.frames.every((f) => Number.isFinite(f.cellX))) return false;
  const medH = [...meas.frames.map((f) => f.h)].sort((a, b) => a - b)[meas.frames.length >> 1];
  const tol = Math.max(2, medH * 0.04);
  // Judged on the clips WITHOUT a gait. A running character leaves the ground
  // — that is the animation, not a fault — so a run's ground row moves 13px
  // however perfectly registered the sheet is, and reading that as
  // misalignment sent a clean sheet through the aligner. A character standing
  // still has no such excuse: if its ground row wanders inside its own cell,
  // the frames are not in one coordinate frame.
  const still = segments.filter((seg) => !seg.gait);
  if (!still.length) return false;
  const worst = Math.max(...still.map((seg) => {
    const g = meas.frames.filter((f) => f.i >= seg.from && f.i < seg.to).map((f) => f.groundY - f.cellY);
    return g.length ? Math.max(...g) - Math.min(...g) : 0;
  }));
  console.log(`  ground row varies ${worst}px inside its cell across the still clip(s)`
    + ` (tolerance ${tol.toFixed(1)}px on a ${medH}px figure)`
    + ` -> ${worst <= tol ? 'already registered, copy it' : 'not registered, align it'}`);
  return worst <= tol;
})();
const inPlace = args.includes('--align') ? false : registered;
let cell, feetY;
if (inPlace) {
  const perClip = segments.map((seg) => {
    const mine = meas.frames.filter((f) => f.i >= seg.from && f.i < seg.to);
    if (!mine.length) return null;
    const L = mine.map((f) => ({
      x0: f.x0 - f.cellX, x1: f.x1 - f.cellX,
      y0: f.y0 - f.cellY, y1: f.y1 - f.cellY, g: f.groundY - f.cellY,
    }));
    const grounds = L.map((l) => l.g).sort((a, b) => a - b);
    return {
      seg,
      x0: Math.min(...L.map((l) => l.x0)), x1: Math.max(...L.map((l) => l.x1)),
      y0: Math.min(...L.map((l) => l.y0)), y1: Math.max(...L.map((l) => l.y1)),
      // The median, so one frame with a smear under it does not lift the clip.
      g: grounds[grounds.length >> 1],
    };
  }).filter(Boolean);

  feetY = Math.max(...perClip.map((c) => c.g - c.y0)) + 1;
  cell = {
    w: Math.max(...perClip.map((c) => c.x1 - c.x0 + 1)),
    h: feetY + Math.max(...perClip.map((c) => c.y1 - c.g)),
  };
  for (const c of perClip) {
    // One offset for the whole clip, so no frame moves relative to its
    // neighbours; the clip as a whole is set down on the atlas's floor.
    c.ox = Math.round(cell.w / 2 - (c.x0 + c.x1) / 2);
    c.oy = (feetY - 1) - c.g;
    for (const f of meas.frames) {
      if (f.i >= c.seg.from && f.i < c.seg.to) { f.inOX = c.ox; f.inOY = c.oy; }
    }
    console.log(`  ${(c.seg.clip || 'frames').padEnd(7)} copied in place`
      + `, set down ${c.ox >= 0 ? '+' : ''}${c.ox},${c.oy >= 0 ? '+' : ''}${c.oy}`);
  }
  console.log(`  cell ${cell.w}x${cell.h}, ground at row ${feetY - 1}`);
  await page.evaluate((o) => {
    window.__state.frames.forEach((f, i) => { f.inOX = o[i][0]; f.inOY = o[i][1]; });
  }, meas.frames.map((f) => [f.inOX ?? 0, f.inOY ?? 0]));
} else {
  // Frames are pinned by their GROUND row, and a speck of leftover background
  // removal can hang below it, so the bottom margin comes from the worst case.
  const below = Math.max(0, ...meas.frames.map((f) => f.y1 - f.groundY));
  cell = { w: maxW + 8, h: maxH + 8 + below };
  feetY = cell.h - 4 - below;
}

const dataUrl = await page.evaluate(([c, o]) => window.__pack(c, o),
  [cell, { cols: meas.frames.length, feetY, inPlace }]);

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
  // In source pixels; the engine scales it by however tall the character is
  // actually drawn, so one cycle of animation covers one stride of ground at
  // any size and any depth.
  c.stride = Math.round(r.stride);
  console.log(`  clip ${name.padEnd(6)} ${c.count} frames, cycle every ${r.period}`
    + `, stride ${c.stride}px`
    + `${r.fromSlope !== undefined ? ` (slope ${r.fromSlope}, floor ${r.floor}${r.stride === r.floor ? ' — floor won' : ''})` : ''}`
    + `  [${r.signal}, ${r.peaks} peaks]`);
}

// A clip named in --once plays through and stops; everything else loops. The
// distinction has to live in the manifest rather than at the call site,
// because it is a property of the art — a drink ends, a breath does not — and
// the script should be able to say "play the drink" without also having to
// know how long it is.
const ONCE = (opt('once', '') || '').split(',').filter(Boolean);
for (const name of ONCE) {
  if (!clips[name]) throw new Error(`--once names ${name}, which is not one of the clips: ${Object.keys(clips)}`);
}
// Frame rate, per clip.
//
// One rate for the whole atlas is wrong, and the reason is that these clips are
// not the same kind of thing. An action — drink it, ring it, pump the bellows —
// happens at the speed a person does it. A LOOP is a character doing nothing,
// and a character doing nothing on a 1.7-second cycle is a character
// fidgeting: it reads as restlessness, and next to a still backdrop it is the
// most conspicuous motion on screen. Adventure-game idles breathe on the order
// of three or four seconds.
//
// The walk is not in here because the walk does not use fps at all — its frames
// advance with distance travelled, so the feet stay in step with the ground at
// any speed. Only idle and the named clips read this.
//
//   --fps 19                 every clip
//   --fps 19 --fps-of idle=10,asleep=9
const FPS = +opt('fps', 12);
const FPS_OF = Object.fromEntries((opt('fps-of', '') || '').split(',').filter(Boolean).map((pair) => {
  const [k, v] = pair.split('=');
  if (!v || !isFinite(+v)) throw new Error(`--fps-of wants name=number, got "${pair}"`);
  return [k, +v];
}));
for (const k of Object.keys(FPS_OF)) {
  if (!clips[k]) throw new Error(`--fps-of names ${k}, which is not one of the clips: ${Object.keys(clips)}`);
}
const fpsFor = (k) => FPS_OF[k] ?? FPS;

const manifest = {
  cellW: cell.w, cellH: cell.h, cols: meas.frames.length,
  figureH: maxH, feetY,
  // What the figure actually occupies in each cell, in source pixels. The cell
  // is sized off the largest frame in the atlas, so for anything else it is
  // mostly air — and a click target sized off the cell is a click target that
  // is wrong for every frame but one. It matters most where the pose changes
  // shape: a man asleep on the ground is half as tall and half again as wide
  // as the same man standing.
  bounds: meas.frames.map((f) => [f.x1 - f.x0 + 1, f.h]),
  clips: Object.keys(clips).length
    ? Object.fromEntries(Object.entries(clips).map(([k, c]) =>
        [k, { ...c, fps: fpsFor(k), ...(ONCE.includes(k) ? { loop: false } : {}) }]))
    : { idle: { start: 0, count: 1, fps: 4 }, walk: { start: 0, count: meas.frames.length, fps: FPS } },
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
// The anchored column must be nailed; the other one is reported because it is
// the honest measure of what the clip does. An idle whose unanchored end still
// wanders is a clip that will read as drifting whichever way it is pinned.
const anchoredOn = meas.frames[0]?.anchor === 'foot' ? 'toe' : 'head';
const anchoredSpread = anchoredOn === 'toe' ? v.toeSpread : v.headSpread;
console.log(`verified: ${v.cells} cells, ground spread ${v.feetSpread}px, `
  + `head spread ${v.headSpread}px, toe spread ${v.toeSpread}px`);
// An in-place atlas makes a different promise, so it is held to a different
// one. It does not claim every ground row is identical — it claims it did not
// MOVE anything, and whatever the source's own ground rows do is the source's
// business. That promise is checked directly, cell by cell, further down.
if (!inPlace && v.feetSpread > 0) {
  console.error('FAILED: the ground row is not the same in every cell');
  process.exit(1);
}
// Mixed anchors across an atlas mean neither column is zero overall, so the
// per-clip case is the one to judge — and it is judged in check-cut.mjs on a
// single-clip fixture. Here the rule is only that the atlas anchored SOMETHING.
if (new Set(meas.frames.map((f) => f.anchor)).size === 1 && anchoredSpread > 1) {
  console.error(`FAILED: the atlas anchored on the ${anchoredOn} but that column`
    + ` still varies by ${anchoredSpread}px`);
  process.exit(1);
}
