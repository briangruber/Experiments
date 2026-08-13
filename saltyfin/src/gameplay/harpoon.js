// The harpoon — a rope between two stubborn masses, and everything that
// follows from taking the other end personally.
//
// The physics is one spring-damper, applied honestly to both ends:
//
//   T = K * stretch + C * max(0, separation rate)        tension, never push
//
// The boat receives T as an acceleration at the STERN towing post: the
// horizontal part becomes drift the keel has to kill (boatController.js
// consumes ctx.tow), the off-axis part slews her stern toward the pull and
// heels her over, and a sounding leviathan squats the transom and steals
// her freeboard. The creature receives -T scaled by a
// mass ratio, folded into its own steering (the 'hooked' phase in
// monster.js), so a hard pull visibly bends its path without ever puppeting
// it.
//
// Consequences run on accumulators rather than instants, because a rope
// yanks in spikes and a capsize should be earned over seconds, not lost to
// one frame of bad luck:
//
//   rollEnergy   grows while the lateral pull exceeds what the keel damps —
//                past ROLL_LIMIT she goes over (the roll is scripted, the
//                trigger is not)
//   sinkEnergy   grows while the bow is being held under; past DUNK_LIMIT
//                the line is torn off the cleat and she pops back up
//   snapT        grows while tension rides above 92% of TMAX; past SNAP_S
//                the line parts — the mercy valve that keeps an unwinnable
//                pull from being a permanent state
//   strain       the creature's exhaustion, 0..1. It climbs while the line
//                is loaded and the player pulls AGAINST the run, which is
//                the whole game: hold on, keep the line singing but not
//                snapping, and the animal tires, rises, and finally slips
//                the hook. Nobody dies; everybody has a story.

import * as THREE from 'three';
import { LAYER, setLayers } from '../core/layers.js';
import { applyWaterClip } from '../water/clip.js';

const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// --- the fire envelope -------------------------------------------------------
const RANGE = 60;            // m, boat to creature, for the call-to-action
// The arm gate and the spear's underwater run MUST agree: offering a shot the
// dart cannot physically reach is a guaranteed miss sold as an opportunity.
//
// Twelve metres was honest about the old spear and miserable to play: the pod
// CRUISES at sixteen to twenty-one, so the button spent almost all its time
// reading TOO DEEP and the shot existed only in the few seconds around a
// rise. The dart now keeps travelling once it is wet (SPEAR_DRAG below), so
// the gate moves to where it can actually reach — which turns a cruising
// leviathan from scenery into a target.
// Twenty was still short. Her cruise band runs to 24.5 m and the escort now
// parks you alongside her while she swims it, so the probe watched a locked
// animal sit at 20.2 m for forty seconds with the throw refused the whole
// time — the TOO DEEP complaint wearing a new hat. Thirty covers the band
// with room over it, and the iron carries that far (see SPEAR_DRAG).
const DEPTH_MAX = 30;
const COOLDOWN = 2.4;        // s between throws
// --- the spear ---------------------------------------------------------------
// Slow enough to WATCH. At 40 m/s the throw was over in half a second of
// foreshortened pencil and the player reported no animation at all; at 27
// with real drop it lobs a visible arc for about a second, the lead becomes
// something you can see paying off, and the entry splash marks the miss.
const SPEAR_V = 27;          // m/s off the bow
const SPEAR_G = 7.5;         // m/s^2 of drop; a harpoon is not a bullet
const FLIGHT_MAX = 4.6;      // s before it is called a miss
// Under water it slows rather than stopping: e^(-1.15 t) still carries the
// dart the twenty-odd metres down to a cruising animal in about a second and
// a half, which is a throw you can watch land.
// Eased so the cask reaches a cruising leviathan: at 0.75 the dart still runs
// close to thirty metres under before it is spent, which is the whole depth
// band the shot is now offered against.
const SPEAR_DRAG = 0.75;     // per second, once wet
const SPEAR_SINK = 2.2;      // m/s^2 it settles at, once wet
// --- the rope ----------------------------------------------------------------
const REST_MIN = 13, REST_MAX = 42;
// THE SLEIGH RIDE.
//
// She is thirty-four metres of animal; the skiff is six. The first balance
// had them arguing as near-equals — the boat held its ground and the fight
// was a tug-of-war between comparable things, which is not what the player
// saw when they looked at her: "that leviathan is WAY bigger than me and my
// boat, it should really be pulling me hard... just dragging me out to sea."
//
// So the rope now couples the hull to her the way a real one would. The
// DAMPER does the towing: it pushes the boat's along-rope velocity toward
// hers, so the terminal state is not "boat pinned at some force" but "boat
// travelling at the animal's speed with a little stretch left in the line".
// That self-limits without a cap — catch up and the stretch goes out of the
// rope, and with it the pull.
const K = 1.5;               // accel per metre of stretch, boat side
const CDAMP = 1.1;           // accel per m/s of separation rate: the tow
// She barely feels it back. Mass goes as the cube of length, so a hull a
// fifth her size moving her at all is already generous; this is what makes
// the fight about survival and endurance rather than about winning a pull.
const LEV_MASS = 85;
// Divides the tow before it reaches the hull. The skiff is 1. THIS IS THE
// PROGRESSION HOOK: a bigger boat is a bigger number here, and the same
// leviathan tows it proportionally less — which is exactly the "bigger boats
// that can handle the bigger creatures" the game is heading for.
const BOAT_POWER = 1.0;
const YAW_K = 0.14;          // nose-toward-the-pull, rad/s per accel unit
const HEEL_K = 0.115;        // heel per lateral accel unit
const SINK_K = 0.16;         // freeboard lost per downward accel unit
// --- the consequences --------------------------------------------------------
const STRAIN_UP = 0.030;     // /s at full load and full opposition
const CUT_HOLD_S = 0.55;
const ROLL_DECAY = 0.5, SINK_DECAY = 0.45;
// --- aiming, and the cameras -------------------------------------------------
// The scope is a real zoom, not a crop: 26 degrees against the chase rig's 46
// is a little over 2x, enough that a leviathan at forty metres is a target
// rather than a smudge, and narrow enough that aiming is a deliberate act.
const SCOPE_FOV = 26;
// How far back down the aim ray the eye sits. Far enough that the bow reads
// as the bottom of the frame rather than as the subject.
const SCOPE_BACK = 5.4;
const AIM_YAW_LIMIT = 1.25;  // rad either side of the bow; you cannot throw
                             // back over your own transom
// You have to be able to aim DOWN at her. She swims up to twelve metres under
// the surface and the shot is taken from twenty-five out, which is 25 degrees
// below horizontal before the spear's own drop is counted; the first cut
// stopped at -12.6 and pinned every reticle to its floor, unable to point at
// the animal it was aiming at. -40 degrees covers the whole envelope.
const AIM_PITCH_MIN = -0.72, AIM_PITCH_MAX = 0.62;
// A forgiving cone. 0.085 rad was five degrees of slop on a target the size
// of a bus at forty metres, and the report was simply "too hard to aim". At
// 0.20 the reticle finds her when it is near her, which is the difference
// between aiming and fighting the aim.
const LOCK_ANGLE = 0.20;
// Aim assist, and it only ever exists while a creature is LOCKED — the player
// has said which animal they mean, so the reticle is allowed to want it. It
// is a pull, not a snap: at 2.4 rad/s of convergence a wild aim still takes a
// beat to settle, and any drag the player makes wins instantly because it is
// applied on top.
const ASSIST_RATE = 2.4;
// Generous, because LOCKED is a statement of intent: the player has already
// said which animal they mean, so the reticle should help them find her from
// most of the way round the bow rather than only when they are nearly there.
// At 0.45 rad the assist quit at 26 degrees off, which is exactly the case
// that needed it.
const ASSIST_CONE = 1.2;     // rad; beyond this the assist lets go entirely
// --- the lock ----------------------------------------------------------------
const LOCK_RANGE = 150;      // m, how far away a creature can be claimed
const LOCK_DROP = 260;       // m, past which the lock breaks on its own
// Measured at 26: the boat settled 17-21 m off her CENTRE, which on a
// thirty-four metre animal is close enough to be inside her turning circle.
// 32 holds the low twenties, which frames her whole length and still sits
// well inside the sixty-metre throw.
const STATION_SIDE = 32;     // m off her beam the boat likes to sit
const STATION_LEAD = 4;      // m ahead of her, so the bow is level with her eye
// The auto-reel. A miss used to cost a 2.4 s cooldown and a hunt for the
// button; now the line comes home by itself and the next throw is a beat
// away, because the interesting part of a harpoon is the throwing.
const REEL_SPEED = 34;       // m/s the spear returns
const REEL_MIN = 0.35;       // s, so a miss still reads as a miss
// --- the barrels ---------------------------------------------------------------
// How long the line stays on the drum after a strike. Long enough to be
// hauled somewhere and feel it, short enough that the hunt is a sequence of
// rides rather than one endless tug-of-war.
const TOW_TIME = 7.0;
const MAX_BARRELS = 10;      // casks the scene can draw at once
const BARREL_ROPE = 9;       // m of line between the animal and her cask

export function createHarpoon(opts = {}) {
  const { ctx, scene, monster, camera, chaseCamera } = opts;
  const water = opts.water || (() => null);
  const burst = opts.burst || (() => {});
  const audio = opts.audio || null;

  // Everything a HUD or a harness could want, in one bag.
  const state = {
    available: false,
    nearDeep: false,
    aiming: false,
    flight: false,
    reeling: false,
    tethered: false,
    tension: 0,
    strain: 0,
    distance: 0,
    aimYaw: 0,
    aimPitch: 0,
    onTarget: false,
    leadDist: 0,
    locked: false,
    lockable: false,
    lockDist: 0,
    escorting: false,
    barrels: 0,
    barrelsNeeded: 0,
    msg: '',
    msgT: 9,
    cutHold: 0,
    capsizing: false,
  };

  // Tunables the debug harness may lower to reach the rare outcomes quickly.
  const tune = {
    // Raised with the forces. An ordinary tow now rides around half of this,
    // so the line hums without parting, and only a genuinely bad angle —
    // beam-on with the engine fighting her — spikes into the red.
    TMAX: 27,                // accel units at which the line is at its limit
    SNAP_S: 2.2,             // s above 92% before it parts
    // A hull being towed leans on the rope constantly, so the roll and dunk
    // budgets grow with it; otherwise the sleigh ride itself would capsize
    // you inside ten seconds and the ride would never happen.
    ROLL_LIMIT: 2.4,         // rollEnergy that capsizes
    DUNK_LIMIT: 2.6,         // sinkEnergy that drags the bow under
  };

  // --- visuals ---------------------------------------------------------------
  // Built once. Never .visible-toggled — the boot warm-up has to draw both
  // objects once so their pipelines compile before the first throw.

  const group = new THREE.Group();
  group.name = 'harpoon';

  // Presence is position, not alpha: idle rope segments and the idle spear
  // park 400 m under the seabed — drawn every frame (culling is off), so
  // their pipelines compile in the boot warm-up and stay warm, while the
  // seabed occludes them from every pass. No material property is ever
  // touched after construction.
  {

    // The spear and the rope are PLAIN meshes with PLAIN materials, built
    // exactly the way the fishing line is (fishing.js:238) - that line is the
    // one cord in this game proven to draw on both backends, above and below
    // the water. Two dead ends died here first: opacityNode uniforms on
    // transparent node materials, then an InstancedMesh - both probed to
    // perfect state and empty pixels. The node renderer converts plain
    // materials itself, and what it converts, it draws.
    const spear = new THREE.Group();
    spear.name = 'harpoon-spear';
    const matWood = new THREE.MeshStandardMaterial({
      color: 0xC9A05E, roughness: 0.75, metalness: 0.0,
    });
    const matIron = new THREE.MeshStandardMaterial({
      color: 0x3A3C42, roughness: 0.45, metalness: 0.35,
    });
    const matVane = new THREE.MeshStandardMaterial({
      color: 0xF2E9D8, roughness: 0.85, metalness: 0.0, side: THREE.DoubleSide,
    });
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.09, 3.4, 7), matWood);
    shaft.rotation.x = Math.PI / 2;
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.17, 0.7, 7), matIron);
    tip.rotation.x = -Math.PI / 2;
    tip.position.z = -2.0;
    const vane = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.03, 0.55), matVane);
    vane.position.z = 1.55;
    const vane2 = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.5, 0.55), matVane);
    vane2.position.z = 1.55;
    spear.add(shaft, tip, vane, vane2);
    spear.traverse((o) => { if (o.isMesh) o.frustumCulled = false; });
    group.add(spear);

    // The rope: a chain of stretched unit cylinders along a sagging curve.
    // Twenty-four draw calls of seven quads each; the per-frame cost is
    // setting twenty-four transforms, and there is no geometry to rebuild.
    //
    // Thinner than it was, and more of it. 5.5 cm of straight tube read as a
    // hawser or a pipe; 3.6 cm reads as cord, and doubling the segment count
    // is what lets the catenary actually curve instead of turning three
    // visible corners. The per-segment radius jitter is deterministic and
    // tiny (+/-8%), and it is the whole difference between a tube and a laid
    // rope: a real line is never the same thickness twice running.
    const SEGS = 24;
    const ROPE_R = 0.036;
    const matRope = new THREE.MeshStandardMaterial({
      color: 0x6B5230, roughness: 0.95, metalness: 0.0,
    });
    const ropeGeo = new THREE.CylinderGeometry(1, 1, 1, 5, 1, true);
    const ropeSegs = [];
    const ropeR = [];
    for (let i = 0; i < SEGS; i++) {
      const m = new THREE.Mesh(ropeGeo, matRope);
      m.name = 'harpoon-rope-' + i;
      m.frustumCulled = false;
      // Parked deep: drawn once by the warm-up (culling is off) so the
      // pipeline compiles, occluded by the seabed ever after until used.
      m.position.set(0, -400, 0);
      const r = ROPE_R * (1 + 0.08 * Math.sin(i * 2.399));
      ropeR.push(r);
      m.scale.set(r, 1, r);
      ropeSegs.push(m);
      group.add(m);
    }

    // THE CASKS. Built once, parked under the seabed, claimed as they are
    // planted — same discipline as the rope: nothing is created mid-fight, so
    // nothing compiles a pipeline mid-fight. Each is a yellow barrel with two
    // iron hoops and a short line up to the animal carrying it.
    const matBarrel = new THREE.MeshStandardMaterial({
      color: 0xE0B23C, roughness: 0.72, metalness: 0.05,
    });
    const matHoop = new THREE.MeshStandardMaterial({
      color: 0x4A3A2C, roughness: 0.8, metalness: 0.2,
    });
    const barrelGeo = new THREE.CylinderGeometry(0.62, 0.62, 1.5, 12);
    const hoopGeo = new THREE.CylinderGeometry(0.66, 0.66, 0.14, 12);
    const barrelPool = [];
    for (let i = 0; i < MAX_BARRELS; i++) {
      const g2 = new THREE.Group();
      g2.name = 'harpoon-barrel-' + i;
      const body = new THREE.Mesh(barrelGeo, matBarrel);
      const h1 = new THREE.Mesh(hoopGeo, matHoop); h1.position.y = 0.45;
      const h2 = new THREE.Mesh(hoopGeo, matHoop); h2.position.y = -0.45;
      g2.add(body, h1, h2);
      g2.traverse((o) => { if (o.isMesh) o.frustumCulled = false; });
      g2.position.set(0, -400, 0);
      barrelPool.push(g2);
      group.add(g2);
    }
    // Live casks: { animal, along, side, obj, bob }
    const barrels = [];

    // UNDERWATER too, and it is the whole feature: a line to a creature ten
    // metres down is mostly BELOW the surface, and submerged geometry is only
    // seen from the helm through the refraction pass, which renders
    // LAYER.UNDERWATER. Same three layers as the leviathan, for the same
    // reason.
    setLayers(group, LAYER.MAIN, LAYER.UNDERWATER, LAYER.REFLECTED);
    applyWaterClip(group);
    scene.add(group);

    // --- scratch --------------------------------------------------------------
    const _bow = new THREE.Vector3();
    const _anchor = new THREE.Vector3();
    const _dir = new THREE.Vector3();
    const _vB = new THREE.Vector3();
    const _rel = new THREE.Vector3();
    const _p = new THREE.Vector3();
    const _q = new THREE.Quaternion();
    const _m = new THREE.Matrix4();
    const _s = new THREE.Vector3(1, 1, 1);
    const _mid = new THREE.Vector3();
    const _a = new THREE.Vector3();
    const _b2 = new THREE.Vector3();
    const _fwd = new THREE.Vector3();
    const _Z = new THREE.Vector3(0, 0, 1);
    const _Y = new THREE.Vector3(0, 1, 0);

    // --- state ----------------------------------------------------------------
    let cooldown = 0;
    let flightT = 0;
    let spearWet = false;    // has this flight already splashed through?
    const spearPos = new THREE.Vector3();
    const spearVel = new THREE.Vector3();
    let rest = 20;
    let attachAlong = 0;     // metres along the creature's axis, + toward head
    let snapT = 0;
    let rollEnergy = 0;
    let sinkEnergy = 0;
    let strain = 0;
    let groanAt = 0.33;
    let cutHeld = false;
    let loafT = 0;           // seconds of unworked line; the animal's patience
    let aimYaw = 0;          // world heading the spear will follow
    let aimPitch = 0.12;
    let reelT = 0;           // seconds into the auto-reel
    let aimStarveT = 0;      // seconds the scope has had nothing to look at
    let sprayT = 0;          // stamp timer for the bow tearing water under tow
    let towT = 0;            // seconds of line left on the drum after a strike
    let locked = null;       // the animal the player has claimed
    const _station = new THREE.Vector3();
    let camFirst = true;     // snap the camera on the frame it is taken
    const _camPos = new THREE.Vector3();
    const _camLook = new THREE.Vector3();
    const _aimDir = new THREE.Vector3();
    const _mid2 = new THREE.Vector3();
    const _side = new THREE.Vector3();
    let capsizeT = -1;       // <0 idle, else seconds into the sequence
    let capsizeSide = 1;
    let capsizeSink = false; // the dunk variant
    const tow = { fx: 0, fz: 0, yaw: 0, heel: 0, trim: 0, sink: 0, brake: 0 };
    let tensionSmooth = 0;

    // ANY of the pod can be struck, not just the primary that shadows the
    // player: each animal carries its own hook/towPull/strain API (see
    // makeAnimal in monster.js), so the harpoon simply binds to whichever
    // one it hits. `target` is the tethered animal; while the line is home
    // the nearest hookable animal is what the call-to-action offers.
    const pod = (monster && monster.pod) || [];
    let target = null;

    function nearestAnimal() {
      let best = null;
      let bd = Infinity;
      for (let i = 0; i < pod.length; i++) {
        const a = pod[i];
        if (!a || !a.state) continue;
        const p = a.state.position;
        const d = Math.hypot(p.x - ctx.boat.position.x, p.z - ctx.boat.position.z);
        if (d < bd) { bd = d; best = a; }
      }
      return { animal: best, dist: bd };
    }

    const hookable = (a, d) => !!a && d < RANGE && a.state.depth < DEPTH_MAX
      && a.phase !== 'breach'
      // Never during the quest's rise: hooking the primary mid-approach
      // cancels the climactic breach the whole first arc builds to, and the
      // quest text then announces a surfacing that never happened. Stage 2
      // onward it is fair game.
      && !(a === pod[0] && a.phase === 'approach'
        && ctx.quest && ctx.quest.state && ctx.quest.state.stage === 1);

    function setMsg(text) { state.msg = text; state.msgT = 0; }

    function bowPoint(out) {
      const b = ctx.boat;
      return out.set(
        b.position.x + b.forward.x * 2.3,
        b.position.y + 0.55,
        b.position.z + b.forward.z * 2.3,
      );
    }

    /**
     * THE SIGHT: where the throw is aimed from, and the only point the scope
     * camera is ever allowed to sit behind. Above the gunwale rather than on
     * it, because a camera at deck height fills the screen with hull — which
     * is what the player saw: "the issue with aiming is it shows the boat
     * mostly". Everything that reasons about the throw uses this one point,
     * so the reticle cannot disagree with the spear.
     */
    function sightPoint(out) {
      const b = ctx.boat;
      return out.set(
        b.position.x + b.forward.x * 2.6,
        b.position.y + 2.2,
        b.position.z + b.forward.z * 2.6,
      );
    }

    // The line is made fast to a towing post at the STERN, and that choice is
    // load-bearing: a rope at the bow weathervanes the nose toward the pull,
    // so the harder you throttled away the harder your own bow was dragged
    // back around until the line went slack -- measured in the harness as
    // strain stalling at 0.09 and the taught strategy silently failing. A
    // stern post makes pulling away STABLE (deviations swing the stern back
    // into line), which is why real boats tow from aft. The spear still
    // flies from the bow; the line pays out over the transom.
    function sternPoint(out) {
      const b = ctx.boat;
      return out.set(
        b.position.x - b.forward.x * 2.4,
        b.position.y + 0.5,
        b.position.z - b.forward.z * 2.4,
      );
    }

    /** The rope's far end: a point on the tethered animal's spine. */
    function anchorPoint(out) {
      const p = target.state.position;
      _fwd.copy(target.velocity);
      _fwd.y *= 0.4;
      if (_fwd.lengthSq() < 1e-4) _fwd.set(0, 0, -1);
      _fwd.normalize();
      return out.set(
        p.x + _fwd.x * attachAlong,
        p.y + 1.2 * target.scale,
        p.z + _fwd.z * attachAlong,
      );
    }

    function release(reason, spent) {
      if (!state.tethered) return;
      state.tethered = false;
      snapT = 0;
      rollEnergy = 0;
      sinkEnergy = 0;
      tensionSmooth = 0;
      state.tension = 0;
      cooldown = COOLDOWN;
      state.cutHold = 0;
      // `spent` marks a fair win: the animal surfaces and lingers instead of
      // vanishing into the deep — see the 'spent' phase in monster.js.
      target?.unhook?.(!!spent);
      target = null;
      audio?.setLineTension?.(0);
      if (reason) setMsg(reason);
    }

    /**
     * Put a cask in her. The attach point is remembered ALONG her spine and
     * off to one side, so every barrel rides its own spot on her back rather
     * than all of them stacking in the same place.
     */
    function plantBarrel(animal) {
      if (barrels.length >= MAX_BARRELS) return;
      const obj = barrelPool[barrels.length];
      const landed = animal.addBarrel();
      barrels.push({
        animal,
        along: attachAlong,
        side: (barrels.length % 2 ? 1 : -1) * 2.2 * animal.scale,
        obj,
        bob: barrels.length * 1.7,
      });
      if (landed) {
        audio?.cue?.('victory');
        const p = animal.state.position;
        burst(p.x, p.z, 40, 1.5);
        setMsg('She is up! Every barrel is in her - look at the size of it.');
      }
    }

    /** Float every planted cask: up to the surface, trailing its animal. */
    function layoutBarrels(dt) {
      for (let i = barrels.length - 1; i >= 0; i--) {
        const b2 = barrels[i];
        const a = b2.animal;
        if (!a || !a.state || a.barrels === 0) {
          // She shook them off; the cask goes back in the locker.
          b2.obj.position.set(0, -400, 0);
          barrels.splice(i, 1);
          continue;
        }
        const p = a.state.position;
        _fwd.copy(a.velocity).setY(0);
        if (_fwd.lengthSq() < 1e-4) _fwd.set(0, 0, -1);
        _fwd.normalize();
        _side.set(-_fwd.z, 0, _fwd.x);
        // Where the iron went in.
        const ax2 = p.x + _fwd.x * b2.along + _side.x * b2.side;
        const az2 = p.z + _fwd.z * b2.along + _side.z * b2.side;
        // The cask wants the surface and lags astern of her — a barrel being
        // towed under skids behind the point it is tied to.
        b2.bob += dt;
        const surf = water()?.sampleHeight?.(ax2, az2, ctx.time) ?? 0;
        const deep = Math.max(0, -(p.y + 1.2 * a.scale));
        const lag = Math.min(deep * 0.55, BARREL_ROPE * 0.8);
        const bx2 = ax2 - _fwd.x * lag;
        const bz2 = az2 - _fwd.z * lag;
        // Dragged under when she sounds hard, riding the chop when she is up.
        const pull = clamp(deep - BARREL_ROPE, 0, 6);
        b2.obj.position.set(
          bx2, surf + 0.35 - pull + Math.sin(b2.bob * 2.1) * 0.12, bz2,
        );
        b2.obj.rotation.set(
          Math.sin(b2.bob * 1.7) * 0.25, Math.atan2(_fwd.x, _fwd.z),
          Math.cos(b2.bob * 1.3) * 0.22,
        );
      }
    }

    function attachNow(animal) {
      if (!animal || state.tethered) return false;
      if (!animal.hook()) return false;
      target = animal;
      state.tethered = true;
      state.flight = false;
      cutHeld = false;
      loafT = 0;
      strain = 0;
      groanAt = 0.33;
      snapT = 0;
      rollEnergy = 0;
      sinkEnergy = 0;
      sternPoint(_bow);
      const p = animal.state.position;
      // Pay out whatever the strike needed - clamping to REST_MAX here made a
      // 55 m hit start 13 m over-stretched: pegged bar, one violent yank and
      // a near-horizontal roll on the attach frame. The auto-reel below
      // shortens it to fighting length as slack allows.
      rest = Math.max(REST_MIN, _bow.distanceTo(p) * 0.98);
      // The iron carries a cask. It goes into her NOW — the line to the boat
      // is only the few seconds of ride before it pays out and leaves the
      // barrel with her, which is exactly how Quint did it.
      plantBarrel(animal);
      towT = TOW_TIME;
      audio?.cue?.('harpoonHit');
      burst(p.x, p.z, 30, 1.2);
      const w = water();
      if (w?.disturb) w.disturb(p.x, p.z, 1.6, 6.5);
      return true;
    }

    function beginCapsize(side, dunk) {
      if (capsizeT >= 0) return;
      capsizeT = 0;
      capsizeSide = side >= 0 ? 1 : -1;
      capsizeSink = !!dunk;
      state.capsizing = true;
      ctx.harpoonHold = true;
      release(dunk
        ? 'She sounds hard - the transom digs in and the line tears free!'
        : 'She rolls you clean over! The line is gone.');
      audio?.cue?.('lineSnap');
    }

    // The scripted part of a capsize: trigger is physics, theatre is not.
    // Roll her over ~1s, wallow ~1s, right herself with a damped wobble ~2s.
    function stepCapsize(dt) {
      capsizeT += dt;
      const b = ctx.boat;
      const t = capsizeT;
      tow.fx = 0; tow.fz = 0; tow.yaw = 0; tow.brake = 1.2; tow.trim = 0;
      if (t < 1.0) {
        const k = t / 1.0;
        tow.heel = capsizeSide * (capsizeSink ? 0.8 : 2.9) * k * k * (3 - 2 * k);
        tow.sink = capsizeSink ? 2.2 * k : 0.6 * k;
      } else if (t < 2.0) {
        tow.heel = capsizeSide * (capsizeSink ? 0.8 : 2.9);
        tow.sink = capsizeSink ? 2.2 : 0.6;
        if (((t * 5) | 0) !== (((t - dt) * 5) | 0)) {
          burst(b.position.x, b.position.z, 22, 1.4);
          const w = water();
          if (w?.disturb) w.disturb(b.position.x, b.position.z, 1.8, 5.5);
        }
      } else if (t < 4.2) {
        const k = t - 2.0;
        tow.heel = capsizeSide * (capsizeSink ? 0.8 : 2.9) * Math.exp(-k * 2.1) * Math.cos(k * 4.6);
        tow.sink = Math.max(0, (capsizeSink ? 2.2 : 0.6) * (1 - k / 0.8));
      } else {
        capsizeT = -1;
        state.capsizing = false;
        ctx.harpoonHold = false;
        tow.heel = 0; tow.sink = 0; tow.brake = 0;
        ctx.tow = null;
        return;
      }
      ctx.tow = tow;
    }

    /**
     * Throw it. Only from the scope — the aim IS the shot now, and a button
     * that auto-hit whatever was nearest made the whole act a formality.
     */
    function fire() {
      if (state.flight || state.reeling || state.tethered) return;
      // THE SHOT IS THE LOCK. Manual aiming was the single hardest thing in
      // the game and the player said so twice; with a creature claimed there
      // is nothing left to decide, so the throw goes straight from the
      // following view — bow to animal, led for her speed and lofted for the
      // drop, exactly the solution the assist was converging on anyway.
      if (locked && locked.state) {
        if (!aimAtAnimal(locked)) return;
      } else if (!state.aiming) {
        const near = nearestAnimal();
        if (!hookable(near.animal, near.dist) || !aimAtAnimal(near.animal)) return;
      }
      exitAim();
      state.flight = true;
      flightT = 0;
      spearWet = false;
      state.tension = 0;
      state.strain = 0;
      cooldown = COOLDOWN;
      sightPoint(spearPos);
      aimDir(_dir);
      spearVel.copy(_dir).multiplyScalar(SPEAR_V);
      audio?.cue?.('harpoonFire');
      // The throw itself has to read: a kick of spray off the bow.
      burst(spearPos.x, spearPos.z, 8, 0.55);
    }

    function stepFlight(dt) {
      flightT += dt;
      if (spearWet) {
        // Wet: it keeps going, just not for free. Drag on the whole velocity
        // and a slow settle, so the run down to a cruising leviathan is a
        // visible glide rather than a bullet or a brick.
        const k = Math.exp(-SPEAR_DRAG * dt);
        spearVel.multiplyScalar(k);
        spearVel.y -= SPEAR_SINK * dt;
      } else {
        spearVel.y -= SPEAR_G * dt;
      }
      spearPos.addScaledVector(spearVel, dt);

      // Strike test against EVERY animal in the pod: the spear does not care
      // which leviathan it was aimed at, and neither should the hit. Each
      // spine is a capsule from mid-tail to nose.
      for (let i = 0; i < pod.length; i++) {
        const a = pod[i];
        if (!a || !a.state || a.hooked) continue;
        const p = a.state.position;
        _fwd.copy(a.velocity).setY(0);
        if (_fwd.lengthSq() < 1e-4) _fwd.set(0, 0, -1);
        _fwd.normalize();
        const L = 12 * a.scale;
        _a.copy(p).addScaledVector(_fwd, L);        // toward the head
        _b2.copy(p).addScaledVector(_fwd, -L);      // down the tail
        _rel.copy(_b2).sub(_a);
        const tSeg = clamp(_p.copy(spearPos).sub(_a).dot(_rel) / _rel.lengthSq(), 0, 1);
        _p.copy(_a).addScaledVector(_rel, tSeg);
        // Generous, deliberately. She is thirty-four metres of animal and the
        // throw is made from a moving boat at a moving target through a lens
        // that is 26 degrees wide; a spear that has to thread a 3.4 m needle
        // is the difference between a hunt and a chore.
        const hitR = 4.6 * a.scale;
        if (spearPos.distanceToSquared(_p) < hitR * hitR) {
          attachAlong = clamp((0.5 - tSeg) * 2 * L, -9 * a.scale, 11 * a.scale);
          state.flight = false;
          // A breaching animal cannot be tethered — the leap owns her
          // position outright and a rope to a Bezier is a rope to nothing —
          // but a spear passing THROUGH her reads as a bug, so the throw
          // glances and comes home. You threw at a leaping leviathan; that
          // is a story either way.
          if (a.phase === 'breach') { beginReel('She twists away mid-leap!'); return; }
          if (!attachNow(a)) beginReel('The spear glances off.');
          return;
        }
      }
      const w = water();
      const surf = w?.sampleHeight ? w.sampleHeight(spearPos.x, spearPos.z, ctx.time) : 0;
      // Crossing the surface splashes, whichever way the flight ends: the
      // entry is half of what makes the throw legible from the helm.
      if (!spearWet && spearPos.y < surf + 0.1) {
        spearWet = true;
        burst(spearPos.x, spearPos.z, 12, 0.7);
        if (w?.disturb) w.disturb(spearPos.x, spearPos.z, 0.9, 2.4);
      }
      // Spent when it has run out of way or out of time — deep enough to
      // reach a cruising animal, and no deeper.
      if (spearPos.y < surf - 42 || flightT > FLIGHT_MAX
        || (spearWet && spearVel.lengthSq() < 4)) {
        beginReel('Missed - hauling the line back in.');
      }
    }

    function stepTether(dt) {
      const b = ctx.boat;
      sternPoint(_bow);
      anchorPoint(_anchor);
      _dir.copy(_anchor).sub(_bow);
      const dist = _dir.length();
      state.distance = dist;
      if (dist > 1e-4) _dir.multiplyScalar(1 / dist);

      // Take up the slack: a real crew never leaves thirty metres of loose
      // line in the water. Easing rest down while the line is slack tightens
      // every fight toward readable distances and keeps the rope where the
      // player can see it work.
      if (dist < rest && rest > 16) rest = Math.max(16, rest - dt * 1.1);

      // A teleport mid-tether (capture harness, debug, a future fast-travel)
      // leaves the rope pinned across the map; an impossible distance is a
      // quiet release, not a physics event.
      if (dist > 160) { release(''); return; }

      const stretch = dist - rest;
      let T = 0;
      if (stretch > 0) {
        _vB.copy(b.forward).multiplyScalar(b.speed);
        if (b.towDrift) { _vB.x += b.towDrift.x; _vB.z += b.towDrift.y; }
        _rel.copy(target.velocity).sub(_vB);
        const sep = _rel.dot(_dir);
        T = K * stretch + CDAMP * Math.max(0, sep);
        T = Math.min(T, tune.TMAX * 1.15);
      }
      const t01 = T / tune.TMAX;
      state.tension = t01;
      tensionSmooth += (t01 - tensionSmooth) * Math.min(1, dt * 6);
      audio?.setLineTension?.(tensionSmooth);

      if (T > 0) {
        // Boat end. Horizontal force feeds the drift; the lateral share
        // swings the bow and heels her; a downward rope steals freeboard.
        //
        // SIGNS, verified against the hull's own conventions (review round):
        // b.right is the PORT vector (forward.z, 0, -forward.x), positive
        // heading rate is a STARBOARD turn, positive heel is starboard-side-
        // up, and NEGATIVE trim is bow-up (boat.js applies rotation.x =
        // -trim). `lateral` here is starboard-positive — hence the negated
        // dot — so a starboard pull yaws starboard (+), heels starboard-down
        // (-), and a rope hauling downward pitches the bow DOWN via positive
        // trim. The first version had all three backwards: the boat steered
        // away from the pull, leaned away from the rope, and reared its bow
        // skyward at the exact moment the leviathan pulled the foredeck
        // green.
        const ax = _dir.x * T / BOAT_POWER, ay = _dir.y * T / BOAT_POWER;
        const az = _dir.z * T / BOAT_POWER;
        const lateral = -(ax * b.right.x + az * b.right.z);
        const along = ax * b.forward.x + az * b.forward.z;
        tow.fx = ax;
        tow.fz = az;
        // The rope's own direction, and how hard the keel is allowed to eat
        // the way it gives the hull. A boat under tow SLIDES: the keel bites
        // across the pull and barely at all along it, which is the whole
        // difference between being dragged out to sea and being nudged.
        tow.dirX = _dir.x;
        tow.dirZ = _dir.z;
        tow.keel = 0.42;
        // Stern lever arm: a starboard pull swings the STERN starboard and
        // the bow port -- negative heading rate. This is also what makes
        // fleeing stable instead of the bow-attach death spiral above.
        tow.yaw = clamp(-lateral * YAW_K, -0.85, 0.85);
        tow.heel = clamp(-lateral * HEEL_K, -1.7, 1.7);
        // A stern hauled downward squats the transom and LIFTS the bow:
        // negative trim is bow-up in this codebase (boat.js rotation.x = -trim).
        tow.trim = clamp(Math.min(0, ay) * 0.03 - Math.max(0, along) * 0.006, -0.42, 0.05);
        tow.sink = Math.max(0, -ay) * SINK_K;
        tow.brake = along < 0 ? Math.min(1.4, -along * 0.1) : 0;
        ctx.tow = tow;

        // Creature end: equal, opposite, and divided by a lot of leviathan —
        // more of it for the bigger pod animals (mass goes with the cube of
        // scale; the square is what FEELS right against their flee speeds).
        // Enough to bend her track — you can steer her, slowly, by leaning on
        // the rope — and nowhere near enough to stop her.
        const m = LEV_MASS * target.scale * target.scale;
        target.towPull(-ax / m * 5, -ay / m * 4, -az / m * 5);

        // Strain: the line has to be LOADED and the player pulling AGAINST
        // the run. Idling on a slack line teaches it nothing.
        const oppose = clamp(-(_vB.x * _dir.x + _vB.z * _dir.z) / 6, 0, 1);
        // The gate came down with the tension scale: a steady tow sits near
        // half of a much larger TMAX, and a gate of 0.4 would have meant an
        // honest sleigh ride tired her not at all.
        if (t01 > 0.22) {
          strain = clamp(strain + dt * (0.005 + STRAIN_UP * t01 * (0.35 + 0.65 * oppose)), 0, 1);
          loafT = Math.max(0, loafT - dt * 2);
        } else {
          // A line the player is not working sits at ~0.3 tension forever —
          // below the strain gate, below the snap gate, a stalemate with no
          // exit. The animal is not so patient: forty lazy seconds and it
          // shakes the iron loose itself.
          loafT += dt;
        }
      } else {
        ctx.tow = null;
        strain = clamp(strain - dt * 0.012, 0, 1);
        loafT += dt;
      }
      if (loafT > 40) {
        release('She shakes the iron loose. Fight her next time.');
        return;
      }
      state.strain = strain;
      target.setStrain(strain);

      // The ride, made visible. Once she is genuinely hauling the hull along,
      // the bow tears water — a burst at the stem every few tenths, scaled by
      // how fast she has the boat going.
      const towing = ctx.boat.towSpeed || 0;
      if (towing > 2.2) {
        sprayT -= dt;
        if (sprayT <= 0) {
          sprayT = 0.16;
          bowPoint(_p);
          burst(_p.x, _p.z, Math.round(4 + towing), 0.5 + towing * 0.09);
          const w2 = water();
          if (w2?.disturb) w2.disturb(_p.x, _p.z, 0.5 + towing * 0.07, 3.2);
        }
      }

      if (strain >= groanAt && strain < 0.99) {
        groanAt += 0.33;
        audio?.cue?.('levGroan');
      }

      // The win: she tires, and slips the hook on her own terms.
      if (strain >= 1) {
        const p = target.state.position;
        burst(p.x, p.z, 34, 1.3);
        audio?.cue?.('victory');
        release('She tires, rolls, and slips the line. What a fish story.', true);
        return;
      }

      // The snap: sustained overload parts the line.
      if (t01 > 0.92) snapT += dt;
      else snapT = Math.max(0, snapT - dt * 2);
      if (snapT > tune.SNAP_S) {
        audio?.cue?.('lineSnap');
        sternPoint(_p);
        burst(_p.x, _p.z, 14, 0.9);
        release('The line parts with a crack!');
        return;
      }

      // The consequences that make her dangerous. Both accumulators charge
      // while the pull exceeds what the hull shrugs off, and drain whenever
      // the line goes quiet — a capsize is EARNED over seconds of being
      // hauled beam-on, never lost to one frame.
      rollEnergy = Math.max(0, rollEnergy
        + dt * (T > 0 ? Math.abs(tow.heel) - 0.62 : -ROLL_DECAY));
      sinkEnergy = Math.max(0, sinkEnergy
        + dt * (T > 0 ? tow.sink - 0.7 : -SINK_DECAY));
      // SAME sign as the lean she has been holding: the roll must continue
      // the multi-second list that earned it, not whip across to the other
      // gunwale at the trigger frame.
      if (rollEnergy > tune.ROLL_LIMIT) { beginCapsize(Math.sign(tow.heel || 1), false); return; }
      if (sinkEnergy > tune.DUNK_LIMIT) { beginCapsize(1, true); return; }

      // THE LINE PAYS OUT. A few seconds of being hauled along behind her,
      // and then the rope runs off the drum and the cask is hers to carry.
      // This is what keeps every barrel its own violent little sleigh ride
      // without turning the hunt into one endless tug-of-war.
      towT -= dt;
      if (towT <= 0) {
        const left = target.barrelsNeeded - target.barrels;
        release(left > 0
          ? 'The line pays out - she has the barrel. ' + left + ' more.'
          : 'The line pays out.');
        return;
      }

      // The cut.
      if (cutHeld) {
        state.cutHold = clamp(state.cutHold + dt / CUT_HOLD_S, 0, 1);
        if (state.cutHold >= 1) {
          state.cutHold = 0;
          release('You cut the line free.');
        }
      } else {
        state.cutHold = Math.max(0, state.cutHold - dt * 3);
      }
    }

    // --- the visuals, every frame ----------------------------------------------
    function layoutRope(visible) {
      if (!visible) {
        for (let i = 0; i < SEGS; i++) {
          ropeSegs[i].position.set(0, -400, 0);
          // Back to its natural gauge as well as its parking spot: a segment
          // left holding the submerged fattening factor reports a rope two
          // and a half times thicker than the one that exists.
          ropeSegs[i].scale.set(ropeR[i], 1, ropeR[i]);
        }
        return;
      }
      sternPoint(_bow);
      if (state.tethered) anchorPoint(_anchor);
      else _anchor.copy(spearPos);
      // Sag: a slack line hangs, a loaded one straightens and hums.
      const dist = _bow.distanceTo(_anchor);
      const slack = Math.max(0, rest - dist);
      const sag = state.tethered
        ? clamp(0.25 + slack * 0.45 - state.tension * 2.2, 0.06, 5)
        : 0.4;
      _mid.copy(_bow).add(_anchor).multiplyScalar(0.5);
      _mid.y -= sag;
      let px = _bow.x, py = _bow.y, pz = _bow.z;
      for (let i = 0; i < SEGS; i++) {
        const t2 = (i + 1) / SEGS;
        const it = 1 - t2;
        const qx = _bow.x * it * it + _mid.x * 2 * it * t2 + _anchor.x * t2 * t2;
        let qy = _bow.y * it * it + _mid.y * 2 * it * t2 + _anchor.y * t2 * t2;
        const qz = _bow.z * it * it + _mid.z * 2 * it * t2 + _anchor.z * t2 * t2;
        // Hemp floats. A slack belly drapes ALONG the surface instead of
        // hanging metres under it — which is also the difference between a
        // line the player can read and one that only refraction knows about.
        // The clamp only lifts sag; a taut line to a deep animal still cuts
        // legitimately under.
        const both = Math.min(_bow.y, _anchor.y);
        if (qy < -0.22 && qy < both) qy = Math.max(qy, Math.min(-0.22, both));
        const seg = ropeSegs[i];
        _a.set(qx - px, qy - py, qz - pz);
        const len = Math.max(_a.length(), 1e-4);
        seg.position.set((qx + px) / 2, (qy + py) / 2, (qz + pz) / 2);
        // The cylinder's axis is +Y; aim it down the segment.
        _q.setFromUnitVectors(_Y, _a.multiplyScalar(1 / len));
        seg.quaternion.copy(_q);
        // The refraction target is a quarter-res texture: an honest 4 cm line
        // vanishes between its texels, so the submerged run still fattens —
        // by a ratio now rather than to a fixed hawser width, so the whole
        // rope keeps its per-segment character above and below.
        const r = ropeR[i] * (seg.position.y < 0 ? 2.6 : 1);
        seg.scale.set(r, len, r);
        px = qx; py = qy; pz = qz;
      }
    }

    function layoutSpear() {
      if (!state.flight && !state.tethered && !state.reeling) {
        // Parked far under the seabed: drawn (frustumCulled is off, so the
        // warm-up compiles it) yet occluded by the world in every pass.
        spear.position.set(0, -400, 0);
        return;
      }
      if (state.flight || state.reeling) {
        spear.position.copy(spearPos);
        _a.copy(spearVel).normalize();
        _q.setFromUnitVectors(_Z, _a);
        spear.quaternion.copy(_q);
        spear.quaternion.multiply(_q2FlipCache);
      } else if (state.tethered) {
        anchorPoint(_p);
        spear.position.copy(_p);
        sternPoint(_a);
        _a.sub(_p).normalize();
        _q.setFromUnitVectors(_Z, _a);
        spear.quaternion.copy(_q);
      }
    }
    // The spear model points its TIP down -Z; in flight the velocity should
    // run out of the tip, so flip once here rather than re-deriving inline.
    const _q2FlipCache = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);

    // --- aiming -----------------------------------------------------------------

    /** The unit vector the spear would follow right now. */
    function aimDir(out) {
      const cp = Math.cos(aimPitch);
      return out.set(Math.sin(aimYaw) * cp, Math.sin(aimPitch), -Math.cos(aimYaw) * cp);
    }

    /**
     * Point the throw at one animal: where her spine WILL be when the spear
     * gets there, lofted for the drop over that flight. This is the whole of
     * aiming now — the player picks the animal, the harpooner solves the lead.
     */
    function aimAtAnimal(a) {
      if (!a || !a.state) return false;
      sightPoint(_bow);
      const p = a.state.position;
      const d = _bow.distanceTo(p);
      if (d < 1e-3) return false;
      const tFly = d / SPEAR_V;
      _a.copy(p).addScaledVector(a.velocity, tFly);
      const flat = Math.hypot(_a.x - _bow.x, _a.z - _bow.z);
      aimYaw = Math.atan2(_a.x - _bow.x, -(_a.z - _bow.z));
      aimPitch = clamp(
        Math.atan2((_a.y - _bow.y) + 0.5 * SPEAR_G * tFly * tFly, flat),
        AIM_PITCH_MIN, AIM_PITCH_MAX,
      );
      state.aimYaw = aimYaw;
      state.aimPitch = aimPitch;
      return true;
    }

    function enterAim() {
      if (!state.available) return;
      const near = nearestAnimal();
      if (!hookable(near.animal, near.dist)) return;
      state.aiming = true;
      camFirst = true;
      // Start pointed at the animal, not at the horizon: the player asked to
      // aim, not to go looking. From there it is theirs to adjust.
      sightPoint(_bow);
      const p = near.animal.state.position;
      aimYaw = Math.atan2(p.x - _bow.x, -(p.z - _bow.z));
      const flat = Math.hypot(p.x - _bow.x, p.z - _bow.z);
      // Ballistic-ish first guess so the reticle sits ON the animal rather
      // than above it: the drop over the flight is 0.5*g*t^2.
      const tFly = flat / SPEAR_V;
      aimPitch = clamp(
        Math.atan2((p.y - _bow.y) + 0.5 * SPEAR_G * tFly * tFly, flat),
        AIM_PITCH_MIN, AIM_PITCH_MAX,
      );
    }

    function exitAim() {
      state.aiming = false;
      state.onTarget = false;
      state.leadDist = 0;
    }

    /** Nudge the aim, in radians. Clamped to the arc the bow can throw into. */
    function nudgeAim(dYaw, dPitch) {
      if (!state.aiming) return;
      const b = ctx.boat;
      let rel = (Number(dYaw) || 0) + aimYaw - b.heading;
      while (rel > Math.PI) rel -= TAU;
      while (rel < -Math.PI) rel += TAU;
      aimYaw = b.heading + clamp(rel, -AIM_YAW_LIMIT, AIM_YAW_LIMIT);
      aimPitch = clamp(aimPitch + (Number(dPitch) || 0), AIM_PITCH_MIN, AIM_PITCH_MAX);
    }

    // --- the lock, and the escort it drives ---------------------------------
    //
    // Locking is the answer to "I can't move around to see them": you claim an
    // animal and the boat keeps station off her beam by itself, so the whole
    // problem of chasing a thirty-four metre shadow around a lagoon with a
    // thumb-stick simply stops being the player's job. The camera frames the
    // pair, and the aim assist keys off the same choice — you have said which
    // one you mean, so the reticle is allowed to help you point at her.

    function lockOn() {
      const near = nearestAnimal();
      if (!near.animal || near.dist > LOCK_RANGE) return false;
      locked = near.animal;
      camFirst = true;
      setMsg('Locked on. The helm will hold station off her beam.');
      return true;
    }

    function lockOff(quiet) {
      if (!locked) return;
      locked = null;
      ctx.escort = null;
      state.escorting = false;
      camFirst = true;
      if (!quiet) setMsg('Lock released.');
    }

    /** Where the boat wants to be: off her beam, a little ahead. */
    function stationPoint(out) {
      const p = locked.state.position;
      _fwd.copy(locked.velocity).setY(0);
      if (_fwd.lengthSq() < 1e-4) _fwd.set(0, 0, -1);
      _fwd.normalize();
      // Whichever beam the boat is already nearer, so the escort never cuts
      // across her nose to swap sides.
      _side.set(-_fwd.z, 0, _fwd.x);
      _rel.set(ctx.boat.position.x - p.x, 0, ctx.boat.position.z - p.z);
      if (_rel.dot(_side) < 0) _side.multiplyScalar(-1);
      return out.set(
        p.x + _side.x * STATION_SIDE + _fwd.x * STATION_LEAD, 0,
        p.z + _side.z * STATION_SIDE + _fwd.z * STATION_LEAD,
      );
    }

    function stepLock(dt) {
      if (!locked || !locked.state) return;
      const p = locked.state.position;
      const d = Math.hypot(p.x - ctx.boat.position.x, p.z - ctx.boat.position.z);
      state.lockDist = d;
      if (d > LOCK_DROP) { lockOff(); setMsg('She has outrun the lock.'); return; }
      // The autopilot is a request, not a seizure: boatController blends it in
      // and any real helm input overrides it (see ctx.escort there).
      stationPoint(_station);
      ctx.escort = { x: _station.x, z: _station.z, look: { x: p.x, z: p.z } };
      state.escorting = true;
      void dt;
    }

    /** Is the aim ray near a hookable animal? Fills state.onTarget/leadDist. */
    /**
     * The assist. With a creature locked, the aim converges on the lead
     * solution — where the spear and the animal would meet — at a bounded
     * rate, and only while the reticle is already in the neighbourhood. It
     * cannot take the shot for you: it moves the aim, you still choose when
     * to release, and a drag applied the same frame wins outright.
     */
    function assistAim(dt) {
      if (!locked || !locked.state) return;
      sightPoint(_bow);
      const p = locked.state.position;
      const d = _bow.distanceTo(p);
      if (d < 1e-3) return;
      const tFly = d / SPEAR_V;
      _a.copy(p).addScaledVector(locked.velocity, tFly);
      const flat = Math.hypot(_a.x - _bow.x, _a.z - _bow.z);
      const wantYaw = Math.atan2(_a.x - _bow.x, -(_a.z - _bow.z));
      const wantPitch = Math.atan2((_a.y - _bow.y) + 0.5 * SPEAR_G * tFly * tFly, flat);
      let dy = wantYaw - aimYaw;
      while (dy > Math.PI) dy -= TAU;
      while (dy < -Math.PI) dy += TAU;
      const dp = wantPitch - aimPitch;
      const off = Math.hypot(dy, dp);
      if (off > ASSIST_CONE || off < 1e-4) return;
      // Ease off as it arrives, so the reticle settles instead of ringing.
      const k = Math.min(1, dt * ASSIST_RATE);
      nudgeAim(dy * k, dp * k);
    }

    function evaluateAim() {
      sightPoint(_bow);
      aimDir(_aimDir);
      let best = Infinity;
      let bestDist = 0;
      for (let i = 0; i < pod.length; i++) {
        const a = pod[i];
        if (!a || !a.state || a.phase === 'breach' || a.hooked) continue;
        const p = a.state.position;
        _rel.copy(p).sub(_bow);
        const d = _rel.length();
        if (d < 1e-3 || d > RANGE * 1.6) continue;
        // Angle between the throw and the bearing to the animal, forgiving
        // by the animal's own size: a 34 m body is a wide target up close.
        const ang = Math.acos(clamp(_rel.dot(_aimDir) / d, -1, 1))
          - Math.atan2(3.2 * a.scale, d);
        if (ang < best) { best = ang; bestDist = d; }
      }
      state.onTarget = best <= LOCK_ANGLE;
      state.leadDist = best < Infinity ? bestDist : 0;
    }

    // --- the cameras --------------------------------------------------------------

    /**
     * Down the shaft. The eye sits on the BACK-EXTENSION of the aim ray, in
     * full three dimensions — so aiming down automatically lifts the camera
     * up and over the bow instead of burying it in the foredeck, and the view
     * direction IS the throw direction, which is what makes a crosshair at
     * screen centre an honest promise. The old rig pinned the eye to a fixed
     * height and looked from a different point than it aimed from: the hull
     * filled the frame and the reticle lied by a couple of degrees.
     */
    function aimCamera(dt) {
      sightPoint(_bow);
      aimDir(_aimDir);
      _camPos.copy(_bow).addScaledVector(_aimDir, -SCOPE_BACK);
      const surf = water()?.sampleHeight?.(_camPos.x, _camPos.z, ctx.time) ?? 0;
      // Never through the sea surface. Raising the eye costs a little of the
      // ray-alignment, so it only happens when the alternative is a view from
      // underwater.
      _camPos.y = Math.max(_camPos.y, surf + 1.0);
      _camLook.copy(_camPos).addScaledVector(_aimDir, 45);
      applyCamera(dt, SCOPE_FOV, 9);
    }

    /** The spear's own shot: trailing it, so the throw and the rope read. */
    function flightCamera(dt) {
      _a.copy(spearVel);
      if (_a.lengthSq() < 1e-4) _a.set(0, 0, -1);
      _a.normalize();
      _camPos.copy(spearPos).addScaledVector(_a, -7.5);
      _camPos.y += 2.4;
      const surf = water()?.sampleHeight?.(_camPos.x, _camPos.z, ctx.time) ?? 0;
      _camPos.y = Math.max(_camPos.y, surf + 1.1);
      _camLook.copy(spearPos).addScaledVector(_a, 8);
      applyCamera(dt, 38, 7);
    }

    /**
     * The fight, as a two-shot. Both ends of the rope have to be in frame or
     * the tug-of-war is a boat being pushed around by nothing — so the rig
     * stands off the LINE at right angles, far enough back that the whole
     * span fits, high enough to see the animal under the water, and it holds
     * that broadside as the two of them swing around each other.
     */
    function fightCamera(dt) {
      const b = ctx.boat;
      anchorPoint(_anchor);
      _mid2.copy(b.position).add(_anchor).multiplyScalar(0.5);
      _rel.copy(_anchor).sub(b.position);
      _rel.y = 0;
      const span = Math.max(_rel.length(), 6);
      if (span > 1e-3) _rel.multiplyScalar(1 / span);
      // Broadside to the rope, on whichever side the camera already is, so
      // the shot never cuts across the axis mid-fight.
      _side.set(-_rel.z, 0, _rel.x);
      _a.copy(camera.position).sub(_mid2);
      if (_a.dot(_side) < 0) _side.multiplyScalar(-1);
      // Far enough back to hold the whole span in a 52 degree lens, with
      // headroom for the animal's own length.
      const back = clamp(span * 0.95 + 16, 26, 74);
      const high = clamp(span * 0.30 + 9, 12, 30);
      _camPos.copy(_mid2).addScaledVector(_side, back);
      _camPos.y = _mid2.y + high;
      const surf = water()?.sampleHeight?.(_camPos.x, _camPos.z, ctx.time) ?? 0;
      _camPos.y = Math.max(_camPos.y, surf + 3.5);
      // Bias the framing toward the boat: it is the thing the player steers,
      // and the leviathan is big enough to hold the other half by itself.
      _camLook.copy(_mid2).lerp(b.position, 0.22);
      _camLook.y = Math.max(_camLook.y, -2.5);
      applyCamera(dt, 52, 2.4);
    }

    /**
     * The hunt: locked but not yet committed. Behind and above the boat's
     * quarter, turned so the locked animal sits in the far half of the frame
     * — you can see where you are going AND what you are going after, which
     * is the shot the player was asking for when they said they could not
     * move around to see them.
     */
    function huntCamera(dt) {
      const b = ctx.boat;
      const p = locked.state.position;
      _mid2.copy(b.position).add(p).multiplyScalar(0.5);
      _rel.set(p.x - b.position.x, 0, p.z - b.position.z);
      const span = Math.max(_rel.length(), 8);
      _rel.multiplyScalar(1 / span);
      // Stand off the line between them, on the side the camera is already,
      // and far enough back that both ends fit a 50 degree lens.
      _side.set(-_rel.z, 0, _rel.x);
      _a.copy(camera.position).sub(_mid2);
      if (_a.dot(_side) < 0) _side.multiplyScalar(-1);
      const back = clamp(span * 0.62 + 20, 26, 62);
      const high = clamp(span * 0.22 + 11, 13, 26);
      _camPos.copy(_mid2).addScaledVector(_side, back * 0.62)
        .addScaledVector(_rel, -back * 0.62);
      _camPos.y = _mid2.y + high;
      const surf = water()?.sampleHeight?.(_camPos.x, _camPos.z, ctx.time) ?? 0;
      _camPos.y = Math.max(_camPos.y, surf + 3.5);
      // Favour the boat a little: it is the thing being steered.
      _camLook.copy(_mid2).lerp(b.position, 0.25);
      _camLook.y = Math.max(_camLook.y, -3);
      applyCamera(dt, 50, 2.2);
    }

    function applyCamera(dt, fov, rate) {
      const k = camFirst ? 1 : Math.min(1, dt * rate);
      camera.position.lerp(_camPos, k);
      camera.lookAt(_camLook);
      const f = camFirst ? fov : camera.fov + (fov - camera.fov) * Math.min(1, dt * 4);
      if (Math.abs(f - camera.fov) > 0.01) {
        camera.fov = f;
        camera.updateProjectionMatrix();
      }
      camFirst = false;
    }

    /** Hand the frame back: the chase rig eases in from wherever we left it. */
    function releaseCamera() {
      const want = chaseCamera?.spec?.fov ?? 46;
      if (Math.abs(camera.fov - want) > 0.01) {
        camera.fov += (want - camera.fov) * 0.35;
        if (Math.abs(camera.fov - want) < 0.4) camera.fov = want;
        camera.updateProjectionMatrix();
      }
    }

    // --- the reel -----------------------------------------------------------------

    function beginReel(reason) {
      state.flight = false;
      state.reeling = true;
      reelT = 0;
      if (reason) setMsg(reason);
    }

    function stepReel(dt) {
      reelT += dt;
      sternPoint(_p);
      _a.copy(_p).sub(spearPos);
      const d = _a.length();
      if (d > 0.6) {
        _a.multiplyScalar(1 / d);
        spearPos.addScaledVector(_a, Math.min(d, REEL_SPEED * dt));
        // Point it home, tail-first, the way a hauled dart actually travels.
        spearVel.copy(_a).multiplyScalar(-REEL_SPEED);
      }
      if (d <= 0.6 && reelT > REEL_MIN) {
        state.reeling = false;
        // A short breath, not a punishment: the player is meant to throw
        // again.
        cooldown = 0.3;
      }
    }

    // --- frame ------------------------------------------------------------------
    function update(c) {
      const dt = Math.min(0.05, c.dt || 0);
      state.msgT += dt;
      cooldown -= dt;

      if (capsizeT >= 0) {
        exitAim();
        stepCapsize(dt);
        layoutRope(false);
        layoutSpear();
        releaseCamera();
        return;
      }

      // Availability: near, shallow, not busy, not mid-anything.
      const busy = !!(c.fishing?.state?.active) || !!(c.shore?.state?.ashore)
        || !!c.editorHold || !!c.fishingHold;
      // Casting a lure, tying up at the quay or opening the editor mid-fight
      // all take the helm away — and a tether pulling on a boat the mooring
      // lerp is also moving is two owners of one hull. The line yields.
      if (state.tethered && busy) release('The line goes slack and drops away.');
      if (state.aiming && busy) exitAim();
      const idle = !state.tethered && !state.flight && !state.reeling;
      if (pod.length) {
        const near = nearestAnimal();
        if (!state.tethered) state.distance = near.dist;
        state.available = idle && !busy && cooldown <= 0
          && hookable(near.animal, near.dist);
        // In range but out of reach: the HUD dims the button and says why,
        // which turns "where did my button go" into "wait for the rise".
        state.nearDeep = !state.available && idle && !busy && cooldown <= 0
          && !!near.animal && near.dist < RANGE
          && near.animal.state.depth >= DEPTH_MAX;
      } else {
        state.available = false;
        state.nearDeep = false;
      }
      // The scope is NOT yanked the moment the shot stops being legal. Her
      // approach ends in a leap at your boat, and closing the scope on the
      // frame she breaches took the camera away at the best thing in the
      // game — probed: aim opened, she entered 'breach' 0.2 s later, the view
      // snapped back to the chase rig. So it stays open while there is
      // anything worth pointing at, and only gives up after four seconds of
      // genuinely empty water. Escape and CANCEL are always right there.
      if (state.aiming) {
        const near2 = nearestAnimal();
        const worthWatching = !!near2.animal && near2.dist < RANGE * 1.6;
        aimStarveT = worthWatching ? 0 : aimStarveT + dt;
        if (aimStarveT > 4) exitAim();
      } else {
        aimStarveT = 0;
      }

      // The lock: claimable, held, and the station it asks the helm for.
      if (locked && !locked.state) locked = null;
      if (locked && state.tethered && target !== locked) lockOff(true);
      if (locked) stepLock(dt);
      else { ctx.escort = null; state.escorting = false; }
      state.locked = !!locked;
      state.barrels = locked ? locked.barrels : 0;
      state.barrelsNeeded = locked ? locked.barrelsNeeded : 0;
      const lockNear = nearestAnimal();
      state.lockable = !locked && !!lockNear.animal && lockNear.dist <= LOCK_RANGE;
      // Range to whichever animal the lock is ABOUT — the held one, or the
      // candidate the button is offering. Reporting zero until the lock
      // engaged left the HUD with nothing to show on the pill it was
      // inviting the player to press.
      if (!locked) state.lockDist = lockNear.animal ? lockNear.dist : 0;

      ctx.lineOut = state.tethered;
      if (state.aiming) { assistAim(dt); evaluateAim(); }
      if (state.flight) stepFlight(dt);
      if (state.reeling) stepReel(dt);
      if (state.tethered) stepTether(dt);
      else if (!state.capsizing) { ctx.tow = null; audio?.setLineTension?.(0); }
      state.aimYaw = aimYaw;
      state.aimPitch = aimPitch;

      // One owner of the frame, chosen here and reported through ownsCamera so
      // main.js can stand the chase rig down. Order matters: the tether wins
      // over the flight (a hit cuts straight to the two-shot), the flight wins
      // over the scope.
      if (state.tethered) fightCamera(dt);
      else if (state.flight) flightCamera(dt);
      else if (state.aiming) aimCamera(dt);
      else if (locked) huntCamera(dt);
      else { camFirst = true; releaseCamera(); }

      layoutRope(state.tethered || state.flight || state.reeling);
      layoutSpear();
      layoutBarrels(dt);
    }

    // --- handle -----------------------------------------------------------------
    return {
      group: null,           // group added to scene here, not by build()
      state,
      update,
      fire,
      aim: enterAim,
      cancelAim: exitAim,
      nudgeAim,
      /** True while this module is writing the camera; main stands the chase rig down. */
      get ownsCamera() {
        return state.aiming || state.flight || state.tethered || !!locked;
      },
      lockOn,
      lockOff: () => lockOff(),
      toggleLock() { if (locked) lockOff(); else lockOn(); },
      cut() { if (state.tethered) release('You cut the line free.'); },
      holdCut(v) { cutHeld = !!v && state.tethered; },
      applyEnv() {},
      dispose() {
        scene.remove(group);
        ropeGeo.dispose();
        shaft.geometry.dispose();
        tip.geometry.dispose();
        vane.geometry.dispose();
        vane2.geometry.dispose();
        matRope.dispose();
        matWood.dispose();
        matIron.dispose();
        matVane.dispose();
      },

      debug: {
        attach() {
          if (state.tethered) return false;
          const near = nearestAnimal();
          if (!near.animal || near.animal.phase === 'breach') return false;
          attachAlong = 4 * near.animal.scale;
          return attachNow(near.animal);
        },
        setStrain(v) { strain = clamp(v, 0, 1); },
        setAim(yaw, pitch) {
          aimYaw = Number(yaw) || 0;
          aimPitch = clamp(Number(pitch) || 0, AIM_PITCH_MIN, AIM_PITCH_MAX);
          state.aimYaw = aimYaw;
          state.aimPitch = aimPitch;
        },
        aimAtNearest() {
          const near = nearestAnimal();
          return near.animal ? aimAtAnimal(near.animal) : false;
        },
        forceCapsize(side = 1) { beginCapsize(side, false); },
        forceDunk() { beginCapsize(1, true); },
        tune,
        get rollEnergy() { return rollEnergy; },
        get sinkEnergy() { return sinkEnergy; },
      },
    };
  }
}
