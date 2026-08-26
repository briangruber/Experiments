/*
 * The things that move when nothing is happening.
 *
 * A painted map is a picture; a painted map with water coming out of the
 * fountain and smoke off the inn chimney is a place. None of this is
 * interactive and none of it is on the critical path — it is a layer of
 * small looping sprites laid over the art at tuned positions, drawn in CSS
 * so it costs nothing and stops dead under prefers-reduced-motion.
 *
 * Positions are percentages of the picture, measured off the generated
 * artwork. Regenerate the art and they will need measuring again.
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

/** Three puffs off a chimney, each slower and fatter than the last. */
const smoke = (x, y) => h('i.amb-smoke', { style: { left: x + '%', top: y + '%' } },
  h('u', { style: { animationDelay: '0s' } }),
  h('u', { style: { animationDelay: '1.5s' } }),
  h('u', { style: { animationDelay: '3s' } }));

/** A gull is two strokes that flap. It is enough. */
const gull = (y, delay, dur) => h('i.amb-gull', {
  style: { top: y + '%', animationDelay: delay, animationDuration: dur },
}, h('u'));

/**
 * The layer over the island map. Everything here sits above the picture and
 * below the numbered badges, and nothing in it takes a pointer event.
 */
export function townAmbience() {
  return h('div.amb', {},
    splash(50, 67),                                  // the tiered fountain in the square
    splash(50.3, 50),                                // the little one up the lane
    smoke(71.5, 43),                                 // a chimney on the lane
    gull(6, '0s', '26s'),
    gull(11, '9s', '34s'),
    gull(3.5, '17s', '30s'),
    at('amb-twinkle', 10, 22),                       // lights on the big wheel
    at('amb-twinkle', 12.5, 27, { animationDelay: '.7s' }),
    at('amb-twinkle', 67, 27, { animationDelay: '1.3s' }),   // shop awnings
    at('amb-twinkle', 78, 59, { animationDelay: '2.1s' }),   // the inn's sign
    at('amb-pennant', 27, 5),                        // over the castle tower
    at('amb-wake', 10, 85));                         // the biplane on the water
}

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
