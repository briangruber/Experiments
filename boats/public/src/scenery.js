import * as THREE from 'three';

// An empty horizon reads as a test level. These are the things that make the
// sea around Port Kelder look like somewhere: rock stacks with grass caps and
// pines, and gulls working the harbour.

const mat = (color, extra = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness: 0.92, metalness: 0, flatShading: true, ...extra });

function hash(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/* ----------------------------------------------------------------- islets */

/** A rock stack: undercut cliff, grass cap, a few pines. */
function islet(seed, radius, height) {
  const g = new THREE.Group();

  const RINGS = 5, SPOKES = 11;
  const pos = [];
  const col = [];
  const idx = [];
  const rock = new THREE.Color(0x8a8375);
  const rockDark = new THREE.Color(0x5d5951);
  const grass = new THREE.Color(0x5f9147);

  for (let r = 0; r <= RINGS; r++) {
    const t = r / RINGS;
    // Wider at the waterline, waisted, then flaring to a flat top: the cliff
    // silhouette is the whole point.
    const profile = 1.05 - 0.42 * Math.sin(t * Math.PI * 0.9) - t * 0.12;
    const y = -4 + t * (height + 4);
    for (let s = 0; s < SPOKES; s++) {
      const a = (s / SPOKES) * Math.PI * 2;
      const wob = 0.78 + hash(seed + s * 3.1, r * 2.7) * 0.44;
      const rr = radius * profile * wob;
      pos.push(Math.cos(a) * rr, y + (hash(seed + s, r) - 0.5) * height * 0.14, Math.sin(a) * rr);
      const c = t > 0.88 ? grass : rock.clone().lerp(rockDark, hash(s, r + seed) * 0.7);
      col.push(c.r, c.g, c.b);
    }
  }
  // Cap.
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

  // Pines: two stacked cones and a trunk, which is all a conifer needs at
  // this distance.
  const trunkMat = mat(0x4a3626);
  const needleMat = mat(0x2f6b3d);
  const trees = 2 + Math.floor(hash(seed, 9) * 4);
  for (let i = 0; i < trees; i++) {
    const a = hash(seed + i, 17) * Math.PI * 2;
    const rr = hash(seed + i, 23) * radius * 0.5;
    const h = height * (0.28 + hash(seed + i, 29) * 0.26);
    const tree = new THREE.Group();
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(h * 0.045, h * 0.07, h * 0.38, 5), trunkMat);
    trunk.position.y = h * 0.19;
    const lower = new THREE.Mesh(new THREE.ConeGeometry(h * 0.32, h * 0.62, 7), needleMat);
    lower.position.y = h * 0.55;
    const upper = new THREE.Mesh(new THREE.ConeGeometry(h * 0.22, h * 0.5, 7), needleMat);
    upper.position.y = h * 0.9;
    tree.add(trunk, lower, upper);
    tree.position.set(Math.cos(a) * rr, height - 0.4, Math.sin(a) * rr);
    tree.castShadow = true;
    tree.traverse((o) => { o.castShadow = true; });
    g.add(tree);
  }

  return g;
}

/**
 * Scatter islets around the town: a couple close enough to sail between, the
 * rest as silhouettes on the horizon.
 */
export function createIslets({ count = 9, inner = 340, outer = 1500 } = {}) {
  const group = new THREE.Group();
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + hash(i, 3) * 0.7;
    const r = inner + Math.pow(hash(i, 5), 0.7) * (outer - inner);
    const scale = 0.7 + hash(i, 7) * 1.5;
    const rock = islet(i * 13.7, 26 * scale, 22 * scale);
    rock.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
    rock.rotation.y = hash(i, 11) * 6.28;
    group.add(rock);
  }
  return group;
}

/* ------------------------------------------------------------------ gulls */

function gullGeometry() {
  // Two swept wings and a body, as one small mesh.
  const g = new THREE.BufferGeometry();
  const v = [
    0.30, 0, 0, -0.26, 0, 0,             // body axis
    -0.02, 0.02, 0.62, -0.20, 0.04, 0.30, // right wing
    -0.02, 0.02, -0.62, -0.20, 0.04, -0.30,
  ];
  const idx = [0, 1, 3, 0, 3, 2, 0, 5, 1, 0, 4, 5];
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Gulls circling the harbour. Cheap, and the sound of a place. */
export function createGulls({ count = 14, centre = new THREE.Vector3(0, 0, 120) } = {}) {
  const geo = gullGeometry();
  const mesh = new THREE.InstancedMesh(
    geo,
    new THREE.MeshStandardMaterial({ color: 0xf4f6f8, roughness: 0.9, flatShading: true, side: THREE.DoubleSide }),
    count
  );
  mesh.frustumCulled = false;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

  const birds = [];
  for (let i = 0; i < count; i++) {
    birds.push({
      radius: 28 + hash(i, 31) * 90,
      height: 16 + hash(i, 37) * 34,
      speed: 0.16 + hash(i, 41) * 0.22,
      phase: hash(i, 43) * 6.28,
      flap: 3.5 + hash(i, 47) * 3,
      size: 1.5 + hash(i, 53) * 1.4,
      drift: (hash(i, 59) - 0.5) * 0.4,
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
        const x = centre.x + Math.cos(t) * b.radius;
        const z = centre.z + Math.sin(t) * b.radius * 1.3;
        const y = centre.y + b.height + Math.sin(t * 1.7 + b.phase) * 3.5;
        pos.set(x, y, z);
        fwd.set(-Math.sin(t), 0, Math.cos(t) * 1.3).normalize();
        q.setFromUnitVectors(up.set(1, 0, 0), fwd);
        up.set(0, 1, 0);
        // Wings flap by squashing the span, which at this size reads perfectly.
        const flap = 0.55 + 0.45 * Math.abs(Math.sin(time * b.flap + b.phase));
        scale.set(b.size, b.size, b.size * flap);
        m.compose(pos, q, scale);
        mesh.setMatrixAt(i, m);
      }
      mesh.instanceMatrix.needsUpdate = true;
    },
  };
}

/** A gull sitting on a post, because one of them always is. */
export function createPerchedGull(x, y, z, facing = 0) {
  const g = new THREE.Group();
  const white = mat(0xf4f6f8);
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 6), white);
  body.scale.set(1.5, 1, 1);
  body.position.y = 0.28;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 7, 6), white);
  head.position.set(0.2, 0.5, 0);
  const beak = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.16, 5), mat(0xe8a33d));
  beak.rotation.z = -Math.PI / 2;
  beak.position.set(0.35, 0.49, 0);
  const tail = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.26, 5), mat(0x4a5257));
  tail.rotation.z = Math.PI / 2;
  tail.position.set(-0.34, 0.3, 0);
  g.add(body, head, beak, tail);
  g.position.set(x, y, z);
  g.rotation.y = facing;
  g.traverse((o) => { o.castShadow = true; });
  return g;
}
