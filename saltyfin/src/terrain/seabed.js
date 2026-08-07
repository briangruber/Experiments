// STUB — replaced by the terrain module owner.
import * as THREE from 'three';
import { LAYER, setLayers } from '../core/layers.js';
export function createSeabed() {
  const size = 900, seg = 128;
  const geo = new THREE.PlaneGeometry(size, size, seg, seg);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const h = (x, z) => -3 - 14 * Math.min(1, Math.hypot(x + 120, z + 60) / 260) + 1.6 * Math.sin(x * 0.09) * Math.cos(z * 0.11);
  for (let i = 0; i < pos.count; i++) pos.setY(i, h(pos.getX(i), pos.getZ(i)));
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ color: 0xC8B98C, roughness: 0.95, metalness: 0 });
  const mesh = new THREE.Mesh(geo, mat);
  const group = new THREE.Group(); group.add(mesh);
  setLayers(group, LAYER.MAIN, LAYER.UNDERWATER);
  return { group, update() {}, applyEnv() {}, dispose() { geo.dispose(); mat.dispose(); }, seabedHeight: h };
}
