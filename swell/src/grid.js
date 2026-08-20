import * as THREE from '../vendor/three/three.module.js';

// A ring grid whose radii are chosen in the *vertex shader*, from the camera's
// height above the water.
//
// The obvious construction — radii in geometric progression — gives triangles
// whose world size grows linearly with distance. That is the wrong law. For a
// camera at height h looking across a plane, a step dr at distance r moves the
// horizon-ward screen position by roughly h·dr/(r²+h²), so holding screen-space
// triangle size constant needs dr ∝ (r² + h²). A geometric grid therefore spends
// most of its rings on the far field, where they are invisible, and starves the
// middle distance — which on a beach is exactly where the surf is. The result is
// triangles tens of pixels across through the break, and since foam sits on the
// crest, the foam boundary inherits the faceting.
//
// Spacing rings uniformly in elevation angle instead — r = h·tan(θ) — is that
// law exactly. It also has to happen per frame rather than at build time,
// because h is a property of the scene's camera, so the ring parameter travels
// as an attribute and the radius is derived in the shader.
export function ringGrid({ rings = 420, sectors = 448 } = {}) {
  const vertCount = (rings + 1) * (sectors + 1);
  const dir = new Float32Array(vertCount * 3);   // unit direction on the water plane
  const ring = new Float32Array(vertCount);      // 0 at the camera, 1 at the rim

  let v = 0;
  for (let i = 0; i <= rings; i++) {
    const f = i / rings;
    for (let j = 0; j <= sectors; j++) {
      const a = (j / sectors) * Math.PI * 2;
      dir[v * 3] = Math.cos(a);
      dir[v * 3 + 1] = 0;
      dir[v * 3 + 2] = Math.sin(a);
      ring[v] = f;
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
  g.setAttribute('position', new THREE.BufferAttribute(dir, 3));
  g.setAttribute('aRing', new THREE.BufferAttribute(ring, 1));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  g.userData.rings = rings;
  g.userData.sectors = sectors;
  return g;
}

// Shared by the ocean and the seabed so the two surfaces land on exactly the
// same footprint. Returns the world XZ of this vertex and the world size of the
// larger of its two edges, which is what drives level of detail downstream.
export const RING_GLSL = /* glsl */`
uniform vec2 uGridCounts;    // (rings, sectors)
uniform vec2 uGridRange;     // (rMin, rMax) in metres

vec2 sw_ringPoint(vec3 dir, float ring, vec2 originXZ, float camHeight, out float spacing){
  float h = max(camHeight, 0.45);
  float thMin = atan(uGridRange.x / h);
  float thMax = atan(uGridRange.y / h);
  float th = mix(thMin, thMax, ring);
  float r = h * tan(th);

  // d(r)/d(ring index): h·sec²θ·Δθ / rings. This is the radial edge length, and
  // it is uniform on screen by construction.
  float sec = 1.0 / max(cos(th), 1e-4);
  float radial = h * sec * sec * (thMax - thMin) / max(uGridCounts.x, 1.0);
  float tangential = r * SW_TAU / max(uGridCounts.y, 1.0);
  spacing = max(radial, tangential);

  return originXZ + dir.xz * r;
}
`;

// Fullscreen triangle for the sky and the post pass.
export function fullscreenTriangle() {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  return g;
}
