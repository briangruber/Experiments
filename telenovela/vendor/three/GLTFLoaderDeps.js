// The two helpers GLTFLoader imports from the three.js addons tree, ported so
// the loader stands alone rather than dragging in BufferGeometryUtils and
// SkeletonUtils whole (about 70 KB for two functions).
//
// Both are faithful ports of the upstream implementations — three.js r185,
// MIT. Only the surrounding module machinery differs.

import { TrianglesDrawMode, TriangleFanDrawMode, TriangleStripDrawMode } from './three.module.min.js';

// BufferGeometryUtils.toTrianglesDrawMode — used when a glTF primitive arrives
// as a triangle strip or fan rather than plain triangles.
export function toTrianglesDrawMode(geometry, drawMode) {
  if (drawMode === TrianglesDrawMode) {
    console.warn('toTrianglesDrawMode(): geometry is already triangles.');
    return geometry;
  }

  if (drawMode === TriangleFanDrawMode || drawMode === TriangleStripDrawMode) {
    let index = geometry.getIndex();

    if (index === null) {
      const indices = [];
      const position = geometry.getAttribute('position');
      if (position === undefined) {
        console.error('toTrianglesDrawMode(): no position attribute; cannot convert.');
        return geometry;
      }
      for (let i = 0; i < position.count; i++) indices.push(i);
      geometry.setIndex(indices);
      index = geometry.getIndex();
    }

    const numberOfTriangles = index.count - 2;
    const newIndices = [];

    if (drawMode === TriangleFanDrawMode) {
      for (let i = 1; i <= numberOfTriangles; i++) {
        newIndices.push(index.getX(0), index.getX(i), index.getX(i + 1));
      }
    } else {
      // Strips alternate winding every other triangle.
      for (let i = 0; i < numberOfTriangles; i++) {
        if (i % 2 === 0) {
          newIndices.push(index.getX(i), index.getX(i + 1), index.getX(i + 2));
        } else {
          newIndices.push(index.getX(i + 2), index.getX(i + 1), index.getX(i));
        }
      }
    }

    if ((newIndices.length / 3) !== numberOfTriangles) {
      console.error('toTrianglesDrawMode(): unable to generate correct amount of triangles.');
    }

    const newGeometry = geometry.clone();
    newGeometry.setIndex(newIndices);
    newGeometry.clearGroups();
    return newGeometry;
  }

  console.error('toTrianglesDrawMode(): unknown draw mode', drawMode);
  return geometry;
}

function parallelTraverse(a, b, callback) {
  callback(a, b);
  for (let i = 0; i < a.children.length; i++) {
    parallelTraverse(a.children[i], b.children[i], callback);
  }
}

// SkeletonUtils.clone — a deep clone that rebinds skinned meshes onto the
// cloned bones instead of leaving them pointing at the original skeleton.
export function clone(source) {
  const sourceLookup = new Map();
  const cloneLookup = new Map();
  const cloned = source.clone();

  parallelTraverse(source, cloned, (sourceNode, clonedNode) => {
    sourceLookup.set(clonedNode, sourceNode);
    cloneLookup.set(sourceNode, clonedNode);
  });

  cloned.traverse((node) => {
    if (!node.isSkinnedMesh) return;
    const clonedMesh = node;
    const sourceMesh = sourceLookup.get(node);
    const sourceBones = sourceMesh.skeleton.bones;
    clonedMesh.skeleton = sourceMesh.skeleton.clone();
    clonedMesh.bindMatrix.copy(sourceMesh.bindMatrix);
    clonedMesh.skeleton.bones = sourceBones.map((bone) => cloneLookup.get(bone));
    clonedMesh.bind(clonedMesh.skeleton, clonedMesh.bindMatrix);
  });

  return cloned;
}
