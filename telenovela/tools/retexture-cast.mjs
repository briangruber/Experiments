#!/usr/bin/env node
// Regenerate the shipping twin models from the pristine Tripo downloads:
//
//   node tools/retexture-cast.mjs            # src/ -> company/cast/models/
//
// Three jobs in one pass, all offline (zero Tripo API spend):
//
//   1. Shrink: base colour to 512 px, normal/metallic-roughness to 256 px,
//      JPEG q0.86 — the same recipe as tools/shrink-assets.mjs.
//   2. Grade Esteban's base colour for the night grade: brighten and de-redden
//      the feathers toward the identity copper-orange (the raw bake reads
//      blood-red/mahogany under the grade), keep the comb red, and flatten the
//      sculpted beak texels toward plumage so the painted snout can never read
//      as a second beak beside the overlay one.
//   3. Cut ricardo-body.jpg: the same map remapped to Ricardo's blue/charcoal
//      palette. He shares Esteban's skinned scene at load (identical twins,
//      identical mesh), so the recolored map is the whole difference.
//
// There is no image library in this environment, so pixels go through the
// headless browser that is already here: canvas in, ImageData math, JPEG out.

import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'company/cast/models/src');
const DST = join(ROOT, 'company/cast/models');

const BASE = 512, AUX = 256, QUALITY = 0.86;
const FILES = ['esteban-idle.glb', 'esteban-walk.glb', 'esteban-run.glb'];

async function loadPlaywright() {
  for (const c of ['playwright', '/opt/node22/lib/node_modules/playwright/index.mjs',
    '/usr/lib/node_modules/playwright/index.mjs', process.env.PLAYWRIGHT_PATH].filter(Boolean)) {
    try { return await import(c); } catch { /* next */ }
  }
  throw new Error('playwright not found');
}

// --- GLB container (same as tools/shrink-assets.mjs) ------------------------

const MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;

function readGlb(buf) {
  if (buf.readUInt32LE(0) !== MAGIC) throw new Error('not a GLB');
  let off = 12, json = null, bin = null;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    const body = buf.subarray(off + 8, off + 8 + len);
    if (type === JSON_CHUNK) json = JSON.parse(body.toString('utf8'));
    else if (type === BIN_CHUNK) bin = Buffer.from(body);
    off += 8 + len + ((4 - (len % 4)) % 4);
  }
  if (!json || !bin) throw new Error('GLB missing a chunk');
  return { json, bin };
}

function pad4(buf, fill) {
  const n = (4 - (buf.length % 4)) % 4;
  return n ? Buffer.concat([buf, Buffer.alloc(n, fill)]) : buf;
}

function writeGlb(json, bin) {
  const jsonChunk = pad4(Buffer.from(JSON.stringify(json), 'utf8'), 0x20);
  const binChunk = pad4(bin, 0);
  const head = Buffer.alloc(12);
  head.writeUInt32LE(MAGIC, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8);
  const jh = Buffer.alloc(8);
  jh.writeUInt32LE(jsonChunk.length, 0);
  jh.writeUInt32LE(JSON_CHUNK, 4);
  const bh = Buffer.alloc(8);
  bh.writeUInt32LE(binChunk.length, 0);
  bh.writeUInt32LE(BIN_CHUNK, 4);
  return Buffer.concat([head, jh, jsonChunk, bh, binChunk]);
}

function classify(json) {
  const roles = new Map();
  const mark = (texIndex, role) => {
    if (texIndex === undefined || texIndex === null) return;
    const tex = json.textures?.[texIndex];
    if (!tex || tex.source === undefined) return;
    if (role === 'base' || !roles.has(tex.source)) roles.set(tex.source, role);
  };
  for (const m of json.materials || []) {
    mark(m.pbrMetallicRoughness?.baseColorTexture?.index, 'base');
    mark(m.emissiveTexture?.index, 'base');
    mark(m.pbrMetallicRoughness?.metallicRoughnessTexture?.index, 'aux');
    mark(m.normalTexture?.index, 'aux');
    mark(m.occlusionTexture?.index, 'aux');
  }
  return roles;
}

// --- go ---------------------------------------------------------------------

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] });
const page = await browser.newPage();
await page.setContent('<!doctype html><meta charset=utf-8><title>retexture</title>');
await page.evaluate(() => {
  // One decode, N outputs: resize to `max`, run `mode` over the pixels, JPEG.
  //
  // Pixel classes (by colour, since the UV layout is Tripo's own):
  //   comb    — saturated bright red skin: keep it red, it is the identity.
  //   gold    — beak and legs: for Esteban, flattened toward dark copper so
  //             the sculpted snout never reads beside the overlay beak; for
  //             Ricardo, toward slate for the same reason.
  //   feather — everything else.
  window.__grade = async (dataUri, max, quality, mode) => {
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = () => rej(new Error('decode failed'));
      img.src = dataUri;
    });
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.width * scale));
    c.height = Math.max(1, Math.round(img.height * scale));
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, 0, 0, c.width, c.height);
    if (mode) {
      const id = g.getImageData(0, 0, c.width, c.height);
      const d = id.data;
      const mix = (a, b, t) => a + (b - a) * t;
      for (let i = 0; i < d.length; i += 4) {
        let r = d[i], gg = d[i + 1], b = d[i + 2];
        // Esteban keeps his warm breast; Ricardo's remap must only spare the
        // TRUE comb reds or the saturated orange breast stays orange on blue.
        const isComb = mode === 'ricardo'
          ? r > 135 && gg < r * 0.36 && b < r * 0.5
          : r > 135 && gg < r * 0.5 && b < r * 0.55;
        const isGold = !isComb && r > 110 && gg > r * 0.55 && b < gg * 0.75;
        if (mode === 'esteban') {
          if (isComb) {
            r *= 1.06; gg *= 1.06; b *= 1.06;
          } else if (isGold) {
            r = mix(r, 138, 0.55); gg = mix(gg, 86, 0.55); b = mix(b, 50, 0.55);
          } else {
            // Feathers: toward copper-orange 0xb06a35 ratios (g≈0.60r,
            // b≈0.30r), then a stop brighter so the lead holds the key.
            if (gg < r * 0.60) gg = mix(gg, r * 0.60, 0.55);
            if (b < r * 0.30) b = mix(b, r * 0.30, 0.35);
            r *= 1.16; gg *= 1.16; b *= 1.12;
          }
        } else if (mode === 'ricardo') {
          if (isComb) {
            r *= 1.04; gg *= 1.04; b *= 1.04;
          } else if (isGold) {
            r = mix(r, 74, 0.55); gg = mix(gg, 79, 0.55); b = mix(b, 92, 0.55);
          } else {
            // Blue/charcoal ramp on the (graded) luminance.
            const l = Math.pow((0.299 * r + 0.587 * gg + 0.114 * b) / 255, 0.92);
            r = l * 118 + 8; gg = l * 134 + 10; b = l * 172 + 16;
          }
        }
        d[i] = Math.min(255, r); d[i + 1] = Math.min(255, gg); d[i + 2] = Math.min(255, b);
      }
      g.putImageData(id, 0, 0);
    }
    return { uri: c.toDataURL('image/jpeg', quality), w: c.width, h: c.height };
  };
});

let ricardoDone = false;
for (const file of FILES) {
  const original = await readFile(join(SRC, file));
  const { json, bin } = readGlb(original);
  const roles = classify(json);

  const chunks = [];
  let offset = 0;
  const notes = [];
  for (let i = 0; i < (json.bufferViews || []).length; i++) {
    const bv = json.bufferViews[i];
    let data = bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);

    const image = (json.images || []).findIndex((im) => im.bufferView === i);
    if (image >= 0) {
      const isBase = roles.get(image) !== 'aux';
      const mime = json.images[image].mimeType || 'image/png';
      const uri = `data:${mime};base64,${data.toString('base64')}`;
      const out = await page.evaluate(
        ([u, m, q, mode]) => window.__grade(u, m, q, mode),
        [uri, isBase ? BASE : AUX, QUALITY, isBase ? 'esteban' : null],
      );
      const shrunk = Buffer.from(out.uri.slice(out.uri.indexOf(',') + 1), 'base64');
      notes.push(`${isBase ? 'base' : 'aux'} ${out.w}px ${(data.length / 1024).toFixed(0)}→${(shrunk.length / 1024).toFixed(0)}KB`);
      data = shrunk;
      json.images[image].mimeType = 'image/jpeg';

      // Ricardo's map is cut from the first base colour we meet (the shared
      // texture is identical across the three GLBs).
      if (isBase && !ricardoDone) {
        const ric = await page.evaluate(
          ([u, m, q]) => window.__grade(u, m, q, 'ricardo'), [uri, BASE, 0.86],
        );
        const buf = Buffer.from(ric.uri.slice(ric.uri.indexOf(',') + 1), 'base64');
        await writeFile(join(DST, 'ricardo-body.jpg'), buf);
        console.log(`  ricardo-body.jpg: ${ric.w}px, ${(buf.length / 1024).toFixed(0)} KB`);
        ricardoDone = true;
      }
    }

    const align = (4 - (offset % 4)) % 4;
    if (align) { chunks.push(Buffer.alloc(align)); offset += align; }
    bv.byteOffset = offset;
    bv.byteLength = data.length;
    chunks.push(data);
    offset += data.length;
  }

  const newBin = Buffer.concat(chunks);
  json.buffers = [{ byteLength: newBin.length }];
  const out = writeGlb(json, newBin);
  await writeFile(join(DST, file), out);
  console.log(`  ${file}: ${(original.length / 1048576).toFixed(2)} → ${(out.length / 1048576).toFixed(2)} MB  [${notes.join(', ')}]`);
}

await browser.close();
console.log('done');
