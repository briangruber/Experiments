#!/usr/bin/env node
// Turn the generated photographs into something the bundle can carry.
//
// Three jobs: shrink them (a 1024 JPEG is 750 KB and the shore needs detail,
// not resolution), derive a NORMAL map from luminance (the albedo's own
// shading is a decent proxy for its relief, and a real normal map is what
// makes rock read as rock rather than as a picture of rock), and emit both as
// data URIs -- the artifact is one file behind a CSP that blocks fetching, so
// every byte has to be inline.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs');
const browser = await chromium.launch();
const page = await browser.newPage();

const SIZE = 512;
const out = {};

for (const [key, file, strength] of [['rock', 'tex/rock.jpg', 2.2], ['sand', 'tex/sand.jpg', 1.2]]) {
  const b64 = (await readFile(resolve(ROOT, file))).toString('base64');
  const r = await page.evaluate(async ({ b64, SIZE, strength }) => {
    const img = new Image();
    img.src = 'data:image/jpeg;base64,' + b64;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = c.height = SIZE;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0, SIZE, SIZE);
    const albedo = c.toDataURL('image/jpeg', 0.82);
    // Mean luminance, so the shader can use the photograph as a MODULATION
    // that averages to 1. Multiplying a computed colour by a dark grey rock
    // photo just makes everything dark -- the texture has to carry its
    // variation without carrying its own overall brightness.
    const md = g.getImageData(0, 0, SIZE, SIZE).data;
    let sum = 0;
    for (let i = 0; i < md.length; i += 4)
      sum += (md[i] * 0.299 + md[i + 1] * 0.587 + md[i + 2] * 0.114) / 255;
    const mean = sum / (SIZE * SIZE);

    // Normal from luminance by Sobel, wrapped so the map stays tileable.
    const d = g.getImageData(0, 0, SIZE, SIZE).data;
    const lum = new Float32Array(SIZE * SIZE);
    for (let i = 0, j = 0; i < d.length; i += 4, j++)
      lum[j] = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) / 255;
    const at = (x, y) => lum[((y + SIZE) % SIZE) * SIZE + ((x + SIZE) % SIZE)];
    const nd = g.createImageData(SIZE, SIZE);
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
      const dx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1))
               - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
      const dy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1))
               - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
      let nx = -dx * strength, ny = -dy * strength, nz = 1;
      const l = Math.hypot(nx, ny, nz);
      const o = (y * SIZE + x) * 4;
      nd.data[o] = (nx / l * 0.5 + 0.5) * 255;
      nd.data[o + 1] = (ny / l * 0.5 + 0.5) * 255;
      nd.data[o + 2] = (nz / l * 0.5 + 0.5) * 255;
      nd.data[o + 3] = 255;
    }
    g.putImageData(nd, 0, 0);
    return { albedo, mean, normal: c.toDataURL('image/jpeg', 0.80) };
  }, { b64, SIZE, strength });
  out[key] = r;
  console.log(`${key}: albedo ${(r.albedo.length / 1024) | 0} KB, normal ${(r.normal.length / 1024) | 0} KB, mean ${r.mean.toFixed(3)}`);
}

// ------------------------------------------------------------- the pines --
//
// FLUX has no alpha channel, so the trees come back on white and are keyed
// here. Three steps, and each exists because skipping it looks wrong:
//
// KEY on the darkest channel, not on luminance. White paper has min(r,g,b)=1
// and foliage has a low blue, so 1-min separates them cleanly; keying on
// luminance instead makes the whole tree semi-transparent, because a lit pine
// is not actually dark.
//
// CROP to the confident pixels first. The generator throws a soft grey shadow
// on the paper, which is neutral and faint -- above the key threshold but well
// below the tree -- so a bounding box over strongly-keyed pixels alone leaves
// it behind, and the crop doubles as a tight atlas.
//
// UNPREMULTIPLY against white. Edge pixels are a blend of needle and paper;
// left alone they ring the whole silhouette in a white halo that reads as
// glow against a dark headland. Backing the paper out of the partial pixels
// is what makes the edge look cut rather than lit.
for (const [key, file] of [['pine1', 'tex/pine1.jpg'], ['pine2', 'tex/pine2.jpg']]) {
  const b64 = (await readFile(resolve(ROOT, file))).toString('base64');
  const r = await page.evaluate(async ({ b64 }) => {
    const img = new Image();
    img.src = 'data:image/jpeg;base64,' + b64;
    await img.decode();
    const W = img.width, H = img.height;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, W, H);
    const px = d.data;

    const alphaOf = (i) => {
      const mn = Math.min(px[i], px[i + 1], px[i + 2]) / 255;
      const a = (1 - mn - 0.04) / 0.30;
      return Math.max(0, Math.min(1, a));
    };

    let x0 = W, y0 = H, x1 = 0, y1 = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (alphaOf((y * W + x) * 4) > 0.55) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    const pad = 4;
    x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
    x1 = Math.min(W - 1, x1 + pad); y1 = Math.min(H - 1, y1 + pad);
    const cw = x1 - x0 + 1, ch = y1 - y0 + 1;

    const out = document.createElement('canvas');
    const SCALE = Math.min(1, 512 / ch);
    out.width = Math.round(cw * SCALE); out.height = Math.round(ch * SCALE);
    const og = out.getContext('2d');
    const tmp = document.createElement('canvas');
    tmp.width = cw; tmp.height = ch;
    const tg = tmp.getContext('2d');
    const cd = tg.createImageData(cw, ch);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const si = ((y + y0) * W + (x + x0)) * 4, di = (y * cw + x) * 4;
      const a = alphaOf(si);
      // Unpremultiply against white paper.
      for (let k = 0; k < 3; k++) {
        const v = a > 0.01 ? (px[si + k] - 255 * (1 - a)) / a : 0;
        cd.data[di + k] = Math.max(0, Math.min(255, v));
      }
      cd.data[di + 3] = Math.round(a * 255);
    }
    tg.putImageData(cd, 0, 0);
    og.drawImage(tmp, 0, 0, out.width, out.height);
    return { png: out.toDataURL('image/png'), w: out.width, h: out.height };
  }, { b64 });
  out[key] = r;
  console.log(`${key}: ${r.w}x${r.h}, ${(r.png.length / 1024) | 0} KB`);
}

await browser.close();
await writeFile(resolve(ROOT, 'src/textures.js'),
  '// GENERATED by tools/bake-textures.mjs -- do not edit.\n'
  + '// Albedo and derived normal maps, inline because the artifact is one file\n'
  + '// behind a CSP that blocks fetching anything external.\n'
  + `export const TEX = ${JSON.stringify(out, null, 1)};\n`);
console.log('wrote src/textures.js');
