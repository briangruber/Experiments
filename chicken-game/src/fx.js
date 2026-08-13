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

// ---- emote bubbles ---------------------------------------------------------
// What a chicken is doing has to read at a glance, with no words anywhere.
// Every icon is drawn with canvas paths or ASCII glyphs only — an emoji font
// is not guaranteed to exist on the viewer's machine, and a tofu box in a
// thought bubble would be worse than no bubble at all.

const INK = '#241a12';
const CREAM = '#f7eeda';
const TAU_2 = Math.PI * 2;

function roundRect(x, l, t, w, h, r) {
  x.beginPath();
  x.moveTo(l + r, t);
  x.arcTo(l + w, t, l + w, t + h, r);
  x.arcTo(l + w, t + h, l, t + h, r);
  x.arcTo(l, t + h, l, t, r);
  x.arcTo(l, t, l + w, t, r);
  x.closePath();
}

function glyph(x, ch, color, size = 62) {
  x.fillStyle = color;
  x.font = `bold ${size}px Georgia, "Times New Roman", serif`;
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  x.fillText(ch, 64, 46);
}

function star(x, cx, cy, r, color) {
  x.fillStyle = color;
  x.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rad = i % 2 ? r * 0.44 : r;
    x[i ? 'lineTo' : 'moveTo'](cx + Math.cos(a) * rad, cy + Math.sin(a) * rad);
  }
  x.closePath();
  x.fill();
}

// The icon painters. Each draws inside a 128x128 canvas, centred near (64,44).
const ICONS = {
  bang: (x) => glyph(x, '!', '#c23b2e', 66),
  question: (x) => glyph(x, '?', INK, 62),
  zzz: (x) => { glyph(x, 'z', INK, 40); x.font = 'bold 56px Georgia'; x.fillText('Z', 82, 32); },
  dots: (x) => { // "...", the sound of a chicken having no thoughts
    x.fillStyle = INK;
    for (const dx of [-22, 0, 22]) { x.beginPath(); x.arc(64 + dx, 50, 7, 0, TAU_2); x.fill(); }
  },
  eye: (x) => {
    x.strokeStyle = INK; x.lineWidth = 6; x.fillStyle = '#fff';
    x.beginPath(); x.ellipse(64, 46, 34, 21, 0, 0, TAU_2); x.fill(); x.stroke();
    x.fillStyle = INK; x.beginPath(); x.arc(64, 46, 11, 0, TAU_2); x.fill();
  },
  anger: (x) => { // the four-spike cartoon anger mark
    x.fillStyle = '#c23b2e';
    x.beginPath();
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      x.moveTo(64 + ca * 34, 46 + sa * 34);
      x.lineTo(64 + (ca - sa) * 9, 46 + (sa + ca) * 9);
      x.lineTo(64 + Math.cos(a + Math.PI / 2) * 34, 46 + Math.sin(a + Math.PI / 2) * 34);
      x.lineTo(64 + (ca + sa) * 3, 46 + (sa - ca) * 3);
    }
    x.closePath(); x.fill();
  },
  heart: (x) => {
    x.fillStyle = '#d4526e';
    x.beginPath();
    x.moveTo(64, 68);
    x.bezierCurveTo(24, 44, 34, 16, 64, 34);
    x.bezierCurveTo(94, 16, 104, 44, 64, 68);
    x.closePath(); x.fill();
  },
  star: (x) => { star(x, 64, 46, 32, '#e8a33d'); },
  dizzy: (x) => { // little stars orbiting nothing
    star(x, 44, 34, 15, '#e8a33d');
    star(x, 82, 42, 13, '#e8a33d');
    star(x, 60, 62, 11, '#e8a33d');
  },
  note: (x) => {
    x.fillStyle = INK;
    x.beginPath(); x.ellipse(50, 62, 15, 11, -0.35, 0, TAU_2); x.fill();
    x.fillRect(61, 18, 6, 45);
    x.beginPath(); x.moveTo(67, 18); x.quadraticCurveTo(92, 26, 86, 48);
    x.quadraticCurveTo(84, 30, 67, 32); x.closePath(); x.fill();
  },
  drop: (x) => {
    x.fillStyle = '#5b93c9';
    x.beginPath(); x.moveTo(64, 16);
    x.bezierCurveTo(92, 46, 88, 72, 64, 72);
    x.bezierCurveTo(40, 72, 36, 46, 64, 16);
    x.closePath(); x.fill();
  },
  egg: (x) => {
    x.fillStyle = '#f2ead8'; x.strokeStyle = INK; x.lineWidth = 5;
    x.beginPath(); x.ellipse(64, 46, 22, 29, 0, 0, TAU_2); x.fill(); x.stroke();
  },
  grain: (x) => {
    x.fillStyle = '#d9a83f';
    for (const [dx, dy, a] of [[-20, 6, 0.4], [4, -12, -0.3], [18, 12, 0.7], [-2, 20, 0.1]]) {
      x.beginPath(); x.ellipse(64 + dx, 46 + dy, 13, 7, a, 0, TAU_2); x.fill();
    }
  },
  spiral: (x) => {
    x.strokeStyle = INK; x.lineWidth = 7; x.lineCap = 'round';
    x.beginPath();
    for (let i = 0; i <= 60; i++) {
      const t = (i / 60) * 4.4 * Math.PI;
      const r = 3 + t * 2.6;
      const px = 64 + Math.cos(t) * r, py = 46 + Math.sin(t) * r;
      x[i ? 'lineTo' : 'moveTo'](px, py);
    }
    x.stroke();
  },
  wing: (x) => { // a hopeful little wing: the flight-attempt icon
    x.fillStyle = INK;
    x.beginPath(); x.moveTo(30, 62);
    x.quadraticCurveTo(44, 18, 96, 24);
    x.quadraticCurveTo(78, 52, 30, 62);
    x.closePath(); x.fill();
    x.strokeStyle = CREAM; x.lineWidth = 4;
    for (const dx of [0, 13, 26]) {
      x.beginPath(); x.moveTo(48 + dx, 54 - dx * 0.55); x.lineTo(62 + dx, 32 - dx * 0.5); x.stroke();
    }
  },
  sun: (x) => {
    x.strokeStyle = '#e8a33d'; x.lineWidth = 6; x.lineCap = 'round';
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU_2;
      x.beginPath();
      x.moveTo(64 + Math.cos(a) * 24, 46 + Math.sin(a) * 24);
      x.lineTo(64 + Math.cos(a) * 36, 46 + Math.sin(a) * 36);
      x.stroke();
    }
    x.fillStyle = '#e8a33d';
    x.beginPath(); x.arc(64, 46, 17, 0, TAU_2); x.fill();
  },
  worm: (x) => {
    x.strokeStyle = '#c2707e'; x.lineWidth = 13; x.lineCap = 'round';
    x.beginPath();
    x.moveTo(28, 58);
    x.bezierCurveTo(44, 24, 62, 72, 78, 40);
    x.bezierCurveTo(86, 26, 96, 30, 100, 42);
    x.stroke();
  },
  crown: (x) => {
    x.fillStyle = '#e8a33d'; x.strokeStyle = INK; x.lineWidth = 5;
    x.beginPath();
    x.moveTo(28, 66); x.lineTo(34, 22); x.lineTo(50, 46); x.lineTo(64, 18);
    x.lineTo(78, 46); x.lineTo(94, 22); x.lineTo(100, 66);
    x.closePath(); x.fill(); x.stroke();
  },
};

function emoteTexture(paint) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d');
  // Thought bubble: one rounded cloud plus two trailing dots, drawn as
  // separate shapes so no outline ever cuts through another.
  x.fillStyle = CREAM; x.strokeStyle = INK; x.lineWidth = 6;
  x.beginPath(); x.arc(50, 100, 10, 0, TAU_2); x.fill(); x.stroke();
  x.beginPath(); x.arc(34, 118, 6, 0, TAU_2); x.fill(); x.stroke();
  roundRect(x, 8, 4, 112, 82, 26);
  x.fill(); x.stroke();
  paint(x);
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  return tex;
}

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
  // `rng` here is the COSMETIC stream, never the simulation's. Effects drop
  // draws when a pool is full (see feather/_sprite below), and pool occupancy
  // depends on the viewer's framerate — sharing the simulation RNG would make
  // two clients on the same seed consume it a different number of times and
  // drift apart within seconds.
  constructor(scene, rng) {
    this.scene = scene;
    this.rng = rng;
    this.feathers = [];
    this.sprites = [];   // puffs and Zs share the update path
    this.patches = [];
    this.puffTex = softCircleTexture();
    this.zTex = zTexture();

    // One shared material per icon: emote sprites animate by scale, never
    // opacity, so every chicken showing "!" can use the same material.
    this.emoteMats = {};
    for (const [name, paint] of Object.entries(ICONS)) {
      this.emoteMats[name] = new THREE.SpriteMaterial({
        map: emoteTexture(paint), transparent: true, depthWrite: false,
      });
    }
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

  zzz(pos, size = 0.16) {
    this._sprite(this.zTex, 0xffffff, pos,
      { grow: 0.12, rise: 0.32, life: 1.7, size, opacity: 0.9, wobble: true });
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

  // Seed patches are simulation state — chickens read patch.count — so they
  // are reaped from the tick, not from the render-rate visual update, which
  // would make the eviction in seeds() depend on framerate.
  reapPatches() {
    this.patches = this.patches.filter((p) => p.count > 0);
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
  }
}
