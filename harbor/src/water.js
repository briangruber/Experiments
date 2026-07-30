import * as THREE from 'three';
import { waveGLSL } from './waves.js';
import { seabedGLSL, LAGOON, seabedHeight } from './seabed.js';
import { SKY_GLSL, SUN_DIR, FOG_DENSITY } from './sky.js';

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

export function createOcean({ segments = 200, half = 2200, detail = 6 } = {}) {
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
        float d = length(p - uCamera.xz);
        float detail = uDetail - smoothstep(50.0, 800.0, d) * 3.0;
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

        float rip = noise(vWorld.xz * 0.85 + uTime * 0.32) - 0.5
                  + (noise(vWorld.xz * 2.5 - uTime * 0.55) - 0.5) * 0.5;
        n = normalize(n + vec3(rip, 0.0, rip * 0.8) * 0.14 * smoothstep(600.0, 35.0, dist));

        float bed = seabedHeight(vWorld.xz);
        float depth = max(0.0, vWorld.y - bed);
        float r = length(vWorld.xz - vec2(0.0, 20.0));

        // Gin-clear over sand; ink past the drop-off.
        float murk = mix(0.018, 0.28, smoothstep(LAGOON_REEF, LAGOON_DEEP, r));
        float absorb = 1.0 - exp(-depth * murk);

        // Crystal turquoise near the boat → sapphire at the horizon.
        float far = smoothstep(500.0, 2000.0, r);
        vec3 deep = mix(vec3(0.02, 0.16, 0.42), vec3(0.01, 0.07, 0.24), far);
        vec3 lagoon = vec3(0.12, 0.82, 0.76);
        vec3 open = mix(vec3(0.05, 0.52, 0.66), vec3(0.03, 0.30, 0.52), far);
        vec3 tint = mix(lagoon, open, smoothstep(LAGOON_FLAT, LAGOON_BRINK, r));

        float fres = pow(1.0 - max(dot(n, view), 0.0), 5.0);
        fres = mix(0.018, 1.0, fres);

        vec3 refl = skyColor(reflect(-view, n), uSun);
        float sss = pow(clamp(vCrest, 0.0, 1.0), 1.6) * pow(max(dot(view, -uSun), 0.0) * 0.5 + 0.5, 2.0);
        vec3 body = mix(tint, deep, absorb);
        body += vec3(0.14, 0.55, 0.42) * sss * 0.85;

        vec3 col = mix(body, refl, fres);
        vec3 h = normalize(uSun + view);
        col += vec3(1.0, 0.95, 0.84) * pow(max(dot(n, h), 0.0), 480.0) * 2.0;

        float foam = smoothstep(0.60, 0.95, vCrest);
        foam *= 0.6 + 0.4 * noise(vWorld.xz * 1.0 + uTime * 0.22);
        foam *= smoothstep(800.0, 120.0, dist);
        col = mix(col, vec3(0.88, 0.94, 0.96), clamp(foam, 0.0, 0.78));

        float fog = 1.0 - exp(-pow(dist * uFog, 2.0));
        vec3 fogDir = normalize(vec3(-view.x, 0.02, -view.z));
        col = mix(col, skyColor(fogDir, uSun), clamp(fog, 0.0, 1.0));

        // Keep the shallows glassy so the reef and sand stay readable.
        float alpha = clamp(fres + (1.0 - fres) * absorb * 0.92, 0.0, 1.0);
        alpha = max(alpha, fog * 0.85);
        alpha = min(alpha, mix(0.55, 1.0, smoothstep(2.0, 14.0, depth)));
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
      uniforms.uSkyTime.value = time;
      uniforms.uCenter.value.set(
        Math.round(camera.position.x / 8) * 8,
        Math.round(camera.position.z / 8) * 8
      );
      mesh.position.set(uniforms.uCenter.value.x, 0, uniforms.uCenter.value.y);
      uniforms.uCamera.value.copy(camera.position);
    },
  };
}

export function createSeabed({ segments = 100, spokes = 110 } = {}) {
  const SAND = new THREE.Color(0xf4e6bc);
  const SAND_DEEP = new THREE.Color(0xcbbc8c);
  const CORAL = new THREE.Color(0xe07a55);
  const WEED = new THREE.Color(0x3f8a4a);
  const ROCK = new THREE.Color(0x555b62);
  const ABYSS = new THREE.Color(0x080d14);

  const positions = [];
  const colors = [];
  const indices = [];
  const outer = LAGOON.deep + 220;

  const hash = (x, y) => {
    const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return s - Math.floor(s);
  };

  for (let ring = 0; ring <= segments; ring++) {
    const t = ring / segments;
    // Start at the origin so there is never a dark hole under the lagoon.
    const r = Math.pow(t, 1.55) * outer;
    for (let s = 0; s < spokes; s++) {
      const a = (s / spokes) * Math.PI * 2;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r + 20;
      const y = r < 8 ? -0.4 : seabedHeight(x, z);
      positions.push(x, y, z);
      const c = new THREE.Color();
      const depth = -y;
      if (depth < 5.5) c.copy(SAND).lerp(SAND_DEEP, depth / 5.5);
      else if (depth < 11) c.copy(SAND_DEEP).lerp(ROCK, (depth - 5.5) / 5.5);
      else c.copy(ROCK).lerp(ABYSS, Math.min(1, (depth - 11) / 36));
      const patch = hash(Math.floor(x * 0.12), Math.floor(z * 0.12));
      if (r > LAGOON.flat - 45 && r < LAGOON.brink && patch > 0.70) {
        c.lerp(patch > 0.86 ? CORAL : WEED, 0.58);
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

  const uniforms = { uTime: { value: 0 }, uCamera: { value: new THREE.Vector3() } };
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.94, metalness: 0 });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.uniforms.uCamera = uniforms.uCamera;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
      .replace('#include <begin_vertex>',
        '#include <begin_vertex>\n  vWPos = (modelMatrix * vec4(position, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vWPos;
        uniform float uTime;
        uniform vec3 uCamera;
        float caustic(vec2 p, float t) {
          float v = 0.0;
          for (int i = 0; i < 2; i++) {
            float fi = float(i);
            vec2 q = p * (0.9 + fi * 0.55) + vec2(t * (0.35 + fi * 0.2), -t * (0.28 - fi * 0.12));
            float a = sin(q.x + sin(q.y * 1.3)) * cos(q.y - cos(q.x * 1.1));
            v += a * a;
          }
          return pow(clamp(v * 0.5, 0.0, 1.0), 2.2);
        }`)
      .replace('#include <opaque_fragment>', `#include <opaque_fragment>
        {
          float depth = max(0.0, -vWPos.y);
          float light = exp(-depth * 0.05);
          vec3 col = gl_FragColor.rgb * mix(0.42, 1.28, light);
          col += vec3(0.62, 0.94, 0.86) * caustic(vWPos.xz * 0.48, uTime) * light * 1.15;
          float dist = length(uCamera - vWPos);
          float haze = 1.0 - exp(-dist * mix(0.045, 0.007, light));
          vec3 water = mix(vec3(0.10, 0.62, 0.58), vec3(0.02, 0.12, 0.28), 1.0 - light);
          gl_FragColor.rgb = mix(col, water, clamp(haze, 0.0, 0.92));
        }`);
  };

  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = -20;
  mesh.frustumCulled = false;
  mesh.receiveShadow = true;
  return {
    mesh,
    update(time, camera) {
      uniforms.uTime.value = time;
      uniforms.uCamera.value.copy(camera.position);
    },
  };
}

export function createReefProps({ count = 180 } = {}) {
  const group = new THREE.Group();
  const shapes = [
    { geo: new THREE.ConeGeometry(1, 2.2, 6), h: 2.2, color: 0xe07a55 },
    { geo: new THREE.DodecahedronGeometry(1.1, 0), h: 2.0, color: 0xd4684a },
    { geo: new THREE.CylinderGeometry(0.35, 0.55, 2.4, 6), h: 2.4, color: 0x3f8a4a },
    { geo: new THREE.IcosahedronGeometry(0.9, 0), h: 1.6, color: 0xc96b58 },
  ];
  const hash = (x, y) => {
    const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return s - Math.floor(s);
  };

  for (let i = 0; i < count; i++) {
    const a = hash(i, 1) * Math.PI * 2;
    const r = LAGOON.flat - 10 + hash(i, 2) * (LAGOON.brink - LAGOON.flat + 30);
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r + 20;
    const y = seabedHeight(x, z);
    // Stay fully submerged — props that breach the surface read as buoys.
    if (y > -2.4 || y < -12) continue;
    const shape = shapes[i % shapes.length];
    const s = 0.55 + hash(i, 3) * 1.1;
    const top = y + shape.h * s * 0.55;
    if (top > -0.6) continue;
    const mesh = new THREE.Mesh(
      shape.geo,
      new THREE.MeshStandardMaterial({
        color: shape.color,
        roughness: 0.9,
        flatShading: true,
      })
    );
    mesh.scale.set(s, s * (0.8 + hash(i, 4) * 0.6), s);
    mesh.position.set(x, y + shape.h * s * 0.35, z);
    mesh.rotation.y = hash(i, 5) * 6.28;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);

    if (hash(i, 6) > 0.55) {
      for (let g = 0; g < 3; g++) {
        const bladeH = 0.9 + hash(i + g, 7) * 0.7;
        const blade = new THREE.Mesh(
          new THREE.ConeGeometry(0.07, bladeH, 4),
          new THREE.MeshStandardMaterial({ color: 0x3a7a42, flatShading: true })
        );
        const bx = x + (hash(i, 8 + g) - 0.5) * 1.6;
        const bz = z + (hash(i, 11 + g) - 0.5) * 1.6;
        blade.position.set(bx, y + bladeH * 0.4, bz);
        blade.rotation.z = (hash(i, 14 + g) - 0.5) * 0.35;
        if (blade.position.y + bladeH * 0.4 < -0.4) group.add(blade);
      }
    }
  }
  return group;
}
