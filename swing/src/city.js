// Procedural skyline.
//
// The city is a lot grid: each lot holds a stack of boxes (setbacks, a cornice,
// sometimes a spire). Geometry is merged per chunk so the renderer sees a few
// dozen draw calls instead of a thousand, and every box is also filed into a
// flat AABB list with a uniform grid over it — that list is what the swing
// raycast and the player's collision query actually run against, so physics
// never touches the render meshes.

import * as THREE from 'three';
import { makeRng, clamp, smoothstep } from './util.js';
import { facadeTextures, roofTexture, groundTextures, FACADE_TILE, ROOF_TILE } from './textures.js';

export const LOT = 46;                 // building footprint budget, metres
export const ROAD = 22;                // street width between lots
export const PITCH = LOT + ROAD;       // 68 m block period
export const N = 32;                   // lots per side
export const EXTENT = N * PITCH;       // 1768 m across
export const HALF = EXTENT / 2;
const ROAD_FRAC = ROAD / PITCH;

const CHUNK = 4;                       // lots per merged chunk
const GROUND_AO = 70;                  // metres over which facades brighten

const TINTS = [
  [0.52, 0.55, 0.64], [0.44, 0.47, 0.58], [0.62, 0.58, 0.56],
  [0.38, 0.44, 0.56], [0.58, 0.52, 0.50], [0.34, 0.40, 0.50],
  [0.50, 0.56, 0.62], [0.66, 0.62, 0.58],
];

/** Downtown is tall and dense; the edges taper off into low-rise. */
function heightProfile(rng, cx, cz) {
  const d = Math.hypot(cx, cz) / HALF;                  // 0 centre → 1 corner
  const core = 1 - smoothstep(0.06, 0.62, d);           // downtown falloff
  const ridge = 0.35 * (1 - smoothstep(0.1, 0.9, Math.abs(cz) / HALF));
  const base = 22 + 230 * core * core + 60 * ridge;
  const jitter = rng.range(0.55, 1.45);
  let h = base * jitter;
  if (rng.chance(0.035)) h *= rng.range(1.5, 2.2);      // the occasional landmark
  return clamp(h, 16, 340);
}

class Boxes {
  constructor() { this.data = []; this.count = 0; }
  push(x0, x1, y0, y1, z0, z1) {
    this.data.push(x0, x1, y0, y1, z0, z1);
    return this.count++;
  }
  freeze() { this.arr = new Float32Array(this.data); this.data = null; return this; }
}

/** Uniform 2D grid over the box list — one bucket per lot cell. */
class BoxGrid {
  constructor(boxes, cell) {
    this.cell = cell;
    this.dim = Math.ceil(EXTENT / cell) + 2;
    this.origin = -HALF - cell;
    this.buckets = Array.from({ length: this.dim * this.dim }, () => []);
    this.boxes = boxes.arr;
    this.stamp = new Int32Array(boxes.count);
    this.tick = 0;
    for (let i = 0; i < boxes.count; i++) {
      const b = i * 6;
      const gx0 = this.cellOf(this.boxes[b]), gx1 = this.cellOf(this.boxes[b + 1]);
      const gz0 = this.cellOf(this.boxes[b + 4]), gz1 = this.cellOf(this.boxes[b + 5]);
      for (let gz = gz0; gz <= gz1; gz++) {
        for (let gx = gx0; gx <= gx1; gx++) this.buckets[gz * this.dim + gx].push(i);
      }
    }
  }
  cellOf(v) { return clamp(Math.floor((v - this.origin) / this.cell), 0, this.dim - 1); }
  bucket(gx, gz) { return this.buckets[gz * this.dim + gx]; }
}

/**
 * Slab test. Returns the near hit distance, or -1. `nrm` receives the face
 * normal of the entry face.
 */
function rayBox(a, b, ox, oy, oz, ix, iy, iz, maxT, nrm) {
  let tmin = 0, tmax = maxT, axis = -1, sign = 1;
  // X
  let t1 = (a[b] - ox) * ix, t2 = (a[b + 1] - ox) * ix;
  let lo = Math.min(t1, t2), hi = Math.max(t1, t2);
  if (lo > tmin) { tmin = lo; axis = 0; sign = t1 > t2 ? 1 : -1; }
  tmax = Math.min(tmax, hi);
  if (tmin > tmax) return -1;
  // Y
  t1 = (a[b + 2] - oy) * iy; t2 = (a[b + 3] - oy) * iy;
  lo = Math.min(t1, t2); hi = Math.max(t1, t2);
  if (lo > tmin) { tmin = lo; axis = 1; sign = t1 > t2 ? 1 : -1; }
  tmax = Math.min(tmax, hi);
  if (tmin > tmax) return -1;
  // Z
  t1 = (a[b + 4] - oz) * iz; t2 = (a[b + 5] - oz) * iz;
  lo = Math.min(t1, t2); hi = Math.max(t1, t2);
  if (lo > tmin) { tmin = lo; axis = 2; sign = t1 > t2 ? 1 : -1; }
  tmax = Math.min(tmax, hi);
  if (tmin > tmax || tmin < 0) return -1;

  nrm.set(0, 0, 0);
  if (axis === 0) nrm.x = sign; else if (axis === 1) nrm.y = sign; else if (axis === 2) nrm.z = sign;
  return tmin;
}

export function buildCity(seed = 1337) {
  const rng = makeRng(seed);
  const boxes = new Boxes();
  const roofSpots = [];                 // {x,y,z,size} for rooftop props
  const skyline = [];                   // {x,z,h} tall towers, for ring courses

  const chunkDim = Math.ceil(N / CHUNK);
  const chunks = Array.from({ length: chunkDim * chunkDim }, () => ({
    wp: [], wn: [], wu: [], wc: [],     // wall position/normal/uv/colour
    rp: [], rn: [], ru: [], rc: [],     // roof
  }));

  const pushWalls = (ck, x0, x1, y0, y1, z0, z1, tint) => {
    const w = x1 - x0, d = z1 - z0, h = y1 - y0;
    // Snap the tile count so window columns land flush with the corners.
    const tu = (len) => Math.max(1, Math.round(len / FACADE_TILE));
    const tv = Math.max(1, Math.round(h / FACADE_TILE));
    const shade = (y) => {
      const k = 0.3 + 0.7 * smoothstep(0, GROUND_AO, y);
      return [tint[0] * k, tint[1] * k, tint[2] * k];
    };
    const c0 = shade(y0), c1 = shade(y1);

    const face = (nx, ny, nz, quad, uMax) => {
      const uv = [[0, 0], [uMax, 0], [uMax, tv], [0, tv]];
      const order = [0, 1, 2, 0, 2, 3];
      for (const i of order) {
        const p = quad[i];
        ck.wp.push(p[0], p[1], p[2]);
        ck.wn.push(nx, ny, nz);
        ck.wu.push(uv[i][0], uv[i][1]);
        const c = p[1] > (y0 + y1) / 2 ? c1 : c0;
        ck.wc.push(c[0], c[1], c[2]);
      }
    };
    // Counter-clockwise seen from outside, uv origin at the bottom-left corner.
    face(0, 0, 1, [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], tu(w));
    face(0, 0, -1, [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], tu(w));
    face(1, 0, 0, [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], tu(d));
    face(-1, 0, 0, [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], tu(d));
  };

  const pushRoof = (ck, x0, x1, y, z0, z1, tint) => {
    const u = Math.max(1, (x1 - x0) / ROOF_TILE), v = Math.max(1, (z1 - z0) / ROOF_TILE);
    const quad = [[x0, y, z1], [x1, y, z1], [x1, y, z0], [x0, y, z0]];
    const uv = [[0, 0], [u, 0], [u, v], [0, v]];
    const k = 0.55 + 0.45 * smoothstep(0, GROUND_AO, y);
    for (const i of [0, 1, 2, 0, 2, 3]) {
      const p = quad[i];
      ck.rp.push(p[0], p[1], p[2]);
      ck.rn.push(0, 1, 0);
      ck.ru.push(uv[i][0], uv[i][1]);
      ck.rc.push(tint[0] * k * 0.8, tint[1] * k * 0.8, tint[2] * k * 0.8);
    }
  };

  const block = (ck, x0, x1, y0, y1, z0, z1, tint) => {
    boxes.push(x0, x1, y0, y1, z0, z1);
    pushWalls(ck, x0, x1, y0, y1, z0, z1, tint);
    pushRoof(ck, x0, x1, y1, z0, z1, tint);
  };

  for (let iz = 0; iz < N; iz++) {
    for (let ix = 0; ix < N; ix++) {
      const cx = (ix - (N - 1) / 2) * PITCH;
      const cz = (iz - (N - 1) / 2) * PITCH;
      // Thin the outskirts out so the city dissolves into the haze instead of
      // ending on a hard square edge.
      const rim = smoothstep(0.5, 1.05, Math.hypot(cx, cz) / HALF);
      if (rng.chance(0.05 + 0.72 * rim)) continue;        // plaza / park / empty lot

      const ck = chunks[Math.floor(iz / CHUNK) * chunkDim + Math.floor(ix / CHUNK)];
      const tint = rng.pick(TINTS);
      const total = heightProfile(rng, cx, cz);

      // Footprint, inset from the lot edge by a random setback.
      let hw = (LOT / 2) * rng.range(0.72, 1.0);
      let hd = (LOT / 2) * rng.range(0.72, 1.0);
      const jx = cx + rng.range(-3, 3), jz = cz + rng.range(-3, 3);

      // Stack 1–3 boxes, each stepping in — the classic setback silhouette.
      const tiers = total > 150 ? rng.int(2, 3) : total > 70 ? rng.int(1, 2) : 1;
      let y = 0;
      for (let t = 0; t < tiers; t++) {
        const share = t === tiers - 1 ? 1 : rng.range(0.45, 0.72);
        const top = y + (total - y) * share;
        block(ck, jx - hw, jx + hw, y, top, jz - hd, jz + hd, tint);
        y = top;
        hw *= rng.range(0.62, 0.85);
        hd *= rng.range(0.62, 0.85);
      }

      // Cornice: a slightly proud cap that catches the light along the roofline.
      if (rng.chance(0.6)) {
        const o = rng.range(0.6, 1.6);
        block(ck, jx - hw - o, jx + hw + o, y, y + rng.range(1.2, 2.6), jz - hd - o, jz + hd + o, tint);
        y += 2;
      }

      const size = Math.min(hw, hd) * 2;
      if (total > 110 && rng.chance(0.4)) {
        // Spire — a narrow shaft plus a mast, for downtown silhouettes.
        const sw = hw * rng.range(0.18, 0.34);
        const sh = total * rng.range(0.12, 0.3);
        block(ck, jx - sw, jx + sw, y, y + sh, jz - sw, jz + sw, tint);
        roofSpots.push({ x: jx, y: y + sh, z: jz, size: sw * 2, kind: 'mast' });
        y += sh;
      } else if (size > 14) {
        roofSpots.push({ x: jx, y, z: jz, size, kind: 'props' });
      }

      if (total > 140) skyline.push({ x: jx, z: jz, h: y });
    }
  }

  boxes.freeze();
  const grid = new BoxGrid(boxes, PITCH);

  // ---------------------------------------------------------------- meshes --

  const group = new THREE.Group();
  group.name = 'city';

  const facade = facadeTextures(seed + 3);
  const wallMat = new THREE.MeshStandardMaterial({
    map: facade.map,
    emissiveMap: facade.emissive,
    emissive: new THREE.Color(0xffffff),
    emissiveIntensity: 1.05,
    vertexColors: true,
    roughness: 0.68,
    metalness: 0.16,
  });
  const roofMat = new THREE.MeshStandardMaterial({
    map: roofTexture(seed + 5),
    vertexColors: true,
    roughness: 0.95,
    metalness: 0.03,
  });

  const attach = (arrPos, arrNor, arrUv, arrCol, mat) => {
    if (!arrPos.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(arrPos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(arrNor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(arrUv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(arrCol, 3));
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, mat);
    m.matrixAutoUpdate = false;
    group.add(m);
    return m;
  };

  for (const ck of chunks) {
    attach(ck.wp, ck.wn, ck.wu, ck.wc, wallMat);
    attach(ck.rp, ck.rn, ck.ru, ck.rc, roofMat);
  }

  // Streets. One quad, three city-widths across, so the grid runs past the fog.
  const ground = groundTextures(seed + 9, ROAD_FRAC);
  const span = EXTENT * 3;
  ground.map.repeat.set(N * 3, N * 3);
  ground.emissive.repeat.set(N * 3, N * 3);
  const groundMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(span, span),
    new THREE.MeshStandardMaterial({
      map: ground.map,
      emissiveMap: ground.emissive,
      emissive: new THREE.Color(0xffffff),
      emissiveIntensity: 0.9,
      roughness: 0.9,
      metalness: 0.05,
    }),
  );
  groundMesh.rotation.x = -Math.PI / 2;
  groundMesh.updateMatrix();
  groundMesh.matrixAutoUpdate = false;
  groundMesh.renderOrder = -1;
  group.add(groundMesh);

  // ------------------------------------------------------------- queries ---

  const arr = boxes.arr, count = boxes.count;
  const tmpN = new THREE.Vector3();

  const city = {
    group, boxes: arr, count, roofSpots, skyline,
    extent: EXTENT, half: HALF, pitch: PITCH,

    /**
     * Nearest box hit along a ray. Walks the lot grid and only tests the boxes
     * filed in the cells the ray actually crosses.
     */
    raycast(origin, dir, maxDist, out) {
      const { cell, dim, origin: go } = grid;
      const ox = origin.x, oy = origin.y, oz = origin.z;
      const ix = 1 / (dir.x || 1e-9), iy = 1 / (dir.y || 1e-9), iz = 1 / (dir.z || 1e-9);
      grid.tick++;

      let gx = grid.cellOf(ox), gz = grid.cellOf(oz);
      const stepX = dir.x > 0 ? 1 : -1, stepZ = dir.z > 0 ? 1 : -1;
      const bx = go + (gx + (dir.x > 0 ? 1 : 0)) * cell;
      const bz = go + (gz + (dir.z > 0 ? 1 : 0)) * cell;
      let tMaxX = Math.abs(dir.x) < 1e-9 ? Infinity : (bx - ox) * ix;
      let tMaxZ = Math.abs(dir.z) < 1e-9 ? Infinity : (bz - oz) * iz;
      const tDeltaX = Math.abs(dir.x) < 1e-9 ? Infinity : Math.abs(cell * ix);
      const tDeltaZ = Math.abs(dir.z) < 1e-9 ? Infinity : Math.abs(cell * iz);

      let bestT = Infinity, bestIdx = -1;
      for (let guard = 0; guard < 256; guard++) {
        for (const i of grid.bucket(gx, gz)) {
          if (grid.stamp[i] === grid.tick) continue;
          grid.stamp[i] = grid.tick;
          const t = rayBox(arr, i * 6, ox, oy, oz, ix, iy, iz, maxDist, tmpN);
          if (t >= 0 && t < bestT) {
            bestT = t; bestIdx = i;
            out.normal.copy(tmpN);
          }
        }
        const tExit = Math.min(tMaxX, tMaxZ);
        if (bestT <= tExit) break;
        if (tExit > maxDist) break;
        if (tMaxX < tMaxZ) { gx += stepX; tMaxX += tDeltaX; } else { gz += stepZ; tMaxZ += tDeltaZ; }
        if (gx < 0 || gz < 0 || gx >= dim || gz >= dim) break;
      }
      if (bestIdx < 0 || bestT > maxDist) return null;
      out.distance = bestT;
      out.point.copy(dir).multiplyScalar(bestT).add(origin);
      out.index = bestIdx;
      return out;
    },

    /**
     * Push a sphere out of any box it overlaps. Mutates `pos`; returns the
     * summed contact normal (zero-length when free).
     */
    resolve(pos, radius, normalOut) {
      normalOut.set(0, 0, 0);
      let hits = 0;
      const gx = grid.cellOf(pos.x), gz = grid.cellOf(pos.z);
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const cx = gx + dx, cz = gz + dz;
          if (cx < 0 || cz < 0 || cx >= grid.dim || cz >= grid.dim) continue;
          for (const i of grid.bucket(cx, cz)) {
            const b = i * 6;
            const qx = clamp(pos.x, arr[b], arr[b + 1]);
            const qy = clamp(pos.y, arr[b + 2], arr[b + 3]);
            const qz = clamp(pos.z, arr[b + 4], arr[b + 5]);
            let nx = pos.x - qx, ny = pos.y - qy, nz = pos.z - qz;
            let d2 = nx * nx + ny * ny + nz * nz;
            if (d2 > radius * radius) continue;

            if (d2 > 1e-8) {
              const d = Math.sqrt(d2);
              nx /= d; ny /= d; nz /= d;
              const push = radius - d;
              pos.x += nx * push; pos.y += ny * push; pos.z += nz * push;
            } else {
              // Centre is inside the box: escape along the shallowest axis.
              //
              // Downwards is deliberately not a candidate. Buildings stand on
              // the ground, so near the base the floor is always the closest
              // face — and pushing down there buries the player under the box,
              // where the street clamp shoves them straight back in and the two
              // fight forever.
              const dxl = pos.x - arr[b], dxh = arr[b + 1] - pos.x;
              const dyh = arr[b + 3] - pos.y;
              const dzl = pos.z - arr[b + 4], dzh = arr[b + 5] - pos.z;
              const m = Math.min(dxl, dxh, dyh, dzl, dzh);
              nx = ny = nz = 0;
              if (m === dyh) { ny = 1; pos.y = arr[b + 3] + radius; }
              else if (m === dxh) { nx = 1; pos.x = arr[b + 1] + radius; }
              else if (m === dxl) { nx = -1; pos.x = arr[b] - radius; }
              else if (m === dzh) { nz = 1; pos.z = arr[b + 5] + radius; }
              else { nz = -1; pos.z = arr[b + 4] - radius; }
            }
            normalOut.x += nx; normalOut.y += ny; normalOut.z += nz;
            hits++;
          }
        }
      }
      if (hits) normalOut.normalize();
      return hits;
    },

    /** Tallest roof directly over/under (x, z), or 0 for open street. */
    heightAt(x, z) {
      const gx = grid.cellOf(x), gz = grid.cellOf(z);
      let h = 0;
      for (const i of grid.bucket(gx, gz)) {
        const b = i * 6;
        if (x >= arr[b] && x <= arr[b + 1] && z >= arr[b + 4] && z <= arr[b + 5]) {
          if (arr[b + 3] > h) h = arr[b + 3];
        }
      }
      return h;
    },
  };

  return city;
}
