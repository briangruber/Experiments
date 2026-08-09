// White water. What a thirty-four metre animal does to the sea when it lands.
//
// ref/05 is the brief and it is worth being precise about what is actually in
// that painting, because the thing this replaces got every axis of it wrong.
// Cropped and zoomed, the breach reads as:
//
//   * a continuous OPAQUE white collar hugging the body at the waterline,
//   * two near-vertical SHEETS thrown out left and right, reaching about 0.7 of
//     the exposed body height, with hard silhouette edges that feather into
//     fingers against the SKY,
//   * twenty to forty clearly DETACHED round droplets above and outside them,
//   * and almost no flat foam mat — the water is ordinary blue within one
//     body-width of the impact.
//
// Vertical, opaque, hard-edged, silhouetted. The old landing was the exact
// inverse: horizontal, translucent, soft, lying in the plane. That was not a
// tuning failure. `water.disturb()` writes into the ripple field, and the water
// shader only ever tints its own surface — no value written into that texture
// can put a single pixel above y = 0. Driving the stamp to saturation was
// measured: a geometrically perfect 26 m disc of flat (217,227,230) with a razor
// edge and no internal structure. That is the ceiling of that road, so this
// takes a different one. Every white pixel above the waterline here is geometry.
//
// Three pieces, one rig, built once at boot and reused for every splash forever:
//
//   CROWN   one open skirt of ~44 columns x 5 rows. Each column is a ballistic
//           sheet: the vertex at height fraction v sits where the sheet's TIP was
//           at time v*t, so the surface is the swept locus of a thrown curtain.
//           It rises, splays, thins and falls with no keyframes and no CPU.
//   SPRAY   one InstancedMesh of icosahedra on plain `p + v t - g t^2/2`, the
//           monster's own bubble rig (monster.js:648-670) with the looping rise
//           swapped for a one-shot arc. These are the detached specks, and they
//           are what makes the landing read as violence rather than as fog.
//   RING    an expanding foam ring stamped into the ripple sim's ARM channel.
//           A costs nothing per frame to keep alive because the sim zeroes it
//           every step (wake.js:172), it has its own knee and gain that are not
//           the boat's, and `armEdge` in waterMaterial.js:686 gives a bright rim
//           for free in the band A ~ 0.3..5.2. No new draw call, no new pipeline,
//           and — critically — not one of the boat-wake uniforms is touched.
//
// EVERYTHING IS BUILT AND DRAWN AT BOOT. This is the constraint that shapes the
// whole file. A pipeline is compiled the first time its object is actually
// drawn, synchronously, and the one frame you must never pay that on is the
// frame the leviathan hits the water. So the meshes are created in the module
// constructor, `visible` is true and `frustumCulled` is false FOREVER (a culled
// object is never reached by renderObject() and warmUpClock's 24 frames all come
// from one camera pose, so culling defers a pipeline exactly like visible=false
// does — measured), the instance count never moves, and `applyWaterClip` is
// called next to `setLayers` at build time.
//
// An idle splash is hidden by COLLAPSING IT TO A POINT in the vertex shader:
// every vertex returns `uOrigin`, so every triangle is degenerate and rasterises
// zero fragments. It still costs its draw call and its vertex shader — about
// 1.2k vertices — which is the price of never compiling anything late.
//
// Layers are MAIN + REFLECTED and deliberately NOT UNDERWATER: the splash lives
// above the waterline, water/clip.js would trim it out of the refraction pass
// anyway, and staying off that pass halves what it costs.

import * as THREE from 'three';
import {
  Fn, uniform, attribute, varying, materialOpacity, positionGeometry,
  vec2, vec3, float, floor, fract, dot, mix,
  step, smoothstep, clamp as tslClamp, oneMinus,
} from 'three/tsl';
import { LAYER, setLayers } from '../core/layers.js';
import { applyWaterClip } from '../water/clip.js';
import { makeRng } from '../core/rng.js';

const TAU = Math.PI * 2;

// --- the physics ------------------------------------------------------------
// Not 9.81. The animal is 34 m long and the camera sits 12-40 m off it, so a
// real-gravity splash on this scale hangs in the air for three seconds and reads
// as slow motion. 22 m/s^2 puts the crown's tip up and back down inside two
// seconds, which is the beat the paintings imply and the beat a landing wants.
const G = 22.0;

// Launch speeds for the crown, PER COLUMN and before the power scale.
//
// These are the ceiling, not the average, and the difference matters: the first
// build used 22 as if it were the mean, then multiplied by a per-column spread
// that topped out at 1.4 and a forward bias that topped out at 1.26. The tallest
// columns launched at 46 m/s and apexed FORTY-EIGHT metres up. The screenshot is
// unambiguous — the splash filled the entire frame, sky included, and completely
// hid the animal that caused it.
//
// Sized against ref/05 instead: the splash there is roughly one and a half head-
// widths across and about one head-height tall, i.e. for a 34 m animal a crown
// ~18 m across and ~8 m at the tallest sheet. 14 m/s with the spread and bias at
// their maxima and power ~1.06 gives 18.1 m/s -> apex 7.5 m. Exactly there.
const CROWN_UP = 14.0;
const CROWN_OUT = 4.0;
// The collar radius the sheet springs from. The body is ~7 m across the
// shoulders, so a 3.4 m ring hugs it rather than standing off it.
const CROWN_R0 = 3.4;
// Cut the crown well before the tip has returned (that would be t ~ 1.9). Two
// reasons, and the second only showed up in a capture. The last third of a
// ballistic fall is the least interesting part of a splash. And a sheet that has
// been flying for a second is STRETCHED: its five rows are spread over eight
// metres of trajectory, so the quads between neighbouring columns become long
// thin panels, and at any alpha above zero they read as faint grey sheets of
// glass hanging in the sky. 1.30 ends it while the sheet is still compact.
const CROWN_LIFE = 1.30;

// Likewise. At 2.0 s the fastest droplets had travelled thirty metres and some
// arrived at the camera, where a 20-triangle icosahedron is unmistakably a
// polyhedron rather than a drop of water.
const SPRAY_LIFE = 1.55;

// How long the ripple sim keeps being stamped. Longer than this and the ring has
// expanded past the wake window (128 m across) and is being thrown away.
const RING_LIFE = 1.15;

// --- little helpers ---------------------------------------------------------

/**
 * The project's one geometry-budget ramp. Branch on `quality.geometry`, never on
 * a tier NAME — an unlisted tier falls through a name ladder to the richest
 * branch, which is how a phone once got a 333k-triangle seabed.
 */
const lerpI = (geo, a, b) =>
  Math.round(a + (b - a) * Math.min(1, Math.max(0, (geo - 0.42) / 0.58)));

// A local copy of the hash/value-noise pair. monster.js has the same three nodes
// but does not export them, and a shared graph across two modules is not worth a
// new import surface for nine lines.
const hash12 = Fn(([p]) => {
  const p3 = fract(vec3(p.xyx).mul(0.1031)).toVar();
  p3.addAssign(vec3(dot(p3, p3.yzx.add(33.33))));
  return fract(p3.x.add(p3.y).mul(p3.z));
});

const vnoise = Fn(([p]) => {
  const i = floor(p).toVar();
  const f = fract(p).toVar();
  const u = f.mul(f).mul(f.mul(-2.0).add(3.0)).toVar();
  return mix(
    mix(hash12(i), hash12(i.add(vec2(1, 0))), u.x),
    mix(hash12(i.add(vec2(0, 1))), hash12(i.add(vec2(1, 1))), u.x),
    u.y,
  );
});

/**
 * The crown skirt. Positions are not positions: `(x, z)` is the unit direction
 * of the column round the ring and `y` is the fraction v along the sheet. The
 * vertex shader builds the real point from those two plus the clock, so one
 * static buffer serves every splash at every size.
 *
 * `aCrown` carries two per-COLUMN values, and they are BAND-LIMITED IN AZIMUTH
 * rather than random. This is the one thing about the crown that had to be
 * discovered rather than designed.
 *
 * With an independent hash per column, neighbouring columns launch at wildly
 * different speeds, and the quad between a column that went nine metres up and
 * its neighbour that went one metre up is a single enormous slanted panel. The
 * capture shows them plainly: faint grey triangles the size of the animal
 * hanging in the air around the splash, an angular ghost of the skirt's own
 * topology. Water does not do that.
 *
 * Summed sinusoids at integer harmonics wrap exactly round the ring and give a
 * smooth height function with three to eight lobes — which is not a compromise,
 * it is the shape ref/05 actually has: a low collar with a handful of distinct
 * SHEETS standing out of it, and clean sky between them.
 */
function buildCrown(segs, rings, rng) {
  const seedA = new Float32Array(segs);
  const seedB = new Float32Array(segs);
  const ph = [rng.range(0, TAU), rng.range(0, TAU), rng.range(0, TAU),
    rng.range(0, TAU), rng.range(0, TAU)];
  for (let i = 0; i < segs; i++) {
    const a = (i / segs) * TAU;
    // 3 + 5 + 8 lobes: enough structure to read as several sheets, few enough
    // that each one spans several columns and therefore has a silhouette.
    seedA[i] = Math.min(1, Math.max(0, 0.50
      + 0.42 * Math.sin(a * 3 + ph[0])
      + 0.30 * Math.sin(a * 5 + ph[1])
      + 0.20 * Math.sin(a * 8 + ph[2])));
    seedB[i] = Math.min(1, Math.max(0, 0.50
      + 0.35 * Math.sin(a * 4 + ph[3])
      + 0.28 * Math.sin(a * 7 + ph[4])));
  }

  const quads = segs * rings;
  const pos = new Float32Array(quads * 6 * 3);
  const crn = new Float32Array(quads * 6 * 2);
  let k = 0;

  const put = (i, j) => {
    const c = i % segs;
    const a = (i / segs) * TAU;
    pos[k * 3] = Math.cos(a);
    pos[k * 3 + 1] = j / rings;
    pos[k * 3 + 2] = Math.sin(a);
    crn[k * 2] = seedA[c];
    crn[k * 2 + 1] = seedB[c];
    k++;
  };

  for (let i = 0; i < segs; i++) {
    for (let j = 0; j < rings; j++) {
      put(i, j); put(i + 1, j); put(i + 1, j + 1);
      put(i, j); put(i + 1, j + 1); put(i, j + 1);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aCrown', new THREE.BufferAttribute(crn, 2));
  // The vertex shader throws these vertices tens of metres, so the authored
  // bounds are meaningless. frustumCulled is false anyway; this just stops three
  // computing a bounding sphere that would lie.
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  return g;
}

// ---------------------------------------------------------------- the module

/**
 * @param {object} opts
 * @param {object} [opts.quality]  `{ geometry }` — the only budget that is read
 * @param {number} [opts.seed]
 */
export function createSplash(opts = {}) {
  const group = new THREE.Group();
  group.name = 'splash';

  const geoBudget = opts.quality?.geometry ?? 1;
  const rng = makeRng(((((opts.seed | 0) || 20260807) ^ 0x5a17ec) >>> 0));

  // Every per-splash value is a uniform created once, never a literal folded
  // into the graph. A number baked into a node graph makes the next splash a
  // fresh WGSL module and a blocking pipeline build; a uniform is a
  // writeBuffer on a group that is already bound.
  const uni = {
    uT: uniform(-1),                        // seconds since impact; < 0 = idle
    uOrigin: uniform(new THREE.Vector3(0, -400, 0)),
    uDir: uniform(new THREE.Vector3(0, 0, -1)),   // horizontal travel at impact
    uPower: uniform(1),
    uFoam: uniform(new THREE.Color(1, 1, 1)),
    uBright: uniform(1),
  };

  // ---- the crown ---------------------------------------------------------

  const segs = lerpI(geoBudget, 22, 44);
  const rings = 5;
  const crownGeo = buildCrown(segs, rings, rng);

  // MeshBasicNodeMaterial, not Standard. Two reasons, both hard-won elsewhere in
  // this project: a Basic material carries no lights hash, so it can never be
  // caught up in the material rebuild that changing the light set causes; and
  // foam is not a shaded surface — its colour comes from `env.foamTint` and
  // `env.foamBrightness`, which is the palette's own answer for white water and
  // the only thing that keeps a splash from being a white hole at night.
  //
  // NOT a `fragmentNode` material: those are skipped by applyWaterClip
  // (clip.js:189), and this one genuinely wants clipping — the falling half of
  // the crown dips below y = 0 and must not appear in the reflection.
  const crownMat = new THREE.MeshBasicNodeMaterial({
    color: 0xffffff,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: true,
    toneMapped: true,
  });

  {
    const aCrown = attribute('aCrown', 'vec2');
    // Clamped, so the shape freezes at the end of life instead of inverting
    // through the parabola; `alive` is what actually removes it.
    //
    // These are bare node expressions, not `.toVar()`s. A toVar emits an
    // assignment into whatever function is being built, and there is no function
    // out here — it has to stay an expression until it is used inside an Fn.
    const t = tslClamp(uni.uT, 0.0, CROWN_LIFE);
    const alive = step(0.0, uni.uT).mul(step(uni.uT, float(CROWN_LIFE)));

    const vSeed = varying(aCrown.x, 'vSeed');
    const vV = varying(positionGeometry.y, 'vV');

    crownMat.positionNode = Fn(() => {
      const dir = vec2(positionGeometry.x, positionGeometry.z).toVar();
      const v = positionGeometry.y.toVar();

      // Which way this column faces relative to the direction she was travelling
      // when she hit: +1 dead ahead, -1 straight behind. She enters at about 41
      // degrees, so the water is thrown FORWARD — a symmetric ring reads as a
      // dropped stone, not as a body skidding in.
      const fwd = dir.x.mul(uni.uDir.x).add(dir.y.mul(uni.uDir.z)).toVar();

      // seed SQUARED, not seed. A uniform spread gives every column much the
      // same height and the crown reads as a bowl. Squaring puts two thirds of
      // the columns below half height and leaves a handful spiking — which is a
      // low solid collar with a few tall sheets standing out of it, which is
      // what ref/05 actually shows.
      const up0 = float(CROWN_UP)
        .mul(aCrown.x.mul(aCrown.x).mul(0.66).add(0.34))
        .mul(fwd.mul(0.22).add(1.0))
        .mul(uni.uPower).toVar();
      const out0 = float(CROWN_OUT)
        .mul(aCrown.y.mul(0.65).add(0.45))
        .mul(fwd.mul(0.50).add(1.0))
        .mul(uni.uPower).toVar();

      // The sheet is the tip's own history: this vertex sits where the tip was
      // at time v*t. That is what makes it a curtain rather than a cone — the
      // base stays at the collar, the top arcs out and over, and the whole thing
      // thins as the trajectory stretches.
      const tv = v.mul(t).toVar();
      const y = up0.mul(tv).sub(float(0.5 * G).mul(tv).mul(tv)).toVar();
      const rad = float(CROWN_R0).mul(uni.uPower).add(out0.mul(tv)).toVar();

      // Collapse to a single point when idle: every triangle degenerate, zero
      // fragments, pipeline still warm.
      return uni.uOrigin.add(
        vec3(dir.x.mul(rad), y, dir.y.mul(rad)).mul(alive),
      );
    })();

    // The tear. One noise sampled per column-and-height, thresholded against v
    // so the collar is solid and the tip is fingers. This is the whole
    // difference between a sheet and a soap bubble: at v = 0 the threshold is
    // below the noise floor so alpha is 1 everywhere, and by v = 1 only the
    // columns that happen to be noisy survive, which is what feathers the
    // silhouette against the sky.
    const nTear = vnoise(
      vec2(vSeed.mul(41.0).add(vV.mul(3.1)), vV.mul(7.0).sub(t.mul(1.6))),
    );

    crownMat.opacityNode = Fn(() => {
      const age = t.div(CROWN_LIFE).toVar();
      // Snap in over two frames, hold, then go. The hold is short: real white
      // water is bright for a moment and grey for a while, and the grey part is
      // the ripple sim's job, not a curtain's.
      const envl = smoothstep(0.0, 0.045, t)
        .mul(oneMinus(smoothstep(0.30, 0.86, age))).toVar();
      // The sheet breaks up from the TOP DOWN — that is what a curtain of water
      // does, and it is also what removes the stretched panels: the rows that
      // get long are exactly the rows that go first.
      envl.mulAssign(oneMinus(smoothstep(0.42, 1.0, age).mul(vV)));
      // A narrow band, so the tear is an EDGE and not a gradient. ref/05's
      // sheets have hard silhouettes against the sky; a wide smoothstep here
      // turns the same geometry into vapour.
      const cut = smoothstep(vV.mul(0.95).sub(0.10), vV.mul(0.95).add(0.13), nTear).toVar();
      return envl.mul(cut).mul(materialOpacity);
    })();

    // Thicker where the sheet survived the tear, so the fingers read as spray
    // and the collar as solid water.
    crownMat.colorNode = uni.uFoam.mul(nTear.mul(0.30).add(0.80)).mul(uni.uBright);
  }

  const crown = new THREE.Mesh(crownGeo, crownMat);
  crown.name = 'splash-crown';
  crown.castShadow = false;
  crown.receiveShadow = false;
  crown.frustumCulled = false;     // see the header: culling defers the pipeline
  crown.renderOrder = 5;
  group.add(crown);

  // ---- the spray ---------------------------------------------------------
  // The bubble rig, one-shot. 20 triangles an instance; 120 instances across two
  // passes is 4,800 triangles against a frame that draws 2.5 million.

  const sprayCount = lerpI(geoBudget, 34, 120);
  const sprayGeo = new THREE.IcosahedronGeometry(1, 0);
  const sprayMat = new THREE.MeshBasicNodeMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
    fog: true,
    toneMapped: true,
  });

  {
    // (vx, vy, vz, size) in a canonical frame: +z is the direction she was
    // travelling, +x is to its right, +y is up. Rotated into the world by uDir in
    // the shader, so one static buffer serves a splash in any direction.
    const aSpr = new Float32Array(sprayCount * 4);
    for (let i = 0; i < sprayCount; i++) {
      const a = rng.range(0, TAU);
      // Elevation biased high — the droplets that read in ref/05 are the ones
      // ABOVE the sheets, and anything thrown flat is inside the crown and never
      // seen. cos^0.6 keeps a few low fliers for the skipping-stone feel.
      const el = Math.acos(Math.pow(rng.next(), 0.6)) * 0.80 + 0.35;
      // 26 m/s threw droplets sixty metres in two seconds — they flew clean past
      // the camera and each 0.6 m icosahedron arrived as a two-inch white
      // HEXAGON filling a tenth of the screen. Detached specks are the point;
      // anything you can count the faces of is a bug.
      const sp = rng.range(4.5, 12.0);
      const ch = Math.cos(el), sh = Math.sin(el);
      // Forward bias again: 1.5x along travel, 0.75x behind.
      const fx = Math.cos(a), fz = Math.sin(a);
      const bias = 1.0 + 0.5 * fz;
      aSpr[i * 4] = fx * ch * sp * bias;
      aSpr[i * 4 + 1] = sh * sp;
      aSpr[i * 4 + 2] = fz * ch * sp * bias;
      // 6 cm to 21 cm. At the 30-40 m a landing is normally watched from that
      // is two to five pixels — a speck, which is all a droplet has ever been.
      aSpr[i * 4 + 3] = rng.range(0.06, 0.21);
    }
    sprayGeo.setAttribute('aSpr', new THREE.InstancedBufferAttribute(aSpr, 4));

    const a = attribute('aSpr', 'vec4');
    const t = uni.uT;
    const alive = step(0.0, t).mul(step(t, float(SPRAY_LIFE)));

    // Every instance matrix is the identity (see below), so `positionGeometry`
    // IS the droplet's local sphere and the whole transform is ours to write.
    const world = Fn(() => {
      const fwd = vec3(uni.uDir.x, 0.0, uni.uDir.z).toVar();
      const rgt = vec3(uni.uDir.z, 0.0, uni.uDir.x.negate()).toVar();
      const v = rgt.mul(a.x).add(vec3(0.0, 1.0, 0.0).mul(a.y)).add(fwd.mul(a.z)).toVar();
      // Gravity is not scaled by power — a bigger splash throws harder, it does
      // not fall slower.
      return uni.uOrigin
        .add(v.mul(t).mul(uni.uPower))
        .sub(vec3(0.0, float(0.5 * G).mul(t).mul(t), 0.0));
    });

    const vSprY = varying(world().y, 'vSprY');

    sprayMat.positionNode = Fn(() => {
      const sc = a.w.mul(uni.uPower).mul(alive).toVar();
      return world().add(positionGeometry.mul(sc));
    })();

    sprayMat.opacityNode = Fn(() => {
      const age = tslClamp(t.div(SPRAY_LIFE), 0.0, 1.0).toVar();
      // Fade out on the way down and swallow anything that has gone under. The
      // clip in the reflection pass removes sub-surface droplets from the mirror
      // but the beauty pass would happily draw a white ball inside the sea.
      const fade = oneMinus(smoothstep(0.55, 1.0, age))
        .mul(smoothstep(-0.6, 0.9, vSprY.sub(uni.uOrigin.y))).toVar();
      return materialOpacity.mul(fade);
    })();

    sprayMat.colorNode = uni.uFoam.mul(uni.uBright);
  }

  const spray = new THREE.InstancedMesh(sprayGeo, sprayMat, sprayCount);
  spray.name = 'splash-spray';
  spray.castShadow = false;
  spray.receiveShadow = false;
  spray.frustumCulled = false;
  spray.renderOrder = 6;
  // Identity instance matrices, written once and never touched again. The
  // droplet's whole position comes from the attribute and the uniforms, so the
  // CPU does nothing per frame and nothing per splash.
  {
    const m = new THREE.Matrix4();
    for (let i = 0; i < sprayCount; i++) spray.setMatrixAt(i, m);
    spray.instanceMatrix.needsUpdate = true;
  }
  group.add(spray);

  setLayers(group, LAYER.MAIN, LAYER.REFLECTED);
  // Build time, next to setLayers. Wiring the clip after the first render bumps
  // material.version on an already-compiled material — measured at 27 blocking
  // _getRenderPipeline calls in one burst (clip.js:158-161).
  applyWaterClip(group);

  // ---- state -------------------------------------------------------------

  let age = -1;             // seconds since fire(); < 0 = idle
  let power = 1;
  let ringT = 0;            // stamp metronome for the water ring
  let pendingChurn = false; // the single B-channel stamp, laid on the next update
  const origin = new THREE.Vector3();
  const dir = new THREE.Vector3(0, 0, -1);

  /**
   * Start a splash. Safe to call over a running one — there is exactly one rig,
   * so a second impact restarts it rather than queueing.
   *
   * @param {number} x world impact point
   * @param {number} y usually ~0; the crown is built from here
   * @param {number} z
   * @param {number} dx horizontal travel direction at impact (need not be unit)
   * @param {number} dz
   * @param {number} p  0.3..1.6, scales speed and radius
   */
  function fire(x, y, z, dx, dz, p = 1) {
    origin.set(x, y, z);
    const d = Math.hypot(dx, dz);
    if (d > 1e-4) dir.set(dx / d, 0, dz / d);
    power = Math.min(1.8, Math.max(0.25, p));
    age = 0;
    ringT = 1e3;            // stamp on the very first frame, not 60 ms later
    uni.uOrigin.value.copy(origin);
    uni.uDir.value.copy(dir);
    uni.uPower.value = power;
    uni.uT.value = 0;
    pendingChurn = true;
  }

  function update(ctx) {
    if (age < 0) return;
    age += ctx.dt;
    uni.uT.value = age;

    // Past every life, park the clock somewhere no `step()` can call alive and
    // stop touching anything. -1 keeps the crown collapsed and the spray at
    // scale zero, which is what a degenerate triangle costs: nothing.
    // The churned patch that stays behind, and it is exactly ONE stamp. B
    // accumulates and only decays on a 4.2 s constant, so re-stamping it is how
    // the first build turned the entire bay white; one stamp of 3.6 leaves
    // B = 0.58, which is a soft grey bruise on the water and the right amount of
    // "something happened here" once the white water has gone.
    if (pendingChurn) {
      pendingChurn = false;
      const w = ctx.water;
      if (w && w.disturb) {
        const bx = ctx.boat ? ctx.boat.position.x : 0;
        const bz = ctx.boat ? ctx.boat.position.z : 0;
        if (Math.hypot(origin.x - bx, origin.z - bz) < 62) {
          w.disturb(origin.x, origin.z, 3.6 * power, 9.0 * power);
        }
      }
    }

    if (age > Math.max(CROWN_LIFE, SPRAY_LIFE, RING_LIFE) + 0.05) {
      age = -1;
      uni.uT.value = -1;
      return;
    }

    // ---- the ring, in the ripple sim's ARM channel ------------------------
    // Why A and not B: B accumulates and decays over 4.2 s, so it is the
    // boat's persistent trail and the water shader's knee for it (uWakeSoft
    // 1.80) is tuned around a value that accumulates to ~1.43 — a one-shot
    // foam of 0.8 lands at a 0.128 blend toward white, a grey wash. A is
    // ZEROED by the sim every step (wake.js:172), so it has to be re-stamped
    // every frame, and in exchange it cannot stain, it has its own knee
    // (uWakeArmSoft 0.85) and — the point — `armEdge` (waterMaterial.js:686)
    // gives it a bright rim in the band A ~ 0.30..5.2 that peaks at A ~ 0.92.
    // So the ring is stamped at A ~ 1.0, which sits on the crest of a rim that
    // is already an expanding, thinning band — the shape comes free.
    //
    // It goes through `wake.disturbArm`, not `water.disturb`, because disturb()
    // writes B as well and B is conservative. The first build re-stamped this
    // ring through disturb() every frame for 1.3 s and drove B past 10; the
    // capture came back with the entire bay white to the horizon.
    //
    // Not one boat-wake uniform is touched to get this.
    const water = ctx.water;
    const wake = water && water.wake;
    if (wake && wake.disturbArm && age < RING_LIFE) {
      ringT += ctx.dt;
      if (ringT > 0.045) {
        ringT = 0;
        const bx = ctx.boat ? ctx.boat.position.x : 0;
        const bz = ctx.boat ? ctx.boat.position.z : 0;
        // The wake window is 128 m across and centred on the boat, so a stamp
        // more than ~62 m out is resampled straight off the edge. Do not spend
        // the pending slots on stamps that are thrown away — the crown and the
        // spray carry a distant landing on their own.
        if (Math.hypot(origin.x - bx, origin.z - bz) < 62) {
          const u = age / RING_LIFE;
          // Matches the crown's own splay closely enough to read as one event:
          // fast at first, easing out.
          const r = (CROWN_R0 + 15.0 * Math.pow(u, 0.55)) * power;
          const fade = 1 - u * u;
          // Eight points, not more: the ring is drawn by the OVERLAP of the
          // stamp discs, and eight discs of radius r*0.55 close a circle of
          // radius r with room to spare.
          const n = 8;
          const a0 = u * 2.1;      // rotate the octagon so it never reads as one
          for (let i = 0; i < n; i++) {
            const a = a0 + (i / n) * TAU;
            wake.disturbArm(
              origin.x + Math.cos(a) * r,
              origin.z + Math.sin(a) * r,
              1.05 * fade * power,
              r * 0.55,
            );
          }
        }
      }
    }
  }

  function applyEnv(env) {
    if (!env) return;
    // Foam colour is the palette's, never a picked white. At night foamTint is
    // a dim blue-grey and foamBrightness collapses, which is the whole reason a
    // white splash does not punch a hole in a moonlit sea.
    uni.uFoam.value.copy(env.foamTint);
    // Two factors, and the second one is the whole night problem.
    //
    // Measured at preset=night: foamTint is (0.497, 0.658, 0.888) linear,
    // foamBrightness 0.55, exposure 1.18 and bloomThreshold 0.52, against a sea
    // whose shallow colour is (0.004, 0.102, 0.156). Foam at the day gain lands
    // at luminance ~0.68 — comfortably OVER the bloom threshold — so every
    // droplet became a glowing point and the landing read as a firework going
    // off, which the capture shows exactly. Folding dayFactor in drops it to
    // ~0.26, under the threshold, so nothing blooms and the splash is pale
    // moonlit water against a dark sea: still by far the brightest thing in
    // frame, because the sea it sits on is at 0.1.
    //
    // Day is untouched: both factors are 1.0 at noon.
    uni.uBright.value = (0.55 + 0.45 * env.foamBrightness)
      * (0.42 + 0.58 * env.dayFactor);
    // Opacity, not transparency: `transparent` is one of the 29 components of
    // the pipeline cache key and must never move. `material.opacity` is a
    // uniform in the node path and is free to write.
    crownMat.opacity = 0.72 + 0.22 * env.dayFactor;
    sprayMat.opacity = 0.80 + 0.18 * env.dayFactor;
  }

  function dispose() {
    crownGeo.dispose();
    crownMat.dispose();
    sprayGeo.dispose();
    sprayMat.dispose();
    spray.dispose();
    group.clear();
  }

  return {
    group,
    fire,
    update,
    applyEnv,
    dispose,
    /** Seconds since the last impact, or < 0 when idle. Read-only. */
    get age() { return age; },
  };
}
