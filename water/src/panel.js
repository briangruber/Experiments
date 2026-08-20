// The physics panel, shared by both backends: a slider per knob, each writing
// straight into the solver's `physics` object, which the next step reads.

export const PHYSICS_KNOBS = [
  { key: 'rise', label: 'bubble rise', min: 0, max: 1.5, step: 0.01 },
  { key: 'buoyancy', label: 'buoyancy', min: 0, max: 2.0, step: 0.01 },
  { key: 'foamLife', label: 'bubble life', min: 0.5, max: 20, step: 0.5, unit: 's' },
  { key: 'aeration', label: 'aeration', min: 0, max: 4, step: 0.05 },
  { key: 'swirl', label: 'swirl', min: 0, max: 0.3, step: 0.005 },
  { key: 'drag', label: 'water drag', min: 0, max: 1.5, step: 0.01 },
  { key: 'blast', label: 'blast power', min: 0, max: 3, step: 0.05 },
  { key: 'ring', label: 'vortex ring', min: 0, max: 3, step: 0.05 },
  { key: 'caustics', label: 'caustics', min: 0, max: 2.5, step: 0.05 },
  { key: 'chop', label: 'surface chop', min: 0, max: 3, step: 0.05 },
];

export function buildPhysicsPanel(physics) {
  const panel = document.getElementById('physics');
  const btn = document.getElementById('physics-btn');
  panel.textContent = '';
  for (const k of PHYSICS_KNOBS) {
    const label = document.createElement('label');
    label.className = 'slider';
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
