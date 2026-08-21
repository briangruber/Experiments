// Underwater explosion: the gas bubble, not just a push.
//
// A charge fired underwater does two things. A shock wave leaves at about
// 1500 m/s and is gone before anything moves — at tank scale that is one
// frame, so it is a single sharp impulse here. What you actually WATCH is the
// second thing: the detonation products form a gas bubble that expands, and
// because the gas over-expands past the pressure that would balance it, the
// water outside stops it, drives it back, and it collapses. The collapse
// overshoots too, so it re-expands, smaller. That oscillation is the whole
// event, and its first consequence is the one this was missing: the bubble has
// a MAXIMUM RADIUS. An explosion underwater does not keep growing.
//
// Cole's empirical laws (Underwater Explosions, 1948) give both scales:
//
//     R_max = 3.36 · W^(1/3) / (d + 10.33)^(1/3)      metres
//     T     = 2.11 · W^(1/3) / (d + 10.33)^(5/6)      seconds
//
// with W the charge in kg and d the depth in metres. The 10.33 is atmospheric
// pressure written as a head of water, which is the quietly interesting part
// at this scale: the tank is under two metres deep, so d + 10.33 barely moves
// and depth has almost no effect on the bubble. That is not a simplification,
// it is what the formula says — a shallow charge is an essentially
// atmospheric-pressure charge.
//
// The exponents here are Cole's. The two leading constants are not: a real
// kilogram of TNT in a two-metre tank gives a bubble wider than the tank and a
// period under a fifth of a second. So the constants are calibrated to put
// R_max at a readable fraction of the tank and the period at a watchable speed,
// and everything else — how the bubble answers to charge and to depth, how it
// oscillates, how the pulses decay — is the real relationship.

const LAMBDA = 0.62;     // each pulse reaches this fraction of the last radius
const PULSES = 3;        // beyond the third there is nothing left to see
const R_K = 0.80;        // calibrated for the tank; Cole's is 3.36 (TNT, metres)
const T_K = 5.6;         // calibrated for watchability; Cole's is 2.11
const P_ATM = 10.33;     // atmosphere as a head of water, metres

// The Rayleigh bubble spends most of its period near its maximum and collapses
// fast at the end; sin^(2/5) is the standard closed form for that shape, the
// 2/5 coming from the collapse asymptotic. A sine would dwell in the wrong
// place entirely and read as a pulsing ball rather than an explosion.
const shape = (u) => Math.pow(Math.max(Math.sin(Math.PI * u), 1e-4), 0.4);

export function createBlast() {
  const s = {
    alive: false,
    x: 0, y: 0, z: 0,
    rMax: 0.3, period: 0.7,
    cycle: 0, t: 0, r: 0, rPrev: 0, charged: false,
    pulse: 0,          // >0 on the frame a collapse rebounds
  };

  // `charge` is the blast-power knob, `depth` how far under the waterline it
  // went off, both already in tank units.
  function fire(x, y, z, charge, depth) {
    const w = Math.cbrt(Math.max(charge, 0.02));
    const head = Math.max(depth, 0) + P_ATM;
    s.rMax = R_K * w / Math.cbrt(head);
    s.period = T_K * w / Math.pow(head, 5 / 6);
    s.x = x; s.y = y; s.z = z;
    s.cycle = 0; s.t = 0; s.alive = true;
    s.r = 0; s.rPrev = 0; s.pulse = 1;   // the shock leaves on frame one
    s.charged = true;                    // the gas has not gone in yet
    return s;
  }

  // Returns a burst descriptor for the solver, or null when nothing is going
  // on. The solver takes one burst per step, which suits this exactly: the
  // bubble IS the explosion, every frame of it.
  function update(dt, physics) {
    if (!s.alive) return null;
    const rMax = s.rMax * Math.pow(LAMBDA, s.cycle);
    const period = s.period * Math.pow(LAMBDA, s.cycle);
    s.t += dt;

    let pulsed = s.pulse;
    s.pulse = 0;
    if (s.t >= period) {
      s.t -= period;
      s.cycle++;
      if (s.cycle >= PULSES) { s.alive = false; return null; }
      pulsed = 1;                       // the collapse rebounded: a bubble pulse
    }

    const u = Math.min(s.t / period, 0.9999);
    s.rPrev = s.r;
    s.r = rMax * shape(u);
    // Wall speed drives the water. Rayleigh's collapse velocity diverges at the
    // end, which is true and unusable, so it is clamped to something the
    // advection can carry in one step.
    const wall = Math.max(-6, Math.min(6, (s.r - s.rPrev) / Math.max(dt, 1e-4)));

    // Buoyant migration: the bubble creeps up while it is large and JUMPS
    // through each collapse, because a small bubble drags little water along
    // with it. Keyed on where it is in the cycle, not on radius alone — the
    // bubble is just as small at the START of a cycle, where it is opening
    // rather than collapsing, and keying on radius launched it off the mark
    // before it had finished expanding.
    const rise = u > 0.5 ? 0.05 * (rMax / Math.max(s.r, 0.03)) : 0.04;
    s.y += Math.min(1.1, rise) * dt;


    // The charge is already in here: it set R_max and the period back in
    // fire(). Multiplying the wall speed and the gas by `blast power` on top
    // would count it twice and, worse, would let the knob shrink the bubble's
    // contents without shrinking the bubble — a big cavity with nothing in it.
    // The knob keeps the ring, which is a look rather than a consequence.
    // The burst path ADDS its velocity and foam every frame and does not scale
    // either by dt — it was built for one-shot impulses, where that is exactly
    // right. A bubble is not one shot: it is fed continuously for a second or
    // more, so anything expressed as a rate here has to carry its own dt or it
    // accumulates by frame COUNT. Left unscaled the gas came out about
    // twenty-five times over and buried the tank in foam.
    // The gas goes in ONCE, as a compact pocket, and is then carried by the
    // wall velocity. Feeding it in as a rate across the whole expansion — the
    // obvious reading of "gas is conserved" — spreads the same amount over a
    // hundred frames while the outward flow is pulling it apart, and it never
    // accumulates into anything you can see. One pocket that then gets carried
    // out and hauled back is both what the gas actually does and the only
    // version of it that reads.
    const charging = s.charged;
    s.charged = false;

    return {
      pos: { x: s.x, y: s.y, z: s.z },
      radius: charging ? Math.max(s.rMax * 0.30, 0.05) : Math.max(s.r, 0.05),
      // Outward while expanding, inward while collapsing — the sign of the
      // wall velocity is the whole reason this reads as a bubble rather than
      // as a puff. The pulse terms are genuine impulses and stay unscaled.
      vel: wall * 9 * dt + pulsed * 2.2,
      up: pulsed * 0.8,
      foam: (charging ? 3.6 : 0) + pulsed * 0.6,
      ring: pulsed * 2.4 * physics.ring * physics.blast,
      ringR: rMax * 1.1,
      _pulse: pulsed,
    };
  }

  return { fire, update, state: s };
}
