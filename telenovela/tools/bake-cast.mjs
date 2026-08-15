#!/usr/bin/env node
// Turn the pristine Tripo downloads into the files the episode actually ships.
//
//   node tools/bake-cast.mjs                  # src/ -> company/cast/models/
//   node tools/bake-cast.mjs --base 640
//
// Everything here is offline — zero Tripo API spend — and it is where the
// budget is won. Two things it does that matter more than the shrinking:
//
//   Animation clips are stripped to tracks. Tripo returns a retarget as a
//   whole second copy of the character: mesh, skeleton and three 4096 px maps,
//   3.3 MB to carry 2.4 seconds of rotation curves. The mesh, materials,
//   images and skin are deleted and only the bone hierarchy and the animation
//   survive, which is the same motion in about twenty kilobytes.
//
//   Those clips are then shared by the whole cast. Every character Tripo rigs
//   comes back on the same 41-joint skeleton with the same bone names, so one
//   walk fits all of them; the clips are named anim-*.glb rather than
//   esteban-*.glb because they no longer belong to anybody.
//
// Materials get metalness forced to 0 and roughness to 0.85 with the
// metallic-roughness map dropped: the raw bake is wet-looking plastic under a
// key light, which is the one thing the first cast was unanimously dinged for.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
// Set dressing is the same job — shrink the maps, narrow the vertices — minus
// the skeleton and the clips, so --props swings the paths over and skips them.
const PROPS = args.includes('--props');
const SRC = join(ROOT, PROPS ? 'company/props/src' : 'company/cast/models/src');
const DST = join(ROOT, PROPS ? 'company/props/assets' : 'company/cast/models');
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const BASE = +opt('base', 512);      // base colour / emissive
const AUX = +opt('aux', 256);        // normal
const QUALITY = +opt('quality', 0.86);

// Who ships as a sculpt, and what their shipping file is called. Ricardo is
// absent on purpose: he is Esteban's mesh in a different coat (see below).
const CAST = [
  { key: 'esteban', out: 'esteban.glb' },
  { key: 'ricardo', out: 'ricardo.glb' },
  { key: 'rosalinda', out: 'rosalinda.glb' },
  { key: 'valentina', out: 'valentina.glb' },
  { key: 'donGallo', out: 'don-gallo.glb' },
];
// Clips are cut from whichever character was retargeted; they fit all of them.
// `stride` thins keyframes. The idle is 15 s of standing about and carries
// two thirds of the clip budget; walk and run are short loops where every key
// is doing something, so they are left alone.
const CLIPS = [
  { from: 'esteban-idle.glb', out: 'anim-idle.glb', stride: 2 },
  { from: 'esteban-walk.glb', out: 'anim-walk.glb' },
  { from: 'esteban-run.glb', out: 'anim-run.glb' },
];

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
  const jh = Buffer.alloc(8); jh.writeUInt32LE(jsonChunk.length, 0); jh.writeUInt32LE(JSON_CHUNK, 4);
  const bh = Buffer.alloc(8); bh.writeUInt32LE(binChunk.length, 0); bh.writeUInt32LE(BIN_CHUNK, 4);
  return Buffer.concat([head, jh, jsonChunk, bh, binChunk]);
}

// Rebuild the binary chunk from a list of {index -> data} replacements, keeping
// every accessor's alignment. Returns the new bin.
function repackBin(json, bin, replace) {
  const chunks = [];
  let offset = 0;
  for (let i = 0; i < (json.bufferViews || []).length; i++) {
    const bv = json.bufferViews[i];
    const data = replace.get(i)
      ?? bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
    const align = (4 - (offset % 4)) % 4;
    if (align) { chunks.push(Buffer.alloc(align)); offset += align; }
    bv.byteOffset = offset;
    bv.byteLength = data.length;
    delete bv.byteStride;   // images have none, and a stale stride is invalid
    chunks.push(data);
    offset += data.length;
  }
  const out = Buffer.concat(chunks);
  json.buffers = [{ byteLength: out.length }];
  return out;
}

// --- geometry quantization --------------------------------------------------
// Tripo emits 32-bit indices for a 12k-vertex mesh and float32 skin weights,
// which together outweigh the textures. Both narrow without visible loss: a
// mesh under 65536 vertices indexes in 16 bits exactly, and a skin weight is a
// number between zero and one that only ever gets multiplied by a matrix.
// Only accessors that own their buffer view outright are touched.
function quantize(json, bin, replace, strides) {
  let quantized = false;
  const owners = new Map();
  for (const a of json.accessors || []) {
    if (a.bufferView === undefined) continue;
    owners.set(a.bufferView, (owners.get(a.bufferView) || 0) + 1);
  }
  const exclusive = (a) => a && a.bufferView !== undefined
    && owners.get(a.bufferView) === 1
    && !json.bufferViews[a.bufferView].byteStride
    && !replace.has(a.bufferView);
  const read = (a) => {
    const bv = json.bufferViews[a.bufferView];
    return bin.subarray((bv.byteOffset || 0) + (a.byteOffset || 0),
      (bv.byteOffset || 0) + (a.byteOffset || 0) + bv.byteLength - (a.byteOffset || 0));
  };
  const notes = [];

  for (const mesh of json.meshes || []) {
    for (const prim of mesh.primitives || []) {
      const idx = json.accessors?.[prim.indices];
      if (idx && idx.componentType === 5125 && exclusive(idx)) {
        const src = new Uint32Array(read(idx).buffer, read(idx).byteOffset, idx.count);
        let max = 0;
        for (let i = 0; i < src.length; i++) if (src[i] > max) max = src[i];
        if (max < 65536) {
          const out = Buffer.alloc(idx.count * 2);
          for (let i = 0; i < src.length; i++) out.writeUInt16LE(src[i], i * 2);
          replace.set(idx.bufferView, out);
          idx.componentType = 5123;
          idx.byteOffset = 0;
          notes.push(`indices u32→u16 ${(src.byteLength / 1024).toFixed(0)}→${(out.length / 1024).toFixed(0)}KB`);
        }
      }
      // A normal is a unit vector, so a signed byte per axis is 1/256 of a
      // right angle — finer than the shading it feeds. A UV inside the unit
      // square keeps 16 bits of a texture we just shrank to 512 px.
      const nrm = json.accessors?.[prim.attributes?.NORMAL];
      if (nrm && nrm.componentType === 5126 && nrm.type === 'VEC3' && exclusive(nrm)) {
        const buf = read(nrm);
        const src = new Float32Array(buf.buffer, buf.byteOffset, nrm.count * 3);
        const out = Buffer.alloc(nrm.count * 4);   // 3 bytes + 1 pad, stride 4
        for (let v = 0; v < nrm.count; v++) {
          for (let k = 0; k < 3; k++) {
            out.writeInt8(Math.max(-127, Math.min(127, Math.round(src[v * 3 + k] * 127))), v * 4 + k);
          }
        }
        replace.set(nrm.bufferView, out);
        strides.set(nrm.bufferView, 4);
        nrm.componentType = 5120; nrm.normalized = true; nrm.byteOffset = 0;
        quantized = true;
        notes.push(`normals f32→i8 ${(src.byteLength / 1024).toFixed(0)}→${(out.length / 1024).toFixed(0)}KB`);
      }

      const uv = json.accessors?.[prim.attributes?.TEXCOORD_0];
      if (uv && uv.componentType === 5126 && uv.type === 'VEC2' && exclusive(uv)) {
        const buf = read(uv);
        const src = new Float32Array(buf.buffer, buf.byteOffset, uv.count * 2);
        let lo = Infinity, hi = -Infinity;
        for (let i = 0; i < src.length; i++) { if (src[i] < lo) lo = src[i]; if (src[i] > hi) hi = src[i]; }
        // Outside the unit square a normalized ushort would wrap the tiling.
        if (lo >= 0 && hi <= 1) {
          const out = Buffer.alloc(uv.count * 4);
          for (let i = 0; i < src.length; i++) out.writeUInt16LE(Math.round(src[i] * 65535), i * 2);
          replace.set(uv.bufferView, out);
          strides.set(uv.bufferView, 4);
          uv.componentType = 5123; uv.normalized = true; uv.byteOffset = 0;
          quantized = true;
          notes.push(`uv f32→u16 ${(src.byteLength / 1024).toFixed(0)}→${(out.length / 1024).toFixed(0)}KB`);
        }
      }

      const w = json.accessors?.[prim.attributes?.WEIGHTS_0];
      if (w && w.componentType === 5126 && w.type === 'VEC4' && exclusive(w)) {
        const buf = read(w);
        const src = new Float32Array(buf.buffer, buf.byteOffset, w.count * 4);
        const out = Buffer.alloc(w.count * 4);
        for (let v = 0; v < w.count; v++) {
          // Quantise, then hand the rounding error to the largest weight so
          // every vertex still sums to exactly 1 and nothing shrinks.
          let sum = 0, big = 0;
          const q = [0, 0, 0, 0];
          for (let k = 0; k < 4; k++) {
            q[k] = Math.round(Math.min(1, Math.max(0, src[v * 4 + k])) * 255);
            sum += q[k];
            if (q[k] > q[big]) big = k;
          }
          q[big] += 255 - sum;
          for (let k = 0; k < 4; k++) out[v * 4 + k] = Math.min(255, Math.max(0, q[k]));
        }
        replace.set(w.bufferView, out);
        w.componentType = 5121;
        w.normalized = true;
        w.byteOffset = 0;
        notes.push(`weights f32→u8 ${(src.byteLength / 1024).toFixed(0)}→${(out.length / 1024).toFixed(0)}KB`);
      }
    }
  }
  // Narrowed vertex attributes are only legal under this extension, and a
  // loader that does not implement it must refuse the file rather than read
  // the bytes as floats.
  if (quantized) {
    json.extensionsUsed = [...new Set([...(json.extensionsUsed || []), 'KHR_mesh_quantization'])];
    json.extensionsRequired = [...new Set([...(json.extensionsRequired || []), 'KHR_mesh_quantization'])];
  }
  return notes;
}

// Which images are base colour and which are detail.
function classify(json) {
  const roles = new Map();
  const mark = (i, role) => {
    if (i === undefined || i === null) return;
    const tex = json.textures?.[i];
    if (!tex || tex.source === undefined) return;
    if (role === 'base' || !roles.has(tex.source)) roles.set(tex.source, role);
  };
  for (const m of json.materials || []) {
    mark(m.pbrMetallicRoughness?.baseColorTexture?.index, 'base');
    mark(m.emissiveTexture?.index, 'base');
    mark(m.normalTexture?.index, 'aux');
    mark(m.occlusionTexture?.index, 'aux');
  }
  return roles;
}

// --- animation-only extraction ----------------------------------------------
// Channels address nodes by index, so the node array is kept whole and only
// its mesh/skin attachments are cut. Everything an animation does not read is
// dropped, then the accessors it does read are renumbered into a fresh table.
//
// Two thirds of a retarget is channels that say nothing. Bones never scale, so
// every scale track is a constant repeated 369 times; and only the root
// translates, because a skeleton's joints are fixed to their parents — the
// rest are the bind offset restated per frame. Dropping both is lossless.
function stripToAnimation(json, bin, stride = 1) {
  const rootish = new Set((json.nodes || [])
    .map((n, i) => (/^(root|hip|pelvis)$/i.test(n.name || '') ? i : -1))
    .filter((i) => i >= 0));
  for (const anim of json.animations || []) {
    anim.channels = anim.channels.filter((c) => c.target.path !== 'scale'
      && (c.target.path !== 'translation' || rootish.has(c.target.node)));
    // Samplers left unreferenced by the surviving channels go with them.
    const used = new Set(anim.channels.map((c) => c.sampler));
    const map = new Map();
    anim.samplers = anim.samplers.filter((_, i) => used.has(i))
      .map((s, i) => { map.set([...used].sort((a, b) => a - b)[i], i); return s; });
    for (const c of anim.channels) c.sampler = map.get(c.sampler);
  }

  const keep = new Set();
  for (const anim of json.animations || []) {
    for (const s of anim.samplers) { keep.add(s.input); keep.add(s.output); }
  }
  const accMap = new Map();
  const accessors = [];
  const views = [];
  const data = [];
  const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
  for (const old of [...keep].sort((a, b) => a - b)) {
    const acc = { ...json.accessors[old] };
    if (acc.bufferView !== undefined) {
      const bv = json.bufferViews[acc.bufferView];
      let raw = bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
      // A 15-second resting loop does not need a key every 24th of a second.
      // Thinning it is the cheapest half-megabyte in the bundle, and the mixer
      // interpolates the difference away.
      if (stride > 1 && acc.componentType === 5126 && COMPONENTS[acc.type]) {
        const n = COMPONENTS[acc.type];
        const src = new Float32Array(raw.buffer, raw.byteOffset, acc.count * n);
        const kept = [];
        for (let i = 0; i < acc.count; i++) {
          // Always keep the last key: dropping it shortens the loop and the
          // clip no longer meets its own start.
          if (i % stride === 0 || i === acc.count - 1) kept.push(i);
        }
        const out = Buffer.alloc(kept.length * n * 4);
        kept.forEach((src_i, j) => {
          for (let k = 0; k < n; k++) out.writeFloatLE(src[src_i * n + k], (j * n + k) * 4);
        });
        raw = out;
        acc.count = kept.length;
      }
      data.push(raw);
      acc.bufferView = views.length;
      // `buffer` is not optional: a view without it dangles, and the loader
      // fails downstream on the accessor rather than here.
      views.push({ buffer: 0, byteLength: raw.length });
    }
    accMap.set(old, accessors.length);
    accessors.push(acc);
  }
  for (const anim of json.animations || []) {
    for (const s of anim.samplers) { s.input = accMap.get(s.input); s.output = accMap.get(s.output); }
  }
  for (const n of json.nodes || []) { delete n.mesh; delete n.skin; }

  const out = {
    asset: json.asset, scene: json.scene, scenes: json.scenes,
    nodes: json.nodes, animations: json.animations,
    accessors, bufferViews: views,
  };
  // Re-emit the kept views back to back, honouring alignment.
  const chunks = [];
  let offset = 0;
  for (let i = 0; i < views.length; i++) {
    const align = (4 - (offset % 4)) % 4;
    if (align) { chunks.push(Buffer.alloc(align)); offset += align; }
    views[i].byteOffset = offset;
    chunks.push(data[i]);
    offset += data[i].length;
  }
  const newBin = Buffer.concat(chunks);
  out.buffers = [{ byteLength: newBin.length }];
  return { json: out, bin: newBin };
}

// --- go ---------------------------------------------------------------------

// Props are listed by whatever has been generated, not by a cast list.
if (PROPS) {
  const { readdir } = await import('node:fs/promises');
  CAST.length = 0;
  CLIPS.length = 0;
  for (const f of (await readdir(SRC)).filter((f) => f.endsWith('.glb')).sort()) {
    CAST.push({ key: f.replace(/\.glb$/, ''), out: f, raw: true });
  }
}

await mkdir(DST, { recursive: true });
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] });
const page = await browser.newPage();
await page.setContent('<!doctype html><meta charset=utf-8><title>bake</title>');
await page.evaluate(() => {
  // mode 'ricardo' remaps the twin's plumage to blue/charcoal while sparing
  // the true comb reds — the whole difference between the brothers.
  window.__bake = async (dataUri, max, quality, mode) => {
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res; img.onerror = () => rej(new Error('decode failed')); img.src = dataUri;
    });
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.width * scale));
    c.height = Math.max(1, Math.round(img.height * scale));
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, 0, 0, c.width, c.height);
    if (mode === 'lift') {
      // A textured PBR bird drinks the night grade where the procedural cast's
      // flat materials reflected it. Brightening at runtime by multiplying the
      // material colour clips the red channel first and turns copper plumage
      // into a saturated postbox red, so the lift happens here instead, as a
      // gamma curve: it opens the shadows, leaves the highlights alone, and
      // holds the hue it was painted with.
      const id = g.getImageData(0, 0, c.width, c.height);
      const d = id.data;
      const lut = new Uint8Array(256);
      for (let i = 0; i < 256; i++) lut[i] = Math.round(255 * Math.pow(i / 255, 1 / 1.42));
      for (let i = 0; i < d.length; i += 4) {
        d[i] = lut[d[i]]; d[i + 1] = lut[d[i + 1]]; d[i + 2] = lut[d[i + 2]];
      }
      g.putImageData(id, 0, 0);
    } else if (mode === 'ricardo') {
      const id = g.getImageData(0, 0, c.width, c.height);
      const d = id.data;
      const mix = (a, b, t) => a + (b - a) * t;
      for (let i = 0; i < d.length; i += 4) {
        let r = d[i], gg = d[i + 1], b = d[i + 2];
        const isComb = r > 135 && gg < r * 0.36 && b < r * 0.5;
        const isGold = !isComb && r > 110 && gg > r * 0.55 && b < gg * 0.75;
        if (isComb) { r *= 1.04; gg *= 1.04; b *= 1.04; }
        else if (isGold) { r = mix(r, 74, 0.5); gg = mix(gg, 79, 0.5); b = mix(b, 92, 0.5); }
        else {
          const l = Math.pow((0.299 * r + 0.587 * gg + 0.114 * b) / 255, 0.92);
          r = l * 118 + 8; gg = l * 134 + 10; b = l * 172 + 16;
        }
        d[i] = Math.min(255, r); d[i + 1] = Math.min(255, gg); d[i + 2] = Math.min(255, b);
      }
      g.putImageData(id, 0, 0);
    }
    return { uri: c.toDataURL('image/jpeg', quality), w: c.width, h: c.height };
  };
});

let total = 0;

for (const { key, out } of CAST) {
  let original;
  try { original = await readFile(join(SRC, PROPS ? `${key}.glb` : `${key}-rigged.glb`)); } catch {
    console.log(`  ${key}: no rigged source, skipped`);
    continue;
  }
  const { json, bin } = readGlb(original);
  const roles = classify(json);

  // Kill the wet-plastic look and drop the map that drives it.
  for (const m of json.materials || []) {
    const p = m.pbrMetallicRoughness || (m.pbrMetallicRoughness = {});
    delete p.metallicRoughnessTexture;
    p.metallicFactor = 0;
    p.roughnessFactor = 0.85;
  }

  const replace = new Map();
  const notes = [];
  for (let i = 0; i < (json.bufferViews || []).length; i++) {
    const image = (json.images || []).findIndex((im) => im.bufferView === i);
    if (image < 0) continue;
    // An image no material references any more is dead weight; skip it and it
    // still occupies its view, so shrink it to nothing instead.
    const role = roles.get(image);
    const bv = json.bufferViews[i];
    const raw = bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
    if (!role) { replace.set(i, Buffer.alloc(0)); notes.push('dropped 1 unused map'); continue; }
    const uri = `data:${json.images[image].mimeType || 'image/png'};base64,${raw.toString('base64')}`;
    const isBase = role === 'base';
    const res = await page.evaluate(([u, m, q, md]) => window.__bake(u, m, q, md),
      [uri, isBase ? BASE : AUX, QUALITY, (isBase && !PROPS) ? 'lift' : null]);
    const shrunk = Buffer.from(res.uri.slice(res.uri.indexOf(',') + 1), 'base64');
    replace.set(i, shrunk);
    json.images[image].mimeType = 'image/jpeg';
    notes.push(`${role} ${res.w}px ${(raw.length / 1024).toFixed(0)}→${(shrunk.length / 1024).toFixed(0)}KB`);

  }

  const strides = new Map();
  notes.push(...quantize(json, bin, replace, strides));
  const newBin = repackBin(json, bin, replace);
  // repackBin clears strides (image views must not carry one); the quantized
  // attribute views need theirs back, since 3 bytes of normal sit in 4.
  for (const [view, stride] of strides) json.bufferViews[view].byteStride = stride;
  const glb = writeGlb(json, newBin);
  await writeFile(join(DST, out), glb);
  total += glb.length;
  console.log(`  ${out}: ${(original.length / 1048576).toFixed(2)} → ${(glb.length / 1048576).toFixed(2)} MB  [${notes.join(', ')}]`);
}

for (const { from, out, stride } of CLIPS) {
  let original;
  try { original = await readFile(join(SRC, from)); } catch {
    console.log(`  ${out}: no source (${from}), skipped`);
    continue;
  }
  const { json, bin } = readGlb(original);
  const names = (json.animations || []).map((a) => a.name).join(', ');
  const stripped = stripToAnimation(json, bin, stride || 1);
  const glb = writeGlb(stripped.json, stripped.bin);
  await writeFile(join(DST, out), glb);
  total += glb.length;
  console.log(`  ${out}: ${(original.length / 1048576).toFixed(2)} MB → ${(glb.length / 1024).toFixed(0)} KB  [${names}]`);
}

await browser.close();
console.log(`\nshipping cast: ${(total / 1048576).toFixed(2)} MB`);
