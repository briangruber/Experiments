#!/usr/bin/env node
// GLB -> inlined quantized mesh module, the format demo/craftModel.js ships in.
//
//   node tools/glb.mjs --in model.glb --out demo/planeModel.js --name PLANE_MESH \
//        --forward -x --tex-size 1024 --tex-quality 0.85
//
// Why this exists: the artifact's CSP blocks every external request, so models
// ship INSIDE the bundle. Raw glTF floats are ~4x bigger than they need to be
// and the textures are 4k PNGs measured in megabytes. This tool:
//
//   - parses the GLB (single mesh, single primitive - the Meshy export shape),
//   - rotates the model so its nose sits on -Z, the convention every craft in
//     this renderer uses for "forward" (--forward says which source axis the
//     nose is on: one of +x -x +z -z),
//   - quantizes: position Int16 scaled so the LENGTH axis spans +-16000 (the
//     decoder multiplies by lengthM/32000), normals Int8, UVs Uint16,
//     indices Uint16,
//   - downscales the baseColor to --tex-size and re-encodes it as JPEG. The
//     encode runs in headless chromium (tools/browser.mjs) because node has no
//     image codec and the repo already carries Playwright for every check.
//
// demo/craftModel.js predates this tool and was produced by a lost one-off
// with the same layout; this is that tool made real and kept.

import { readFile, writeFile } from 'node:fs/promises';
import { launchChromium } from './browser.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const IN = opt('in'); const OUT = opt('out'); const NAME = opt('name', 'MESH');
const FORWARD = opt('forward', '-z');
const TEX_SIZE = +opt('tex-size', 1024);
const TEX_Q = +opt('tex-quality', 0.85);
// --spin "hx,hy,hz,rCut,rMax,zMax,yFloor,seedR" bakes a per-vertex SPIN WEIGHT
// for a propeller: which vertices the renderer may rotate about the hub axis.
// All values are in NORMALISED model units (the bounding box centred, divided
// by the length axis), which is what the numbers below were measured in.
const SPIN = opt('spin', '');
if (!IN || !OUT) { console.error('need --in and --out'); process.exit(2); }

const buf = await readFile(IN);
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('not a GLB');
const jsonLen = dv.getUint32(12, true);
const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
const binOff = 20 + jsonLen + 8;
const bin = buf.subarray(binOff, binOff + dv.getUint32(20 + jsonLen, true));

const accessor = (i) => {
  const a = gltf.accessors[i];
  const bv = gltf.bufferViews[a.bufferView];
  const off = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const comps = { SCALAR: 1, VEC2: 2, VEC3: 3 }[a.type];
  const Ctor = { 5126: Float32Array, 5123: Uint16Array, 5125: Uint32Array }[a.componentType];
  return { data: new Ctor(bin.buffer, bin.byteOffset + off, a.count * comps), comps, count: a.count };
};

const prim = gltf.meshes[0].primitives[0];
const pos = accessor(prim.attributes.POSITION);
const nrm = accessor(prim.attributes.NORMAL);
const uv = accessor(prim.attributes.TEXCOORD_0);
const idx = accessor(prim.indices);

// ---- rotate so the nose lands on -Z ---------------------------------------
// Proper rotations only (det +1): a mirror would silently swap port and
// starboard on any asymmetric livery.
const ROT = {
  '-z': (x, y, z) => [x, y, z],
  '+z': (x, y, z) => [- x, y, - z],
  '-x': (x, y, z) => [- z, y, x],
  '+x': (x, y, z) => [z, y, - x],
}[FORWARD];
if (!ROT) throw new Error('--forward must be one of +x -x +z -z');

const n = pos.count;
const P = new Float64Array(n * 3);
for (let i = 0; i < n; i++) {
  const [x, y, z] = ROT(pos.data[i * 3], pos.data[i * 3 + 1], pos.data[i * 3 + 2]);
  P[i * 3] = x; P[i * 3 + 1] = y; P[i * 3 + 2] = z;
}
const NR = new Float64Array(n * 3);
for (let i = 0; i < n; i++) {
  const [x, y, z] = ROT(nrm.data[i * 3], nrm.data[i * 3 + 1], nrm.data[i * 3 + 2]);
  NR[i * 3] = x; NR[i * 3 + 1] = y; NR[i * 3 + 2] = z;
}

// Centre on the bounding box; the length axis is Z after the rotation.
const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) {
  min[c] = Math.min(min[c], P[i * 3 + c]); max[c] = Math.max(max[c], P[i * 3 + c]);
}
const ctr = min.map((m, c) => (m + max[c]) / 2);
const length = max[2] - min[2];

const qpos = new Int16Array(n * 3);
for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) {
  const v = (P[i * 3 + c] - ctr[c]) / length * 32000;
  if (Math.abs(v) > 32767) throw new Error('quantized position out of Int16 - model much wider than long?');
  qpos[i * 3 + c] = Math.round(v);
}
const qnrm = new Int8Array(n * 3);
for (let i = 0; i < n * 3; i++) qnrm[i] = Math.round(Math.max(-1, Math.min(1, NR[i])) * 127);
const quv = new Uint16Array(n * 2);
for (let i = 0; i < n * 2; i++) quv[i] = Math.round(Math.max(0, Math.min(1, uv.data[i])) * 65535);
if (n > 65535) throw new Error('more than 65535 vertices - Uint16 indices cannot address this');
const qidx = idx.data instanceof Uint16Array ? idx.data : Uint16Array.from(idx.data);

// ---- baseColor -> downscaled JPEG in headless chromium ---------------------
const matIdx = prim.material ?? 0;
const texInfo = gltf.materials[matIdx].pbrMetallicRoughness?.baseColorTexture;
let jpegB64 = '';
if (texInfo) {
  const img = gltf.images[gltf.textures[texInfo.index].source];
  const bv = gltf.bufferViews[img.bufferView];
  const png = bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength);
  const browser = await launchChromium();
  const page = await browser.newPage();
  jpegB64 = await page.evaluate(async ({ b64, size, q, mime }) => {
    const raw = atob(b64);
    const u8 = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) u8[i] = raw.charCodeAt(i);
    const bmp = await createImageBitmap(new Blob([u8], { type: mime }));
    const s = Math.min(1, size / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * s), h = Math.round(bmp.height * s);
    const c = new OffscreenCanvas(w, h);
    c.getContext('2d').drawImage(bmp, 0, 0, w, h);
    const out = await c.convertToBlob({ type: 'image/jpeg', quality: q });
    const ab = new Uint8Array(await out.arrayBuffer());
    let str = '';
    for (let i = 0; i < ab.length; i += 0x8000) str += String.fromCharCode(...ab.subarray(i, i + 0x8000));
    return btoa(str);
  }, { b64: png.toString('base64'), size: TEX_SIZE, q: TEX_Q, mime: img.mimeType });
  await browser.close();
}

// ---- propeller spin weights ------------------------------------------------
//
// WHY THIS IS A FLOOD FILL AND NOT A BOX.
//
// The blades sweep past the fuselage and the wing root, so no cylinder, slab or
// annulus around the hub separates them: measured on this asset, a generous
// annulus caught 472 vertices of which a third were fuselage, and the blade
// tips sit at the same radius from the hub as the wing root does. The UV atlas
// does not separate them either - Meshy's unwrap is fragmented, and the blades'
// UV bounding box contains 7220 vertices from the whole airframe. What DOES
// separate them is CONNECTIVITY: a blade reaches the airframe only through the
// spinner, so a fill seeded on unambiguous blade vertices and forbidden to
// cross into the spinner (r < rCut) stops exactly at the blade roots.
//
// The hub disc itself is then added unconditionally. It is a body of revolution
// about the spin axis, so rotating it is visually a no-op - and including it
// moves the shear boundary off the blade root (where it would show as a twist)
// and onto an axisymmetric surface (where it cannot show at all).
function spinWeights(P, idx, n, spec) {
  const [hx, hy, hz, rCut, rMax, zMax, yFloor, seedR] = spec.split(',').map(Number);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) {
    min[c] = Math.min(min[c], P[i * 3 + c]); max[c] = Math.max(max[c], P[i * 3 + c]);
  }
  const ctr = min.map((m, c) => (m + max[c]) / 2);
  const L = max[2] - min[2];
  const Q = new Float64Array(n * 3);
  for (let i = 0; i < n * 3; i++) Q[i] = (P[i] - ctr[i % 3]) / L;

  // Weld first: an export is split at every UV seam, and an unwelded blade is a
  // dozen disconnected ribbons that a fill cannot walk along.
  const map = new Map(); const weld = new Int32Array(n); let nw = 0;
  for (let i = 0; i < n; i++) {
    const k = `${Math.round(Q[i * 3] * 20000)},${Math.round(Q[i * 3 + 1] * 20000)},${Math.round(Q[i * 3 + 2] * 20000)}`;
    let w = map.get(k);
    if (w === undefined) { w = nw++; map.set(k, w); }
    weld[i] = w;
  }
  const adj = Array.from({ length: nw }, () => new Set());
  for (let t = 0; t < idx.length; t += 3) {
    const a = weld[idx[t]], b = weld[idx[t + 1]], c = weld[idx[t + 2]];
    adj[a].add(b); adj[a].add(c); adj[b].add(a); adj[b].add(c); adj[c].add(a); adj[c].add(b);
  }
  const rw = new Float64Array(nw), dzw = new Float64Array(nw), yw = new Float64Array(nw);
  for (let i = 0; i < n; i++) {
    const w = weld[i];
    rw[w] = Math.hypot(Q[i * 3] - hx, Q[i * 3 + 1] - hy);
    dzw[w] = Math.abs(Q[i * 3 + 2] - hz);
    yw[w] = Q[i * 3 + 1];
  }
  const inHub = (w) => rw[w] < rCut && dzw[w] < zMax && yw[w] > yFloor;
  const seen = new Uint8Array(nw); const queue = [];
  for (let w = 0; w < nw; w++) {
    if (rw[w] > seedR && rw[w] < rMax && dzw[w] < zMax * 0.8 && yw[w] > hy + 0.025) {
      seen[w] = 1; queue.push(w);
    }
  }
  const seeds = queue.length;
  for (let qi = 0; qi < queue.length; qi++) {
    for (const w of adj[queue[qi]]) {
      if (seen[w] || rw[w] < rCut || rw[w] > rMax || dzw[w] > zMax || yw[w] < yFloor) continue;
      seen[w] = 1; queue.push(w);
    }
  }
  for (let w = 0; w < nw; w++) if (inHub(w)) seen[w] = 1;
  const out = new Uint8Array(n);
  let hit = 0;
  for (let i = 0; i < n; i++) { out[i] = seen[weld[i]] ? 255 : 0; if (out[i]) hit++; }
  console.log(`  spin: ${seeds} seeds -> ${hit} of ${n} vertices rotate (hub ${hx},${hy},${hz})`);
  return out;
}

const b64 = (arr) => Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).toString('base64');
let spinLine = '';
if (SPIN) {
  const w = spinWeights(P, qidx, n, SPIN);
  const parts = SPIN.split(',').map(Number);
  spinLine = `  spin: '${b64(w)}',\n  spinHub: [${parts[0]}, ${parts[1]}, ${parts[2]}],\n`;
}

const body = `// ${NAME}: generated from ${IN.split('/').pop()} by tools/glb.mjs.
// Inlined because the artifact CSP blocks every external request. Positions are
// Int16 with the LENGTH axis spanning +-16000 (decode: * lengthM / 32000),
// normals Int8, UVs Uint16. Source forward axis was ${FORWARD}; rotated so the
// nose sits at -Z, the renderer's convention for "forward".
export const ${NAME} = {
  verts: ${n}, tris: ${qidx.length / 3},
  pos: '${b64(qpos)}',
  nrm: '${b64(qnrm)}',
  uv: '${b64(quv)}',
  idx: '${b64(qidx)}',
${spinLine}  baseColorJpeg: '${jpegB64}',
};
`;
await writeFile(OUT, body);
console.log(`${OUT}: ${n} verts, ${qidx.length / 3} tris, jpeg ${Math.round(jpegB64.length * 0.75 / 1024)} kB, module ${Math.round(body.length / 1024)} kB`);
