import * as THREE from 'three';
import { clamp } from './util.js';

// The telenovela layer.
//
// The coop was always a melodrama — a rank upset is a betrayal, a standoff is
// a confrontation, a rooster calling one particular hen over to food is a
// love triangle waiting to happen. What it lacked was a camera that knew it.
//
// This watches the simulation for those moments and shoots them the way a
// soap does: snap in on her face, cut to his, cut to whoever is watching from
// the nesting boxes, and hold a beat too long on each. Bars in, organ sting,
// bars out.
//
// IMPORTANT: everything here is local and cosmetic. It reads simulation state
// and never writes it, draws from no RNG, and runs on render time rather than
// ticks — the same discipline as the rain streaks. Two viewers may well be
// watching different scenes at the same moment, which is fine and is why the
// camera has always been per-viewer. Nothing in this file can desync a coop.

const SHOT_DUR = 1.45;          // how long we hold on each face
const BARS = 0.11;              // letterbox height, fraction of the viewport

// What is worth cutting away for, and how badly. A scene only happens if
// nothing better has happened recently, so these compete.
const DRAMA = {
  deposed: 100,          // the pecking order changed hands
  evictedFromNest: 62,
  shovedOffRoost: 46,
  displaced: 30,
  newFavourite: 88,      // he has moved on
  broughtBackup: 70,     // she brought a friend
  caughtMouse: 54,
  foxTookEgg: 96,
  hatched: 80,
};

export class Director {
  constructor(world, camera, orbit, views) {
    this.world = world;
    this.camera = camera;
    this.orbit = orbit;
    this.views = views;
    this.scene = null;          // the running scene, or null
    this.cooldown = 6;
    this.enabled = true;
    this.pending = [];          // beats raised this tick, highest first
    this.buildOverlay();
  }

  buildOverlay() {
    const el = document.createElement('div');
    el.id = 'drama';
    el.innerHTML = '<div class="bar top"></div><div class="bar bottom"></div>';
    document.getElementById('ui')?.appendChild(el);
    this.el = el;
    this.bars = el.querySelectorAll('.bar');
  }

  // Called from the simulation when something happens. Cheap and side-effect
  // free: it only records that a thing occurred, and the render loop decides
  // whether to make a scene of it.
  beat(kind, subject, object = null, witness = null) {
    if (!this.enabled) return;
    const score = DRAMA[kind] ?? 20;
    this.pending.push({ kind, score, subject, object, witness });
  }

  // A third party to cut to. The whole grammar depends on someone watching,
  // and a soap will always find someone. Prefers whoever has the strongest
  // feelings about the people involved.
  findWitness(a, b) {
    const w = this.world;
    let best = null, bestScore = 0;
    for (const c of w.chickens) {
      if (!c.active || c === a || c === b) continue;
      if (c.zone !== a.zone) continue;
      const care = Math.abs(w.rel.get(c.index, a.index))
        + Math.abs(w.rel.get(c.index, b?.index ?? a.index));
      const near = 1 / (1 + c.pos.distanceTo(a.pos));
      const score = care + near * 0.8 + (c.big ? 0.6 : 0);   // Bertha is always a mood
      if (score > bestScore) { bestScore = score; best = c; }
    }
    return best;
  }

  // Start a scene, if one is warranted and the viewer is not busy.
  consider(userActiveSince) {
    if (!this.pending.length) return;
    const top = this.pending.reduce((a, b) => (b.score > a.score ? b : a));
    this.pending.length = 0;
    if (this.scene || this.cooldown > 0) return;
    // Never wrestle the camera off someone who is using it.
    if (this.world.time - userActiveSince < 3) return;
    if (!top.subject?.active) return;
    // Only shoot what this viewer could actually see; cutting into the coop
    // from the run reads as a glitch, not a cut.
    if (top.subject.zone !== this.orbit.view) return;

    const witness = top.witness ?? this.findWitness(top.subject, top.object);
    const shots = [top.subject, top.object, witness].filter((c) => c?.active);
    if (!shots.length) return;

    this.scene = {
      kind: top.kind,
      shots,
      i: 0,
      t: 0,
      bars: 0,
      // Remember where the viewer was looking so we can hand it back.
      home: {
        theta: this.orbit.thetaT, phi: this.orbit.phiT, r: this.orbit.rT,
        target: this.orbit.targetT.clone(),
      },
    };
    this.world.audio.sting();
  }

  // Where the camera sits for a close-up. In FRONT of her and slightly off
  // axis, level with her head, near enough that her face fills the frame —
  // the whole grammar is reaction shots, and a reaction needs a face. Built
  // behind her shoulder first, which framed every scene as an anonymous back.
  shotFor(c, t) {
    const push = 1 - Math.min(1, t / SHOT_DUR) * 0.2;      // slow creep in
    const yaw = c.yaw + (c.index % 2 ? 0.55 : -0.55);      // not a mugshot
    const dist = (c.big ? 1.4 : 0.8) * push;
    const eye = 0.55 * c.scale + 0.1;
    const pos = new THREE.Vector3(
      c.pos.x + Math.sin(yaw) * dist,
      c.pos.y + eye + 0.08,
      c.pos.z + Math.cos(yaw) * dist);
    // Never let a dramatic beat put the camera inside a wall.
    const box = this.views[this.orbit.view].box;
    pos.x = clamp(pos.x, box.x[0], box.x[1]);
    pos.y = clamp(pos.y, box.y[0], box.y[1]);
    pos.z = clamp(pos.z, box.z[0], box.z[1]);
    return { pos, look: new THREE.Vector3(c.pos.x, c.pos.y + eye, c.pos.z) };
  }

  // Drives the camera while a scene runs. Returns true if it owns the camera
  // this frame, in which case the orbit rig stands down.
  update(frameDt) {
    this.cooldown = Math.max(0, this.cooldown - frameDt);
    const s = this.scene;
    if (!s) {
      if (this.barsShown) {
        this.barsShown = Math.max(0, this.barsShown - frameDt * 3);
        this.applyBars(this.barsShown);
      }
      return false;
    }

    s.t += frameDt;
    if (s.t >= SHOT_DUR) {
      s.t = 0;
      s.i++;
      if (s.i < s.shots.length) this.world.audio.sting(s.i);
      else {
        // Out. The viewer's framing comes back exactly as they left it.
        this.orbit.thetaT = s.home.theta;
        this.orbit.phiT = s.home.phi;
        this.orbit.rT = s.home.r;
        this.orbit.targetT.copy(s.home.target);
        this.world.audio.stingResolve();
        this.scene = null;
        // Long. Roost shoves alone happen several times a night, and a scene
        // every half minute stops being an event and becomes the format.
        this.cooldown = 45;
        return false;
      }
    }

    const subject = s.shots[s.i];
    if (!subject.active) { s.i = s.shots.length; return true; }
    const shot = this.shotFor(subject, s.t);
    // Cut, do not glide: a soap cuts. Only the push-in is animated.
    this.camera.position.copy(shot.pos);
    this.camera.lookAt(shot.look);

    this.barsShown = Math.min(1, (this.barsShown ?? 0) + frameDt * 6);
    this.applyBars(this.barsShown);
    return true;
  }

  applyBars(k) {
    const h = (BARS * k * 100).toFixed(2);
    for (const b of this.bars) b.style.height = `${h}vh`;
    this.el.classList.toggle('on', k > 0.01);
  }

  // Any interaction cancels the scene immediately. Being trapped in someone
  // else's close-up is the fastest way to make this annoying.
  cancel() {
    if (!this.scene) return;
    this.orbit.thetaT = this.scene.home.theta;
    this.orbit.phiT = this.scene.home.phi;
    this.orbit.rT = this.scene.home.r;
    this.orbit.targetT.copy(this.scene.home.target);
    this.scene = null;
    this.cooldown = 12;
  }
}
