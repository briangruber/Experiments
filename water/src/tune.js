// Live tuning knobs.
//
// Temporary, and deliberately not part of the interface proper: they exist so
// the numbers that can only be judged by eye get judged by an eye, at full
// frame rate, instead of by me squinting at half-frame-a-second captures. Every
// value here starts at what the code used before it was a knob, so the tank
// behaves identically until something is moved.
//
// Two ways in. There is a panel at the bottom of Settings, and the whole object
// is on `window.water.tune`, so anything here can also be set straight from the
// browser console:
//
//     water.tune.beat = 5.2
//
// Nothing is read at startup and cached — every one of these is read at the
// point of use, each frame or each event, so a change lands immediately.
//
// When the numbers settle they should be folded back into the constants they
// came from and this file deleted; `Copy Tuning` prints them in a form that
// makes that a paste rather than a transcription.
export const TUNE = {
  // --- barrels -------------------------------------------------------------
  // Deliberately a narrower spread than it first shipped with: at 0.138 the
  // biggest drum is 1.6x the reference size, and since the cavity radius goes
  // with it, the largest blast phase came out at 0.84 in a tank whose half
  // extent is 1 — the explosion filled the tank and whited out the frame.
  // Widen from here rather than down to it.
  barrelMin: 0.058,     // smallest drum, in tank units
  barrelMax: 0.118,     // largest
  barrelFixed: 0,       // >0 forces every drop to this size, for A/B

  // How hard size drives the blast. The physics says the cavity radius goes as
  // the barrel's size, linearly — this is the exponent on that, so 1 is
  // Cole's answer, higher exaggerates the difference between a small drum and
  // a big one, and 0 makes every barrel blow the same hole.
  blastPow: 0.75,

  // --- the blast itself ----------------------------------------------------
  // Mean aeration of the cavity, which is what decides how fast the blast site
  // floats while its phases play out. Too low and the late phases fire below
  // their own gas — two explosions. Too high and the site outruns the plume.
  cavityRise: 0.35,
  // How hard the cavity is pinned while it opens and is crushed. It is a
  // multiple of `buoyancy`, and the value that exactly cancels is the LOCAL
  // FOAM FRACTION, because that is what buoyancy is multiplied by: the foam
  // feels buoyancy * foam upward, so anchoring at 1 balances a foam of 1.
  // The first guess of 2 assumed the pocket kept something near its injected
  // peak of 3.8, but the burst spreads it through a Gaussian immediately and
  // the crush phases add none, so the number that matters is well under 1 by
  // the time it counts — and at 2 the anchor beat buoyancy outright and drove
  // the whole cavity downward. Rising still means raise it, sinking means
  // lower it, and the value that hangs is the one where they cancel.
  // Now a fraction of the cavity's buoyancy to WITHHOLD, not a force to push
  // back with, so 1 is "held perfectly still" and there is no value that can
  // drive it downward. The old push could not work at any setting: one constant
  // cannot balance a foam field that varies across the pocket.
  cavityAnchor: 1.0,
  // How big the cavity is BORN. Waiting for the injected pocket to spread into
  // an engulfing bubble is what made the whole thing feel slow — opening it at
  // size instead costs nothing and lets the hold come back down.
  cavitySize: 1.9,
  // 0 drops the cavity entirely and leaves the bare rebound blast — the whole
  // implosion-then-boom sequence is the three pinned phases.
  cavityOn: 1,
  // The balance between the two halves of the event. `blast power` over in
  // physics scales BOTH, which is what made them fight: an implosion worth
  // watching forced a rebound that swamped the tank. 1 and 1 is how it behaved
  // before these existed.
  implosion: 2.95,
  mainBlast: 0.15,
  // Brightness of the shock's own flash. 0 leaves the blast lit only by the
  // sun, which is what it was.
  flash: 2.4,
  // Stretches or squeezes the pinned phases together, so how long the cavity
  // sits there before the rebound is one number instead of three.
  cavityHold: 1.35,

  // --- meshes in the light ------------------------------------------------
  // How dark a solid mesh's shadow goes in the volumetric light, and how far
  // the penumbra spreads as a multiple of the proxy radius. 0 strength puts it
  // back to light marching straight through the barrels as if they were water.
  meshShadow: 1.6,
  // How far a mesh steps back up the beam before reading the light volume. It
  // has to clear its OWN occluder or it reads its own shadow and goes flat
  // dark; too far and it is lit by water well above it.
  lightLift: 0.16,
  shadowSoft: 2.0,

  // --- the surface, seen from underneath ------------------------------------
  // How much of the sky comes through Snell's window. 0 is the flat dark room
  // it used to be, which is what made the surface read as a lid.
  skyGain: 0.55,

  // --- framing -------------------------------------------------------------
  // 1 puts the tank's full width exactly at the frame's edges. Below 1 pushes
  // the side walls out of shot, above 1 pulls them inside it.
  fitWidth: 1.0,

  // --- the fish ------------------------------------------------------------
  cross: 28,            // seconds end to end
  beat: 3.4,            // tail beat, radians a second
  tailAmp: 1.0,         // multiplier on the per-joint tail amplitudes
  lag: 0.85,            // radians each joint trails the one ahead of it
  reach: 1.5,           // how far behind the tank it starts, in tank halves
  fadeStart: 0.55,      // depth where it begins to dissolve, in tank halves
  fadeSpan: 0.55,       // and how much further until it is gone
};
