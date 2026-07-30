import * as THREE from 'three';

/** Soft foam ribbon trailing the motorboat. */
export function createWake({ max = 120 } = {}) {
  const positions = new Float32Array(max * 2 * 3);
  const alphas = new Float32Array(max * 2);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aAlpha', new THREE.BufferAttribute(alphas, 1));

  const indices = [];
  for (let i = 0; i < max - 1; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    indices.push(a, c, b, b, c, d);
  }
  geo.setIndex(indices);

  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: { uTime: { value: 0 } },
    vertexShader: /* glsl */`
      attribute float aAlpha;
      varying float vAlpha;
      void main() {
        vAlpha = aAlpha;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */`
      varying float vAlpha;
      void main() {
        vec3 col = vec3(0.92, 0.96, 0.98);
        gl_FragColor = vec4(col, vAlpha * 0.72);
      }`,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -5;

  const points = [];
  let emitAcc = 0;

  return {
    mesh,
    update(boat, dt) {
      emitAcc += dt;
      const interval = 0.04;
      if (emitAcc >= interval && Math.abs(boat.speed) > 1.2) {
        emitAcc = 0;
        const back = -2.2;
        const side = 0.55 + Math.min(1.2, Math.abs(boat.speed) * 0.06);
        const fx = Math.sin(boat.heading);
        const fz = Math.cos(boat.heading);
        const rx = Math.cos(boat.heading);
        const rz = -Math.sin(boat.heading);
        const cx = boat.x + fx * back;
        const cz = boat.z + fz * back;
        const y = boat.y + 0.08;
        points.unshift({
          lx: cx - rx * side, ly: y, lz: cz - rz * side,
          rx: cx + rx * side, ry: y, rz: cz + rz * side,
          life: 1,
        });
        if (points.length > max) points.length = max;
      }

      for (let i = 0; i < points.length; i++) {
        points[i].life -= dt * 0.35;
        const p = points[i];
        const a = Math.max(0, p.life);
        const widen = 1 + (1 - a) * 1.8;
        const mx = (p.lx + p.rx) * 0.5;
        const mz = (p.lz + p.rz) * 0.5;
        positions[i * 6] = mx + (p.lx - mx) * widen;
        positions[i * 6 + 1] = p.ly;
        positions[i * 6 + 2] = mz + (p.lz - mz) * widen;
        positions[i * 6 + 3] = mx + (p.rx - mx) * widen;
        positions[i * 6 + 4] = p.ry;
        positions[i * 6 + 5] = mz + (p.rz - mz) * widen;
        alphas[i * 2] = a * (i === 0 ? 0.3 : 1);
        alphas[i * 2 + 1] = a * (i === 0 ? 0.3 : 1);
      }
      // Clear unused.
      for (let i = points.length; i < max; i++) {
        positions[i * 6 + 1] = -100;
        positions[i * 6 + 4] = -100;
        alphas[i * 2] = 0;
        alphas[i * 2 + 1] = 0;
      }
      geo.attributes.position.needsUpdate = true;
      geo.attributes.aAlpha.needsUpdate = true;
      geo.computeBoundingSphere();
    },
  };
}
