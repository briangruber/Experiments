// Ocean settings — the handful of numbers that decide what the sea looks like,
// exposed as sliders and remembered across reloads.
//
// Why this exists at all: every one of these values was picked by rendering a
// frame, looking at it, and rendering another. That loop costs minutes per
// step and it is run by me, on a desktop, against reference paintings — while
// the person who has to like the result is looking at a phone in daylight.
// Turning the loop into a slider moves the judgement to where the eyes are.
//
// Two rules shape the file:
//
//   1. **A setting is a number, never a shader edit.** Everything here writes
//      an existing uniform. Nothing branches, nothing rebuilds a node graph,
//      nothing touches material.needsUpdate — a changed setting must never cost
//      a pipeline compile, because on the WebGPU backend that is a visible
//      stall (see main.js's warm-up for what those cost).
//   2. **The time of day still wins where it should.** surface.applyEnv() writes
//      absorption, reflection, caustics and glitter from the environment preset
//      every time the clock moves, so a setting that owned those outright would
//      be erased at the next sunset. Those are declared `scale` and multiply
//      whatever the preset just wrote; only values the presets never touch are
//      declared `set`. `apply()` runs at the END of applyEnv for that reason.
//
// The panel that drives this lives in hud/oceanPanel.js. This module has no DOM
// in it and can be driven from the console: saltyfin.ocean.set('reflect', 0.4).

const KEY = 'saltyfin-ocean';
// Bumped to 2 when the wake came back: a stored `wake: 0` from the version
// where it was off would have kept it off for anyone who had ever opened the
// panel, which is the one setting a player would not think to go looking for.
const VERSION = 2;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// mode: 'set'   — this uniform is ours alone; write the value straight in.
//       'scale' — the env preset owns the base value; multiply it.
// `map` converts the slider's number into what the uniform wants, for the two
// controls where the natural direction of the knob is the inverse of the
// shader's parameter.
export const GROUPS = [
  {
    title: 'Clarity',
    controls: [
      {
        key: 'clarity', label: 'Water clarity', min: 0.4, max: 2.4, step: 0.02, def: 1,
        mode: 'scale', uniform: 'uAbsorb',
        hint: 'How far light gets before the water eats it. Up is clearer.',
        // Absorption is the reciprocal of clarity: less absorbed, further seen.
        apply: (u, v) => u.uAbsorb.value.multiplyScalar(1 / v),
      },
      {
        key: 'reflect', label: 'Reflection', min: 0, max: 1.4, step: 0.02, def: 1,
        mode: 'scale', hint: 'How much sky the surface mirrors back.',
        apply: (u, v) => { u.uReflStrength.value *= v; },
      },
      {
        key: 'shallowRefl', label: 'Shallow reflection', min: 0.05, max: 0.7, step: 0.01, def: 0.22,
        mode: 'set', hint: 'How much of that reaches the lagoon. Down to see the coral.',
        apply: (u, v) => { u.uReflBedMin.value = v; },
      },
      {
        key: 'caustics', label: 'Caustics', min: 0, max: 2, step: 0.02, def: 1,
        mode: 'scale', hint: 'The moving light net on the sand.',
        apply: (u, v) => { u.uCaustic.value *= v; },
      },
      {
        key: 'glitter', label: 'Sun glitter', min: 0, max: 2, step: 0.02, def: 1,
        mode: 'scale', hint: 'The scatter of hard bright points on the sun path.',
        apply: (u, v) => { u.uGlitter.value *= v; },
      },
    ],
  },
  {
    title: 'Waves',
    controls: [
      {
        key: 'swell', label: 'Offshore swell', min: 0, max: 2, step: 0.02, def: 1,
        mode: 'set', hint: 'How much rougher the water gets as the bottom drops away. 0 is a flat sea everywhere.',
        apply: (u, v) => { u.uSwellGain.value = v; },
      },
      {
        key: 'chop', label: 'Chop', min: 0, max: 1, step: 0.01, def: 0.44,
        mode: 'set', hint: 'The metre-scale texture riding on the swell.',
        apply: (u, v) => { u.uDetailStrength.value = v; },
      },
      {
        // step 0.05, not 0.02: a range input snaps to min + n*step, and 0.95 is
        // not on a 0.02 grid from zero — the slider would come back reading 0.96
        // and the stored value and the thumb would disagree by a step forever.
        key: 'fineChop', label: 'Fine chop', min: 0, max: 2, step: 0.05, def: 0.95,
        mode: 'set', hint: 'The sub-metre ripple, near the camera only.',
        apply: (u, v) => { u.uFineChop.value = v; },
      },
      {
        key: 'distort', label: 'Refraction bend', min: 0, max: 0.6, step: 0.01, def: 0.26,
        mode: 'set', hint: 'How far the surface throws what is under it.',
        apply: (u, v) => { u.uRefractDistort.value = v; },
      },
    ],
  },
  {
    title: 'Foam',
    controls: [
      {
        key: 'whitecaps', label: 'Whitecaps', min: 0, max: 1, step: 0.01, def: 0.5,
        mode: 'set', hint: 'White on the steep faces offshore. The lagoon stays glass either way.',
        // uCrestNorm normalises the Gerstner Jacobian by the steepness budget,
        // so it runs BACKWARDS: 0.42 is a clean blue sea, 0.10 is a milky wash.
        // The slider is the direction a person expects; the map is the inverse.
        apply: (u, v) => { u.uCrestNorm.value = 0.42 - 0.32 * v; },
      },
      {
        key: 'drift', label: 'Drift foam', min: 0, max: 0.4, step: 0.005, def: 0.13,
        mode: 'set', hint: 'Old foam lying in the troughs, long after the wave broke.',
        apply: (u, v) => { u.uAmbFoam.value = v; },
      },
      {
        key: 'shoreFoam', label: 'Shore foam', min: 0, max: 2, step: 0.02, def: 0.72,
        mode: 'set', hint: 'How far up the beach the white band reaches, in metres of depth.',
        apply: (u, v) => { u.uShoreFoamDepth.value = v; },
      },
      {
        key: 'foamBright', label: 'Foam brightness', min: 0, max: 1.6, step: 0.02, def: 1,
        mode: 'scale', hint: 'Applies to all three foam layers at once.',
        apply: (u, v) => { u.uFoamBright.value *= v; },
      },
      {
        key: 'wake', label: 'Boat wake', min: 0, max: 1.6, step: 0.02, def: 1,
        mode: 'set',
        hint: 'The V and the trail behind the hull. The water it pushes is there either way.',
        apply: (u, v) => { u.uWakeVisible.value = v; },
      },
    ],
  },
];

export const CONTROLS = GROUPS.flatMap((g) => g.controls);
const BY_KEY = new Map(CONTROLS.map((c) => [c.key, c]));

export const DEFAULTS = Object.fromEntries(CONTROLS.map((c) => [c.key, c.def]));

/** Whatever is in storage, cleaned: known keys only, finite, in range. */
function load() {
  const values = { ...DEFAULTS };
  let raw;
  try { raw = localStorage.getItem(KEY); } catch { return values; }  // sandboxed storage
  if (!raw) return values;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return values; }
  if (!parsed || parsed.v !== VERSION || typeof parsed.values !== 'object') return values;
  for (const [k, v] of Object.entries(parsed.values)) {
    const c = BY_KEY.get(k);
    // A control that has been renamed or removed since the save is dropped
    // rather than carried, and a defaulted key simply keeps its default. That
    // is the whole reason for VERSION: bump it and every stored value is stale
    // in one step, without a migration.
    if (!c || typeof v !== 'number' || !Number.isFinite(v)) continue;
    values[k] = clamp(v, c.min, c.max);
  }
  return values;
}

export function createOceanSettings() {
  const values = load();
  const listeners = new Set();
  let saveTimer = 0;

  function save() {
    // Dragging a slider fires input events at pointer rate. Coalesce: the
    // storage write is not what matters, having the value survive a reload is.
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(KEY, JSON.stringify({ v: VERSION, values }));
      } catch { /* private mode, quota, sandboxed iframe — losing the save is fine */ }
    }, 180);
  }

  return {
    values,

    /**
     * Write every setting onto the water's uniforms. Called at the END of
     * surface.applyEnv(), which means the `scale` controls multiply values the
     * environment preset wrote microseconds earlier and the whole thing stays
     * idempotent however many times the clock ticks.
     */
    apply(u) {
      if (!u) return;
      for (const c of CONTROLS) {
        const v = values[c.key];
        if (typeof v !== 'number') continue;
        try { c.apply(u, v); } catch { /* a uniform this build does not have */ }
      }
    },

    get(key) { return values[key]; },

    /** Set one value, persist it, and tell whoever is listening to re-apply. */
    set(key, v) {
      const c = BY_KEY.get(key);
      if (!c || !Number.isFinite(v)) return;
      values[key] = clamp(v, c.min, c.max);
      save();
      for (const fn of listeners) fn(key, values[key]);
    },

    reset() {
      Object.assign(values, DEFAULTS);
      save();
      for (const fn of listeners) fn(null, null);
    },

    /** Called on every change with (key, value); (null, null) for a reset. */
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    groups: GROUPS,
    defaults: DEFAULTS,
  };
}

// One instance for the process. The water surface, the panel and the console
// API all need the same object, and threading it through four constructors to
// avoid a module-level singleton would buy nothing — there is exactly one sea.
export const oceanSettings = createOceanSettings();
