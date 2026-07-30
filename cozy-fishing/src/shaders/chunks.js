// GLSL chunks shared between the sky dome and the water, plus a CPU mirror
// of the wave field so floating props ride the same water the GPU draws.

import * as THREE from 'three';
import { WAVES, PALETTE, SUN_DIR } from '../config.js';

const f = (n) => n.toFixed(5);

export const wavesGLSL = `
float waveHeight(vec2 p, float t) {
  float h = 0.0;
${WAVES.map((w) =>
  `  h += ${f(w.amp)} * sin(dot(vec2(${f(w.dx)}, ${f(w.dz)}), p) * ${f(w.freq)} + t * ${f(w.speed)});`
).join('\n')}
  return h;
}
`;

export function waveHeight(x, z, t) {
  let h = 0;
  for (const w of WAVES) h += w.amp * Math.sin((w.dx * x + w.dz * z) * w.freq + t * w.speed);
  return h;
}

// skyColor(dir): the golden-hour gradient + sun halo. The water reflects it,
// the fog borrows its horizon terms, so everything agrees on the hour.
export const skyColorGLSL = `
uniform vec3 uSunDir;
uniform vec3 uZenith, uMid, uWarm, uHorizon, uSunTint;
vec3 skyColor(vec3 d) {
  float y = max(d.y, 0.0);
  vec3 c = mix(uHorizon, uWarm, smoothstep(0.02, 0.12, y));
  c = mix(c, uMid, smoothstep(0.10, 0.32, y));
  c = mix(c, uZenith, smoothstep(0.28, 0.62, y));
  float s = max(dot(d, uSunDir), 0.0);
  c += uSunTint * (0.13 * pow(s, 6.0) + 0.2 * pow(s, 32.0));
  return c;
}
`;

export const SUN = new THREE.Vector3(...SUN_DIR).normalize();

export function skyUniforms() {
  const c = PALETTE.sky;
  return {
    uSunDir: { value: SUN.clone() },
    uZenith: { value: new THREE.Color(c.zenith) },
    uMid: { value: new THREE.Color(c.mid) },
    uWarm: { value: new THREE.Color(c.warm) },
    uHorizon: { value: new THREE.Color(c.horizon) },
    uSunTint: { value: new THREE.Color(c.sun) },
  };
}
