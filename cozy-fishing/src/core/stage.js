// Renderer + camera rig + post chain (soft bloom, filmic tonemap).
// The camera idles with a slow sway and follows the pointer a little,
// like someone leaning to see past the lantern.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { CAMERA, BLOOM } from '../config.js';
import { damp } from './utils.js';

export function createStage(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();

  const camera = new THREE.PerspectiveCamera(CAMERA.fov, 1, 0.1, 2000);
  const basePos = new THREE.Vector3(...CAMERA.pos);
  const target = new THREE.Vector3(...CAMERA.target);
  camera.position.copy(basePos);
  camera.lookAt(target);

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(1, 1), BLOOM.strength, BLOOM.radius, BLOOM.threshold
  );
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  const pointer = { x: 0, y: 0 };
  const off = { x: 0, y: 0 };
  addEventListener('pointermove', (e) => {
    pointer.x = (e.clientX / innerWidth) * 2 - 1;
    pointer.y = (e.clientY / innerHeight) * 2 - 1;
  });

  function resize() {
    renderer.setSize(innerWidth, innerHeight);
    composer.setSize(innerWidth, innerHeight);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  }
  addEventListener('resize', resize);
  resize();

  function update(dt, t) {
    off.x = damp(off.x, pointer.x * CAMERA.parallax, 2.2, dt);
    off.y = damp(off.y, -pointer.y * CAMERA.parallax * 0.5, 2.2, dt);
    camera.position.set(
      basePos.x + off.x + Math.sin(t * 0.11) * CAMERA.swayAmp,
      basePos.y + off.y + Math.sin(t * 0.169) * CAMERA.swayAmp * 0.5,
      basePos.z
    );
    camera.lookAt(target.x + off.x * 1.5, target.y + off.y * 2.0, target.z);
  }

  return { renderer, scene, camera, composer, update, render: () => composer.render() };
}
