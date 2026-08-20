import * as THREE from '../vendor/three/three.module.js';
import { assemble, uniformName } from './slots/index.js';
import { RING_GLSL } from './grid.js';

// Shared host uniforms - everything that is not a knob.
export function hostUniforms() {
  return {
    uTime: { value: 0 },
    uSunDir: { value: new THREE.Vector3(0, 0.2, 1) },
    uCamPos: { value: new THREE.Vector3() },
    uPixelAngle: { value: 0.001 },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uGridOrigin: { value: new THREE.Vector2() },
    uGridCounts: { value: new THREE.Vector2(420, 448) },
    uGridRange: { value: new THREE.Vector2(0.35, 20000) },
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
uniform vec2  uGridOrigin;
`;

// Two footprints, deliberately.
//
// Geometry cannot show a wave shorter than the gap between two vertices, so the
// vertex stage filters at the tessellation spacing. Shading has no such limit —
// it runs per pixel — so it filters at the pixel footprint instead, and picks up
// every train the mesh was too coarse to carry.
//
// That split is the difference between an ocean and a set of smooth bands: the
// long waves are geometry, the short ones are normals. Making both stages agree
// on one conservative footprint, which is the obvious thing to do, throws away
// all the detail between pixel size and vertex size — and at 100 m out that is
// everything below about 18 m.
const FOOTPRINT = /* glsl */`
float sw_pixelFootprint(vec2 pFlat){
  float d = distance(vec3(pFlat.x, 0.0, pFlat.y), uCamPos);
  return max(d * uPixelAngle, 0.02);
}
float sw_vertexFootprint(vec2 pFlat, float spacing){
  return max(spacing, sw_pixelFootprint(pFlat));
}
`;

export function oceanMaterial(selection, knobs) {
  const chain = HOST_DECLS + assemble(selection, knobs);
  const uniforms = Object.assign(hostUniforms(), knobUniforms(knobs));

  const vertexShader = /* glsl */`
    in float aRing;
    out vec3 vWorld;
    out vec2 vFlat;
    out float vSpacing;
    ${chain}
    ${RING_GLSL}
    ${FOOTPRINT}
    void main(){
      float spacing;
      vFlat = sw_ringPoint(position, aRing, uGridOrigin, uCamPos.y, spacing);
      vSpacing = spacing;
      float depth = sw_waterDepth(vFlat);
      float fp = sw_vertexFootprint(vFlat, spacing);
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
    out vec4 fragColor;
    ${chain}
    ${FOOTPRINT}
    void main(){
      vec3 V = normalize(uCamPos - vWorld);
      float dist = distance(uCamPos, vWorld);
      float fp = sw_pixelFootprint(vFlat);

      // Depth is evaluated here rather than interpolated from the triangle's
      // corners. Interpolating it makes every depth-driven term - the breaker
      // index, the absorption path, the waterline - vary linearly across a
      // triangle, so they all step at triangle edges. That is most of the
      // stairstepping in the surf zone, and no amount of extra tessellation
      // removes it.
      float bedDepth = sw_waterDepth(vFlat);
      float depth = max(bedDepth, 0.02);

      // Recomputed per pixel at the *pixel* footprint. The position stays as the
      // mesh delivered it; only the normal gains the short trains. This is the
      // classic geometry-plus-normal-detail split, done analytically.
      Wave w = sw_waves(vFlat, uTime, depth, fp);

      // Waves run up the sand and drain back, so the waterline is not where
      // the still-water depth says it is.
      if (uShoreEnabled > 0.5 && bedDepth + w.disp.y * 0.85 < 0.0) discard;

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
    // DoubleSide, like the ocean. The polar grid's winding puts the visible face
    // away from the camera, so a front-facing sand mesh is silently culled and
    // the beach renders as the sky's ground lobe — which looks enough like wet
    // sand from a distance to hide the bug for a long time.
    side: THREE.DoubleSide,
    uniforms: sharedUniforms,
    vertexShader: /* glsl */`
      in float aRing;
      out vec3 vWorld;
      out vec2 vFlat;
      ${chain}
      ${RING_GLSL}
      void main(){
        float spacing;
        vFlat = sw_ringPoint(position, aRing, uGridOrigin, uCamPos.y, spacing);
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
        // skyRad is a radiance; the hemisphere it stands for delivers about pi
        // times as much irradiance. Same slip as the foam had, and it is what
        // makes dry sand read as wet asphalt.
        vec3 col = albedo * (sunRad * sat(dot(N, uSunDir)) + skyRad * SW_PI * 0.55) * (1.0 / SW_PI);

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

// A measurement pass, not a picture: each texel is one sample of the wave field
// at a known world position, written out as raw floats for readback.
//
// This exists so the physical checks in tools/harness/metrics measure the shader
// that actually ships. A metric that re-implemented the spectrum in JavaScript
// would be testing the re-implementation, and could be satisfied by a variant
// that renders nothing at all.
export function probeMaterial(selection, knobs, sharedUniforms) {
  const chain = HOST_DECLS + assemble(selection, knobs);
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: Object.assign({
      uProbeOrigin: { value: new THREE.Vector2() },
      uProbeExtent: { value: 512 },
      uProbeRes: { value: 256 },
    }, sharedUniforms),
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
    fragmentShader: /* glsl */`
      precision highp float;
      uniform vec2 uProbeOrigin;
      uniform float uProbeExtent;
      uniform float uProbeRes;
      in vec2 vUv;
      out vec4 fragColor;
      ${chain}
      void main(){
        vec2 p = uProbeOrigin + (vUv - 0.5) * uProbeExtent;
        float depth = max(sw_waterDepth(p), 0.05);
        float fp = uProbeExtent / max(uProbeRes, 1.0);
        Wave w = sw_waves(p, uTime, depth, fp);
        vec2 fb = sw_breaking(w, p, uTime, depth, fp);
        fragColor = vec4(w.disp.y, fb.x, w.fold, w.subRough);
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
