// The lake's shape, as a plain function.
//
// Kept free of three.js on purpose: the terrain mesh is only one consumer. The
// boat needs the same numbers to know where the water runs out, and anything
// else that cares -- spawn points, shallow-water shading, a minimap -- should
// ask this rather than keep its own copy that can drift out of agreement with
// the geometry on screen.

import { get } from './params.js';

// ----------------------------------------------------------
// Deterministic value noise, so the lake is the same lake every reload and the
// boat can be placed in open water without checking.

const hash2 = (x, y) => {
  let h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return h - Math.floor(h);
};

const vnoise = (x, y) => {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy), b = hash2(ix + 1, iy);
  const c = hash2(ix, iy + 1), d = hash2(ix + 1, iy + 1);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
};

const fbm = (x, y, oct = 5) => {
  let s = 0, amp = 0.5, fx = x, fy = y;
  for (let i = 0; i < oct; i++) {
    s += amp * vnoise(fx, fy);
    fx = fx * 2.03 + 17.1; fy = fy * 2.03 - 9.3;
    amp *= 0.5;
  }
  return s / (1 - Math.pow(0.5, oct)) * 0.5;
};

/** Land height in metres at a world position. Negative is lake bed. */
export function heightAt(x, z) {
  const R = get('lake.radius');
  const r = Math.hypot(x, z) / Math.max(R, 50);

  // A basin: open water in the middle, rising to hills at the rim. The rim is
  // pushed in and out by low-frequency noise, which is what gives bays and
  // headlands rather than a circular pond.
  const wobble = (fbm(x * 0.00055, z * 0.00055, 3) - 0.5) * get('lake.wobble');
  const basin = Math.max(0, (r + wobble - 0.30)) / 0.70;

  const hills = fbm(x * 0.0016, z * 0.0016, 5) * get('lake.relief');
  const detail = fbm(x * 0.0075, z * 0.0075, 4) * get('lake.relief') * 0.16;

  // Islands: a second, sparser field that only breaches near the middle.
  const isl = fbm(x * 0.0021 + 53.0, z * 0.0021 - 27.0, 4);
  const islands = Math.max(0, isl - 0.62) * get('lake.islands') * (1 - Math.min(r, 1));

  return -get('lake.depth') + basin * basin * get('lake.rim') + hills + detail + islands;
}
