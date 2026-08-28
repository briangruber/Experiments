// The sun and the moon as actual bodies.
//
// Two camera-facing quads at 4.2 km — inside the sky dome, outside everything
// else — with depth testing left on so a cliff or the lighthouse still occludes
// them. They render in the transparent queue after all opaque geometry, which
// is what makes that occlusion work at all given the sky writes no depth.
//
// The sun emits well above 1.0 so core/post's bloom has something to chew on:
// a small hard white disc at noon, a fat soft gold one sitting on the water
// line at sunset. The moon is dimmer, carries a phase terminator, very low
// contrast maria and a soft halo ring. Both fade with their own intensity so
// they cross-dissolve through dusk.

import * as THREE from 'three';
import { GLSL } from '../core/glsl.js';
import { LAYER, setLayers } from '../core/layers.js';

const DIST = 4200;

// Angular radius of each body, radians. Larger than life on purpose — the art
// wants a sun you can read at a glance, not an astronomically correct pinhead.
const SUN_ANG = 0.0245;
const MOON_ANG = 0.0225;

// The disc occupies this fraction of the quad's half-extent; the rest is room
// for the glow to fall off in.
const SUN_FILL = 0.32;
const MOON_FILL = 0.30;

const VERT = /* glsl */`
varying vec2 vUv;
void main(){
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const SUN_FRAG = /* glsl */`
varying vec2 vUv;
uniform vec3  uColor;
uniform vec3  uHalo;
uniform float uBright;
uniform float uGlow;
uniform float uSoft;
uniform float uOpacity;

${GLSL.util}

void main(){
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);

  float disc = 1.0 - smoothstep(${SUN_FILL.toFixed(3)} - uSoft, ${SUN_FILL.toFixed(3)} + uSoft, r);
  // A touch of limb softening inside the disc so the edge is not a hard cut.
  disc *= 0.86 + 0.14 * (1.0 - sat(r / ${SUN_FILL.toFixed(3)}));

  float glow = pow(sat(1.0 - r), 3.2);

  vec3 c = uColor * (uBright * disc) + uHalo * (glow * uGlow);
  gl_FragColor = vec4(c * uOpacity, 1.0);
}
`;

const MOON_FRAG = /* glsl */`
varying vec2 vUv;
uniform vec3  uColor;
uniform float uBright;
uniform float uGlow;
uniform float uSoft;
uniform float uPhase;
uniform float uOpacity;

${GLSL.util}
${GLSL.hash}
${GLSL.noise}

const mat2 MROT = mat2(0.80, -0.60, 0.60, 0.80);
float mfbm(vec2 p){
  float s = 0.0, a = 0.5, n = 0.0;
  for(int i=0;i<3;i++){ s += a*vnoise(p); n += a; a *= 0.5; p = MROT*p*2.07; }
  return s/max(n, 1e-4);
}

void main(){
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);

  float fill = ${MOON_FILL.toFixed(3)};
  float disc = 1.0 - smoothstep(fill - uSoft, fill + uSoft, r);

  // Unit-disc coordinates, and the height of the sphere at that point.
  vec2 q = p / fill;
  float z = sqrt(max(1.0 - dot(q, q), 0.0));

  // Phase terminator: an ellipse sweeping across the face. 1 = full.
  float k = 2.0 * uPhase - 1.0;
  float xt = -k * sqrt(max(1.0 - q.y*q.y, 0.0));
  float lit = smoothstep(xt - 0.09, xt + 0.09, q.x);

  // Faint maria. Low contrast on purpose — it should read as texture, not map.
  float m = mfbm(q * 1.9 + 4.0);
  float maria = 1.0 - 0.15 * smoothstep(0.42, 0.70, m);
  float limb = 0.80 + 0.20 * pow(z, 0.45);

  float glow = pow(sat(1.0 - r), 3.0);

  vec3 c = uColor * (uBright * disc * lit * maria * limb) + uColor * (glow * uGlow);
  gl_FragColor = vec4(c * uOpacity, 1.0);
}
`;

const _dir = new THREE.Vector3();
const _neg = new THREE.Vector3();
const _zAxis = new THREE.Vector3(0, 0, 1);

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

function place(mesh, dir) {
  mesh.position.copy(dir).multiplyScalar(DIST);
  _neg.copy(dir).negate();
  mesh.quaternion.setFromUnitVectors(_zAxis, _neg);
}

export function createCelestial() {
  const geo = new THREE.PlaneGeometry(1, 1);

  const sunMat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: SUN_FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    fog: false,
    uniforms: {
      uColor: { value: new THREE.Color(1, 1, 1) },
      uHalo: { value: new THREE.Color(1, 1, 1) },
      uBright: { value: 10 },
      uGlow: { value: 0.6 },
      uSoft: { value: 0.02 },
      uOpacity: { value: 1 },
    },
  });

  const moonMat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: MOON_FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    fog: false,
    uniforms: {
      uColor: { value: new THREE.Color(0.8, 0.88, 1) },
      uBright: { value: 3.4 },
      uGlow: { value: 0.32 },
      uSoft: { value: 0.02 },
      uPhase: { value: 1 },
      uOpacity: { value: 1 },
    },
  });

  const sun = new THREE.Mesh(geo, sunMat);
  const moon = new THREE.Mesh(geo, moonMat);
  const sunSize = 2 * SUN_ANG * DIST / SUN_FILL;
  const moonSize = 2 * MOON_ANG * DIST / MOON_FILL;
  sun.scale.setScalar(sunSize);
  moon.scale.setScalar(moonSize);
  sun.frustumCulled = false;
  moon.frustumCulled = false;
  sun.renderOrder = 1;
  moon.renderOrder = 1;

  const group = new THREE.Group();
  group.add(sun, moon);
  setLayers(group, LAYER.MAIN, LAYER.REFLECTED);

  return {
    group,

    applyEnv(env) {
      // --- sun ---------------------------------------------------------------
      const sunVis = clamp01((env.sunDir.y + 0.025) / 0.050);
      sun.visible = sunVis > 0.002;
      if (sun.visible) {
        _dir.copy(env.sunDir);
        place(sun, _dir);
        const su = sunMat.uniforms;
        su.uColor.value.copy(env.sunDiscColor);
        su.uHalo.value.copy(env.sunHalo);
        // Hot and small when it is high, gold and fat when it is on the water.
        const high = clamp01(env.sunDir.y * 2.2);
        su.uBright.value = 1.8 + 2.0 * clamp01(env.sunIntensity / 3.7) + 7.5 * high;
        su.uGlow.value = 0.35 + 0.85 * (1.0 - high);
        su.uSoft.value = 0.012 + 0.045 * (1.0 - clamp01(env.sunDir.y * 3.0));
        su.uOpacity.value = sunVis;
      }

      // --- moon --------------------------------------------------------------
      const moonVis = clamp01((env.moonDir.y + 0.020) / 0.050) * clamp01(env.moonIntensity * 1.7);
      moon.visible = moonVis > 0.002;
      if (moon.visible) {
        _dir.copy(env.moonDir);
        place(moon, _dir);
        const mu = moonMat.uniforms;
        mu.uColor.value.copy(env.moonColor);
        mu.uBright.value = 0.85 + 0.85 * clamp01(env.moonIntensity);
        mu.uGlow.value = 0.12 + 0.12 * clamp01(env.moonIntensity);
        mu.uSoft.value = 0.014;
        mu.uPhase.value = env.moonPhase;
        mu.uOpacity.value = moonVis;
      }
    },

    update(ctx) {
      const c = ctx.camera.position;
      group.position.set(c.x, 0, c.z);
    },

    dispose() {
      geo.dispose();
      sunMat.dispose();
      moonMat.dispose();
    },
  };
}
