// The physics panel, shared by both backends: a slider per knob, each writing
// straight into the solver's `physics` object, which the next step reads.

export const PHYSICS_KNOBS = [
  { key: 'rise', label: 'bubble rise', min: 0, max: 1.5, step: 0.01,
    desc: 'How fast bubbles slip upward THROUGH the water. This is the whole '
        + 'difference between bubbles and smoke: the foam is carried by the '
        + 'flow plus this rise, rather than by the flow alone. At 0 the foam '
        + 'drifts like smoke.' },
  { key: 'buoyancy', label: 'buoyancy', min: 0, max: 10, step: 0.05,
    desc: 'How hard aerated water lifts the fluid around it. This is what '
        + 'drives a plume upward and makes it billow — the single biggest '
        + 'knob on how violent the tank looks.' },
  { key: 'foamLife', label: 'bubble life', min: 0.5, max: 20, step: 0.5, unit: 's',
    desc: 'How long bubbles last before fading, as an e-folding time. Bubbles '
        + 'mostly leave by popping at the surface rather than by decaying, so '
        + 'this can be set long without the tank filling up.' },
  { key: 'aeration', label: 'aeration', min: 0, max: 4, step: 0.05,
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
  { key: 'ring', label: 'vortex ring', min: 0, max: 3, step: 0.05,
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

export function buildPhysicsPanel(physics) {
  const panel = document.getElementById('physics');
  const btn = document.getElementById('physics-btn');
  panel.textContent = '';
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
export function armBurst(b, physics) {
  return {
    pos: b.pos,
    vel: (b.vel ?? 0) * physics.blast,
    up: (b.up ?? 0) * physics.blast,
    foam: (b.foam ?? 0) * physics.blast,
    radius: b.radius,
    ring: (b.ring ?? 0) * physics.ring * physics.blast,
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
