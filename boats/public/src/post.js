import * as THREE from 'three';
import { EffectComposer } from '../vendor/addons/postprocessing/EffectComposer.js';
import { RenderPass } from '../vendor/addons/postprocessing/RenderPass.js';
import { ShaderPass } from '../vendor/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from '../vendor/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from '../vendor/addons/postprocessing/OutputPass.js';

// The finishing pass. Deliberately restrained: this is a stylised game, and
// the job here is to make the sun feel bright and tie the frame together, not
// to smear it in lens effects.

/** Grade, vignette and a cheap edge-aware smooth, in one full-screen pass. */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uVignette: { value: 0.26 },
    uWarmth: { value: 0.06 },
    uAA: { value: 1 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform vec2 uResolution;
    uniform float uVignette;
    uniform float uWarmth;
    uniform float uAA;
    varying vec2 vUv;

    float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

    void main() {
      vec2 px = 1.0 / uResolution;
      vec3 col = texture2D(tDiffuse, vUv).rgb;

      // FXAA-lite: blend along the local gradient only where there is an edge,
      // which is most of the benefit for a fraction of the cost.
      if (uAA > 0.5) {
        float l = luma(col);
        float lN = luma(texture2D(tDiffuse, vUv + vec2(0.0, px.y)).rgb);
        float lS = luma(texture2D(tDiffuse, vUv - vec2(0.0, px.y)).rgb);
        float lE = luma(texture2D(tDiffuse, vUv + vec2(px.x, 0.0)).rgb);
        float lW = luma(texture2D(tDiffuse, vUv - vec2(px.x, 0.0)).rgb);
        float edge = max(max(abs(lN - l), abs(lS - l)), max(abs(lE - l), abs(lW - l)));
        if (edge > 0.06) {
          vec2 dir = normalize(vec2(abs((lN + lS) - 2.0 * l) + 1e-4, abs((lE + lW) - 2.0 * l) + 1e-4));
          vec3 blur = texture2D(tDiffuse, vUv + dir * px * 0.85).rgb
                    + texture2D(tDiffuse, vUv - dir * px * 0.85).rgb;
          col = mix(col, (col + blur * 0.5) / 2.0, clamp(edge * 6.0, 0.0, 1.0));
        }
      }

      // Sea-air grade: lift the shadows toward blue, warm the highlights.
      float l2 = luma(col);
      col = mix(col, col * vec3(1.0 + uWarmth, 1.0, 1.0 - uWarmth * 0.7), smoothstep(0.45, 1.0, l2));
      col = mix(col, col * vec3(0.93, 0.99, 1.08), smoothstep(0.35, 0.0, l2));

      vec2 d = vUv - 0.5;
      col *= 1.0 - uVignette * dot(d, d) * 1.6;

      gl_FragColor = vec4(col, 1.0);
    }`,
};

export function createPost(renderer, scene, camera, { bloom = true, aa = true } = {}) {
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  let bloomPass = null;
  if (bloom) {
    // Threshold high: only the sun's glitter, the lighthouse and a monster's
    // eyes should ever glow.
    bloomPass = new UnrealBloomPass(
      new THREE.Vector2(innerWidth, innerHeight), 0.30, 0.7, 0.92
    );
    composer.addPass(bloomPass);
  }

  const grade = new ShaderPass(GradeShader);
  grade.uniforms.uAA.value = aa ? 1 : 0;
  composer.addPass(grade);
  composer.addPass(new OutputPass());

  function resize() {
    const dpr = renderer.getPixelRatio();
    composer.setSize(innerWidth, innerHeight);
    composer.setPixelRatio(dpr);
    grade.uniforms.uResolution.value.set(innerWidth * dpr, innerHeight * dpr);
    bloomPass?.setSize(innerWidth * dpr, innerHeight * dpr);
  }
  resize();

  return {
    composer,
    resize,
    render() { composer.render(); },
    setBloom(v) { if (bloomPass) bloomPass.strength = v; },
  };
}

/**
 * An environment map built from the game's own sky, rather than a downloaded
 * HDRI. It costs nothing to ship, and more importantly it cannot disagree with
 * the sky you are actually looking at.
 */
export function skyEnvironment(renderer, skyMesh) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const envScene = new THREE.Scene();
  const clone = skyMesh.clone();
  clone.material = skyMesh.material;      // shared: same shader, same sun
  envScene.add(clone);
  const target = pmrem.fromScene(envScene, 0, 1, 2000);
  pmrem.dispose();
  return target.texture;
}
