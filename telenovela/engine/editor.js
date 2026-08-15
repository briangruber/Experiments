// The editing room. Loaded only with ?edit, so the shipped page never pays for
// it, and it drives the SAME world the film renders — what you frame here is
// what the render makes, because it is the same solver, the same actors and
// the same lens.
//
// The piece is written as code: scenes are modules with a setup() and a list of
// timed cues. That is a good way to keep an episode diffable and a bad way to
// find out where a camera should stand, which is a thing you do by looking. So
// this does not replace the script — it is a viewfinder for it. You scrub to a
// beat, drag the actors and the camera until the frame is right, and it hands
// back the exact line of source that reproduces what you are looking at.
//
//   Scrub          pick a scene, drag the timeline, or step a frame at a time
//   Shot           edit the live shot — framing, lens, angle, height, roll
//   Blocking       drag actors and the camera on the plan; drag to set facing
//   Fly            detach the lens, find an angle by eye, then Use as shot,
//                  which solves back to the angle/height a cue can be written in
//   Copy           the cue for the current state, ready to paste into the scene

import * as THREE from '../vendor/three/three.module.min.js';
import { deg, clamp } from './util.js';

const FRAMES = ['ews', 'ws', 'mls', 'ms', 'mcu', 'cu', 'bcu', 'ecu'];
const LENSES = [24, 28, 35, 40, 50, 65, 85, 100, 135];
const HEIGHTS = ['floor', 'low', 'eye', 'over', 'high'];

// The plan view's world window, matched to the courtyard's walls.
const PLAN = { minX: -4.6, maxX: 4.6, minZ: -4.6, maxZ: 4.0 };

const fmt = (n, d = 2) => Number(n.toFixed(d));

export function attachEditor(T) {
  const { dir, cam, actors, camera } = T;
  const state = { paused: true, seeking: false, fly: false, sel: null, drag: null };

  // --- chrome ---------------------------------------------------------------
  const root = document.createElement('div');
  root.id = 'editor';
  root.innerHTML = `
    <div class="ed-bar">
      <select class="ed-scene"></select>
      <button class="ed-play" title="Space">▶</button>
      <button class="ed-step" title="One frame">›</button>
      <input class="ed-time" type="range" min="0" max="1" step="0.001" value="0">
      <span class="ed-t">0.0s</span>
      <span class="ed-shot"></span>
      <button class="ed-fly">Fly</button>
      <button class="ed-copy">Copy cue</button>
    </div>
    <div class="ed-side">
      <canvas class="ed-plan" width="300" height="300"></canvas>
      <div class="ed-hint">drag a dot to move · drag outside it to turn</div>
      <div class="ed-rows"></div>
      <pre class="ed-out"></pre>
    </div>`;
  document.body.appendChild(root);

  const $ = (s) => root.querySelector(s);
  const sceneSel = $('.ed-scene'), playBtn = $('.ed-play'), stepBtn = $('.ed-step');
  const timeEl = $('.ed-time'), tLabel = $('.ed-t'), shotLabel = $('.ed-shot');
  const flyBtn = $('.ed-fly'), copyBtn = $('.ed-copy');
  const plan = $('.ed-plan'), rows = $('.ed-rows'), out = $('.ed-out');
  const g = plan.getContext('2d');

  for (const id of T.episode.order) {
    const o = document.createElement('option');
    o.value = id; o.textContent = id;
    sceneSel.appendChild(o);
  }

  // --- driving the world ----------------------------------------------------
  // The film's own loop keeps running; pausing is just holding the clock still,
  // so every system (weather, springs, the soundtrack's ducking) stays alive
  // and the frame you judge is a real frame rather than a frozen one.
  const origUpdate = dir.update.bind(dir);
  // Pausing holds the clock still for the render loop only. Seeking drives the
  // very same update() to walk the scene forward, so it has to be let through
  // or the scrubber cannot move — which is exactly what happened the first
  // time this was tried.
  dir.update = (dt) => ((state.paused && !state.seeking) ? origUpdate(0) : origUpdate(dt));

  function sceneDur() { return dir.scene ? dir.scene.dur : 1; }
  function seek(t) {
    state.seeking = true;
    try { T.goTo(sceneSel.value, clamp(t, 0, sceneDur() - 0.001)); } finally { state.seeking = false; }
    state.paused = true;
    playBtn.textContent = '▶';
    refresh();
  }

  sceneSel.onchange = () => seek(0);
  timeEl.oninput = () => seek(+timeEl.value * sceneDur());
  playBtn.onclick = () => {
    state.paused = !state.paused;
    playBtn.textContent = state.paused ? '▶' : '❚❚';
  };
  stepBtn.onclick = () => {
    state.paused = true;
    state.seeking = true;
    origUpdate(1 / 30);
    state.seeking = false;
    refresh();
  };

  // --- fly mode -------------------------------------------------------------
  // Orbit the lens by hand to find an angle, then solve back to the numbers a
  // cue is written in: the azimuth becomes an `angle` relative to the subject's
  // own facing, and the elevation becomes a `height` in metres.
  const fly = { az: 0, el: 0.25, dist: 3, tgt: new THREE.Vector3(0, 0.5, 0) };
  flyBtn.onclick = () => {
    state.fly = !state.fly;
    flyBtn.classList.toggle('on', state.fly);
    if (state.fly) {
      fly.tgt.copy(cam.aim);
      const d = camera.position.clone().sub(cam.aim);
      fly.dist = d.length();
      fly.az = Math.atan2(d.x, d.z);
      fly.el = Math.asin(clamp(d.y / (fly.dist || 1), -1, 1));
    }
    refresh();
  };

  function applyFly() {
    const p = new THREE.Vector3(
      Math.sin(fly.az) * Math.cos(fly.el),
      Math.sin(fly.el),
      Math.cos(fly.az) * Math.cos(fly.el),
    ).multiplyScalar(fly.dist).add(fly.tgt);
    camera.position.copy(p);
    camera.up.set(0, 1, 0);
    camera.lookAt(fly.tgt);
  }

  addEventListener('wheel', (e) => {
    if (!state.fly) return;
    fly.dist = clamp(fly.dist * (1 + Math.sign(e.deltaY) * 0.08), 0.35, 16);
    e.preventDefault();
  }, { passive: false });

  let look = null;
  addEventListener('pointerdown', (e) => {
    if (state.fly && e.target === document.querySelector('canvas')) look = { x: e.clientX, y: e.clientY };
  });
  addEventListener('pointerup', () => { look = null; });
  addEventListener('pointermove', (e) => {
    if (!look) return;
    fly.az -= (e.clientX - look.x) * 0.005;
    fly.el = clamp(fly.el + (e.clientY - look.y) * 0.004, -0.4, 1.35);
    look = { x: e.clientX, y: e.clientY };
  });

  // --- the plan -------------------------------------------------------------
  const toPlan = (x, z) => [
    ((x - PLAN.minX) / (PLAN.maxX - PLAN.minX)) * plan.width,
    ((z - PLAN.minZ) / (PLAN.maxZ - PLAN.minZ)) * plan.height,
  ];
  const fromPlan = (px, pz) => [
    PLAN.minX + (px / plan.width) * (PLAN.maxX - PLAN.minX),
    PLAN.minZ + (pz / plan.height) * (PLAN.maxZ - PLAN.minZ),
  ];

  function drawPlan() {
    g.clearRect(0, 0, plan.width, plan.height);
    g.fillStyle = '#15161c'; g.fillRect(0, 0, plan.width, plan.height);
    // The walls the solver will not put a camera outside of.
    const b = cam.bounds;
    const [x0, z0] = toPlan(b.minX, b.minZ), [x1, z1] = toPlan(b.maxX, b.maxZ);
    g.strokeStyle = '#39404f'; g.lineWidth = 1;
    g.strokeRect(x0, z0, x1 - x0, z1 - z0);
    // Anything it must not stand in.
    g.fillStyle = 'rgba(120,90,60,0.20)';
    for (const o of cam.obstacles || []) {
      const [px, pz] = toPlan(o.x, o.z);
      const r = (o.r / (PLAN.maxX - PLAN.minX)) * plan.width;
      g.beginPath(); g.arc(px, pz, r, 0, Math.PI * 2); g.fill();
    }
    // The lens, and where it is pointed.
    const [cx, cz] = toPlan(camera.position.x, camera.position.z);
    const [ax, az2] = toPlan(cam.aim.x, cam.aim.z);
    g.strokeStyle = '#e8c56a'; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(cx, cz); g.lineTo(ax, az2); g.stroke();
    g.fillStyle = '#e8c56a';
    g.beginPath(); g.arc(cx, cz, 5, 0, Math.PI * 2); g.fill();

    for (const k in actors) {
      const a = actors[k];
      if (!a.pos) continue;
      const [px, pz] = toPlan(a.pos.x, a.pos.z);
      const on = a.rig?.root?.visible !== false;
      g.globalAlpha = on ? 1 : 0.3;
      g.fillStyle = state.sel === k ? '#ff7f6b' : '#8fd0ff';
      g.beginPath(); g.arc(px, pz, 6, 0, Math.PI * 2); g.fill();
      // Facing, so blocking reads at a glance.
      g.strokeStyle = g.fillStyle; g.lineWidth = 2;
      g.beginPath(); g.moveTo(px, pz);
      g.lineTo(px + Math.sin(a.yaw) * 14, pz + Math.cos(a.yaw) * 14);
      g.stroke();
      g.globalAlpha = 1;
      g.fillStyle = '#c9d2e2'; g.font = '10px ui-sans-serif, sans-serif';
      g.fillText(k, px + 9, pz - 7);
    }
  }

  plan.onpointerdown = (e) => {
    const r = plan.getBoundingClientRect();
    const px = (e.clientX - r.left) * (plan.width / r.width);
    const pz = (e.clientY - r.top) * (plan.height / r.height);
    let best = null, bestD = 1e9;
    for (const k in actors) {
      const a = actors[k];
      if (!a.pos) continue;
      const [ax2, az3] = toPlan(a.pos.x, a.pos.z);
      const d = Math.hypot(ax2 - px, az3 - pz);
      if (d < bestD) { bestD = d; best = k; }
    }
    const [cx, cz] = toPlan(camera.position.x, camera.position.z);
    const camD = Math.hypot(cx - px, cz - pz);
    if (camD < bestD && camD < 22) {
      state.sel = '(camera)';
      state.drag = { kind: 'cam' };
    } else if (best) {
      state.sel = best;
      // Inside the dot moves; outside it turns — one gesture for both, which
      // is how blocking actually gets adjusted.
      state.drag = { kind: bestD < 12 ? 'move' : 'turn', key: best };
    }
    plan.setPointerCapture(e.pointerId);
    refresh();
  };
  plan.onpointermove = (e) => {
    if (!state.drag) return;
    const r = plan.getBoundingClientRect();
    const [wx, wz] = fromPlan((e.clientX - r.left) * (plan.width / r.width),
      (e.clientY - r.top) * (plan.height / r.height));
    if (state.drag.kind === 'cam') {
      if (!state.fly) { state.fly = true; flyBtn.classList.add('on'); fly.tgt.copy(cam.aim); }
      const d = new THREE.Vector3(wx - fly.tgt.x, camera.position.y - fly.tgt.y, wz - fly.tgt.z);
      fly.dist = Math.max(0.35, d.length());
      fly.az = Math.atan2(d.x, d.z);
    } else {
      const a = actors[state.drag.key];
      if (state.drag.kind === 'move') a.place(wx, wz, a.yaw);
      else a.place(a.pos.x, a.pos.z, Math.atan2(wx - a.pos.x, wz - a.pos.z));
    }
    refresh();
  };
  plan.onpointerup = () => { state.drag = null; };

  // --- the shot inspector ---------------------------------------------------
  function row(label, node) {
    const d = document.createElement('div');
    d.className = 'ed-row';
    const l = document.createElement('label');
    l.textContent = label;
    d.append(l, node);
    return d;
  }
  function select(opts, value, onChange) {
    const s = document.createElement('select');
    for (const o of opts) {
      const e = document.createElement('option');
      e.value = String(o); e.textContent = String(o);
      s.appendChild(e);
    }
    s.value = String(value);
    s.onchange = () => onChange(s.value);
    return s;
  }
  function slider(min, max, step, value, onChange) {
    const wrap = document.createElement('div');
    wrap.className = 'ed-slide';
    const s = document.createElement('input');
    s.type = 'range'; s.min = min; s.max = max; s.step = step; s.value = value;
    const v = document.createElement('span');
    v.textContent = fmt(value);
    s.oninput = () => { v.textContent = fmt(+s.value); onChange(+s.value); };
    wrap.append(s, v);
    return wrap;
  }

  // Editing the live shot means writing onto cam.shot and re-solving. It is the
  // real spec object the solver reads every frame, so the picture answers on
  // the same frame — which is the entire point of doing this by eye.
  function apply(patch) {
    if (!cam.shot) return;
    Object.assign(cam.shot, patch);
    cam._hold = null;
    cam.solve(0, true);
    refresh();
  }

  function buildRows() {
    rows.textContent = '';
    const s = cam.shot;
    if (!s) return;
    rows.append(
      row('framing', select(FRAMES, s.frame, (v) => apply({ frame: v }))),
      row('lens', select(LENSES, s.lens, (v) => apply({ lens: +v }))),
      row('angle', slider(-180, 180, 1, s.angle, (v) => apply({ angle: v }))),
      row('height', typeof s.height === 'number'
        ? slider(0.05, 2.8, 0.01, s.height, (v) => apply({ height: v }))
        : select(HEIGHTS, s.height, (v) => apply({ height: v }))),
      row('roll', slider(-25, 25, 0.5, s.dutch, (v) => apply({ dutch: v }))),
      row('handheld', slider(0, 1, 0.05, s.handheld, (v) => apply({ handheld: v }))),
    );
    const toggles = document.createElement('div');
    toggles.className = 'ed-row';
    for (const [key, label] of [['compose', 'compose'], ['hold', 'hold'], ['strictAngle', 'strict']]) {
      const b = document.createElement('button');
      b.textContent = label;
      b.className = s[key] ? 'on' : '';
      b.onclick = () => apply({ [key]: !cam.shot[key] });
      toggles.appendChild(b);
    }
    rows.appendChild(toggles);
    // Height is either a keyword or a number; let it become one.
    const swap = document.createElement('button');
    swap.textContent = typeof s.height === 'number' ? 'height → keyword' : 'height → metres';
    swap.onclick = () => apply({ height: typeof cam.shot.height === 'number' ? 'eye' : camera.position.y });
    rows.appendChild(swap);
  }

  // --- emitting source ------------------------------------------------------
  // What comes out has to be a cue you can paste, which means resolving the
  // hand-flown lens back into the terms the script speaks: an angle measured
  // off the subject's own facing, and a height in metres.
  function subjectKey() {
    const s = cam.shot;
    if (!s || !s.subject) return null;
    for (const k in actors) if (actors[k] === s.subject) return k;
    return null;
  }
  function cueText() {
    const s = cam.shot;
    if (!s) return '// no shot';
    const key = subjectKey();
    let angle = s.angle, height = s.height;
    if (state.fly) {
      const sub = s.subject;
      const yaw = sub && sub.yaw !== undefined ? sub.yaw : 0;
      const d = camera.position.clone().sub(cam.aim);
      angle = Math.round(((Math.atan2(d.x, d.z) - yaw) * 180 / Math.PI + 540) % 360 - 180);
      height = fmt(camera.position.y);
    }
    const parts = [
      key ? `subject: ${key}` : (s.subject ? 'subject: /* prop or point */' : null),
      `frame: '${s.frame}'`,
      `lens: ${s.lens}`,
      `angle: ${fmt(angle, 0)}`,
      typeof height === 'number' ? `height: ${fmt(height)}` : `height: '${height}'`,
      s.dutch ? `dutch: ${fmt(s.dutch)}` : null,
      `dur: ${fmt(s.dur, 1)}`,
      `handheld: ${fmt(s.handheld)}`,
      s.strictAngle ? 'strictAngle: true' : null,
      s.compose === false ? 'compose: false' : null,
      s.hold === false ? 'hold: false' : null,
      s.label ? `label: '${s.label}'` : null,
    ].filter(Boolean);

    const blocking = [];
    for (const k in actors) {
      const a = actors[k];
      if (!a.pos || a.rig?.root?.visible === false) continue;
      blocking.push(`${k}.place(${fmt(a.pos.x)}, ${fmt(a.pos.z)}, deg(${Math.round(a.yaw * 180 / Math.PI)}));`);
    }
    return `// ${sceneSel.value} @ ${fmt(dir.t, 1)}s\n`
      + `c.cam.cut({\n  ${parts.join(', ')},\n});\n`
      + (blocking.length ? `\n${blocking.join('\n')}\n` : '');
  }

  copyBtn.onclick = async () => {
    const text = cueText();
    try { await navigator.clipboard.writeText(text); copyBtn.textContent = 'Copied'; } catch { copyBtn.textContent = 'Select it'; }
    setTimeout(() => { copyBtn.textContent = 'Copy cue'; }, 1200);
  };

  addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.code === 'Space') { playBtn.click(); e.preventDefault(); }
    if (e.code === 'Period') stepBtn.click();
    if (e.code === 'KeyF') flyBtn.click();
  });

  // --- per-frame ------------------------------------------------------------
  function refresh() {
    const dur = sceneDur();
    timeEl.value = String(clamp(dir.t / dur, 0, 1));
    tLabel.textContent = `${dir.t.toFixed(1)} / ${dur}s`;
    shotLabel.textContent = cam.label || '';
    buildRows();
    out.textContent = cueText();
    drawPlan();
  }

  // The plan and the readouts follow the film while it plays; the inspector is
  // only rebuilt on a real change, or typing into it would fight the clock.
  let acc = 0;
  function tick(dt) {
    if (state.fly) applyFly();
    acc += dt;
    if (acc > 0.1) {
      acc = 0;
      const dur = sceneDur();
      timeEl.value = String(clamp(dir.t / dur, 0, 1));
      tLabel.textContent = `${dir.t.toFixed(1)} / ${dur}s`;
      shotLabel.textContent = cam.label || '';
      drawPlan();
    }
  }

  sceneSel.value = T.episode.order[0];
  refresh();
  return { tick, get flying() { return state.fly; } };
}
