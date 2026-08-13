import * as THREE from 'three';
import { rand } from './util.js';

// Lightweight effect pools: falling feathers, dust puffs, sleep Zs, and seed
// patches thrown by the player.

function softCircleTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const grad = ctx.createRadialGradient(32, 32, 4, 32, 32, 30);
  grad.addColorStop(0, 'rgba(255,255,255,0.9)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

function zTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  ctx.font = 'bold 44px Georgia';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(255,250,235,0.95)';
  ctx.fillText('z', 32, 34);
  return new THREE.CanvasTexture(c);
}

const FEATHER_GEO = new THREE.PlaneGeometry(0.085, 0.05);
const SEED_GEO = new THREE.SphereGeometry(0.022, 6, 5);

class SeedPatch {
  constructor(scene, pos, rng) {
    this.pos = pos.clone();
    this.count = 14;
    this.total = 14;
    this.scene = scene;
    this.mesh = new THREE.InstancedMesh(SEED_GEO,
      new THREE.MeshStandardMaterial({ color: 0xe3c063, flatShading: true, roughness: 0.9 }), this.total);
    const dummy = new THREE.Object3D();
    for (let i = 0; i < this.total; i++) {
      const a = rand(rng, 0, Math.PI * 2), r = Math.sqrt(rng()) * 0.5;
      dummy.position.set(pos.x + Math.sin(a) * r, 0.03, pos.z + Math.cos(a) * r);
      dummy.scale.setScalar(rand(rng, 0.8, 1.3));
      dummy.updateMatrix();
      this.mesh.setMatrixAt(i, dummy.matrix);
    }
    scene.add(this.mesh);
  }

  eat() {
    if (this.count <= 0) return;
    this.count--;
    const dummy = new THREE.Object3D();
    dummy.scale.setScalar(0);
    dummy.updateMatrix();
    this.mesh.setMatrixAt(this.count, dummy.matrix);
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.count <= 0) this.scene.remove(this.mesh);
  }

  // A stable spot around the patch per chicken so they don't stack up.
  spotFor(c) {
    let h = 0;
    for (let i = 0; i < c.name.length; i++) h = (h * 31 + c.name.charCodeAt(i)) | 0;
    const a = (h % 360) * Math.PI / 180;
    return new THREE.Vector3(this.pos.x + Math.sin(a) * 0.42, 0, this.pos.z + Math.cos(a) * 0.42);
  }
}

export class FX {
  constructor(scene, rng) {
    this.scene = scene;
    this.rng = rng;
    this.feathers = [];
    this.sprites = [];   // puffs and Zs share the update path
    this.patches = [];
    this.puffTex = softCircleTexture();
    this.zTex = zTexture();
  }

  feather(pos, color) {
    if (this.feathers.length > 36) return;
    const m = new THREE.Mesh(FEATHER_GEO, new THREE.MeshBasicMaterial({
      color, side: THREE.DoubleSide, transparent: true, opacity: 0.95,
    }));
    m.position.set(pos.x + rand(this.rng, -0.2, 0.2), pos.y + rand(this.rng, 0.3, 0.6), pos.z + rand(this.rng, -0.2, 0.2));
    m.rotation.set(rand(this.rng, 0, 3), rand(this.rng, 0, 3), 0);
    m.userData = { life: 0, phase: rand(this.rng, 0, 6.28), landed: false };
    this.scene.add(m);
    this.feathers.push(m);
  }

  puff(pos, color) {
    this._sprite(this.puffTex, color, pos.clone().add(new THREE.Vector3(rand(this.rng, -0.2, 0.2), 0.12, rand(this.rng, -0.2, 0.2))),
      { grow: 1.1, rise: 0.12, life: 0.9, size: 0.3, opacity: 0.4 });
  }

  zzz(pos) {
    this._sprite(this.zTex, 0xffffff, pos,
      { grow: 0.12, rise: 0.32, life: 1.7, size: 0.16, opacity: 0.9, wobble: true });
  }

  _sprite(map, color, pos, cfg) {
    if (this.sprites.length > 40) return;
    const s = new THREE.Sprite(new THREE.SpriteMaterial({
      map, color, transparent: true, opacity: cfg.opacity, depthWrite: false,
    }));
    s.position.copy(pos);
    s.scale.setScalar(cfg.size);
    s.userData = { ...cfg, t: 0, baseX: pos.x };
    this.scene.add(s);
    this.sprites.push(s);
  }

  seeds(pos) {
    const patch = new SeedPatch(this.scene, pos, this.rng);
    this.patches.push(patch);
    if (this.patches.length > 3) {
      const old = this.patches.shift();
      old.count = 0;
      this.scene.remove(old.mesh);
    }
    return patch;
  }

  update(dt, time) {
    for (let i = this.feathers.length - 1; i >= 0; i--) {
      const f = this.feathers[i];
      const u = f.userData;
      u.life += dt;
      if (!u.landed) {
        f.position.y -= 0.35 * dt;
        f.position.x += Math.sin(time * 3 + u.phase) * 0.25 * dt;
        f.rotation.z = Math.sin(time * 2.4 + u.phase) * 0.9;
        f.rotation.x = Math.sin(time * 1.8 + u.phase) * 0.6 + 1.2;
        if (f.position.y <= 0.02) { f.position.y = 0.02; u.landed = true; u.life = 0; }
      } else {
        f.material.opacity = Math.max(0, 0.95 - u.life * 0.7);
        if (f.material.opacity <= 0) {
          this.scene.remove(f);
          f.material.dispose();
          this.feathers.splice(i, 1);
        }
      }
    }

    for (let i = this.sprites.length - 1; i >= 0; i--) {
      const s = this.sprites[i];
      const u = s.userData;
      u.t += dt;
      const k = u.t / u.life;
      s.position.y += u.rise * dt;
      if (u.wobble) s.position.x = u.baseX + Math.sin(u.t * 3.2) * 0.06;
      s.scale.setScalar(u.size + u.grow * k * u.size * 3);
      s.material.opacity = u.opacity * (1 - k);
      if (u.t >= u.life) {
        this.scene.remove(s);
        s.material.dispose();
        this.sprites.splice(i, 1);
      }
    }

    this.patches = this.patches.filter((p) => p.count > 0);
  }
}
