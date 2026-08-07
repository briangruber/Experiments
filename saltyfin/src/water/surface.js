// STUB — replaced by the water module owner.
import * as THREE from 'three';
import { LAYER, setLayers } from '../core/layers.js';
import { waveHeight, waveNormal } from './waves.js';
export function createWater() {
  const geo = new THREE.PlaneGeometry(4000, 4000, 96, 96);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshStandardMaterial({ color: 0x1173b8, roughness: 0.08, metalness: 0.0, transparent: true, opacity: 0.92 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  const group = new THREE.Group(); group.add(mesh);
  setLayers(group, LAYER.MAIN);
  return {
    group, material: mat,
    update(ctx) { mesh.position.set(ctx.camera.position.x, 0, ctx.camera.position.z); },
    applyEnv(env) { mat.color.copy(env.waterDeep); },
    dispose() { geo.dispose(); mat.dispose(); },
    sampleHeight: (x, z, t) => waveHeight(x, z, t),
    sampleNormal: (x, z, t, out) => waveNormal(x, z, t, out || new THREE.Vector3()),
    disturb() {}, setTargets() {},
  };
}
