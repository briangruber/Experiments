// STUB — replaced by the boat module owner.
import * as THREE from 'three';
import { LAYER, setLayers } from '../core/layers.js';
export function createBoat() {
  const group = new THREE.Group();
  const hull = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.85, 4.6), new THREE.MeshStandardMaterial({ color: 0xf2efe6, roughness: 0.6 }));
  hull.position.y = 0.15; hull.castShadow = true;
  group.add(hull);
  setLayers(group, LAYER.MAIN, LAYER.REFLECTED);
  return {
    group, update(ctx) {
      group.position.copy(ctx.boat.position);
      group.rotation.set(ctx.boat.trim, ctx.boat.heading, ctx.boat.heel, 'YXZ');
    }, applyEnv() {}, dispose() {},
  };
}
