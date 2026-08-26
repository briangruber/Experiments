/*
 * The things that move while you are standing still.
 *
 * The town map animates by itself now — it is a painted clip with its own
 * clouds and its own fountain — so what is left here is what happens
 * inside a place: firelight, water, dust in a sunbeam, cloud going past a
 * terrace. Small looping CSS sprites at measured positions, costing
 * nothing, and stopping dead under prefers-reduced-motion.
 */

import { h } from '../../core/dom.js';

const at = (cls, x, y, extra = {}) => h('i', {
  class: cls, style: { left: x + '%', top: y + '%', ...extra },
});

/** Water, in three arcs that fall out of step with each other. */
const splash = (x, y) => h('i.amb-splash', { style: { left: x + '%', top: y + '%' } },
  h('u', { style: { animationDelay: '0s' } }),
  h('u', { style: { animationDelay: '.45s' } }),
  h('u', { style: { animationDelay: '.9s' } }));

/* What each land does while you stand in it. Lands not named here are
   still and meant to be. */
const LAND = {
  keep: () => [at('amb-glow warm', 12, 62), at('amb-glow warm', 88, 58, { animationDelay: '.8s' })],
  inn: () => [at('amb-glow fire', 50, 58), at('amb-glow warm', 12, 18, { animationDelay: '.5s' }),
              at('amb-glow warm', 87, 17, { animationDelay: '1.1s' })],
  fountain: () => [splash(50, 52)],
  boardwalk: () => [at('amb-twinkle', 22, 30), at('amb-twinkle', 44, 24, { animationDelay: '.6s' }),
                    at('amb-twinkle', 68, 28, { animationDelay: '1.2s' }),
                    at('amb-twinkle', 86, 22, { animationDelay: '1.8s' })],
  post: () => [h('i.amb-motes')],
  cloud: () => [h('i.amb-drift'), h('i.amb-drift', { style: { animationDelay: '-18s', top: '38%' } })],
};

export function landAmbience(id) {
  const make = LAND[id];
  return make ? h('div.amb', {}, ...make()) : null;
}
