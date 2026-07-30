import * as THREE from 'three';
import { seabedHeight, seabedGLSL, LAGOON } from '/shared/seabed.js';
import { SUN_DIR } from './sea.js';

// Everything you can see through the water near town: the sand, the reef, the
// light moving on the bottom, and the fish that make the lagoon feel alive
// rather than merely clear.

const SAND = new THREE.Color(0xe4d3a6);
const SAND_DEEP = new THREE.Color(0xb9ab86);
const CORAL = new THREE.Color(0xc9705c);
const WEED = new THREE.Color(0x4f6b4a);
const ROCK = new THREE.Color(0x50565c);
const ABYSS = new THREE.Color(0x080d14);

function hash(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/* ------------------------------------------------------------------ floor */

export function createSeabed({ segments = 120, spokes = 128 } = {}) {
  const positions = [];
  const colors = [];
  const indices = [];
  const outer = LAGOON.deep + 260;

  for (let ring = 0; ring <= segments; ring++) {
    // Rings bunch up where the interesting geometry is: the reef and the brink.
    const t = ring / segments;
    const r = 40 + Math.pow(t, 1.7) * (outer - 40);
    for (let s = 0; s < spokes; s++) {
      const a = (s / spokes) * Math.PI * 2;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const y = seabedHeight(x, z);
      positions.push(x, y, z);

      // Colour by depth and a little by chance: sand, then coral on the reef,
      // then rock, then nothing worth seeing.
      const c = new THREE.Color();
      const depth = -y;
      if (depth < 6) c.copy(SAND).lerp(SAND_DEEP, depth / 6);
      else if (depth < 12) c.copy(SAND_DEEP).lerp(ROCK, (depth - 6) / 6);
      else c.copy(ROCK).lerp(ABYSS, Math.min(1, (depth - 12) / 40));

      const patch = hash(Math.floor(x * 0.12), Math.floor(z * 0.12));
      if (r > LAGOON.flat - 50 && r < LAGOON.brink && patch > 0.72) {
        c.lerp(patch > 0.88 ? CORAL : WEED, 0.55);
      }
      const shade = 0.88 + hash(x * 0.7, z * 0.7) * 0.24;
      colors.push(c.r * shade, c.g * shade, c.b * shade);
    }
  }

  for (let ring = 0; ring < segments; ring++) {
    for (let s = 0; s < spokes; s++) {
      const a = ring * spokes + s;
      const b = ring * spokes + ((s + 1) % spokes);
      const c = a + spokes, d = b + spokes;
      indices.push(a, c, b, b, c, d);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();

  const uniforms = {
    uTime: { value: 0 },
    uSun: { value: SUN_DIR },
    uCamera: { value: new THREE.Vector3() },
  };

  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */`
      precision highp float;
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying vec3 vColor;
      void main() {
        vColor = color;
        vNormal = normalize(normalMatrix * normal);
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }`,
    fragmentShader: /* glsl */`
      precision highp float;
      uniform float uTime;
      uniform vec3 uSun;
      uniform vec3 uCamera;
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying vec3 vColor;
      ${seabedGLSL()}

      // Sunlight focused by the moving surface. Two counter-rotating layers of
      // cheap cellular noise get most of the way there.
      float caustic(vec2 p, float t) {
        float v = 0.0;
        for (int i = 0; i < 2; i++) {
          float fi = float(i);
          vec2 q = p * (0.9 + fi * 0.55) + vec2(t * (0.35 + fi * 0.2), -t * (0.28 - fi * 0.12));
          float a = sin(q.x + sin(q.y * 1.3)) * cos(q.y - cos(q.x * 1.1));
          v += a * a;
        }
        return pow(clamp(v * 0.5, 0.0, 1.0), 2.2);
      }

      void main() {
        vec3 n = normalize(vNormal);
        float depth = max(0.0, -vWorld.y);
        float lambert = max(dot(n, uSun), 0.0) * 0.7 + 0.3;

        // Light that reaches this depth at all.
        float light = exp(-depth * 0.055);
        vec3 col = vColor * lambert * mix(0.30, 1.35, light);

        // Caustics only where the water is shallow enough to focus them.
        float caus = caustic(vWorld.xz * 0.5, uTime) * light * 1.5;
        col += vec3(0.60, 0.92, 0.84) * caus * 0.7;

        // Water column between the eye and the floor. Kept deliberately thin
        // in the shallows: the whole point of the lagoon is that you can count
        // the fish from the pier, so this only really bites once the bottom
        // drops away.
        float dist = length(uCamera - vWorld);
        float haze = 1.0 - exp(-dist * mix(0.048, 0.0075, light));
        vec3 water = mix(vec3(0.11, 0.45, 0.46), vec3(0.02, 0.09, 0.15), 1.0 - light);
        col = mix(col, water, clamp(haze, 0.0, 0.92));

        gl_FragColor = vec4(col, 1.0);
      }`,
    vertexColors: true,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = -20;          // under the transparent water
  mesh.frustumCulled = false;

  return {
    mesh,
    update(time, camera) {
      uniforms.uTime.value = time;
      uniforms.uCamera.value.copy(camera.position);
    },
  };
}

/* ------------------------------------------------------------------ coral */

/** Coral heads and boulders scattered over the reef, so it has silhouette. */
export function createReefProps({ count = 220 } = {}) {
  const group = new THREE.Group();
  // Height of each shape in local units, so a prop can be sunk by its own size
  // rather than poking out of the lagoon like a traffic cone.
  const shapes = [
    { geo: new THREE.ConeGeometry(1, 2.2, 6), h: 2.2 },
    { geo: new THREE.SphereGeometry(1, 7, 5), h: 2.0 },
    { geo: new THREE.CylinderGeometry(0.35, 0.9, 2.6, 6), h: 2.6 },
  ];
  const buckets = shapes.map((shape) => {
    // White base: the per-instance colour is the colour, not a tint on top of
    // another one.
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true });
    const inst = new THREE.InstancedMesh(shape.geo, mat, Math.ceil(count / shapes.length));
    inst.frustumCulled = false;
    inst.count = 0;
    inst.userData.h = shape.h;
    group.add(inst);
    return inst;
  });

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const colour = new THREE.Color();

  for (let i = 0; i < count; i++) {
    const a = hash(i, 3) * Math.PI * 2;
    const r = LAGOON.flat - 30 + hash(i, 7) * (LAGOON.brink - LAGOON.flat + 20);
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const y = seabedHeight(x, z);
    if (y > -1.2 || y < -26) continue;         // not on the beach, not in the dark
    const bucket = buckets[i % buckets.length];
    // Keep the whole thing at least half a metre under: a coral head breaking
    // the surface in a sheltered lagoon looks like a bug, because it is one.
    // Sit the prop on the bottom and keep its top under water: the centre sits
    // half a height up, so the clearance test has to use the whole height.
    const h = bucket.userData.h;
    const room = Math.max(0, -y - 0.5);
    const s = Math.min(0.5 + hash(i, 11) * 1.9, room / (h * 0.95));
    if (s < 0.3) continue;
    pos.set(x, y + s * h * 0.45, z);
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), hash(i, 13) * 6.28);
    scale.set(s * (0.7 + hash(i, 17) * 0.7), s, s * (0.7 + hash(i, 19) * 0.7));
    m.compose(pos, q, scale);
    bucket.setMatrixAt(bucket.count, m);
    // Reef colours: corals warm, weeds green, the odd purple fan.
    const palette = [[0.035, 0.62], [0.08, 0.55], [0.28, 0.38], [0.75, 0.34], [0.12, 0.5]][i % 5];
    colour.setHSL(palette[0] + hash(i, 23) * 0.03, palette[1], 0.42 + hash(i, 29) * 0.16);
    // Baked-in absorption: without it a coral head lit by the sky lamp glows
    // brighter than the sand it is sitting on.
    const light = Math.exp(y * 0.055);
    colour.multiplyScalar(0.42 + 0.58 * light);
    colour.lerp(new THREE.Color(0x0d3f4a), (1 - light) * 0.55);
    bucket.setColorAt(bucket.count, colour);
    bucket.count++;
  }
  for (const b of buckets) {
    b.instanceMatrix.needsUpdate = true;
    if (b.instanceColor) b.instanceColor.needsUpdate = true;
  }
  return group;
}

/* ------------------------------------------------------------------- fish */

function fishGeometry() {
  // A flattened diamond with a forked tail reads as "fish" at any size.
  const g = new THREE.BufferGeometry();
  const v = [
    0.5, 0, 0, 0, 0.16, 0.11, 0, 0.16, -0.11, 0, -0.16, 0.11, 0, -0.16, -0.11,
    -0.42, 0, 0, -0.62, 0.2, 0, -0.62, -0.2, 0,
  ];
  const idx = [
    0, 1, 2, 0, 3, 1, 0, 2, 4, 0, 4, 3,
    5, 2, 1, 5, 1, 3, 5, 4, 2, 5, 3, 4,
    5, 6, 7,
  ];
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * Schools of reef fish in the lagoon. Purely decorative -- but they are what
 * sells "clear water", and they give the dock something to watch while a float
 * sits still.
 */
export function createFishSchools({ schools = 7, per = 14 } = {}) {
  const geo = fishGeometry();
  const total = schools * per;
  const mat = new THREE.MeshLambertMaterial({ flatShading: true, side: THREE.DoubleSide });
  const mesh = new THREE.InstancedMesh(geo, mat, total);
  mesh.frustumCulled = false;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

  const colour = new THREE.Color();
  const flock = [];
  for (let i = 0; i < schools; i++) {
    // The first two schools live off the end of the pier, which is where
    // someone new to the game is standing.
    const a = i < 2 ? Math.PI / 2 + (i - 0.5) * 0.34 : hash(i, 41) * Math.PI * 2;
    const r = i < 2 ? 150 + i * 22 : LAGOON.shore + 22 + hash(i, 43) * (LAGOON.reef - LAGOON.shore - 30);
    flock.push({
      cx: Math.cos(a) * r,
      cz: Math.sin(a) * r,
      radius: 6 + hash(i, 47) * 16,
      speed: 0.22 + hash(i, 53) * 0.3,
      phase: hash(i, 59) * 6.28,
      size: 0.7 + hash(i, 61) * 1.6,
      depth: 1.2 + hash(i, 67) * 2.5,
    });
    for (let j = 0; j < per; j++) {
      colour.setHSL(0.08 + hash(i, j + 71) * 0.55, 0.62, 0.52 + hash(j, i + 73) * 0.2);
      mesh.setColorAt(i * per + j, colour);
    }
  }
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);

  return {
    mesh,
    update(time) {
      let k = 0;
      for (let i = 0; i < flock.length; i++) {
        const s = flock[i];
        for (let j = 0; j < per; j++) {
          const off = (j / per) * Math.PI * 2;
          const t = time * s.speed + s.phase + off;
          const wobble = Math.sin(t * 3.1 + j) * 0.28;
          const rr = s.radius * (0.75 + 0.25 * Math.sin(t * 0.7 + j * 0.6));
          const x = s.cx + Math.cos(t) * rr;
          const z = s.cz + Math.sin(t) * rr * 0.8;
          const bed = seabedHeight(x, z);
          const y = Math.min(-0.35, bed + s.depth + wobble);
          pos.set(x, y, z);
          // Face along the path.
          fwd.set(-Math.sin(t), 0, Math.cos(t) * 0.8).normalize();
          q.setFromUnitVectors(up.set(1, 0, 0), fwd);
          up.set(0, 1, 0);
          const flick = 1 + Math.sin(t * 9 + j) * 0.12;
          scale.set(s.size * flick, s.size, s.size);
          m.compose(pos, q, scale);
          mesh.setMatrixAt(k++, m);
        }
      }
      mesh.instanceMatrix.needsUpdate = true;
    },
  };
}
