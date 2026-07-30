import * as THREE from 'three';
import { WORLD } from '/shared/config.js';
import { sampleWater } from '/shared/waves.js';

// Port Kelder: the only safe water on the map, and the only place a carcass is
// worth anything. It needs to be visible from a long way out, hence the light.

const mat = (color, extra = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness: 0.9, metalness: 0, flatShading: true, ...extra });

function hash2(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function islandMesh(radius) {
  const RINGS = 26, SPOKES = 56;
  const positions = [];
  const colors = [];
  const indices = [];
  const sand = new THREE.Color(0xd8c79a);
  const grass = new THREE.Color(0x5c7444);
  const rock = new THREE.Color(0x6d6a63);

  for (let r = 0; r <= RINGS; r++) {
    const t = r / RINGS;
    for (let s = 0; s < SPOKES; s++) {
      const a = (s / SPOKES) * Math.PI * 2;
      // A wobbly coastline reads as land; a perfect circle reads as a plate.
      const wob = 0.86 + hash2(Math.cos(a) * 3, Math.sin(a) * 3) * 0.28;
      const rr = t * radius * wob;
      const fall = Math.pow(Math.max(0, 1 - t), 1.7);
      const bumps = (hash2(Math.cos(a) * 7 + t * 5, Math.sin(a) * 7) - 0.5) * 5 * (1 - t);
      const y = -3.5 + fall * 26 + bumps;
      positions.push(Math.cos(a) * rr, y, Math.sin(a) * rr);
      const c = y < 1.6 ? sand : y > 17 ? rock : grass;
      const shade = 0.86 + hash2(rr, a * 4) * 0.28;
      colors.push(c.r * shade, c.g * shade, c.b * shade);
    }
  }
  for (let r = 0; r < RINGS; r++) {
    for (let s = 0; s < SPOKES; s++) {
      const a = r * SPOKES + s;
      const b = r * SPOKES + ((s + 1) % SPOKES);
      const c = a + SPOKES, d = b + SPOKES;
      indices.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, mat(0xffffff, { vertexColors: true, side: THREE.DoubleSide }));
}

function house(w, d, h, wallColor, roofColor) {
  const g = new THREE.Group();
  const walls = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(wallColor));
  walls.position.y = h / 2;
  g.add(walls);
  const roof = new THREE.Mesh(new THREE.CylinderGeometry(0.001, d * 0.78, h * 0.62, 4, 1), mat(roofColor));
  roof.rotation.y = Math.PI / 4;
  roof.position.y = h + h * 0.31;
  roof.scale.x = w / d;
  g.add(roof);
  // Lit windows: the town should look occupied from a mile out.
  const glow = mat(0xffd489, { emissive: 0xffb347, emissiveIntensity: 1.6 });
  for (let i = 0; i < 2; i++) {
    const win = new THREE.Mesh(new THREE.BoxGeometry(w * 0.18, h * 0.22, 0.1), glow);
    win.position.set((i - 0.5) * w * 0.44, h * 0.55, d / 2 + 0.02);
    g.add(win);
  }
  const chimney = new THREE.Mesh(new THREE.BoxGeometry(w * 0.16, h * 0.5, w * 0.16), mat(0x6b5a50));
  chimney.position.set(w * 0.28, h * 1.15, 0);
  g.add(chimney);
  g.userData.chimney = new THREE.Vector3(w * 0.28, h * 1.4, 0);
  return g;
}

export function createTown() {
  const group = new THREE.Group();
  const R = 104;

  const island = islandMesh(R);
  group.add(island);

  // Harbour mouth faces +Z, which is where fresh boats spawn.
  const jettyMat = mat(0x8f7a5e);
  const pilingMat = mat(0x5a4632);
  for (const side of [-1, 1]) {
    const arm = new THREE.Group();
    for (let i = 0; i < 9; i++) {
      const t = i / 8;
      const plank = new THREE.Mesh(new THREE.BoxGeometry(5.5, 1.1, 4.4), jettyMat);
      plank.position.set(side * (18 + t * 24), 1.4 - t * 0.2, 46 + t * 30);
      plank.rotation.y = side * 0.42;
      arm.add(plank);
      const pile = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.6, 7, 6), pilingMat);
      pile.position.set(side * (18 + t * 24), -1.6, 46 + t * 30);
      arm.add(pile);
    }
    group.add(arm);
  }

  // Main pier straight out of the market square.
  for (let i = 0; i < 7; i++) {
    const plank = new THREE.Mesh(new THREE.BoxGeometry(9, 1.1, 6.4), jettyMat);
    plank.position.set(0, 1.5, 34 + i * 6.4);
    group.add(plank);
    for (const s of [-1, 1]) {
      const pile = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.6, 8, 6), pilingMat);
      pile.position.set(s * 3.6, -1.4, 34 + i * 6.4);
      group.add(pile);
    }
  }

  // Town: a market row facing the water, plus houses climbing the hill.
  const chimneys = [];
  const wallColours = [0xd9cbb0, 0xc9b79a, 0xbfae95, 0xd2c3a6];
  const roofColours = [0x8c4a3a, 0x6d4331, 0x9a5a42, 0x5f4a3c];
  const plots = [
    [-24, 26, 9, 8, 7], [-10, 30, 8, 7, 6], [8, 29, 10, 8, 7], [24, 24, 9, 7, 6],
    [-34, 8, 8, 7, 6], [32, 10, 9, 8, 8], [-16, 2, 10, 9, 8], [12, -2, 11, 9, 9],
    [-6, -18, 9, 8, 7], [20, -16, 8, 7, 6], [-28, -12, 9, 8, 7],
  ];
  plots.forEach(([x, z, w, d, h], i) => {
    const b = house(w, d, h, wallColours[i % 4], roofColours[i % 4]);
    const t = Math.hypot(x, z) / R;
    b.position.set(x, -3.5 + Math.pow(Math.max(0, 1 - t), 1.7) * 26 - 0.6, z);
    b.rotation.y = Math.atan2(-x, -z) + (hash2(x, z) - 0.5) * 0.5;
    group.add(b);
    chimneys.push(b.localToWorld(b.userData.chimney.clone()));
  });

  // Warehouse for the fish market, with a big open front.
  const shed = new THREE.Mesh(new THREE.BoxGeometry(26, 11, 14), mat(0x9a8a72));
  shed.position.set(0, 6, 16);
  group.add(shed);

  // Barrels and crates on the quay.
  for (let i = 0; i < 16; i++) {
    const a = hash2(i, 3) * Math.PI * 2;
    const r = 14 + hash2(i, 7) * 18;
    const isBarrel = hash2(i, 11) > 0.5;
    const item = isBarrel
      ? new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 2.1, 8), mat(0x7a5b3a))
      : new THREE.Mesh(new THREE.BoxGeometry(1.9, 1.7, 1.9), mat(0x8b6f4a));
    const x = Math.cos(a) * r, z = Math.abs(Math.sin(a) * r) * 0.8 + 12;
    const t = Math.hypot(x, z) / R;
    item.position.set(x, -3.5 + Math.pow(Math.max(0, 1 - t), 1.7) * 26 + 1, z);
    item.rotation.y = hash2(i, 13) * 3;
    group.add(item);
  }

  // The lighthouse -- your bearing home when the hold is full.
  const lh = new THREE.Group();
  const tower = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 4.4, 30, 12), mat(0xe6e0d2));
  tower.position.y = 15;
  const bands = new THREE.Mesh(new THREE.CylinderGeometry(2.75, 3.3, 7, 12), mat(0xb03f32));
  bands.position.y = 17;
  const gallery = new THREE.Mesh(new THREE.CylinderGeometry(3.6, 3.6, 1.2, 12), mat(0x4a5257));
  gallery.position.y = 30;
  const lampRoom = new THREE.Mesh(
    new THREE.CylinderGeometry(2.4, 2.4, 4.4, 10),
    mat(0xfff0c4, { emissive: 0xffc357, emissiveIntensity: 2.4, transparent: true, opacity: 0.92 })
  );
  lampRoom.position.y = 32.6;
  const cap = new THREE.Mesh(new THREE.ConeGeometry(3.0, 3.2, 10), mat(0x8c3f33));
  cap.position.y = 36.4;
  lh.add(tower, bands, gallery, lampRoom, cap);

  const beam = new THREE.Mesh(
    new THREE.ConeGeometry(6.5, 190, 10, 1, true),
    new THREE.MeshBasicMaterial({
      color: 0xffd489, transparent: true, opacity: 0.10,
      depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    })
  );
  beam.rotation.z = Math.PI / 2 + 0.06;
  beam.position.set(95, 32.6, 0);
  const beamPivot = new THREE.Group();
  beamPivot.add(beam);
  beamPivot.position.y = 0;
  lh.add(beamPivot);

  lh.position.set(-52, 14, -30);
  group.add(lh);

  const lamp = new THREE.PointLight(0xffc357, 220, 260, 2);
  lamp.position.set(-52, 47, -30);
  group.add(lamp);

  // A ring of buoys marking the calm water where monsters will not follow.
  const buoyMat = mat(0xd8503f, { emissive: 0x581a12, emissiveIntensity: 0.4 });
  const buoys = [];
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2;
    const buoy = new THREE.Group();
    const body = new THREE.Mesh(new THREE.SphereGeometry(1.5, 8, 7), buoyMat);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 4, 5), mat(0x2f373d));
    pole.position.y = 2;
    const flag = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.0), mat(0xf2c057, { side: THREE.DoubleSide }));
    flag.position.set(0.8, 3.2, 0);
    buoy.add(body, pole, flag);
    buoy.position.set(Math.cos(a) * WORLD.townRadius, 0, Math.sin(a) * WORLD.townRadius);
    group.add(buoy);
    buoys.push(buoy);
  }

  return {
    group,
    chimneys,
    buoys,
    update(dt, time, particles) {
      beamPivot.rotation.y -= dt * 0.42;
      // The harbour buoys ride the same water everything else does.
      const w = {};
      for (const buoy of buoys) {
        sampleWater(buoy.position.x, buoy.position.z, time, w);
        buoy.position.y = w.y - 0.4;
        buoy.rotation.z = Math.asin(Math.max(-1, Math.min(1, -w.nx))) * 0.6;
        buoy.rotation.x = Math.asin(Math.max(-1, Math.min(1, w.nz))) * 0.6;
      }
      lampRoom.material.emissiveIntensity = 2.0 + Math.sin(time * 2.4) * 0.5;
      if (particles && Math.random() < dt * 9) {
        const c = chimneys[(Math.random() * chimneys.length) | 0];
        particles.smoke(c.x, c.y, c.z, 0x6b6a66, 1);
      }
    },
  };
}
