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
  castle: () => [at('amb-glow warm', 12, 62), at('amb-glow warm', 88, 58, { animationDelay: '.8s' })],
  clubhouse: () => [at('amb-glow warm', 16, 24, { animationDelay: '.5s' }),
                    at('amb-glow warm', 84, 26, { animationDelay: '1.1s' })],
  fountain: () => [splash(50, 52)],
  cafe: () => [splash(50, 62), at('amb-twinkle', 22, 22, { animationDelay: '.6s' })],
  arcade: () => [at('amb-glow neon', 20, 45), at('amb-glow neon', 52, 40, { animationDelay: '.7s' }),
                 at('amb-glow neon', 80, 46, { animationDelay: '1.4s' })],
  workshop: () => [h('i.amb-motes')],
  post: () => [h('i.amb-motes')],
};

export function landAmbience(id) {
  const make = LAND[id];
  return make ? h('div.amb', {}, ...make()) : null;
}
