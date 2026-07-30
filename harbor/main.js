// Salty Fin Bay - wiring. Owns input, the chase camera, the per-frame draw
// list and the small amount of glue between the game state and the HUD.

import { getContext } from '../src/gl.js';
import { mat4, mul, v3, clamp, lerp } from '../src/math.js';
import { Renderer } from './render.js';
import { buildWorld, bedHeight } from './world.js';
import {
  buildBoat, buildAngler, buildRod, buildBobber, buildFish, buildGull, buildGullWing,
  Boat, SPECIES, trs,
} from './boat.js';
import { Fishing, Particles, Gull, makeShoals, ST, HOLD_LIMIT, GOAL } from './game.js';
import { Hud } from './ui.js';

const qs = new URLSearchParams(location.search);
const canvas = document.getElementById('gl');
const gl = getContext(canvas);
const renderer = new Renderer(gl, canvas);

const world = buildWorld(gl);
const meshes = {
  boat: buildBoat(gl),
  angler: buildAngler(gl),
  rod: buildRod(gl),
  bobber: buildBobber(gl),
  gull: buildGull(gl),
  wingL: buildGullWing(gl, -1),
  wingR: buildGullWing(gl, 1),
  fish: SPECIES.map((sp) => buildFish(gl, sp)),
};
const fishMeshOf = new Map(SPECIES.map((sp, i) => [sp.name, meshes.fish[i].mesh]));

const IDENTITY = mat4();
const fx = new Particles();
const fishing = new Fishing(fx);
const boat = new Boat(-26, 14, 1.35);
const shoals = makeShoals(world, 9);
const hud = new Hud();

const gulls = [
  new Gull(-38, 6, 16, 9.5, 3.4, 0.1),
  new Gull(-30, -22, 22, 12.0, 3.0, 0.5),
  new Gull(90, -70, 26, 15.0, 3.6, 0.8),
  new Gull(20, 30, 30, 11.0, 2.8, 0.3),
];
// two gulls sitting on the quay, because the reference has one and it is the
// single detail that makes the dock feel inhabited
const perched = [
  { m: trs([world.quayX + 0.55, 3.0, -1.2], 2.1), wing: 0 },
  { m: trs([world.quayX - 2.6, 3.15, 12.4], -0.7), wing: 0 },
];

// ---------------------------------------------------------------- input
const keys = new Set();
const input = { forward: 0, turn: 0, boost: false, reel: false, action: false };
let orbitYaw = 0, orbitPitch = 0, dragging = false, lastPt = null, uiHidden = false;

addEventListener('keydown', (e) => {
  if (e.repeat) return;
  keys.add(e.code);
  if (e.code === 'Space') { input.action = true; e.preventDefault(); }
  if (e.code === 'KeyH') { uiHidden = !uiHidden; document.body.classList.toggle('hide-ui', uiHidden); }
  startGame();
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());

canvas.addEventListener('pointerdown', (e) => {
  dragging = true; lastPt = [e.clientX, e.clientY];
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  orbitYaw -= (e.clientX - lastPt[0]) * 0.005;
  orbitPitch = clamp(orbitPitch + (e.clientY - lastPt[1]) * 0.004, -0.5, 0.9);
  lastPt = [e.clientX, e.clientY];
});
addEventListener('pointerup', () => { dragging = false; });
addEventListener('resize', () => renderer.resize());

function readInput() {
  input.forward = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
  input.turn = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
  input.boost = keys.has('ShiftLeft') || keys.has('ShiftRight');
  input.reel = keys.has('Space');
}

// ---------------------------------------------------------------- wake
const wake = [];
function updateWake(dt, t) {
  const sp = Math.abs(boat.speed);
  if (sp > 0.35) {
    const rate = clamp(sp / boat.maxSpeed, 0, 1);
    const back = boat.localToWorld([0, 0, -1.9]);
    for (const side of [-1, 1]) {
      const p = boat.localToWorld([side * 0.85, 0, -1.5]);
      wake.push({
        x: p[0], z: p[2], life: 2.8, max: 2.8,
        vlat: side * (0.7 + rate * 1.1), yaw: boat.yaw, s: 0.4 + rate * 0.6,
      });
    }
    if (sp > 4 && Math.random() < 0.5) {
      fx.emit(back[0], 0.10, back[2], (Math.random() - 0.5) * 0.9, 0.5 + Math.random() * 0.9,
        (Math.random() - 0.5) * 0.9, 0.34, 0.09 + Math.random() * 0.09, [1.4, 1.6, 1.7]);
    }
    if (sp > 7 && Math.random() < 0.6) {
      const bow = boat.localToWorld([(Math.random() < 0.5 ? -0.8 : 0.8), 0.05, 1.4]);
      fx.emit(bow[0], 0.06, bow[2], (bow[0] - boat.x) * 0.5, 1.0 + Math.random() * 1.1,
        (bow[2] - boat.z) * 0.5, 0.42, 0.11 + Math.random() * 0.12, [1.5, 1.7, 1.8]);
    }
  }
  for (let i = wake.length - 1; i >= 0; i--) {
    const w = wake[i];
    w.life -= dt;
    if (w.life <= 0) { wake.splice(i, 1); continue; }
    const age = 1 - w.life / w.max;
    w.x += Math.cos(w.yaw) * w.vlat * dt;
    w.z += -Math.sin(w.yaw) * w.vlat * dt;
    renderer.foam(w.x, w.z, (0.35 + age * 1.05) * w.s * 2.0, dt * 0.85 * (1 - age) * (1 - age) * w.s);
  }
  // hull disturbance right under the boat
  renderer.foam(boat.x, boat.z, 1.15, dt * 0.55 * clamp(sp / 4, 0.1, 1.0));
}

// ---------------------------------------------------------------- camera
const cam = { pos: v3(-30, 5, 4), look: v3(-26, 1, 14), fov: 40 };
function updateCamera(dt) {
  const yaw = boat.yaw + orbitYaw;
  const speedK = clamp(Math.abs(boat.speed) / boat.maxSpeed, 0, 1);
  const dist = 12.0 + speedK * 3.0;
  const height = 4.4 + orbitPitch * 6.0 + speedK * 0.8;
  const wantX = boat.x - Math.sin(yaw) * dist;
  const wantZ = boat.z - Math.cos(yaw) * dist;
  const wantY = boat.y + height;

  const k = 1 - Math.exp(-dt * 5.5);
  cam.pos[0] = lerp(cam.pos[0], wantX, k);
  cam.pos[1] = lerp(cam.pos[1], wantY, 1 - Math.exp(-dt * 3.2));
  cam.pos[2] = lerp(cam.pos[2], wantZ, k);
  // never dunk the lens, and never clip through the seabed near the shallows
  cam.pos[1] = Math.max(cam.pos[1], 0.85, bedHeight(cam.pos[0], cam.pos[2]) + 1.2);

  const ahead = 6.0 + speedK * 5.0;
  const lookAtX = boat.x + Math.sin(boat.yaw) * ahead;
  const lookAtZ = boat.z + Math.cos(boat.yaw) * ahead;
  cam.look[0] = lerp(cam.look[0], lookAtX, k);
  cam.look[1] = lerp(cam.look[1], boat.y + 2.1, k);
  cam.look[2] = lerp(cam.look[2], lookAtZ, k);

  cam.fov = lerp(cam.fov, 40 + speedK * 6, 1 - Math.exp(-dt * 2.5));
  if (!dragging) orbitYaw = lerp(orbitYaw, 0, 1 - Math.exp(-dt * 0.7));

  renderer.setCamera(cam.pos, cam.look, v3(0, 1, 0), cam.fov, canvas.clientWidth / canvas.clientHeight);
}

// ---------------------------------------------------------------- gameplay glue
function nearestShoal() {
  let best = null, bestD = 1e9;
  for (const s of shoals) {
    if (!s.alive) continue;
    const d = Math.hypot(s.x - boat.x, s.z - boat.z);
    if (d < bestD) { bestD = d; best = s; }
  }
  return { shoal: best, dist: bestD };
}

let sellCooldown = 0;
let goalMet = false;
function gameplay(dt, t) {
  const near = nearestShoal();
  const overShoal = near.shoal && near.dist < near.shoal.r + 2.5;
  const slow = Math.abs(boat.speed) < 1.6;

  if (input.action) {
    if (fishing.state === ST.BITE) fishing.hook();
    else if (fishing.canCast && overShoal && slow) fishing.cast(boat, near.shoal);
  }
  fishing.update(dt, boat, input, t);

  // selling: drift into the shop's berth with a hold to unload
  sellCooldown = Math.max(0, sellCooldown - dt);
  const sp = world.sellPoint;
  const atShop = Math.hypot(boat.x - sp.x, boat.z - sp.z) < sp.r;
  if (atShop && slow && fishing.hold.length && !sellCooldown && fishing.state === ST.IDLE) {
    const n = fishing.hold.length;
    fishing.sell();
    sellCooldown = 1.2;
    for (let i = 0; i < n * 4; i++) {
      fx.emit(boat.x + (Math.random() - 0.5) * 1.6, 0.8 + Math.random(), boat.z + (Math.random() - 0.5) * 1.6,
        (Math.random() - 0.5) * 1.6, 2.2 + Math.random() * 1.8, (Math.random() - 0.5) * 1.6,
        1.0, 0.16, [2.4, 1.7, 0.5], -3.5);
    }
  }

  // shoals go quiet when fished out and a fresh one shows up elsewhere
  for (const s of shoals) {
    s.update(dt, t);
    if (!s.alive && s.fade < 0.02) {
      const a = Math.random() * 6.283, d = 26 + Math.random() * 130;
      const nx = Math.cos(a) * d + 10, nz = Math.sin(a) * d - 10;
      if (bedHeight(nx, nz) < -3.2 && !world.obstacles.some((o) => Math.hypot(nx - o.x, nz - o.z) < o.r + 9)) {
        s.reset(nx, nz);
      }
    }
  }

  if (!goalMet && fishing.coins >= GOAL) {
    goalMet = true;
    fishing.toast = { text: `${GOAL} coins — the new boat is yours. Keep fishing.`, at: performance.now(), good: true };
  }

  // contextual prompt
  let prompt = null;
  if (fishing.state === ST.BITE) prompt = { text: '<kbd>Space</kbd> hook it!', urgent: true };
  else if (fishing.state === ST.WAIT || fishing.state === ST.CAST) prompt = { text: 'waiting for a bite…' };
  else if (fishing.state === ST.FIGHT) prompt = null;
  else if (fishing.hold.length >= HOLD_LIMIT) prompt = { text: 'hold full — take it back to the <b>Salty Fin</b>' };
  else if (overShoal && slow) prompt = { text: '<kbd>Space</kbd> cast' };
  else if (overShoal) prompt = { text: 'ease off the throttle to cast' };
  else if (atShop && fishing.hold.length) prompt = { text: 'come alongside to sell your catch' };
  else if (near.shoal) {
    const dir = compass(near.shoal.x - boat.x, near.shoal.z - boat.z);
    prompt = { text: `shoal ${Math.round(near.dist)} m ${dir}` };
  }
  return prompt;
}

function compass(dx, dz) {
  // relative to where the boat is pointing, which is what a helmsman wants
  const rel = Math.atan2(dx, dz) - boat.yaw;
  const a = ((rel + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  if (Math.abs(a) < 0.4) return 'dead ahead';
  if (Math.abs(a) > 2.6) return 'astern';
  return a > 0 ? 'to starboard' : 'to port';
}

// ---------------------------------------------------------------- draw list
function submit(t) {
  renderer.add(world.above, IDENTITY, { above: true, below: false, shadow: true });
  renderer.add(world.below, IDENTITY, { above: false, below: true, shadow: false });

  const boatM = boat.matrix();
  renderer.add(meshes.boat, boatM, { above: true, below: true, shadow: true });

  // the angler, breathing and leaning into the throttle
  const lean = clamp(boat.speed / boat.maxSpeed, 0, 1) * 0.10;
  const anglerLocal = trs([0, 0.34, -0.62], 0, -lean + Math.sin(t * 1.6) * 0.012, 0);
  renderer.add(meshes.angler, mul(boatM, anglerLocal, mat4()), { above: true, below: false, shadow: true });

  // rod: butt in the holder, tip rising with the fight
  const bend = fishing.rodBend + fishing.rodSwing;
  const rodLocal = trs([0.62, 0.44, -0.15], -0.26, 0.80 - bend * 0.62, 0.28);
  const rodM = mul(boatM, rodLocal, mat4());
  renderer.add(meshes.rod, rodM, { above: true, below: false, shadow: true });

  if (fishing.bobber.active) {
    const b = fishing.bobber;
    renderer.add(meshes.bobber, trs([b.x, b.y, b.z], 0), { above: true, below: false, shadow: false });
    // line: a sagging dotted curve from the rod tip
    const tip = [
      rodM[0] * 0 + rodM[4] * 2.7 + rodM[8] * 0 + rodM[12],
      rodM[1] * 0 + rodM[5] * 2.7 + rodM[9] * 0 + rodM[13],
      rodM[2] * 0 + rodM[6] * 2.7 + rodM[10] * 0 + rodM[14],
    ];
    const sag = 0.55 * (1 - fishing.tension * 0.8);
    for (let i = 1; i < 16; i++) {
      const k = i / 16;
      renderer.sprite(
        lerp(tip[0], b.x, k), lerp(tip[1], b.y + 0.16, k) - Math.sin(k * Math.PI) * sag, lerp(tip[2], b.z, k),
        0.045, 2.2, 2.3, 2.4, 0.9,
      );
    }
  }

  // shoals: fish under the surface, a marker ring on it
  for (const s of shoals) {
    if (s.fade < 0.02) continue;
    for (const f of s.fish) {
      renderer.add(fishMeshOf.get(f.sp.name), s.fishTransform(f, t), { above: false, below: true, shadow: false });
    }
    const pulse = 0.55 + Math.sin(t * 2 + s.phase) * 0.18;
    const n = 38;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * 6.283 + t * 0.25;
      const r = s.r * (0.94 + Math.sin(t * 1.6 + i) * 0.03);
      // half a sprite's height above the water, or the sea plane cuts the
      // camera-facing quads in two
      renderer.sprite(s.x + Math.cos(a) * r, 0.30, s.z + Math.sin(a) * r, 0.26,
        0.9, 1.7, 1.8, pulse * s.fade * 0.55);
    }
    // bubbles breaking over the shoal
    if (Math.random() < 0.5) {
      const a = Math.random() * 6.283, r = Math.random() * s.r * 0.8;
      fx.emit(s.x + Math.cos(a) * r, 0.02, s.z + Math.sin(a) * r, 0, 0.25, 0, 0.9, 0.09, [1.3, 1.7, 1.8], 0.4);
    }
  }

  // the catch, arcing aboard
  if (fishing.state === ST.LANDED && fishing.fishPos) {
    const mesh = fishMeshOf.get(fishing.caughtSp.name);
    renderer.add(mesh, trs(fishing.fishPos, fishing.fishSpin, 0.4, fishing.fishSpin * 1.7, 1.4),
      { above: true, below: false, shadow: true });
  }

  for (const g of gulls) {
    const m = trs([g.x, g.y, g.z], g.yaw, 0, g.bank);
    renderer.add(meshes.gull, m, { above: true, below: false, shadow: true });
    renderer.add(meshes.wingL, mul(m, trs([0, 0.05, 0], 0, 0, -g.wing), mat4()), { above: true, shadow: true });
    renderer.add(meshes.wingR, mul(m, trs([0, 0.05, 0], 0, 0, g.wing), mat4()), { above: true, shadow: true });
  }
  for (const p of perched) {
    renderer.add(meshes.gull, p.m, { above: true, below: false, shadow: true });
    renderer.add(meshes.wingL, mul(p.m, trs([0, 0.05, 0], 0, 0, -0.05), mat4()), { above: true, shadow: true });
    renderer.add(meshes.wingR, mul(p.m, trs([0, 0.05, 0], 0, 0, 0.05), mat4()), { above: true, shadow: true });
  }

  fx.draw(renderer);
}

// ---------------------------------------------------------------- loop
let started = qs.has('nointro');
if (started) document.getElementById('intro').classList.add('gone');
function startGame() {
  if (started) return;
  started = true;
  document.getElementById('intro').classList.add('gone');
}
document.getElementById('start').addEventListener('click', startGame);
document.getElementById('intro').addEventListener('pointerdown', startGame);

let time = +(qs.get('t') || 0);
let last = performance.now();
let frames = 0, fpsAcc = 0, fpsShown = 0, slowFor = 0;

function frame(now) {
  requestAnimationFrame(frame);
  let dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (!started) dt = Math.min(dt, 0.016);
  time += dt;

  readInput();
  renderer.resize();
  if (started) boat.update(dt, input, world, time);
  for (const g of gulls) g.update(dt, time);

  const prompt = started ? gameplay(dt, time) : null;
  fx.update(dt);
  updateCamera(dt);

  renderer.begin(dt, time);
  renderer.setFoamCenter(boat.x, boat.z);
  updateWake(dt, time);
  submit(time);
  renderer.render(v3(boat.x, 0, boat.z));

  input.action = false;

  // adaptive resolution: hold the frame budget before anything else
  fpsAcc += dt; frames++;
  if (fpsAcc > 0.5) {
    fpsShown = Math.round(frames / fpsAcc);
    frames = 0; fpsAcc = 0;
    if (fpsShown < 26 && renderer.quality > 0.5) { slowFor++; } else slowFor = 0;
    if (slowFor > 2) {
      renderer.quality = Math.max(0.5, renderer.quality - 0.15);
      renderer.resize(true);
      slowFor = 0;
    }
  }
  hud.update(fishing, prompt, `${fpsShown} fps`);
}

// Handle for the capture harness and the console: pose the boat, force a
// state, inspect the world without going through the input layer.
window.bay = {
  boat, fishing, shoals, world, renderer, cam, fx, meshes, gulls,
  get frames() { return frames; },
  get time() { return time; },
  setPose(x, z, yaw) { boat.x = x; boat.z = z; boat.yaw = yaw; boat.speed = 0; orbitYaw = 0; },
  gotoShoal(i = 0) {
    const s = shoals.filter((q) => q.alive)[i] || shoals[0];
    boat.x = s.x - 3; boat.z = s.z - 3; boat.speed = 0;
    boat.yaw = Math.atan2(s.x - boat.x, s.z - boat.z);
    return { x: s.x, z: s.z, bed: s.bed };
  },
  snapCamera() {
    // jump the smoothed camera straight to its target, for deterministic shots
    for (let i = 0; i < 60; i++) updateCamera(0.05);
  },
  press(code) {
    if (code === 'Space') input.action = true;
  },
  hold(code, on) { if (on) keys.add(code); else keys.delete(code); },
  start: startGame,
};

// first frame builds every program; get it out of the way before showing the bay
renderer.begin(0.016, time);
renderer.setFoamCenter(boat.x, boat.z);
submit(time);
updateCamera(0.016);
renderer.render(v3(boat.x, 0, boat.z));
document.getElementById('boot').classList.add('gone');
if (qs.has('quality')) { renderer.quality = +qs.get('quality'); renderer.resize(true); }
requestAnimationFrame(frame);
