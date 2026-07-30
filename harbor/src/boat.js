import * as THREE from 'three';
import { sampleWater } from './waves.js';

// Small white motorboat with wood trim — the craft from the reference frame.

const mat = (color, extra = {}) =>
  new THREE.MeshStandardMaterial({
    color, roughness: 0.55, metalness: 0.05, flatShading: true, ...extra,
  });

function hullGeometry() {
  const NS = 20, NP = 12;
  const len = 5.4, beam = 2.15, depth = 0.78;
  const positions = [];
  const indices = [];
  const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);
  const smoothstep = (t) => { const c = clamp01(t); return c * c * (3 - 2 * c); };

  for (let i = 0; i < NS; i++) {
    const t = i / (NS - 1); // 0 = stern, 1 = bow
    let f;
    if (t < 0.38) f = 0.82 + 0.18 * smoothstep(t / 0.38);
    else f = 0.08 + 0.92 * Math.pow(clamp01(1 - (t - 0.38) / 0.62), 0.7);
    const w = (beam / 2) * f;
    const d = depth * (1 - 0.28 * smoothstep((t - 0.55) / 0.45));
    const sheer = 0.52 + 0.18 * Math.pow(Math.abs(t - 0.42) / 0.58, 1.6);
    const x = (t - 0.5) * len;
    for (let j = 0; j < NP; j++) {
      const s = (j / (NP - 1)) * 2 - 1;
      const z = w * s;
      // Rounded bilge: flatter bottom, soft turn at the chines.
      const bilge = Math.pow(Math.abs(s), 2.8);
      const y = sheer - d * (1 - bilge * 0.92);
      positions.push(x, y, z);
    }
  }
  for (let i = 0; i < NS - 1; i++) {
    for (let j = 0; j < NP - 1; j++) {
      const a = i * NP + j, b = a + 1, c = a + NP, d = c + 1;
      indices.push(a, b, c, b, d, c);
    }
  }
  const centre = positions.length / 3;
  positions.push(-len / 2, 0.2, 0);
  for (let j = 0; j < NP - 1; j++) indices.push(centre, j + 1, j);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return { geo, len, beam };
}

function createCharacter() {
  const g = new THREE.Group();
  const jacket = mat(0x1a3558, { roughness: 0.88 });
  const skin = mat(0xf0c8a8, { roughness: 0.92 });
  const green = mat(0x3ec24c, { roughness: 0.96 });

  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.26, 0.42, 4, 8), jacket);
  body.position.y = 0.52;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 10, 8), skin);
  head.position.y = 1.0;
  // Bright green knit beanie — the read-from-behind cue in the reference.
  const beanie = new THREE.Mesh(
    new THREE.SphereGeometry(0.23, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.58),
    green
  );
  beanie.position.y = 1.08;
  beanie.rotation.x = 0.12;
  const brim = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.035, 6, 14), green);
  brim.rotation.x = Math.PI / 2;
  brim.position.y = 1.02;
  const pom = new THREE.Mesh(new THREE.SphereGeometry(0.065, 6, 6), mat(0x2f9a3a));
  pom.position.y = 1.28;

  for (const side of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.07, 0.32, 3, 6), jacket);
    arm.position.set(0.02, 0.62, side * 0.36);
    arm.rotation.z = side * 0.85;
    arm.rotation.x = 0.25;
    g.add(arm);
  }
  g.add(body, head, beanie, brim, pom);
  return g;
}

export function createBoat() {
  const root = new THREE.Group();
  const mesh = new THREE.Group();
  const { geo, len, beam } = hullGeometry();

  const hull = new THREE.Mesh(geo, mat(0xf7f8fa, { roughness: 0.32 }));
  hull.castShadow = true;
  hull.receiveShadow = true;
  mesh.add(hull);

  // Wood gunwales as two rails along the sheer — not a torus (those read as oars).
  const wood = mat(0xc4894a, { roughness: 0.72 });
  for (const side of [-1, 1]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(len * 0.88, 0.1, 0.12), wood);
    rail.position.set(0.05, 0.58, side * (beam * 0.48));
    rail.castShadow = true;
    mesh.add(rail);
    }
  // Transom wood cap.
  const transom = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.14, beam * 0.85), wood);
  transom.position.set(-len * 0.48, 0.55, 0);
  mesh.add(transom);

  const floor = new THREE.Mesh(
    new THREE.BoxGeometry(3.4, 0.08, 1.45),
    mat(0xd2aa6e, { roughness: 0.82 })
  );
  floor.position.set(-0.15, 0.28, 0);
  mesh.add(floor);

  for (const x of [-0.95, 0.45]) {
    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.12, 1.35), mat(0xb07a3e));
    seat.position.set(x, 0.46, 0);
    mesh.add(seat);
  }

  const bow = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.08, 1.35), mat(0xf0f2f4, { roughness: 0.4 }));
  bow.position.set(1.75, 0.54, 0);
  mesh.add(bow);

  // Cleat on the bow.
  const cleat = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.1, 0.12), wood);
  cleat.position.set(2.05, 0.62, 0);
  mesh.add(cleat);

  const motor = new THREE.Group();
  const cowling = new THREE.Mesh(
    new THREE.BoxGeometry(0.5, 0.62, 0.42),
    mat(0x22262c, { roughness: 0.4, metalness: 0.25 })
  );
  cowling.position.y = 0.52;
  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(0.055, 0.07, 0.85, 6),
    mat(0x3a4048, { metalness: 0.45, roughness: 0.4 })
  );
  shaft.position.y = -0.12;
  const prop = new THREE.Mesh(
    new THREE.BoxGeometry(0.07, 0.32, 0.42),
    mat(0xb0b8c0, { metalness: 0.55, roughness: 0.35 })
  );
  prop.position.set(0, -0.5, 0);
  motor.add(cowling, shaft, prop);
  motor.position.set(-2.65, 0.18, 0);
  mesh.add(motor);

  const character = createCharacter();
  character.position.set(-0.9, 0.38, 0);
  character.rotation.y = Math.PI / 2;
  mesh.add(character);

  mesh.rotation.y = -Math.PI / 2;
  root.add(mesh);

  return {
    root,
    mesh,
    prop,
    x: 0,
    z: 0,
    y: 0,
    heading: 0,
    speed: 0,
    throttle: 0,
    rudder: 0,
    pitch: 0,
    roll: 0,
  };
}

const _w = {};
const MAX_SPEED = 16;
const ACCEL = 9;
const DRAG = 1.8;
const TURN = 1.55;

export function updateBoat(boat, input, dt, time) {
  const throttle = (input.forward ? 1 : 0) - (input.back ? 0.45 : 0);
  const steer = (input.left ? 1 : 0) - (input.right ? 1 : 0);
  boat.throttle += (throttle - boat.throttle) * Math.min(1, dt * 4);
  boat.rudder += (steer - boat.rudder) * Math.min(1, dt * 6);

  const boost = input.boost ? 1.35 : 1;
  boat.speed += boat.throttle * ACCEL * boost * dt;
  boat.speed -= boat.speed * DRAG * dt;
  if (boat.throttle <= 0.05 && !input.back) boat.speed -= boat.speed * 0.8 * dt;
  boat.speed = Math.max(-4, Math.min(MAX_SPEED * boost, boat.speed));

  const turnRate = TURN * (0.35 + 0.65 * Math.min(1, Math.abs(boat.speed) / 8));
  boat.heading += boat.rudder * turnRate * Math.sign(boat.speed || 1) * dt;

  boat.x += Math.sin(boat.heading) * boat.speed * dt;
  boat.z += Math.cos(boat.heading) * boat.speed * dt;

  // Soft world bounds — keep the player near the scenic harbour.
  const r = Math.hypot(boat.x, boat.z);
  if (r > 520) {
    const pull = (r - 520) * 0.4 * dt;
    boat.x -= (boat.x / r) * pull * 40;
    boat.z -= (boat.z / r) * pull * 40;
    boat.speed *= 0.92;
  }

  sampleWater(boat.x, boat.z, time, _w);
  const targetY = _w.y - 0.12;
  boat.y += (targetY - boat.y) * Math.min(1, dt * 8);

  // Attitude: lean into turns, pitch with throttle, settle on wave normal.
  const targetRoll = -boat.rudder * 0.22 - boat.speed * boat.rudder * 0.012;
  const targetPitch = -boat.throttle * 0.08 + Math.min(0.12, boat.speed * 0.008);
  boat.roll += (targetRoll - boat.roll) * Math.min(1, dt * 5);
  boat.pitch += (targetPitch - boat.pitch) * Math.min(1, dt * 4);

  // Wave tilt from surface normal.
  const waveRoll = Math.atan2(_w.nz, _w.ny) * 0.55;
  const wavePitch = Math.atan2(_w.nx, _w.ny) * 0.55;

  boat.root.position.set(boat.x, boat.y, boat.z);
  boat.root.rotation.order = 'YXZ';
  boat.root.rotation.y = boat.heading;
  boat.root.rotation.x = boat.pitch + wavePitch;
  boat.root.rotation.z = boat.roll + waveRoll;

  if (boat.prop) boat.prop.rotation.x += dt * (8 + Math.abs(boat.speed) * 6);
}
