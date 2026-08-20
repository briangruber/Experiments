import * as THREE from '../vendor/three/three.module.js';
import { assemble, uniformName } from './slots/index.js';

// Shared host uniforms - everything that is not a knob.
export function hostUniforms() {
  return {
    uTime: { value: 0 },
    uSunDir: { value: new THREE.Vector3(0, 0.2, 1) },
    uCamPos: { value: new THREE.Vector3() },
    uPixelAngle: { value: 0.001 },
    uResolution: { value: new THREE.Vector2(1, 1) },
  };
}

export function knobUniforms(knobs) {
  const u = {};
  for (const [k, v] of Object.entries(knobs)) {
    u[uniformName(k)] = { value: Array.isArray(v) ? new THREE.Vector3(...v) : v };
  }
  return u;
}

export function syncKnobUniforms(uniforms, knobs) {
  for (const [k, v] of Object.entries(knobs)) {
    const u = uniforms[uniformName(k)];
    if (!u) continue;
    if (Array.isArray(v)) u.value.set(v[0], v[1], v[2]);
    else u.value = v;
  }
}

// Uniforms the host owns rather than the knob set. Declared here so every
// assembled shader — ocean, sand, sky — sees the same names.
const HOST_DECLS = /* glsl */`
uniform float uTime;
uniform vec3  uSunDir;
uniform vec3  uCamPos;
uniform float uPixelAngle;
uniform vec2  uResolution;
`;

// Footprint is computed identically in both stages so the displaced position
// and the shading normal always agree about which wave trains exist.
const FOOTPRINT = /* glsl */`
float sw_footprint(vec3 world, float spacing){
  float d = distance(world, uCamPos);
  return max(spacing, d * uPixelAngle);
}
`;

export function oceanMaterial(selection, knobs) {
  const chain = HOST_DECLS + assemble(selection, knobs);
  const uniforms = Object.assign(hostUniforms(), knobUniforms(knobs));

  const vertexShader = /* glsl */`
    in float aSpacing;
    out vec3 vWorld;
    out vec2 vFlat;
    out float vSpacing;
    out float vDepth;
    ${chain}
    ${FOOTPRINT}
    void main(){
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vFlat = wp.xz;
      vSpacing = aSpacing;
      float depth = sw_waterDepth(vFlat);
      vDepth = depth;
      float fp = sw_footprint(vec3(vFlat.x, 0.0, vFlat.y), aSpacing);
      Wave w = sw_waves(vFlat, uTime, max(depth, 0.05), fp);
      vec3 P = vec3(vFlat.x, 0.0, vFlat.y) + w.disp;
      // Fall away with the curve of the earth so the far sea sinks under the
      // horizon instead of standing up as a wall.
      float d = distance(P.xz, uCamPos.xz);
      P.y -= (d * d) / 12742000.0 * uEarthCurve;
      vWorld = P;
      gl_Position = projectionMatrix * viewMatrix * vec4(P, 1.0);
    }
  `;

  const fragmentShader = /* glsl */`
    precision highp float;
    in vec3 vWorld;
    in vec2 vFlat;
    in float vSpacing;
    in float vDepth;
    out vec4 fragColor;
    ${chain}
    ${FOOTPRINT}
    void main(){
      vec3 V = normalize(uCamPos - vWorld);
      float dist = distance(uCamPos, vWorld);
      float fp = sw_footprint(vec3(vFlat.x, 0.0, vFlat.y), vSpacing);
      float depth = max(vDepth, 0.02);

      // Recomputed per pixel: the vertex normal would be a facet normal, and a
      // faceted ocean is the single most common tell of a first-pass sea.
      Wave w = sw_waves(vFlat, uTime, depth, fp);

      // Waves run up the sand and drain back, so the waterline is not where
      // the still-water depth says it is.
      if (uShoreEnabled > 0.5 && vDepth + w.disp.y * 0.85 < 0.0) discard;

      Surf s;
      s.P = vWorld;
      s.N = w.normal;
      s.V = V;
      s.L = uSunDir;
      s.sunRad = sw_sunRadiance(uSunDir);
      s.skyRad = sw_skyAmbient(uSunDir);
      s.depth = depth;
      s.dist = dist;
      s.w = w;

      vec3 col = sw_waterShade(s);

      vec2 fb = sw_breaking(w, vFlat, uTime, depth, fp);
      if (fb.x > 0.002){
        vec3 foam = sw_foamShade(s, fb.x, fb.y);
        col = mix(col, foam, fb.x);
      }

      // Aerial perspective. Done here rather than inside a slot so foam, water
      // and sand all sit in the same air.
      float fog = 1.0 - exp(-dist * 0.000042 * uFogDensity);
      col = mix(col, sw_sky(-V, uSunDir), fog);

      fragColor = vec4(col, 1.0);
    }
  `;

  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms,
    vertexShader,
    fragmentShader,
    side: THREE.DoubleSide,
  });
}

export function sandMaterial(selection, knobs, sharedUniforms) {
  const chain = HOST_DECLS + assemble(selection, knobs);
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: sharedUniforms,
    vertexShader: /* glsl */`
      in float aSpacing;
      out vec3 vWorld;
      out vec2 vFlat;
      ${chain}
      void main(){
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vFlat = wp.xz;
        vec3 P = vec3(vFlat.x, sw_seabedHeight(vFlat), vFlat.y);
        float d = distance(P.xz, uCamPos.xz);
        P.y -= (d * d) / 12742000.0 * uEarthCurve;
        vWorld = P;
        gl_Position = projectionMatrix * viewMatrix * vec4(P, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      precision highp float;
      in vec3 vWorld;
      in vec2 vFlat;
      out vec4 fragColor;
      ${chain}
      void main(){
        vec3 V = normalize(uCamPos - vWorld);
        float dist = distance(uCamPos, vWorld);

        // Normal from the bed itself, plus ripple detail that fades with range.
        float e = max(0.35, dist * 0.004);
        float h0 = sw_seabedHeight(vFlat);
        float hx = sw_seabedHeight(vFlat + vec2(e, 0.0));
        float hz = sw_seabedHeight(vFlat + vec2(0.0, e));
        vec3 N = normalize(vec3(-(hx - h0) / e, 1.0, -(hz - h0) / e));

        float depth = -h0;
        // Sand darkens and goes glossy where the swash has just been over it.
        float wet = smoothstep(-1.6, 0.35, depth);
        vec3 albedo = sw_seabedAlbedo(vFlat) * mix(1.0, 0.52, wet);

        vec3 sunRad = sw_sunRadiance(uSunDir);
        vec3 skyRad = sw_skyAmbient(uSunDir);
        vec3 col = albedo * (sunRad * sat(dot(N, uSunDir)) + skyRad * 0.55) * (1.0 / SW_PI);

        // Wet sand holds a broad specular sheen; dry sand holds none.
        vec3 H = normalize(uSunDir + V);
        float spec = pow(sat(dot(N, H)), 48.0) * wet * 0.35;
        col += sunRad * spec * (1.0 / SW_PI);

        float fog = 1.0 - exp(-dist * 0.000042 * uFogDensity);
        col = mix(col, sw_sky(-V, uSunDir), fog);
        fragColor = vec4(col, 1.0);
      }
    `,
  });
}

export function skyMaterial(selection, knobs, sharedUniforms) {
  const chain = HOST_DECLS + assemble(selection, knobs);
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: Object.assign({ uInvViewProj: { value: new THREE.Matrix4() } }, sharedUniforms),
    depthTest: false,
    depthWrite: false,
    vertexShader: /* glsl */`
      in vec3 position;
      out vec2 vNdc;
      void main(){
        vNdc = position.xy;
        gl_Position = vec4(position.xy, 1.0, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      precision highp float;
      uniform mat4 uInvViewProj;
      in vec2 vNdc;
      out vec4 fragColor;
      ${chain}
      void main(){
        vec4 far = uInvViewProj * vec4(vNdc, 1.0, 1.0);
        vec4 near = uInvViewProj * vec4(vNdc, -1.0, 1.0);
        vec3 dir = normalize(far.xyz / far.w - near.xyz / near.w);
        fragColor = vec4(sw_sky(dir, uSunDir), 1.0);
      }
    `,
  });
}

// ACES fitted tonemap. The scene renders to a half-float target in linear
// radiance; this is the only place a colour becomes a pixel.
export function postMaterial(sharedUniforms) {
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: Object.assign({ uHdr: { value: null } }, sharedUniforms),
    depthTest: false,
    depthWrite: false,
    vertexShader: `
      in vec3 position;
      out vec2 vUv;
      void main(){
        vUv = position.xy * 0.5 + 0.5;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: `
      precision highp float;
      uniform sampler2D uHdr;
      uniform float uExposure;
      uniform float uVignette;
      uniform vec2 uResolution;
      in vec2 vUv;
      out vec4 fragColor;

      vec3 aces(vec3 x){
        const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
        return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
      }

      void main(){
        vec3 hdr = texture(uHdr, vUv).rgb * uExposure;
        vec3 col = aces(hdr);
        vec2 q = vUv - 0.5;
        col *= 1.0 - uVignette * dot(q, q) * 1.35;
        col = pow(max(col, 0.0), vec3(1.0 / 2.2));
        // Ordered dither, so smooth sky gradients do not band in 8 bits.
        float dither = fract(dot(gl_FragCoord.xy, vec2(0.7548776662, 0.5698402909)));
        col += (dither - 0.5) / 255.0;
        fragColor = vec4(col, 1.0);
      }
    `,
  });
}
