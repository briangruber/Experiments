import * as THREE from 'three';
import { sampleWater } from './waves.js';

// Small white motorboat with wood trim — the craft from the reference frame.

const mat = (color, extra = {}) =>
  new THREE.MeshStandardMaterial({
    color, roughness: 0.55, metalness: 0.05, flatShading: true, ...extra,
  });

function hullGeometry() {
  const NS = 18, NP = 11;
  const len = 5.2, beam = 2.0, depth = 0.85;
  const positions = [];
  const indices = [];
  const smoothstep = (t) => {
    const c = t < 0 ? 0 : t > 1 ? 1 : t;
    return c * c * (3 - 2 * c);
  };

  for (let i = 0; i < NS; i++) {
    const t = i / (NS - 1); // 0 = stern, 1 = bow
    let f;
    if (t < 0.35) f = 0.78 + 0.22 * smoothstep(t / 0.35);
    else f = 0.12 + 0.88 * Math.pow(Math.max(0, 1 - (t - 0.35) / 0.65), 0.75);
    const w = (beam / 2) * f;
    const d = depth * (1 - 0.35 * smoothstep((t - 0.55) / 0.45));
    const sheer = depth * (0.12 + 0.22 * Math.pow(Math.abs(t - 0.4) / 0.6, 1.8));
    const x = (t - 0.5) * len;
    for (let j = 0; j < NP; j++) {
      const s = (j / (NP - 1)) * 2 - 1;
      const z = w * s;
      const y = sheer - d * (1 - Math.pow(Math.abs(s), 2.4));
      positions.push(x, y, z);
    }
  }
  for (let i = 0; i < NS - 1; i++) {
    for (let j = 0; j < NP - 1; j++) {
      const a = i * NP + j, b = a + 1, c = a + NP, d = c + 1;
      indices.push(a, b, c, b, d, c);
    }
  }
  // Transom fill.
  const centre = positions.length / 3;
  positions.push(-len / 2, 0.15, 0);
  for (let j = 0; j < NP - 1; j++) indices.push(centre, j + 1, j);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

function createCharacter() {
  const g = new THREE.Group();
  // Dark blue jacket.
  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.28, 0.45, 4, 8),
    mat(0x1e3a5f, { roughness: 0.85 })
  );
  body.position.y = 0.55;
  // Head.
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 8), mat(0xf0c8a8, { roughness: 0.9 }));
  head.position.y = 1.05;
  // Bright green beanie — the silhouette cue from the reference.
  const beanie = new THREE.Mesh(
    new THREE.SphereGeometry(0.24, 10, 8, 0, Math.PI * 2, 0, Math.PI * 0.55),
    mat(0x3db84a, { roughness: 0.95 })
  );
  beanie.position.y = 1.14;
  beanie.rotation.x = 0.15;
  const pom = new THREE.Mesh(new THREE.SphereGeometry(0.07, 6, 6), mat(0x2f9a3a));
  pom.position.y = 1.32;
  // Simple arms resting on gunwales.
  const armM = mat(0x1e3a5f, { roughness: 0.85 });
  for (const side of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.08, 0.35, 3, 6), armM);
    arm.position.set(0.05, 0.65, side * 0.38);
    arm.rotation.z = side * 0.9;
    arm.rotation.x = 0.3;
    g.add(arm);
  }
  g.add(body, head, beanie, pom);
  return g;
}

export function createBoat() {
  const root = new THREE.Group();
  const mesh = new THREE.Group();

  const hull = new THREE.Mesh(hullGeometry(), mat(0xf4f6f8, { roughness: 0.35 }));
  hull.castShadow = true;
  hull.receiveShadow = true;
  mesh.add(hull);

  // Wood gunwale trim.
  const trim = new THREE.Mesh(
    new THREE.TorusGeometry(1.85, 0.07, 6, 28, Math.PI),
    mat(0xb8894a, { roughness: 0.7 })
  );
  trim.rotation.x = Math.PI / 2;
  trim.rotation.z = Math.PI / 2;
  trim.position.set(0.15, 0.55, 0);
  trim.scale.set(1.35, 0.55, 1);
  mesh.add(trim);

  // Flat cockpit floor.
  const floor = new THREE.Mesh(
    new THREE.BoxGeometry(3.6, 0.08, 1.5),
    mat(0xc4a06a, { roughness: 0.8 })
  );
  floor.position.set(-0.1, 0.22, 0);
  mesh.add(floor);

  // Bench seats.
  for (const x of [-0.9, 0.5]) {
    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.12, 1.4), mat(0xa87840));
    seat.position.set(x, 0.42, 0);
    mesh.add(seat);
  }

  // Bow deck plate.
  const bow = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.1, 1.5), mat(0xeceff2, { roughness: 0.4 }));
  bow.position.set(1.7, 0.48, 0);
  mesh.add(bow);

  // Outboard motor.
  const motor = new THREE.Group();
  const cowling = new THREE.Mesh(
    new THREE.BoxGeometry(0.55, 0.7, 0.5),
    mat(0x2a2e34, { roughness: 0.45, metalness: 0.2 })
  );
  cowling.position.y = 0.55;
  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(0.06, 0.08, 0.9, 6),
    mat(0x3a4048, { metalness: 0.4, roughness: 0.4 })
  );
  shaft.position.y = -0.15;
  const prop = new THREE.Mesh(
    new THREE.BoxGeometry(0.08, 0.35, 0.5),
    mat(0xb0b8c0, { metalness: 0.5, roughness: 0.35 })
  );
  prop.position.set(0, -0.55, 0);
  motor.add(cowling, shaft, prop);
  motor.position.set(-2.55, 0.15, 0);
  mesh.add(motor);
  mesh.userData.prop = prop;

  // Character in the aft seat.
  const character = createCharacter();
  character.position.set(-0.85, 0.35, 0);
  character.rotation.y = Math.PI / 2; // facing forward (+X)
  mesh.add(character);

  // Forward is +X in boat local space; heading 0 faces +Z world after yaw.
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
