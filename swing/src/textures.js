// Every surface in the city is painted here, into 2D canvases, at load time.
// Nothing is fetched from disk: a facade is a window grid drawn once and tiled
// in world space, so a 30 m tower and a 200 m tower get identically sized
// windows and the whole skyline stays coherent at any distance.

import * as THREE from 'three';
import { makeRng } from './util.js';

/** World metres covered by one repeat of the facade texture (8 windows). */
export const FACADE_TILE = 24;
/** World metres covered by one repeat of the roof texture. */
export const ROOF_TILE = 16;

function canvas(size, h = size) {
  const c = document.createElement('canvas');
  c.width = size; c.height = h;
  return { c, g: c.getContext('2d') };
}

function finish(c, { srgb = true, aniso = 8 } = {}) {
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = aniso;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function noise(g, w, h, amount, alpha) {
  for (let i = 0; i < amount; i++) {
    const x = Math.random() * w, y = Math.random() * h;
    g.fillStyle = `rgba(255,255,255,${alpha * Math.random()})`;
    g.fillRect(x, y, 1 + Math.random() * 2, 1);
  }
}

/**
 * Facade colour + emissive pair. The emissive canvas carries the lit windows;
 * bloom turns them into the glow that sells the skyline at dusk.
 */
export function facadeTextures(seed = 7) {
  const rng = makeRng(seed);
  const S = 1024, CELLS = 8, P = S / CELLS;      // 128 px per window cell

  const base = canvas(S);
  base.g.fillStyle = '#3b4150';
  base.g.fillRect(0, 0, S, S);

  // Concrete mottling and vertical grime streaks between the window columns.
  for (let i = 0; i < 900; i++) {
    const x = rng() * S, y = rng() * S, r = rng.range(8, 60);
    base.g.fillStyle = `rgba(${rng.chance(0.5) ? '255,255,255' : '0,0,0'},${rng.range(0.01, 0.05)})`;
    base.g.beginPath(); base.g.arc(x, y, r, 0, Math.PI * 2); base.g.fill();
  }

  const lit = canvas(S);
  lit.g.fillStyle = '#000';
  lit.g.fillRect(0, 0, S, S);

  const WARM = ['#ffd9a0', '#ffc46a', '#fff0d0', '#ffb37a'];
  const COLD = ['#9fe6ff', '#cfefff', '#7fd4ff'];

  for (let cy = 0; cy < CELLS; cy++) {
    for (let cx = 0; cx < CELLS; cx++) {
      const x = cx * P, y = cy * P;
      const w = P * 0.62, h = P * 0.5;
      const ox = x + (P - w) / 2, oy = y + (P - h) / 2;

      // Glass recess on the colour map.
      base.g.fillStyle = '#171b26';
      base.g.fillRect(ox - 3, oy - 3, w + 6, h + 6);
      const glass = base.g.createLinearGradient(ox, oy, ox, oy + h);
      glass.addColorStop(0, '#243044');
      glass.addColorStop(0.55, '#131826');
      glass.addColorStop(1, '#1b2334');
      base.g.fillStyle = glass;
      base.g.fillRect(ox, oy, w, h);
      // Mullion.
      base.g.fillStyle = '#0d1017';
      base.g.fillRect(ox + w / 2 - 1.5, oy, 3, h);

      // Ledge highlight below the sill.
      base.g.fillStyle = 'rgba(255,255,255,0.05)';
      base.g.fillRect(ox - 4, oy + h + 3, w + 8, 3);

      if (!rng.chance(0.52)) continue;                  // most windows stay dark
      const col = rng.chance(0.78) ? rng.pick(WARM) : rng.pick(COLD);
      const strength = rng.range(0.35, 1);
      lit.g.globalAlpha = strength;
      lit.g.fillStyle = col;
      // Occasionally only half the pane is lit — reads as rooms, not a grid.
      const cut = rng.chance(0.28) ? rng.range(0.3, 0.7) : 1;
      lit.g.fillRect(ox, oy, w * cut, h);
      lit.g.globalAlpha = strength * 0.1;
      lit.g.fillRect(ox - 6, oy - 6, w + 12, h + 12);   // soft spill onto concrete
      lit.g.globalAlpha = 1;
    }
  }

  noise(base.g, S, S, 4000, 0.05);

  return { map: finish(base.c), emissive: finish(lit.c) };
}

/** Gravel-and-tar rooftop, with painted markings and stains. */
export function roofTexture(seed = 11) {
  const rng = makeRng(seed);
  const S = 512;
  const { c, g } = canvas(S);
  g.fillStyle = '#20242c';
  g.fillRect(0, 0, S, S);
  for (let i = 0; i < 9000; i++) {
    g.fillStyle = `rgba(${rng.chance(0.5) ? '255,255,255' : '0,0,0'},${rng.range(0.02, 0.12)})`;
    g.fillRect(rng() * S, rng() * S, rng.range(1, 4), rng.range(1, 4));
  }
  for (let i = 0; i < 26; i++) {                       // tar seams
    g.strokeStyle = `rgba(0,0,0,${rng.range(0.1, 0.3)})`;
    g.lineWidth = rng.range(1, 4);
    g.beginPath();
    const y = rng() * S;
    g.moveTo(0, y); g.lineTo(S, y + rng.range(-20, 20));
    g.stroke();
  }
  g.strokeStyle = 'rgba(230,230,210,0.16)';
  g.lineWidth = 5;
  g.strokeRect(40, 40, S - 80, S - 80);
  return finish(c);
}

/** Street grid seen from above: asphalt, sidewalks, lane markings, lamps. */
export function groundTextures(seed = 23, roadFrac = 0.32) {
  const rng = makeRng(seed);
  const S = 512;
  const r = Math.round(S * roadFrac) / 2;               // half road width in px

  const base = canvas(S);
  const g = base.g;
  g.fillStyle = '#0b0e15';
  g.fillRect(0, 0, S, S);
  // Block interior (under the buildings) — slightly warmer than the asphalt.
  g.fillStyle = '#151922';
  g.fillRect(r, r, S - 2 * r, S - 2 * r);
  // Sidewalk ring.
  g.strokeStyle = '#242a36';
  g.lineWidth = 10;
  g.strokeRect(r + 5, r + 5, S - 2 * r - 10, S - 2 * r - 10);

  // Lane dashes down the middle of each road (roads run along the tile edges).
  g.strokeStyle = 'rgba(220,190,120,0.5)';
  g.lineWidth = 3;
  g.setLineDash([16, 22]);
  g.beginPath();
  g.moveTo(0, 0); g.lineTo(S, 0);
  g.moveTo(0, 0); g.lineTo(0, S);
  g.stroke();
  g.setLineDash([]);
  noise(g, S, S, 6000, 0.04);

  // Street lights and traffic, as an emissive layer.
  const lit = canvas(S);
  const e = lit.g;
  e.fillStyle = '#000';
  e.fillRect(0, 0, S, S);
  const lamp = (x, y, col, rad, a) => {
    const grd = e.createRadialGradient(x, y, 0, x, y, rad);
    grd.addColorStop(0, col);
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    e.globalAlpha = a;
    e.fillStyle = grd;
    e.beginPath(); e.arc(x, y, rad, 0, Math.PI * 2); e.fill();
    e.globalAlpha = 1;
  };
  for (let i = 0; i < 6; i++) {
    const t = (i + 0.5) / 6 * S;
    lamp(t, r * 0.55, '#ffcf8a', 26, 0.9);
    lamp(t, S - r * 0.55, '#ffcf8a', 26, 0.9);
    lamp(r * 0.55, t, '#ffcf8a', 26, 0.9);
    lamp(S - r * 0.55, t, '#ffcf8a', 26, 0.9);
  }
  for (let i = 0; i < 14; i++) {                       // traffic
    const along = rng() * S;
    const lane = rng.range(-r * 0.5, r * 0.5);
    if (rng.chance(0.5)) lamp(along, (rng.chance(0.5) ? 0 : S) + lane, rng.chance(0.5) ? '#fff4e0' : '#ff5a5a', 9, 1);
    else lamp((rng.chance(0.5) ? 0 : S) + lane, along, rng.chance(0.5) ? '#fff4e0' : '#ff5a5a', 9, 1);
  }

  return { map: finish(base.c), emissive: finish(lit.c) };
}

/** Dusk gradient with stars, painted straight onto the inside of a sphere. */
export function skyTexture() {
  const W = 1024, H = 512;
  const { c, g } = canvas(W, H);
  // A sphere's v runs 1 at the zenith to 0 at the nadir, and canvas row 0 maps
  // to v = 1 — so the horizon belongs at the *middle* of this gradient, not at
  // the bottom. Everything below y = H/2 is under the skyline and never seen.
  const grd = g.createLinearGradient(0, 0, 0, H);
  grd.addColorStop(0.00, '#050818');   // zenith
  grd.addColorStop(0.18, '#0b1130');
  grd.addColorStop(0.32, '#1b2350');
  grd.addColorStop(0.42, '#3b3269');
  grd.addColorStop(0.47, '#7c4272');
  grd.addColorStop(0.49, '#c2624f');
  grd.addColorStop(0.50, '#ff9a52');   // horizon
  grd.addColorStop(0.52, '#ffc078');
  grd.addColorStop(0.56, '#6a4a63');
  grd.addColorStop(0.70, '#221c33');
  grd.addColorStop(1.00, '#14101f');
  g.fillStyle = grd;
  g.fillRect(0, 0, W, H);

  const rng = makeRng(99);
  for (let i = 0; i < 900; i++) {
    const y = rng() * H * 0.42;
    const a = (1 - y / (H * 0.42)) * rng.range(0.15, 0.95);
    g.fillStyle = `rgba(255,255,255,${a})`;
    const s = rng.chance(0.9) ? 1 : 2;
    g.fillRect(rng() * W, y, s, s);
  }
  // A few soft cloud bands catching the last light, just above the horizon.
  for (let i = 0; i < 26; i++) {
    const y = rng.range(H * 0.3, H * 0.49);
    const w = rng.range(90, 460), h = rng.range(4, 16);
    const x = rng() * W;
    const cg = g.createLinearGradient(x, y, x + w, y);
    const tint = y > H * 0.44 ? '255,190,150' : '150,140,190';
    cg.addColorStop(0, `rgba(${tint},0)`);
    cg.addColorStop(0.5, `rgba(${tint},${rng.range(0.08, 0.3)})`);
    cg.addColorStop(1, `rgba(${tint},0)`);
    g.fillStyle = cg;
    g.beginPath();
    g.ellipse(x + w / 2, y, w / 2, h, 0, 0, Math.PI * 2);
    g.fill();
  }
  return finish(c);
}

/** Soft round sprite used for spray, sparks and the sun flare. */
export function dotTexture() {
  const S = 128;
  const { c, g } = canvas(S);
  const grd = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grd.addColorStop(0.0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  grd.addColorStop(1.0, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, S, S);
  const tex = finish(c);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}
