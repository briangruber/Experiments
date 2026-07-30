// Pooled, cheap atmosphere: ripple rings, splash droplets, catch sparkles,
// drifting golden motes, chimney smoke, and the stretched light streaks
// that lanterns and windows lay on the water.

import * as THREE from 'three';
import { rand } from '../core/utils.js';

export function createEffects(scene, heightAt) {
  const fx = new THREE.Group();
  fx.name = 'effects';
  scene.add(fx);

  // --- ripple rings -------------------------------------------------------
  const ripples = [];
  {
    const geo = new THREE.RingGeometry(0.92, 1.0, 48).rotateX(-Math.PI / 2);
    for (let i = 0; i < 14; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffe9cd, transparent: true, opacity: 0, depthWrite: false,
      });
      const m = new THREE.Mesh(geo, mat);
      m.visible = false;
      fx.add(m);
      ripples.push({ m, life: 0, dur: 1, size: 1, x: 0, z: 0 });
    }
  }
  function ripple(x, z, size = 1) {
    const r = ripples.find((r) => !r.m.visible) || ripples[0];
    Object.assign(r, { life: 0, dur: 1.1 + size * 0.3, size, x, z });
    r.m.visible = true;
  }

  // --- splash droplets & sparkles ----------------------------------------
  function makeBurst(geo, color, count, { additive = false } = {}) {
    const mat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.95, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    const pool = [];
    for (let i = 0; i < count; i++) {
      const m = new THREE.Mesh(geo, mat);
      m.visible = false;
      fx.add(m);
      pool.push({ m, vel: new THREE.Vector3(), life: 0, dur: 1, spin: 0 });
    }
    return pool;
  }
  const drops = makeBurst(new THREE.IcosahedronGeometry(0.045), 0xf3e6d0, 26);
  const sparks = makeBurst(new THREE.OctahedronGeometry(0.06), 0xffd98c, 20, { additive: true });

  function burst(pool, x, y, z, n, up, spread, dur) {
    let used = 0;
    for (const p of pool) {
      if (p.m.visible) continue;
      p.m.visible = true;
      p.m.position.set(x + rand(-0.06, 0.06), y, z + rand(-0.06, 0.06));
      p.vel.set(rand(-spread, spread), rand(up * 0.55, up), rand(-spread, spread));
      p.life = 0;
      p.dur = dur * rand(0.7, 1.15);
      p.spin = rand(-6, 6);
      if (++used >= n) break;
    }
  }
  const splash = (x, z, strength = 1) => {
    const y = heightAt(x, z, tNow) + 0.05;
    burst(drops, x, y, z, Math.round(7 * strength), 2.6 * strength, 1.1 * strength, 0.65);
  };
  const sparkle = (pos, n = 10) => burst(sparks, pos.x, pos.y, pos.z, n, 1.6, 1.3, 0.9);

  // --- golden motes over the water by the dock ---------------------------
  const MOTES = 60;
  let motesGeo;
  {
    motesGeo = new THREE.BufferGeometry();
    const pos = new Float32Array(MOTES * 3);
    motesGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.PointsMaterial({
      color: 0xffd9a0, size: 0.075, transparent: true, opacity: 0.55,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
    });
    const pts = new THREE.Points(motesGeo, mat);
    pts.frustumCulled = false;
    fx.add(pts);
  }
  const motes = Array.from({ length: MOTES }, () => ({
    x: rand(-10, 8), y: rand(0.4, 3.4), z: rand(-16, 2),
    ph: rand(Math.PI * 2), sp: rand(0.05, 0.22),
  }));

  // --- light streaks on the water ----------------------------------------
  const streakTex = (() => {
    const c = document.createElement('canvas');
    c.width = 32; c.height = 256;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, 'rgba(255,255,255,0.95)');
    grad.addColorStop(0.5, 'rgba(255,255,255,0.28)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 32, 256);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  })();
  const streaks = [];
  // anchor: { x, z, color, w, len }  — glow source sitting at (x, z),
  // smearing toward the camera (+z).
  function addStreak({ x, z, color = 0xffca70, w = 0.5, len = 5 }) {
    const mat = new THREE.MeshBasicMaterial({
      map: streakTex, color, transparent: true, opacity: 0.42,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, len).rotateX(-Math.PI / 2), mat);
    m.position.set(x, 0.22, z + len / 2);
    m.renderOrder = 1;
    fx.add(m);
    streaks.push({ m, ph: rand(Math.PI * 2), base: 0.42 });
  }

  // --- chimney smoke ------------------------------------------------------
  const smokes = [];
  function addSmoke(x, y, z) {
    for (let i = 0; i < 5; i++) {
      const mat = new THREE.MeshLambertMaterial({
        color: 0xcabcd0, transparent: true, opacity: 0, fog: true,
      });
      const m = new THREE.Mesh(new THREE.SphereGeometry(0.16, 7, 5), mat);
      fx.add(m);
      smokes.push({ m, x, y, z, ph: (i / 5) * 1, sp: rand(0.85, 1.1) });
    }
  }

  // --- update -------------------------------------------------------------
  let tNow = 0;
  function update(dt, t) {
    tNow = t;

    for (const r of ripples) {
      if (!r.m.visible) continue;
      r.life += dt;
      const k = r.life / r.dur;
      if (k >= 1) { r.m.visible = false; continue; }
      const s = 0.25 + k * 2.6 * r.size;
      r.m.scale.set(s, 1, s);
      r.m.position.set(r.x, heightAt(r.x, r.z, t) + 0.05, r.z);
      r.m.material.opacity = 0.55 * (1 - k) * (1 - k);
    }

    for (const pool of [drops, sparks]) {
      for (const p of pool) {
        if (!p.m.visible) continue;
        p.life += dt;
        const k = p.life / p.dur;
        if (k >= 1) { p.m.visible = false; continue; }
        p.vel.y -= 6.5 * dt;
        p.m.position.addScaledVector(p.vel, dt);
        p.m.rotation.y += p.spin * dt;
        p.m.scale.setScalar(1 - k * k);
      }
    }

    const pos = motesGeo.attributes.position.array;
    for (let i = 0; i < MOTES; i++) {
      const mo = motes[i];
      pos[i * 3] = mo.x + Math.sin(t * mo.sp + mo.ph) * 0.9;
      pos[i * 3 + 1] = mo.y + Math.sin(t * mo.sp * 1.7 + mo.ph * 2.0) * 0.35;
      pos[i * 3 + 2] = mo.z + Math.cos(t * mo.sp * 0.8 + mo.ph) * 0.9;
    }
    motesGeo.attributes.position.needsUpdate = true;

    for (const s of streaks) {
      s.m.material.opacity = s.base * (0.85 + 0.15 * Math.sin(t * 1.4 + s.ph));
      s.m.scale.x = 1 + 0.18 * Math.sin(t * 1.1 + s.ph * 2.0);
    }

    for (const s of smokes) {
      const k = ((t * 0.14 * s.sp) + s.ph) % 1;
      s.m.position.set(
        s.x + Math.sin(k * 5 + s.ph * 9) * 0.22 + k * 0.5,
        s.y + k * 2.2,
        s.z + Math.cos(k * 4 + s.ph * 7) * 0.14
      );
      s.m.scale.setScalar(0.5 + k * 1.7);
      s.m.material.opacity = 0.3 * Math.sin(Math.PI * Math.min(k * 1.6, 1));
    }
  }

  return { update, ripple, splash, sparkle, addStreak, addSmoke };
}
