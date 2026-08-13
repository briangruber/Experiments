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
import { offsetDir } from './threats.js';
import { Portal } from './portal.js';
import { Debug } from './debug.js';
import { clamp } from './noise.js';

const params = new URLSearchParams(location.search);
const canvas = document.getElementById('gl');

// Touch and keyboard are different games to explain, and a small laptop window
// is not a phone — ask the pointer, not the viewport.
const COARSE = matchMedia('(pointer: coarse)').matches;
document.body.classList.toggle('touch', COARSE);

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
const PETAL = new THREE.Color(0xffe6f2);
const WEATHER = new WeakMap();

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
for (const p of planets) if (p.def.weather) WEATHER.set(p, new THREE.Color(p.def.weather.color));

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
  planet.spawnThreats();
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

  openPortal(planet, originDir);

  hud.toast(`${planet.def.name} wakes`);
  setTimeout(() => {
    if (state.mode === 'play' && planet.portal) hud.toast('a way through has opened', 4200);
  }, 3400);
}

// The exit opens beside you, not back at the beacon: a few paces off, so you
// have to step into it rather than fall through it the instant it appears.
function openPortal(planet, originDir) {
  if (planet.portal || state.worldIndex >= planets.length - 1) return;
  const spot = offsetDir(originDir, 3.4 / planet.def.radius, Math.random() * Math.PI * 2, new THREE.Vector3());
  planet.portal = new Portal(planet, spot, {
    color: planet.def.portal ?? 0xbfe8ff,
    facing: originDir,
  });
  audio.portal();
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

// Everything the threats need that a planet has no business owning.
const threatCtx = {
  particles,
  audio,
  active: false,
  emberColor: new THREE.Color(0xff8a3a),
  gloomColor: new THREE.Color(0x9a7ad8),
  onHit: (hit) => onThreatHit(hit),
  onStomp: () => {
    chase.shake = 0.4;
    hud.toast('gloom scattered', 1600);
  },
};

// Getting hit never kills. It knocks you flying and shakes loose a spark you
// had already caught, which lands nearby — a setback you can walk back.
function onThreatHit({ push, strength, source }) {
  const knocked = player.knock(push, strength);
  // Recorded for the harness: whether the mercy window swallowed this one is
  // invisible from the outside otherwise.
  state.lastHit = { source, knocked };
  if (!knocked) return;
  audio.hurt();
  chase.shake = 1.0;
  hud.flash();

  const planet = current();
  const held = planet.motes.filter((m) => m.taken && !m.islet);
  if (!held.length || planet.bloomed) {
    hud.toast(source === 'meteor' ? 'a meteor came down' : 'the gloom found you', 2200);
    return;
  }
  const mote = held[held.length - 1];
  mote.taken = false;
  mote.attract = null;
  mote.obj.visible = true;
  // Thrown clear of where you are standing, so it cannot be re-caught by
  // accident while you are still tumbling.
  offsetDir(player.up, 0.30 + Math.random() * 0.16, Math.random() * Math.PI * 2, mote.dir);
  mote.up.copy(mote.dir);
  mote.hold = 1.6;
  state.sparks = Math.max(0, state.sparks - 1);
  hud.setSparks(state.sparks, planet.moteTotal);
  hud.toast(source === 'meteor' ? 'a meteor scattered a spark' : 'the gloom stole a spark', 2600);

  planet.group.localToWorld(_a.copy(mote.dir).multiplyScalar(planet.groundRadius(mote.dir) + 1));
  _b.copy(mote.dir).transformDirection(planet.group.matrixWorld);
  particles.burst(_a, { count: 20, color: SPARK, speed: 4, size: 0.45, life: 0.9, up: _b });
}

// A few motes of whatever this world's air carries — snow, pollen, embers.
// Emitted around the keeper rather than over the globe, so a fixed budget of
// particles always lands where it can be seen.
function emitWeather(dt) {
  const planet = current();
  const w = planet.def.weather;
  if (!w || state.mode === 'flight') return;
  state.weatherEmit = (state.weatherEmit ?? 0) + dt;
  const gap = 1 / (w.rate ?? 8);
  while (state.weatherEmit > gap) {
    state.weatherEmit -= gap;
    player.worldPosition(_a);
    player.worldUp(_b);
    _c.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(14);
    _a.add(_c).addScaledVector(_b, 5 + Math.random() * 4);
    _d.copy(_b).multiplyScalar(-(w.fall ?? 1.2));
    _d.x += (Math.random() - 0.5) * (w.drift ?? 0.8);
    _d.z += (Math.random() - 0.5) * (w.drift ?? 0.8);
    particles.spawn(_a, _d, WEATHER.get(planet) ?? SPARK, w.size ?? 0.3, w.life ?? 3.2, { drag: 0.15 });
  }
}

// Petals thrown up along the bloom front while it travels.
function emitBloomFront(planet, dt) {
  if (!planet.waveActive) return;
  planet.frontEmit = (planet.frontEmit ?? 0) + dt;
  while (planet.frontEmit > 0.03) {
    planet.frontEmit -= 0.03;
    offsetDir(planet.bloomOrigin, planet.waveRadius, Math.random() * Math.PI * 2, _c);
    planet.group.localToWorld(_a.copy(_c).multiplyScalar(planet.groundRadius(_c) + 0.3));
    _b.copy(_c).transformDirection(planet.group.matrixWorld);
    _d.copy(_b).multiplyScalar(2.2 + Math.random() * 2.2);
    _d.x += (Math.random() - 0.5) * 1.6;
    _d.z += (Math.random() - 0.5) * 1.6;
    particles.spawn(_a, _d, PETAL, 0.4, 1.6, { drag: 0.7 });
  }
}

function checkMotes(dt) {
  const planet = current();
  const pickup = 1.35;
  for (const m of planet.motes) {
    if (m.taken) continue;
    // A spark just shaken loose stays cold for a moment. Without this the
    // magnet below hauls it straight back and the hit costs you nothing.
    if (m.hold > 0) { m.hold -= dt; m.attract = null; continue; }
    const d = m.obj.position.distanceTo(player.local);
    // Sparks lean toward you before they are caught; it makes the collection
    // forgiving without moving the pickup radius somewhere dishonest.
    if (d < 2.6) {
      m.attract = player.local;
      m.attractRate = clamp((2.6 - d) / 2.6, 0, 1) * 3.5;
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

  if (planet.portal && state.worldIndex < planets.length - 1) {
    const d = player.local.distanceTo(planet.portal.centre);
    if (d < 9) {
      hud.showPrompt(`walk into the portal &nbsp;·&nbsp; <b>${planets[state.worldIndex + 1].def.name}</b>`);
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
  // right = forward x up in a right-handed frame. Negating it here is what had
  // A and D swapped.
  _right.crossVectors(_fwd, _up).normalize();
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
    // The higher you get, the further back the camera sits — on the light
    // worlds a full-speed jump nearly leaves the planet, and that only reads
    // if you can see the planet.
    const planetNow = current();
    const altitude = Math.max(0, player.local.length() - planetNow.groundRadius(player.up));
    chase.targetDistance = planetNow.def.radius * 1.15 + 4 + Math.min(altitude * 1.5, planetNow.def.radius * 1.4);

    chase.measureClearance(planetNow, dt);
    chase.update(dt, {
      target: _a,
      up: _b,
      moveDir: playing && (input.move.x || input.move.y) ? move : null,
      look: input.takeLook(),
      zoom: input.takeZoom(),
      autoFollow: input.lookedRecently <= 0,
      // Only swing in behind the keeper when they are actually running
      // forward. Following a strafe rotates the camera, which rotates what
      // "right" means, which curves the strafe further — the keeper spirals on
      // the spot while the view whips around them.
      followStrength: Math.max(0, input.move.y) * (1 - Math.min(1, Math.abs(input.move.x))),
      heightOffset: 1.6,
    });
  }

  if (playing && input.takeInteract() && state.promptAction === 'launch') startFlight();
  else if (state.mode !== 'play') input.takeInteract();

  for (const p of planets) p.update(dt, state.time);
  threatCtx.active = playing && state.mode !== 'flight';
  current().updateThreats(dt, state.time, player, threatCtx);
  current().portal?.update(dt, state.time, threatCtx);
  emitBloomFront(current(), dt);
  emitWeather(dt);
  // Stepping into the mouth is the whole interaction.
  if (state.mode === 'play' && current().portal?.reached(player.local)) startFlight();
  particles.update(dt);
  engine.update(dt);
  debug.update(dt);
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

// user-select stops the highlight, but a drag beginning on the canvas can still
// be claimed by the browser as a native drag or a selection extend, which
// swallows the pointermove stream the camera runs on.
canvas.addEventListener('selectstart', (e) => e.preventDefault());
canvas.addEventListener('dragstart', (e) => e.preventDefault());

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
      + 'gather them all and the world wakes up under your feet. Watch for the gloom, and for the sky.'
      + '<br><br><span class="keys">'
      + (COARSE
        ? '<b>left half</b> of the screen steers &nbsp;·&nbsp; <b>tap the right half</b> to jump'
          + '<br><b>drag the right half</b> to look around'
          + '<br>walk into the portal when it opens'
        : '<b>WASD</b> run &nbsp;·&nbsp; <b>Space</b> jump &nbsp;·&nbsp; <b>Shift</b> sprint '
          + '&nbsp;·&nbsp; <b>drag</b> to look<br>walk into the portal when it opens')
      + '</span>',
    button: 'Begin',
  }).then(begin);
}

// Debug / capture handle. The panel in debug.js drives the game through this,
// so anything it can do is scriptable from the harness too.
const game = window.tinyWorlds = {
  THREE, engine, planets, player, chase, state, particles, audio, hud, input,
  begin,
  goto: (i) => { enterWorld(clamp(i, 0, planets.length - 1)); if (state.mode !== 'finale') state.mode = 'play'; },
  giveSpark: () => {
    const p = current();
    const next = p.motes.find((m) => !m.taken);
    if (next) collect(p, next);
  },
  dropMeteor: () => current().meteors?.spawn(player.up.clone()),
  clearGloom: () => {
    for (const m of current().gloom?.mobs ?? []) { m.root.visible = false; m.dead = 20; }
  },
  openPortal: () => openPortal(current(), current().bloomOrigin),
  bloom: () => { const p = current(); p.motes.forEach((m) => { m.taken = true; m.obj.visible = false; }); bloomWorld(p, p.landingDir); state.sparks = p.moteTotal; hud.setSparks(state.sparks, p.moteTotal); },
  get frames() { return state.frames; },
};

const debug = new Debug(game, { open: params.has('debug') });
input.onKey.add((code) => { if (code === 'Backquote') debug.toggle(); });
document.getElementById('debug-chip').addEventListener('click', () => debug.toggle());
