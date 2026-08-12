#!/usr/bin/env node
// Reduce a retargeted GLB to nothing but its animation.
//
//   node tools/strip-anim.mjs assets/keeper-walk.glb   # report the saving
//
// Tripo returns each retarget as a complete model: the same skinned mesh and
// the same three JPEG textures as every other clip of that character, plus a
// few dozen KB of keyframes. The game only ever takes `animations[0]` from
// these files — the mesh comes from the idle one — so for the single-file
// build the rest is dead weight, and it is most of the weight.
//
// Nodes are kept in place and keep their names, because animation channels
// address nodes by index and three binds tracks by node name.

import { readFile } from 'node:fs/promises';

const MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;

export function stripToAnimation(buf) {
  if (buf.readUInt32LE(0) !== MAGIC) return buf;
  const jsonLen = buf.readUInt32LE(12);
  if (buf.readUInt32LE(16) !== JSON_CHUNK) return buf;
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
  if (!json.animations?.length) return buf;

  const binHeader = 20 + jsonLen;
  if (binHeader + 8 > buf.length || buf.readUInt32LE(binHeader + 4) !== BIN_CHUNK) return buf;
  const bin = buf.subarray(binHeader + 8, binHeader + 8 + buf.readUInt32LE(binHeader));

  // Only the accessors the animation samplers read.
  const wanted = new Set();
  for (const anim of json.animations) {
    for (const s of anim.samplers) { wanted.add(s.input); wanted.add(s.output); }
  }

  const viewMap = new Map();      // old bufferView -> new index
  const accessorMap = new Map();  // old accessor  -> new index
  const bufferViews = [];
  const accessors = [];
  const parts = [];
  let offset = 0;

  for (const oldIndex of [...wanted].sort((a, b) => a - b)) {
    const acc = { ...json.accessors[oldIndex] };
    if (acc.bufferView !== undefined) {
      if (!viewMap.has(acc.bufferView)) {
        const bv = json.bufferViews[acc.bufferView];
        const start = bv.byteOffset ?? 0;
        const pad = (4 - (offset % 4)) % 4;
        if (pad) { parts.push(Buffer.alloc(pad)); offset += pad; }
        parts.push(Buffer.from(bin.subarray(start, start + bv.byteLength)));
        const copy = { buffer: 0, byteOffset: offset, byteLength: bv.byteLength };
        if (bv.byteStride !== undefined) copy.byteStride = bv.byteStride;
        offset += bv.byteLength;
        viewMap.set(acc.bufferView, bufferViews.push(copy) - 1);
      }
      acc.bufferView = viewMap.get(acc.bufferView);
    }
    accessorMap.set(oldIndex, accessors.push(acc) - 1);
  }

  const out = {
    asset: json.asset ?? { version: '2.0' },
    scene: json.scene ?? 0,
    scenes: json.scenes,
    // Same nodes, same names, same indices — just no geometry hanging off them.
    nodes: (json.nodes ?? []).map((n) => {
      const c = { ...n };
      delete c.mesh;
      delete c.skin;
      return c;
    }),
    animations: json.animations.map((a) => ({
      ...a,
      samplers: a.samplers.map((s) => ({
        ...s, input: accessorMap.get(s.input), output: accessorMap.get(s.output),
      })),
    })),
    accessors,
    bufferViews,
    buffers: [{ byteLength: offset }],
  };

  const binOut = Buffer.concat(parts);
  const jsonOut = Buffer.from(JSON.stringify(out), 'utf8');
  const jsonPad = (4 - (jsonOut.length % 4)) % 4;
  const binPad = (4 - (binOut.length % 4)) % 4;
  const jsonPadded = Buffer.concat([jsonOut, Buffer.alloc(jsonPad, 0x20)]);
  const binPadded = Buffer.concat([binOut, Buffer.alloc(binPad)]);

  const total = 12 + 8 + jsonPadded.length + 8 + binPadded.length;
  const glb = Buffer.alloc(total);
  glb.writeUInt32LE(MAGIC, 0);
  glb.writeUInt32LE(2, 4);
  glb.writeUInt32LE(total, 8);
  glb.writeUInt32LE(jsonPadded.length, 12);
  glb.writeUInt32LE(JSON_CHUNK, 16);
  jsonPadded.copy(glb, 20);
  const binAt = 20 + jsonPadded.length;
  glb.writeUInt32LE(binPadded.length, binAt);
  glb.writeUInt32LE(BIN_CHUNK, binAt + 4);
  binPadded.copy(glb, binAt + 8);
  return glb;
}

// Files whose mesh the game never uses: the character mesh always comes from
// the `-idle` retarget, and these carry a byte-identical copy of it.
export const isClipOnly = (name) => /-(walk|run|jump|climb|slash)\.glb$/.test(name);

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  for (const path of process.argv.slice(2)) {
    const before = await readFile(path);
    const after = stripToAnimation(before);
    console.log(`${path}: ${(before.length / 1e6).toFixed(2)} MB -> ${(after.length / 1e6).toFixed(2)} MB`);
  }
}
