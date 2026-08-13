// A tiny world: displaced icosphere, sea, scattered life, and the bloom
// wavefront that turns the whole thing from grey to green.
//
// The terrain is a pure function of direction, so the mesh and the physics
// agree without any raycasting: `groundRadius(dir)` is the same maths the
// vertex shader was fed at build time.

import * as THREE from 'three';
import { Noise, clamp, lerp, smoothstep, rng } from './noise.js';
import { SUN_POSITION } from './engine.js';
import { MeteorStorm, Gloom } from './threats.js';

const TAU = Math.PI * 2;
const _v = new THREE.Vector3();
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const _p0 = new THREE.Vector3();
const _p1 = new THREE.Vector3();
const _p2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _col = new THREE.Color();

// How small and grey a dormant tree is before its world wakes up.
const DORMANT = 0.55;

// Phones are fill-rate bound long before they are geometry bound, and the two
// shells of noise over the whole planet are the most expensive thing drawn.
const LOW_FX = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

let _glowSprite = null;
function glowSprite() {
  if (_glowSprite) return _glowSprite;
  const size = 64;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,0.9)');
  g.addColorStop(0.3, 'rgba(255,236,190,0.35)');
  g.addColorStop(1, 'rgba(255,210,140,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  _glowSprite = new THREE.CanvasTexture(c);
  _glowSprite.colorSpace = THREE.SRGBColorSpace;
  return _glowSprite;
}

// Merge a few small parts into one geometry. mergeGeometries refuses a mix of
// indexed and non-indexed inputs, and the polyhedra come back non-indexed.
function mergeParts(parts) {
  const list = parts.map((g) => g.toNonIndexed());
  const total = list.reduce((n, g) => n + g.attributes.position.count, 0);
  const out = new THREE.BufferGeometry();
  const pos = new Float32Array(total * 3);
  let o = 0;
  for (const g of list) {
    pos.set(g.attributes.position.array, o);
    o += g.attributes.position.array.length;
  }
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.computeVertexNormals();
  return out;
}

// Two tangents for a direction, for finite-difference normals and yaw frames.
function tangents(dir, t1, t2) {
  t1.set(0, 1, 0);
  if (Math.abs(dir.y) > 0.9) t1.set(1, 0, 0);
  t1.crossVectors(t1, dir).normalize();
  t2.crossVectors(dir, t1).normalize();
}

// Uniformly distributed direction on the sphere.
function randomDir(rand, out) {
  const z = rand() * 2 - 1;
  const a = rand() * TAU;
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  return out.set(r * Math.cos(a), r * Math.sin(a), z);
}

function sampleRamp(stops, e, seaE, out) {
  // Below sea level the ramp runs floor -> shore; above it, shore -> peak.
  if (e <= seaE) {
    const t = seaE > 0 ? clamp(e / seaE, 0, 1) : 1;
    return out.copy(stops[0]).lerp(stops[1], t);
  }
  // Uneven breakpoints: a narrow beach, a wide band of living ground, then
  // rock and only a cap of snow. Equal thirds gave every world a pale dome.
  const land = clamp((e - seaE) / Math.max(1e-4, 1 - seaE), 0, 1);
  // Four stops above water means three segments, so BREAKS needs four entries:
  // a narrow beach, a wide band of living ground, then rock climbing to a cap.
  const BREAKS = [0, 0.08, 0.82, 1];
  let i = 1;
  while (i < BREAKS.length - 1 && land > BREAKS[i]) i++;
  const t = (land - BREAKS[i - 1]) / Math.max(1e-4, BREAKS[i] - BREAKS[i - 1]);
  return out.copy(stops[i]).lerp(stops[i + 1], clamp(t, 0, 1));
}

export class Planet {
  constructor(def, assets) {
    this.def = def;
    this.assets = assets;
    this.noise = new Noise(def.seed);
    this.rand = rng(def.seed ^ 0x9e3779b9);

    this.group = new THREE.Group();
    this.group.position.fromArray(def.position);
    this.group.userData.planet = this;

    this.bloomOrigin = new THREE.Vector3(0, 1, 0);
    this.waveRadius = 0;
    this.waveActive = false;
    this.bloomed = false;
    this.lush = 0; // 0..1, drives water colour and prop emissives

    this.buildTerrain();
    this.buildWater();
    this.buildAtmosphere();
    this.pickLandingSite();
    this.scatterProps();
    this.buildGrass();
    this.buildFlowers();
    this.buildClouds();
    this.buildMist();
    this.placeMotes();
    this.buildBeacon();
    if (def.islets) this.buildIslets();
    if (def.finale) this.buildHeartTree();
  }

  // ---------------------------------------------------------------- terrain

  elevation(dir) {
    const t = this.def.terrain, n = this.noise, f = t.freq;
    // Domain warp: sample the height field at a point that has itself been
    // pushed around by a lower-frequency field. Plain fbm gives blobby, evenly
    // spaced islands; warping bends them into coastlines that wander.
    const w = t.warp ?? 0.4;
    const wf = f * 0.6;
    const px = dir.x * f + n.noise3(dir.x * wf + 5.2, dir.y * wf + 1.3, dir.z * wf - 2.7) * w;
    const py = dir.y * f + n.noise3(dir.x * wf - 3.1, dir.y * wf + 7.9, dir.z * wf + 4.4) * w;
    const pz = dir.z * f + n.noise3(dir.x * wf + 9.6, dir.y * wf - 6.2, dir.z * wf + 0.8) * w;

    const base = n.fbm(px, py, pz, 6, 2.15, 0.5);
    const land = smoothstep(-0.16, 0.34, base);
    const r = n.ridge(px * 2.1 + 13.7, py * 2.1 - 5.2, pz * 2.1 + 2.4, 5);
    // Fine relief only above water, so sea floors stay smooth and beaches read
    // as beaches.
    const detail = n.fbm(px * 3.4, py * 3.4, pz * 3.4, 3) * 0.05 * land;
    return base * t.amp + (r - 0.45) * t.ridgeAmp * land + detail * t.amp;
  }

  surfaceRadius(dir) {
    return this.def.radius + this.elevation(dir);
  }

  // What the player actually stands on — shallow water is waded, not drowned in.
  groundRadius(dir) {
    return Math.max(this.surfaceRadius(dir), this.seaRadius - 0.10);
  }

  normalAt(dir, out = new THREE.Vector3()) {
    tangents(dir, _t1, _t2);
    const eps = 0.035;
    _p0.copy(dir).multiplyScalar(this.groundRadius(dir));
    _v.copy(dir).addScaledVector(_t1, eps).normalize();
    _p1.copy(_v).multiplyScalar(this.groundRadius(_v));
    _v.copy(dir).addScaledVector(_t2, eps).normalize();
    _p2.copy(_v).multiplyScalar(this.groundRadius(_v));
    _p1.sub(_p0); _p2.sub(_p0);
    out.crossVectors(_p1, _p2).normalize();
    if (out.dot(dir) < 0) out.negate();
    return out;
  }

  slopeAt(dir) {
    return 1 - clamp(this.normalAt(dir, _v).dot(dir), 0, 1);
  }

  buildTerrain() {
    const def = this.def;
    const geo = new THREE.IcosahedronGeometry(1, 5); // non-indexed: flat shaded
    const pos = geo.attributes.position;
    const count = pos.count;
    const heights = new Float32Array(count);
    let hMin = Infinity, hMax = -Infinity;

    for (let i = 0; i < count; i++) {
      _v.fromBufferAttribute(pos, i).normalize();
      const h = this.elevation(_v);
      heights[i] = h;
      if (h < hMin) hMin = h;
      if (h > hMax) hMax = h;
    }
    this.hMin = hMin; this.hMax = hMax;
    this.seaRadius = def.radius + lerp(hMin, hMax, def.terrain.seaLevel);
    this.seaE = def.terrain.seaLevel;

    const dryStops = def.dry.map((c) => new THREE.Color(c).convertSRGBToLinear());
    const lushStops = def.lush.map((c) => new THREE.Color(c).convertSRGBToLinear());
    const dry = new Float32Array(count * 3);
    const lush = new Float32Array(count * 3);
    const col = new THREE.Color();
    const rand = rng(def.seed + 17);

    for (let i = 0; i < count; i++) {
      _v.fromBufferAttribute(pos, i).normalize();
      pos.setXYZ(i, _v.x * (def.radius + heights[i]), _v.y * (def.radius + heights[i]), _v.z * (def.radius + heights[i]));
    }

    // Steepness per triangle, straight off the displaced positions — the face
    // normal is free here, where sampling the height field three more times
    // per vertex would triple the build.
    const steep = new Float32Array(count / 3);
    for (let f = 0; f < count; f += 3) {
      _p0.fromBufferAttribute(pos, f);
      _p1.fromBufferAttribute(pos, f + 1).sub(_p0);
      _p2.fromBufferAttribute(pos, f + 2).sub(_p0);
      _v.crossVectors(_p1, _p2).normalize();
      steep[f / 3] = 1 - Math.abs(_v.dot(_p0.normalize()));
    }

    const rockCol = new THREE.Color(def.rock ?? 0x6d675e).convertSRGBToLinear();
    const foamCol = new THREE.Color(def.foam ?? 0xdfe8ea).convertSRGBToLinear();

    for (let i = 0; i < count; i++) {
      const e = clamp((heights[i] - hMin) / Math.max(1e-4, hMax - hMin), 0, 1);
      // One jitter value per triangle keeps facets reading as distinct plates.
      const j = i % 3 === 0 ? (this._j = 0.94 + rand() * 0.12) : this._j;
      // Cliffs are bare stone whether or not the world has woken up, and the
      // surf line sits just above the water on both.
      const bare = smoothstep(0.34, 0.72, steep[(i / 3) | 0]);
      const land = clamp((e - this.seaE) / Math.max(1e-4, 1 - this.seaE), 0, 1);
      const surf = (1 - smoothstep(0, 0.05, land)) * (1 - bare);

      sampleRamp(dryStops, e, this.seaE, col);
      col.lerp(rockCol, bare * 0.85).lerp(foamCol, surf * 0.45);
      dry[i * 3] = col.r * j; dry[i * 3 + 1] = col.g * j; dry[i * 3 + 2] = col.b * j;

      sampleRamp(lushStops, e, this.seaE, col);
      col.lerp(rockCol, bare * 0.8).lerp(foamCol, surf * 0.7);
      lush[i * 3] = col.r * j; lush[i * 3 + 1] = col.g * j; lush[i * 3 + 2] = col.b * j;
    }

    geo.setAttribute('color', new THREE.BufferAttribute(dry, 3));
    geo.setAttribute('aLush', new THREE.BufferAttribute(lush, 3));
    geo.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true, flatShading: true, roughness: 0.94, metalness: 0.0,
    });
    this.terrainUniforms = {
      uBloomOrigin: { value: this.bloomOrigin },
      uBloomRadius: { value: 0 },
    };
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.terrainUniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
          attribute vec3 aLush;
          uniform vec3 uBloomOrigin;
          uniform float uBloomRadius;
          varying float vEdge;`)
        .replace('#include <color_vertex>', `#include <color_vertex>
          {
            float ang = acos(clamp(dot(normalize(position), uBloomOrigin), -1.0, 1.0));
            float w = 1.0 - smoothstep(uBloomRadius - 0.22, uBloomRadius, ang);
            vColor = mix(vColor, aLush, w);
            // A band of light riding the front, so the change looks like it is
            // being carried across the world rather than switched on.
            vEdge = (1.0 - smoothstep(0.0, 0.20, abs(ang - uBloomRadius)))
                  * step(0.001, uBloomRadius) * (1.0 - step(3.2, uBloomRadius));
          }`)
;
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vEdge;')
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          totalEmissiveRadiance += vec3(1.0, 0.86, 0.5) * vEdge * 2.2;`);
    };
    mat.customProgramCacheKey = () => 'terrain-bloom';

    this.terrain = new THREE.Mesh(geo, mat);
    this.terrain.castShadow = true;
    this.terrain.receiveShadow = true;
    this.group.add(this.terrain);
  }

  buildWater() {
    const def = this.def;
    const geo = new THREE.SphereGeometry(this.seaRadius, 128, 72);
    this.waterUniforms = { uTime: { value: 0 } };
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(def.water.dry),
      transparent: true,
      opacity: def.water.opacity,
      roughness: 0.34,
      metalness: 0.0,
      // A touch of self-light so shallow water never reads as a black hole on
      // the night side of a world you are meant to keep walking across.
      emissive: new THREE.Color(def.water.dry),
      emissiveIntensity: 0.16,
    });
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.waterUniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          float w = sin(position.x * 3.1 + uTime * 1.6) * cos(position.z * 2.7 - uTime * 1.2)
                  + sin(position.y * 4.3 + uTime * 0.9) * 0.5;
          transformed += normalize(position) * w * 0.035;`);
    };
    mat.customProgramCacheKey = () => 'water-wobble';
    this.waterColorDry = new THREE.Color(def.water.dry);
    this.waterColorLush = new THREE.Color(def.water.lush);
    this.water = new THREE.Mesh(geo, mat);
    this.water.receiveShadow = true;
    this.group.add(this.water);
  }

  // A fresnel shell. Costs nothing and is most of the reason a world reads as
  // a world when you see it from another one.
  buildAtmosphere() {
    const def = this.def;
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(def.ambient.sky) },
        uStrength: { value: def.dark ? 0.4 : 0.5 },
      },
      vertexShader: `
        varying vec3 vN; varying vec3 vP;
        void main() {
          vN = normalize(normalMatrix * normal);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vP = mv.xyz;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform vec3 uColor; uniform float uStrength;
        varying vec3 vN; varying vec3 vP;
        void main() {
          float f = pow(1.0 - abs(dot(normalize(vN), normalize(-vP))), 2.6);
          gl_FragColor = vec4(uColor, f * uStrength);
        }`,
      transparent: true,
      side: THREE.BackSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.atmosphere = new THREE.Mesh(new THREE.SphereGeometry(def.radius * 1.035, 48, 32), mat);
    this.group.add(this.atmosphere);
  }

  // ------------------------------------------------------------ placement

  // Rejection sampling for a spot that is dry land, not too steep, and not on
  // top of something we already placed.
  findSpot(rand, {
    minSlope = 0, maxSlope = 0.35, minSep = 0.18, taken = [], aboveSea = 0.15,
    tries = 260, prefer = null, preferWeight = 0, minPrefer = -1,
  } = {}) {
    let best = null, bestScore = -Infinity;
    for (let i = 0; i < tries; i++) {
      randomDir(rand, _v);
      const r = this.surfaceRadius(_v);
      if (r < this.seaRadius + aboveSea) continue;
      const slope = this.slopeAt(_v);
      if (slope > maxSlope || slope < minSlope) continue;
      const facing = prefer ? _v.dot(prefer) : 0;
      if (facing < minPrefer) continue;
      let sep = Infinity;
      for (const t of taken) sep = Math.min(sep, _v.angleTo(t));
      if (sep < minSep) continue;
      const score = sep - slope * 2 + facing * preferWeight;
      if (score > bestScore) { bestScore = score; best = _v.clone(); }
      if (!prefer && sep > minSep * 2.2) break; // good enough, stop burning samples
    }
    return best;
  }

  pickLandingSite() {
    const rand = rng(this.def.seed + 991);
    // Arrive in daylight. The sun is fixed in the solar system, so half of
    // every world is night; landing there means stepping off the beacon into a
    // world you cannot see.
    this.sunDirLocal = _v.copy(SUN_POSITION).sub(this.group.position).normalize().clone();
    this.landingDir = this.findSpot(rand, {
      maxSlope: 0.18, minSep: 0, aboveSea: 0.4, tries: 700,
      prefer: this.sunDirLocal, preferWeight: 3, minPrefer: 0.35,
    }) || this.findSpot(rand, { maxSlope: 0.3, minSep: 0, aboveSea: 0.2 })
      || this.sunDirLocal.clone();
    this.bloomOrigin.copy(this.landingDir);
    this.occupied = [this.landingDir.clone()];
  }

  // Orient an object so its local +Y is the surface normal, with a random spin.
  placeOnSurface(obj, dir, yaw, lift = 0) {
    const r = this.groundRadius(dir) + lift;
    obj.position.copy(dir).multiplyScalar(r);
    const n = this.normalAt(dir, _v);
    obj.quaternion.setFromUnitVectors(_up, n);
    obj.rotateY(yaw);
  }

  matrixOnSurface(dir, yaw, scale, lift, out) {
    const n = this.normalAt(dir, _v);
    _q.setFromUnitVectors(_up, n);
    _q.multiply(new THREE.Quaternion().setFromAxisAngle(_up, yaw));
    _p0.copy(dir).multiplyScalar(this.groundRadius(dir) + lift);
    return out.compose(_p0, _q, _s.setScalar(scale));
  }

  scatterProps() {
    const def = this.def;
    const rand = rng(def.seed + 555);
    const A = this.assets;
    this.growables = [];

    const makeInstanced = (source, count, kind) => {
      if (!count) return null;
      const mesh = new THREE.InstancedMesh(source.geometry, source.material, count);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.userData.kind = kind;
      mesh.count = 0; // filled as we find spots
      this.group.add(mesh);
      return mesh;
    };

    // Trees stand there from the first frame, grey and half-size: the world is
    // dormant, not empty. The wave brings back both their colour and their height.
    const treeSrc = A.tree;
    this.trees = makeInstanced(treeSrc, def.props.trees, 'tree');
    if (this.trees) {
      this.trees.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(def.props.trees * 3), 3);
      this.trees.instanceColor.setUsage(THREE.DynamicDrawUsage);
    }
    for (let i = 0; i < def.props.trees; i++) {
      const dir = this.findSpot(rand, { maxSlope: 0.48, minSep: 0.1, taken: this.occupied, aboveSea: 0.2, tries: 420 });
      if (!dir) break;
      this.occupied.push(dir);
      const item = {
        dir, yaw: rand() * TAU, scale: (1.4 + rand() * 0.8) * (def.radius / 11),
        mesh: this.trees, index: this.trees.count++, grow: 0,
        angle: dir.angleTo(this.bloomOrigin), lift: -0.05,
      };
      this.growables.push(item);
      this.trees.setMatrixAt(item.index, this.matrixOnSurface(dir, item.yaw, item.scale * DORMANT, item.lift, _m));
      this.trees.setColorAt(item.index, _col.setRGB(0, 0, 0)); // r = alive
    }

    if (this.trees?.instanceColor) this.trees.instanceColor.needsUpdate = true;

    this.rocks = makeInstanced(A.rock, def.props.rocks, 'rock');
    for (let i = 0; i < def.props.rocks; i++) {
      const dir = this.findSpot(rand, { maxSlope: 0.7, minSep: 0.08, taken: this.occupied, aboveSea: 0.0, tries: 380 });
      if (!dir) break;
      this.occupied.push(dir);
      const s = (0.7 + rand() * 1.05) * (def.radius / 11);
      this.rocks.setMatrixAt(this.rocks.count++, this.matrixOnSurface(dir, rand() * TAU, s, -0.15, _m));
    }

    this.crystals = makeInstanced(A.crystal, def.props.crystals, 'crystal');
    for (let i = 0; i < def.props.crystals; i++) {
      const dir = this.findSpot(rand, { maxSlope: 0.75, minSep: 0.1, taken: this.occupied, aboveSea: 0.1, tries: 380 });
      if (!dir) break;
      this.occupied.push(dir);
      const s = (0.8 + rand() * 0.8) * (def.radius / 11);
      this.crystals.setMatrixAt(this.crystals.count++, this.matrixOnSurface(dir, rand() * TAU, s, -0.08, _m));
    }
    if (this.crystals) {
      this.crystals.material = this.crystals.material.clone();
      this.crystals.material.emissive = new THREE.Color(def.lush[3]);
      this.crystals.material.emissiveIntensity = def.dark ? 0.4 : 0.1;
    }

    this.houses = [];
    for (let i = 0; i < (def.props.houses || 0); i++) {
      const dir = this.findSpot(rand, { maxSlope: 0.26, minSep: 0.45, taken: this.occupied, aboveSea: 0.3, tries: 500 });
      if (!dir) break;
      this.occupied.push(dir);
      const obj = A.house.object.clone(true);
      const s = 1.7 * (def.radius / 11);
      obj.scale.setScalar(s);
      this.placeOnSurface(obj, dir, rand() * TAU, -0.05 * s);
      obj.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      this.group.add(obj);
      // A warm window that only lights once the world is alive again.
      const glow = new THREE.PointLight(0xffc98a, 0, 5, 2);
      glow.position.copy(obj.position).addScaledVector(dir, 0.6);
      this.group.add(glow);
      this.houses.push({ obj, glow });
    }
  }

  // Everything that springs up behind the bloom front shares this: scale in as
  // the front passes, overshoot slightly, then sway.
  waveScale(mat, uniforms, { sway = 0.10, feather = 0.30, pop = 0.45 } = {}) {
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
          uniform vec3 uBloomOrigin;
          uniform float uBloomRadius;
          uniform float uTime;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          vec3 iPos = vec3(instanceMatrix[3]);
          float ang = acos(clamp(dot(normalize(iPos), uBloomOrigin), -1.0, 1.0));
          float g = 1.0 - smoothstep(uBloomRadius - ${feather}, uBloomRadius, ang);
          g *= 1.0 + ${pop} * exp(-pow((uBloomRadius - ang) * 5.0 - 1.0, 2.0));
          float sway = sin(uTime * 1.9 + iPos.x * 2.3 + iPos.z * 1.7) * ${sway};
          transformed.xz += sway * transformed.y;
          transformed *= g;`);
    };
    mat.customProgramCacheKey = () => `wave-${feather}-${pop}-${sway}`;
    return mat;
  }

  // Flowers only exist after the bloom, and they are the clearest read on it:
  // colour that was not there a second ago, at eye level rather than underfoot.
  buildFlowers() {
    const def = this.def;
    const count = Math.round((def.grass || 0) * 0.16);
    if (!count) return;
    const rand = rng(def.seed + 6161);

    const stem = new THREE.CylinderGeometry(0.012, 0.016, 0.17, 4);
    stem.translate(0, 0.085, 0);
    const head = new THREE.IcosahedronGeometry(0.075, 0);
    head.scale(1, 0.62, 1);
    head.translate(0, 0.2, 0);
    const geo = mergeParts([stem, head]);
    const cols = [];
    const gp = geo.attributes.position;
    for (let i = 0; i < gp.count; i++) {
      const petal = gp.getY(i) > 0.15;
      cols.push(petal ? 1 : 0.28, petal ? 1 : 0.42, petal ? 1 : 0.24);
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.85, metalness: 0, side: THREE.DoubleSide,
    });
    this.waveScale(mat, this.grassUniforms, { sway: 0.06, feather: 0.26, pop: 0.7 });

    const mesh = new THREE.InstancedMesh(geo, mat, count);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = true;

    const hues = (def.flowers ?? ['#ffd6e8', '#fff2b0', '#d9c2ff']).map((c) => new THREE.Color(c));
    const scaleFor = def.radius / 11;
    let n = 0;
    for (let i = 0; i < count * 4 && n < count; i++) {
      randomDir(rand, _v);
      if (this.surfaceRadius(_v) < this.seaRadius + 0.25) continue;
      if (this.slopeAt(_v) > 0.46) continue;
      this.matrixOnSurface(_v, rand() * TAU, (0.9 + rand() * 0.7) * scaleFor, -0.02, _m);
      mesh.setMatrixAt(n, _m);
      mesh.setColorAt(n, _col.copy(hues[(rand() * hues.length) | 0]));
      n++;
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
    this.flowers = mesh;
    this.group.add(mesh);
  }

  // A drifting cloud deck. Nothing sells "planet" like weather you can see
  // moving over the ground from orbit.
  buildClouds() {
    const def = this.def;
    if (def.clouds === false) return;
    this.cloudUniforms = {
      uTime: { value: 0 },
      uSun: { value: new THREE.Vector3(0, 1, 0) },
      uCover: { value: def.cloudCover ?? 0.52 },
      uTint: { value: new THREE.Color(def.cloudTint ?? 0xffffff) },
      uShade: { value: new THREE.Color(def.dark ? 0x2a2338 : 0x8fa2bd) },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.cloudUniforms,
      transparent: true,
      depthWrite: false,
      side: THREE.FrontSide,
      vertexShader: `
        varying vec3 vN;
        void main() {
          vN = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        #define OCTAVES ${LOW_FX ? 3 : 4}
        uniform float uTime; uniform vec3 uSun; uniform float uCover;
        uniform vec3 uTint; uniform vec3 uShade;
        varying vec3 vN;
        // Value noise: a fifth the instructions of simplex and indistinguishable
        // once four octaves of it are being used as cloud cover.
        float hash(vec3 p) {
          p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
          p *= 17.0;
          return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
        }
        float vnoise(vec3 x) {
          vec3 i = floor(x), f = fract(x);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x),
                         mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
                     mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x),
                         mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
        }
        float fbm(vec3 p) {
          float a = 0.5, s = 0.0, norm = 0.0;
          for (int i = 0; i < OCTAVES; i++) { s += a * vnoise(p); norm += a; p *= 2.07; a *= 0.5; }
          return s / norm;   // normalised, so uCover means the same on every world
        }
        void main() {
          vec3 p = vN * 3.1 + vec3(uTime * 0.012, uTime * 0.005, -uTime * 0.009);
          float d = fbm(p);
          // A faster, finer layer torn across the first one gives banks an edge
          // that frays instead of ending on a contour line.
          ${LOW_FX ? '' : `float wisp = fbm(vN * 7.4 + vec3(-uTime * 0.03, uTime * 0.018, uTime * 0.024));
          d = d * 0.78 + wisp * 0.22;`}
          float a = smoothstep(uCover, uCover + 0.16, d) * 0.78;
          a *= 0.55 + 0.45 * smoothstep(uCover - 0.04, uCover + 0.3, d);
          if (a < 0.02) discard;
          float lit = max(dot(vN, normalize(uSun)), 0.0);
          vec3 col = mix(uShade, uTint, lit * 0.85 + 0.15);
          gl_FragColor = vec4(col, a);
        }`,
    });
    this.clouds = new THREE.Mesh(new THREE.SphereGeometry(def.radius * 1.09, LOW_FX ? 40 : 64, LOW_FX ? 24 : 40), mat);
    this.clouds.renderOrder = 2;
    this.group.add(this.clouds);
  }

  // Mist pools where the ground is low. This is one shell a little above sea
  // level: everywhere the land rises through it the terrain simply occludes it,
  // so the mist ends up in the valleys and over the water for free.
  buildMist() {
    const def = this.def;
    if (def.mist === false) return;
    this.mistUniforms = {
      uTime: { value: 0 },
      uColor: { value: new THREE.Color(def.mistTint ?? 0xdfe8f0) },
      uSun: { value: new THREE.Vector3(0, 1, 0) },
      uDensity: { value: def.mistDensity ?? 0.5 },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.mistUniforms,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.NormalBlending,
      vertexShader: `
        varying vec3 vN;
        varying vec3 vView;
        void main() {
          vN = normalize(position);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vView = mv.xyz;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform float uTime; uniform vec3 uColor; uniform vec3 uSun; uniform float uDensity;
        varying vec3 vN; varying vec3 vView;
        float hash(vec3 p) {
          p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
          p *= 17.0;
          return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
        }
        float vnoise(vec3 x) {
          vec3 i = floor(x), f = fract(x);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x),
                         mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
                     mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x),
                         mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
        }
        void main() {
          vec3 p = vN * 5.0 + vec3(uTime * 0.02, -uTime * 0.014, uTime * 0.011);
          float d = ${LOW_FX ? 'vnoise(p)' : 'vnoise(p) * 0.6 + vnoise(p * 2.3) * 0.4'};
          // Thickest edge-on, which is how a shallow layer of air actually reads.
          float graze = 1.0 - abs(dot(normalize(vN), normalize(-vView)));
          float a = smoothstep(0.38, 0.78, d) * uDensity * (0.35 + graze * 0.9);
          if (a < 0.01) discard;
          float lit = max(dot(vN, normalize(uSun)), 0.0) * 0.6 + 0.4;
          gl_FragColor = vec4(uColor * lit, min(a, 0.72));
        }`,
    });
    this.mist = new THREE.Mesh(
      new THREE.SphereGeometry(this.seaRadius + (def.mistHeight ?? 0.55), LOW_FX ? 48 : 96, LOW_FX ? 28 : 56), mat,
    );
    this.mist.renderOrder = 1;
    this.group.add(this.mist);
  }

  // Threats are built on first arrival, not at world-build time: five worlds
  // of skinned monsters up front is memory nobody is looking at yet.
  spawnThreats() {
    if (this.threatsReady) return;
    this.threatsReady = true;
    const t = this.def.threats;
    if (!t) return;
    if (t.meteors) this.meteors = new MeteorStorm(this, t.meteors);
    if (t.gloom) this.gloom = new Gloom(this, this.assets, t.gloom);
  }

  updateThreats(dt, time, player, ctx) {
    this.meteors?.update(dt, time, player, ctx);
    this.gloom?.update(dt, time, player, ctx);
  }

  buildGrass() {
    const def = this.def;
    const count = def.grass || 0;
    this.grassUniforms = {
      uBloomOrigin: { value: this.bloomOrigin },
      uBloomRadius: { value: 0 },
      uTime: { value: 0 },
    };
    if (!count) return;
    const rand = rng(def.seed + 313);

    // One cluster = three crossed tapered blades, dark at the root.
    const blade = [];
    const idx = [];
    const cols = [];
    for (let b = 0; b < 3; b++) {
      const a = (b / 3) * TAU + rand() * 0.4;
      const dx = Math.cos(a), dz = Math.sin(a);
      const w = 0.032;
      const o = blade.length / 3;
      blade.push(-dz * w, 0, dx * w, dz * w, 0, -dx * w, dx * 0.02, 0.18, dz * 0.02);
      idx.push(o, o + 1, o + 2);
      cols.push(0.62, 0.6, 0.5, 0.68, 0.66, 0.55, 1.35, 1.35, 1.2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(blade, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();

    const tint = new THREE.Color(def.lush[2]).convertSRGBToLinear();
    const mat = new THREE.MeshStandardMaterial({
      color: tint, vertexColors: true, side: THREE.DoubleSide, roughness: 1.0,
      metalness: 0.0,
    });
    this.waveScale(mat, this.grassUniforms);

    const mesh = new THREE.InstancedMesh(geo, mat, count);
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    let n = 0;
    const scaleFor = def.radius / 11;
    for (let i = 0; i < count * 3 && n < count; i++) {
      randomDir(rand, _v);
      const r = this.surfaceRadius(_v);
      if (r < this.seaRadius + 0.12) continue;
      if (this.slopeAt(_v) > 0.62) continue;
      mesh.setMatrixAt(n++, this.matrixOnSurface(_v, rand() * TAU, (1.05 + rand() * 0.8) * scaleFor, -0.02, _m));
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    this.grass = mesh;
    this.group.add(mesh);
  }

  placeMotes() {
    const def = this.def;
    const rand = rng(def.seed + 4242);
    const moteSpots = [this.landingDir.clone()];
    this.motes = [];
    if (!def.motes) return;

    const geo = new THREE.IcosahedronGeometry(0.26, 1);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xfff3c4, emissive: 0xffd97a, emissiveIntensity: 1.5,
      roughness: 0.4, metalness: 0.0,
    });
    // A billboarded glow reads as light; a translucent sphere read as a bubble.
    const haloMat = new THREE.SpriteMaterial({
      map: glowSprite(), color: 0xffd98a, transparent: true, opacity: 0.85,
      depthWrite: false, blending: THREE.AdditiveBlending,
    });

    for (let i = 0; i < def.motes; i++) {
      // Half sit on the ground, half float high enough to need a jump.
      const high = i % 3 === 2;
      // Sparks are spread against each other and the landing site only. Sharing
      // the prop occupancy list starved them of spots and quietly shrank the
      // count the HUD promised.
      const dir = this.findSpot(rand, {
        maxSlope: high ? 0.85 : 0.55, minSep: 0.5, taken: moteSpots, aboveSea: 0.2, tries: 600,
      });
      if (!dir) break;
      moteSpots.push(dir);
      const obj = new THREE.Group();
      const core = new THREE.Mesh(geo, mat);
      const halo = new THREE.Sprite(haloMat);
      halo.scale.setScalar(1.9);
      obj.add(core, halo);
      const lift = high ? 2.3 + rand() * 1.2 : 0.75;
      obj.position.copy(dir).multiplyScalar(this.groundRadius(dir) + lift);
      this.group.add(obj);
      this.motes.push({
        obj, core, halo, dir, lift, taken: false,
        phase: rand() * TAU, base: obj.position.clone(),
        up: dir.clone(),
      });
    }
    this.moteTotal = this.motes.length;
  }

  buildBeacon() {
    const A = this.assets;
    const dir = this.landingDir;
    this.beaconDir = dir;
    const obj = A.lantern.object.clone(true);
    const s = 1.9 * (this.def.radius / 11);
    obj.scale.setScalar(s);
    this.placeOnSurface(obj, dir, 0, -0.05);
    obj.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    this.group.add(obj);

    const flame = new THREE.Mesh(
      new THREE.SphereGeometry(0.3 * s, 14, 12),
      new THREE.MeshBasicMaterial({ color: 0xffe6a8, transparent: true, opacity: 0 }),
    );
    flame.position.copy(dir).multiplyScalar(this.groundRadius(dir) + 1.35 * s);
    this.group.add(flame);

    const light = new THREE.PointLight(0xffd68a, 0, 13, 1.9);
    light.position.copy(flame.position);
    this.group.add(light);

    // A soft halo instead of a light column: on a world this small you can see
    // the beacon from anywhere anyway, and a column swallows the sky.
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowSprite(), color: 0xffdc9a, transparent: true, opacity: 0,
      depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    halo.scale.setScalar(2.4 * s);
    halo.position.copy(flame.position);
    this.group.add(halo);

    this.beacon = { obj, flame, light, halo, dir, emit: 0 };
  }

  // Floating stepping stones: a flat disc you can actually stand on, with a
  // cone keel under it so it reads as a torn-off piece of the world.
  buildIslets() {
    const rand = rng(this.def.seed + 777);
    this.islets = [];
    const thickness = 0.5;
    const topMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(this.def.dry[4]).convertSRGBToLinear(),
      roughness: 0.95, metalness: 0, flatShading: true,
    });
    for (let i = 0; i < this.def.islets; i++) {
      randomDir(rand, _v);
      const dir = _v.clone();
      const radius = 1.5 + rand() * 0.7;
      // Reachable by one jump from the ground below: apex is v^2/2g, and the
      // keeper has to clear the top face, not just the underside.
      const height = this.surfaceRadius(dir) + 2.2 + rand() * 1.0;

      const mesh = new THREE.Group();
      const disc = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius * 0.92, thickness, 11), topMat);
      const keel = new THREE.Mesh(new THREE.ConeGeometry(radius * 0.86, radius * 0.95, 11), topMat);
      keel.position.y = -thickness * 0.5 - radius * 0.47;
      keel.rotation.x = Math.PI;
      keel.rotation.y = rand() * TAU;
      mesh.add(disc, keel);
      mesh.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      mesh.quaternion.setFromUnitVectors(_up, dir);
      this.group.add(mesh);

      const islet = {
        mesh, dir, radius, height, thickness, bob: 0.5 + rand() * 0.55,
        phase: rand() * TAU, speed: 0.32 + rand() * 0.3, y: height, vy: 0,
      };
      this.islets.push(islet);

      // Every islet is worth the trip: one mote hovering just above it.
      if (this.motes.length && i % 2 === 0) {
        const m = this.motes[i % this.motes.length];
        if (m && !m.islet) {
          m.islet = islet;
          m.dir = dir.clone();
          m.up = dir.clone();
        }
      }
    }
  }

  buildHeartTree() {
    const src = this.assets.tree;
    const tree = new THREE.Mesh(src.geometry, src.material.clone());
    const dir = this.landingDir.clone();
    tree.scale.setScalar(0.001);
    this.placeOnSurface(tree, dir, 0, -0.1);
    tree.castShadow = true;
    this.group.add(tree);
    this.heartTree = { obj: tree, dir, grow: 0, target: 5.5 };
  }

  // -------------------------------------------------------------- lifecycle

  startBloom(originDir) {
    if (this.bloomed) return;
    this.bloomOrigin.copy(originDir).normalize();
    this.terrainUniforms.uBloomOrigin.value.copy(this.bloomOrigin);
    if (this.grassUniforms) this.grassUniforms.uBloomOrigin.value.copy(this.bloomOrigin);
    for (const g of this.growables) g.angle = g.dir.angleTo(this.bloomOrigin);
    this.waveRadius = 0;
    this.waveActive = true;
    this.waveShoved = false;   // the front shoves the keeper once as it passes
    this.bloomed = true;
  }

  update(dt, time) {
    const def = this.def;
    this.group.rotation.y += (def.spin || 0) * dt;
    if (this.waterUniforms) this.waterUniforms.uTime.value = time;
    if (this.grassUniforms) this.grassUniforms.uTime.value = time;
    if (this.cloudUniforms) {
      this.cloudUniforms.uTime.value = time;
      // The sun in this planet's own frame, since the group is turning.
      _v.copy(SUN_POSITION).sub(this.group.position).normalize();
      _m.copy(this.group.matrixWorld).invert();
      this.cloudUniforms.uSun.value.copy(_v).transformDirection(_m).normalize();
      this.clouds.rotation.y += dt * 0.008;
    }
    if (this.mistUniforms) {
      this.mistUniforms.uTime.value = time;
      this.mistUniforms.uSun.value.copy(this.cloudUniforms?.uSun.value ?? _up);
    }

    if (this.waveActive) {
      this.waveRadius += dt * 1.5;
      this.terrainUniforms.uBloomRadius.value = this.waveRadius;
      if (this.grassUniforms) this.grassUniforms.uBloomRadius.value = this.waveRadius;
      this.lush = clamp(this.waveRadius / Math.PI, 0, 1);
      this.water.material.color.copy(this.waterColorDry).lerp(this.waterColorLush, this.lush);
      this.water.material.emissive.copy(this.water.material.color);
      if (this.crystals) this.crystals.material.emissiveIntensity = lerp(def.dark ? 0.4 : 0.1, def.dark ? 1.3 : 0.4, this.lush);
      for (const h of this.houses) h.glow.intensity = this.lush * (def.dark ? 14 : 6);
      if (this.waveRadius > Math.PI + 0.5) { this.waveActive = false; this.lush = 1; }
    }

    // Trees spring up as the wavefront sweeps past them.
    if (this.trees && (this.waveActive || this.treesDirty !== false)) {
      let moving = false;
      for (const g of this.growables) {
        const want = this.waveRadius > g.angle ? 1 : 0;
        if (Math.abs(g.grow - want) > 0.001) {
          g.grow = lerp(g.grow, want, 1 - Math.exp(-5.5 * dt));
          moving = true;
        } else if (g.grow !== want) { g.grow = want; moving = true; }
        // Slight elastic overshoot on the way up.
        const e = lerp(DORMANT, 1, g.grow) * (1 + 0.2 * Math.sin(Math.min(1, g.grow) * Math.PI));
        this.matrixOnSurface(g.dir, g.yaw, Math.max(0.0001, e * g.scale), g.lift, _m);
        g.mesh.setMatrixAt(g.index, _m);
        g.mesh.setColorAt(g.index, _col.setRGB(g.grow, g.grow, g.grow));
      }
      this.trees.instanceMatrix.needsUpdate = true;
      if (this.trees.instanceColor) this.trees.instanceColor.needsUpdate = true;
      this.treesDirty = moving;
    }

    if (this.beacon) {
      const on = this.beaconOn ? 1 : 0;
      this.beaconLevel = lerp(this.beaconLevel ?? 0, on, 1 - Math.exp(-2.2 * dt));
      const flicker = 0.85 + 0.15 * Math.sin(time * 7.3) * Math.sin(time * 3.1);
      this.beacon.flame.material.opacity = this.beaconLevel * 0.95;
      this.beacon.flame.scale.setScalar(0.85 + 0.2 * flicker * this.beaconLevel);
      this.beacon.light.intensity = this.beaconLevel * 7 * flicker;
      this.beacon.halo.material.opacity = this.beaconLevel * 0.6 * flicker;
      this.beacon.halo.scale.setScalar(2.4 * (0.92 + 0.08 * flicker) * (this.def.radius / 11) * 1.9);
    }

    for (const islet of this.islets ?? []) {
      islet.y = islet.height + Math.sin(time * islet.speed + islet.phase) * islet.bob;
      islet.vy = Math.cos(time * islet.speed + islet.phase) * islet.bob * islet.speed;
      islet.mesh.position.copy(islet.dir).multiplyScalar(islet.y);
    }

    for (const m of this.motes) {
      if (m.taken) continue;
      const bobBase = m.islet
        ? m.islet.y + m.islet.thickness * 0.5 + 0.95
        : this.groundRadius(m.dir) + m.lift;
      const bob = Math.sin(time * 1.7 + m.phase) * 0.16;
      m.obj.position.copy(m.dir).multiplyScalar(bobBase + bob);
      // Main sets `attract` when the keeper is close, so sparks lean in. The
      // rate is per second, not per frame: as a raw lerp factor this pulled
      // four times harder at 240Hz than at 60.
      if (m.attract) m.obj.position.lerp(m.attract, 1 - Math.exp(-(m.attractRate ?? 2) * dt));
      m.obj.rotation.y += dt * 1.3;
      m.obj.rotation.x += dt * 0.7;
      const pulse = 1.75 + 0.35 * Math.sin(time * 3.4 + m.phase);
      m.halo.scale.setScalar(pulse);
    }

    if (this.heartTree && this.heartTree.grow > 0) {
      const h = this.heartTree;
      h.shown = lerp(h.shown ?? 0, 1, 1 - Math.exp(-1.1 * dt));
      const e = h.shown * (1 + 0.12 * Math.sin(h.shown * Math.PI));
      h.obj.scale.setScalar(Math.max(0.001, e * h.target));
    }
  }
}
