/*
 * Faces.
 *
 * The graphical services of the era all had one of these: before you went
 * anywhere you built a head, and then that head was you for the rest of
 * the night. It is the single cheapest thing a system can do to make a
 * room feel occupied — eight names in a list is a list, eight faces
 * standing around is a party.
 *
 * Drawn as vectors rather than generated, so that every combination is
 * consistent, instant, and costs nothing to store. A face is six small
 * numbers.
 */

import { svg, hash } from '../../core/dom.js';

export const SKINS = ['#f6d5b8', '#eec39c', '#d9a273', '#b87a4e', '#8d5a34', '#5f3b21'];
export const HAIRS = ['#2b2118', '#5b3a1a', '#a86b2e', '#d9b45a', '#c04a2a', '#9a9a9a',
                      '#3a5fb8', '#8a3fa8', '#2f8f5a'];

/* Clothes, because these were portraits — head and shoulders in a frame —
   not floating heads. */
export const SHIRTS = ['#c0392b', '#2f6bd0', '#2f8f5a', '#d9a02b', '#8a3fa8',
                       '#e0e0d8', '#3a3f4a', '#d96a8a'];

/* The wash behind the sitter, which the services all had. */
export const BACKDROPS = ['#8fbfe0', '#c8d8a8', '#e0c090', '#d8a8c0', '#a8b8d8', '#c0c0b0'];

/** Each part is a small builder so a face is just six indices. */
const HAIR_STYLES = [
  (c) => [svg('path', { d: 'M12 26c0-9 5-15 20-15s20 6 20 15c0 0-3-7-20-7s-20 7-20 7z', fill: c })],
  (c) => [svg('path', { d: 'M11 30c0-13 7-20 21-20s21 7 21 20c0 0 1-14-21-14S11 30 11 30z', fill: c }),
          svg('path', { d: 'M9 28c0 12 3 18 3 18l-4 1c-2-6-2-13-1-19z', fill: c }),
          svg('path', { d: 'M55 28c0 12-3 18-3 18l4 1c2-6 2-13 1-19z', fill: c })],
  (c) => [svg('path', { d: 'M13 27c2-11 9-16 19-16s17 5 19 16c-4-4-9-3-13-6-3 4-16 5-25 6z', fill: c })],
  (c) => [svg('path', { d: 'M16 22c4-8 10-11 16-11s12 3 16 11c-3-2-7 1-10-2-4 4-15 3-22 2z', fill: c }),
          svg('path', { d: 'M20 12c6-5 18-5 24 0-6-3-18-3-24 0z', fill: c })],
  (c) => [svg('path', { d: 'M12 30C12 15 20 9 32 9s20 6 20 21c0 6-2 10-2 10s2-22-18-22-18 22-18 22-2-4-2-10z', fill: c })],
  () => [],                                            // none
  (c) => [svg('path', { d: 'M14 25c1-10 8-15 18-15s17 5 18 15c-5-6-8-2-12-6-4 5-14 5-24 6z', fill: c }),
          svg('circle', { cx: 32, cy: 7, r: 4, fill: c })],
];

const EYES = [
  () => [svg('circle', { cx: 24, cy: 33, r: 2.6, fill: '#1a1a1a' }),
         svg('circle', { cx: 40, cy: 33, r: 2.6, fill: '#1a1a1a' })],
  () => [svg('ellipse', { cx: 24, cy: 33, rx: 3.4, ry: 2.4, fill: '#fff', stroke: '#333', 'stroke-width': .8 }),
         svg('ellipse', { cx: 40, cy: 33, rx: 3.4, ry: 2.4, fill: '#fff', stroke: '#333', 'stroke-width': .8 }),
         svg('circle', { cx: 24.6, cy: 33, r: 1.5, fill: '#2b4a8f' }),
         svg('circle', { cx: 40.6, cy: 33, r: 1.5, fill: '#2b4a8f' })],
  () => [svg('path', { d: 'M21 34c1.6-2.4 4.4-2.4 6 0', fill: 'none', stroke: '#1a1a1a', 'stroke-width': 1.6, 'stroke-linecap': 'round' }),
         svg('path', { d: 'M37 34c1.6-2.4 4.4-2.4 6 0', fill: 'none', stroke: '#1a1a1a', 'stroke-width': 1.6, 'stroke-linecap': 'round' })],
  () => [svg('rect', { x: 21.5, y: 31.5, width: 5, height: 3, fill: '#1a1a1a' }),
         svg('rect', { x: 37.5, y: 31.5, width: 5, height: 3, fill: '#1a1a1a' })],
  () => [svg('circle', { cx: 24, cy: 33, r: 3.6, fill: '#fff', stroke: '#333', 'stroke-width': .8 }),
         svg('circle', { cx: 40, cy: 33, r: 3.6, fill: '#fff', stroke: '#333', 'stroke-width': .8 }),
         svg('circle', { cx: 24, cy: 33, r: 1.7, fill: '#1a1a1a' }),
         svg('circle', { cx: 40, cy: 33, r: 1.7, fill: '#1a1a1a' })],
];

const BROWS = [
  () => [],
  () => [svg('path', { d: 'M20 28h8M36 28h8', stroke: '#3a2a1a', 'stroke-width': 1.8, 'stroke-linecap': 'round' })],
  () => [svg('path', { d: 'M20 29l8-2M36 27l8 2', stroke: '#3a2a1a', 'stroke-width': 1.8, 'stroke-linecap': 'round' })],
  () => [svg('path', { d: 'M20 27l8 2M36 29l8-2', stroke: '#3a2a1a', 'stroke-width': 1.8, 'stroke-linecap': 'round' })],
];

const NOSES = [
  () => [svg('path', { d: 'M32 36v5l-2.5 1.5', fill: 'none', stroke: '#a97b58', 'stroke-width': 1.4, 'stroke-linecap': 'round' })],
  () => [svg('circle', { cx: 32, cy: 40, r: 2, fill: '#c98f68' })],
  () => [svg('path', { d: 'M30 41c1.4 1 2.6 1 4 0', fill: 'none', stroke: '#a97b58', 'stroke-width': 1.4, 'stroke-linecap': 'round' })],
  () => [],
];

const MOUTHS = [
  () => [svg('path', { d: 'M26 47c3.5 3.5 8.5 3.5 12 0', fill: 'none', stroke: '#8a3a3a', 'stroke-width': 1.8, 'stroke-linecap': 'round' })],
  () => [svg('path', { d: 'M26 49c3.5-3.5 8.5-3.5 12 0', fill: 'none', stroke: '#8a3a3a', 'stroke-width': 1.8, 'stroke-linecap': 'round' })],
  () => [svg('ellipse', { cx: 32, cy: 48, rx: 4, ry: 3, fill: '#7a2a2a' }),
         svg('ellipse', { cx: 32, cy: 49.4, rx: 2.4, ry: 1.4, fill: '#d97a7a' })],
  () => [svg('rect', { x: 27, y: 47, width: 10, height: 1.8, rx: .9, fill: '#8a3a3a' })],
  () => [svg('path', { d: 'M26 46.5c3.5 4 8.5 4 12 0z', fill: '#7a2a2a' }),
         svg('rect', { x: 27.5, y: 46.5, width: 9, height: 1.6, fill: '#fff' })],
];

const EXTRAS = [
  () => [],
  // spectacles
  () => [svg('circle', { cx: 24, cy: 33, r: 5, fill: 'none', stroke: '#3a3a3a', 'stroke-width': 1.3 }),
         svg('circle', { cx: 40, cy: 33, r: 5, fill: 'none', stroke: '#3a3a3a', 'stroke-width': 1.3 }),
         svg('path', { d: 'M29 33h6', stroke: '#3a3a3a', 'stroke-width': 1.3 })],
  // baseball cap
  () => [svg('path', { d: 'M13 25c0-10 8-15 19-15s19 5 19 15z', fill: '#2f6bd0' }),
         svg('path', { d: 'M12 25h26c0 2-2 3-6 3H14z', fill: '#2454a8' })],
  // headphones
  () => [svg('path', { d: 'M14 32v-4a18 18 0 0 1 36 0v4', fill: 'none', stroke: '#3a3a44', 'stroke-width': 2.4 }),
         svg('rect', { x: 10.5, y: 30, width: 6, height: 10, rx: 2.4, fill: '#3a3a44' }),
         svg('rect', { x: 47.5, y: 30, width: 6, height: 10, rx: 2.4, fill: '#3a3a44' })],
  // moustache
  () => [svg('path', { d: 'M25 44c3-2 5-1 7 0 2-1 4-2 7 0-2 2-5 2-7 1-2 1-5 1-7-1z', fill: '#3a2a1a' })],
  // a crown, for the Keep
  () => [svg('path', { d: 'M20 18l3-9 5 6 4-8 4 8 5-6 3 9z', fill: '#ffd23a', stroke: '#a97b00', 'stroke-width': .8 })],
];

export const PARTS = {
  hair: HAIR_STYLES, eyes: EYES, brows: BROWS,
  nose: NOSES, mouth: MOUTHS, extra: EXTRAS,
};

export const DEFAULT_FACE = {
  skin: 0, hair: 1, hairColor: 0, eyes: 1, brows: 1, nose: 0, mouth: 0, extra: 0,
  shirt: 1, backdrop: 0,
};

const pick = (arr, i) => arr[((i % arr.length) + arr.length) % arr.length];

/**
 * One sitter, as an <svg>: a wash, shoulders in a shirt, then the head.
 * Square, because these hung in a frame with a name plate under them.
 */
export function faceSvg(face = DEFAULT_FACE, size = 64, { plain = false } = {}) {
  const f = { ...DEFAULT_FACE, ...face };
  const skin = pick(SKINS, f.skin);
  const hairCol = pick(HAIRS, f.hairColor);
  const shirt = pick(SHIRTS, f.shirt);
  const wash = pick(BACKDROPS, f.backdrop);
  const dark = c => c;                       // shirts read flat, as they did

  return svg('svg', {
    viewBox: '0 0 64 64', width: size, height: size, class: 'face',
    'shape-rendering': 'geometricPrecision',
  },
    plain ? null : svg('rect', { x: 0, y: 0, width: 64, height: 64, fill: wash }),
    plain ? null : svg('rect', { x: 0, y: 44, width: 64, height: 20, fill: wash,
                                 opacity: .0 }),

    // shoulders
    svg('path', { d: 'M8 64c0-11 10-16 24-16s24 5 24 16z', fill: shirt }),
    svg('path', { d: 'M8 64c0-11 10-16 24-16s24 5 24 16z', fill: 'none',
                  stroke: 'rgba(0,0,0,.35)', 'stroke-width': 1 }),
    svg('path', { d: 'M26 49h12l-6 9z', fill: dark(shirt), opacity: .55 }),

    // neck and head
    svg('rect', { x: 27, y: 46, width: 10, height: 8, fill: skin }),
    svg('ellipse', { cx: 32, cy: 32, rx: 19, ry: 21, fill: skin }),
    svg('ellipse', { cx: 32, cy: 32, rx: 19, ry: 21, fill: 'none',
                     stroke: 'rgba(0,0,0,.32)', 'stroke-width': 1 }),
    svg('ellipse', { cx: 13.5, cy: 33, rx: 3, ry: 4, fill: skin }),
    svg('ellipse', { cx: 50.5, cy: 33, rx: 3, ry: 4, fill: skin }),

    svg('g', { transform: 'translate(0,-4)' },
      pick(PARTS.brows, f.brows)(),
      pick(PARTS.eyes, f.eyes)(),
      pick(PARTS.nose, f.nose)(),
      pick(PARTS.mouth, f.mouth)(),
      pick(PARTS.hair, f.hair)(hairCol),
      pick(PARTS.extra, f.extra)()));
}

/** A stable face for anybody who has not built one — bots, mostly. */
export function faceFor(name) {
  const x = hash(String(name));
  return {
    skin: x % SKINS.length,
    hair: (x >> 3) % PARTS.hair.length,
    hairColor: (x >> 6) % HAIRS.length,
    eyes: (x >> 10) % PARTS.eyes.length,
    brows: (x >> 13) % PARTS.brows.length,
    nose: (x >> 16) % PARTS.nose.length,
    mouth: (x >> 19) % PARTS.mouth.length,
    extra: (x >> 22) % PARTS.extra.length,
    shirt: (x >> 25) % SHIRTS.length,
    backdrop: (x >> 28) % BACKDROPS.length,
  };
}

export function randomFace() {
  const r = n => (Math.random() * n) | 0;
  return {
    skin: r(SKINS.length), hair: r(PARTS.hair.length), hairColor: r(HAIRS.length),
    eyes: r(PARTS.eyes.length), brows: r(PARTS.brows.length), nose: r(PARTS.nose.length),
    mouth: r(PARTS.mouth.length), extra: r(PARTS.extra.length),
    shirt: r(SHIRTS.length), backdrop: r(BACKDROPS.length),
  };
}

const STORE = 'reverie.face';

export function loadFace() {
  try {
    const v = JSON.parse(localStorage.getItem(STORE));
    return v && typeof v === 'object' ? { ...DEFAULT_FACE, ...v } : null;
  } catch { return null; }
}
export function saveFace(face) {
  try { localStorage.setItem(STORE, JSON.stringify(face)); } catch {}
}
