import * as THREE from 'three';

// Port Cinder: a Wind-Waker / Townscaper harbour — timber houses, green-capped
// cliffs, a lighthouse on its own rock, pines leaning over the water.

const mat = (color, extra = {}) =>
  new THREE.MeshStandardMaterial({
    color, roughness: 0.9, metalness: 0, flatShading: true, ...extra,
  });

function hash(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

export const ISLAND_RADIUS = 96;

export function islandHeight(x, z) {
  const r = Math.hypot(x, z);
  const a = Math.atan2(z, x);
  const wob = 0.84 + hash(Math.cos(a) * 3, Math.sin(a) * 3) * 0.32;
  const t = Math.min(1.25, r / (ISLAND_RADIUS * wob));
  const fall = Math.pow(Math.max(0, 1 - t), 1.65);
  const bumps = (hash(Math.cos(a) * 7 + t * 5, Math.sin(a) * 7) - 0.5) * 5.5 * Math.max(0, 1 - t);
  return -3.2 + fall * 28 + bumps;
}

function islandMesh(radius) {
  const RINGS = 28, SPOKES = 60;
  const positions = [];
  const colors = [];
  const indices = [];
  const sand = new THREE.Color(0xe8d5a4);
  const grass = new THREE.Color(0x4f9a42);
  const grassDark = new THREE.Color(0x3a7a34);
  const rock = new THREE.Color(0x8a8378);
  const rockDark = new THREE.Color(0x5e5950);

  for (let r = 0; r <= RINGS; r++) {
    const t = r / RINGS;
    for (let s = 0; s < SPOKES; s++) {
      const a = (s / SPOKES) * Math.PI * 2;
      const wob = 0.84 + hash(Math.cos(a) * 3, Math.sin(a) * 3) * 0.32;
      const rr = t * radius * wob;
      const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
      const y = islandHeight(x, z);
      positions.push(x, y, z);
      let c;
      if (y < 1.2) c = sand;
      else if (t > 0.92 && y < 8) c = rock.clone().lerp(rockDark, hash(s, r) * 0.6);
      else c = grass.clone().lerp(grassDark, hash(rr, a * 4) * 0.45);
      const shade = 0.88 + hash(rr, a * 5) * 0.24;
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

/** Tudor / timber-frame house with gabled roof and optional timber beams. */
function house(w, d, h, wallColor, roofColor, timber = true) {
  const g = new THREE.Group();
  const plaster = mat(wallColor);
  const wood = mat(0x4a3424);
  const roofM = mat(roofColor);

  const walls = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), plaster);
  walls.position.y = h / 2;
  g.add(walls);

  if (timber) {
    // Cross-beams and corner posts so it reads as a half-timber cottage.
    const beamT = 0.18;
    for (const sx of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(beamT, h, beamT), wood);
      post.position.set(sx * (w / 2 - 0.05), h / 2, d / 2 + 0.02);
      g.add(post);
    }
    const mid = new THREE.Mesh(new THREE.BoxGeometry(w * 0.92, beamT, beamT), wood);
    mid.position.set(0, h * 0.55, d / 2 + 0.03);
    g.add(mid);
    // Diagonal braces.
    for (const side of [-1, 1]) {
      const brace = new THREE.Mesh(new THREE.BoxGeometry(w * 0.42, beamT * 0.85, beamT * 0.7), wood);
      brace.position.set(side * w * 0.22, h * 0.32, d / 2 + 0.04);
      brace.rotation.z = side * 0.55;
      g.add(brace);
    }
  }

  // Gabled roof from a pyramid stretched to a ridge.
  const roof = new THREE.Mesh(new THREE.ConeGeometry(d * 0.72, h * 0.7, 4), roofM);
  roof.rotation.y = Math.PI / 4;
  roof.position.y = h + h * 0.32;
  roof.scale.x = (w / d) * 1.05;
  g.add(roof);

  // Round attic window.
  const round = new THREE.Mesh(
    new THREE.CircleGeometry(Math.min(w, d) * 0.12, 12),
    mat(0x87ceeb, { emissive: 0x3a6080, emissiveIntensity: 0.35 })
  );
  round.position.set(0, h * 0.72, d / 2 + 0.06);
  g.add(round);

  // Flower box.
  const box = new THREE.Mesh(new THREE.BoxGeometry(w * 0.45, 0.22, 0.28), mat(0x6b4a32));
  box.position.set(0, h * 0.38, d / 2 + 0.2);
  g.add(box);
  for (let i = 0; i < 4; i++) {
    const flower = new THREE.Mesh(
      new THREE.SphereGeometry(0.12, 6, 5),
      mat([0xe85d75, 0xf2c14e, 0xd94f70, 0xf0a0b8][i])
    );
    flower.position.set((i - 1.5) * 0.22, h * 0.5, d / 2 + 0.22);
    g.add(flower);
  }

  // Chimney.
  const chimney = new THREE.Mesh(new THREE.BoxGeometry(w * 0.16, h * 0.55, w * 0.16), mat(0x7a5a4a));
  chimney.position.set(w * 0.28, h * 1.2, -d * 0.1);
  g.add(chimney);

  return g;
}

function pine(h) {
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(h * 0.04, h * 0.07, h * 0.35, 5),
    mat(0x4a3626)
  );
  trunk.position.y = h * 0.18;
  const lower = new THREE.Mesh(new THREE.ConeGeometry(h * 0.34, h * 0.58, 7), mat(0x2a6b38));
  lower.position.y = h * 0.52;
  const upper = new THREE.Mesh(new THREE.ConeGeometry(h * 0.22, h * 0.48, 7), mat(0x348045));
  upper.position.y = h * 0.88;
  g.add(trunk, lower, upper);
  g.traverse((o) => { o.castShadow = true; });
  return g;
}

/** Jagged sea stack: undercut rock, bright grass cap, pines. */
export function createCliff(seed, radius, height) {
  const g = new THREE.Group();
  const RINGS = 6, SPOKES = 12;
  const pos = [];
  const col = [];
  const idx = [];
  const rock = new THREE.Color(0x9a9184);
  const rockDark = new THREE.Color(0x625c52);
  const grass = new THREE.Color(0x4f9a42);

  for (let r = 0; r <= RINGS; r++) {
    const t = r / RINGS;
    // Wider at waterline, waisted mid, flaring to flat green top.
    const profile = 1.08 - 0.48 * Math.sin(t * Math.PI * 0.92) - t * 0.1;
    const y = -5 + t * (height + 5);
    for (let s = 0; s < SPOKES; s++) {
      const a = (s / SPOKES) * Math.PI * 2;
      const wob = 0.72 + hash(seed + s * 3.1, r * 2.7) * 0.5;
      const rr = radius * profile * wob;
      pos.push(Math.cos(a) * rr, y + (hash(seed + s, r) - 0.5) * height * 0.12, Math.sin(a) * rr);
      const c = t > 0.86 ? grass : rock.clone().lerp(rockDark, hash(s, r + seed) * 0.65);
      col.push(c.r, c.g, c.b);
    }
  }
  const capIndex = pos.length / 3;
  pos.push(0, height, 0);
  col.push(grass.r, grass.g, grass.b);

  for (let r = 0; r < RINGS; r++) {
    for (let s = 0; s < SPOKES; s++) {
      const a = r * SPOKES + s;
      const b = r * SPOKES + ((s + 1) % SPOKES);
      idx.push(a, a + SPOKES, b, b, a + SPOKES, b + SPOKES);
    }
  }
  for (let s = 0; s < SPOKES; s++) {
    idx.push(RINGS * SPOKES + s, capIndex, RINGS * SPOKES + ((s + 1) % SPOKES));
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const rockMesh = new THREE.Mesh(geo, mat(0xffffff, { vertexColors: true }));
  rockMesh.castShadow = true;
  rockMesh.receiveShadow = true;
  g.add(rockMesh);

  const trees = 2 + Math.floor(hash(seed, 9) * 5);
  for (let i = 0; i < trees; i++) {
    const a = hash(seed + i, 17) * Math.PI * 2;
    const rr = hash(seed + i, 23) * radius * 0.45;
    const th = height * (0.26 + hash(seed + i, 29) * 0.28);
    const tree = pine(th);
    tree.position.set(Math.cos(a) * rr, height - 0.3, Math.sin(a) * rr);
    g.add(tree);
  }
  return g;
}

function createLighthouse() {
  const lh = new THREE.Group();
  // White/tan tower with dark lantern — matching the reference silhouette.
  const base = new THREE.Mesh(new THREE.CylinderGeometry(3.4, 4.6, 4, 12), mat(0xc4b49a));
  base.position.y = 2;
  const tower = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 3.2, 26, 12), mat(0xf2efe6));
  tower.position.y = 17;
  const band = new THREE.Mesh(new THREE.CylinderGeometry(2.55, 2.9, 5, 12), mat(0xd4c4a8));
  band.position.y = 14;
  const gallery = new THREE.Mesh(new THREE.CylinderGeometry(3.4, 3.4, 1.0, 12), mat(0x3a4048));
  gallery.position.y = 30.2;
  const lamp = new THREE.Mesh(
    new THREE.CylinderGeometry(2.1, 2.1, 3.8, 10),
    mat(0xfff2c8, { emissive: 0xffc857, emissiveIntensity: 1.8, transparent: true, opacity: 0.9 })
  );
  lamp.position.y = 32.6;
  const cap = new THREE.Mesh(new THREE.ConeGeometry(2.8, 2.8, 10), mat(0x2a3038));
  cap.position.y = 35.8;
  lh.add(base, tower, band, gallery, lamp, cap);

  // Rail posts around the gallery.
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.15, 1.1, 0.15), mat(0x2a3038));
    post.position.set(Math.cos(a) * 3.1, 31.0, Math.sin(a) * 3.1);
    lh.add(post);
  }
  return lh;
}

export function createWorld() {
  const group = new THREE.Group();
  const R = ISLAND_RADIUS;

  const island = islandMesh(R);
  island.castShadow = true;
  island.receiveShadow = true;
  group.add(island);

  // Wooden harbour piers reaching into clear water.
  const jettyMat = mat(0x9a7d58);
  const pilingMat = mat(0x5a4632);
  for (const side of [-1, 1]) {
    for (let i = 0; i < 8; i++) {
      const t = i / 7;
      const plank = new THREE.Mesh(new THREE.BoxGeometry(5.2, 1.0, 4.2), jettyMat);
      plank.position.set(side * (18 + t * 24), 1.4, 78 + t * 52);
      plank.rotation.y = side * 0.4;
      plank.castShadow = true;
      plank.receiveShadow = true;
      group.add(plank);
      const pile = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.55, 7, 6), pilingMat);
      pile.position.set(side * (18 + t * 24), -1.8, 78 + t * 52);
      group.add(pile);
    }
  }
  for (let i = 0; i < 12; i++) {
    const z = 64 + i * 6.2;
    const plank = new THREE.Mesh(new THREE.BoxGeometry(8.5, 1.0, 6.2), jettyMat);
    plank.position.set(0, 1.4, z);
    plank.castShadow = true;
    plank.receiveShadow = true;
    group.add(plank);
    for (const s of [-1, 1]) {
      const pile = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.55, 8.5, 6), pilingMat);
      pile.position.set(s * 3.4, -2.0, z);
      group.add(pile);
    }
  }
  // Pier head.
  {
    const head = new THREE.Mesh(new THREE.BoxGeometry(13, 1.0, 8), jettyMat);
    head.position.set(0, 1.4, 140);
    head.castShadow = true;
    group.add(head);
  }

  // Bollards, barrels, crates.
  for (const [bx, bz] of [[-3.2, 92], [3.2, 92], [-4.8, 136], [4.8, 136]]) {
    const bollard = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.46, 1.4, 8), mat(0x6b5a45));
    bollard.position.set(bx, 2.4, bz);
    group.add(bollard);
  }
  for (let i = 0; i < 14; i++) {
    const a = hash(i, 3) * Math.PI;
    const r = 12 + hash(i, 7) * 22;
    const isBarrel = hash(i, 11) > 0.45;
    const item = isBarrel
      ? new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.85, 2.0, 8), mat(0x7a5b3a))
      : new THREE.Mesh(new THREE.BoxGeometry(1.7, 1.5, 1.7), mat(0x8b6f4a));
    const x = Math.cos(a) * r * (hash(i, 4) > 0.5 ? 1 : -1);
    const z = 55 + Math.abs(Math.sin(a) * r) * 0.9;
    item.position.set(x, islandHeight(x, z) + 1, z);
    item.rotation.y = hash(i, 13) * 3;
    item.castShadow = true;
    group.add(item);
  }

  // Market row + hillside cottages — red & blue roofs like the reference.
  const wallColours = [0xf5ead2, 0xefe0c4, 0xf8f0dc, 0xe8d8b8];
  const roofColours = [0xc4452f, 0x3a7a9a, 0xb83a2a, 0x2f6f8a, 0xd45535, 0x4a8aaa];
  const plots = [
    [-22, 28, 9, 8, 7], [-8, 32, 8, 7, 6.5], [10, 30, 10, 8, 7.5], [24, 25, 9, 7, 6.5],
    [-32, 10, 8, 7, 6], [30, 12, 9, 8, 8], [-14, 4, 10, 9, 8], [14, 0, 11, 9, 9],
    [-4, -16, 9, 8, 7], [22, -14, 8, 7, 6.5], [-26, -8, 9, 8, 7],
    [-18, 42, 7, 6, 5.5], [6, 44, 8, 7, 6],
  ];
  plots.forEach(([x, z, w, d, h], i) => {
    const b = house(w, d, h, wallColours[i % 4], roofColours[i % roofColours.length]);
    b.position.set(x, islandHeight(x, z) - 0.5, z);
    b.rotation.y = Math.atan2(-x, -z) + (hash(x, z) - 0.5) * 0.45;
    b.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    group.add(b);
  });

  // Tavern sign.
  {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, 4.5, 6), mat(0x5a4030));
    post.position.set(-6, islandHeight(-6, 48) + 2.2, 48);
    const sign = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.4, 0.15), mat(0x8b3a2a));
    sign.position.set(-6, islandHeight(-6, 48) + 3.8, 48.2);
    group.add(post, sign);
  }

  // Pines on the island hill.
  for (let i = 0; i < 28; i++) {
    const a = hash(i, 40) * Math.PI * 2;
    const r = 18 + hash(i, 41) * 55;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const y = islandHeight(x, z);
    if (y < 6) continue;
    const tree = pine(5 + hash(i, 42) * 7);
    tree.position.set(x, y - 0.2, z);
    group.add(tree);
  }

  // Lighthouse on its own rocky islet (mid-ground right of harbour mouth).
  const lhRock = createCliff(77, 18, 16);
  lhRock.position.set(72, 0, 40);
  lhRock.rotation.y = 0.8;
  group.add(lhRock);
  const lh = createLighthouse();
  lh.position.set(72, 14, 40);
  lh.scale.setScalar(0.85);
  lh.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  group.add(lh);

  // Scattered sea stacks / islets around the harbour.
  const stacks = [
    { x: -90, z: 160, r: 22, h: 28, s: 11 },
    { x: 110, z: 180, r: 28, h: 34, s: 22 },
    { x: 160, z: 80, r: 20, h: 24, s: 33 },
    { x: -140, z: 60, r: 32, h: 40, s: 44 },
    { x: 40, z: 260, r: 24, h: 30, s: 55 },
    { x: -60, z: 300, r: 36, h: 42, s: 66 },
    { x: 200, z: 200, r: 26, h: 36, s: 77 },
    { x: -200, z: 220, r: 30, h: 38, s: 88 },
    { x: 130, z: -40, r: 18, h: 22, s: 99 },
    { x: -170, z: -20, r: 22, h: 26, s: 111 },
  ];
  for (const st of stacks) {
    const cliff = createCliff(st.s, st.r, st.h);
    cliff.position.set(st.x, 0, st.z);
    cliff.rotation.y = hash(st.s, 3) * 6.28;
    group.add(cliff);
  }

  // Distant mountain ring for depth.
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 + 0.3;
    const r = 480 + hash(i, 90) * 220;
    const cliff = createCliff(i * 17.3, 40 + hash(i, 91) * 35, 50 + hash(i, 92) * 45);
    cliff.position.set(Math.cos(a) * r, -2, Math.sin(a) * r);
    cliff.rotation.y = a;
    group.add(cliff);
  }

  return {
    group,
    spawn: { x: 8, z: 210, heading: Math.PI }, // facing the harbour
    lighthouse: { x: 72, z: 40 },
  };
}

/** Simple circling gulls for life in the air. */
export function createGulls({ count = 12, centre = new THREE.Vector3(0, 0, 100) } = {}) {
  const geo = new THREE.BufferGeometry();
  const v = [
    0.30, 0, 0, -0.26, 0, 0,
    -0.02, 0.02, 0.62, -0.20, 0.04, 0.30,
    -0.02, 0.02, -0.62, -0.20, 0.04, -0.30,
  ];
  geo.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  geo.setIndex([0, 1, 3, 0, 3, 2, 0, 5, 1, 0, 4, 5]);
  geo.computeVertexNormals();

  const mesh = new THREE.InstancedMesh(
    geo,
    new THREE.MeshStandardMaterial({
      color: 0xf4f6f8, roughness: 0.9, flatShading: true, side: THREE.DoubleSide,
    }),
    count
  );
  mesh.frustumCulled = false;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

  const birds = [];
  for (let i = 0; i < count; i++) {
    birds.push({
      radius: 30 + hash(i, 31) * 85,
      height: 18 + hash(i, 37) * 32,
      speed: 0.15 + hash(i, 41) * 0.22,
      phase: hash(i, 43) * 6.28,
      flap: 3.5 + hash(i, 47) * 3,
      size: 1.5 + hash(i, 53) * 1.3,
    });
  }

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);

  return {
    mesh,
    update(time) {
      for (let i = 0; i < birds.length; i++) {
        const b = birds[i];
        const t = time * b.speed + b.phase;
        pos.set(
          centre.x + Math.cos(t) * b.radius,
          centre.y + b.height + Math.sin(t * 1.7 + b.phase) * 3.2,
          centre.z + Math.sin(t) * b.radius * 1.25
        );
        fwd.set(-Math.sin(t), 0, Math.cos(t) * 1.25).normalize();
        up.set(1, 0, 0);
        q.setFromUnitVectors(up, fwd);
        const flap = 0.55 + 0.45 * Math.abs(Math.sin(time * b.flap + b.phase));
        scale.set(b.size, b.size, b.size * flap);
        m.compose(pos, q, scale);
        mesh.setMatrixAt(i, m);
      }
      mesh.instanceMatrix.needsUpdate = true;
    },
  };
}
