import * as THREE from 'three';
import { waterHeight } from '/shared/waves.js';

// One pooled point cloud carries every splash, every puff of blood and every
// column of smoke from a burning hull. Cheaper than five systems and it keeps
// the sorting honest.

const MAX = 1400;

export class Particles {
  constructor(scene) {
    this.count = MAX;
    this.pos = new Float32Array(MAX * 3);
    this.col = new Float32Array(MAX * 3);
    this.size = new Float32Array(MAX);
    this.alpha = new Float32Array(MAX);
    this.vel = new Float32Array(MAX * 3);
    this.life = new Float32Array(MAX);
    this.maxLife = new Float32Array(MAX);
    this.grav = new Float32Array(MAX);
    this.drag = new Float32Array(MAX);
    this.buoy = new Uint8Array(MAX);
    this.cursor = 0;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { uScale: { value: window.innerHeight * 0.5 } },
      vertexShader: /* glsl */`
        attribute float aSize;
        attribute float aAlpha;
        attribute vec3 aColor;
        uniform float uScale;
        varying float vAlpha;
        varying vec3 vColor;
        void main() {
          vAlpha = aAlpha;
          vColor = aColor;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * uScale / max(-mv.z, 1.0);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        precision mediump float;
        varying float vAlpha;
        varying vec3 vColor;
        void main() {
          vec2 d = gl_PointCoord - 0.5;
          float r = dot(d, d);
          if (r > 0.25) discard;
          float a = vAlpha * smoothstep(0.25, 0.02, r);
          gl_FragColor = vec4(vColor, a);
        }`,
    });

    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    this.material = mat;
    scene.add(this.points);
  }

  spawn(x, y, z, vx, vy, vz, opts = {}) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % MAX;
    const c = opts.color ?? 0xffffff;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.col[i * 3] = ((c >> 16) & 255) / 255;
    this.col[i * 3 + 1] = ((c >> 8) & 255) / 255;
    this.col[i * 3 + 2] = (c & 255) / 255;
    this.size[i] = opts.size ?? 0.5;
    this.life[i] = this.maxLife[i] = opts.life ?? 1;
    this.grav[i] = opts.gravity ?? 11;
    this.drag[i] = opts.drag ?? 0.6;
    this.buoy[i] = opts.float ? 1 : 0;
    this.alpha[i] = opts.alpha ?? 1;
  }

  splash(p, strength = 1, color = 0xdff0f6) {
    const n = Math.min(40, Math.round(6 + strength * 14));
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * 1.4 * strength;
      this.spawn(
        p.x + Math.cos(a) * r * 0.6, p.y + 0.2, p.z + Math.sin(a) * r * 0.6,
        Math.cos(a) * r * 2.4, 3.5 + Math.random() * 5.5 * strength, Math.sin(a) * r * 2.4,
        { color, size: 0.18 + Math.random() * 0.34 * strength, life: 0.7 + Math.random() * 0.8, gravity: 13 }
      );
    }
  }

  burst(p, color, n = 24, spread = 4, opts = {}) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const b = Math.random() * Math.PI - Math.PI / 2;
      const s = spread * (0.35 + Math.random());
      this.spawn(
        p.x, p.y, p.z,
        Math.cos(a) * Math.cos(b) * s, Math.sin(b) * s + 1.5, Math.sin(a) * Math.cos(b) * s,
        { color, size: 0.3 + Math.random() * 0.6, life: 0.8 + Math.random(), gravity: 6, ...opts }
      );
    }
  }

  /** Negative gravity makes it rise; update() also grows it as it climbs. */
  smoke(x, y, z, color = 0x2c2f33, n = 1) {
    for (let i = 0; i < n; i++) {
      this.spawn(
        x + (Math.random() - 0.5) * 1.2, y, z + (Math.random() - 0.5) * 1.2,
        (Math.random() - 0.5) * 1.4, 2.4 + Math.random() * 2.2, (Math.random() - 0.5) * 1.4,
        { color, size: 0.9 + Math.random() * 0.8, life: 1.8 + Math.random() * 1.6, gravity: -1.6, drag: 1.1, alpha: 0.55 }
      );
    }
  }

  update(dt, time) {
    const { pos, vel, life, maxLife, alpha, grav, drag, buoy, size } = this;
    for (let i = 0; i < MAX; i++) {
      if (life[i] <= 0) { alpha[i] = 0; continue; }
      life[i] -= dt;
      const i3 = i * 3;
      vel[i3 + 1] -= grav[i] * dt;
      const d = Math.max(0, 1 - drag[i] * dt);
      vel[i3] *= d; vel[i3 + 1] *= d; vel[i3 + 2] *= d;
      pos[i3] += vel[i3] * dt;
      pos[i3 + 1] += vel[i3 + 1] * dt;
      pos[i3 + 2] += vel[i3 + 2] * dt;
      if (buoy[i]) {
        // Foam sits on the surface instead of falling through it.
        const wy = waterHeight(pos[i3], pos[i3 + 2], time);
        if (pos[i3 + 1] < wy) { pos[i3 + 1] = wy; vel[i3 + 1] = 0; }
      }
      const t = Math.max(0, life[i] / maxLife[i]);
      alpha[i] = t * t * (buoy[i] ? 0.75 : 1);
      if (grav[i] < 0) size[i] += dt * 0.9; // smoke billows
    }
    const g = this.points.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.aAlpha.needsUpdate = true;
    g.attributes.aColor.needsUpdate = true;
    g.attributes.aSize.needsUpdate = true;
  }

  resize(h) { this.material.uniforms.uScale.value = h * 0.5; }
}

/** Foam ribbon dragged behind a hull. */
export class Wake {
  constructor(scene, { length = 90, width = 1.6, color = 0xdfeef2 } = {}) {
    this.n = length;
    this.width = width;
    this.positions = new Float32Array(length * 2 * 3);
    this.alphas = new Float32Array(length * 2);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alphas, 1));
    const idx = [];
    for (let i = 0; i < length - 1; i++) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, c, b, b, c, d);
    }
    geo.setIndex(idx);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.geo = geo;
    this.mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      uniforms: { uColor: { value: new THREE.Color(color) } },
      vertexShader: `
        attribute float aAlpha; varying float vA;
        void main() { vA = aAlpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `
        precision mediump float; uniform vec3 uColor; varying float vA;
        void main() { if (vA <= 0.001) discard; gl_FragColor = vec4(uColor, vA); }`,
    }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
    scene.add(this.mesh);
    this.acc = 0;
  }

  /** Call every frame; drops a new rib every few metres of travel. */
  push(x, y, z, headingX, headingZ, strength, dt) {
    this.acc += dt;
    for (let i = 0; i < this.n * 2; i++) this.alphas[i] = Math.max(0, this.alphas[i] - dt * 0.42);
    if (this.acc < 0.045) { this.flush(); return; }
    this.acc = 0;
    // Shift the whole ribbon back one rib and write the new one at the head.
    // A ring buffer would be cheaper but leaves a triangle stretched across the
    // world at the wrap point.
    this.positions.copyWithin(6, 0, (this.n - 1) * 6);
    this.alphas.copyWithin(2, 0, (this.n - 1) * 2);
    const w = this.width * (0.5 + strength);
    const px = -headingZ, pz = headingX; // perpendicular in XZ
    this.positions[0] = x + px * w;
    this.positions[1] = y;
    this.positions[2] = z + pz * w;
    this.positions[3] = x - px * w;
    this.positions[4] = y;
    this.positions[5] = z - pz * w;
    this.alphas[0] = this.alphas[1] = Math.min(0.6, 0.15 + strength * 0.5);
    this.flush();
  }

  flush() {
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aAlpha.needsUpdate = true;
  }

  dispose() {
    this.mesh.parent?.remove(this.mesh);
    this.geo.dispose();
    this.mesh.material.dispose();
  }
}
