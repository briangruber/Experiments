// Stylized faceted water: a dense patch under the playable area and a coarse
// skirt out to the horizon, both displaced by the shared wave field.
// Normals come from screen-space derivatives, so every low-poly facet catches
// its own piece of the sun — that's where the sparkle lives.

import * as THREE from 'three';
import { PALETTE, FOG } from '../config.js';
import { wavesGLSL, skyColorGLSL, skyUniforms, waveHeight } from '../shaders/chunks.js';

export function createWater(scene) {
  const w = PALETTE.water;
  const uniforms = {
    ...skyUniforms(),
    uTime: { value: 0 },
    uDeep: { value: new THREE.Color(w.deep) },
    uShallow: { value: new THREE.Color(w.shallow) },
    uMottle: { value: new THREE.Color(w.mottle) },
    uGlint: { value: new THREE.Color(w.glint) },
    uFogColor: { value: new THREE.Color(PALETTE.fog) },
    uFogNear: { value: FOG.near },
    uFogFar: { value: FOG.far },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */ `
      uniform float uTime;
      varying vec3 vWorld;
      ${wavesGLSL}
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        wp.y += waveHeight(wp.xz, uTime);
        vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uDeep, uShallow, uMottle, uGlint;
      uniform vec3 uFogColor;
      uniform float uFogNear, uFogFar;
      varying vec3 vWorld;
      ${skyColorGLSL}

      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float vnoise(vec2 p) {
        vec2 i = floor(p), fr = fract(p);
        vec2 u = fr * fr * (3.0 - 2.0 * fr);
        return mix(
          mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
          mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
      }

      void main() {
        // Flat facet normal from derivatives.
        vec3 N = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
        if (N.y < 0.0) N = -N;

        vec3 V = normalize(vWorld - cameraPosition);
        vec3 R = reflect(V, N);

        // Body: bright teal shallows near the dock, mottled with weed-dark
        // patches, deepening further out.
        float shore = 1.0 - smoothstep(10.0, 60.0, length(vWorld.xz - vec2(0.0, -6.0)));
        float mott = vnoise(vWorld.xz * 0.16 + vec2(0.0, uTime * 0.015));
        mott = smoothstep(0.35, 0.75, mott);
        vec3 body = mix(uDeep, uShallow, shore);
        body = mix(body, uMottle, mott * shore * 0.55);

        // Gentle reflection of the evening sky.
        vec3 rd = normalize(vec3(R.x, max(R.y, 0.03), R.z));
        vec3 refl = skyColor(rd);
        float fres = 0.04 + 0.96 * pow(1.0 - max(dot(N, -V), 0.0), 5.0);
        fres = min(fres * 1.5, 0.9);
        vec3 col = mix(body, refl, fres);

        // Sun path and per-facet sparkle.
        float rs = max(dot(R, uSunDir), 0.0);
        col += uGlint * pow(rs, 24.0) * 0.35;
        col += uGlint * pow(rs, 400.0) * 3.5;

        // Fog toward a horizon that carries the same sun halo as the sky,
        // so the seam between water and sky disappears.
        float vs = max(dot(V, uSunDir), 0.0);
        vec3 fogCol = uFogColor + uSunTint * (0.13 * pow(vs, 6.0) + 0.2 * pow(vs, 32.0));
        float dist = length(vWorld - cameraPosition);
        col = mix(col, fogCol, smoothstep(uFogNear, uFogFar, dist));

        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });

  const near = new THREE.Mesh(
    new THREE.PlaneGeometry(170, 170, 200, 200).rotateX(-Math.PI / 2), material
  );
  near.position.set(0, 0, -35);

  const skirt = new THREE.Mesh(
    new THREE.PlaneGeometry(1300, 1300, 48, 48).rotateX(-Math.PI / 2), material
  );
  skirt.position.set(0, -0.04, -180);

  for (const m of [near, skirt]) {
    m.name = 'water';
    m.frustumCulled = false;
    scene.add(m);
  }

  return {
    material,
    // CPU mirror so props float on the same waves the GPU draws.
    heightAt: (x, z, t) => waveHeight(x, z, t),
    update(dt, t) { uniforms.uTime.value = t; },
  };
}
