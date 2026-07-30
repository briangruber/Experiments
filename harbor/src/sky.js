import * as THREE from 'three';

export const SUN_DIR = new THREE.Vector3(0.42, 0.72, -0.55).normalize();
export const HORIZON_COLOR = new THREE.Color(0.55, 0.78, 0.95);
export const FOG_DENSITY = 0.00028;

export const SKY_GLSL = /* glsl */`
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

float clouds(vec3 dir, float t) {
#ifndef SKY_CLOUDS
  return 0.0;
#else
  if (dir.y < 0.015) return 0.0;
  vec2 uv = dir.xz / max(dir.y, 0.02) * 1.35 + vec2(t * 0.010, t * 0.005);
  float base = skyFbm(uv * 0.48);
  float detail = skyFbm(uv * 1.6 + base);
  float d = base * 0.72 + detail * 0.28;
  float mask = smoothstep(0.46, 0.68, d);
  return mask * smoothstep(0.012, 0.18, dir.y);
#endif
}

vec3 skyColor(vec3 dir, vec3 sunDir) {
  float y = dir.y;
  // Bright postcard afternoon: saturated blue, soft white puffs.
  vec3 zenith  = vec3(0.10, 0.42, 0.92);
  vec3 mid     = vec3(0.32, 0.62, 0.95);
  vec3 horizon = vec3(0.72, 0.88, 0.98);
  vec3 col = mix(horizon, mid, smoothstep(0.0, 0.35, y));
  col = mix(col, zenith, pow(clamp(y, 0.0, 1.0), 0.55));

  float sd = max(dot(dir, sunDir), 0.0);
  col += vec3(1.0, 0.90, 0.70) * pow(sd, 8.0) * 0.28;
  col += vec3(1.0, 0.97, 0.88) * smoothstep(0.9990, 0.9997, sd) * 7.0;

  float c = clouds(dir, uSkyTime);
  if (c > 0.001) {
    float lit = 0.58 + 0.42 * max(dot(normalize(dir + sunDir * 0.35), sunDir), 0.0);
    vec3 cloud = mix(vec3(0.70, 0.78, 0.90), vec3(1.0, 0.995, 0.98), lit);
    col = mix(col, cloud, c * 0.96);
  }

  col = mix(col, vec3(0.78, 0.90, 0.98), pow(1.0 - clamp(abs(y) * 3.2, 0.0, 1.0), 3.0) * 0.18);
  if (y < 0.0) col = mix(col, vec3(0.02, 0.16, 0.34), clamp(-y * 5.0, 0.0, 1.0));
  return col;
}`;

export function createSky({ segments = 48 } = {}) {
  const geo = new THREE.SphereGeometry(4200, segments, segments / 2);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uSun: { value: SUN_DIR },
      uSkyTime: { value: 0 },
    },
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
        float d = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
        gl_FragColor = vec4(col + d / 255.0, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -100;
  return {
    mesh,
    update(time) { mat.uniforms.uSkyTime.value = time; },
  };
}

export function createLights(scene, { shadows = true, shadowMap = 2048, shadowSpan = 180 } = {}) {
  const sun = new THREE.DirectionalLight(0xfff2d8, 2.8);
  sun.position.copy(SUN_DIR).multiplyScalar(320);
  scene.add(sun);
  scene.add(sun.target);

  if (shadows) {
    sun.castShadow = true;
    sun.shadow.mapSize.set(shadowMap, shadowMap);
    const c = sun.shadow.camera;
    c.left = -shadowSpan; c.right = shadowSpan;
    c.top = shadowSpan; c.bottom = -shadowSpan;
    c.near = 1; c.far = 900;
    c.updateProjectionMatrix();
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.85;
  }

  const hemi = new THREE.HemisphereLight(0xa8d4f0, 0x1a4050, 0.85);
  scene.add(hemi);
  const fill = new THREE.DirectionalLight(0x7fb8d8, 0.35);
  fill.position.set(-SUN_DIR.x, 0.45, -SUN_DIR.z).multiplyScalar(200);
  scene.add(fill);

  return {
    sun, hemi, fill, shadowSpan, shadowMap,
    follow(x, z) {
      const texel = (shadowSpan * 2) / shadowMap;
      const sx = Math.round(x / texel) * texel;
      const sz = Math.round(z / texel) * texel;
      sun.target.position.set(sx, 0, sz);
      sun.position.set(sx + SUN_DIR.x * 340, SUN_DIR.y * 340, sz + SUN_DIR.z * 340);
      sun.target.updateMatrixWorld();
      sun.updateMatrixWorld();
    },
  };
}
