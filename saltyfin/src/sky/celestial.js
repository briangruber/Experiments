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
//
// Ported from GLSL to TSL. The old `varying vec2 vUv` is just `uv()`; the maria
// fbm is the shared value noise from sky.js, same hash constants as the WebGL
// build so the moon has the same face.

import * as THREE from 'three';
import {
  Fn, uniform, uv, vec4, float,
  max, clamp, pow, dot, smoothstep, sqrt, length,
} from 'three/tsl';
import { fbmValue2 } from './sky.js';
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

  const bodyMat = () => {
    const m = new THREE.NodeMaterial();
    m.transparent = true;
    m.depthWrite = false;
    m.depthTest = true;
    m.blending = THREE.AdditiveBlending;
    m.fog = false;
    return m;
  };

  // --- sun -------------------------------------------------------------------
  const sunColor = uniform(new THREE.Vector3(1, 1, 1));
  const sunHalo = uniform(new THREE.Vector3(1, 1, 1));
  const sunBright = uniform(10);
  const sunGlow = uniform(0.6);
  const sunSoft = uniform(0.02);
  const sunOpacity = uniform(1);

  const sunMat = bodyMat();
  sunMat.fragmentNode = Fn(() => {
    const p = uv().mul(2.0).sub(1.0).toVar();
    const r = length(p).toVar();

    const disc = smoothstep(
      float(SUN_FILL).sub(sunSoft), float(SUN_FILL).add(sunSoft), r,
    ).oneMinus().toVar();
    // A touch of limb softening inside the disc so the edge is not a hard cut.
    disc.mulAssign(clamp(r.div(SUN_FILL), 0, 1).oneMinus().mul(0.14).add(0.86));

    const glow = pow(clamp(r.oneMinus(), 0, 1), 3.2).toVar();

    const c = sunColor.mul(sunBright.mul(disc)).add(sunHalo.mul(glow.mul(sunGlow))).toVar();
    return vec4(c.mul(sunOpacity), 1.0);
  })();

  // --- moon ------------------------------------------------------------------
  const moonColor = uniform(new THREE.Vector3(0.8, 0.88, 1));
  const moonBright = uniform(3.4);
  const moonGlow = uniform(0.32);
  const moonSoft = uniform(0.02);
  const moonPhase = uniform(1);
  const moonOpacity = uniform(1);

  const moonMat = bodyMat();
  moonMat.fragmentNode = Fn(() => {
    const p = uv().mul(2.0).sub(1.0).toVar();
    const r = length(p).toVar();

    const disc = smoothstep(
      float(MOON_FILL).sub(moonSoft), float(MOON_FILL).add(moonSoft), r,
    ).oneMinus().toVar();

    // Unit-disc coordinates, and the height of the sphere at that point.
    const q = p.div(MOON_FILL).toVar();
    const z = sqrt(max(float(1.0).sub(dot(q, q)), 0.0)).toVar();

    // Phase terminator: an ellipse sweeping across the face. 1 = full.
    const k = moonPhase.mul(2.0).sub(1.0).toVar();
    const xt = k.negate().mul(sqrt(max(float(1.0).sub(q.y.mul(q.y)), 0.0))).toVar();
    const lit = smoothstep(xt.sub(0.09), xt.add(0.09), q.x).toVar();

    // Faint maria. Low contrast on purpose — it should read as texture, not map.
    const m = fbmValue2(q.mul(1.9).add(4.0), 3).toVar();
    const maria = smoothstep(0.42, 0.70, m).mul(0.15).oneMinus().toVar();
    const limb = pow(z, 0.45).mul(0.20).add(0.80).toVar();

    const glow = pow(clamp(r.oneMinus(), 0, 1), 3.0).toVar();

    const c = moonColor.mul(moonBright.mul(disc).mul(lit).mul(maria).mul(limb))
      .add(moonColor.mul(glow.mul(moonGlow))).toVar();
    return vec4(c.mul(moonOpacity), 1.0);
  })();

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
        sunColor.value.set(env.sunDiscColor.r, env.sunDiscColor.g, env.sunDiscColor.b);
        sunHalo.value.set(env.sunHalo.r, env.sunHalo.g, env.sunHalo.b);
        // Hot and small when it is high, gold and fat when it is on the water.
        const high = clamp01(env.sunDir.y * 2.2);
        sunBright.value = 1.8 + 2.0 * clamp01(env.sunIntensity / 3.7) + 7.5 * high;
        sunGlow.value = 0.35 + 0.85 * (1.0 - high);
        sunSoft.value = 0.012 + 0.045 * (1.0 - clamp01(env.sunDir.y * 3.0));
        sunOpacity.value = sunVis;
      }

      // --- moon --------------------------------------------------------------
      const moonVis = clamp01((env.moonDir.y + 0.020) / 0.050) * clamp01(env.moonIntensity * 1.7);
      moon.visible = moonVis > 0.002;
      if (moon.visible) {
        _dir.copy(env.moonDir);
        place(moon, _dir);
        moonColor.value.set(env.moonColor.r, env.moonColor.g, env.moonColor.b);
        moonBright.value = 0.85 + 0.85 * clamp01(env.moonIntensity);
        moonGlow.value = 0.12 + 0.12 * clamp01(env.moonIntensity);
        moonSoft.value = 0.014;
        moonPhase.value = env.moonPhase;
        moonOpacity.value = moonVis;
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
