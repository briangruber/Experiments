// The loop: find a shoal, cast, hook it, fight it in, run the catch back to
// the Salty Fin and sell it. Everything here is state - the drawing is done by
// main.js from what these objects expose.

import { mulberry32, clamp, lerp, smoothstep } from '../src/math.js';
import { bedHeight } from './world.js';
import { SPECIES, pickSpecies, waveHeight, trs } from './boat.js';

export const HOLD_LIMIT = 8;
export const GOAL = 400;

const rand = mulberry32(90210);

// ---------------------------------------------------------------- particles
export class Particles {
  constructor(max = 900) {
    this.p = [];
    this.max = max;
  }
  emit(x, y, z, vx, vy, vz, life, size, col, gravity = -6.5) {
    if (this.p.length >= this.max) return;
    this.p.push({ x, y, z, vx, vy, vz, life, maxLife: life, size, col, g: gravity });
  }
  splash(x, y, z, power, col = [1.4, 1.7, 1.85]) {
    const n = Math.min(26, 6 + Math.round(power * 12));
    for (let i = 0; i < n; i++) {
      const a = rand() * 6.283, s = (0.6 + rand() * 1.5) * power;
      this.emit(
        x + Math.cos(a) * 0.15, y + 0.05, z + Math.sin(a) * 0.15,
        Math.cos(a) * s, 1.4 + rand() * 2.6 * power, Math.sin(a) * s,
        0.45 + rand() * 0.5, 0.10 + rand() * 0.15, col,
      );
    }
  }
  update(dt) {
    for (let i = this.p.length - 1; i >= 0; i--) {
      const q = this.p[i];
      q.life -= dt;
      if (q.life <= 0) { this.p.splice(i, 1); continue; }
      q.vy += q.g * dt;
      q.x += q.vx * dt; q.y += q.vy * dt; q.z += q.vz * dt;
      q.vx *= 1 - dt * 1.2; q.vz *= 1 - dt * 1.2;
    }
  }
  draw(renderer) {
    for (const q of this.p) {
      const t = q.life / q.maxLife;
      const a = smoothstep(0, 0.35, t) * 0.9;
      renderer.sprite(q.x, q.y, q.z, q.size * (0.6 + t * 0.7), q.col[0], q.col[1], q.col[2], a);
    }
  }
}

// ---------------------------------------------------------------- shoals
function validSpot(x, z, world) {
  const y = bedHeight(x, z);
  if (y > -3.0 || y < -16) return false;
  for (const o of world.obstacles) if (Math.hypot(x - o.x, z - o.z) < o.r + 8) return false;
  return true;
}

export class Shoal {
  constructor(x, z, world) {
    this.reset(x, z, world);
  }
  reset(x, z) {
    this.x = x; this.z = z;
    this.bed = bedHeight(x, z);
    this.r = 7.0;
    this.depthBonus = clamp((-this.bed - 3) / 12, 0, 1);
    this.stock = 3 + Math.floor(rand() * 3);
    this.phase = rand() * 6.283;
    this.fish = [];
    const n = 5 + Math.floor(rand() * 4);
    for (let i = 0; i < n; i++) {
      this.fish.push({
        sp: pickSpecies(rand, this.depthBonus),
        a: rand() * 6.283,
        rad: 1.4 + rand() * 3.4,
        depth: 0.7 + rand() * Math.min(2.2, -this.bed - 1.0),
        speed: 0.35 + rand() * 0.4,
        bob: rand() * 6.283,
      });
    }
    this.alive = true;
    this.fade = 0;
  }
  update(dt, t) {
    this.fade = lerp(this.fade, this.alive ? 1 : 0, 1 - Math.exp(-dt * 2));
    for (const f of this.fish) f.a += f.speed * dt * (this.alive ? 1 : 2.2);
    this.phase += dt;
  }
  // where the fish actually are, for drawing
  fishTransform(f, t) {
    const x = this.x + Math.cos(f.a) * f.rad;
    const z = this.z + Math.sin(f.a) * f.rad;
    const y = -f.depth + Math.sin(t * 1.3 + f.bob) * 0.12;
    return trs([x, y, z], -f.a + Math.PI / 2, Math.sin(t * 2 + f.bob) * 0.12, Math.sin(t * 3 + f.bob) * 0.2, f.sp.size / 0.4);
  }
}

export function makeShoals(world, n = 9) {
  const out = [];
  let guard = 0;
  while (out.length < n && guard++ < 4000) {
    const a = rand() * 6.283, d = 22 + rand() * 130;
    const x = Math.cos(a) * d + 10, z = Math.sin(a) * d - 10;
    if (!validSpot(x, z, world)) continue;
    if (out.some((s) => Math.hypot(s.x - x, s.z - z) < 34)) continue;
    out.push(new Shoal(x, z, world));
  }
  return out;
}

// ---------------------------------------------------------------- gulls
export class Gull {
  constructor(cx, cz, r, h, speed, seed) {
    this.cx = cx; this.cz = cz; this.r = r; this.h = h;
    this.speed = speed; this.a = seed * 6.283;
    this.flap = seed * 3;
  }
  update(dt, t) {
    this.a += this.speed * dt / Math.max(this.r, 4);
    this.flap += dt * (5.5 + Math.sin(t * 0.7 + this.cx) * 1.5);
    this.x = this.cx + Math.cos(this.a) * this.r;
    this.z = this.cz + Math.sin(this.a) * this.r;
    this.y = this.h + Math.sin(t * 0.8 + this.a * 2) * 0.9;
    this.yaw = -this.a + Math.PI / 2;
    this.bank = 0.34;
    this.wing = Math.sin(this.flap) * 0.75;
  }
}

// ---------------------------------------------------------------- fishing
export const ST = {
  IDLE: 'idle', CAST: 'cast', WAIT: 'wait', BITE: 'bite',
  FIGHT: 'fight', LANDED: 'landed', LOST: 'lost',
};

export class Fishing {
  constructor(particles) {
    this.fx = particles;
    this.state = ST.IDLE;
    this.t = 0;
    this.hold = [];
    this.coins = 0;
    this.best = null;
    this.shoal = null;
    this.bobber = { x: 0, y: 0, z: 0, active: false };
    this.rodBend = 0;
    this.rodSwing = 0;
    this.progress = 0;
    this.tension = 0;
    this.hookY = 0.5; this.hookV = 0;
    this.fishY = 0.5; this.fishV = 0;
    this.toast = null;
    this.card = null;
    this.sold = 0;
    this.caughtSp = null;
    this.caughtWeight = 0;
  }

  get canCast() { return this.state === ST.IDLE && this.hold.length < HOLD_LIMIT; }

  cast(boat, shoal) {
    this.shoal = shoal;
    this.state = ST.CAST;
    this.t = 0;
    // land the bobber between the boat and the middle of the shoal
    const dx = shoal.x - boat.x, dz = shoal.z - boat.z;
    const d = Math.max(1e-3, Math.hypot(dx, dz));
    const reach = clamp(d * 0.95, 6.5, 11.0);
    this.castFrom = boat.localToWorld([0.62, 1.9, -0.15]);
    this.castTo = [boat.x + (dx / d) * reach, 0, boat.z + (dz / d) * reach];
    this.bobber.active = true;
  }

  hook() {
    if (this.state !== ST.BITE) return false;
    this.state = ST.FIGHT;
    this.t = 0;
    this.progress = 0.32;
    this.tension = 0;
    this.hookY = 0.5; this.hookV = 0;
    this.fishY = 0.55; this.fishV = 0;
    const sp = pickSpecies(rand, this.shoal.depthBonus);
    this.caughtSp = sp;
    this.caughtWeight = +(sp.size * (4 + rand() * 6)).toFixed(1);
    this.fight = {
      // heavier fish move further and change direction more often
      wander: 0.35 + sp.value / 160,
      dodge: 0.8 + sp.value / 90,
      drain: 0.30 + sp.value / 420,
    };
    this.fx.splash(this.bobber.x, 0, this.bobber.z, 0.7);
    return true;
  }

  update(dt, boat, input, t) {
    this.t += dt;
    const b = this.bobber;

    switch (this.state) {
      case ST.CAST: {
        const k = clamp(this.t / 0.62, 0, 1);
        this.rodSwing = Math.sin(k * Math.PI) * 0.9 - k * 0.25;
        const e = clamp((this.t - 0.18) / 0.44, 0, 1);
        b.x = lerp(this.castFrom[0], this.castTo[0], e);
        b.z = lerp(this.castFrom[2], this.castTo[2], e);
        b.y = lerp(this.castFrom[1], 0, e) + Math.sin(e * Math.PI) * 1.9;
        if (e >= 1) {
          this.fx.splash(b.x, 0, b.z, 0.55);
          this.state = ST.WAIT;
          this.t = 0;
          this.waitFor = 1.1 + rand() * 3.0;
          this.nibble = 0;
        }
        break;
      }
      case ST.WAIT: {
        this.rodSwing = lerp(this.rodSwing, 0, 1 - Math.exp(-dt * 4));
        b.y = waveHeight(b.x, b.z, t) + Math.sin(t * 2.2) * 0.02;
        // a couple of teasing nibbles before the real take
        if (this.t > this.waitFor * 0.55 && rand() < dt * 0.7) {
          this.nibble = 0.22;
          this.fx.splash(b.x, 0, b.z, 0.18);
        }
        if (this.nibble > 0) { this.nibble -= dt; b.y -= 0.09; }
        if (this.t >= this.waitFor) {
          this.state = ST.BITE; this.t = 0;
          this.fx.splash(b.x, 0, b.z, 0.35);
        }
        break;
      }
      case ST.BITE: {
        b.y = waveHeight(b.x, b.z, t) - 0.16 - Math.abs(Math.sin(this.t * 16)) * 0.1;
        this.rodBend = lerp(this.rodBend, 0.25, 1 - Math.exp(-dt * 8));
        if (this.t > 1.05) { this.lose('It shook the hook.'); }
        break;
      }
      case ST.FIGHT: {
        const f = this.fight;
        // the fish marker wanders; holding space lifts the hook window
        this.fishV += (Math.sin(t * 3.1) * 0.6 + (rand() - 0.5) * f.dodge * 6) * dt;
        this.fishV *= 1 - dt * 2.2;
        this.fishY = clamp(this.fishY + this.fishV * dt * f.wander * 3.4, 0.06, 0.94);
        if (this.fishY <= 0.06 || this.fishY >= 0.94) this.fishV *= -0.6;

        this.hookV += (input.reel ? 1.55 : -1.35) * dt;
        this.hookV *= 1 - dt * 3.0;
        this.hookY = clamp(this.hookY + this.hookV * dt * 2.6, 0.05, 0.95);
        if (this.hookY <= 0.05 || this.hookY >= 0.95) this.hookV *= -0.25;

        const on = Math.abs(this.hookY - this.fishY) < 0.115;
        this.progress = clamp(this.progress + (on ? 0.30 : -f.drain) * dt, 0, 1.001);
        this.tension = lerp(this.tension, on ? 1 : 0, 1 - Math.exp(-dt * 6));
        this.rodBend = lerp(this.rodBend, 0.35 + this.tension * 0.5, 1 - Math.exp(-dt * 7));

        // the bobber gets dragged around while the fight runs
        const a = t * 2.4;
        b.x += Math.cos(a) * dt * 0.9 * (1 - this.tension * 0.4);
        b.z += Math.sin(a * 1.3) * dt * 0.9;
        b.y = waveHeight(b.x, b.z, t) - 0.12 - this.tension * 0.1;
        if (rand() < dt * 5) this.fx.splash(b.x, 0, b.z, 0.12);

        if (this.progress >= 1) this.land(boat);
        else if (this.progress <= 0) this.lose('The line went slack.');
        else if (this.t > 26) this.lose('It ran you out of line.');
        break;
      }
      case ST.LANDED: {
        // fish arcs out of the water and into the boat
        const k = clamp(this.t / 0.85, 0, 1);
        const to = boat.localToWorld([0, 0.55, -0.5]);
        this.fishPos = [
          lerp(this.landFrom[0], to[0], k),
          lerp(this.landFrom[1], to[1], k) + Math.sin(k * Math.PI) * 2.3,
          lerp(this.landFrom[2], to[2], k),
        ];
        this.fishSpin = k * 9;
        this.rodBend = lerp(this.rodBend, 0, 1 - Math.exp(-dt * 5));
        if (this.t > 1.6) { this.state = ST.IDLE; this.bobber.active = false; this.card = null; }
        break;
      }
      case ST.LOST: {
        this.rodBend = lerp(this.rodBend, 0, 1 - Math.exp(-dt * 6));
        if (this.t > 1.1) { this.state = ST.IDLE; this.bobber.active = false; }
        break;
      }
      default:
        this.rodBend = lerp(this.rodBend, 0, 1 - Math.exp(-dt * 4));
        this.rodSwing = lerp(this.rodSwing, 0, 1 - Math.exp(-dt * 4));
        break;
    }
  }

  land(boat) {
    this.state = ST.LANDED;
    this.t = 0;
    this.landFrom = [this.bobber.x, 0, this.bobber.z];
    this.fx.splash(this.bobber.x, 0, this.bobber.z, 1.5);
    const sp = this.caughtSp;
    this.hold.push({ sp, weight: this.caughtWeight });
    if (!this.best || sp.value * this.caughtWeight > this.best.value * this.best.weight) {
      this.best = { name: sp.name, value: sp.value, weight: this.caughtWeight };
    }
    this.card = { name: sp.name, weight: this.caughtWeight, value: sp.value, col: sp.col, at: performance.now() };
    if (this.shoal) {
      this.shoal.stock--;
      if (this.shoal.stock <= 0) this.shoal.alive = false;
    }
    this.toast = { text: `${sp.name} · ${this.caughtWeight}kg`, at: performance.now(), good: true };
  }

  lose(why) {
    this.state = ST.LOST;
    this.t = 0;
    this.toast = { text: why, at: performance.now(), good: false };
  }

  sell() {
    if (!this.hold.length) return 0;
    let total = 0;
    for (const f of this.hold) total += Math.round(f.sp.value * (0.6 + f.weight / 8));
    this.coins += total;
    this.sold += this.hold.length;
    this.hold.length = 0;
    this.toast = { text: `Sold for ${total} coins`, at: performance.now(), good: true };
    return total;
  }
}
