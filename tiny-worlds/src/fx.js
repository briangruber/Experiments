// One pooled Points system for every spark, footfall puff and re-entry trail
// in the game. World space, CPU-updated, capped — it never allocates in play.

import * as THREE from 'three';

const _v = new THREE.Vector3();
const _c = new THREE.Color();

function sparkTexture() {
  const s = 64;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class Particles {
  constructor(scene, count = 900) {
    this.count = count;
    this.pos = new Float32Array(count * 3);
    this.col = new Float32Array(count * 3);
    this.siz = new Float32Array(count);
    this.vel = new Float32Array(count * 3);
    this.life = new Float32Array(count);
    this.maxLife = new Float32Array(count);
    this.drag = new Float32Array(count);
    this.grav = new Float32Array(count * 3);
    this.cursor = 0;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.siz, 1));
    geo.setDrawRange(0, count);

    // Own shader rather than PointsMaterial: per-particle size needs an
    // attribute, and PointsMaterial already owns the name `size` as a uniform.
    this.scaleUniform = { value: 400 };
    const mat = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: sparkTexture() }, uScale: this.scaleUniform },
      vertexShader: `
        attribute vec3 aColor;
        attribute float aSize;
        uniform float uScale;
        varying vec3 vColor;
        void main() {
          vColor = aColor;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = max(1.0, aSize * (uScale / max(0.001, -mv.z)));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform sampler2D uMap;
        varying vec3 vColor;
        void main() {
          vec4 t = texture2D(uMap, gl_PointCoord);
          if (t.a < 0.01) discard;
          gl_FragColor = vec4(vColor * t.a, t.a);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
    scene.add(this.points);
    this.geo = geo;
    for (let i = 0; i < count; i++) this.siz[i] = 0;
  }

  // `color` is an sRGB THREE.Color; the render target is linear.
  spawn(p, v, color, size, life, { drag = 1.4, gravity = null } = {}) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.count;
    _c.copy(color).convertSRGBToLinear();
    this.pos[i * 3] = p.x; this.pos[i * 3 + 1] = p.y; this.pos[i * 3 + 2] = p.z;
    this.vel[i * 3] = v.x; this.vel[i * 3 + 1] = v.y; this.vel[i * 3 + 2] = v.z;
    this.col[i * 3] = _c.r; this.col[i * 3 + 1] = _c.g; this.col[i * 3 + 2] = _c.b;
    this.siz[i] = size;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.drag[i] = drag;
    if (gravity) { this.grav[i * 3] = gravity.x; this.grav[i * 3 + 1] = gravity.y; this.grav[i * 3 + 2] = gravity.z; }
    else { this.grav[i * 3] = this.grav[i * 3 + 1] = this.grav[i * 3 + 2] = 0; }
    this.baseSize ||= new Float32Array(this.count);
    this.baseSize[i] = size;
  }

  burst(center, { count = 26, color = new THREE.Color(0xffd98a), speed = 4, size = 0.45, life = 0.9, up = null, spread = 1 } = {}) {
    for (let i = 0; i < count; i++) {
      _v.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1);
      if (_v.lengthSq() < 1e-4) _v.set(0, 1, 0);
      _v.normalize().multiplyScalar(speed * (0.4 + Math.random() * 0.9) * spread);
      if (up) _v.addScaledVector(up, speed * 0.5);
      this.spawn(center, _v, color, size * (0.6 + Math.random() * 0.8), life * (0.7 + Math.random() * 0.6), {
        gravity: up ? up.clone().multiplyScalar(-6) : null,
      });
    }
  }

  update(dt) {
    const { pos, vel, life, maxLife, siz, drag, grav, count } = this;
    const base = this.baseSize;
    for (let i = 0; i < count; i++) {
      if (life[i] <= 0) { if (siz[i] !== 0) siz[i] = 0; continue; }
      life[i] -= dt;
      const t = Math.max(0, life[i] / maxLife[i]);
      const d = Math.exp(-drag[i] * dt);
      vel[i * 3] = vel[i * 3] * d + grav[i * 3] * dt;
      vel[i * 3 + 1] = vel[i * 3 + 1] * d + grav[i * 3 + 1] * dt;
      vel[i * 3 + 2] = vel[i * 3 + 2] * d + grav[i * 3 + 2] * dt;
      pos[i * 3] += vel[i * 3] * dt;
      pos[i * 3 + 1] += vel[i * 3 + 1] * dt;
      pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
      siz[i] = (base ? base[i] : 0.4) * t * t;
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aColor.needsUpdate = true;
    this.geo.attributes.aSize.needsUpdate = true;
  }
}
