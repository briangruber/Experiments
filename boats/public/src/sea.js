import * as THREE from 'three';
import { waveGLSL } from '/shared/waves.js';
import { seabedGLSL, LAGOON } from '/shared/seabed.js';
import { WORLD } from '/shared/config.js';

// Midday, not golden hour. The reference art is a bright blue afternoon: high
// sun, short shadows, everything legible and cheerful.
export const SUN_DIR = new THREE.Vector3(0.34, 0.66, -0.67).normalize();

// One analytic sky, sampled by the dome, by the water's reflection, and by the
// fog. If they disagree the horizon splits and the illusion dies.
const SKY_GLSL = /* glsl */`
float skyHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float skyNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(skyHash(i), skyHash(i + vec2(1, 0)), f.x),
             mix(skyHash(i + vec2(0, 1)), skyHash(i + vec2(1, 1)), f.x), f.y);
}
float skyFbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * skyNoise(p); p *= 2.03; a *= 0.5; }
  return v;
}

/**
 * Cumulus on a flat plane above the world, sampled by projecting the view
 * direction onto it. Cheap, and it gives the horizon somewhere to be.
 */
/**
 * Only the sky dome pays for weather. The ocean calls skyColor twice per
 * fragment -- once for the reflection, once for the fog -- and a five-octave
 * fbm on every water pixel is enough to hang a software renderer, never mind a
 * phone. Reflections get a clean sky, which at grazing angles nobody misses.
 */
float clouds(vec3 dir, float t) {
#ifndef SKY_CLOUDS
  return 0.0;
#else
  if (dir.y < 0.015) return 0.0;
  // Scale matters more than it looks: too small and the entire sky lands
  // inside one noise cell, which is a flat grey field, not weather.
  vec2 uv = dir.xz / max(dir.y, 0.02) * 1.5 + vec2(t * 0.012, t * 0.006);
  float base = skyFbm(uv * 0.5);
  float detail = skyFbm(uv * 1.7 + base);
  float d = base * 0.72 + detail * 0.28;
  // Sharp-edged puffs rather than fog: the reference is a picture-book sky.
  // Wide gap between the thresholds keeps plenty of blue between the puffs.
  float mask = smoothstep(0.47, 0.70, d);
  // Fade them out at the horizon so the plane projection never shows its edge.
  return mask * smoothstep(0.012, 0.16, dir.y);
#endif
}

vec3 skyColor(vec3 dir, vec3 sunDir) {
  float y = dir.y;
  vec3 zenith  = vec3(0.045, 0.28, 0.80);
  vec3 horizon = vec3(0.48, 0.74, 0.93);
  vec3 col = mix(horizon, zenith, pow(clamp(y, 0.0, 1.0), 0.42));

  float sd = max(dot(dir, sunDir), 0.0);
  col += vec3(1.0, 0.86, 0.62) * pow(sd, 9.0) * 0.30;
  col += vec3(1.0, 0.96, 0.86) * smoothstep(0.9992, 0.99972, sd) * 8.0;

  float c = clouds(dir, uSkyTime);
  if (c > 0.001) {
    // Lit from the sun side, blue-shadowed underneath.
    float lit = 0.55 + 0.45 * max(dot(normalize(dir + sunDir * 0.4), sunDir), 0.0);
    vec3 cloud = mix(vec3(0.62, 0.70, 0.84), vec3(1.0, 0.99, 0.96), lit);
    col = mix(col, cloud, c * 0.94);
  }

  col = mix(col, vec3(0.74, 0.86, 0.96), pow(1.0 - clamp(abs(y) * 3.4, 0.0, 1.0), 3.0) * 0.22);
  if (y < 0.0) col = mix(col, vec3(0.02, 0.14, 0.30), clamp(-y * 5.0, 0.0, 1.0));
  return col;
}`;

export const HORIZON_COLOR = new THREE.Color(0.60, 0.80, 0.93);
export const FOG_DENSITY = 0.00034;

/* --------------------------------------------------------------------- sky */

export function createSky({ segments = 48 } = {}) {
  const geo = new THREE.SphereGeometry(6000, segments, Math.max(12, segments * 0.66));
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: { uSun: { value: SUN_DIR }, uSkyTime: { value: 0 } },
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      precision highp float;
      #define SKY_CLOUDS 1
      uniform vec3 uSun;
      uniform float uSkyTime;
      varying vec3 vDir;
      ${SKY_GLSL}
      void main() {
        vec3 col = skyColor(normalize(vDir), uSun);
        // A little dithering keeps the gradient from banding on cheap panels.
        float d = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
        gl_FragColor = vec4(col + d / 255.0, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -100;
  mesh.userData.uniforms = mat.uniforms;
  return mesh;
}

/* ------------------------------------------------------------------- ocean */

/**
 * A camera-locked grid whose vertices bunch up near the viewer, so we get
 * metre-scale detail around the hull and still reach the horizon with one mesh.
 */
function makeGrid(segments, half, power) {
  const geo = new THREE.BufferGeometry();
  const n = segments + 1;
  const pos = new Float32Array(n * n * 3);
  const axis = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const u = (i / segments) * 2 - 1;
    axis[i] = Math.sign(u) * Math.pow(Math.abs(u), power) * half;
  }
  let k = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      pos[k++] = axis[i];
      pos[k++] = 0;
      pos[k++] = axis[j];
    }
  }
  const idx = new Uint32Array(segments * segments * 6);
  let t = 0;
  for (let j = 0; j < segments; j++) {
    for (let i = 0; i < segments; i++) {
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      idx[t++] = a; idx[t++] = c; idx[t++] = b;
      idx[t++] = b; idx[t++] = c; idx[t++] = d;
    }
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), half * 2);
  return geo;
}

export function createOcean({ segments = 224, half = 2600, detail = 6 } = {}) {
  const geo = makeGrid(segments, half, 1.55);

  const uniforms = {
    uTime: { value: 0 },
    uCenter: { value: new THREE.Vector2() },
    uSun: { value: SUN_DIR },
    uCamera: { value: new THREE.Vector3() },
    uFog: { value: FOG_DENSITY },
    uSkyTime: { value: 0 },
    uDetail: { value: detail },
  };

  const mat = new THREE.ShaderMaterial({
    uniforms,
    fog: false,
    // The lagoon is the whole reason for the opening: you have to be able to
    // see the sand and the fish through the surface. That means real alpha over
    // the seabed mesh, with absorption doing the work instead of a flat colour.
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */`
      precision highp float;
      uniform float uTime;
      uniform vec2 uCenter;
      uniform vec3 uCamera;
      uniform float uDetail;
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying float vCrest;
      ${waveGLSL()}
      void main() {
        vec2 p = position.xz + uCenter;
        // Cheaper waves far away: the horizon does not need the 6cm ripples.
        float d = length(p - uCamera.xz);
        float detail = uDetail - smoothstep(60.0, 900.0, d) * 3.0;
        vec3 nrm; float crest;
        vec3 world = waveField(p, uTime, detail, nrm, crest);
        vWorld = world;
        vNormal = nrm;
        vCrest = crest;
        gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
      }`,
    fragmentShader: /* glsl */`
      precision highp float;
      uniform vec3 uSun;
      uniform vec3 uCamera;
      uniform float uFog;
      uniform float uTime;
      uniform float uSkyTime;
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying float vCrest;
      ${SKY_GLSL}
      ${seabedGLSL()}

      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x),
                   mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
      }

      void main() {
        vec3 n = normalize(vNormal);
        vec3 view = normalize(uCamera - vWorld);
        float dist = length(uCamera - vWorld);

        // Ripple detail that the mesh is too coarse to carry.
        float rip = noise(vWorld.xz * 0.9 + uTime * 0.35) - 0.5
                  + (noise(vWorld.xz * 2.7 - uTime * 0.6) - 0.5) * 0.5;
        n = normalize(n + vec3(rip, 0.0, rip * 0.8) * 0.16 * smoothstep(700.0, 40.0, dist));

        // How much water is under this point, and therefore how much of it we
        // are looking through.
        float bed = seabedHeight(vWorld.xz);
        float depth = max(0.0, vWorld.y - bed);
        float r = length(vWorld.xz);

        // Clarity is a story beat, not just optics: the lagoon is gin-clear,
        // and the water turns to ink at the drop-off.
        float murk = mix(0.040, 0.34, smoothstep(LAGOON_REEF, LAGOON_DEEP, r));
        float absorb = 1.0 - exp(-depth * murk);

        // A postcard palette: emerald over the sand, turquoise over the reef,
        // and a saturated cobalt once the bottom is gone.
        float far = smoothstep(600.0, 2400.0, r);
        vec3 deep = mix(vec3(0.015, 0.10, 0.30), vec3(0.008, 0.045, 0.17), far);
        vec3 lagoon = vec3(0.10, 0.74, 0.66);
        vec3 open = mix(vec3(0.055, 0.42, 0.55), vec3(0.03, 0.26, 0.44), far);
        vec3 tint = mix(lagoon, open, smoothstep(LAGOON_FLAT, LAGOON_BRINK, r));

        float fres = pow(1.0 - max(dot(n, view), 0.0), 5.0);
        fres = mix(0.028, 1.0, fres);

        vec3 refl = skyColor(reflect(-view, n), uSun);
        // Subsurface glow where the crest is thin and the sun is behind it.
        float sss = pow(clamp(vCrest, 0.0, 1.0), 1.6) * pow(max(dot(view, -uSun), 0.0) * 0.5 + 0.5, 2.0);
        vec3 body = mix(tint, deep, absorb);
        body += vec3(0.12, 0.48, 0.36) * sss * 0.9;

        vec3 col = mix(body, refl, fres);

        // Sun glitter.
        vec3 h = normalize(uSun + view);
        col += vec3(1.0, 0.94, 0.82) * pow(max(dot(n, h), 0.0), 520.0) * 2.1;

        // Foam: where the Gerstner crest sharpens past the point of breaking.
        float foam = smoothstep(0.66, 0.98, vCrest);
        foam *= 0.62 + 0.38 * noise(vWorld.xz * 1.1 + uTime * 0.25);
        foam *= smoothstep(900.0, 140.0, dist);
        col = mix(col, vec3(0.86, 0.92, 0.94), clamp(foam, 0.0, 0.82));

        float fog = 1.0 - exp(-pow(dist * uFog, 2.0));
        vec3 fogDir = normalize(vec3(-view.x, 0.015, -view.z));
        col = mix(col, skyColor(fogDir, uSun), clamp(fog, 0.0, 1.0));

        // Opaque where the water swallows the light, glassy where it does not.
        // The reflection always survives, which is what keeps the lagoon from
        // looking like coloured cellophane.
        float alpha = clamp(fres + (1.0 - fres) * absorb, 0.0, 1.0);
        alpha = max(alpha, fog);
        gl_FragColor = vec4(col, alpha);
      }`,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;

  return {
    mesh,
    uniforms,
    update(time, camera) {
      uniforms.uTime.value = time;
      // Snap the grid so vertices do not crawl as the camera drifts.
      uniforms.uCenter.value.set(
        Math.round(camera.position.x / 8) * 8,
        Math.round(camera.position.z / 8) * 8
      );
      mesh.position.set(uniforms.uCenter.value.x, 0, uniforms.uCenter.value.y);
      uniforms.uCamera.value.copy(camera.position);
    },
  };
}

/* ------------------------------------------------------------------ lights */

export function createLights(scene, { shadows = true, shadowMap = 2048, shadowSpan = 150 } = {}) {
  const sun = new THREE.DirectionalLight(0xfff0d6, 2.6);
  sun.position.copy(SUN_DIR).multiplyScalar(300);
  scene.add(sun);
  scene.add(sun.target);

  if (shadows) {
    // One tight ortho box that follows the player. Anything further away than
    // this is fogged or under water, so a cascade would be paying for nothing.
    sun.castShadow = true;
    sun.shadow.mapSize.set(shadowMap, shadowMap);
    const c = sun.shadow.camera;
    c.left = -shadowSpan; c.right = shadowSpan;
    c.top = shadowSpan; c.bottom = -shadowSpan;
    c.near = 1; c.far = 900;
    c.updateProjectionMatrix();
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.9;      // stops the sand self-striping
  }

  // Ambient now comes mostly from the environment map generated off the sky
  // dome; this is only the fill under it.
  const sky = new THREE.HemisphereLight(0x9ec8dd, 0x123040, 0.8);
  scene.add(sky);

  const fill = new THREE.DirectionalLight(0x7fb4cc, 0.32);
  fill.position.set(-SUN_DIR.x, 0.4, -SUN_DIR.z).multiplyScalar(200);
  scene.add(fill);

  return {
    sun, sky, fill, shadowSpan,
    /**
     * Keep the shadow box over the player, snapped to whole texels so the
     * shadow edges do not crawl as the world slides underneath.
     */
    follow(x, z) {
      const texel = (shadowSpan * 2) / shadowMap;
      const sx = Math.round(x / texel) * texel;
      const sz = Math.round(z / texel) * texel;
      sun.target.position.set(sx, 0, sz);
      sun.position.set(sx + SUN_DIR.x * 320, SUN_DIR.y * 320, sz + SUN_DIR.z * 320);
      sun.target.updateMatrixWorld();
      sun.updateMatrixWorld();
    },
  };
}

/** The wall of dark water that marks the edge of the charted sea. */
export function createWorldEdge() {
  const geo = new THREE.CylinderGeometry(WORLD.radius + 60, WORLD.radius + 60, 260, 96, 1, true);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    fog: false,
    uniforms: { uTime: { value: 0 } },
    vertexShader: `
      varying vec3 vP;
      void main() { vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      precision highp float;
      uniform float uTime;
      varying vec3 vP;
      void main() {
        float up = smoothstep(-130.0, 90.0, vP.y);
        float band = 0.5 + 0.5 * sin(vP.x * 0.02 + vP.z * 0.017 + uTime * 0.4);
        vec3 col = mix(vec3(0.05, 0.12, 0.18), vec3(0.32, 0.42, 0.5), band * 0.4);
        gl_FragColor = vec4(col, (1.0 - up) * 0.75);
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = 60;
  return { mesh, uniforms: mat.uniforms };
}
