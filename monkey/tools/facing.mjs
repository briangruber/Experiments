#!/usr/bin/env node
// Which way is a sprite sheet facing?
//
//   node tools/facing.mjs assets/cast/autosprite/grout/*.png
//
// AutoSprite returns every sheet under a "/right/" path, and returns some of
// them mirrored anyway — this character's walk faces one way and his idle and
// drink face the other. Left uncorrected that is a man who spins round when he
// stops walking, and it is the kind of thing that is obvious in motion and
// nearly invisible in a contact sheet, so it is measured rather than eyeballed.
//
// The measure is a mirror match, not a guess at anatomy. The first frame of
// each sheet is compared with a reference frame both as it is and flipped,
// scoring the better alignment over a range of horizontal offsets. A profile
// figure and its mirror image are very different pictures, so the two scores
// separate cleanly; a symmetric one would score the same both ways, and that
// shows up as a small margin rather than as a confident wrong answer.

import { readFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { ROOT, launch, serve } from './harness.mjs';

// Flag values are not sheets. Filtering on "does not start with --" swallowed
// the 32 in `--frame 32` and tried to open it as a PNG, which is a confusing
// way to be told you typed something fine.
const FLAGS = ['ref', 'cols', 'rows', 'frame', 'band', 'want'];
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const args = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && FLAGS.includes(argv[i - 1].replace(/^--/, '')) && argv[i - 1].startsWith('--')));
if (!args.length) { console.error('usage: node tools/facing.mjs <sheet.png>... [--ref <sheet.png>] [--cols N]'); process.exit(1); }

const uri = async (p) => 'data:image/png;base64,'
  + (await readFile(isAbsolute(p) ? p : join(ROOT, p))).toString('base64');

const { port, close } = await serve();
const browser = await launch();
const page = await browser.newPage();
await page.goto(`http://localhost:${port}/tools/sheet-cut.html`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__ready === true);

await page.evaluate(() => {
  const load = (u) => new Promise((res, rej) => {
    const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = u;
  });

  // The silhouette test above is weak on this cast: a long coat is very nearly
  // symmetric, so a mirrored frame scores almost as well as the original and
  // the margin collapses. The face is not symmetric. In a side view the skin
  // of the face sits on the side the character is looking towards, and the hair
  // and the hat's tail sit behind it — so where the skin falls inside the head
  // is a direct reading of the facing rather than an inference from outline.
  window.__faceSide = async (url, cols, rows, index, band = 0.22) => {
    const img = await load(url);
    const cw = img.width / cols, ch = img.height / rows;
    const c = document.createElement('canvas');
    c.width = cw; c.height = ch;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(img, -(index % cols) * cw, -Math.floor(index / cols) * ch);
    const d = x.getImageData(0, 0, cw, ch).data;
    const at = (px, py) => (py * cw + px) * 4;
    let y0 = 1e9, y1 = -1, bx0 = 1e9, bx1 = -1;
    for (let py = 0; py < ch; py++) for (let px = 0; px < cw; px++) {
      if (d[at(px, py) + 3] > 40) { if (py < y0) y0 = py; if (py > y1) y1 = py; }
    }
    if (y1 < 0) return null;
    // The head band: the top fifth of the figure, which is hat, hair and face
    // and nothing else on any of these poses.
    const bandTop = y0, bandBot = y0 + Math.round((y1 - y0) * band);
    for (let py = bandTop; py <= bandBot; py++) for (let px = 0; px < cw; px++) {
      if (d[at(px, py) + 3] > 40) { if (px < bx0) bx0 = px; if (px > bx1) bx1 = px; }
    }
    let sum = 0, n = 0;
    for (let py = bandTop; py <= bandBot; py++) for (let px = bx0; px <= bx1; px++) {
      const i = at(px, py);
      const [r, g, b, a] = [d[i], d[i + 1], d[i + 2], d[i + 3]];
      // Lit skin: warm, clearly red over blue, and not a dark outline.
      if (a > 120 && r > 130 && r > g + 12 && g > b && r - b > 45) { sum += px; n++; }
    }
    if (!n) return { skin: 0, lean: 0 };
    const mid = (bx0 + bx1) / 2;
    // -1 is fully to the left of the head, +1 fully to the right.
    return { skin: n, lean: (sum / n - mid) / ((bx1 - bx0) / 2 || 1) };
  };

  // One cell, cropped to the figure and normalised to a fixed box, as a
  // silhouette. Colour is deliberately dropped: a coat is the same colour
  // whichever way it faces, and the shape is what carries the direction.
  window.__silhouette = async (url, cols, rows, index, size = 64) => {
    const img = await load(url);
    const cw = img.width / cols, ch = img.height / rows;
    const c = document.createElement('canvas');
    c.width = cw; c.height = ch;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(img, -(index % cols) * cw, -Math.floor(index / cols) * ch);
    const d = x.getImageData(0, 0, cw, ch).data;
    let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    for (let py = 0; py < ch; py++) for (let px = 0; px < cw; px++) {
      if (d[(py * cw + px) * 4 + 3] > 40) {
        if (px < x0) x0 = px; if (px > x1) x1 = px;
        if (py < y0) y0 = py; if (py > y1) y1 = py;
      }
    }
    if (x1 < 0) return null;
    const n = document.createElement('canvas');
    n.width = size; n.height = size;
    const nx = n.getContext('2d', { willReadFrequently: true });
    nx.drawImage(c, x0, y0, x1 - x0 + 1, y1 - y0 + 1, 0, 0, size, size);
    const nd = nx.getImageData(0, 0, size, size).data;
    const a = new Float32Array(size * size);
    for (let i = 0; i < a.length; i++) a[i] = nd[i * 4 + 3] > 40 ? 1 : 0;
    return Array.from(a);
  };
});

// Intersection over union, at the best of a few horizontal shifts, so a figure
// sitting a pixel or two off centre is not scored as a different one.
function iou(a, b, size) {
  let best = 0;
  for (let s = -3; s <= 3; s++) {
    let inter = 0, union = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const bx = x + s;
      const av = a[y * size + x];
      const bv = bx >= 0 && bx < size ? b[y * size + bx] : 0;
      if (av || bv) union++;
      if (av && bv) inter++;
    }
    best = Math.max(best, union ? inter / union : 0);
  }
  return best;
}
const SIZE = 64;
const flip = (a) => {
  const o = new Array(a.length);
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) o[y * SIZE + x] = a[y * SIZE + (SIZE - 1 - x)];
  return o;
};

const COLS = +opt('cols', 6), ROWS = +opt('rows', 6);
// Frame 1 is not always the frame to read: a raised cup covers the face and
// puts two hands in the head band, and a seated pose puts the head in the top
// third rather than the top fifth. Both are choices about where to look, not
// about what counts as facing.
const FRAME = +opt('frame', 1) - 1;
const BAND = +opt('band', 0.22);
const refPath = opt('ref', args[0]);
const ref = await page.evaluate(([u, c, r, i, s]) => window.__silhouette(u, c, r, i, s),
  [await uri(refPath), COLS, ROWS, 0, SIZE]);
console.log(`reference: ${refPath} frame 1 — every sheet below is reported relative to this\n`);

const verdicts = [];
for (const p of args) {
  const s = await page.evaluate(([u, c, r, i, sz]) => window.__silhouette(u, c, r, i, sz),
    [await uri(p), COLS, ROWS, 0, SIZE]);
  if (!s) { console.log(`  ${p}: empty first frame`); continue; }
  const same = iou(ref, s, SIZE), mirrored = iou(ref, flip(s), SIZE);
  const face = await page.evaluate(([u, c, r, i, b]) => window.__faceSide(u, c, r, i, b),
    [await uri(p), COLS, ROWS, FRAME, BAND]);
  // The face reading decides; the silhouette match is printed beside it as a
  // second opinion, because when the two disagree the answer is worth a look
  // rather than a shrug.
  const dir = !face || face.skin < 20 || Math.abs(face.lean) < 0.06
    ? 'unclear' : (face.lean > 0 ? 'right' : 'left');
  verdicts.push({ p, dir });
  console.log(`  ${p.split('/').pop().padEnd(18)} faces ${String(dir).padEnd(7)}`
    + ` (skin lean ${face ? face.lean.toFixed(2).padStart(5) : ' n/a '}, ${face ? face.skin : 0}px)`
    + `   silhouette: as-is ${same.toFixed(2)} flipped ${mirrored.toFixed(2)}`);
}
await browser.close();
await close();
// The room places this character facing right, so that is what the atlas has
// to hold; anything reading left is flipped on the way in.
const WANT = opt('want', 'right');
const flipped = verdicts.filter((v) => v.dir !== WANT && v.dir !== 'unclear')
  .map((v) => v.p.split('/').pop().replace('.png', ''));
if (flipped.length) console.log(`\nfacing ${WANT} is wanted — flip when cutting: ${flipped.join(',')}`);
else console.log(`\nall readable sheets already face ${WANT}`);
if (verdicts.some((v) => v.dir === 'unclear')) {
  console.log('unclear means too little skin in the head band of frame 1 — a hat brim or a raised cup can do it');
}
