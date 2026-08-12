// Procedural surfaces for the level shell.
//
// Tripo makes the objects; the building itself is generated here. Walls,
// floor and ceiling need textures that tile seamlessly across a whole level,
// which is exactly what a mesh generator does not produce — so these are
// synthesised on a canvas at load and turned into full PBR sets.
//
// Everything is built from one wrapping value-noise function, which is what
// makes the results tileable: the lattice wraps at the texture period, so the
// left edge is genuinely the right edge rather than approximately it.

import * as THREE from 'three';

const SIZE = 512;

/** Integer hash → [0,1). Cheap, and stable across reloads. */
function hash2(x, y, seed) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const fade = (t) => t * t * (3 - 2 * t);

/** Value noise on a lattice that wraps every `period` cells. */
function noise2(x, y, period, seed) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const wrap = (v) => ((v % period) + period) % period;
  const x0 = wrap(xi);
  const y0 = wrap(yi);
  const x1 = wrap(xi + 1);
  const y1 = wrap(yi + 1);

  const u = fade(xf);
  const v = fade(yf);
  const a = hash2(x0, y0, seed);
  const b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed);
  const d = hash2(x1, y1, seed);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

/** Fractal noise, still tiling: each octave doubles the wrapping period. */
function fbm(x, y, octaves, period, seed) {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let freq = period;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise2(x * freq, y * freq, freq, seed + o * 101);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

/** Ridged noise — the streaky, veined look of water damage. */
function ridge(x, y, octaves, period, seed) {
  return 1 - Math.abs(fbm(x, y, octaves, period, seed) * 2 - 1);
}

function makeCanvas() {
  const c = document.createElement('canvas');
  c.width = SIZE;
  c.height = SIZE;
  return c;
}

function toTexture(canvas, { srgb = false, repeat = 1 } = {}) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.anisotropy = 8;
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Derive a tangent-space normal map from a height field by central
 * differences, sampling with wraparound so the normal map tiles as cleanly as
 * the height it came from.
 */
function normalFromHeight(height, strength = 2.4) {
  const canvas = makeCanvas();
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(SIZE, SIZE);
  const at = (x, y) => height[((y + SIZE) % SIZE) * SIZE + ((x + SIZE) % SIZE)];

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      // Normalise (-dx, -dy, 1) into the 0..255 encoding.
      const len = Math.hypot(dx, dy, 1);
      const i = (y * SIZE + x) * 4;
      img.data[i] = ((-dx / len) * 0.5 + 0.5) * 255;
      img.data[i + 1] = ((-dy / len) * 0.5 + 0.5) * 255;
      img.data[i + 2] = (1 / len) * 0.5 * 255 + 127.5;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** Pack a per-pixel float field into a greyscale texture canvas. */
function fieldToCanvas(field) {
  const canvas = makeCanvas();
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(SIZE, SIZE);
  for (let i = 0; i < field.length; i++) {
    const v = Math.max(0, Math.min(255, field[i] * 255));
    img.data[i * 4] = v;
    img.data[i * 4 + 1] = v;
    img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/**
 * Build one surface.
 *
 * `shade(u, v, n)` returns { r, g, b, height, rough } per texel, where `n` is
 * a small bag of pre-sampled noise so each surface does not have to re-derive
 * the same fields.
 */
function buildSurface(shade, seed) {
  const albedo = makeCanvas();
  const ctx = albedo.getContext('2d');
  const img = ctx.createImageData(SIZE, SIZE);
  const height = new Float32Array(SIZE * SIZE);
  const rough = new Float32Array(SIZE * SIZE);

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const u = x / SIZE;
      const v = y / SIZE;
      const n = {
        grain: fbm(u, v, 5, 8, seed),
        blotch: fbm(u, v, 4, 3, seed + 17),
        fine: fbm(u, v, 3, 32, seed + 41),
        veins: ridge(u, v, 4, 5, seed + 73),
      };
      const s = shade(u, v, n);
      const i = (y * SIZE + x) * 4;
      img.data[i] = s.r * 255;
      img.data[i + 1] = s.g * 255;
      img.data[i + 2] = s.b * 255;
      img.data[i + 3] = 255;
      height[y * SIZE + x] = s.height;
      rough[y * SIZE + x] = s.rough;
    }
  }
  ctx.putImageData(img, 0, 0);

  return {
    map: toTexture(albedo, { srgb: true }),
    normalMap: toTexture(normalFromHeight(height)),
    roughnessMap: toTexture(fieldToCanvas(rough)),
  };
}

/** Square-wave distance to the nearest grout line, for tiled surfaces. */
function grout(u, v, cells, width) {
  const fu = Math.abs(((u * cells) % 1) - 0.5);
  const fv = Math.abs(((v * cells) % 1) - 0.5);
  const edge = Math.max(fu, fv);
  return edge > 0.5 - width ? 1 : 0;
}

/**
 * The three shell materials. Built once and shared by every surface of that
 * kind in the level — the geometry's UVs are world-space, so a single tiling
 * material covers the whole floor without a visible repeat at tile joins.
 */
export function createShellMaterials(seed = 1) {
  // Floor: poured concrete under standing water. The puddles are the point —
  // they are the only thing in the level that reflects the torch back, so the
  // player's own light is what makes the floor readable.
  const floorMaps = buildSurface((u, v, n) => {
    const base = 0.13 + n.grain * 0.1 + n.fine * 0.04;
    const stain = Math.max(0, n.blotch - 0.52) * 1.4;
    const wet = Math.max(0, n.blotch * 0.7 + n.veins * 0.5 - 0.62);
    const crack = n.veins > 0.93 ? 1 : 0;
    const shade = base - stain * 0.05 - crack * 0.07;
    return {
      r: shade * 1.02,
      g: shade * 0.99,
      b: shade * 0.95,
      height: n.grain * 0.5 + n.fine * 0.5 - crack * 0.8,
      rough: 0.94 - wet * 0.8 - crack * 0.1,
    };
  }, seed);

  // Walls: institutional tile to waist height is implied by the UV layout
  // (V is world height on wall quads), painted plaster above, and rust running
  // down from wherever the pipes used to be.
  const wallMaps = buildSurface((u, v, n) => {
    const tiled = v < 0.42;
    const line = tiled ? grout(u, v, 9, 0.055) : 0;
    const peel = Math.max(0, n.blotch - 0.46) * 2.1;
    const rust = Math.max(0, n.veins - 0.55) * (0.35 + u * 0.4);
    const base = tiled ? 0.3 + n.fine * 0.05 : 0.21 + n.grain * 0.12;
    const shade = base * (1 - line * 0.55) - peel * 0.06;
    return {
      // Rust pushes red and kills blue; peeled plaster shows grey underneath.
      r: shade * (1 + rust * 0.85),
      g: shade * (0.97 - rust * 0.12),
      b: shade * (0.92 - rust * 0.45),
      height: (tiled ? -line * 0.9 : 0) + n.grain * 0.35 + peel * 0.5,
      rough: (tiled ? 0.55 : 0.9) + peel * 0.08 - n.fine * 0.05,
    };
  }, seed + 5);

  // Ceiling: water-stained panels. Barely ever lit, so it is cheap and dark,
  // but it has to hold up when the torch points up during a scare.
  const ceilMaps = buildSurface((u, v, n) => {
    const panel = grout(u, v, 4, 0.03);
    const damp = Math.max(0, n.blotch - 0.44) * 1.7;
    const shade = 0.17 + n.grain * 0.07 - panel * 0.07 - damp * 0.05;
    return {
      r: shade * (1 + damp * 0.35),
      g: shade * (1 + damp * 0.16),
      b: shade * (1 - damp * 0.1),
      height: -panel * 0.7 + n.grain * 0.3,
      rough: 0.95 - damp * 0.12,
    };
  }, seed + 11);

  const common = {
    // Bare metal nowhere in the shell; everything is painted, poured or tiled.
    metalness: 0.0,
    envMapIntensity: 0.12,
  };

  const floor = new THREE.MeshStandardMaterial({
    ...floorMaps,
    ...common,
    normalScale: new THREE.Vector2(0.8, 0.8),
  });
  const walls = new THREE.MeshStandardMaterial({
    ...wallMaps,
    ...common,
    normalScale: new THREE.Vector2(1.0, 1.0),
  });
  const ceiling = new THREE.MeshStandardMaterial({
    ...ceilMaps,
    ...common,
    normalScale: new THREE.Vector2(0.7, 0.7),
  });

  return { floor, walls, ceiling };
}

/**
 * A soft radial sprite, used for the torch's dust motes and for the glow that
 * sits inside practical lights. Generated rather than shipped so the game has
 * no image files at all beyond the generated meshes.
 */
export function createGlowTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
