import * as THREE from 'three';
import { WORLD, BOATS, MONSTER_BY_ID, HARPOON, haulPenalty } from '/shared/config.js';
import { sampleWater } from '/shared/waves.js';
import { createSky, createOcean, createLights, createWorldEdge, HORIZON_COLOR, FOG_DENSITY } from './sea.js';
import { createBoat, createLabel } from './boat.js';
import { MonsterView, createCarcass } from './monster.js';
import { HarpoonSystem, Rope, disposeGroup } from './harpoon.js';
import { Particles, Wake } from './fx.js';
import { createTown } from './town.js';
import { Hud } from './hud.js';
import { Minimap, depthLabel } from './minimap.js';
import { createInput } from './input.js';
import { Net } from './net.js';
import { Audio } from './audio.js';
import { detectTier, AdaptiveResolution, goImmersive } from './quality.js';
import { attachSoloWorld } from './solo.js';

const canvas = document.getElementById('gl');
const { tier } = detectTier();

const renderer = new THREE.WebGLRenderer({
  canvas, antialias: tier.antialias, powerPreference: 'high-performance',
});
const resolution = new AdaptiveResolution(renderer, tier);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.02;

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(HORIZON_COLOR.clone(), FOG_DENSITY);
scene.background = HORIZON_COLOR.clone();

const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.4, 9000);
camera.position.set(0, 14, 130);

const ocean = createOcean({
  segments: tier.oceanSegments, half: tier.oceanHalf, detail: tier.waveDetail,
});
scene.add(ocean.mesh);
scene.add(createSky({ segments: tier.skySegments }));
createLights(scene);
const edge = createWorldEdge();
scene.add(edge.mesh);

const town = createTown({ lamp: tier.townLight });
scene.add(town.group);

const particles = new Particles(scene, { max: tier.particles });
const input = createInput(canvas);
const audio = new Audio();
const net = new Net();

/* --------------------------------------------------------------- state */

const game = {
  id: 0,
  self: null,
  boat: null,          // { view, x, z, h, speed, throttle, rudder, extVx, extVz }
  monsters: new Map(), // id -> MonsterView
  players: new Map(),  // id -> remote boat record
  carcasses: [],
  charge: 0,
  cooldown: 0,
  reelAcc: 0,
  reelTimer: 0,
  shake: 0,
  time: 0,
  playing: false,
  travelled: 0,
  peakSpeed: 0,
};

const harpoons = new HarpoonSystem(scene, {
  onSplash: (p, s) => { particles.splash(p, s); audio.splash(s); },
  onHit: (view, damage, point, charge) => {
    const crit = charge > 0.92;
    const dmg = damage * (crit ? 1.15 : 1);
    net.send({ t: 'hit', id: view.id, dmg: +dmg.toFixed(1) });
    particles.burst(point, view.type.accent, 20, 5);
    particles.splash(point, 0.7);
    audio.hit();
    view.flash = 1;
    const s = toScreen(point);
    if (s) hud.damageNumber(s, dmg, crit);
    game.shake = Math.max(game.shake, 0.25);
  },
  onTether: (t) => {
    hud.log(`Fast to a ${t.view.type.name}!`, 'kill');
    audio.roar(t.view.type.tier);
  },
  onRelease: (t, reason) => {
    net.send({ t: 'cut', id: t.view.id });
    if (reason === 'snap') {
      hud.log('The rope parted!', 'sink');
      audio.snap();
      game.shake = Math.max(game.shake, 0.5);
    }
  },
});

const hud = new Hud({
  dock: (action, tier) => net.send({ t: 'dock', action, tier }),
  closeDock: () => { hud.closeDock(); relock(); },
  respawn: () => net.send({ t: 'respawn' }),
  chat: (text) => net.send({ t: 'chat', text }),
  chatClosed: () => { input.typing = false; relock(); },
});

// Smaller chart on a phone: it competes with two thumbs for the corners.
const minimap = new Minimap(document.getElementById('minimap'), {
  size: input.touch ? Math.min(104, Math.round(Math.min(innerWidth, innerHeight) * 0.27)) : 220,
  range: input.touch ? 600 : 700,
});

/* ---------------------------------------------------------- own vessel */

function buildOwnBoat(tier) {
  const prev = game.boat;
  const view = createBoat(tier, { color: 0xf2c057 });
  scene.add(view.group);
  const boat = {
    view,
    x: prev ? prev.x : 0, z: prev ? prev.z : 90,
    h: prev ? prev.h : Math.PI,
    speed: 0, throttle: 0, rudder: 0,
    extVx: 0, extVz: 0,
    roll: 0, pitch: 0, tier,
    wake: prev ? prev.wake : new Wake(scene, { length: tier.wakeLength, width: 1.4 }),
  };
  if (prev) { scene.remove(prev.view.group); prev.view.dispose(); }
  game.boat = boat;
  return boat;
}

const _bow = new THREE.Vector3();
function bowPoint() {
  const b = game.boat;
  return b ? _bow.copy(b.view.bowPoint).applyMatrix4(b.view.group.matrixWorld) : _bow.set(0, 1, 0);
}

/* --------------------------------------------------------------- camera */

const cam = { yaw: 0, pitch: 0.20, dist: 1, pos: new THREE.Vector3(0, 14, 130), look: new THREE.Vector3() };
const _fwd = new THREE.Vector3();
const _tmp = new THREE.Vector3();

function aimDirection() {
  return camera.getWorldDirection(_fwd).clone().normalize();
}

/**
 * Where to throw to actually hit `point` from `origin` at `speed`, allowing for
 * the drop. Two iterations is plenty at harpoon ranges.
 */
const _aim = new THREE.Vector3();
function ballisticAim(origin, point, speed) {
  _aim.copy(point).sub(origin);
  let flat = Math.hypot(_aim.x, _aim.z);
  let rise = _aim.y;
  for (let i = 0; i < 2; i++) {
    const t = flat / Math.max(1, speed);
    rise = (point.y - origin.y) + 0.5 * HARPOON.gravity * t * t;
    flat = Math.hypot(_aim.x, _aim.z);
  }
  _aim.y = rise;
  return _aim.normalize();
}

/**
 * The monster a touch player means. Generous by design: a thumb cannot place a
 * crosshair, and the fun is in the rope, not the reticle.
 */
function assistTarget(maxRange) {
  const t = harpoons.tether;
  if (t) return t.view;
  const dir = aimDirection();
  const origin = camera.position;
  let best = null, bestScore = -1;
  for (const view of game.monsters.values()) {
    if (view.dying) continue;
    const to = _tmp.copy(view.hitSpheresWorld[0].pos).sub(origin);
    const dist = to.length();
    if (dist > maxRange) continue;
    const aligned = to.normalize().dot(dir);
    if (aligned < 0.72) continue;               // roughly a 44-degree cone
    // Prefer what you are looking at, then what is close.
    const score = aligned * 2 + (1 - dist / maxRange);
    if (score > bestScore) { bestScore = score; best = view; }
  }
  return best;
}

function updateCamera(dt) {
  const b = game.boat;
  if (!b) return;
  const look = input.consumeLook();
  const sens = input.touch ? 0.0022 : 0.0026;
  cam.yaw -= look.x * sens;
  cam.pitch = Math.max(-0.28, Math.min(0.85, cam.pitch + look.y * sens));
  if (input.touch && look.x === 0 && look.y === 0) {
    // One thumb is on the stick and the other is on THROW; nobody is free to
    // fly the camera, so it eases back behind the bow on its own.
    cam.yaw *= Math.pow(0.22, dt);
    cam.pitch += (0.20 - cam.pitch) * Math.min(1, dt * 0.7);
  }
  cam.dist = Math.max(0.55, Math.min(2.6, cam.dist + input.consumeWheel() * 0.14));

  const spec = BOATS[b.tier];
  const range = (spec.length * 1.25 + 7.5) * cam.dist;
  const height = (spec.length * 0.34 + 2.4) * cam.dist * (0.55 + cam.pitch);
  const yaw = b.h + cam.yaw;

  sampleWater(b.x, b.z, game.time, _water);
  const target = _tmp.set(b.x, _water.y + spec.length * 0.22 + 1.4, b.z);
  const want = new THREE.Vector3(
    target.x - Math.cos(yaw) * range * Math.cos(cam.pitch),
    target.y + height + Math.sin(cam.pitch) * range,
    target.z - Math.sin(yaw) * range * Math.cos(cam.pitch)
  );
  // Never let the camera dunk below the swell.
  const wy = sampleWater(want.x, want.z, game.time, {}).y;
  want.y = Math.max(want.y, wy + 2.4);

  const k = 1 - Math.pow(0.0006, dt);
  cam.pos.lerp(want, k);
  camera.position.copy(cam.pos);
  cam.look.lerp(target, 1 - Math.pow(0.0002, dt));
  camera.lookAt(cam.look);

  if (game.shake > 0) {
    game.shake = Math.max(0, game.shake - dt * 1.4);
    const s = game.shake * game.shake * 1.6;
    camera.position.x += (Math.random() - 0.5) * s;
    camera.position.y += (Math.random() - 0.5) * s;
    camera.position.z += (Math.random() - 0.5) * s;
  }
}

const _screen = new THREE.Vector3();
function toScreen(v) {
  _screen.copy(v).project(camera);
  if (_screen.z > 1) return null;
  return {
    x: (_screen.x * 0.5 + 0.5) * innerWidth,
    y: (-_screen.y * 0.5 + 0.5) * innerHeight,
  };
}

/* ------------------------------------------------------------- physics */

const _water = {};

function updateBoat(dt) {
  const b = game.boat;
  if (!b || !game.self) return;
  const spec = BOATS[b.tier];
  const dead = game.self.dead;

  // Controls.
  let throttle = 0, rudder = 0;
  if (!dead && !hud.dockOpen && !input.typing) {
    if (input.down('KeyW') || input.down('ArrowUp')) throttle += 1;
    if (input.down('KeyS') || input.down('ArrowDown')) throttle -= 0.6;
    if (input.down('KeyA') || input.down('ArrowLeft')) rudder -= 1;
    if (input.down('KeyD') || input.down('ArrowRight')) rudder += 1;
    if (input.touch) { throttle += input.stick.y; rudder += input.stick.x; }
  }
  b.throttle += (throttle - b.throttle) * Math.min(1, dt * 3.2);
  b.rudder += (rudder - b.rudder) * Math.min(1, dt * 5.5);

  const slots = game.self.cargo.reduce((a, c) => a + c.slots, 0);
  const haul = haulPenalty(slots, game.self.hold);
  const crewFactor = 0.45 + 0.55 * (game.self.crewMax ? game.self.crew / game.self.crewMax : 1);
  const hullFactor = 0.55 + 0.45 * Math.max(0, game.self.hull / game.self.hullMax);
  const top = spec.speed * haul * (0.7 + 0.3 * crewFactor) * hullFactor;

  const want = top * b.throttle;
  b.speed += (want - b.speed) * Math.min(1, dt * (spec.accel / 6));

  // Rudder authority needs water moving over it.
  const bite = Math.min(1, Math.abs(b.speed) / (spec.speed * 0.34));
  b.h += b.rudder * spec.turn * dt * bite * Math.sign(b.speed || 1);

  b.extVx *= Math.pow(0.14, dt);
  b.extVz *= Math.pow(0.14, dt);

  b.x += (Math.cos(b.h) * b.speed + b.extVx) * dt;
  b.z += (Math.sin(b.h) * b.speed + b.extVz) * dt;
  game.travelled += Math.abs(b.speed) * dt;
  game.peakSpeed = Math.max(game.peakSpeed, Math.abs(b.speed));

  // The edge of the world pushes back rather than being an invisible wall.
  const d = Math.hypot(b.x, b.z);
  if (d > WORLD.radius) {
    const s = WORLD.radius / d;
    b.x *= s; b.z *= s;
    b.speed *= 0.6;
  }

  // Buoyancy: sample the surface at bow and stern so the hull pitches with the
  // wave it is actually sitting on.
  const half = spec.length * 0.42;
  const bowW = sampleWater(b.x + Math.cos(b.h) * half, b.z + Math.sin(b.h) * half, game.time, {});
  const aftW = sampleWater(b.x - Math.cos(b.h) * half, b.z - Math.sin(b.h) * half, game.time, {});
  sampleWater(b.x, b.z, game.time, _water);

  const pitch = Math.atan2(bowW.y - aftW.y, half * 2);
  const heel = Math.asin(Math.max(-1, Math.min(1, -_water.nx * Math.sin(b.h) + _water.nz * Math.cos(b.h))));
  const turnHeel = -b.rudder * Math.min(1, Math.abs(b.speed) / spec.speed) * 0.32;

  b.pitch += (pitch - b.pitch) * Math.min(1, dt * 5);
  b.roll += (heel * 0.6 + turnHeel - b.roll) * Math.min(1, dt * 4);

  const g = b.view.group;
  g.position.set(b.x, _water.y + b.view.floatY, b.z);
  g.rotation.set(0, -b.h, 0, 'YXZ');
  g.rotateZ(b.pitch);
  g.rotateX(-b.roll);
  g.updateMatrixWorld();

  // Oars swing when there is no sail to do the work.
  for (const oar of b.view.oars) {
    oar.rotation.y = Math.sin(game.time * 3.4) * 0.4 * Math.min(1, Math.abs(b.speed) / 4) * oar.userData.side;
  }

  const strength = Math.min(1, Math.abs(b.speed) / spec.speed);
  b.wake.push(b.x - Math.cos(b.h) * half, _water.y + 0.12, b.z - Math.sin(b.h) * half,
    Math.cos(b.h), Math.sin(b.h), strength * (spec.length / 12), dt);

  // Bow spray when driving into a sea.
  if (strength > 0.45 && Math.random() < dt * 34 * strength) {
    const px = b.x + Math.cos(b.h) * half, pz = b.z + Math.sin(b.h) * half;
    particles.spawn(px, bowW.y + 0.3, pz,
      Math.cos(b.h) * b.speed * 0.35 + (Math.random() - 0.5) * 3,
      2.5 + Math.random() * 3.5,
      Math.sin(b.h) * b.speed * 0.35 + (Math.random() - 0.5) * 3,
      { color: 0xe8f4f8, size: 0.22 + Math.random() * 0.3, life: 0.8, gravity: 12, float: true });
  }

  // A holed hull smokes.
  const hullPct = game.self.hull / game.self.hullMax;
  if (hullPct < 0.42 && Math.random() < dt * (1 - hullPct) * 12) {
    particles.smoke(b.x + (Math.random() - 0.5) * spec.length * 0.4, _water.y + spec.length * 0.2,
      b.z + (Math.random() - 0.5) * spec.length * 0.4, hullPct < 0.2 ? 0x1d1d1f : 0x4a4a48, 1);
  }

  audio.setSpeed(strength);
  net.sendState(b.x, b.z, b.h, b.speed);
}

/* --------------------------------------------------------- the harpoon */

function updateHarpoon(dt) {
  const b = game.boat;
  if (!b || !game.self || game.self.dead) return;
  const spec = BOATS[b.tier];

  game.cooldown = Math.max(0, game.cooldown - dt);

  const canFire = !hud.dockOpen && !input.typing && game.cooldown <= 0;
  if (input.firing && canFire) {
    game.charge = Math.min(1, game.charge + dt / HARPOON.chargeTime);
  }
  if (input.consumeFire() && canFire && game.charge > 0.06) {
    const charge = game.charge;
    const origin = bowPoint().clone().add(new THREE.Vector3(0, 0.6, 0));
    const speed = HARPOON.minSpeed + (HARPOON.maxSpeed - HARPOON.minSpeed) * charge;
    let dir = aimDirection();
    if (input.aimAssist) {
      const locked = assistTarget(spec.rope * 1.15);
      // Aim at the nearest part of the body, not its head: on a serpent the
      // head is often the one bit under water.
      if (locked) dir = ballisticAim(origin, locked.nearestSphere(origin).pos, speed).clone();
    }
    const damage = spec.harpoonDamage * (0.62 + 0.38 * charge);
    harpoons.fire({ origin, dir, charge, damage, maxRope: spec.rope });
    net.send({
      t: 'fire', x: origin.x, y: origin.y, z: origin.z,
      vx: dir.x, vy: dir.y, vz: dir.z,
    });
    audio.throw_();
    game.cooldown = HARPOON.cooldown;
    game.charge = 0;
  }
  if (!input.firing) game.charge = Math.max(0, game.charge - dt * 2.2);

  harpoons.update(dt, game.time, {
    monsters: game.monsters,
    anchor: bowPoint(),
  });

  const t = harpoons.tether;
  hud.setStrain(t);
  if (!t) { game.reelAcc = 0; return; }

  const monsterType = t.view.type;
  const crewFactor = 0.35 + 0.65 * (game.self.crewMax ? game.self.crew / game.self.crewMax : 0);

  // Reeling: damage and strain both come out of the winch.
  const reeling = (input.reeling || input.down('KeyR')) && !hud.dockOpen && !input.typing;
  if (reeling) {
    const rate = spec.reel * crewFactor;
    t.length = Math.max(9, t.length - rate * 0.22 * dt);
    t.strain += HARPOON.reelStrain * dt * (1 + Math.max(0, t.over) * 0.06);
    game.reelAcc += rate * dt;
    game.reelTimer += dt;
    if (Math.random() < dt * 9) audio.winch();
    if (game.reelTimer > 0.25) {
      net.send({ t: 'reel', id: t.view.id, dmg: +game.reelAcc.toFixed(2) });
      game.reelTimer = 0;
      game.reelAcc = 0;
    }
  } else {
    t.strain -= HARPOON.strainRelief * dt;
  }

  // The sleigh ride: something huge on a short rope drags the boat.
  if (t.over > 0) {
    const massRatio = (monsterType.tier + 2) / (b.tier + 2);
    t.strain += Math.min(t.over, 14) * HARPOON.dragStrain * dt * massRatio;
    const dir = _tmp.set(t.point.x - b.x, 0, t.point.z - b.z);
    const len = dir.length() || 1;
    dir.multiplyScalar(1 / len);
    const pull = Math.min(t.over, 16) * 0.9 * massRatio;
    b.extVx += dir.x * pull * dt;
    b.extVz += dir.z * pull * dt;
    if (Math.random() < dt * 4) {
      particles.splash(_tmp.set(b.x + dir.x * 3, sampleWater(b.x, b.z, game.time, {}).y, b.z + dir.z * 3), 0.5);
    }
  }
  t.strain = Math.max(0, t.strain);

  if (t.strain >= HARPOON.strainSnap) harpoons.release(t, 'snap');
  if (input.once('KeyC')) harpoons.release(t, 'cut');
}

/* ---------------------------------------------------- remote boats etc. */

const remoteRopes = new Map();

function syncPlayers(list) {
  const seen = new Set();
  for (const p of list) {
    seen.add(p.id);
    let rec = game.players.get(p.id);
    if (!rec || rec.tier !== p.t) {
      if (rec) { scene.remove(rec.view.group); rec.view.dispose(); rec.label.parent?.remove(rec.label); }
      const view = createBoat(p.t, { color: 0x7ee0ff });
      scene.add(view.group);
      const label = createLabel(p.n, `Lv ${p.lv}`);
      scene.add(label);
      rec = {
        view, label, tier: p.t, name: p.n,
        x: p.x, z: p.z, h: p.h, tx: p.x, tz: p.z, th: p.h, sp: p.sp,
        wake: new Wake(scene, { length: Math.round(tier.wakeLength * 0.6), width: 1.2 }),
      };
      game.players.set(p.id, rec);
    }
    rec.tx = p.x; rec.tz = p.z; rec.th = p.h; rec.sp = p.sp; rec.hp = p.hp;
    rec.lv = p.lv;
    rec.dead = p.d;
  }
  for (const [id, rec] of game.players) {
    if (seen.has(id)) continue;
    removePlayer(id, rec);
  }
}

function removePlayer(id, rec) {
  scene.remove(rec.view.group);
  rec.view.dispose();
  rec.label.parent?.remove(rec.label);
  rec.wake.dispose();
  game.players.delete(id);
}

function updatePlayers(dt) {
  for (const [, rec] of game.players) {
    const k = 1 - Math.pow(0.002, dt);
    rec.x += (rec.tx - rec.x) * k;
    rec.z += (rec.tz - rec.z) * k;
    let dh = ((rec.th - rec.h + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    rec.h += dh * k;

    const spec = BOATS[rec.tier];
    const half = spec.length * 0.42;
    sampleWater(rec.x, rec.z, game.time, _water);
    const g = rec.view.group;
    g.position.set(rec.x, _water.y + rec.view.floatY, rec.z);
    g.rotation.set(0, -rec.h, 0, 'YXZ');
    g.updateMatrixWorld();
    g.visible = !rec.dead;
    rec.label.visible = !rec.dead;
    rec.label.position.set(rec.x, _water.y + spec.length * 0.55 + 3, rec.z);
    const strength = Math.min(1, Math.abs(rec.sp) / spec.speed);
    rec.wake.push(rec.x - Math.cos(rec.h) * half, _water.y + 0.12, rec.z - Math.sin(rec.h) * half,
      Math.cos(rec.h), Math.sin(rec.h), strength * (spec.length / 12), dt);
  }
}

/** Ropes other crews have out, so a shared kill looks shared. */
function updateRemoteRopes() {
  const live = new Set();
  for (const [mid, view] of game.monsters) {
    if (!view.tetheredBy) continue;
    for (const pid of view.tetheredBy) {
      if (pid === game.id) continue;
      const rec = game.players.get(pid);
      if (!rec) continue;
      const key = `${pid}:${mid}`;
      live.add(key);
      let rope = remoteRopes.get(key);
      if (!rope) {
        rope = new Rope(0xc7bda6, 0.05);
        scene.add(rope.mesh);
        remoteRopes.set(key, rope);
      }
      const from = _tmp.copy(rec.view.bowPoint).applyMatrix4(rec.view.group.matrixWorld);
      rope.update(from, view.nearestSphere(from).pos, 0.3);
    }
  }
  for (const [key, rope] of remoteRopes) {
    if (live.has(key)) continue;
    scene.remove(rope.mesh);
    rope.dispose();
    remoteRopes.delete(key);
  }
}

/* ----------------------------------------------------------- towed catch */

function syncCarcasses() {
  const cargo = game.self ? game.self.cargo : [];
  const want = cargo.slice(0, 3);
  while (game.carcasses.length > want.length) {
    const c = game.carcasses.pop();
    scene.remove(c.root);
    scene.remove(c.rope.mesh);
    c.rope.dispose();
    disposeGroup(c.root);
  }
  while (game.carcasses.length < want.length) {
    const spec = want[game.carcasses.length];
    const c = createCarcass(spec.id);
    const rope = new Rope(0xb9ad92, 0.05);
    scene.add(c.root, rope.mesh);
    game.carcasses.push({ ...c, rope });
  }
  for (let i = 0; i < game.carcasses.length; i++) game.carcasses[i].kind = want[i].id;
}

function updateCarcasses() {
  const b = game.boat;
  if (!b) return;
  const spec = BOATS[b.tier];
  const stern = _tmp.copy(b.view.sternPoint).applyMatrix4(b.view.group.matrixWorld).clone();
  for (let i = 0; i < game.carcasses.length; i++) {
    const c = game.carcasses[i];
    const back = spec.length * 0.55 + (i + 1) * (spec.length * 0.42 + c.type.size * 3.2);
    const x = b.x - Math.cos(b.h) * back;
    const z = b.z - Math.sin(b.h) * back;
    sampleWater(x, z, game.time, _water);
    c.root.position.set(x, _water.y - c.type.size * 0.35, z);
    c.root.rotation.y = -b.h;
    c.rope.update(stern, c.root.position, 0.4);
  }
}

/* --------------------------------------------------------------- events */

net.on('welcome', (msg) => {
  game.id = msg.id;
  applySelf(msg.you);
  syncPlayers(msg.players || []);
  for (const m of msg.monsters || []) upsertMonster(m);
});

net.on('snap', (msg) => {
  syncPlayers(msg.p || []);
  const seen = new Set();
  for (const m of msg.m || []) { upsertMonster(m); seen.add(m.id); }
  for (const [id, view] of game.monsters) {
    if (seen.has(id) || harpoons.tethers.some((t) => t.view === view)) continue;
    scene.remove(view.root);
    view.dispose();
    game.monsters.delete(id);
  }
});

function upsertMonster(m) {
  let view = game.monsters.get(m.id);
  if (!view) {
    view = new MonsterView(m.k, m.id);
    scene.add(view.root);
    game.monsters.set(m.id, view);
  }
  view.target(m);
  view.tetheredBy = m.th || null;
}

net.on('you', (msg) => applySelf(msg));

function applySelf(s) {
  const prevTier = game.self ? game.self.tier : null;
  const prevCrew = game.self ? game.self.crew : null;
  game.self = s;
  hud.setSelf(s);
  if (!game.boat || prevTier !== s.tier) buildOwnBoat(s.tier);
  if (game.boat && (prevCrew !== s.crew || prevTier !== s.tier)) game.boat.view.setCrew(s.crew);
  syncCarcasses();
}

net.on('hurt', (msg) => {
  if (game.self) {
    game.self.hull = msg.hull;
    game.self.crew = msg.crewLeft;
    hud.setHull(msg.hull, msg.hullMax);
    game.boat?.view.setCrew(msg.crewLeft);
  }
  game.shake = Math.max(game.shake, 0.7);
  audio.hurt();
  flashScreen(0.5);
  const b = game.boat;
  if (b) {
    const p = new THREE.Vector3(b.x, sampleWater(b.x, b.z, game.time, {}).y + 1, b.z);
    particles.burst(p, 0x8a6a45, 22, 6);
    particles.splash(p, 1.4);
  }
  const type = MONSTER_BY_ID[msg.monster];
  if (msg.crew > 0) hud.log(`${type ? type.name : 'It'} took ${msg.crew} of your crew`, 'bite');
});

net.on('kill', (msg) => {
  audio.kill();
  const type = MONSTER_BY_ID[msg.monster];
  if (msg.carcass) hud.log(`${msg.name} landed — in the hold, worth ${type.bounty.toLocaleString()}g at the docks`, 'big');
  else if (msg.lost) hud.log(`${msg.name} killed, but the hold is full — ${msg.gold.toLocaleString()}g salvaged`, 'gold');
  else if (msg.gold) hud.log(`Crew share of the ${msg.name}: ${msg.gold.toLocaleString()}g`, 'gold');
  applySelf(msg.state);
  const t = harpoons.tethers.find((x) => x.view.id === msg.mid);
  if (t) harpoons.release(t, 'landed');
});

net.on('dead', (msg) => {
  const view = game.monsters.get(msg.mid);
  const type = MONSTER_BY_ID[msg.k];
  const p = new THREE.Vector3(msg.x, sampleWater(msg.x, msg.z, game.time, {}).y, msg.z);
  particles.burst(p, type ? type.accent : 0xd8503f, 60, 9, { life: 1.6, size: 0.7 });
  particles.splash(p, 2.4);
  audio.roar((type?.tier ?? 0) + 1);
  if (view) {
    view.dying = 0.001;
    const t = harpoons.tethers.find((x) => x.view === view);
    if (t) harpoons.release(t, 'landed');
  }
});

net.on('sank', (msg) => {
  hud.showDeath(msg);
  applySelf(msg.state);
  audio.sink();
  game.shake = 1.2;
  const b = game.boat;
  if (b) {
    const p = new THREE.Vector3(b.x, 0, b.z);
    particles.burst(p, 0x8a6a45, 90, 12, { life: 2.4, size: 0.8 });
    particles.splash(p, 3);
  }
  for (const t of [...harpoons.tethers]) harpoons.release(t, 'lost');
});

net.on('respawn', (msg) => {
  hud.hideDeath();
  applySelf(msg.state);
  const b = game.boat;
  if (b) { b.x = msg.x; b.z = msg.z; b.h = Math.PI; b.speed = 0; b.extVx = b.extVz = 0; }
  hud.log('A rowboat, an oar, and your reputation. Off you go.', 'info');
  relock();
});

net.on('ev', (msg) => {
  hud.log(msg.text, msg.kind);
  if (msg.kind === 'level') audio.level();
  if (msg.kind === 'gold' || msg.kind === 'trade') audio.gold();
});

net.on('chat', (msg) => hud.chat(msg.name, msg.text, msg.id === game.id));
net.on('bye', (msg) => {
  const rec = game.players.get(msg.id);
  if (rec) removePlayer(msg.id, rec);
});

net.on('shot', (msg) => {
  harpoons.fire({
    origin: new THREE.Vector3(msg.x, msg.y, msg.z),
    dir: new THREE.Vector3(msg.vx, msg.vy, msg.vz).normalize(),
    charge: 0.8, damage: 0, owner: msg.pid, maxRope: 120,
  });
});

net.on('stick', (msg) => {
  const view = game.monsters.get(msg.mid);
  if (view && msg.pid !== game.id) {
    view.tetheredBy = [...new Set([...(view.tetheredBy || []), msg.pid])];
  }
});

net.on('disconnected', () => {
  if (!game.playing) return;
  hud.log('Lost the harbourmaster — trying to raise them again', 'warn');
});

/* ------------------------------------------------------------ overlays */

let flashEl = null;
function flashScreen(strength) {
  if (!flashEl) {
    flashEl = document.createElement('div');
    flashEl.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:30;' +
      'background:radial-gradient(ellipse at center, transparent 35%, rgba(180,40,25,0.75) 100%);opacity:0';
    document.body.appendChild(flashEl);
  }
  flashEl.style.transition = 'none';
  flashEl.style.opacity = String(Math.min(1, strength));
  requestAnimationFrame(() => {
    flashEl.style.transition = 'opacity 620ms ease-out';
    flashEl.style.opacity = '0';
  });
}

function relock() {
  if (!input.touch && game.playing && !hud.dockOpen && !hud.chatOpen) canvas.requestPointerLock?.();
}

/* ----------------------------------------------------------- game loop */

let last = performance.now();
let hudTimer = 0;
let inTown = false;
let frames = 0;
let fpsAcc = 0;

// Exposed for the headless smoke test in tools/smoke.mjs.
window.__debug = { get frames() { return frames; }, game, camera, scene, harpoons, cam, net, hud };

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  game.time += dt;
  frames++;
  fpsAcc += dt;

  if (game.playing) {
    handleHotkeys();
    updateBoat(dt);
    updateHarpoon(dt);
    updatePlayers(dt);
    updateCarcasses();
  }

  // Distant monsters cost a lot of CPU animation for a few pixels; on a phone
  // the horizon ones are not worth it.
  const cullSq = tier.monsterDistance * tier.monsterDistance;
  const camX = camera.position.x, camZ = camera.position.z;

  for (const view of game.monsters.values()) {
    if (view.dying) {
      view.dying += dt * 0.5;
      if (view.dying > 1.6) {
        scene.remove(view.root);
        view.dispose();
        game.monsters.delete(view.id);
        continue;
      }
    }
    const dx = view.x - camX, dz = view.z - camZ;
    const far = dx * dx + dz * dz > cullSq;
    view.root.visible = !far;
    // Still stepped if it is on our rope, because the tether reads its body.
    if (far && !harpoons.tethers.some((t) => t.view === view)) continue;
    view.update(dt, game.time);
  }
  updateRemoteRopes();

  updateCamera(dt);
  ocean.update(game.time, camera);
  edge.uniforms.uTime.value = game.time;
  town.update(dt, game.time, particles);
  particles.update(dt, game.time);

  resolution.update(dt);
  hudTimer += dt;
  if (game.playing && hudTimer > 0.1) {
    hudTimer = 0;
    updateHudSlow();
    window.__frames = frames;
    window.__debug.fps = fpsAcc > 0 ? Math.round(frames / fpsAcc) : 0;
    window.__debug.monsters = game.monsters.size;
    window.__debug.players = game.players.size;
    window.__debug.distance = game.travelled;
    window.__debug.speed = game.peakSpeed;
    window.__debug.tethered = harpoons.tethers.length;
    window.__debug.tier = tier.name;
    window.__debug.pixelScale = +resolution.scale.toFixed(2);
    window.__debug.touch = input.touch;
    window.__debug.self = game.self;
  }

  renderer.render(scene, camera);
  input.endFrame();
}

function handleHotkeys() {
  if (input.once('Tab')) hud.toggleLeaderboard();
  if (input.once('KeyT') && !hud.chatOpen) {
    input.typing = true;
    hud.openChat();
  }
  if (input.once('Escape')) {
    if (hud.chatOpen) hud.closeChat();
    else if (hud.dockOpen) { hud.closeDock(); }
  }
  if (input.once('KeyE')) {
    if (hud.dockOpen) { hud.closeDock(); relock(); }
    else if (inTown && !game.self?.dead) { hud.openDock(); audio.bell(); }
  }
}

function updateHudSlow() {
  const b = game.boat;
  if (!b || !game.self) return;

  hud.setCharge(game.charge);
  hud.setSpeed(Math.abs(b.speed) * 1.94);

  const d = Math.hypot(b.x, b.z);
  const wasInTown = inTown;
  inTown = d < WORLD.townRadius;
  if (inTown && !wasInTown) hud.log('Port Kelder — press E to trade', 'ok');

  document.getElementById('minimap-depth').textContent = depthLabel(d);

  input.setDockPrompt?.(inTown && !game.self.dead && !hud.dockOpen);

  if (game.self.dead) hud.setPrompt(null);
  else if (input.touch) hud.setPrompt(null);
  else if (inTown) hud.setPrompt('<b>E</b> — the fish market, the chandler, the shipwright');
  else if (harpoons.tether) hud.setPrompt('<b>R</b> or right-click — winch it in &nbsp; <b>C</b> — cut it loose');
  else if (game.self.cargo.length) hud.setPrompt('Hold has catch — <b>sail home</b> to sell it');
  else hud.setPrompt(null);

  // Target readout for whatever is on the rope, or whatever we are aiming at.
  const t = harpoons.tether;
  const spec = BOATS[b.tier];
  let show = t ? t.view : (input.aimAssist ? assistTarget(spec.rope * 1.15) : nearestAimed());
  if (show) {
    const head = show.hitSpheresWorld[0].pos;
    const screen = toScreen(_tmp.copy(head).add(new THREE.Vector3(0, show.type.size * 3.4, 0)));
    hud.setTarget(show.type.name, show.hp, screen);
    hud.setLocked(!!t || (input.aimAssist && !!show));
  } else {
    hud.setTarget('', 0, null);
    hud.setLocked(false);
  }

  const monsters = [];
  for (const view of game.monsters.values()) {
    monsters.push({ id: view.id, x: view.x, z: view.z, kind: view.type.id, hunting: view.state > 0 });
  }
  const players = [...game.players.values()].map((p) => ({ x: p.x, z: p.z }));
  minimap.draw({
    me: { x: b.x, z: b.z }, heading: b.h, monsters, players,
    tetherId: t ? t.view.id : -1,
  });

  if (!hud.leaderboardOpen) return;
  const rows = [...game.players.values()]
    .map((p) => ({ id: 0, name: p.name, tier: p.tier, level: p.lv || 1 }))
    .concat([{ id: game.id, name: game.self.name, tier: game.self.tier, level: game.self.level }])
    .sort((a, b2) => b2.tier - a.tier || b2.level - a.level);
  hud.setLeaderboard(rows, game.id);
}

/** The monster closest to the middle of the screen, for the target readout. */
function nearestAimed() {
  const dir = aimDirection();
  const origin = camera.position;
  let best = null, bestScore = 0.985;
  for (const view of game.monsters.values()) {
    if (view.dying) continue;
    const to = _tmp.copy(view.hitSpheresWorld[0].pos).sub(origin);
    const dist = to.length();
    if (dist > 420) continue;
    const score = to.normalize().dot(dir);
    if (score > bestScore) { bestScore = score; best = view; }
  }
  return best;
}

/* --------------------------------------------------------------- boot */

function relayout() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  resolution.apply();
  particles.resize(innerHeight);
}
addEventListener('resize', relayout);
// Phones fire this on rotation before the new size has settled.
addEventListener('orientationchange', () => setTimeout(relayout, 250));

const startBtn = document.getElementById('start-btn');
const nameInput = document.getElementById('name-input');
const statusEl = document.getElementById('start-status');
try { nameInput.value = localStorage.getItem('hh-name') || ''; } catch { /* private mode */ }

// A published single file has no server to talk to, and neither does a page
// opened straight off disk. Both play solo, with the world running in the tab.
const SOLO = window.__SOLO_BUILD__ === true
  || new URLSearchParams(location.search).has('solo')
  || location.protocol === 'file:';

async function begin() {
  const name = (nameInput.value || '').trim().slice(0, 16);
  startBtn.disabled = true;
  statusEl.textContent = '';
  try { localStorage.setItem('hh-name', name); } catch { /* private mode */ }

  let solo = SOLO;
  if (!solo) {
    try {
      await net.connect(name);
    } catch {
      // Nobody answered. Rather than dead-ending the player on an error
      // message, put them to sea on their own.
      solo = true;
    }
  }
  if (solo) await net.connectSolo(name, attachSoloWorld);
  audio.start();
  // Fire and forget: fullscreen and the wake lock are courtesies, and on some
  // browsers the wake-lock promise simply never settles on a hidden page.
  goImmersive(document.documentElement).then(relayout, relayout);
  relayout();
  document.getElementById('start').hidden = true;
  hud.show();
  game.playing = true;
  relock();
  hud.log('Weigh anchor. Something is out there.', 'info');
  if (net.solo) hud.log('Solo sea — the world is running in this tab', 'info');
}

startBtn.onclick = begin;
nameInput.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Enter') begin();
});

canvas.addEventListener('click', () => { if (game.playing) relock(); });

// First frame: get the water on screen before the player has even typed a name.
buildOwnBoat(0);
game.self = null;
requestAnimationFrame((t) => {
  last = t;
  document.getElementById('boot').hidden = true;
  frame(t);
});

addEventListener('error', (e) => {
  const fatal = document.getElementById('fatal');
  document.getElementById('fatal-detail').textContent = e.message || String(e.error);
  fatal.hidden = false;
});
