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
