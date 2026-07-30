// Every set piece is a named placeholder registered here. When real models
// are ready, drop them in without touching the scene code:
//
//   import { swapModel } from './props/registry.js';
//   const gltf = await new GLTFLoader().loadAsync('models/boat.glb');
//   swapModel(scene, 'boat', gltf.scene);   // keeps the placeholder's transform
//
// Anchor conventions for each name are documented in the README.

const builders = new Map();

export function definePlaceholder(name, build) {
  builders.set(name, build);
}

export function spawn(name, opts = {}) {
  const build = builders.get(name);
  if (!build) throw new Error(`no placeholder registered for "${name}"`);
  const obj = build(opts);
  obj.name = name;
  obj.userData.placeholder = true;
  return obj;
}

export function swapModel(root, name, model) {
  const old = root.getObjectByName(name);
  if (!old) throw new Error(`no object named "${name}" in scene`);
  model.name = name;
  model.position.copy(old.position);
  model.rotation.copy(old.rotation);
  model.scale.copy(old.scale);
  model.userData.api = old.userData.api;      // keep runtime hooks alive
  old.parent.add(model);
  old.parent.remove(old);
  return model;
}
