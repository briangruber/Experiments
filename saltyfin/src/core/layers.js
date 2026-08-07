// Which passes an object appears in. See CONTRACT.md.
//
// Three's Object3D.layers is per-object, not inherited, so setting a bit on a
// group does nothing for its children. setLayers walks the subtree.

export const LAYER = {
  MAIN: 0,
  UNDERWATER: 1,
  REFLECTED: 2,
  WATER: 3,
};

export function setLayers(root, ...bits) {
  root.traverse((o) => {
    o.layers.disableAll();
    for (const b of bits) o.layers.enable(b);
  });
  return root;
}

export function addLayers(root, ...bits) {
  root.traverse((o) => {
    for (const b of bits) o.layers.enable(b);
  });
  return root;
}
