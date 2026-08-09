// The floor of the bay.
//
// This is what the refraction pass actually shows, so it carries at least as
// much of ref/01 as the water shader does: warm pale sand, winding channels,
// grey-green reef patches, olive seagrass, and the ripple ridges that make
// shallow water read as shallow.
//
// Three things make it work:
//
//   * One *graded* grid, not a uniform one. The columns are 1.6 m apart out to
//     60 m and then grow geometrically to ~23 m at the 820 m rim, so the reef
//     under the boat is properly resolved and the open sea costs almost nothing.
//     A single mesh means one draw call and — more importantly — no cracks
//     between LOD rings.
//   * `seabedHeight` is the same function that built the mesh, evaluated on the
//     CPU. Coral, kelp, the dock's pilings and the boat all ask it, so it has to
//     be exact and allocation-free. It is: every scratch value lives at module
//     scope and the whole thing is arithmetic on `core/rng.js` noise.
//   * The albedo is baked into vertex colours from the same masks that shaped
//     the height, and a small tiling ripple normal/albedo pair adds the detail
//     the 1.6 m grid cannot carry. One MeshStandardMaterial, one draw call.
//
// Everything here is seen through several metres of water, which desaturates it
// and pulls it blue, so the raw albedo is deliberately a shade warmer and
// brighter than it should be on its own.

import * as THREE from 'three';
import { LAYER, setLayers } from '../core/layers.js';
import { fbm2D, noise2D, value2D, worley2D, hash2, smoothstep, clamp } from '../core/rng.js';
import { islandFloor } from './island.js';

const TAU = Math.PI * 2;

const HALF = 820;             // metres from the origin the mesh covers
const REEF_R = 200;           // radius of the reef flats

// --- the height field --------------------------------------------------------

const _w = { d: 0, id: 0 };
/** Everything one evaluation produces. Module scope: `seabedHeight` never allocates. */
const _s = { h: 0, depth: 0, channel: 0, reef: 0, heads: 0, grass: 0, island: 0 };

function smax(a, b, k) {
  const d = a - b;
  const h = Math.max(0, k - (d < 0 ? -d : d)) / k;
  return (a > b ? a : b) + h * h * k * 0.25;
}

/**
 * The bay floor at (x, z). Fills `out` with the height and with the masks the
 * colour pass needs, so the mesh build only pays for one evaluation per vertex.
 */
function evalSeabed(x, z, out) {
  const r = Math.sqrt(x * x + z * z);

  // --- the big profile ------------------------------------------------------
  // Reef flats out to ~200 m, then the shelf edge, then open sea. The north is
  // pushed deeper because that is where the boat goes looking for the leviathan.
  let d = 2.6 + 4.6 * smoothstep(10, REEF_R, r);
  d += 21 * smoothstep(190, 312, r);
  d += 26 * smoothstep(330, 780, r);
  d += 5 * smoothstep(-160, -430, z);

  // --- sand channels --------------------------------------------------------
  // Zero crossings of a warped low-frequency field: long winding lanes of clean
  // sand cut through the reef, which is what the art has and what makes the
  // shallows readable.
  const warp = noise2D(x * 0.0031 - 7.9, z * 0.0031 + 2.6);
  const meander = fbm2D(x * 0.0042 + 11.3 + warp * 1.1, z * 0.0042 - 4.2 - warp * 0.8, 2);
  const channel = 1 - smoothstep(0.0, 0.185, meander < 0 ? -meander : meander);
  const shallow = 1 - smoothstep(120, 300, r);
  d += 1.5 * channel * shallow;

  // --- reef ----------------------------------------------------------------
  const reefBand = (1 - smoothstep(150, 300, r)) * (1 - 0.85 * channel);
  worley2D(x * 0.0165 + 3.7, z * 0.0165 - 9.1, _w);
  const patch = 1 - smoothstep(0.16, 0.66, _w.d);
  const reef = patch * reefBand;
  d -= 1.9 * reef;

  worley2D(x * 0.075 + 21.4, z * 0.075 + 5.8, _w);
  const heads = (1 - smoothstep(0.10, 0.46, _w.d)) * reefBand;
  d -= 0.55 * heads;

  let h = -d;

  // --- surface detail -------------------------------------------------------
  // Ripple ridges. The bearing drifts slowly so they curve the way real sand
  // ripples do instead of marching in one direction across the whole bay.
  const ra = noise2D(x * 0.0055 - 2.1, z * 0.0055 + 7.7) * 1.6;
  const s = x * Math.cos(ra) + z * Math.sin(ra);
  const ripAmp = 0.24 * (1 - smoothstep(3.0, 16.0, d)) * (0.45 + 0.55 * channel);
  h += ripAmp * (Math.pow(0.5 + 0.5 * Math.sin(s * 0.70), 1.8) - 0.42);

  // Rubble and broad lumps.
  h += 0.28 * noise2D(x * 0.090 + 4.4, z * 0.090 - 1.2) * (1 - smoothstep(6, 24, d));
  h += 0.85 * fbm2D(x * 0.022 - 8.8, z * 0.022 + 3.3, 2) * (1 - smoothstep(12, 44, d));

  // --- the islands ----------------------------------------------------------
  // Their shallow sand apron, soft-maxed in so the shore shelves out instead of
  // dropping straight off the rock.
  const isl = islandFloor(x, z);
  out.island = isl;
  if (isl > h - 8) h = smax(h, isl, 3.0);

  // --- masks for the colour pass -------------------------------------------
  out.h = h;
  out.depth = h < 0 ? -h : 0;
  out.channel = channel;
  out.reef = reef;
  out.heads = heads;
  out.grass = smoothstep(0.44, 0.70, value2D(x * 0.019 + 5.1, z * 0.019 - 2.4))
    * (1 - smoothstep(4, 16, d)) * (1 - 0.9 * channel);
  return out;
}

/** Seabed height at a world point. Negative below water. Allocation-free. */
export function seabedHeightAt(x, z) {
  return evalSeabed(x, z, _s).h;
}

// --- palette -----------------------------------------------------------------

const _col = new THREE.Color();
function lin(hex) { _col.setHex(hex, THREE.SRGBColorSpace); return [_col.r, _col.g, _col.b]; }

const C_SAND = lin(0xDDC895);
const C_SAND_BRIGHT = lin(0xF2E3B6);
const C_REEF = lin(0x849070);
const C_REEF_WARM = lin(0xA08A63);
const C_GRASS = lin(0x5E7038);
const C_DEEP = lin(0x6E7A6E);

const _c3 = [0, 0, 0];
const _col2 = [0, 0, 0];
function setC(dst, src) { dst[0] = src[0]; dst[1] = src[1]; dst[2] = src[2]; }
function mixC(dst, src, t) {
  if (t <= 0) return;
  const u = t > 1 ? 1 : t;
  dst[0] += (src[0] - dst[0]) * u;
  dst[1] += (src[1] - dst[1]) * u;
  dst[2] += (src[2] - dst[2]) * u;
}

// --- tiling sand textures ----------------------------------------------------
// The grid cannot carry a 2 m ripple, so the fine detail lives in a small
// procedural normal/albedo pair that tiles every few metres.

const TILE_M = 6.5;           // metres one texture tile covers

function tileHash(ix, iy, period, salt) {
  const px = ((ix % period) + period) % period;
  const py = ((iy % period) + period) % period;
  return hash2(px + salt * 131, py + salt * 57);
}

function tileValue(x, y, period, salt) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const a = tileHash(xi, yi, period, salt);
  const b = tileHash(xi + 1, yi, period, salt);
  const c = tileHash(xi, yi + 1, period, salt);
  const e = tileHash(xi + 1, yi + 1, period, salt);
  const ab = a + (b - a) * u;
  const ce = c + (e - c) * u;
  return ab + (ce - ab) * v;
}

/** Height of the sand surface over one tile. Exactly periodic in u and v. */
function sandField(u, v) {
  const w1 = tileValue(u * 3, v * 3, 3, 2) - 0.5;
  const w2 = tileValue(u * 7, v * 7, 7, 5) - 0.5;
  const ridge = 0.5 + 0.5 * Math.sin((v * 5 + u * 2 + w1 * 0.55) * TAU);
  let h = Math.pow(ridge, 1.7) * 0.62;
  h += w2 * 0.30;
  h += (tileValue(u * 17, v * 17, 17, 11) - 0.5) * 0.16;
  h += (tileValue(u * 37, v * 37, 37, 23) - 0.5) * 0.09;
  return h;
}

function makeSandTextures() {
  const N = 128;
  const nrm = new Uint8Array(N * N * 4);
  const alb = new Uint8Array(N * N * 4);
  const e = 1 / N;
  const K = 0.055;             // world slope per unit of field gradient
  for (let j = 0; j < N; j++) {
    const v = j / N;
    for (let i = 0; i < N; i++) {
      const u = i / N;
      const hl = sandField(u - e, v), hr = sandField(u + e, v);
      const hd = sandField(u, v - e), hu = sandField(u, v + e);
      let nx = -(hr - hl) / (2 * e) * K;
      let ny = -(hu - hd) / (2 * e) * K;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      nx *= inv; ny *= inv;
      const nz = inv;
      const k = (j * N + i) * 4;
      nrm[k] = Math.round((nx * 0.5 + 0.5) * 255);
      nrm[k + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      nrm[k + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      nrm[k + 3] = 255;

      const hh = sandField(u, v);
      const spec = tileValue(u * 29, v * 29, 29, 41);
      const g = clamp(0.80 + 0.26 * hh + 0.10 * (spec - 0.5), 0.60, 1.0);
      alb[k] = Math.round(g * 255);
      alb[k + 1] = Math.round(g * 251);
      alb[k + 2] = Math.round(g * 239);
      alb[k + 3] = 255;
    }
  }

  const normalMap = new THREE.DataTexture(nrm, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  normalMap.wrapS = normalMap.wrapT = THREE.RepeatWrapping;
  normalMap.magFilter = THREE.LinearFilter;
  normalMap.minFilter = THREE.LinearMipmapLinearFilter;
  normalMap.generateMipmaps = true;
  normalMap.colorSpace = THREE.NoColorSpace;
  normalMap.anisotropy = 4;
  normalMap.needsUpdate = true;

  const map = new THREE.DataTexture(alb, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.magFilter = THREE.LinearFilter;
  map.minFilter = THREE.LinearMipmapLinearFilter;
  map.generateMipmaps = true;
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 4;
  map.needsUpdate = true;

  return { normalMap, map };
}

// --- the graded grid ---------------------------------------------------------

/**
 * One axis of the grid: constant `innerStep` out to `innerHalf`, then a
 * geometric ramp to `half`. Mirrored, so the middle sample is exactly 0.
 */
function gradedAxis(innerHalf, innerStep, half, growth) {
  const pts = [0];
  let p = 0, step = innerStep;
  while (p < half && pts.length < 360) {
    p += step;
    if (p >= half) { pts.push(half); break; }
    pts.push(p);
    if (p > innerHalf) step *= growth;
  }
  if (pts[pts.length - 1] !== half) pts.push(half);
  const n = pts.length;
  const out = new Float64Array(n * 2 - 1);
  for (let i = 0; i < n; i++) {
    out[n - 1 + i] = pts[i];
    out[n - 1 - i] = -pts[i];
  }
  return out;
}

// --- module ------------------------------------------------------------------

export function createSeabed(opts = {}) {
  // The fine band has to cover the whole reef, not just the water around the
  // boat. At 62 m the grid was already 5–12 m a cell across the middle distance,
  // and since the sand and reef colours live in the vertex stream that came back
  // through the clear water as a patchwork quilt with a hard edge where the
  // ramp began. The reef runs to about 200 m, so the fine band does too.
  //
  // Density comes off quality.geometry rather than the tier name: this is by
  // some way the heaviest single mesh in the scene, and a tier that matched no
  // branch of a name ladder used to land on the finest grid of the three.
  // Reach stays near the reef edge at every budget — it is the cell size that
  // gives, so what coarsens is the detail, not the extent of the seabed.
  const g = opts.quality?.geometry ?? 1;
  const cell = THREE.MathUtils.lerp(4.0, 2.2, THREE.MathUtils.clamp((g - 0.42) / 0.58, 0, 1));
  const ramp = THREE.MathUtils.lerp(1.060, 1.046, THREE.MathUtils.clamp((g - 0.42) / 0.58, 0, 1));
  const reach = THREE.MathUtils.lerp(190, 330, THREE.MathUtils.clamp((g - 0.42) / 0.58, 0, 1));
  const axis = gradedAxis(reach, cell, HALF, ramp);

  const N = axis.length;
  const vcount = N * N;
  const pos = new Float32Array(vcount * 3);
  const uv = new Float32Array(vcount * 2);
  const col = new Float32Array(vcount * 3);

  // Masks, kept alongside the positions so the colour pass (which needs the
  // computed normals) does not have to evaluate the field a second time.
  const mChannel = new Float32Array(vcount);
  const mReef = new Float32Array(vcount);
  const mHeads = new Float32Array(vcount);
  const mGrass = new Float32Array(vcount);

  const invTile = 1 / TILE_M;
  let p = 0;
  for (let j = 0; j < N; j++) {
    const z = axis[j];
    for (let i = 0; i < N; i++) {
      const x = axis[i];
      evalSeabed(x, z, _s);
      const v = j * N + i;
      pos[p] = x; pos[p + 1] = _s.h; pos[p + 2] = z;
      uv[v * 2] = x * invTile;
      uv[v * 2 + 1] = z * invTile;
      mChannel[v] = _s.channel;
      mReef[v] = _s.reef;
      mHeads[v] = _s.heads;
      mGrass[v] = _s.grass;
      p += 3;
    }
  }

  const idx = new Uint32Array((N - 1) * (N - 1) * 6);
  let k = 0;
  for (let j = 0; j < N - 1; j++) {
    for (let i = 0; i < N - 1; i++) {
      const a = j * N + i, b = a + 1, c = a + N, d = c + 1;
      idx[k++] = a; idx[k++] = c; idx[k++] = b;
      idx[k++] = b; idx[k++] = c; idx[k++] = d;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeVertexNormals();

  // --- vertex colour --------------------------------------------------------
  const nrm = geo.attributes.normal.array;
  for (let v = 0; v < vcount; v++) {
    const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
    const depth = y < 0 ? -y : 0;
    const flat = clamp((nrm[v * 3 + 1] - 0.55) / 0.45, 0, 1);
    const mottle = value2D(x * 0.21 + 9.4, z * 0.21 - 3.6);
    const broad = value2D(x * 0.013 - 4.7, z * 0.013 + 8.2);

    setC(_c3, C_SAND);
    mixC(_c3, C_SAND_BRIGHT, mChannel[v] * 0.72 + 0.25 * (1 - smoothstep(1.5, 6.0, depth)));

    // Reef rock — greyer, greener, and warmer where the coral heads clump.
    setC(_col2, C_REEF);
    mixC(_col2, C_REEF_WARM, 0.30 + 0.45 * broad);
    mixC(_c3, _col2, clamp(mReef[v] * 1.15 + mHeads[v] * 0.55, 0, 0.92));

    // Seagrass beds.
    mixC(_c3, C_GRASS, mGrass[v] * (0.55 + 0.45 * broad) * 0.85);

    // Slopes hold rubble, not sand.
    mixC(_c3, C_REEF, (1 - flat) * 0.45);

    // Everything below the shelf edge goes cold and dull; the water is doing
    // most of that anyway, but the albedo should not fight it.
    mixC(_c3, C_DEEP, smoothstep(9, 26, depth) * 0.8);

    const shade = (0.90 + 0.20 * mottle) * (0.94 + 0.10 * broad);
    col[v * 3] = _c3[0] * shade;
    col[v * 3 + 1] = _c3[1] * shade;
    col[v * 3 + 2] = _c3[2] * shade;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.computeBoundingSphere();

  const { normalMap, map } = makeSandTextures();

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    map,
    normalMap,
    normalScale: new THREE.Vector2(0.85, 0.85),
    roughness: 0.95,
    metalness: 0.0,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'seabed';
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  // The mesh spans the whole bay; culling it on a bounding sphere is pointless
  // and the sphere is bigger than the frustum anyway.
  mesh.frustumCulled = false;

  const group = new THREE.Group();
  group.name = 'seabed';
  group.add(mesh);
  setLayers(group, LAYER.MAIN, LAYER.UNDERWATER);

  const _lift = new THREE.Color();

  return {
    group,

    update() {},

    applyEnv(env) {
      if (!env) return;
      // The reef still reads under a full moon in ref/03, which no amount of
      // 0.4-intensity hemisphere light will do on its own. A trace of
      // in-scattered water colour keeps the sand alive at night without
      // touching it at midday.
      // Normalised, because the raw scatter colour is nearly black at night and
      // multiplying it by a small number would do nothing at all.
      _lift.copy(env.waterScatter);
      const peak = Math.max(_lift.r, _lift.g, _lift.b);
      if (peak > 1e-4) _lift.multiplyScalar(1 / peak);
      mat.emissive.copy(_lift).multiplyScalar(0.006 + 0.024 * env.nightFactor);
      // Caustics brighten the shallows; borrow the strength as a gentle
      // overall lift so the sand tracks the time of day.
      const g = 0.90 + 0.16 * env.causticStrength;
      mat.color.setRGB(g, g * 0.995, g * 0.985);
    },

    dispose() {
      geo.dispose();
      mat.dispose();
      map.dispose();
      normalMap.dispose();
    },

    seabedHeight: seabedHeightAt,
  };
}
