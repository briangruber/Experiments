import * as THREE from 'three';
import { waterHeight } from '/shared/waves.js';
import { seabedHeight } from '/shared/seabed.js';
import { rollSpecies, rollWeight, fishValue, waterAt } from '/shared/fish.js';

// The fishing mini-game.
//
// Three separate skills, in order:
//   1. Placing the cast. Power is a held charge; the float has to land in water
//      deep enough to hold fish.
//   2. Reading the take. The float twitches several times before it goes under
//      for real. Strike on a twitch and you spook the fish; strike late and it
//      spits the hook. The tell is the size of the dip.
//   3. Playing the fish. Holding the reel gains line but loads the rod. The
//      fish runs in bursts, telegraphed half a second early, and the line parts
//      at full tension. Reeling with the tension high gains line much faster,
//      so the skilful play is to sit just under the limit and back off the
//      instant it bolts.

export const PHASE = {
  IDLE: 'idle',
  CAST: 'cast',        // winding up
  FLY: 'fly',          // float in the air
  WAIT: 'wait',        // float down, nothing yet
  NIBBLE: 'nibble',    // twitching -- a strike now is a mistake
  BITE: 'bite',        // the real take, strike window open
  FIGHT: 'fight',
  LANDED: 'landed',
  LOST: 'lost',
};

const CAST_TIME = 1.1;          // seconds to a full-power cast
const MIN_RANGE = 6;
const MAX_RANGE = 34;
const STRIKE_WINDOW = 0.62;     // how long the bite stays hookable
const TENSION_MAX = 100;

const _v = new THREE.Vector3();

function buildFloat() {
  const g = new THREE.Group();
  const top = new THREE.Mesh(
    new THREE.SphereGeometry(0.16, 10, 8),
    new THREE.MeshStandardMaterial({ color: 0xd8503f, roughness: 0.55, flatShading: true })
  );
  const bottom = new THREE.Mesh(
    new THREE.SphereGeometry(0.15, 10, 8),
    new THREE.MeshStandardMaterial({ color: 0xf2ece0, roughness: 0.6, flatShading: true })
  );
  bottom.position.y = -0.14;
  bottom.scale.y = 1.3;
  const stem = new THREE.Mesh(
    new THREE.CylinderGeometry(0.02, 0.02, 0.5, 5),
    new THREE.MeshStandardMaterial({ color: 0xe8e0cf })
  );
  stem.position.y = 0.3;
  g.add(top, bottom, stem);
  return g;
}

/** The dark shape that drifts up to the bait — the reason clear water matters. */
function buildShadow() {
  const geo = new THREE.CircleGeometry(1, 18);
  const mat = new THREE.MeshBasicMaterial({
    color: 0x05131c, transparent: true, opacity: 0.34, depthWrite: false,
  });
  const m = new THREE.Mesh(geo, mat);
  m.rotation.x = -Math.PI / 2;
  m.scale.set(1, 1, 2.1);
  return m;
}

export class Fishing {
  /**
   * @param {THREE.Scene} scene
   * @param {object} hooks onCatch({species, kg, value}), onLost(reason),
   *                       onPhase(phase), onSplash(pos, strength), onSfx(name)
   */
  constructor(scene, hooks = {}) {
    this.scene = scene;
    this.hooks = hooks;
    this.phase = PHASE.IDLE;
    this.charge = 0;
    this.timer = 0;

    this.float = buildFloat();
    this.float.visible = false;
    scene.add(this.float);

    this.shadow = buildShadow();
    this.shadow.visible = false;
    scene.add(this.shadow);

    // The line is drawn as a thin ribbon from rod tip to float.
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3 * 24), 3));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
    this.line = new THREE.Line(g, new THREE.LineBasicMaterial({
      color: 0xe8f0f4, transparent: true, opacity: 0.55,
    }));
    this.line.frustumCulled = false;
    this.line.visible = false;
    scene.add(this.line);

    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.fish = null;
    this.ripples = [];
  }

  get active() { return this.phase !== PHASE.IDLE; }
  get fighting() { return this.phase === PHASE.FIGHT; }

  setPhase(p) {
    this.phase = p;
    this.hooks.onPhase?.(p);
  }

  /* --------------------------------------------------------------- input */

  beginCast() {
    if (this.phase !== PHASE.IDLE) return false;
    this.setPhase(PHASE.CAST);
    this.charge = 0;
    return true;
  }

  /** Release the cast. `origin` is the rod tip, `dir` the way we are facing. */
  releaseCast(origin, dir) {
    if (this.phase !== PHASE.CAST) return;
    const range = MIN_RANGE + (MAX_RANGE - MIN_RANGE) * this.charge;
    this.pos.copy(origin);
    this.vel.copy(dir).setY(0).normalize().multiplyScalar(range * 0.62);
    this.vel.y = 5.2 + this.charge * 3.4;
    this.float.visible = true;
    this.line.visible = true;
    this.setPhase(PHASE.FLY);
    this.hooks.onSfx?.('cast');
    this.charge = 0;
  }

  /**
   * The one button that means "act now": sets the hook during the take, and is
   * a mistake at any other time.
   */
  strike() {
    if (this.phase === PHASE.BITE) {
      this.hookUp();
      return 'hooked';
    }
    if (this.phase === PHASE.NIBBLE) {
      this.spook('You struck at a nibble — it is gone');
      return 'early';
    }
    if (this.phase === PHASE.WAIT) {
      this.reelIn();
      return 'reeled';
    }
    return null;
  }

  reelIn() {
    if (this.phase === PHASE.IDLE) return;
    this.stop();
  }

  stop() {
    this.float.visible = false;
    this.line.visible = false;
    this.shadow.visible = false;
    this.fish = null;
    this.setPhase(PHASE.IDLE);
  }

  /* -------------------------------------------------------------- states */

  spook(reason) {
    this.hooks.onLost?.(reason);
    this.hooks.onSfx?.('spook');
    this.stop();
  }

  hookUp() {
    const f = this.fish;
    this.fish = {
      ...f,
      line: 100,              // metres of it still out there
      tension: 0,
      running: false,
      runTimer: 1.2 + Math.random() * 1.5,
      telegraph: 0,
      staminaLeft: f.species.stamina,
    };
    this.setPhase(PHASE.FIGHT);
    this.hooks.onSfx?.('hook');
  }

  /* --------------------------------------------------------------- frame */

  /**
   * @param {object} ctx { rodTip: Vector3, facing: Vector3, reeling: bool,
   *                       townDistance: number, time: number }
   */
  update(dt, ctx) {
    const { rodTip, time } = ctx;

    if (this.phase === PHASE.CAST) {
      this.charge = Math.min(1, this.charge + dt / CAST_TIME);
    }

    if (this.phase === PHASE.FLY) {
      this.vel.y -= 14 * dt;
      this.pos.addScaledVector(this.vel, dt);
      const wy = waterHeight(this.pos.x, this.pos.z, time);
      if (this.pos.y <= wy) {
        this.pos.y = wy;
        const bed = seabedHeight(this.pos.x, this.pos.z);
        if (wy - bed < 0.9) {
          // Landed on the sand or a rock: nothing lives there.
          this.hooks.onSplash?.(this.pos, 0.4);
          this.spook('Too shallow — nothing there but sand');
        } else {
          this.hooks.onSplash?.(this.pos, 0.5);
          this.hooks.onSfx?.('plop');
          this.startWaiting(ctx);
        }
      }
    }

    if (this.phase === PHASE.WAIT || this.phase === PHASE.NIBBLE || this.phase === PHASE.BITE) {
      this.timer -= dt;
      this.updateApproach(dt, ctx);
    }

    if (this.phase === PHASE.FIGHT) this.updateFight(dt, ctx);

    // Float motion: rides the swell, dips when something is interested.
    if (this.float.visible) {
      const wy = waterHeight(this.pos.x, this.pos.z, time);
      let dip = 0;
      if (this.phase === PHASE.NIBBLE) dip = Math.max(0, Math.sin(this.timer * 22)) * 0.12;
      if (this.phase === PHASE.BITE) dip = 0.55;
      if (this.phase === PHASE.FIGHT) {
        dip = 0.35 + this.fish.tension / TENSION_MAX * 0.3;
      }
      const y = this.phase === PHASE.FLY ? this.pos.y : wy - dip;
      this.float.position.set(this.pos.x, y, this.pos.z);
      this.float.rotation.z = Math.sin(time * 1.7) * 0.12 + dip * 0.5;
    }

    this.updateLine(rodTip);
  }

  startWaiting(ctx) {
    const species = rollSpecies(waterAt(ctx.townDistance));
    const kg = rollWeight(species);
    this.fish = { species, kg };
    // Bigger fish are warier: they take longer to commit.
    this.timer = 2.2 + Math.random() * 5 + species.stamina * 0.2;
    this.nibblesLeft = 1 + Math.floor(Math.random() * 3);
    this.setPhase(PHASE.WAIT);
    this.shadow.visible = false;
  }

  updateApproach(dt, ctx) {
    const size = this.fish ? this.fish.kg : 1;

    if (this.phase === PHASE.WAIT && this.timer <= 0) {
      // The shape arrives before the take — visible if the water is clear.
      this.setPhase(PHASE.NIBBLE);
      this.timer = 0.5 + Math.random() * 0.7;
      this.hooks.onSfx?.('nibble');
    } else if (this.phase === PHASE.NIBBLE && this.timer <= 0) {
      if (this.nibblesLeft-- > 0 && Math.random() < 0.6) {
        this.setPhase(PHASE.WAIT);
        this.timer = 0.8 + Math.random() * 2.4;
      } else {
        this.setPhase(PHASE.BITE);
        this.timer = STRIKE_WINDOW;
        this.hooks.onSfx?.('bite');
      }
    } else if (this.phase === PHASE.BITE && this.timer <= 0) {
      this.spook('It took the bait and left');
    }

    // Shadow circling under the float. This is the payoff for clear water.
    const shown = this.phase !== PHASE.WAIT || this.timer < 1.6;
    this.shadow.visible = shown && ctx.townDistance < 700;
    if (this.shadow.visible) {
      const bed = seabedHeight(this.pos.x, this.pos.z);
      const swing = this.phase === PHASE.BITE ? 0.4 : 1.6;
      const a = ctx.time * (this.phase === PHASE.NIBBLE ? 1.9 : 0.9);
      this.shadow.position.set(
        this.pos.x + Math.cos(a) * swing,
        Math.max(bed + 0.12, this.pos.y - 1.4),
        this.pos.z + Math.sin(a) * swing
      );
      const s = 0.35 + Math.min(1.6, size * 0.35);
      this.shadow.scale.set(s, 1, s * 2.1);
      this.shadow.rotation.z = -a;
    }
  }

  updateFight(dt, ctx) {
    const f = this.fish;
    const sp = f.species;

    // Runs are telegraphed: the rod loads up a beat before the fish goes.
    f.runTimer -= dt;
    if (f.telegraph > 0) {
      f.telegraph -= dt;
      if (f.telegraph <= 0) {
        f.running = true;
        f.runDuration = 0.6 + Math.random() * 0.9 * (f.staminaLeft / sp.stamina);
        this.hooks.onSfx?.('run');
      }
    } else if (f.running) {
      f.runDuration -= dt;
      f.staminaLeft -= dt * 1.6;
      if (f.runDuration <= 0) {
        f.running = false;
        f.runTimer = 1.1 + Math.random() * 2.2 / Math.max(0.4, sp.runs);
      }
    } else if (f.runTimer <= 0 && f.staminaLeft > 0) {
      f.telegraph = 0.42;                       // the tell
      this.hooks.onTelegraph?.();
    }

    const reeling = ctx.reeling;
    const tired = 1 - Math.min(1, Math.max(0, f.staminaLeft) / sp.stamina) * 0.55;

    if (reeling) {
      // Gaining line loads the rod. A running fish loads it much faster.
      const load = (f.running ? sp.power * 26 : sp.power * 7) * tired;
      f.tension += load * dt;
      // Fishing tight to the limit is worth real money.
      const band = f.tension > 62 && f.tension < 92 ? 1.9 : 1;
      f.line -= (f.running ? 3 : 15) * band * dt * (2 - tired);
    } else {
      f.tension -= 34 * dt;
      if (f.running) f.line += 9 * dt;           // it takes line back
    }
    f.tension = Math.max(0, f.tension);
    f.line = Math.max(0, Math.min(130, f.line));

    // Drag the float toward or away from the angler.
    const toRod = _v.copy(ctx.rodTip).sub(this.pos).setY(0);
    const dist = toRod.length() || 1;
    toRod.multiplyScalar(1 / dist);
    const pull = (reeling ? (f.running ? 0.6 : 3.4) : (f.running ? -3.2 : 0.4));
    this.pos.addScaledVector(toRod, pull * dt);
    // And let it thrash sideways so the line is never a straight boring string.
    const side = _v.set(-toRod.z, 0, toRod.x);
    this.pos.addScaledVector(side, Math.sin(ctx.time * (f.running ? 7 : 2.6)) * (f.running ? 1.8 : 0.5) * dt);

    if (f.tension >= TENSION_MAX) {
      this.hooks.onSfx?.('snap');
      this.spook(`The line parted — ${sp.name}, gone`);
      return;
    }
    if (f.line <= 0 || dist < 2.2) {
      this.land();
    }
  }

  land() {
    const { species, kg } = this.fish;
    const value = fishValue(species, kg);
    this.hooks.onSfx?.('land');
    this.hooks.onSplash?.(this.pos, 0.9);
    this.hooks.onCatch?.({ species, kg, value });
    this.stop();
  }

  updateLine(rodTip) {
    if (!this.line.visible || !rodTip) return;
    const pos = this.line.geometry.attributes.position.array;
    const n = pos.length / 3;
    const sag = this.phase === PHASE.FIGHT
      ? 0.4 * (1 - this.fish.tension / TENSION_MAX)
      : 1.2;
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const droop = Math.sin(Math.PI * t) * sag;
      pos[i * 3] = rodTip.x + (this.float.position.x - rodTip.x) * t;
      pos[i * 3 + 1] = rodTip.y + (this.float.position.y - rodTip.y) * t - droop;
      pos[i * 3 + 2] = rodTip.z + (this.float.position.z - rodTip.z) * t;
    }
    this.line.geometry.attributes.position.needsUpdate = true;
  }

  /** 0..1, for bending the rod and drawing the gauge. */
  get tension() { return this.fish && this.phase === PHASE.FIGHT ? this.fish.tension / TENSION_MAX : 0; }
  get progress() { return this.fish && this.phase === PHASE.FIGHT ? 1 - this.fish.line / 100 : 0; }
  get running() { return !!(this.fish && this.fish.running); }
  get telegraphing() { return !!(this.fish && this.fish.telegraph > 0); }
}
