// The look. Scene renders into a float buffer, then gets defocused, bloomed,
// diffused, graded, grained, vignetted and letterboxed on the way to the
// screen. The soft glow is doing most of the telenovela work.

import * as THREE from '../vendor/three/three.module.min.js';
import { clamp01, lerp, approach } from './util.js';

const QUAD = new THREE.BufferGeometry();
QUAD.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
QUAD.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));

const VERT = `varying vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

// Default grade. The director animates these per scene.
export const LOOK = () => ({
  exposure: 1.55,
  contrast: 1.06,
  saturation: 0.96,
  warmth: 0.06,          // push highlights amber, shadows blue
  lift: 0.006,
  bloom: 0.55,
  bloomThreshold: 0.72,
  diffusion: 0.3,        // the soft-focus veil
  halation: 0.35,
  // Depth of field, up from 1.0. A long lens wide open is the most reliable
  // signal a picture was photographed rather than rendered: it puts the
  // subject on a plane of its own, and it turns the courtyard's big flat
  // stucco panels into soft tone instead of wallpaper.
  dof: 1.45,             // multiplier on the defocus strength
  grain: 0.028,
  vignette: 0.42,
  chroma: 0.32,
  letterbox: 0.115,      // fraction of height per bar
  flash: 0,
  fade: 0,               // 1 = black
  whip: 1,               // multiplier on the camera's own whip envelope
  whipDir: 0,
  freeze: 0,             // pushes grain and contrast for a held frame
  vhs: 0.18,             // scanline / broadcast softness
  tint: [1, 1, 1],
});

export class Post {
  constructor(renderer, width, height) {
    this.renderer = renderer;
    this.scene = new THREE.Scene();
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(QUAD, null);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
    this.look = LOOK();
    this.target = LOOK();

    const rtOpts = { type: THREE.HalfFloatType, depthBuffer: true, samples: 0 };
    this.rt = new THREE.WebGLRenderTarget(width, height, rtOpts);
    this.rt.depthTexture = new THREE.DepthTexture(width, height);
    this.rt.depthTexture.type = THREE.UnsignedIntType;
    this.rt.texture.minFilter = this.rt.texture.magFilter = THREE.LinearFilter;

    const half = (d) => new THREE.WebGLRenderTarget(
      Math.max(2, Math.floor(width / d)), Math.max(2, Math.floor(height / d)),
      { type: THREE.HalfFloatType, depthBuffer: false },
    );
    this.rtA = half(2); this.rtB = half(2);   // near-blur, used by DOF + diffusion
    this.rtC = half(6); this.rtD = half(6);   // wide blur, used by bloom + halation

    this.bright = new THREE.ShaderMaterial({
      uniforms: { tSrc: { value: null }, uThreshold: { value: 0.7 }, uTexel: { value: new THREE.Vector2() } },
      vertexShader: VERT,
      fragmentShader: `
        varying vec2 vUv; uniform sampler2D tSrc; uniform float uThreshold; uniform vec2 uTexel;
        void main(){
          vec3 c = vec3(0.0);
          c += texture2D(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
          c += texture2D(tSrc, vUv + uTexel * vec2( 1.0, -1.0)).rgb;
          c += texture2D(tSrc, vUv + uTexel * vec2(-1.0,  1.0)).rgb;
          c += texture2D(tSrc, vUv + uTexel * vec2( 1.0,  1.0)).rgb;
          c *= 0.25;
          float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
          float k = max(0.0, l - uThreshold) / max(0.0001, l);
          gl_FragColor = vec4(c * k, 1.0);
        }`,
    });

    this.blur = new THREE.ShaderMaterial({
      uniforms: { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } },
      vertexShader: VERT,
      fragmentShader: `
        varying vec2 vUv; uniform sampler2D tSrc; uniform vec2 uDir;
        void main(){
          vec3 c = texture2D(tSrc, vUv).rgb * 0.227027;
          c += (texture2D(tSrc, vUv + uDir * 1.3846).rgb + texture2D(tSrc, vUv - uDir * 1.3846).rgb) * 0.316216;
          c += (texture2D(tSrc, vUv + uDir * 3.2308).rgb + texture2D(tSrc, vUv - uDir * 3.2308).rgb) * 0.070270;
          gl_FragColor = vec4(c, 1.0);
        }`,
    });

    this.copy = new THREE.ShaderMaterial({
      uniforms: { tSrc: { value: null } },
      vertexShader: VERT,
      fragmentShader: `varying vec2 vUv; uniform sampler2D tSrc;
        void main(){ gl_FragColor = vec4(texture2D(tSrc, vUv).rgb, 1.0); }`,
    });

    this.composite = new THREE.ShaderMaterial({
      uniforms: {
        tScene: { value: null }, tNear: { value: null }, tWide: { value: null }, tDepth: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uNear: { value: 0.1 }, uFar: { value: 100 },
        uFocus: { value: 3 }, uAperture: { value: 1 }, uDof: { value: 1 },
        uExposure: { value: 1 }, uContrast: { value: 1.05 }, uSaturation: { value: 1.05 },
        uWarmth: { value: 0.06 }, uLift: { value: 0.006 }, uTint: { value: new THREE.Vector3(1, 1, 1) },
        uBloom: { value: 0.5 }, uDiffusion: { value: 0.3 }, uHalation: { value: 0.35 },
        uGrain: { value: 0.05 }, uVignette: { value: 0.4 }, uChroma: { value: 0.3 },
        uLetterbox: { value: 0.115 }, uFlash: { value: 0 }, uFade: { value: 0 },
        uWhip: { value: 0 }, uWhipDir: { value: 0 }, uFreeze: { value: 0 }, uVhs: { value: 0.18 },
        uTime: { value: 0 }, uAspect: { value: 1.78 },
      },
      vertexShader: VERT,
      fragmentShader: `
        varying vec2 vUv;
        uniform sampler2D tScene, tNear, tWide, tDepth;
        uniform vec2 uTexel;
        uniform float uNear, uFar, uFocus, uAperture, uDof;
        uniform float uExposure, uContrast, uSaturation, uWarmth, uLift;
        uniform float uBloom, uDiffusion, uHalation, uGrain, uVignette, uChroma;
        uniform float uLetterbox, uFlash, uFade, uWhip, uWhipDir, uFreeze, uVhs, uTime, uAspect;
        uniform vec3 uTint;

        float viewZ(vec2 uv){
          float d = texture2D(tDepth, uv).x;
          return (2.0 * uNear * uFar) / (uFar + uNear - (d * 2.0 - 1.0) * (uFar - uNear));
        }

        float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

        // Filmic tone curve — a cheap ACES fit.
        vec3 tonemap(vec3 x){
          const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
          return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
        }

        // One scene fetch, whip-smeared when the operator is panning hard.
        vec3 fetch(vec2 uv){
          if (uWhip > 0.002) {
            vec2 dir = vec2(cos(uWhipDir), sin(uWhipDir)) * uWhip * 0.075;
            vec3 acc = vec3(0.0);
            float w = 0.0;
            for (int i = 0; i < 9; i++) {
              float t = float(i) / 8.0 - 0.5;
              float k = 1.0 - abs(t) * 1.2;
              acc += texture2D(tScene, uv + dir * t).rgb * k;
              w += k;
            }
            return acc / w;
          }
          return texture2D(tScene, uv).rgb;
        }

        void main(){
          vec2 uv = vUv;
          vec2 cen = uv - 0.5;

          // Broadcast wobble: a whisper of horizontal instability.
          uv.x += sin(uv.y * 220.0 + uTime * 3.0) * 0.00035 * uVhs;

          // Chromatic aberration, applied at the fetch so the grade downstream
          // still sees one coherent image (splitting it later fringes green).
          float ca = uChroma * 0.004 * dot(cen, cen);
          vec3 col;
          if (ca > 0.00002) {
            col = vec3(fetch(uv + cen * ca).r, fetch(uv).g, fetch(uv - cen * ca).b);
          } else {
            col = fetch(uv);
          }

          // Depth of field: blend to the half-res blur by circle of confusion.
          float z = viewZ(uv);
          // Falloff scales with the focus distance, or a close-up focused at
          // 70cm defocuses the subject's own beak.
          float coc = clamp(abs(z - uFocus) / max(0.6, uFocus) * uAperture * uDof * 0.55, 0.0, 1.0);
          coc = pow(coc, 0.8);
          vec3 nearBlur = texture2D(tNear, uv).rgb;
          vec3 wide = texture2D(tWide, uv).rgb;
          col = mix(col, mix(nearBlur, wide, coc * 0.45), coc);

          // Diffusion: the soft veil that makes everyone look forgiven.
          col = mix(col, max(col, nearBlur * 1.15), uDiffusion * 0.55);
          col += nearBlur * uDiffusion * 0.22;

          // Bloom and halation (halation leans red, like light through film).
          col += wide * uBloom;
          col += wide * vec3(1.0, 0.42, 0.28) * uHalation * 0.5;

          // Grade.
          col *= uExposure;
          col += uLift;
          float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
          col = mix(vec3(l), col, uSaturation);
          col = (col - 0.5) * uContrast + 0.5;
          col *= uTint;
          // Split tone: amber highs, cyan lows.
          col += vec3(0.045, 0.012, -0.03) * uWarmth * smoothstep(0.35, 1.0, l);
          col += vec3(-0.02, 0.0, 0.035) * uWarmth * (1.0 - smoothstep(0.0, 0.4, l));

          col = tonemap(max(col, 0.0));

          // Vignette.
          float v = 1.0 - uVignette * dot(cen * vec2(uAspect * 0.62, 1.0), cen * vec2(uAspect * 0.62, 1.0)) * 2.1;
          col *= clamp(v, 0.0, 1.0);

          // Scanlines, very lightly.
          col *= 1.0 - uVhs * 0.06 * (0.5 + 0.5 * sin(vUv.y * 1400.0));

          // Grain, coarser on a frozen frame.
          float g = hash(vUv * vec2(1024.0, 640.0) + fract(uTime) * 91.7) - 0.5;
          col += g * (uGrain + uFreeze * 0.06) * (1.2 - l * 0.7);

          col += uFlash;
          col *= 1.0 - uFade;

          // Letterbox last, so nothing bleeds into the bars.
          float bar = step(vUv.y, uLetterbox) + step(1.0 - uLetterbox, vUv.y);
          col *= 1.0 - bar;

          // Linear -> sRGB for the canvas.
          vec3 s = mix(col * 12.92, 1.055 * pow(max(col, 0.0), vec3(1.0 / 2.4)) - 0.055, step(0.0031308, col));
          gl_FragColor = vec4(s, 1.0);
        }`,
    });

    this.setSize(width, height);
  }

  setSize(w, h) {
    this.width = w; this.height = h;
    this.rt.setSize(w, h);
    this.rt.depthTexture.image.width = w;
    this.rt.depthTexture.image.height = h;
    this.rt.depthTexture.needsUpdate = true;
    this.rtA.setSize(Math.max(2, w >> 1), Math.max(2, h >> 1));
    this.rtB.setSize(Math.max(2, w >> 1), Math.max(2, h >> 1));
    const d = 6;
    this.rtC.setSize(Math.max(2, Math.floor(w / d)), Math.max(2, Math.floor(h / d)));
    this.rtD.setSize(Math.max(2, Math.floor(w / d)), Math.max(2, Math.floor(h / d)));
    this.composite.uniforms.uTexel.value.set(1 / w, 1 / h);
    this.composite.uniforms.uAspect.value = w / h;
  }

  pass(material, target) {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.clear(true, false, false);
    this.renderer.render(this.scene, this.cam);
  }

  blurInto(src, tmp, dst, radius) {
    this.blur.uniforms.tSrc.value = src.texture;
    this.blur.uniforms.uDir.value.set(radius / dst.width, 0);
    this.pass(this.blur, tmp);
    this.blur.uniforms.tSrc.value = tmp.texture;
    this.blur.uniforms.uDir.value.set(0, radius / dst.height);
    this.pass(this.blur, dst);
  }

  // Ease the live look toward whatever the director last asked for.
  grade(dt, rate = 2.4) {
    for (const k in this.target) {
      if (k === 'tint') {
        for (let i = 0; i < 3; i++) this.look.tint[i] = approach(this.look.tint[i], this.target.tint[i], rate, dt);
      } else if (typeof this.target[k] === 'number') {
        this.look[k] = approach(this.look[k], this.target[k], rate, dt);
      }
    }
  }

  setLook(vals) { Object.assign(this.target, vals); return this; }
  snapLook(vals) { Object.assign(this.target, vals); Object.assign(this.look, vals); return this; }

  render(scene, camera, time, cine) {
    const r = this.renderer;
    r.setRenderTarget(this.rt);
    r.clear();
    r.render(scene, camera);

    // Half-res soft blur — DOF near field and the diffusion veil.
    this.copy.uniforms.tSrc.value = this.rt.texture;
    this.pass(this.copy, this.rtA);
    this.blurInto(this.rtA, this.rtB, this.rtA, 1.4);

    // Wide blur for bloom and halation.
    this.bright.uniforms.tSrc.value = this.rtA.texture;
    this.bright.uniforms.uThreshold.value = this.look.bloomThreshold;
    this.bright.uniforms.uTexel.value.set(1 / this.rtA.width, 1 / this.rtA.height);
    this.pass(this.bright, this.rtC);
    this.blurInto(this.rtC, this.rtD, this.rtC, 2.2);
    this.blurInto(this.rtC, this.rtD, this.rtC, 3.6);

    const u = this.composite.uniforms, L = this.look;
    u.tScene.value = this.rt.texture;
    u.tNear.value = this.rtA.texture;
    u.tWide.value = this.rtC.texture;
    u.tDepth.value = this.rt.depthTexture;
    u.uNear.value = camera.near; u.uFar.value = camera.far;
    u.uFocus.value = cine ? cine.focus : 3;
    u.uAperture.value = cine ? cine.aperture : 1;
    u.uWhip.value = cine ? cine.whip * L.whip : 0;
    u.uWhipDir.value = L.whipDir;
    u.uTime.value = time;
    u.uDof.value = L.dof;
    u.uExposure.value = L.exposure; u.uContrast.value = L.contrast;
    u.uSaturation.value = L.saturation; u.uWarmth.value = L.warmth; u.uLift.value = L.lift;
    u.uTint.value.set(L.tint[0], L.tint[1], L.tint[2]);
    u.uBloom.value = L.bloom; u.uDiffusion.value = L.diffusion; u.uHalation.value = L.halation;
    u.uGrain.value = L.grain; u.uVignette.value = L.vignette; u.uChroma.value = L.chroma;
    u.uLetterbox.value = L.letterbox; u.uFlash.value = L.flash; u.uFade.value = L.fade;
    u.uFreeze.value = L.freeze; u.uVhs.value = L.vhs;

    r.setRenderTarget(null);
    this.pass(this.composite, null);
  }
}
