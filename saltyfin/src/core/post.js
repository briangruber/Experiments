// Post: threshold, a small mip pyramid of blurs, then a composite that does the
// tonemap, the grade and the vignette in one pass.
//
// The bloom is the Unreal-style downsample/upsample chain rather than a single
// wide gaussian, because the thing it has to sell is a lantern and a row of
// village windows at night — small, very bright, and they need a long soft
// falloff without an obvious kernel edge.

import * as THREE from 'three';
import { GLSL } from './glsl.js';

const QUAD_VERT = /* glsl */`
out vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const THRESHOLD_FRAG = /* glsl */`
precision highp float;
in vec2 vUv;
uniform sampler2D tSrc;
uniform float threshold;
uniform float softKnee;
uniform float exposure;
out vec4 fragColor;
${GLSL.color}
void main(){
  vec3 c = texture(tSrc, vUv).rgb * exposure;
  float l = max(max(c.r, c.g), c.b);
  float knee = threshold * softKnee + 1e-5;
  float soft = clamp(l - threshold + knee, 0.0, 2.0*knee);
  soft = soft*soft/(4.0*knee);
  float w = max(soft, l - threshold) / max(l, 1e-5);
  fragColor = vec4(c * w, 1.0);
}
`;

const DOWN_FRAG = /* glsl */`
precision highp float;
in vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 texel;
out vec4 fragColor;
void main(){
  // 13-tap Karis-weighted downsample: no fireflies, no aliasing crawl.
  vec3 a = texture(tSrc, vUv + texel*vec2(-2,  2)).rgb;
  vec3 b = texture(tSrc, vUv + texel*vec2( 0,  2)).rgb;
  vec3 c = texture(tSrc, vUv + texel*vec2( 2,  2)).rgb;
  vec3 d = texture(tSrc, vUv + texel*vec2(-2,  0)).rgb;
  vec3 e = texture(tSrc, vUv).rgb;
  vec3 f = texture(tSrc, vUv + texel*vec2( 2,  0)).rgb;
  vec3 g = texture(tSrc, vUv + texel*vec2(-2, -2)).rgb;
  vec3 h = texture(tSrc, vUv + texel*vec2( 0, -2)).rgb;
  vec3 i = texture(tSrc, vUv + texel*vec2( 2, -2)).rgb;
  vec3 j = texture(tSrc, vUv + texel*vec2(-1,  1)).rgb;
  vec3 k = texture(tSrc, vUv + texel*vec2( 1,  1)).rgb;
  vec3 l = texture(tSrc, vUv + texel*vec2(-1, -1)).rgb;
  vec3 m = texture(tSrc, vUv + texel*vec2( 1, -1)).rgb;
  vec3 o = e*0.125 + (a+c+g+i)*0.03125 + (b+d+f+h)*0.0625 + (j+k+l+m)*0.125;
  fragColor = vec4(o, 1.0);
}
`;

const UP_FRAG = /* glsl */`
precision highp float;
in vec2 vUv;
uniform sampler2D tSrc;
uniform sampler2D tPrev;
uniform vec2 texel;
uniform float radius;
out vec4 fragColor;
void main(){
  vec2 r = texel * radius;
  vec3 s = texture(tSrc, vUv + vec2(-r.x,  r.y)).rgb * 1.0
         + texture(tSrc, vUv + vec2( 0.0,  r.y)).rgb * 2.0
         + texture(tSrc, vUv + vec2( r.x,  r.y)).rgb * 1.0
         + texture(tSrc, vUv + vec2(-r.x,  0.0)).rgb * 2.0
         + texture(tSrc, vUv).rgb * 4.0
         + texture(tSrc, vUv + vec2( r.x,  0.0)).rgb * 2.0
         + texture(tSrc, vUv + vec2(-r.x, -r.y)).rgb * 1.0
         + texture(tSrc, vUv + vec2( 0.0, -r.y)).rgb * 2.0
         + texture(tSrc, vUv + vec2( r.x, -r.y)).rgb * 1.0;
  fragColor = vec4(s / 16.0 + texture(tPrev, vUv).rgb, 1.0);
}
`;

const COMPOSITE_FRAG = /* glsl */`
precision highp float;
in vec2 vUv;
uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform vec2 resolution;
uniform float exposure;
uniform float bloomStrength;
uniform float saturation;
uniform float contrast;
uniform float vignette;
uniform float grain;
uniform float time;
uniform vec3 lift;
uniform vec3 gain;
uniform float underwater;
uniform vec3 underwaterTint;
uniform float chroma;
out vec4 fragColor;
${GLSL.color}
${GLSL.util}

vec3 sampleScene(vec2 uv){ return texture(tScene, uv).rgb; }

void main(){
  vec2 uv = vUv;
  vec2 c2 = uv - 0.5;
  float r2 = dot(c2, c2);

  // A hair of lateral chromatic aberration at the frame edge. The uniform is in
  // pixels at the very corner, not in UV: c2*r2 peaks around 0.25, so a UV
  // offset that looks tiny is in fact twenty pixels wide.
  vec3 col;
  if (chroma > 0.0001) {
    vec2 off = c2 * r2 * (chroma * 4.0 / resolution);
    col = vec3(sampleScene(uv - off).r, sampleScene(uv).g, sampleScene(uv + off).b);
  } else {
    col = sampleScene(uv);
  }

  col *= exposure;
  col += texture(tBloom, uv).rgb * bloomStrength;

  if (underwater > 0.001) {
    float d = underwater;
    col = mix(col, col * underwaterTint, d * 0.85);
    col += underwaterTint * d * 0.05;
  }

  col = tonemapFilmic(col);

  // Grade in display-referred space: lift/gain then contrast around 0.5.
  col = col * gain + lift * (1.0 - col);
  col = (col - 0.5) * contrast + 0.5;
  col = saturateColor(col, saturation);
  col = max(col, vec3(0.0));

  float v = 1.0 - vignette * smoothstep(0.15, 0.85, r2 * 2.0);
  col *= v;

  col = linearToSrgb(col);
  col += (ign(gl_FragCoord.xy + fract(time)*137.0) - 0.5) * (grain + 1.0/255.0);

  fragColor = vec4(col, 1.0);
}
`;

export function createPost({ renderer, targets, makeTarget }) {
  const quadGeo = new THREE.BufferGeometry();
  quadGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  quadGeo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));

  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quadScene = new THREE.Scene();
  const quadMesh = new THREE.Mesh(quadGeo, null);
  quadMesh.frustumCulled = false;
  quadScene.add(quadMesh);

  // RawShaderMaterial + GLSL3: three prepends `#version 300 es` itself, but
  // declares nothing else, so the attributes are spelled out here.
  const mat = (frag, uniforms) => new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: 'precision highp float;\nin vec3 position;\nin vec2 uv;\n' + QUAD_VERT,
    fragmentShader: frag,
    uniforms,
    depthTest: false, depthWrite: false,
  });

  const thresholdMat = mat(THRESHOLD_FRAG, {
    tSrc: { value: null }, threshold: { value: 1.0 }, softKnee: { value: 0.6 }, exposure: { value: 1 },
  });
  const downMat = mat(DOWN_FRAG, { tSrc: { value: null }, texel: { value: new THREE.Vector2() } });
  const upMat = mat(UP_FRAG, {
    tSrc: { value: null }, tPrev: { value: null },
    texel: { value: new THREE.Vector2() }, radius: { value: 1 },
  });
  const compositeMat = mat(COMPOSITE_FRAG, {
    tScene: { value: null }, tBloom: { value: null },
    resolution: { value: new THREE.Vector2() },
    exposure: { value: 1 }, bloomStrength: { value: 0.4 },
    saturation: { value: 1.1 }, contrast: { value: 1.05 },
    vignette: { value: 0.25 }, grain: { value: 0.012 }, time: { value: 0 },
    lift: { value: new THREE.Vector3() }, gain: { value: new THREE.Vector3(1, 1, 1) },
    underwater: { value: 0 }, underwaterTint: { value: new THREE.Vector3(0.2, 0.6, 0.8) },
    // Pixels of R/B separation at the frame corner. Barely there on purpose.
    chroma: { value: 1.6 },
  });

  const LEVELS = 6;
  let chain = [];      // { down, up } per level

  function resize(w, h) {
    for (const l of chain) { l.down.dispose(); l.up.dispose(); }
    chain = [];
    let lw = w, lh = h;
    for (let i = 0; i < LEVELS; i++) {
      lw = Math.max(2, lw >> 1); lh = Math.max(2, lh >> 1);
      chain.push({
        down: makeTarget(lw, lh, { depth: false }),
        up: makeTarget(lw, lh, { depth: false }),
        w: lw, h: lh,
      });
      if (lw <= 4 || lh <= 4) break;
    }
    compositeMat.uniforms.resolution.value.set(w, h);
  }

  function draw(material, target) {
    quadMesh.material = material;
    renderer.setRenderTarget(target ?? null);
    renderer.clear(true, true, false);
    renderer.render(quadScene, quadCam);
  }

  const tmpLift = new THREE.Vector3();
  const tmpGain = new THREE.Vector3();

  function render(env, { time = 0, underwater = 0, underwaterTint = null } = {}) {
    const src = targets.scene.texture;

    thresholdMat.uniforms.tSrc.value = src;
    thresholdMat.uniforms.threshold.value = env.bloomThreshold;
    thresholdMat.uniforms.exposure.value = env.exposure;
    draw(thresholdMat, chain[0].down);

    for (let i = 1; i < chain.length; i++) {
      downMat.uniforms.tSrc.value = chain[i - 1].down.texture;
      downMat.uniforms.texel.value.set(1 / chain[i - 1].w, 1 / chain[i - 1].h);
      draw(downMat, chain[i].down);
    }

    const last = chain.length - 1;
    upMat.uniforms.radius.value = env.bloomRadius * 2.0 + 0.5;
    // Seed the top of the pyramid with itself, then walk down accumulating.
    upMat.uniforms.tSrc.value = chain[last].down.texture;
    upMat.uniforms.tPrev.value = chain[last].down.texture;
    upMat.uniforms.texel.value.set(1 / chain[last].w, 1 / chain[last].h);
    draw(upMat, chain[last].up);

    for (let i = last - 1; i >= 0; i--) {
      upMat.uniforms.tSrc.value = chain[i + 1].up.texture;
      upMat.uniforms.tPrev.value = chain[i].down.texture;
      upMat.uniforms.texel.value.set(1 / chain[i + 1].w, 1 / chain[i + 1].h);
      draw(upMat, chain[i].up);
    }

    const u = compositeMat.uniforms;
    u.tScene.value = src;
    u.tBloom.value = chain[0].up.texture;
    u.exposure.value = env.exposure;
    u.bloomStrength.value = env.bloomStrength;
    u.saturation.value = env.saturation;
    u.contrast.value = env.contrast;
    u.vignette.value = env.vignette;
    u.grain.value = env.grainStrength;
    u.time.value = time;
    u.underwater.value = underwater;
    if (underwaterTint) u.underwaterTint.value.set(underwaterTint.r, underwaterTint.g, underwaterTint.b);
    tmpLift.set(env.lift.r, env.lift.g, env.lift.b);
    tmpGain.set(env.gain.r, env.gain.g, env.gain.b);
    u.lift.value.copy(tmpLift);
    u.gain.value.copy(tmpGain);

    draw(compositeMat, null);
  }

  function dispose() {
    for (const l of chain) { l.down.dispose(); l.up.dispose(); }
    quadGeo.dispose();
    thresholdMat.dispose(); downMat.dispose(); upMat.dispose(); compositeMat.dispose();
  }

  return { resize, render, dispose, materials: { compositeMat } };
}
