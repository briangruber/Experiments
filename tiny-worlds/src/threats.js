// What a dormant world throws at you.
//
// Two kinds, both living in a planet's local space alongside the keeper:
// meteors that fall out of the sky aiming roughly where you are standing, and
// gloom that patrol the surface and charge when you come near. Neither can
// kill you — getting hit knocks you off your feet and scatters a spark you
// already caught, which is a setback you can walk back and undo.
//
// Everything here goes quiet once the world blooms. That is the reward: the
// light drives the gloom off and the sky stops falling.

import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { rng, clamp, lerp, damp } from './noise.js';

const TAU = Math.PI * 2;
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _r = new THREE.Vector3();
const _f = new THREE.Vector3();

// A direction a given angle away from `dir`, in a random compass bearing.
export function offsetDir(dir, angle, bearing, out) {
  _v.set(0, 1, 0);
  if (Math.abs(dir.y) > 0.9) _v.set(1, 0, 0);
  _r.crossVectors(_v, dir).normalize();
  _f.crossVectors(dir, _r).normalize();
  return out.copy(dir).multiplyScalar(Math.cos(angle))
    .addScaledVector(_r, Math.sin(angle) * Math.cos(bearing))
    .addScaledVector(_f, Math.sin(angle) * Math.sin(bearing))
    .normalize();
}

// Orient an object so its local +Y is the surface normal and +Z faces `heading`.
function standOn(obj, planet, dir, heading, lift = 0) {
  planet.normalAt(dir, _v);
  _f.copy(heading).addScaledVector(_v, -heading.dot(_v));
  if (_f.lengthSq() < 1e-6) _f.set(0, 0, 1).cross(_v);
  _f.normalize();
  _r.crossVectors(_v, _f).normalize();
  _m.makeBasis(_r, _v, _f);
  obj.quaternion.setFromRotationMatrix(_m);
  obj.position.copy(dir).multiplyScalar(planet.groundRadius(dir) + lift);
}

// --------------------------------------------------------------- meteors

export class MeteorStorm {
  constructor(planet, opts = {}) {
    this.planet = planet;
    this.rand = rng(planet.def.seed + 8123);
    this.interval = opts.interval ?? 6;
    this.blast = opts.blast ?? 3.4;         // knockback radius on the surface
    this.fallTime = opts.fallTime ?? 2.6;   // seconds of warning
    this.timer = this.interval * 0.6;
    this.live = [];
    this.impacts = [];

    const rock = planet.assets.rock;
    this.rockGeo = rock.geometry;
    this.rockMat = rock.material.clone();
    this.rockMat.emissive = new THREE.Color(0xff6a22);
    this.rockMat.emissiveIntensity = 1.4;

  }

  // A ring that follows the ground. A flat disc laid tangent to a world this
  // small saws straight through the hills either side of it; this walks the
  // terrain height around the circle instead.
  capRing(centreDir, innerAngle, outerAngle, lift = 0.12, segments = 48) {
    const planet = this.planet;
    const pos = new Float32Array(segments * 6 * 3);
    const dirIn = new THREE.Vector3();
    const dirOut = new THREE.Vector3();
    const prevIn = new THREE.Vector3();
    const prevOut = new THREE.Vector3();
    const at = (dir, target) => target.copy(dir).multiplyScalar(planet.groundRadius(dir) + lift);
    let o = 0;
    for (let i = 0; i <= segments; i++) {
      const bearing = (i / segments) * TAU;
      offsetDir(centreDir, innerAngle, bearing, dirIn);
      offsetDir(centreDir, outerAngle, bearing, dirOut);
      const a = at(dirIn, new THREE.Vector3());
      const b = at(dirOut, new THREE.Vector3());
      if (i > 0) {
        for (const v of [prevIn, prevOut, a, prevOut, b, a]) {
          pos[o++] = v.x; pos[o++] = v.y; pos[o++] = v.z;
        }
      }
      prevIn.copy(a); prevOut.copy(b);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos.subarray(0, o), 3));
    return geo;
  }

  spawn(towardDir) {
    const planet = this.planet;
    const rand = this.rand;
    // Aimed near the keeper, but never exactly at them.
    const target = towardDir
      ? offsetDir(towardDir, this.blast * (0.7 + rand() * 1.3) / planet.def.radius, rand() * TAU, new THREE.Vector3())
      : new THREE.Vector3(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1).normalize();

    const rock = new THREE.Mesh(this.rockGeo, this.rockMat);
    rock.scale.setScalar(0.6 + rand() * 0.5);
    rock.castShadow = true;
    planet.group.add(rock);

    const angle = this.blast / planet.def.radius;
    const marker = new THREE.Mesh(
      this.capRing(target, angle * 0.74, angle),
      new THREE.MeshBasicMaterial({
        color: 0xff7a3a, transparent: true, opacity: 0, depthWrite: false,
        side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
      }),
    );
    planet.group.add(marker);

    const glow = new THREE.PointLight(0xff7a30, 0, 12, 2);
    planet.group.add(glow);

    this.live.push({
      rock, marker, glow, target, t: 0,
      from: offsetDir(target, 0.9 + rand() * 0.5, rand() * TAU, new THREE.Vector3())
        .multiplyScalar(planet.def.radius * 2.6),
      spin: new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).multiplyScalar(4),
    });
  }

  // `ctx` carries the things a planet has no business owning: particles, audio,
  // and the callback that tells the game somebody got hit.
  update(dt, time, player, ctx) {
    const planet = this.planet;
    const active = !planet.bloomed && ctx.active;

    if (active) {
      this.timer -= dt;
      if (this.timer <= 0) {
        this.timer = this.interval * (0.7 + this.rand() * 0.6);
        this.spawn(player?.planet === planet ? player.up : null);
      }
    }

    for (let i = this.live.length - 1; i >= 0; i--) {
      const m = this.live[i];
      m.t += dt / this.fallTime;
      const t = clamp(m.t, 0, 1);

      const land = _v.copy(m.target).multiplyScalar(planet.groundRadius(m.target));
      m.rock.position.lerpVectors(m.from, land, t * t);   // accelerating fall
      m.rock.rotation.x += m.spin.x * dt;
      m.rock.rotation.y += m.spin.y * dt;
      m.rock.rotation.z += m.spin.z * dt;

      m.marker.material.opacity = 0.3 + 0.5 * t * (0.6 + 0.4 * Math.sin(time * 14));
      m.glow.position.copy(m.rock.position);
      m.glow.intensity = 6 + 10 * t;

      if (ctx.active && t < 1) {
        planet.group.localToWorld(_w.copy(m.rock.position));
        ctx.particles.spawn(_w, _v.set((Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2),
          ctx.emberColor, 0.5, 0.7, { drag: 1.0 });
      }

      if (t >= 1) this.impact(m, player, ctx);
      if (t >= 1) {
        planet.group.remove(m.rock, m.marker, m.glow);
        m.marker.material.dispose();
        m.marker.geometry.dispose();
        this.live.splice(i, 1);
      }
    }

    // Expanding shock rings, purely decorative once the hit is resolved.
    for (let i = this.impacts.length - 1; i >= 0; i--) {
      const s = this.impacts[i];
      s.t += dt * 1.6;
      s.mesh.material.opacity = s.t < 0 ? 0 : Math.max(0, 0.8 * (1 - s.t));
      if (s.t >= 1) {
        planet.group.remove(s.mesh);
        s.mesh.material.dispose();
        s.mesh.geometry.dispose();
        this.impacts.splice(i, 1);
      }
    }
  }

  impact(m, player, ctx) {
    const planet = this.planet;
    const dir = m.target;
    planet.group.localToWorld(_w.copy(dir).multiplyScalar(planet.groundRadius(dir)));
    _v.copy(dir).transformDirection(planet.group.matrixWorld);

    ctx.particles.burst(_w, {
      count: 46, color: ctx.emberColor, speed: 9, size: 0.6, life: 1.3, up: _v,
    });
    ctx.audio?.impact();

    // Three rings at widening angles, revealed in turn, reads as a shockwave
    // without any geometry having to grow.
    const angle = this.blast / planet.def.radius;
    for (let i = 0; i < 3; i++) {
      const a0 = angle * (0.5 + i * 0.55);
      const shock = new THREE.Mesh(
        this.capRing(dir, a0, a0 + angle * 0.32, 0.16),
        new THREE.MeshBasicMaterial({
          color: 0xffb46a, transparent: true, opacity: 0, depthWrite: false,
          side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
        }),
      );
      planet.group.add(shock);
      this.impacts.push({ mesh: shock, t: -i * 0.28 });
    }

    // A scorched boulder stays behind, so a long visit leaves a marked world.
    const debris = new THREE.Mesh(this.rockGeo, planet.assets.rock.material);
    debris.scale.setScalar(0.45 + this.rand() * 0.3);
    standOn(debris, planet, dir, _f.set(1, 0, 0), -0.12);
    debris.castShadow = true;
    planet.group.add(debris);

    if (!ctx.active || !player || player.planet !== planet) return;
    const reach = player.up.angleTo(dir) * planet.groundRadius(dir);
    if (reach < this.blast) {
      const push = new THREE.Vector3().copy(player.up).sub(dir).normalize();
      if (push.lengthSq() < 1e-4) push.copy(player.facing);
      ctx.onHit?.({ push, strength: 1 - reach / this.blast, source: 'meteor' });
    }
  }
}

// ----------------------------------------------------------------- gloom

export class Gloom {
  constructor(planet, assets, count) {
    this.planet = planet;
    this.assets = assets;
    this.rand = rng(planet.def.seed + 5150);
    this.count = count;
    this.mobs = [];
    this.group = new THREE.Group();
    planet.group.add(this.group);
    for (let i = 0; i < count; i++) this.add();
  }

  add() {
    const planet = this.planet;
    const rand = this.rand;
    const src = this.assets.gloom;
    // Every gloom needs its own skeleton, so a plain clone will not do.
    const obj = src.rigged ? cloneSkinned(src.object) : src.object.clone(true);
    const height = 1.15 * (planet.def.radius / 11);
    obj.scale.setScalar(height);
    obj.rotation.y = src.faceOffset ?? 0;
    obj.traverse((o) => { if (o.isMesh || o.isSkinnedMesh) { o.castShadow = true; o.frustumCulled = false; } });

    const root = new THREE.Group();
    root.add(obj);
    this.group.add(root);

    // Kept away from the landing site: the first thing you see should not be
    // a monster standing on your beacon.
    let dir = null;
    for (let i = 0; i < 60 && !dir; i++) {
      const c = new THREE.Vector3(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1).normalize();
      if (c.angleTo(planet.landingDir) < 0.9) continue;
      if (planet.surfaceRadius(c) < planet.seaRadius + 0.2) continue;
      dir = c;
    }
    dir ||= offsetDir(planet.landingDir, 1.6, rand() * TAU, new THREE.Vector3());

    const mob = {
      root, obj, dir, height,
      heading: offsetDir(dir, Math.PI / 2, rand() * TAU, new THREE.Vector3()).sub(dir).normalize(),
      speed: 0, wander: rand() * TAU, wanderTimer: 0,
      state: 'patrol', cooldown: 0, bob: rand() * TAU, dead: 0, respawn: 0,
      mixer: null, actions: {},
    };
    // Heading has to be a tangent; derive it cleanly.
    mob.heading.copy(offsetDir(dir, 0.02, mob.wander, _w)).sub(dir).normalize();

    if (src.rigged && Object.keys(src.clips).length) {
      mob.mixer = new THREE.AnimationMixer(obj);
      for (const [name, clip] of Object.entries(src.clips)) {
        const action = mob.mixer.clipAction(clip);
        action.enabled = true;
        action.setEffectiveWeight(name === 'walk' ? 1 : 0);
        action.play();
        mob.actions[name] = action;
      }
      mob.current = 'walk';
    }

    standOn(root, planet, dir, mob.heading);
    this.mobs.push(mob);
    return mob;
  }

  setAnim(mob, name) {
    if (!mob.mixer || mob.current === name || !mob.actions[name]) return;
    mob.actions[name].reset().play().fadeIn(0.2);
    mob.actions[mob.current]?.fadeOut(0.2);
    mob.current = name;
  }

  update(dt, time, player, ctx) {
    const planet = this.planet;
    const chasing = ctx.active && !planet.bloomed && player && player.planet === planet;
    const scale = planet.def.radius / 11;

    for (const mob of this.mobs) {
      if (mob.dead > 0) {
        mob.dead -= dt;
        if (mob.dead <= 0 && !planet.bloomed && ctx.active) {
          // Comes back somewhere else entirely, not where you left it.
          mob.dir.copy(offsetDir(planet.landingDir, 1.2 + this.rand() * 1.6, this.rand() * TAU, _w));
          mob.root.visible = true;
          mob.state = 'patrol';
        }
        continue;
      }
      if (planet.bloomed && mob.root.visible) {
        // The bloom clears them out — one puff each, then gone for good.
        planet.group.localToWorld(_w.copy(mob.root.position));
        ctx.particles.burst(_w, { count: 18, color: ctx.gloomColor, speed: 3.5, size: 0.5, life: 0.9 });
        mob.root.visible = false;
        continue;
      }
      if (!mob.root.visible) continue;

      mob.cooldown = Math.max(0, mob.cooldown - dt);
      const toPlayer = chasing ? player.up.angleTo(mob.dir) * planet.groundRadius(mob.dir) : Infinity;

      if (chasing && toPlayer < 7 * scale) {
        mob.state = 'chase';
        // Head straight at the keeper along the surface.
        _v.copy(player.up).addScaledVector(mob.dir, -player.up.dot(mob.dir));
        if (_v.lengthSq() > 1e-6) mob.heading.copy(_v.normalize());
        mob.speed = damp(mob.speed, 4.6 * scale, 3, dt);
      } else {
        mob.state = 'patrol';
        mob.wanderTimer -= dt;
        if (mob.wanderTimer <= 0) {
          mob.wanderTimer = 2 + this.rand() * 3;
          mob.wander += (this.rand() - 0.5) * 2.2;
          _v.copy(offsetDir(mob.dir, 0.05, mob.wander, _w)).sub(mob.dir);
          if (_v.lengthSq() > 1e-6) mob.heading.copy(_v.normalize());
        }
        mob.speed = damp(mob.speed, 1.5 * scale, 2, dt);
      }

      // Walk along the surface: step, then re-project onto the sphere.
      _v.copy(mob.dir).multiplyScalar(planet.groundRadius(mob.dir)).addScaledVector(mob.heading, mob.speed * dt);
      mob.dir.copy(_v).normalize();
      // Keep the heading tangent after the step, or it slowly tips into the ground.
      mob.heading.addScaledVector(mob.dir, -mob.heading.dot(mob.dir));
      if (mob.heading.lengthSq() > 1e-6) mob.heading.normalize();
      // Turn back at the waterline rather than wading out to sea.
      if (planet.surfaceRadius(mob.dir) < planet.seaRadius + 0.05) {
        mob.heading.negate();
        mob.wander += Math.PI;
      }

      const hover = Math.sin(time * 3 + mob.bob) * 0.05 * scale;
      standOn(mob.root, planet, mob.dir, mob.heading, hover);
      this.setAnim(mob, mob.state === 'chase' ? 'walk' : 'idle');
      if (mob.mixer) {
        if (mob.actions.walk) mob.actions.walk.setEffectiveTimeScale(mob.state === 'chase' ? 1.7 : 1);
        mob.mixer.update(dt);
      }

      if (!chasing || mob.cooldown > 0) continue;

      // Contact. Coming down on one from above dispels it; anything else is a
      // hit on the keeper.
      const gap = player.local.distanceTo(mob.root.position);
      if (gap > 1.15 * scale + 0.5) continue;

      const falling = player.vel.dot(player.up) < -1.5;
      const above = player.local.length() > mob.root.position.length() + 0.45 * scale;
      planet.group.localToWorld(_w.copy(mob.root.position));
      if (!player.grounded && falling && above) {
        ctx.particles.burst(_w, { count: 26, color: ctx.gloomColor, speed: 4.5, size: 0.55, life: 1.0 });
        ctx.audio?.stomp();
        mob.root.visible = false;
        mob.dead = 14;
        mob.speed = 0;
        ctx.onStomp?.(_w.clone());
      } else {
        _v.copy(player.up).sub(mob.dir).normalize();
        if (_v.lengthSq() < 1e-4) _v.copy(player.facing);
        mob.cooldown = 1.6;
        ctx.onHit?.({ push: _v.clone(), strength: 0.8, source: 'gloom' });
      }
    }
  }
}
