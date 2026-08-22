// The physics panel, shared by both backends: a slider per knob, each writing
// straight into the solver's `physics` object, which the next step reads.

export const PHYSICS_KNOBS = [
  { key: 'rise', label: 'bubble rise', min: 0, max: 1.5, step: 0.01,
    desc: 'How fast bubbles slip upward THROUGH the water. This is the whole '
        + 'difference between bubbles and smoke: the foam is carried by the '
        + 'flow plus this rise, rather than by the flow alone. At 0 the foam '
        + 'drifts like smoke.' },
  { key: 'buoyancy', label: 'buoyancy', min: 0, max: 25, step: 0.05,
    desc: 'How hard aerated water lifts the fluid around it. This is what '
        + 'drives a plume upward and makes it billow — the single biggest '
        + 'knob on how violent the tank looks.' },
  { key: 'foamLife', label: 'bubble life', min: 0.5, max: 20, step: 0.5, unit: 's',
    desc: 'How long bubbles last before fading, as an e-folding time. Bubbles '
        + 'mostly leave by popping at the surface rather than by decaying, so '
        + 'this can be set long without the tank filling up.' },
  { key: 'aeration', label: 'aeration', min: 0, max: 10, step: 0.05,
    desc: 'How much foam the paddle and barrels inject per unit of churn. '
        + 'Turn it up for a milkier tank, down for a few sparse strands.' },
  { key: 'swirl', label: 'vorticity', min: 0, max: 0.3, step: 0.005,
    desc: 'Vorticity confinement: it puts back the fine curl the solver damps '
        + 'away numerically, so it sharpens eddies that already exist. It does '
        + 'NOT create the motion, so turning it to zero makes the flow smoother '
        + 'rather than still — what keeps a tank churning is the buoyancy of the '
        + 'foam already in it. Use "calm water" to stop the flow.' },
  { key: 'drag', label: 'water drag', min: 0, max: 10, step: 0.05,
    desc: 'Velocity damping — the stand-in for viscosity. High values make the '
        + 'water syrupy and kill motion quickly after the paddle stops.' },
  { key: 'blast', label: 'blast power', min: 0, max: 3, step: 0.05,
    desc: "Scales an explosion's impulse, foam and ring at the moment it is "
        + 'armed, so moving this reaches explosions already queued.' },
  { key: 'ring', label: 'vortex ring', min: 0, max: 8, step: 0.05,
    desc: 'How much circulation a blast seeds. A purely radial impulse just '
        + 'spreads and dies; this rolling torus is what turns the rising cap '
        + 'into a mushroom. At 0 you get a puff instead.' },
  { key: 'caustics', label: 'caustics', min: 0, max: 2.5, step: 0.05,
    desc: 'Strength of the light filaments on the floor and in the shafts. The '
        + 'pattern is median-normalised, so this redistributes light rather '
        + 'than adding exposure.' },
  { key: 'chop', label: 'surface chop', min: 0, max: 3, step: 0.05,
    desc: 'Amplitude of the ripples on the waterline, which drives the sun '
        + 'glint and how much the view refracts as it crosses the surface.' },
];

// Named starting points, because these ten knobs interact and the interesting
// looks sit in narrow corners of that space. Each is a whole physics setting,
// not a nudge, so applying one moves every slider.
export const PRESETS = {
  // A detonation reads as a mushroom only if four things happen in order: a
  // hard impulse punches a stem, the ring rolls the top of that stem outward
  // and back down into a cap, buoyancy keeps feeding the stem from below, and
  // the foam lasts long enough to still be there when the cap finishes
  // turning over. Drag is the enemy of all four — it is the single change
  // that matters most — and `bubble rise` is nearly as important: foam that
  // slips upward fast enough outruns the flow carrying it and shreds the cap
  // into a curtain, so a mushroom wants the foam to behave like smoke.
  mushroom: {
    rise: 0.18, buoyancy: 16, foamLife: 6, aeration: 5, swirl: 0.06,
    drag: 0.9, blast: 2.2, ring: 7,
  },
  // The opposite corner, and the tank's own defaults: stiff and syrupy, where
  // a blast makes a compact ball of froth that lifts slowly and holds together.
  churn: {
    rise: 0.34, buoyancy: 12.2, foamLife: 2.5, aeration: 7.45, swirl: 0.14,
    drag: 10.0, blast: 0.25, ring: 4.45, caustics: 2.45, chop: 2.9,
  },
};

export function buildPhysicsPanel(physics) {
  const panel = document.getElementById('physics');
  const btn = document.getElementById('physics-btn');
  panel.textContent = '';
  // filled in as the sliders are built, so a preset can move them
  const sync = [];
  const row = document.createElement('div');
  row.className = 'preset-row';
  for (const name of Object.keys(PRESETS)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = name;
    b.title = `Apply the "${name}" preset to every slider below.`;
    b.addEventListener('click', () => {
      Object.assign(physics, PRESETS[name]);
      for (const f of sync) f();
    });
    row.append(b);
  }
  panel.append(row);
  for (const k of PHYSICS_KNOBS) {
    const label = document.createElement('label');
    label.className = 'slider';
    if (k.desc) label.title = `${k.label} — ${k.desc}`;
    const span = document.createElement('span');
    const val = document.createElement('b');
    const input = document.createElement('input');
    input.type = 'range';
    input.min = k.min; input.max = k.max; input.step = k.step;
    input.value = physics[k.key];
    input.setAttribute('aria-label', k.label);
    const show = () => {
      val.textContent = (+input.value).toFixed(2).replace(/0$/, '') + (k.unit || '');
    };
    show();
    input.addEventListener('input', () => {
      physics[k.key] = +input.value;
      show();
    });
    sync.push(() => { input.value = physics[k.key]; show(); });
    span.append(document.createTextNode(k.label + ' '), val);
    label.append(span, input);
    panel.append(label);
  }
  btn.addEventListener('click', () => {
    const open = panel.hasAttribute('hidden');
    panel.toggleAttribute('hidden', !open);
    btn.classList.toggle('active', open);
    btn.setAttribute('aria-expanded', String(open));
  });
}

// Scale a queued explosion by the blast/ring knobs at the moment it is armed,
// so moving the sliders affects explosions already in the queue.
// `k` is this frame's share of a phase that is being held over several — see
// the explosion queue in main.js. A `raw` phase skips the blast scaling: a
// barrel holds the same pocket of air whatever `blast power` is set to, so the
// air is a property of the object rather than of the explosion.
export function armBurst(b, physics, k = 1) {
  const s = (b.raw ? 1 : physics.blast) * k;
  return {
    pos: b.pos,
    vel: (b.vel ?? 0) * s,
    up: (b.up ?? 0) * s,
    foam: (b.foam ?? 0) * s,
    radius: b.radius,
    ring: (b.ring ?? 0) * physics.ring * physics.blast * k,
    ringR: b.ringR ?? 0.3,
  };
}

// ---------------------------------------------------------------------------
// Scene panel: the knobs that decide how much there is to simulate. Grid size
// and particle count both own GPU allocations, so they take effect on a reload
// (the same trick the quality cycle uses); paddle size is live.

export const GRID_SIZES = [32, 48, 64, 80, 96, 112, 128, 144, 160];

// N^3 voxels across 11 rgba16f volumes, plus the particle buffers
const gridMiB = (n) => Math.round((11 * n * n * n * 8) / (1 << 20));

function slider(panel, { label, min, max, step, value, format, desc, oninput, onchange }) {
  const el = document.createElement('label');
  el.className = 'slider';
  if (desc) el.title = `${label} — ${desc}`;
  const span = document.createElement('span');
  const val = document.createElement('b');
  const input = document.createElement('input');
  input.type = 'range';
  input.min = min; input.max = max; input.step = step; input.value = value;
  input.setAttribute('aria-label', label);
  const show = () => { val.textContent = format(+input.value); };
  show();
  input.addEventListener('input', () => { show(); oninput?.(+input.value); });
  if (onchange) input.addEventListener('change', () => onchange(+input.value));
  span.append(document.createTextNode(label + ' '), val);
  el.append(span, input);
  panel.append(el);
  return input;
}

// Reload with one query parameter changed, keeping everything else.
function reloadWith(key, value) {
  const q = new URLSearchParams(location.search);
  q.set(key, String(value));
  location.search = `?${q}`;
}

// ---------------------------------------------------------------------------
// The tuning panel. Temporary — see src/tune.js. Every knob writes straight
// into TUNE, which is read at the point of use rather than cached, so a drag
// lands on the next frame with no reload and nothing to rebuild.
export function buildTunePanel(TUNE, hooks = {}) {
  const panel = document.getElementById('tune');
  const btn = document.getElementById('tune-btn');
  if (!panel || !btn) return;
  panel.textContent = '';

  const head = (t) => {
    const h = document.createElement('h3');
    h.className = 'tune-head';
    h.textContent = t;
    panel.append(h);
  };
  const knob = (key, label, min, max, step, desc, dp = 2) => slider(panel, {
    label, min, max, step, value: TUNE[key], desc,
    format: (v) => v.toFixed(dp),
    oninput: (v) => { TUNE[key] = v; hooks.onChange?.(key, v); },
  });
  const action = (label, fn, title) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'row-btn';
    b.textContent = label;
    if (title) b.title = title;
    b.addEventListener('click', fn);
    panel.append(b);
    return b;
  };

  head('Barrels');
  knob('barrelMin', 'size min', 0.02, 0.12, 0.002,
    'Smallest drum a random drop can pick.', 3);
  knob('barrelMax', 'size max', 0.04, 0.30, 0.002,
    'Largest drum a random drop can pick.', 3);
  knob('barrelFixed', 'fixed size', 0, 0.30, 0.002,
    'Zero picks at random between the two above. Anything else forces every '
    + 'drop to exactly this size, which is how you compare two sizes fairly.', 3);
  knob('blastPow', 'blast from size', 0, 2.5, 0.05,
    'How hard the barrel\'s size drives its explosion. 1 is what the physics '
    + 'says: cavity radius goes as the barrel\'s size, linearly. Higher '
    + 'exaggerates the gap between a small drum and a big one; 0 makes every '
    + 'barrel blow the same hole whatever its size.');
  knob('cavityRise', 'cavity rise', 0, 1.5, 0.01,
    'How fast the blast site floats while its phases play out. Too low and the '
    + 'late phases fire below their own gas, which looks like two explosions in '
    + 'two places. Too high and the site outruns the plume it is feeding.');
  knob('cavityOn', 'cavity', 0, 1, 1,
    'The cavity is the pocket opening and the water crushing it, before the '
    + 'rebound throws the plume. Off leaves the bare blast, which is what this '
    + 'was before any of it.', 0);
  knob('cavityAnchor', 'cavity anchor', 0, 1, 0.02,
    'How much of the cavity\'s buoyancy is withheld while it opens and is '
    + 'crushed. The solver has no idea the pocket is one coherent bubble — it '
    + 'is just buoyant foam to it — so at 0 the cavity floats off before the '
    + 'rebound arrives and you get a small explosion rising followed by a big '
    + 'one somewhere else. 1 holds it perfectly still. It withholds the force '
    + 'rather than pushing back, so nothing here can drive it downward.');
  knob('cavitySize', 'cavity size', 0.5, 4, 0.05,
    'How big the cavity is BORN. The pocket used to be injected small and left '
    + 'to spread into an engulfing bubble, which is slow; opening it at size '
    + 'costs nothing and lets the hold come back down.');
  knob('cavityHold', 'cavity hold', 0.2, 4, 0.05,
    'How long the cavity sits there before the rebound throws the plume. '
    + 'Stretches the pocket and both crush phases together.');
  action('Detonate at mid depth', () => hooks.blast?.(),
    'Set one off immediately, without waiting for a barrel to sink to its mark.');

  head('Meshes in the Light');
  knob('meshShadow', 'shadow strength', 0, 10, 0.1,
    'How hard a solid mesh blocks the light. 0 lets the light march straight '
    + 'through a barrel as if it were water. It is an exponent, so past 1 the '
    + 'core of the shadow is already black and what keeps darkening is the '
    + 'penumbra around it — which is what makes the blocked shaft read.', 1);
  knob('shadowSoft', 'shadow softness', 1.05, 5, 0.05,
    'How far the penumbra spreads, as a multiple of each proxy sphere\'s '
    + 'radius. Low is a hard cut, high is a broad smudge.');

  knob('lightLift', 'mesh light offset', 0.02, 0.6, 0.01,
    'How far back up the beam a mesh looks when it reads the light. It has to '
    + 'clear its own shadow — it puts an occluder into that same volume — or it '
    + 'goes flat dark; too far and it is lit by water well above it.');

  head('The Surface');
  knob('skyGain', 'sky through window', 0, 1.6, 0.02,
    'How much sky comes through Snell\'s window — the cone about 97 degrees '
    + 'wide straight overhead that everything above the waterline is squeezed '
    + 'into. 0 is the flat dark room this used to be, which is why the surface '
    + 'read as a lid: nothing was bright anywhere, so there was no contrast to '
    + 'read the water by.');

  head('Framing');
  knob('fitWidth', 'frame width', 0.55, 1.6, 0.01,
    'How much of the tank\'s width the window spans. 1 puts the side walls '
    + 'exactly at the frame\'s edges; below 1 pushes them out of shot, above 1 '
    + 'pulls them inside it. Takes effect on the next resize or on Refit.');
  action('Refit view', () => hooks.refit?.(),
    'Re-frame the tank now, using the width above.');

  head('The Fish');
  knob('cross', 'crossing time', 6, 60, 0.5,
    'Seconds from first appearing to gone, end to end.', 1);
  knob('beat', 'tail beat', 0.5, 9, 0.05,
    'Radians a second. This is the whole animal\'s clock: the body\'s sway, '
    + 'yaw and roll all come off it, so raising it speeds up everything at once.');
  knob('tailAmp', 'tail amplitude', 0, 3, 0.02,
    'Multiplier on how far each tail joint swings. The per-joint amounts still '
    + 'grow toward the tip; this scales all four together.');
  knob('lag', 'phase lag', 0, 2.5, 0.02,
    'Radians each joint trails the one ahead of it. This is what makes the bend '
    + 'travel backwards down the body instead of the tail wagging as one piece. '
    + 'At 0 it is a metronome.');
  knob('reach', 'swims out to', 0.9, 3, 0.02,
    'How far behind the tank it goes, in tank halves, before turning around. '
    + 'Past about 1.1 it is fully dissolved before it turns.');
  knob('fadeStart', 'fade starts at', 0.2, 1.5, 0.02,
    'Depth at which it begins to dissolve, in tank halves. Smaller means it '
    + 'starts fading closer to the camera.');
  knob('fadeSpan', 'fade over', 0.1, 1.5, 0.02,
    'How much further, in tank halves, until it is completely gone.');
  const scrub = slider(panel, {
    label: 'scrub', min: 0, max: 1, step: 0.005, value: 0,
    desc: 'Drag the fish through its whole crossing by hand. This is the fast '
        + 'way to judge the fade: 0 and 1 are the far ends, 0.5 is closest.',
    format: (v) => v.toFixed(3),
    oninput: (v) => hooks.scrub?.(v),
  });
  action('Summon fish', () => { hooks.summon?.(); scrub.value = 0; },
    'Bring it out now rather than waiting for it to wander in.');

  const copy = action('Copy Tuning', async () => {
    const txt = JSON.stringify(TUNE, null, 2);
    try { await navigator.clipboard.writeText(txt); copy.textContent = 'Copied'; }
    catch { copy.textContent = 'Copy failed'; }
    setTimeout(() => { copy.textContent = 'Copy Tuning'; }, 1400);
  }, 'Copy every value above, ready to paste back so they can be folded into the code.');

  btn.addEventListener('click', () => {
    const open = panel.hasAttribute('hidden');
    panel.toggleAttribute('hidden', !open);
    btn.classList.toggle('active', open);
    btn.setAttribute('aria-expanded', String(open));
  });
}

export function buildScenePanel({
  gridN, particleCount, tankHalf, onTank, paddleScale, onPaddleScale,
}) {
  const panel = document.getElementById('scene');
  const btn = document.getElementById('scene-btn');
  if (!panel || !btn) return;
  panel.textContent = '';

  const gi = GRID_SIZES.indexOf(gridN);
  slider(panel, {
    label: 'grid', min: 0, max: GRID_SIZES.length - 1, step: 1,
    value: gi < 0 ? GRID_SIZES.length - 1 : gi,
    desc: 'Simulation resolution: how many voxels the solver runs on, and the '
        + 'memory that costs. Higher resolves finer filaments and wisps but is '
        + 'much more work per frame — the cost goes as the cube of this.',
    format: (i) => `${GRID_SIZES[i]}³ · ${gridMiB(GRID_SIZES[i])} MiB`,
    onchange: (i) => reloadWith('n', GRID_SIZES[i]),
  });

  slider(panel, {
    label: 'particles', min: 5, max: 300, step: 5, value: Math.round(particleCount / 1000),
    desc: 'How many bubble sprites are simulated. They are decoration on top '
        + 'of the volumetric foam — they sparkle on the shell of the plumes and '
        + 'do not affect the fluid itself.',
    format: (k) => `${k} K`,
    onchange: (k) => reloadWith('p', k * 1000),
  });

  slider(panel, {
    label: 'tank size', min: 0.35, max: 1, step: 0.01, value: tankHalf,
    desc: 'Size of the glass tank the water sits in. The grid stays the same, '
        + 'so a smaller tank means the same detail packed into less water, and '
        + 'the walls are closer for plumes to spread against.',
    format: (v) => `${(v * 100).toFixed(0)}%`,
    oninput: onTank,
  });

  slider(panel, {
    label: 'paddle size', min: 0.25, max: 3, step: 0.05, value: paddleScale,
    desc: 'Size of the stirring paddle. A bigger blade sweeps more water and '
        + 'aerates more per pass.',
    format: (v) => `${v.toFixed(2)}×`,
    oninput: onPaddleScale,
  });

  const note = document.createElement('div');
  note.className = 'panel-note';
  note.textContent = 'grid and particles reallocate GPU memory, so they reload the page';
  panel.append(note);

  btn.addEventListener('click', () => {
    const open = panel.hasAttribute('hidden');
    panel.toggleAttribute('hidden', !open);
    btn.classList.toggle('active', open);
    btn.setAttribute('aria-expanded', String(open));
  });
}

// Bubble diffuser on the tank floor: an always-on source, as opposed to the
// paddle (which aerates only what it sweeps) and barrels (one-shot). Every
// control is live — the solver reads the object each step, so mutating it in
// place is all that is needed.
export function buildEmitterPanel(emitter) {
  const panel = document.getElementById('emitter');
  const btn = document.getElementById('emitter-btn');
  if (!panel || !btn) return;
  panel.textContent = '';

  // On/off lives up top with the other actions, not buried in here — running
  // the diffuser is a thing you do, tuning it is a thing you set.
  const toggle = document.getElementById('bubbles-btn');
  if (toggle) {
    const sync = () => {
      toggle.classList.toggle('active', emitter.on);
      toggle.setAttribute('aria-pressed', String(emitter.on));
    };
    toggle.addEventListener('click', () => { emitter.on = !emitter.on; sync(); });
    sync();
  }

  slider(panel, {
    label: 'bubble rate', min: 0, max: 8, step: 0.1, value: emitter.rate,
    desc: 'How much air the diffuser puts out per second. This is what the '
        + 'plume is made of; buoyancy over in physics decides how hard it rises.',
    format: (v) => v.toFixed(1),
    oninput: (v) => { emitter.rate = v; },
  });

  slider(panel, {
    label: 'bubble size', min: 0.3, max: 3, step: 0.05, value: emitter.size,
    desc: 'How coarsely the stream breaks up. The solver has no individual '
        + 'bubbles — foam is a density — so this is the scale it breaks into: '
        + 'low gives a fine mist of small bubbles, high gives fat lazy ones.',
    format: (v) => `${v.toFixed(2)}×`,
    oninput: (v) => { emitter.size = v; },
  });

  slider(panel, {
    label: 'nozzle width', min: 0.04, max: 0.6, step: 0.01, value: emitter.radius,
    desc: 'How wide the mouth is. Narrow gives a single rope of bubbles that '
        + 'wanders; wide gives a broad curtain that breaks up as it climbs.',
    format: (v) => v.toFixed(2),
    oninput: (v) => { emitter.radius = v; },
  });

  slider(panel, {
    label: 'jet', min: 0, max: 4, step: 0.05, value: emitter.jet,
    desc: 'Upward push at the nozzle itself, on top of what buoyancy does to '
        + 'the bubbles. Turn it up for a pressurised jet with a stem, down for '
        + 'a lazy column that only rises because it is lighter than water.',
    format: (v) => v.toFixed(2),
    oninput: (v) => { emitter.jet = v; },
  });

  for (const axis of ['x', 'z']) {
    const key = axis === 'x' ? 'fx' : 'fz';
    slider(panel, {
      label: `position ${axis}`, min: -0.9, max: 0.9, step: 0.01, value: emitter[key],
      desc: `Where the diffuser sits on the floor along ${axis}, as a fraction `
          + 'of the way to the wall — so it keeps its place if the tank is resized.',
      format: (v) => v.toFixed(2),
      oninput: (v) => { emitter[key] = v; },
    });
  }

  btn.addEventListener('click', () => {
    const open = panel.hasAttribute('hidden');
    panel.toggleAttribute('hidden', !open);
    btn.classList.toggle('active', open);
    btn.setAttribute('aria-expanded', String(open));
  });
}

// Shared query-parameter parsing for the two allocation knobs.
export function gridOverride(query, dflt) {
  const n = Math.round(+query.get('n'));
  return Number.isFinite(n) && n >= 32 && n <= 160 ? n : dflt;
}

export function particleOverride(query, dflt) {
  const p = Math.round(+query.get('p'));
  return Number.isFinite(p) && p >= 1000 && p <= 400000 ? p : dflt;
}

// Tank half-extent inside the simulation cube. 1 fills the grid; smaller leaves
// a solid margin, which is what makes the tank look smaller.
export function tankOverride(query, dflt) {
  const t = +query.get('tank');
  return Number.isFinite(t) && t >= 0.35 && t <= 1 ? t : dflt;
}

// ---------------------------------------------------------------------------
// "get the code": the three.js that reproduces exactly what is on screen. Read
// live from the running objects, so it always matches the sliders as they are
// now rather than whatever they were at load.

function codeFor({ backend, N, jacobi, particleCount, tankHalf, paddleScale, physics }) {
  const webgpu = backend === 'WebGPU';
  const knobs = PHYSICS_KNOBS
    .map((k) => `  ${k.key}: ${(+physics[k.key]).toFixed(3).replace(/\.?0+$/, '')},`)
    .join('\n');
  const q = new URLSearchParams(location.search);
  q.set('n', N); q.set('p', particleCount); q.set('tank', tankHalf.toFixed(2));
  if (webgpu) q.set('gpu', '1');
  return `// Churn — the settings currently on screen.
// Backend: ${backend}.  Same scene as ${location.origin}${location.pathname}?${q}

import * as THREE from '${webgpu ? 'three/webgpu' : 'three'}';
import { ${webgpu ? 'Fluid3D' : 'Fluid'} } from './src/${webgpu ? 'gpu/fluid3d.js' : 'fluid.js'}';

// direction the sunlight travels
const lightDir = new THREE.Vector3(0.30, -1.0, -0.35).normalize();

const fluid = new ${webgpu ? 'Fluid3D' : 'Fluid'}(renderer, {
  N: ${`${N},`.padEnd(7)}// ${N}³ voxels — cost scales with the cube of this
  jacobi: ${`${jacobi},`.padEnd(2)}   // pressure-solve iterations
  lightDir,
  surfaceY: ${(0.72 * tankHalf).toFixed(3)},   // waterline, 72% of the tank height
  tank: ${tankHalf.toFixed(2)},         // tank half-extent inside the grid
});
fluid.clear();

// Every knob below is live: the next step() picks it up.
Object.assign(fluid.physics, {
${knobs}
});

// Paddle: half-extents, so this blade is ${(0.60 * paddleScale).toFixed(2)} × ${(0.10 * paddleScale).toFixed(2)} × ${(0.40 * paddleScale).toFixed(2)}.
const paddleHalf = new THREE.Vector3(${(0.30 * paddleScale).toFixed(3)}, ${(0.05 * paddleScale).toFixed(3)}, ${(0.20 * paddleScale).toFixed(3)});
fluid.paddle = {
  on: true,
  pos: paddle.position,      // world position
  vel: paddleVel,            // world units/s
  angVel: paddleAngVel,      // rad/s, world axes
  half: paddleHalf,
  rot: rotMat3,              // world -> paddle local
};

// Barrels in flight, as spheres. Push one per barrel each frame.
fluid.barrels = [{ pos, vel, radius: 0.16 }];

// A one-shot explosion, consumed by the next step().
fluid.burst = {
  pos: new THREE.Vector3(0, -0.4, 0),
  vel: 3.2 * ${(+physics.blast).toFixed(2)},        // outward impulse  (blast power)
  up: 1.2 * ${(+physics.blast).toFixed(2)},
  foam: 0.42 * ${(+physics.blast).toFixed(2)},
  radius: 0.36,
  ring: 2.6 * ${(+physics.ring).toFixed(2)} * ${(+physics.blast).toFixed(2)},   // circulation: this is what mushrooms the cap
  ringR: 0.28,
};

// ${particleCount.toLocaleString()} bubble sprites, advected by the velocity field.
// Per frame:
fluid.step(dt, time);
`;
}

export function buildCodePanel(getState) {
  const panel = document.getElementById('code');
  const btn = document.getElementById('code-btn');
  const pre = document.getElementById('code-text');
  const copy = document.getElementById('code-copy');
  if (!panel || !btn || !pre || !copy) return;

  btn.addEventListener('click', () => {
    const open = panel.hasAttribute('hidden');
    if (open) pre.textContent = codeFor(getState());   // regenerate on every open
    panel.toggleAttribute('hidden', !open);
    btn.classList.toggle('active', open);
    btn.setAttribute('aria-expanded', String(open));
  });

  copy.addEventListener('click', async () => {
    let ok = false;
    try {
      await navigator.clipboard.writeText(pre.textContent);
      ok = true;
    } catch {
      // clipboard is often blocked in a sandboxed frame; select it instead so
      // the usual copy shortcut still works
      const r = document.createRange();
      r.selectNodeContents(pre);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    }
    copy.textContent = ok ? 'copied' : 'selected — press ⌘/Ctrl+C';
    copy.classList.add('done');
    setTimeout(() => { copy.textContent = 'copy'; copy.classList.remove('done'); }, 2200);
  });
}
