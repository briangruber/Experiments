// STUB — replaced by the sky module owner.
import * as THREE from 'three';
import { LAYER, setLayers } from '../core/layers.js';
export function createSky() {
  const geo = new THREE.SphereGeometry(4000, 32, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { top: { value: new THREE.Color() }, bot: { value: new THREE.Color() } },
    vertexShader: 'varying vec3 vW; void main(){ vW = position; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
    fragmentShader: 'uniform vec3 top; uniform vec3 bot; varying vec3 vW; void main(){ float h = normalize(vW).y*0.5+0.5; gl_FragColor = vec4(mix(bot, top, smoothstep(0.42,0.85,h)), 1.0); }',
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  const group = new THREE.Group(); group.add(mesh);
  setLayers(group, LAYER.MAIN, LAYER.REFLECTED);
  return {
    group, update() {}, dispose() { geo.dispose(); mat.dispose(); },
    applyEnv(env) { mat.uniforms.top.value.copy(env.skyZenith); mat.uniforms.bot.value.copy(env.skyHorizon); },
  };
}
