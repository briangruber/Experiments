#!/usr/bin/env node
// Repair a skinned GLB whose inverse bind matrices do not match its skeleton.
//
//   node tools/fix-bind.mjs in.glb out.glb
//   node tools/fix-bind.mjs in.glb --check
//
// A skin stores, per joint, the inverse of that joint's world transform at the
// moment the mesh was bound to it. Get those wrong and every vertex is
// transformed by the difference: the model does not simply pose badly, it
// detonates into shards, while the same geometry rendered without skinning is
// perfect. That is the signature to look for, and it is what a hen in a
// magenta dress arrived with.
//
// The repair is exact whenever the skeleton is still in its bind pose, which
// it is in every export of this kind: recompute each matrix as the inverse of
// the joint's world transform, read straight off the node hierarchy. If the
// rig had been saved mid-animation this would bake that pose in instead — so
// --check reports the error first and refuses to guess.

import { readFile, writeFile } from 'node:fs/promises';

const [, , inPath, outArg, mode] = process.argv;
if (!inPath) { console.error('usage: node tools/fix-bind.mjs in.glb [out.glb|--check] [--rebuild-skeleton]'); process.exit(1); }
const CHECK = outArg === '--check';
// Two different breakages need opposite repairs, and picking the wrong one
// looks like it worked.
//
//   default            the skeleton is right and the bind matrices are wrong:
//                      recompute each as the inverse of the joint's world
//                      transform.
//   --rebuild-skeleton the bind matrices are right and the skeleton is not
//                      there at all — every joint's node transform is
//                      identity, so the bones are piled at the origin. The
//                      bind pose is still recoverable, because an inverse bind
//                      matrix IS the inverse of where that joint stood: invert
//                      it back and lay the hierarchy out from the result.
//
// The tell for the second case is a model that renders perfectly in bind pose
// (identity bones times identity matrices is a no-op) and collapses the moment
// anything rotates a bone.
const REBUILD = mode === '--rebuild-skeleton' || outArg === '--rebuild-skeleton';

const MAGIC = 0x46546c67, JSON_CHUNK = 0x4e4f534a, BIN_CHUNK = 0x004e4942;

function readGlb(buf) {
  if (buf.readUInt32LE(0) !== MAGIC) throw new Error('not a GLB');
  let off = 12, json = null, bin = null;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off), type = buf.readUInt32LE(off + 4);
    const body = buf.subarray(off + 8, off + 8 + len);
    if (type === JSON_CHUNK) json = JSON.parse(body.toString('utf8'));
    else if (type === BIN_CHUNK) bin = Buffer.from(body);
    off += 8 + len + ((4 - (len % 4)) % 4);
  }
  return { json, bin };
}

function writeGlb(json, bin) {
  const pad = (b, f) => { const n = (4 - (b.length % 4)) % 4; return n ? Buffer.concat([b, Buffer.alloc(n, f)]) : b; };
  const jc = pad(Buffer.from(JSON.stringify(json), 'utf8'), 0x20), bc = pad(bin, 0);
  const head = Buffer.alloc(12);
  head.writeUInt32LE(MAGIC, 0); head.writeUInt32LE(2, 4);
  head.writeUInt32LE(12 + 8 + jc.length + 8 + bc.length, 8);
  const jh = Buffer.alloc(8); jh.writeUInt32LE(jc.length, 0); jh.writeUInt32LE(JSON_CHUNK, 4);
  const bh = Buffer.alloc(8); bh.writeUInt32LE(bc.length, 0); bh.writeUInt32LE(BIN_CHUNK, 4);
  return Buffer.concat([head, jh, jc, bh, bc]);
}

// Column-major 4x4, the order glTF stores them in.
const mul = (a, b) => {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  }
  return o;
};

function invert(m) {
  const inv = new Array(16);
  inv[0] = m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15] + m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10];
  inv[4] = -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15] - m[8] * m[7] * m[14] - m[12] * m[6] * m[11] + m[12] * m[7] * m[10];
  inv[8] = m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15] + m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9];
  inv[12] = -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14] - m[8] * m[6] * m[13] - m[12] * m[5] * m[10] + m[12] * m[6] * m[9];
  inv[1] = -m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15] - m[9] * m[3] * m[14] - m[13] * m[2] * m[11] + m[13] * m[3] * m[10];
  inv[5] = m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15] + m[8] * m[3] * m[14] + m[12] * m[2] * m[11] - m[12] * m[3] * m[10];
  inv[9] = -m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15] - m[8] * m[3] * m[13] - m[12] * m[1] * m[11] + m[12] * m[3] * m[9];
  inv[13] = m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14] + m[8] * m[2] * m[13] + m[12] * m[1] * m[10] - m[12] * m[2] * m[9];
  inv[2] = m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15] + m[5] * m[3] * m[14] + m[13] * m[2] * m[7] - m[13] * m[3] * m[6];
  inv[6] = -m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15] - m[4] * m[3] * m[14] - m[12] * m[2] * m[7] + m[12] * m[3] * m[6];
  inv[10] = m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15] + m[4] * m[3] * m[13] + m[12] * m[1] * m[7] - m[12] * m[3] * m[5];
  inv[14] = -m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14] - m[4] * m[2] * m[13] - m[12] * m[1] * m[6] + m[12] * m[2] * m[5];
  inv[3] = -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11] - m[5] * m[3] * m[10] - m[9] * m[2] * m[7] + m[9] * m[3] * m[6];
  inv[7] = m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11] + m[4] * m[3] * m[10] + m[8] * m[2] * m[7] - m[8] * m[3] * m[6];
  inv[11] = -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11] - m[4] * m[3] * m[9] - m[8] * m[1] * m[7] + m[8] * m[3] * m[5];
  inv[15] = m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10] + m[4] * m[2] * m[9] + m[8] * m[1] * m[6] - m[8] * m[2] * m[5];
  const det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12];
  if (!det) throw new Error('singular joint transform');
  return inv.map((v) => v / det);
}

function localOf(n) {
  if (n.matrix) return n.matrix.slice();
  const t = n.translation || [0, 0, 0], q = n.rotation || [0, 0, 0, 1], s = n.scale || [1, 1, 1];
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
    (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
    (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
}

const buf = await readFile(inPath);
const { json, bin } = readGlb(buf);
if (!json.skins?.length) { console.error('no skin in this file'); process.exit(1); }

const nodes = json.nodes;
const parent = new Array(nodes.length).fill(-1);
nodes.forEach((n, i) => (n.children || []).forEach((c) => { parent[c] = i; }));
const world = new Array(nodes.length);
const W = (i) => {
  if (world[i]) return world[i];
  const m = localOf(nodes[i]);
  world[i] = parent[i] < 0 ? m : mul(W(parent[i]), m);
  return world[i];
};

if (REBUILD) {
  let laid = 0;
  for (const skin of json.skins) {
    if (skin.inverseBindMatrices === undefined) continue;
    const acc = json.accessors[skin.inverseBindMatrices];
    const bv = json.bufferViews[acc.bufferView];
    const base = (bv.byteOffset || 0) + (acc.byteOffset || 0);
    const want = new Map();          // node index -> its world matrix at bind
    skin.joints.forEach((node, k) => {
      const ibm = [];
      for (let e = 0; e < 16; e++) ibm.push(bin.readFloatLE(base + k * 64 + e * 4));
      want.set(node, invert(ibm));
    });
    // Top-down, so a parent's world is settled before its children ask for it.
    const worldOf = new Array(nodes.length);
    const roots = nodes.map((_, i) => i).filter((i) => parent[i] < 0);
    const walk = (i, parentWorld) => {
      const target = want.get(i);
      let world = parentWorld;
      if (target) {
        const local = mul(invert(parentWorld), target);
        const n = nodes[i];
        delete n.translation; delete n.rotation; delete n.scale;
        n.matrix = local;
        world = target;
        laid++;
      }
      worldOf[i] = world;
      for (const c of nodes[i].children || []) walk(c, world);
    };
    const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    for (const r of roots) walk(r, I);
  }
  await writeFile(outArg, writeGlb(json, bin));
  console.log(`laid out ${laid} joints from their bind matrices -> ${outArg}`);
  process.exit(0);
}

let fixed = 0, worst = 0;
for (const skin of json.skins) {
  if (skin.inverseBindMatrices === undefined) continue;
  const acc = json.accessors[skin.inverseBindMatrices];
  const bv = json.bufferViews[acc.bufferView];
  const base = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  for (let k = 0; k < skin.joints.length; k++) {
    const w = W(skin.joints[k]);
    const stored = [];
    for (let e = 0; e < 16; e++) stored.push(bin.readFloatLE(base + k * 64 + e * 4));
    const p = mul(w, stored);
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) worst = Math.max(worst, Math.abs(p[c * 4 + r] - (r === c ? 1 : 0)));
    }
    if (!CHECK) {
      const good = invert(w);
      for (let e = 0; e < 16; e++) bin.writeFloatLE(good[e], base + k * 64 + e * 4);
      fixed++;
    }
  }
}

console.log(`worst |world * IBM - I| before: ${worst.toFixed(4)}`);
if (CHECK) {
  console.log(worst < 0.01 ? 'bind matrices are consistent' : 'bind matrices are WRONG');
  process.exit(worst < 0.01 ? 0 : 1);
}
await writeFile(outArg, writeGlb(json, bin));
console.log(`rebuilt ${fixed} bind matrices -> ${outArg}`);
