import * as THREE from '../vendor/three/three.module.js';

// A polar grid, dense at the middle and sparse at the rim, re-centred on the
// camera every frame. Ring radii are geometric, so the world-space spacing of
// the tessellation grows linearly with distance - which is exactly how a pixel
// footprint grows, and is why one `aSpacing` attribute is enough to drive
// level of detail everywhere.
export function polarGrid({ rings = 420, sectors = 448, rMin = 0.4, rMax = 20000 } = {}) {
  const vertCount = (rings + 1) * (sectors + 1);
  const pos = new Float32Array(vertCount * 3);
  const spacing = new Float32Array(vertCount);
  const ln = Math.log(rMax / rMin);

  let v = 0;
  for (let i = 0; i <= rings; i++) {
    const f = i / rings;
    const r = rMin * Math.exp(ln * f);
    // Whichever way the quad is longer is the one that limits what it can show.
    const radial = (r * ln) / rings;
    const tangential = (r * Math.PI * 2) / sectors;
    const s = Math.max(radial, tangential);
    for (let j = 0; j <= sectors; j++) {
      const a = (j / sectors) * Math.PI * 2;
      pos[v * 3] = Math.cos(a) * r;
      pos[v * 3 + 1] = 0;
      pos[v * 3 + 2] = Math.sin(a) * r;
      spacing[v] = s;
      v++;
    }
  }

  const idx = new Uint32Array(rings * sectors * 6);
  let k = 0;
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < sectors; j++) {
      const a = i * (sectors + 1) + j;
      const b = a + sectors + 1;
      idx[k++] = a; idx[k++] = b; idx[k++] = a + 1;
      idx[k++] = a + 1; idx[k++] = b; idx[k++] = b + 1;
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aSpacing', new THREE.BufferAttribute(spacing, 1));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  // The mesh is re-centred on the camera, so a fitted bounding sphere would be
  // wrong the moment it moves. Frustum culling is off instead.
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), rMax * 2);
  return g;
}

// Fullscreen triangle for the sky and the post pass.
export function fullscreenTriangle() {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  return g;
}
