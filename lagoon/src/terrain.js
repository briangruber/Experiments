// The cove's floor, and the single source of truth for "how deep is the water
// here".
//
// Everything that needs the answer - the water shader's absorption and foam, the
// boat's buoyancy, where a coral head or a piling is planted - reads it from
// here, so nothing can drift out of agreement with anything else. The height
// field is plain JS: the floor mesh is built from it on the CPU (it is static,
// so there is no reason to displace it on the GPU), and the water shader reads
// it back as a single-channel float texture.

import { DataTexture, RedFormat, FloatType, LinearFilter, ClampToEdgeWrapping, BufferGeometry, BufferAttribute } from 'three';

export const FIELD_EXTENT = 340;      // metres covered by the depth texture, centred on the origin
export const FIELD_RES = 1024;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

// ------------------------------------------------------------------ value noise
function hash2(x, y) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function valueNoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

function fbm(x, y, octaves = 4) {
  let sum = 0, amp = 0.5, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise(x, y);
    norm += amp;
    amp *= 0.5;
    x = x * 2.03 + 17.1; y = y * 2.03 - 9.7;
  }
  return sum / norm;
}

// ------------------------------------------------------------------- reef heads
// Fixed, seeded layout: the same cove every run, so props can be planted against
// it once and stay planted.
function mulberry(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// [x, z, radius, rise] - reef heads lift the floor, islets break the surface.
export const MOUNDS = (() => {
  const rnd = mulberry(90210);
  const list = [];
  // Reef heads scattered across the shallow shelf, biased to the near/left half
  // where the water is clear enough to read them.
  for (let i = 0; i < 22; i++) {
    const a = rnd() * Math.PI * 2;
    const r = 6 + rnd() * 46;
    const x = -6 + Math.cos(a) * r * 1.05;
    const z = 4 + Math.sin(a) * r * 0.85;
    list.push([x, z, 2.2 + rnd() * 5.5, 0.35 + rnd() * 1.5]);
  }
  // Distant islets: the rocky shoulders on the far side of the channel.
  list.push([46, -58, 22, 12], [86, -30, 26, 14], [12, -96, 30, 11]);
  return list;
})();

// --------------------------------------------------------------- height field
// Returns metres relative to still water: negative is submerged, positive is dry.
export function terrainHeight(x, z, floorDepth = 4.2) {
  // A diagonal shelf: shallow towards the shore at -x, dropping away towards
  // +x / -z, which is where the deep blue sits in frame. Past the lip of the
  // shelf it keeps falling away, so a single frame can hold sand you can count
  // the ripples on and water too deep to see the bottom of.
  const s = (x * 0.82 - z * 0.34 + 26) / 34;
  // The power curve holds the shelf shallow for most of its width and then lets
  // it go: a linear ramp puts the interesting 0.5-2 m band in a narrow stripe
  // you have to go looking for, and this spreads it across the near half of the
  // cove where the camera actually is.
  let y = -floorDepth * Math.pow(smoothstep(0, 1, clamp(s, 0, 1)), 1.55);
  if (s > 1) y -= (s - 1) * floorDepth * 1.15;

  // Dry land inshore of the waterline, with a gentle beach slope.
  y += Math.max(0, -s) * 8.0;

  // Long, low dunes and a slow swell in the floor itself.
  y += (fbm(x * 0.035 + 11.3, z * 0.035 - 4.7, 4) - 0.5) * 1.5 * Math.min(1, Math.abs(y) * 0.5 + 0.15);
  y += Math.sin(x * 0.055 - z * 0.041) * 0.22;

  // A dredged channel running out to sea keeps the deep side reading as a route
  // rather than a wall.
  const ch = Math.exp(-Math.pow((x * 0.42 + z * 0.62 - 6) / 16, 2));
  y -= ch * floorDepth * 0.22;

  for (let i = 0; i < MOUNDS.length; i++) {
    const [mx, mz, mr, mh] = MOUNDS[i];
    const d = Math.hypot(x - mx, z - mz) / mr;
    if (d < 1) {
      const f = 1 - d * d;
      y += mh * f * f;
    }
  }

  // Everything past the cove settles to open water, so the field's edge - where
  // the depth texture clamps - agrees with what is drawn beyond it.
  const r = Math.hypot(x, z);
  y = y * (1 - smoothstep(120, 230, r)) + -floorDepth * 2.4 * smoothstep(120, 230, r);
  return y;
}

export function depthAt(x, z, floorDepth) {
  return -terrainHeight(x, z, floorDepth);
}

// Surface normal of the floor, by central difference. Used to sit props flat.
export function terrainNormal(x, z, floorDepth, e = 0.5) {
  const hx = terrainHeight(x + e, z, floorDepth) - terrainHeight(x - e, z, floorDepth);
  const hz = terrainHeight(x, z + e, floorDepth) - terrainHeight(x, z - e, floorDepth);
  const n = [-hx, 2 * e, -hz];
  const l = Math.hypot(n[0], n[1], n[2]);
  return [n[0] / l, n[1] / l, n[2] / l];
}

// ------------------------------------------------------------- depth texture
export function buildDepthTexture(floorDepth, res = FIELD_RES) {
  const data = new Float32Array(res * res);
  const step = FIELD_EXTENT / (res - 1);
  const o = -FIELD_EXTENT / 2;
  for (let j = 0; j < res; j++) {
    const z = o + j * step;
    for (let i = 0; i < res; i++) {
      data[j * res + i] = terrainHeight(o + i * step, z, floorDepth);
    }
  }
  const tex = new DataTexture(data, res, res, RedFormat, FloatType);
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearFilter;
  tex.wrapS = tex.wrapT = ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

export function updateDepthTexture(tex, floorDepth) {
  const res = tex.image.width;
  const data = tex.image.data;
  const step = FIELD_EXTENT / (res - 1);
  const o = -FIELD_EXTENT / 2;
  for (let j = 0; j < res; j++) {
    const z = o + j * step;
    for (let i = 0; i < res; i++) data[j * res + i] = terrainHeight(o + i * step, z, floorDepth);
  }
  tex.needsUpdate = true;
}

// ------------------------------------------------------------- floor geometry
// A plain XZ grid baked to the height field. Vertex colours carry the sand /
// reef / rock split so the floor shader stays cheap and the look stays art
// directable from one place.
export function buildFloorGeometry(floorDepth, size = 260, segments = 512) {
  const n = segments + 1;
  const pos = new Float32Array(n * n * 3);
  const nrm = new Float32Array(n * n * 3);
  const uvs = new Float32Array(n * n * 2);
  const col = new Float32Array(n * n * 3);
  const step = size / segments;
  const o = -size / 2;

  for (let j = 0; j < n; j++) {
    const z = o + j * step;
    for (let i = 0; i < n; i++) {
      const x = o + i * step;
      const y = terrainHeight(x, z, floorDepth);
      const k = (j * n + i) * 3;
      pos[k] = x; pos[k + 1] = y; pos[k + 2] = z;
      const nn = terrainNormal(x, z, floorDepth, step);
      nrm[k] = nn[0]; nrm[k + 1] = nn[1]; nrm[k + 2] = nn[2];
      uvs[(j * n + i) * 2] = (x - o) / size;
      uvs[(j * n + i) * 2 + 1] = (z - o) / size;

      // Reef cover: high where the floor bulges up into the light and the slope
      // is gentle, absent on the dry beach and in the deep channel.
      let reef = smoothstep(-5.5, -1.2, y) * smoothstep(0.25, -0.15, y) * smoothstep(0.62, 0.93, nn[1]);
      reef *= smoothstep(0.35, 0.62, fbm(x * 0.09 - 3.1, z * 0.09 + 7.7, 3));
      const rock = smoothstep(2.6, 7.0, y);              // islets and headland
      col[k] = reef; col[k + 1] = rock; col[k + 2] = fbm(x * 0.31, z * 0.31, 2);
    }
  }

  const idx = new Uint32Array(segments * segments * 6);
  let t = 0;
  for (let j = 0; j < segments; j++) {
    for (let i = 0; i < segments; i++) {
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      idx[t++] = a; idx[t++] = c; idx[t++] = b;
      idx[t++] = b; idx[t++] = c; idx[t++] = d;
    }
  }

  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('normal', new BufferAttribute(nrm, 3));
  g.setAttribute('uv', new BufferAttribute(uvs, 2));
  g.setAttribute('color', new BufferAttribute(col, 3));
  g.setIndex(new BufferAttribute(idx, 1));
  return g;
}

// ---------------------------------------------------------------- water grid
// A square grid warped outwards by a power curve: centimetres of spacing under
// the camera, hundreds of metres of reach at the horizon, one draw call.
export function buildWaterGeometry(segments = 448, reach = 420, curve = 1.85) {
  const n = segments + 1;
  const pos = new Float32Array(n * n * 3);
  const uvs = new Float32Array(n * n * 2);
  const warp = (u) => Math.sign(u) * Math.pow(Math.abs(u), curve) * reach;

  for (let j = 0; j < n; j++) {
    const v = (j / segments) * 2 - 1;
    for (let i = 0; i < n; i++) {
      const u = (i / segments) * 2 - 1;
      const k = (j * n + i) * 3;
      pos[k] = warp(u); pos[k + 1] = 0; pos[k + 2] = warp(v);
      uvs[(j * n + i) * 2] = i / segments;
      uvs[(j * n + i) * 2 + 1] = j / segments;
    }
  }

  const idx = new Uint32Array(segments * segments * 6);
  let t = 0;
  for (let j = 0; j < segments; j++) {
    for (let i = 0; i < segments; i++) {
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      idx[t++] = a; idx[t++] = c; idx[t++] = b;
      idx[t++] = b; idx[t++] = c; idx[t++] = d;
    }
  }

  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('uv', new BufferAttribute(uvs, 2));
  g.setIndex(new BufferAttribute(idx, 1));
  g.boundingSphere = null;
  return g;
}
