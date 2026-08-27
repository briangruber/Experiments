// How the hull sits in the water at a given speed.
//
// A planing hull does not simply tilt further the faster it goes. It climbs its
// own bow wave through the hump -- bow up, stern squatting, the steepest trim it
// ever runs -- and then settles BACK down as dynamic lift takes over and it gets
// up on top of the water. So trim rises and then falls, and the peak is around
// the hump rather than at the top end.
//
// The consequence that matters for the wake: as the bow lifts, the wetted length
// shortens. Spray stops leaving from the stem and starts leaving from wherever
// the hull still touches, which moves aft with speed. That contact point is what
// the wake has to be built from, not the stem.

import { get } from './params.js';

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export function attitude(speed) {
  const L = Math.max(get('boat.length'), 0.5);
  const Fr = Math.max(speed, 0) / Math.sqrt(9.81 * L);

  const frh = Math.max(get('boat.humpFroude'), 0.05);
  const h = Fr / frh;
  const hump = h * h * Math.exp(1 - h * h);        // peaks at 1.0, at Fr = frh
  const planed = smoothstep(frh * 1.05, frh * 2.3, Fr);

  // Through the hump the bow climbs; on plane it settles back to a shallower
  // running trim. The hump term is faded as the plane term takes over, so the
  // two cannot add into an angle no hull would run at.
  // Below the hump the hull is pushing water aside and sits BOW DOWN -- the
  // slowest, smallest-wake regime. Then it climbs, then it settles.
  const displacement = 1 - smoothstep(0, frh * 0.8, Fr);

  const trim = -get('boat.trimRest') * displacement
             + get('boat.trimHump') * hump * (1 - planed * 0.75)
             + get('boat.trimPlane') * planed;

  const rise = get('boat.riseMax') * planed;       // the hull lifts once planing
  const wetStart = L * get('boat.wetShift') * planed;   // water touches from here aft

  return { Fr, trim, rise, wetStart, planed, hump };
}
