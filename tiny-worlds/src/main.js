// Tiny Worlds — boot, game state, and the loop that ties it together.
//
// Five planets exist in one scene from the first frame. The keeper only ever
// stands on one of them; the rest hang in the sky where you can see them,
// which is the whole point.

import * as THREE from 'three';
import { WORLDS } from './worlds.js';
import { Planet } from './planet.js';
import { Player } from './player.js';
import { ChaseCamera } from './camera.js';
import { Engine } from './engine.js';
import { Particles } from './fx.js';
import { Input } from './input.js';
import { Hud } from './hud.js';
import { Audio } from './audio.js';
import { loadAssets } from './assets.js';
import { clamp } from './noise.js';

const params = new URLSearchParams(location.search);
const canvas = document.getElementById('gl');

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _up = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _move = new THREE.Vector3();
const _m = new THREE.Matrix4();
const SPARK = new THREE.Color(0xffd98a);

const hud = new Hud();
const engine = new Engine(canvas);
const input = new Input(canvas);
const audio = new Audio();

const state = {
  mode: 'loading',       // loading | title | play | flight | finale
  worldIndex: 0,
  sparks: 0,
  totalSparks: 0,
  collected: 0,
  time: 0,
  frames: 0,
  flight: null,
  promptAction: null,
};

// ---------------------------------------------------------------- boot

hud.setLoading(0.05);
const assets = await loadAssets((p) => hud.setLoading(0.05 + p * 0.55));

const planets = [];
for (let i = 0; i < WORLDS.length; i++) {
  const planet = new Planet(WORLDS[i], assets);
  engine.scene.add(planet.group);
  planets.push(planet);
  hud.setLoading(0.6 + 0.4 * ((i + 1) / WORLDS.length));
  await new Promise((r) => setTimeout(r, 0)); // let the bar actually paint
}

const player = new Player(assets);
const chase = new ChaseCamera(engine.camera);
const particles = new Particles(engine.scene);

// Point sizes are in world units; the shader needs the drawing buffer height.
const syncParticleScale = () => {
  particles.scaleUniform.value = engine.renderer.getSize(new THREE.Vector2()).y
    * engine.renderer.getPixelRatio() * 0.5;
};
syncParticleScale();
addEventListener('resize', syncParticleScale);

state.totalSparks = planets.reduce((n, p) => n + (p.moteTotal ?? 0), 0);

player.onJump = () => audio.jump();
player.onLand = (strength) => {
  audio.land(strength);
  if (strength > 0.25) {
    player.worldPosition(_a);
    player.worldUp(_b);
    particles.burst(_a, {
      count: 6 + Math.round(strength * 12), color: new THREE.Color(0xd8cbb0),
      speed: 1.6 + strength * 2.4, size: 0.28, life: 0.5, up: _b, spread: 0.7,
    });
  }
};
player.onStep = () => audio.step();

const current = () => planets[state.worldIndex];

function enterWorld(index, { lift = 0 } = {}) {
  state.worldIndex = index;
  const planet = planets[index];
  player.attachTo(planet, planet.landingDir, { lift });
  engine.focusWorld(planet);
  hud.setWorld(planet.def, index, planets.length);
  state.sparks = planet.motes.filter((m) => m.taken).length;
  hud.setSparks(state.sparks, planet.moteTotal ?? 0);
  audio.setWorld(index, { dark: planet.def.dark });
  chase.targetDistance = planet.def.radius * 1.15 + 4;
  chase.snap();
  // The Heart has nothing to collect: arriving is the ending.
  if (planet.def.finale && !planet.bloomed) startFinale();
}

// ---------------------------------------------------------------- play

function collect(planet, mote) {
  mote.taken = true;
  mote.obj.visible = false;
  planet.group.localToWorld(_a.copy(mote.obj.position));
  player.worldUp(_b);
  particles.burst(_a, { count: 34, color: SPARK, speed: 5.5, size: 0.5, life: 1.0, up: _b });
  state.sparks++;
  state.collected++;
  audio.collect(state.sparks - 1, planet.moteTotal);
  hud.setSparks(state.sparks, planet.moteTotal);
  if (state.sparks >= planet.moteTotal) bloomWorld(planet, mote.dir);
}

function bloomWorld(planet, originDir) {
  planet.startBloom(originDir);
  planet.beaconOn = true;
  audio.bloom();
  chase.shake = 0.9;

  planet.group.localToWorld(_a.copy(originDir).multiplyScalar(planet.groundRadius(originDir)));
  _b.copy(originDir).transformDirection(planet.group.matrixWorld);
  particles.burst(_a, { count: 90, color: new THREE.Color(planet.def.lush[2]), speed: 9, size: 0.6, life: 1.8, up: _b });

  hud.toast(`${planet.def.name} wakes`);
  setTimeout(() => {
    if (state.mode === 'play') hud.toast('the beacon is lit — go to it', 4200);
  }, 3400);
}

// A lit beacon breathes embers upward — the "come here" signal, without a
// light column blotting out the sky.
function emitBeacon(dt) {
  const planet = current();
  if (!planet.beaconOn || !planet.beacon) return;
  planet.beacon.emit += dt;
  while (planet.beacon.emit > 0.075) {
    planet.beacon.emit -= 0.075;
    planet.group.localToWorld(_a.copy(planet.beacon.flame.position));
    _b.copy(planet.beaconDir).transformDirection(planet.group.matrixWorld)
      .multiplyScalar(1.8 + Math.random() * 1.8);
    _b.x += (Math.random() - 0.5) * 0.7;
    _b.y += (Math.random() - 0.5) * 0.7;
    _b.z += (Math.random() - 0.5) * 0.7;
    particles.spawn(_a, _b, SPARK, 0.34, 1.7, { drag: 0.55 });
  }
}

function checkMotes(dt) {
  const planet = current();
  const pickup = 1.35;
  for (const m of planet.motes) {
    if (m.taken) continue;
    const d = m.obj.position.distanceTo(player.local);
    // Sparks lean toward you before they are caught; it makes the collection
    // forgiving without moving the pickup radius somewhere dishonest.
    if (d < 3.4) {
      m.attract = player.local;
      m.attractT = clamp((3.4 - d) / 3.4, 0, 1) * 0.55;
    } else {
      m.attract = null;
    }
    if (d < pickup) collect(planet, m);
  }
}

function updatePrompt() {
  const planet = current();
  state.promptAction = null;
  if (state.mode !== 'play') { hud.hidePrompt(); return; }

  if (planet.bloomed && planet.beacon && state.worldIndex < planets.length - 1) {
    const d = player.local.distanceTo(_a.copy(planet.beaconDir).multiplyScalar(planet.groundRadius(planet.beaconDir)));
    if (d < 3.0) {
      hud.showPrompt(`<b>E</b> &nbsp; launch to ${planets[state.worldIndex + 1].def.name}`);
      state.promptAction = 'launch';
      return;
    }
  }
  hud.hidePrompt();
}

// ---------------------------------------------------------------- flight

function startFlight() {
  const from = current();
  const to = planets[state.worldIndex + 1];
  if (!to) return;

  player.worldPosition(_a);
  player.worldUp(_b);
  engine.scene.add(player.root);       // reparents out of the planet
  player.root.position.copy(_a);
  player.setAnim('jump', 0.15);

  particles.burst(_a, { count: 60, color: SPARK, speed: 7, size: 0.55, life: 1.2, up: _b });
  audio.launch();
  chase.shake = 1.0;

  state.mode = 'flight';
  state.flight = {
    from, to, t: 0, dur: 6.2,
    start: _a.clone(),
    upFrom: _b.clone(),
    camPos: engine.camera.position.clone(),
    trail: 0,
  };
  hud.hidePrompt();
  hud.toast(`${to.def.name}`, 4000);
}

function bezier(p0, p1, p2, p3, t, out) {
  const u = 1 - t;
  return out.set(0, 0, 0)
    .addScaledVector(p0, u * u * u)
    .addScaledVector(p1, 3 * u * u * t)
    .addScaledVector(p2, 3 * u * t * t)
    .addScaledVector(p3, t * t * t);
}

function orientRoot(up, forward) {
  _d.copy(forward).addScaledVector(up, -forward.dot(up));
  if (_d.lengthSq() < 1e-6) _d.set(0, 0, 1);
  _d.normalize();
  _right.crossVectors(up, _d).normalize();
  _m.makeBasis(_right, up, _d);
  player.root.quaternion.setFromRotationMatrix(_m);
}

function updateFlight(dt) {
  const f = state.flight;
  const prevT = f.t;
  f.t = clamp(f.t + dt / f.dur, 0, 1);
  const e = f.t * f.t * (3 - 2 * f.t);

  // Endpoints are resolved every frame: the target world is slowly spinning.
  const to = f.to;
  const landLocal = _c.copy(to.landingDir).multiplyScalar(to.groundRadius(to.landingDir));
  const p3 = to.group.localToWorld(landLocal).clone();
  const upTo = _d.copy(to.landingDir).transformDirection(to.group.matrixWorld).normalize();
  const p0 = f.start;
  const p1 = _a.copy(p0).addScaledVector(f.upFrom, 34);
  const p2 = _b.copy(p3).addScaledVector(upTo, 40);

  const pos = bezier(p0, p1, p2, p3, e, new THREE.Vector3());
  const ahead = bezier(p0, p1, p2, p3, Math.min(1, e + 0.01), new THREE.Vector3()).sub(pos);
  const tangent = ahead.lengthSq() > 1e-8 ? ahead.normalize() : _fwd.set(0, 0, 1);

  _up.copy(f.upFrom).lerp(upTo, e * e * (3 - 2 * e)).normalize();
  player.root.position.copy(pos);
  orientRoot(_up, tangent);
  player.mixer.update(dt);

  // Re-entry trail.
  f.trail += dt;
  while (f.trail > 0.02) {
    f.trail -= 0.02;
    _a.copy(pos).addScaledVector(tangent, -0.6);
    _b.copy(tangent).multiplyScalar(-3).add(
      new THREE.Vector3((Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2),
    );
    particles.spawn(_a, _b, SPARK, 0.5, 0.8, { drag: 1.1 });
  }

  // Chase from behind and slightly above the arc, easing wider at apex.
  const wide = Math.sin(e * Math.PI);
  _a.copy(pos).addScaledVector(tangent, -9 - wide * 7).addScaledVector(_up, 3.2 + wide * 3);
  f.camPos.lerp(_a, 1 - Math.exp(-3.4 * dt));
  engine.camera.position.copy(f.camPos);
  engine.camera.up.copy(_up);
  engine.camera.lookAt(pos);

  if (prevT < 0.86 && f.t >= 0.86) audio.arrive();

  if (f.t >= 1) {
    state.flight = null;
    enterWorld(state.worldIndex + 1);
    player.worldPosition(_a);
    player.worldUp(_b);
    particles.burst(_a, { count: 40, color: new THREE.Color(0xd8cbb0), speed: 4.5, size: 0.4, life: 0.9, up: _b });
    chase.shake = 0.7;
    if (!to.def.finale) state.mode = 'play';
  }
}

// ---------------------------------------------------------------- finale

async function startFinale() {
  const planet = current();
  if (state.mode !== 'title') state.mode = 'finale';
  planet.startBloom(planet.landingDir);
  planet.beaconOn = true;
  planet.heartTree.grow = 1;
  audio.bloom();
  setTimeout(() => audio.finale(), 1800);
  hud.setSparks(0, 0);
  hud.toast('The Heart remembers', 6000);

  await new Promise((r) => setTimeout(r, 9000));
  await hud.showCard({
    title: 'Every world is awake',
    sub: 'and the keeper sits down at last',
    body: `You woke <b>${planets.length}</b> worlds and carried <b>${state.collected}</b> sparks home.<br>`
      + 'Walk as long as you like — the Heart is yours now.',
    button: 'Keep walking',
  });
  state.mode = 'play';
}

// ---------------------------------------------------------------- loop

function movementBasis(dt) {
  player.worldUp(_up);
  chase.forwardOn(_up, _fwd);
  _right.crossVectors(_fwd, _up).normalize().negate();
  _move.set(0, 0, 0)
    .addScaledVector(_fwd, input.move.y)
    .addScaledVector(_right, input.move.x);
  if (_move.lengthSq() > 1) _move.normalize();
  return _move;
}

let last = performance.now();
let fpsAcc = 0, fpsFrames = 0;

// `?dt=0.0166` forces a fixed timestep so the headless harness advances the
// same amount of game time per frame however slow software rendering is.
const FIXED_DT = parseFloat(params.get('dt') ?? '') || 0;

function frame(now) {
  requestAnimationFrame(frame);
  const dt = FIXED_DT || Math.min(0.05, (now - last) / 1000);
  last = now;
  state.time += dt;
  state.frames++;

  input.poll(dt);
  const playing = state.mode === 'play' || state.mode === 'finale';

  if (state.mode === 'flight') {
    updateFlight(dt);
  } else {
    const move = playing ? movementBasis(dt) : _move.set(0, 0, 0);
    player.sprint = input.sprint;
    player.update(dt, { moveWorld: move, jump: playing && input.takeJump(), freeze: !playing });
    if (playing) { checkMotes(dt); emitBeacon(dt); }

    player.worldPosition(_a);
    player.worldUp(_b);
    chase.update(dt, {
      target: _a,
      up: _b,
      moveDir: playing && (input.move.x || input.move.y) ? move : null,
      look: input.takeLook(),
      zoom: input.takeZoom(),
      autoFollow: input.lookedRecently <= 0,
      heightOffset: 1.3,
    });
    chase.avoidTerrain(current());
  }

  if (playing && input.takeInteract() && state.promptAction === 'launch') startFlight();
  else if (state.mode !== 'play') input.takeInteract();

  for (const p of planets) p.update(dt, state.time);
  particles.update(dt);
  engine.update(dt);
  if (state.mode !== 'flight') updatePrompt();

  engine.render();

  fpsAcc += dt; fpsFrames++;
  if (fpsAcc > 0.5) {
    hud.setFps(Math.round(fpsFrames / fpsAcc));
    fpsAcc = 0; fpsFrames = 0;
  }
}

// ---------------------------------------------------------------- input glue

input.onKey.add((code) => {
  if (code === 'KeyM') { audio.setMuted(!audio.muted); hud.toast(audio.muted ? 'muted' : 'sound on', 1400); }
  if (code === 'KeyH') hud.toggleChrome(!document.body.classList.contains('no-chrome'));
  if (code === 'KeyR' && state.mode === 'play') chase.snap();
});

// Touch: a tap on the right half jumps, and the prompt is tappable.
let touch = null;
canvas.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'touch' || e.clientX < innerWidth * 0.42) return;
  touch = { t: performance.now(), x: e.clientX, y: e.clientY };
});
canvas.addEventListener('pointerup', (e) => {
  if (!touch || e.pointerType !== 'touch') return;
  const quick = performance.now() - touch.t < 260;
  const still = Math.hypot(e.clientX - touch.x, e.clientY - touch.y) < 14;
  if (quick && still && state.mode === 'play') input.tapToJump();
  touch = null;
});
document.getElementById('prompt').addEventListener('click', () => { input.interactQueued = true; });

// ---------------------------------------------------------------- start

function begin() {
  document.body.classList.remove('menu');
  audio.start();
  state.mode = 'play';
  hud.setWorld(current().def, state.worldIndex, planets.length);
}

const startWorld = clamp(parseInt(params.get('world') ?? '0', 10) || 0, 0, planets.length - 1);
enterWorld(startWorld);
state.mode = 'title';
hud.hideLoading();
requestAnimationFrame((t) => { last = t; frame(t); });

if (params.get('skipmenu')) {
  hud.hideCard();
  begin();
} else {
  document.body.classList.add('menu');
  hud.showCard({
    title: 'Tiny Worlds',
    sub: 'a keeper, five small planets, and the light they lost',
    body: 'Every world here has gone grey. Somewhere on each one, its last sparks are still drifting — '
      + 'gather them all and the world wakes up under your feet.<br><br>'
      + '<span class="keys"><b>WASD</b> run &nbsp;·&nbsp; <b>Space</b> jump &nbsp;·&nbsp; <b>Shift</b> sprint '
      + '&nbsp;·&nbsp; <b>drag</b> look &nbsp;·&nbsp; <b>E</b> use the beacon</span>',
    button: 'Begin',
  }).then(begin);
}

// Debug / capture handle.
window.tinyWorlds = {
  THREE, engine, planets, player, chase, state, particles, audio, hud, input,
  begin,
  goto: (i) => { enterWorld(clamp(i, 0, planets.length - 1)); state.mode = 'play'; },
  bloom: () => { const p = current(); p.motes.forEach((m) => { m.taken = true; m.obj.visible = false; }); bloomWorld(p, p.landingDir); state.sparks = p.moteTotal; hud.setSparks(state.sparks, p.moteTotal); },
  get frames() { return state.frames; },
};
