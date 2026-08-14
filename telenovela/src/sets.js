// The set: a hacienda courtyard at night. Built once, dressed for the whole
// episode. Everything is generated — tiles, stucco, bougainvillea, the moon.

import * as THREE from '../vendor/three/three.module.min.js';
import { TAU, clamp01, lerp, deg, mulberry32, fbm1 } from './util.js';

// --- generated textures -----------------------------------------------------

function canvas(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return [c, c.getContext('2d')];
}

function finish(c, repeat = 1, aniso = 8) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = aniso;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function tileTexture(rng) {
  const N = 512, [c, g] = canvas(N);
  g.fillStyle = '#2a1c17';
  g.fillRect(0, 0, N, N);
  const cells = 4, s = N / cells;
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      const off = (y % 2) * s * 0.5;
      const px = ((x * s + off) % N) - 2, py = y * s;
      const h = 14 + rng() * 10, l = 32 + rng() * 13;
      g.fillStyle = `hsl(${h} 24% ${l}%)`;
      g.fillRect(px + 3, py + 3, s - 6, s - 6);
      // Wear: a few lighter scuffs and darker damp patches per tile.
      for (let i = 0; i < 22; i++) {
        const a = rng() * 0.14;
        g.fillStyle = rng() < 0.5 ? `rgba(255,225,200,${a})` : `rgba(20,10,6,${a})`;
        const w = 6 + rng() * 40;
        g.fillRect(px + 3 + rng() * (s - 12), py + 3 + rng() * (s - 12), w, 3 + rng() * 12);
      }
    }
  }
  // Grain over the lot so the floor never bands under the moonlight.
  const img = g.getImageData(0, 0, N, N), d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rng() - 0.5) * 26;
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
  return c;
}

function stuccoTexture(rng, base = [38, 26, 82]) {
  const N = 256, [c, g] = canvas(N);
  g.fillStyle = `hsl(${base[0]} ${base[1]}% ${base[2]}%)`;
  g.fillRect(0, 0, N, N);
  for (let i = 0; i < 2600; i++) {
    const a = rng() * 0.07;
    g.fillStyle = rng() < 0.5 ? `rgba(255,250,235,${a})` : `rgba(60,40,25,${a})`;
    g.beginPath();
    g.arc(rng() * N, rng() * N, 1 + rng() * 9, 0, TAU);
    g.fill();
  }
  // Damp rising from the base of the wall.
  const grad = g.createLinearGradient(0, N, 0, N * 0.55);
  grad.addColorStop(0, 'rgba(52,36,26,0.5)');
  grad.addColorStop(1, 'rgba(52,36,26,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, N, N);
  return c;
}

function woodTexture(rng) {
  const N = 256, [c, g] = canvas(N);
  g.fillStyle = '#3d2a1d';
  g.fillRect(0, 0, N, N);
  for (let i = 0; i < 160; i++) {
    g.strokeStyle = `rgba(${90 + rng() * 60},${60 + rng() * 40},${34 + rng() * 26},${0.1 + rng() * 0.3})`;
    g.lineWidth = 0.5 + rng() * 2.5;
    g.beginPath();
    const y = rng() * N;
    g.moveTo(0, y);
    for (let x = 0; x <= N; x += 16) g.lineTo(x, y + Math.sin(x * 0.05 + i) * 3 + (rng() - 0.5) * 2);
    g.stroke();
  }
  return c;
}

function cloudTexture(rng) {
  const N = 256, [c, g] = canvas(N);
  g.clearRect(0, 0, N, N);
  for (let i = 0; i < 220; i++) {
    const x = N / 2 + (rng() - 0.5) * N * 0.85;
    const y = N / 2 + (rng() - 0.5) * N * 0.5;
    const r = 12 + rng() * 46;
    const d = 1 - Math.hypot((x - N / 2) / (N / 2), (y - N / 2) / (N / 2));
    const a = clamp01(d) * 0.13;
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, `rgba(255,255,255,${a})`);
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function discTexture() {
  const N = 64, [c, g] = canvas(N);
  const grd = g.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, N / 2);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.4, 'rgba(255,255,255,0.7)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, N, N);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// --- set pieces -------------------------------------------------------------

// A wall with arched openings, built as one extruded shape with holes so the
// arches read as cut through solid stucco.
function archWall(width, height, thickness, arches, mat) {
  const s = new THREE.Shape();
  s.moveTo(-width / 2, 0);
  s.lineTo(width / 2, 0);
  s.lineTo(width / 2, height);
  s.lineTo(-width / 2, height);
  s.lineTo(-width / 2, 0);
  for (const a of arches) {
    const h = new THREE.Path();
    const { x, w, hh } = a;                   // hh = height of the straight part
    h.moveTo(x - w / 2, 0.02);
    h.lineTo(x - w / 2, hh);
    h.absarc(x, hh, w / 2, Math.PI, 0, true);
    h.lineTo(x + w / 2, 0.02);
    h.lineTo(x - w / 2, 0.02);
    s.holes.push(h);
  }
  const g = new THREE.ExtrudeGeometry(s, { depth: thickness, bevelEnabled: false, curveSegments: 18 });
  g.translate(0, 0, -thickness / 2);
  // Box-ish UVs so the stucco doesn't smear across the arch soffits.
  const pos = g.attributes.position, uv = g.attributes.uv;
  for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i) * 0.55, pos.getY(i) * 0.55);
  uv.needsUpdate = true;
  const m = new THREE.Mesh(g, mat);
  m.castShadow = m.receiveShadow = true;
  return m;
}

function fountain(rng, mats) {
  const g = new THREE.Group();
  const basin = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 1.05, 0.34, 28, 1), mats.stone);
  basin.position.y = 0.17;
  basin.castShadow = basin.receiveShadow = true;
  g.add(basin);
  const lip = new THREE.Mesh(new THREE.TorusGeometry(0.96, 0.07, 8, 30), mats.stone);
  lip.rotation.x = Math.PI / 2;
  lip.position.y = 0.35;
  lip.castShadow = lip.receiveShadow = true;
  g.add(lip);
  const column = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.17, 0.62, 14), mats.stone);
  column.position.y = 0.6;
  column.castShadow = true;
  g.add(column);
  const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.14, 0.14, 20), mats.stone);
  bowl.position.y = 0.95;
  bowl.castShadow = true;
  g.add(bowl);
  const finial = new THREE.Mesh(new THREE.SphereGeometry(0.08, 12, 10), mats.stone);
  finial.position.y = 1.06;
  g.add(finial);

  // Two water surfaces, rippled in the vertex shader. Dark, so they mostly
  // work as a mirror for the moon.
  const waterMat = new THREE.MeshStandardMaterial({
    color: 0x16303a, roughness: 0.06, metalness: 0.5, transparent: true, opacity: 0.9,
  });
  waterMat.userData.time = { value: 0 };
  waterMat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = waterMat.userData.time;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        float r = length(position.xz);
        transformed.y += sin(r * 26.0 - uTime * 3.4) * 0.006 * (1.0 - r * 0.6)
                       + sin(r * 11.0 + uTime * 1.7) * 0.004;`);
  };
  const water = new THREE.Mesh(new THREE.CircleGeometry(0.92, 48), waterMat);
  water.rotation.x = -Math.PI / 2;
  water.position.y = 0.31;
  water.receiveShadow = true;
  g.add(water);
  const water2 = new THREE.Mesh(new THREE.CircleGeometry(0.33, 24), waterMat);
  water2.rotation.x = -Math.PI / 2;
  water2.position.y = 1.02;
  g.add(water2);

  // Four thin falls from the upper bowl.
  const fallMat = new THREE.MeshStandardMaterial({
    color: 0x9fc6cf, roughness: 0.15, metalness: 0.1, transparent: true, opacity: 0.34,
  });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU + 0.4;
    const fall = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.02, 0.62, 6, 1, true), fallMat);
    fall.position.set(Math.cos(a) * 0.3, 0.66, Math.sin(a) * 0.3);
    g.add(fall);
  }
  g.userData.waterMat = waterMat;
  void rng;
  return g;
}

function palm(rng, height = 1.5) {
  const g = new THREE.Group();
  const potMat = new THREE.MeshStandardMaterial({ color: 0x8a4a2e, roughness: 0.85 });
  const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.19, 0.34, 16), potMat);
  pot.position.y = 0.17;
  pot.castShadow = pot.receiveShadow = true;
  g.add(pot);
  const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.285, 0.275, 0.06, 16), potMat);
  rim.position.y = 0.33;
  rim.castShadow = true;
  g.add(rim);
  const soil = new THREE.Mesh(new THREE.CircleGeometry(0.25, 14), new THREE.MeshStandardMaterial({ color: 0x2a1d14, roughness: 1 }));
  soil.rotation.x = -Math.PI / 2;
  soil.position.y = 0.335;
  g.add(soil);

  const leafMat = new THREE.MeshStandardMaterial({ color: 0x2f5a33, roughness: 0.72, side: THREE.DoubleSide });
  const fronds = new THREE.Group();
  fronds.position.y = 0.34;
  g.add(fronds);
  const n = 9 + Math.floor(rng() * 4);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + rng() * 0.4;
    const len = height * (0.62 + rng() * 0.5);
    const arc = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(Math.cos(a) * len * 0.16, len * 0.55, Math.sin(a) * len * 0.16),
      new THREE.Vector3(Math.cos(a) * len * 0.55, len * 0.86, Math.sin(a) * len * 0.55),
      new THREE.Vector3(Math.cos(a) * len * 0.95, len * 0.6, Math.sin(a) * len * 0.95),
    ]);
    const stem = new THREE.Mesh(new THREE.TubeGeometry(arc, 10, 0.012, 5), leafMat);
    stem.castShadow = true;
    fronds.add(stem);
    // Blades along the frond.
    const blades = 7;
    for (let k = 1; k <= blades; k++) {
      const t = k / (blades + 1);
      const p = arc.getPoint(t);
      const tan = arc.getTangent(t);
      for (const sside of [-1, 1]) {
        const bl = new THREE.Mesh(new THREE.PlaneGeometry(0.055, 0.3 * (1 - t * 0.45)), leafMat);
        bl.position.copy(p);
        bl.lookAt(p.clone().add(tan));
        bl.rotateY(sside * deg(72));
        bl.rotateX(deg(90));
        bl.translateY(0.14 * (1 - t * 0.45));
        bl.castShadow = true;
        fronds.add(bl);
      }
    }
  }
  g.userData.fronds = fronds;
  return g;
}

function bougainvillea(rng, count = 260) {
  const geo = new THREE.PlaneGeometry(0.07, 0.07);
  const mat = new THREE.MeshStandardMaterial({ color: 0xd8477e, roughness: 0.8, side: THREE.DoubleSide });
  const mesh = new THREE.InstancedMesh(geo, mat, count);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3(), s = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    // Clumped along the top of the wall, spilling down.
    const cl = Math.floor(rng() * 5);
    const cx = -3.2 + cl * 1.6 + (rng() - 0.5) * 1.1;
    const drop = Math.pow(rng(), 1.7);
    p.set(cx, 2.35 - drop * 1.5, -3.3 + (rng() - 0.5) * 0.24);
    e.set(rng() * TAU, rng() * TAU, rng() * TAU);
    q.setFromEuler(e);
    const k = 0.6 + rng() * 0.9;
    s.set(k, k, k);
    mesh.setMatrixAt(i, m.compose(p, q, s));
    mesh.setColorAt(i, new THREE.Color().setHSL(0.92 + rng() * 0.06, 0.55 + rng() * 0.25, 0.34 + rng() * 0.2));
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.castShadow = true;
  return mesh;
}

function lantern(mats) {
  const g = new THREE.Group();
  const cage = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.11, 0.2, 6), mats.iron);
  cage.castShadow = true;
  g.add(cage);
  const cap = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.08, 6), mats.iron);
  cap.position.y = 0.13;
  cap.castShadow = true;
  g.add(cap);
  const glass = new THREE.Mesh(
    new THREE.SphereGeometry(0.055, 10, 8),
    new THREE.MeshBasicMaterial({ color: 0xffcb7a }),
  );
  g.add(glass);
  const light = new THREE.PointLight(0xffab52, 1.7, 5.6, 1.9);
  light.position.y = 0.01;
  g.add(light);
  g.userData.light = light;
  g.userData.glass = glass;
  return g;
}

// --- the courtyard ----------------------------------------------------------

export const MARKS = {
  fountain: new THREE.Vector3(-1.75, 0, -0.55),
  archCenter: new THREE.Vector3(0, 0, -3.25),
  archLeft: new THREE.Vector3(-2.35, 0, -3.25),
  archRight: new THREE.Vector3(2.35, 0, -3.25),
  centreStage: new THREE.Vector3(0.15, 0, -0.3),
  downLeft: new THREE.Vector3(-1.5, 0, 1.35),
  downRight: new THREE.Vector3(1.55, 0, 1.2),
  palmFG: new THREE.Vector3(2.55, 0, 2.15),
  bench: new THREE.Vector3(2.7, 0, -1.5),
};

export function buildSet(scene, renderer) {
  const rng = mulberry32(20260214);
  const set = new THREE.Group();
  scene.add(set);

  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const tileTex = finish(tileTexture(rng), 3.2, aniso);
  const stuccoTex = finish(stuccoTexture(rng), 3, aniso);
  const stuccoWarm = finish(stuccoTexture(rng, [26, 30, 74]), 2, aniso);
  const woodTex = finish(woodTexture(rng), 2, aniso);

  const mats = {
    floor: new THREE.MeshStandardMaterial({ map: tileTex, roughness: 0.62, metalness: 0.02, color: 0xb8b2ad }),
    stucco: new THREE.MeshStandardMaterial({ map: stuccoTex, roughness: 0.92, color: 0xa89a8c }),
    stuccoWarm: new THREE.MeshStandardMaterial({ map: stuccoWarm, roughness: 0.9, color: 0xa08c78 }),
    stone: new THREE.MeshStandardMaterial({ color: 0x8d8479, roughness: 0.82 }),
    wood: new THREE.MeshStandardMaterial({ map: woodTex, roughness: 0.8 }),
    iron: new THREE.MeshStandardMaterial({ color: 0x1b1a1e, roughness: 0.5, metalness: 0.7 }),
  };

  // Floor.
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(26, 26), mats.floor);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  set.add(floor);
  set.userData.floorMat = mats.floor;

  // Back wall with three arches, and a low parapet above it.
  const back = archWall(11, 3.1, 0.5, [
    { x: -2.35, w: 1.25, hh: 1.35 },
    { x: 0, w: 1.6, hh: 1.55 },
    { x: 2.35, w: 1.25, hh: 1.35 },
  ], mats.stucco);
  back.position.set(0, 0, -3.45);
  set.add(back);
  const parapet = new THREE.Mesh(new THREE.BoxGeometry(11, 0.34, 0.66), mats.stucco);
  parapet.position.set(0, 3.24, -3.45);
  parapet.castShadow = parapet.receiveShadow = true;
  set.add(parapet);

  // Side walls, angled in slightly to funnel the eye to the centre arch.
  for (const sx of [-1, 1]) {
    const side = archWall(7.6, 3.1, 0.45, [{ x: -1.5, w: 1.2, hh: 1.3 }, { x: 1.6, w: 1.2, hh: 1.3 }], mats.stuccoWarm);
    side.position.set(sx * 4.6, 0, -0.2);
    side.rotation.y = sx * deg(-90);
    set.add(side);
  }

  // Fourth wall, so reverse shots have a courtyard behind them instead of sky.
  const front = archWall(11, 3.0, 0.45, [
    { x: -2.6, w: 1.15, hh: 1.3 },
    { x: 0, w: 1.7, hh: 1.5 },
    { x: 2.6, w: 1.15, hh: 1.3 },
  ], mats.stuccoWarm);
  front.position.set(0, 0, 3.95);
  front.rotation.y = Math.PI;
  set.add(front);

  // The dark room behind the centre arch — entrances come out of that black.
  const backdrop = new THREE.Mesh(
    new THREE.PlaneGeometry(11, 3.4),
    new THREE.MeshStandardMaterial({ color: 0x14100f, roughness: 1 }),
  );
  backdrop.position.set(0, 1.7, -4.6);
  set.add(backdrop);
  const backFloor = new THREE.Mesh(new THREE.PlaneGeometry(11, 2.4), mats.floor);
  backFloor.rotation.x = -Math.PI / 2;
  backFloor.position.set(0, 0.001, -4.4);
  backFloor.receiveShadow = true;
  set.add(backFloor);

  // Two steps down into the courtyard, under the centre arch.
  for (let i = 0; i < 2; i++) {
    const st = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.07, 0.3), mats.stone);
    st.position.set(0, 0.035 + i * 0.0, -3.05 - i * 0.3);
    st.receiveShadow = st.castShadow = true;
    set.add(st);
  }

  const f = fountain(rng, mats);
  f.position.copy(MARKS.fountain);
  set.add(f);

  const palms = [];
  for (const [x, z, h, sc] of [[2.55, 2.15, 1.7, 1.15], [-3.35, 1.7, 1.4, 1.0], [3.5, -2.2, 1.25, 0.9], [-3.5, -2.4, 1.3, 0.95]]) {
    const p = palm(rng, h);
    p.position.set(x, 0, z);
    p.scale.setScalar(sc);
    p.rotation.y = rng() * TAU;
    set.add(p);
    palms.push(p);
  }

  const vine = bougainvillea(rng);
  set.add(vine);

  // Bench.
  {
    const b = new THREE.Group();
    const seat = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.08, 0.42), mats.wood);
    seat.position.y = 0.42;
    const backrest = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.42, 0.07), mats.wood);
    backrest.position.set(0, 0.64, -0.18);
    backrest.rotation.x = deg(-8);
    for (const m of [seat, backrest]) { m.castShadow = m.receiveShadow = true; b.add(m); }
    for (const sx of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.42, 0.36), mats.iron);
      leg.position.set(sx * 0.55, 0.21, 0);
      leg.castShadow = true;
      b.add(leg);
    }
    b.position.copy(MARKS.bench);
    b.rotation.y = deg(-104);
    set.add(b);
  }

  // Lanterns hung from the arches.
  const lanterns = [];
  for (const [x, y, z] of [[-2.35, 2.05, -3.15], [2.35, 2.05, -3.15], [-4.3, 2.1, -1.7], [4.3, 2.1, -1.7]]) {
    const l = lantern(mats);
    l.position.set(x, y, z);
    const hook = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.42, 5), mats.iron);
    hook.position.set(x, y + 0.28, z);
    set.add(hook);
    set.add(l);
    lanterns.push(l);
  }

  // --- sky ------------------------------------------------------------------
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: {
      uTop: { value: new THREE.Color(0x020307) },
      uMid: { value: new THREE.Color(0x070c1a) },
      uHorizon: { value: new THREE.Color(0x141327) },
      uFlash: { value: 0 },
      uMoonDir: { value: new THREE.Vector3(0.4, 0.62, 0.68).normalize() },
    },
    vertexShader: `varying vec3 vDir;
      void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `varying vec3 vDir;
      uniform vec3 uTop, uMid, uHorizon, uMoonDir; uniform float uFlash;
      void main(){
        float h = clamp(vDir.y * 0.5 + 0.5, 0.0, 1.0);
        vec3 c = mix(uHorizon, uMid, smoothstep(0.48, 0.66, h));
        c = mix(c, uTop, smoothstep(0.62, 0.95, h));
        float halo = pow(max(dot(normalize(vDir), uMoonDir), 0.0), 34.0);
        c += vec3(0.20, 0.23, 0.32) * halo;
        c += vec3(0.16, 0.18, 0.26) * pow(max(dot(normalize(vDir), uMoonDir), 0.0), 4.0) * 0.35;
        c += uFlash * vec3(0.7, 0.78, 1.0) * (0.35 + h * 0.7);
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(80, 32, 20), skyMat);
  sky.renderOrder = -10;
  scene.add(sky);

  // Stars.
  {
    const N = 900, pos = new Float32Array(N * 3), col = new Float32Array(N * 3), sz = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const u = rng() * TAU, v = Math.acos(lerp(-0.05, 1, rng()));
      const r = 70;
      pos[i * 3] = Math.sin(v) * Math.cos(u) * r;
      pos[i * 3 + 1] = Math.cos(v) * r;
      pos[i * 3 + 2] = Math.sin(v) * Math.sin(u) * r;
      const c = new THREE.Color().setHSL(0.55 + rng() * 0.12, 0.35, 0.6 + rng() * 0.4);
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      sz[i] = 0.1 + Math.pow(rng(), 6) * 0.9;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(sz, 1));
    const m = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, fog: false,
      uniforms: { uTwinkle: { value: 0 }, uDim: { value: 1 } },
      vertexShader: `attribute float aSize; varying vec3 vC; varying float vS;
        uniform float uTwinkle;
        void main(){ vC = color; vS = aSize;
          vec4 mv = modelViewMatrix * vec4(position,1.0);
          gl_PointSize = (1.0 + aSize * 3.0) * (0.7 + 0.3 * sin(uTwinkle * 2.0 + aSize * 40.0));
          gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `varying vec3 vC; varying float vS; uniform float uDim;
        void main(){ vec2 d = gl_PointCoord - 0.5; float a = smoothstep(0.5, 0.05, length(d));
          gl_FragColor = vec4(vC, a * (0.25 + vS) * uDim); }`,
      vertexColors: true, blending: THREE.AdditiveBlending,
    });
    const stars = new THREE.Points(g, m);
    stars.renderOrder = -9;
    scene.add(stars);
    set.userData.stars = m;
  }

  // Moon: a bright disc with a soft halo sprite behind it.
  const moonDir = new THREE.Vector3(0.4, 0.62, 0.68).normalize();
  const moonPos = moonDir.clone().multiplyScalar(60);
  const moon = new THREE.Mesh(new THREE.CircleGeometry(1.5, 32), new THREE.MeshBasicMaterial({ color: 0xdfe7ff, fog: false }));
  moon.position.copy(moonPos);
  moon.lookAt(0, 0, 0);
  moon.renderOrder = -8;
  scene.add(moon);
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: discTexture(), color: 0x9fb4e8, transparent: true, opacity: 0.5,
    blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
  }));
  halo.scale.setScalar(16);
  halo.position.copy(moonPos);
  halo.renderOrder = -8;
  scene.add(halo);

  // Clouds: a few big soft cards drifting across the moon.
  const clouds = [];
  const cloudTex = cloudTexture(rng);
  for (let i = 0; i < 7; i++) {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(34, 12),
      new THREE.MeshBasicMaterial({ map: cloudTex, transparent: true, depthWrite: false, opacity: 0.5, color: 0x6e7b9c, fog: false }),
    );
    m.position.set(-40 + rng() * 90, 14 + rng() * 16, -46 - rng() * 14);
    m.scale.setScalar(0.7 + rng() * 1.5);
    m.renderOrder = -7;
    m.userData.speed = 0.25 + rng() * 0.5;
    scene.add(m);
    clouds.push(m);
  }

  // --- lighting -------------------------------------------------------------
  const moonLight = new THREE.DirectionalLight(0x9db4e8, 3.6);
  moonLight.position.copy(moonDir).multiplyScalar(16);
  moonLight.castShadow = true;
  moonLight.shadow.mapSize.set(2048, 2048);
  moonLight.shadow.camera.near = 1;
  moonLight.shadow.camera.far = 40;
  const d = 7.5;
  Object.assign(moonLight.shadow.camera, { left: -d, right: d, top: d, bottom: -d });
  moonLight.shadow.camera.updateProjectionMatrix();
  moonLight.shadow.bias = -0.0012;
  moonLight.shadow.normalBias = 0.02;
  scene.add(moonLight);
  scene.add(moonLight.target);

  const ambient = new THREE.HemisphereLight(0x3d4f78, 0x2a1d1f, 1.15);
  scene.add(ambient);

  // A warm practical spilling out of the doorway behind the centre arch —
  // this is what silhouettes an entrance.
  const doorway = new THREE.SpotLight(0xffb265, 10.0, 13, deg(54), 0.6, 1.6);
  doorway.position.set(0, 2.5, -4.3);
  doorway.target.position.set(0, 0, -1.2);
  doorway.castShadow = true;
  doorway.shadow.mapSize.set(1024, 1024);
  doorway.shadow.bias = -0.002;
  scene.add(doorway, doorway.target);

  // A soft key from camera-left so faces are never flat.
  const key = new THREE.SpotLight(0xbcd0ff, 4.0, 22, deg(62), 0.85, 1.4);
  key.position.set(-4.5, 4.2, 3.2);
  key.target.position.set(0, 0.4, -0.5);
  scene.add(key, key.target);

  const fog = new THREE.FogExp2(0x161a2c, 0.03);
  scene.fog = fog;

  const state = {
    group: set, floor, mats, palms, lanterns, fountain: f, clouds, sky: skyMat,
    stars: set.userData.stars, moon, halo, moonLight, ambient, doorway, key, fog,
    wetness: 0, flash: 0,
  };

  set.userData.state = state;
  return state;
}

export function updateSet(set, dt, time) {
  set.fountain.userData.waterMat.userData.time.value = time;
  set.sky.uniforms.uFlash.value = set.flash;
  set.stars.uniforms.uTwinkle.value = time;
  set.stars.uniforms.uDim.value = 1 - set.wetness * 0.85;

  for (let i = 0; i < set.lanterns.length; i++) {
    const l = set.lanterns[i];
    // Flicker, and swing a little once the storm arrives.
    const fl = 0.82 + fbm1(time * 3.1 + i * 7, i) * 0.28 + Math.sin(time * 17 + i) * 0.03;
    l.userData.light.intensity = 1.8 * fl * (1 - set.wetness * 0.25);
    l.userData.glass.material.color.setHSL(0.09, 0.75, 0.55 + fl * 0.16);
    l.rotation.z = fbm1(time * 0.9 + i * 3, i + 11) * 0.12 * (0.25 + set.wetness);
    l.rotation.x = fbm1(time * 0.8 + i * 5, i + 21) * 0.1 * (0.25 + set.wetness);
  }

  for (const p of set.palms) {
    p.userData.fronds.rotation.z = fbm1(time * 0.55 + p.position.x, 5) * (0.03 + set.wetness * 0.09);
    p.userData.fronds.rotation.x = fbm1(time * 0.45 + p.position.z, 9) * (0.03 + set.wetness * 0.09);
  }

  for (const c of set.clouds) {
    c.position.x += c.userData.speed * dt;
    if (c.position.x > 60) c.position.x = -60;
    c.material.opacity = lerp(0.36, 0.85, set.wetness);
    c.material.color.setHSL(0.62, 0.18, lerp(0.34, 0.16, set.wetness));
  }

  // Wet ground goes dark and glossy, and the moon dims behind the storm.
  set.mats.floor.roughness = lerp(0.62, 0.14, set.wetness);
  set.mats.floor.metalness = lerp(0.02, 0.42, set.wetness);
  set.mats.floor.color.setScalar(lerp(0.85, 0.58, set.wetness));
  set.moonLight.intensity = lerp(3.6, 2.15, set.wetness) + set.flash * 8.0;
  set.moon.material.opacity = 1;
  set.halo.material.opacity = lerp(0.5, 0.12, set.wetness);
  set.ambient.intensity = lerp(1.15, 0.95, set.wetness) + set.flash * 2.4;
  set.fog.density = lerp(0.03, 0.055, set.wetness);
}
