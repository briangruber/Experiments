// Rain and lightning. Both live entirely on the GPU except for the strike
// envelope, which the director drives so the thunder lands on a cut.

import * as THREE from '../vendor/three/three.module.min.js';
import { clamp01, lerp, mulberry32 } from './util.js';

const BOX = { x: 9, z: 9, y: 7.5 };

export function buildWeather(scene) {
  const rng = mulberry32(1971);

  // --- rain: one LineSegments draw, positions computed in the vertex shader --
  const N = 2600;
  const pos = new Float32Array(N * 2 * 3);
  const seed = new Float32Array(N * 2 * 3);
  const tail = new Float32Array(N * 2);
  for (let i = 0; i < N; i++) {
    const sx = (rng() - 0.5) * 2 * BOX.x;
    const sz = (rng() - 0.5) * 2 * BOX.z;
    const ph = rng();
    const sp = 0.75 + rng() * 0.5;
    for (let k = 0; k < 2; k++) {
      const j = i * 2 + k;
      pos[j * 3] = sx; pos[j * 3 + 1] = 0; pos[j * 3 + 2] = sz;
      seed[j * 3] = ph; seed[j * 3 + 1] = sp; seed[j * 3 + 2] = rng();
      tail[j] = k;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 3));
  g.setAttribute('aTail', new THREE.BufferAttribute(tail, 1));
  const rainMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    uniforms: {
      uTime: { value: 0 }, uAmount: { value: 0 }, uWind: { value: new THREE.Vector2(0.55, 0.2) },
      uColor: { value: new THREE.Color(0xa9c4e6) }, uFlash: { value: 0 },
    },
    vertexShader: `
      attribute vec3 aSeed; attribute float aTail;
      uniform float uTime, uAmount; uniform vec2 uWind;
      varying float vA;
      void main(){
        float speed = 9.0 * aSeed.y;
        float h = ${BOX.y.toFixed(1)};
        float y = h - mod(aSeed.x * h + uTime * speed, h);
        float streak = aTail * (0.28 + aSeed.z * 0.4);
        vec3 p = position;
        p.y = y + streak;
        p.x += uWind.x * (h - y) * 0.1 - uWind.x * streak;
        p.z += uWind.y * (h - y) * 0.1 - uWind.y * streak;
        // Drops beyond the current intensity are simply not drawn.
        vA = step(aSeed.z, uAmount) * (1.0 - aTail * 0.75) * smoothstep(0.0, 0.6, y);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: `
      varying float vA; uniform vec3 uColor; uniform float uFlash;
      void main(){ gl_FragColor = vec4(uColor * (0.55 + uFlash * 3.0), vA * 0.5); }`,
  });
  const rain = new THREE.LineSegments(g, rainMat);
  rain.frustumCulled = false;
  rain.renderOrder = 5;
  scene.add(rain);

  // --- splashes: instanced rings popping on the tiles ------------------------
  const M = 420;
  const ring = new THREE.RingGeometry(0.02, 0.045, 10);
  ring.rotateX(-Math.PI / 2);
  const splashMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    uniforms: { uTime: { value: 0 }, uAmount: { value: 0 } },
    vertexShader: `
      attribute vec2 aOff; attribute float aPhase;
      uniform float uTime, uAmount;
      varying float vA;
      void main(){
        float t = fract(uTime * 1.7 + aPhase);
        float grow = 1.0 + t * 5.5;
        vA = (1.0 - t) * step(aPhase, uAmount) * 0.55;
        vec3 p = position * grow + vec3(aOff.x, 0.008, aOff.y);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: `varying float vA; void main(){ gl_FragColor = vec4(0.62, 0.74, 0.92, vA); }`,
  });
  const splashGeo = new THREE.InstancedBufferGeometry().copy(ring);
  splashGeo.instanceCount = M;
  const off = new Float32Array(M * 2), phase = new Float32Array(M);
  for (let i = 0; i < M; i++) {
    off[i * 2] = (rng() - 0.5) * 14;
    off[i * 2 + 1] = (rng() - 0.5) * 12 - 1;
    phase[i] = rng();
  }
  splashGeo.setAttribute('aOff', new THREE.InstancedBufferAttribute(off, 2));
  splashGeo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase, 1));
  const splash = new THREE.Mesh(splashGeo, splashMat);
  splash.frustumCulled = false;
  splash.renderOrder = 6;
  scene.add(splash);

  // --- lightning -------------------------------------------------------------
  const bolt = new THREE.DirectionalLight(0xd8e6ff, 0);
  bolt.position.set(-6, 12, -9);
  scene.add(bolt);

  const w = {
    rain, rainMat, splash, splashMat, bolt,
    amount: 0, amountTarget: 0, flash: 0, strikes: [], t: 0,
    setRain(v, immediate = false) { this.amountTarget = v; if (immediate) this.amount = v; return this; },
    // A strike is a burst of two or three flashes with a gap — never one.
    strike(power = 1, delay = 0) {
      this.strikes.push({ t: -delay, power, pattern: [0, 0.06, 0.1, 0.34, 0.42] });
      return this;
    },
  };
  return w;
}

export function updateWeather(w, dt, time, set) {
  w.t += dt;
  w.amount = lerp(w.amount, w.amountTarget, 1 - Math.exp(-1.1 * dt));
  w.rainMat.uniforms.uTime.value = time;
  w.rainMat.uniforms.uAmount.value = w.amount;
  w.splashMat.uniforms.uTime.value = time;
  w.splashMat.uniforms.uAmount.value = clamp01(w.amount - 0.15);

  let flash = 0;
  for (let i = w.strikes.length - 1; i >= 0; i--) {
    const s = w.strikes[i];
    s.t += dt;
    if (s.t < 0) continue;
    let v = 0;
    for (const p of s.pattern) {
      const d = s.t - p;
      if (d >= 0 && d < 0.16) v = Math.max(v, Math.pow(1 - d / 0.16, 2.2));
    }
    flash = Math.max(flash, v * s.power);
    if (s.t > 0.75) w.strikes.splice(i, 1);
  }
  w.flash = flash;
  w.bolt.intensity = flash * 9;
  w.rainMat.uniforms.uFlash.value = flash;
  if (set) {
    set.wetness = clamp01(w.amount * 1.15);
    set.flash = flash;
  }
}
