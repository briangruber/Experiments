// The wake, as things rather than as a texture.
//
// Every previous version of this was a FIELD: a ribbon of geometry with noise
// sampled through it. Three of them, each better shaded than the last, and all
// three read as a stamp — because that is what they were. A noise field nailed
// to the world does not move; the mark slides over it, nothing in it is ever
// born and nothing ever dies, and no amount of eroding the threshold changes
// that the thing you are looking at is a texture with a shape cut out of it.
//
// So this is not a field. It is a few hundred PUFFS, each one an object with a
// birth, a drift, a spin, a growth rate and a death. They spread because they
// are pushed apart, not because a width function widens; they dissolve because
// each one fades on its own clock, not because a ramp says so. That is what
// "dynamic" costs, and it is not much: two instanced draws and a CPU loop over
// a few hundred structs.
//
// And they are drawn by hand rather than sampled. Each puff's outline is a
// circle whose radius is modulated by three sine lobes keyed on the puff's own
// seed and drifting slowly with time — an irregular, wobbling ink blot with a
// heavier rim than centre, which is how you would draw foam with a brush. No
// texture, so nothing tiles, and the wobble means even a frozen frame has no
// two identical marks in it.
//
// Two systems here:
//
//   PUFFS    flat on the water, the wake itself
//   BUBBLES  under it, off the propeller, rising and wobbling
//
// The bubbles are the reason the boat looks like it has an engine in the water
// rather than a decal behind it, and they are the one part of this you can swim
// down and look at during the fishing beat.

import * as THREE from 'three';
import {
  Fn, attribute, uniform, positionLocal, uv, vec2, vec3, vec4, float,
  sin, cos, atan, length, smoothstep, max, min, abs, mix, cameraPosition,
} from 'three/tsl';
import { LAYER, setLayers } from '../core/layers.js';
import { makeRng } from '../core/rng.js';

const TAU = Math.PI * 2;

// --- the puffs ---------------------------------------------------------------

// How many can be alive at once. A puff lives ~3.5 s and they are laid in pairs
// about every 0.11 s at speed, so ~64 pairs is the working set; the rest is
// headroom for a hard turn, where the spawn rate briefly doubles.
const MAX_PUFFS = 520;
const PUFF_LIFE = [2.2, 3.8];      // seconds, randomised per puff
// Small and MANY. At 0.34-0.62 m on a 9.5 Hz spawn the marks were bigger
// than the gaps between them and the wake read as a row of scattered leaves
// — you could count them. Foam is a crowd: they have to overlap into a
// churn near the transom and only separate into individual flecks once
// they have spread and faded.
const PUFF_R0 = [0.16, 0.34];      // metres at birth
const PUFF_GROW = 0.30;            // metres of radius per sqrt(second)
const PUFF_LIFT = 0.05;            // above the surface, to clear its own depth
const SPAWN_HZ = 48;               // pairs per second at full speed
const MIN_SPEED = 0.55;

// --- the bubbles -------------------------------------------------------------

const MAX_BUBBLES = 200;
const BUB_LIFE = [1.1, 2.3];
const BUB_R = [0.022, 0.075];
// Bubbles come out of the prop going DOWN and BACK, and only then rise.
// Released with buoyancy alone from 0.42 m under, they reached the surface in
// about a third of a second and died — measured, 15 alive at any moment out of
// a 200 pool, which is a fizz and not a wash. A negative launch plus a
// buoyant acceleration gives a plume that dives, spreads and boils back up,
// which is both what a propeller does and about four times the screen life.
const BUB_LAUNCH_Y = [-0.75, -0.25];   // m/s, downward at birth
const BUB_BUOY = 1.15;                 // m/s^2 upward once the thrust decays
const BUB_VMAX = 0.80;                 // terminal rise
const BUB_HZ = 46;                 // per second at full speed

export function createWakeFoam(opts = {}) {
  const water = opts.water || (() => null);
  const quality = opts.quality || {};
  const rng = makeRng(0x5EAF0A);

  const budget = Math.min(1, Math.max(0.35, quality.geometry ?? 1));
  const nPuff = Math.max(48, Math.round(MAX_PUFFS * budget));
  const nBub = Math.max(40, Math.round(MAX_BUBBLES * budget));

  const group = new THREE.Group();
  group.name = 'wake-foam';

  const uTime = uniform(0);
  const uColor = uniform(new THREE.Color(0xffffff));
  const uOpacity = uniform(1);
  const uBubColor = uniform(new THREE.Color(0xE8F6FF));

  // ---- shared: a unit quad -------------------------------------------------
  const quad = new THREE.PlaneGeometry(1, 1);

  // =========================================================================
  // PUFFS
  // =========================================================================

  const puffGeo = new THREE.InstancedBufferGeometry();
  puffGeo.index = quad.index;
  puffGeo.attributes.position = quad.attributes.position;
  puffGeo.attributes.uv = quad.attributes.uv;
  puffGeo.instanceCount = nPuff;

  // (centre x, y, z, radius)
  const pA = new Float32Array(nPuff * 4);
  // (alpha, seed, spin, squash)
  const pB = new Float32Array(nPuff * 4);
  const pAattr = new THREE.InstancedBufferAttribute(pA, 4);
  const pBattr = new THREE.InstancedBufferAttribute(pB, 4);
  pAattr.setUsage(THREE.DynamicDrawUsage);
  pBattr.setUsage(THREE.DynamicDrawUsage);
  puffGeo.setAttribute('aPuffA', pAattr);
  puffGeo.setAttribute('aPuffB', pBattr);

  const puffMat = new THREE.NodeMaterial();
  puffMat.transparent = true;
  puffMat.depthWrite = false;
  puffMat.depthTest = true;
  puffMat.side = THREE.DoubleSide;
  puffMat.fog = false;
  puffMat.lights = false;
  puffMat.blending = THREE.NormalBlending;

  const aPuffA = attribute('aPuffA', 'vec4');
  const aPuffB = attribute('aPuffB', 'vec4');

  // The quad lies FLAT — the plane's local y becomes world z — and it is spun
  // about the vertical by the puff's own angle so no two marks share an
  // orientation. Squash makes them ellipses drawn out along the track, which
  // is the shape a patch of disturbed water actually is.
  puffMat.positionNode = Fn(() => {
    const c = aPuffA.xyz.toVar();
    const r = aPuffA.w.toVar();
    const spin = aPuffB.z.toVar();
    const squash = aPuffB.w.toVar();
    const q = vec2(positionLocal.x.mul(squash), positionLocal.y).toVar();
    const s = sin(spin).toVar(), k = cos(spin).toVar();
    return vec3(
      c.x.add(q.x.mul(k).sub(q.y.mul(s)).mul(r)),
      c.y,
      c.z.add(q.x.mul(s).add(q.y.mul(k)).mul(r)),
    );
  })();

  puffMat.fragmentNode = Fn(() => {
    const d = uv().sub(0.5).mul(2.0).toVar();
    const r = length(d).toVar();
    const ang = atan(d.y, d.x).toVar();
    const seed = aPuffB.y.toVar();
    const alpha = aPuffB.x.toVar();

    // The hand-drawn outline. Three lobes at coprime frequencies, phased by the
    // puff's seed so every mark is a different shape, and creeping with time so
    // the edge is never still. This is the whole "drawn rather than sampled"
    // idea and it is four transcendentals.
    const wob = float(1.0)
      .add(sin(ang.mul(3.0).add(seed.mul(6.28)).add(uTime.mul(0.9))).mul(0.15))
      .add(sin(ang.mul(5.0).sub(seed.mul(11.7)).sub(uTime.mul(0.6))).mul(0.09))
      .add(sin(ang.mul(8.0).add(seed.mul(21.3)).add(uTime.mul(1.4))).mul(0.05))
      .toVar();

    // A wash with a heavier rim, the way a brush leaves more pigment at the
    // edge of a stroke. The body is deliberately weak — foam is mostly holes.
    const body = smoothstep(wob, wob.mul(0.20), r).toVar();
    const rim = smoothstep(wob.mul(0.55), wob.mul(0.90), r)
      .mul(smoothstep(wob.mul(1.04), wob.mul(0.86), r)).toVar();
    // And a couple of holes punched through the middle, so it is a ring of
    // froth rather than a coin. Cheap: two more lobes tested against radius.
    const hole = smoothstep(0.0, 0.55,
      abs(sin(ang.mul(2.0).add(seed.mul(17.1))).mul(0.5).add(0.5).sub(r))).oneMinus().toVar();

    // Body carries most of it now and the rim is a lift on top rather than an
    // outline. A hard rim over a weak body drew OUTLINED SHAPES — at any size
    // they read as petals, and at the old size you could count them.
    const a = body.mul(0.62).add(rim.mul(0.40))
      .mul(hole.mul(0.22).oneMinus().add(0.78))
      .mul(alpha).mul(uOpacity).toVar();
    return vec4(uColor, a);
  })();

  const puffMesh = new THREE.Mesh(puffGeo, puffMat);
  puffMesh.name = 'wake-puffs';
  puffMesh.frustumCulled = false;
  puffMesh.castShadow = false;
  puffMesh.receiveShadow = false;
  puffMesh.renderOrder = 12;
  group.add(puffMesh);

  // =========================================================================
  // BUBBLES
  // =========================================================================

  const bubGeo = new THREE.InstancedBufferGeometry();
  bubGeo.index = quad.index;
  bubGeo.attributes.position = quad.attributes.position;
  bubGeo.attributes.uv = quad.attributes.uv;
  bubGeo.instanceCount = nBub;

  const bA = new Float32Array(nBub * 4);      // (x, y, z, radius)
  const bB = new Float32Array(nBub * 4);      // (alpha, seed, 0, 0)
  const bAattr = new THREE.InstancedBufferAttribute(bA, 4);
  const bBattr = new THREE.InstancedBufferAttribute(bB, 4);
  bAattr.setUsage(THREE.DynamicDrawUsage);
  bBattr.setUsage(THREE.DynamicDrawUsage);
  bubGeo.setAttribute('aBubA', bAattr);
  bubGeo.setAttribute('aBubB', bBattr);

  const bubMat = new THREE.NodeMaterial();
  bubMat.transparent = true;
  bubMat.depthWrite = false;
  bubMat.depthTest = true;
  bubMat.side = THREE.DoubleSide;
  bubMat.fog = false;
  bubMat.lights = false;

  const aBubA = attribute('aBubA', 'vec4');
  const aBubB = attribute('aBubB', 'vec4');

  // Camera-facing, unlike the puffs: a bubble is a sphere and should be round
  // from wherever you look at it, including from a metre underwater during the
  // fishing beat, which is the shot these exist for.
  bubMat.positionNode = Fn(() => {
    const c = aBubA.xyz.toVar();
    const r = aBubA.w.toVar();
    const toCam = cameraPosition.sub(c).toVar();
    const right = vec3(toCam.z, 0.0, toCam.x.negate()).toVar();
    const rl = length(right).toVar();
    const rn = right.div(max(rl, 1e-4)).toVar();
    const up = vec3(0.0, 1.0, 0.0);
    return c.add(rn.mul(positionLocal.x.mul(r).mul(2.0)))
      .add(up.mul(positionLocal.y.mul(r).mul(2.0)));
  })();

  bubMat.fragmentNode = Fn(() => {
    const d = uv().sub(0.5).mul(2.0).toVar();
    const r = length(d).toVar();
    const seed = aBubB.y.toVar();
    // A bubble is a bright ring with a nearly clear middle and one specular
    // dot up and to one side. Drawing the ring rather than a filled disc is
    // what makes it read as a bubble and not as a snowflake.
    const ring = smoothstep(1.0, 0.86, r).mul(smoothstep(0.58, 0.80, r)).toVar();
    const fill = smoothstep(1.0, 0.2, r).mul(0.13).toVar();
    const hx = d.sub(vec2(sin(seed.mul(9.4)).mul(0.34).sub(0.12), 0.36)).toVar();
    const spec = smoothstep(0.30, 0.06, length(hx)).toVar();
    const a = max(ring.mul(0.85), max(fill, spec.mul(0.9))).mul(aBubB.x).mul(uOpacity).toVar();
    return vec4(uBubColor, a);
  })();

  const bubMesh = new THREE.Mesh(bubGeo, bubMat);
  bubMesh.name = 'wake-bubbles';
  bubMesh.frustumCulled = false;
  bubMesh.castShadow = false;
  bubMesh.receiveShadow = false;
  bubMesh.renderOrder = 11;
  group.add(bubMesh);

  // Puffs are surface marks, so beauty only. Bubbles are UNDER the water and
  // have to appear in the underwater pass as well, or they vanish exactly when
  // the camera goes down to look at them.
  setLayers(puffMesh, LAYER.MAIN);
  setLayers(bubMesh, LAYER.MAIN, LAYER.UNDERWATER);
  group.add(puffMesh);

  // =========================================================================
  // simulation
  // =========================================================================

  const puffs = [];
  for (let i = 0; i < nPuff; i++) {
    puffs.push({ live: false, x: 0, y: 0, z: 0, vx: 0, vz: 0, r0: 0, age: 0, life: 1, seed: 0, spin: 0, squash: 1 });
  }
  const bubbles = [];
  for (let i = 0; i < nBub; i++) {
    bubbles.push({ live: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, r: 0, age: 0, life: 1, seed: 0, wob: 0 });
  }

  let puffAcc = 0;
  let bubAcc = 0;
  let nextPuff = 0;
  let nextBub = 0;

  const surfaceAt = (x, z, t) => (water?.()?.sampleHeight ? water().sampleHeight(x, z, t) : 0);

  function spawnPuff(x, z, vx, vz, strength) {
    const p = puffs[nextPuff];
    nextPuff = (nextPuff + 1) % nPuff;
    p.live = true;
    p.x = x; p.z = z; p.y = 0;
    p.vx = vx; p.vz = vz;
    p.r0 = PUFF_R0[0] + (PUFF_R0[1] - PUFF_R0[0]) * rng.next();
    p.age = 0;
    p.life = (PUFF_LIFE[0] + (PUFF_LIFE[1] - PUFF_LIFE[0]) * rng.next()) * (0.6 + 0.4 * strength);
    p.seed = rng.next();
    p.spin = rng.range(0, TAU);
    p.squash = 1.25 + rng.next() * 0.9;
    p.str = strength;
  }

  function spawnBubble(x, y, z, vx, vz) {
    const b = bubbles[nextBub];
    nextBub = (nextBub + 1) % nBub;
    b.live = true;
    b.x = x + rng.range(-0.12, 0.12);
    b.y = y + rng.range(-0.10, 0.10);
    b.z = z + rng.range(-0.12, 0.12);
    b.vx = vx * rng.range(0.3, 0.9) + rng.range(-0.25, 0.25);
    b.vz = vz * rng.range(0.3, 0.9) + rng.range(-0.25, 0.25);
    b.vy = BUB_LAUNCH_Y[0] + (BUB_LAUNCH_Y[1] - BUB_LAUNCH_Y[0]) * rng.next();
    b.r = BUB_R[0] + (BUB_R[1] - BUB_R[0]) * rng.next() ** 2;
    b.age = 0;
    b.life = BUB_LIFE[0] + (BUB_LIFE[1] - BUB_LIFE[0]) * rng.next();
    b.seed = rng.next();
    b.wob = rng.range(0, TAU);
  }

  function update(ctx) {
    const b = ctx.boat;
    const t = ctx.time;
    const dt = Math.min(0.05, ctx.dt || 0);
    uTime.value = t;

    const speed = Math.abs(b.speed || 0);
    const strength = speed < MIN_SPEED ? 0 : Math.min(1, (speed - MIN_SPEED) / 3.2);

    // The stern, and the lateral unit vector there.
    const sx = b.position.x - b.forward.x * 2.05;
    const sz = b.position.z - b.forward.z * 2.05;
    const lx = -b.forward.z, lz = b.forward.x;

    // ---- spawn puffs, in pairs -------------------------------------------
    // Two at a time, offset either side of the track and pushed OUTWARD, which
    // is what makes the trail spread without a width function and without the
    // two hard lines a Kelvin wedge draws.
    if (strength > 0) {
      puffAcc += dt * SPAWN_HZ * (0.35 + 0.65 * strength);
      while (puffAcc >= 1) {
        puffAcc -= 1;
        for (const side of [-1, 1]) {
          // Anywhere across the band, not at a fixed offset: two fixed offsets
          // draw two lines of blobs no matter how many you spawn.
          const off = side * (0.10 + rng.range(0, 1.35));
          const out = side * rng.range(0.30, 0.75);
          spawnPuff(
            sx + lx * off + rng.range(-0.45, 0.45) - b.forward.x * rng.range(0, 0.9),
            sz + lz * off + rng.range(-0.45, 0.45) - b.forward.z * rng.range(0, 0.9),
            lx * out - b.forward.x * rng.range(0.1, 0.5),
            lz * out - b.forward.z * rng.range(0.1, 0.5),
            strength,
          );
        }
      }

      // ---- and the prop wash -------------------------------------------
      // From the gearcase, which sits about 0.42 m under and 0.5 m aft of the
      // transom mount. Blown backwards and down, then buoyancy takes over.
      bubAcc += dt * BUB_HZ * strength;
      while (bubAcc >= 1) {
        bubAcc -= 1;
        spawnBubble(
          sx - b.forward.x * 0.45 + lx * -0.30,
          -0.44,
          sz - b.forward.z * 0.45 + lz * -0.30,
          -b.forward.x * (0.8 + 1.8 * strength),
          -b.forward.z * (0.8 + 1.8 * strength),
        );
      }
    }

    // ---- integrate puffs ---------------------------------------------------
    for (let i = 0; i < nPuff; i++) {
      const p = puffs[i];
      const o = i * 4;
      if (!p.live) { pA[o + 3] = 0; pB[o] = 0; continue; }
      p.age += dt;
      const u = p.age / p.life;
      if (u >= 1) { p.live = false; pA[o + 3] = 0; pB[o] = 0; continue; }
      // Drift decays: the shove from the hull dies away and the mark then just
      // sits on the water.
      const damp = Math.exp(-p.age * 1.15);
      p.x += p.vx * damp * dt;
      p.z += p.vz * damp * dt;
      const r = p.r0 + PUFF_GROW * Math.sqrt(p.age);
      // In fast, out slow, and the out is cubed so most of the life is spent
      // faint — foam is mostly a memory of foam.
      const fade = u < 0.12 ? u / 0.12 : (1 - (u - 0.12) / 0.88) ** 2.2;
      pA[o] = p.x;
      pA[o + 1] = surfaceAt(p.x, p.z, t) + PUFF_LIFT;
      pA[o + 2] = p.z;
      pA[o + 3] = r;
      pB[o] = fade * (0.45 + 0.55 * p.str);
      pB[o + 1] = p.seed;
      pB[o + 2] = p.spin + p.age * 0.25;      // a slow tumble
      pB[o + 3] = p.squash;
    }

    // ---- integrate bubbles -------------------------------------------------
    for (let i = 0; i < nBub; i++) {
      const bb = bubbles[i];
      const o = i * 4;
      if (!bb.live) { bA[o + 3] = 0; bB[o] = 0; continue; }
      bb.age += dt;
      const u = bb.age / bb.life;
      const surf = surfaceAt(bb.x, bb.z, t);
      if (u >= 1 || (bb.age > 0.25 && bb.y > surf - 0.02)) { bb.live = false; bA[o + 3] = 0; bB[o] = 0; continue; }
      const damp = Math.exp(-bb.age * 1.6);
      bb.x += (bb.vx * damp + Math.sin(t * 3.1 + bb.wob) * 0.16) * dt;
      bb.z += (bb.vz * damp + Math.cos(t * 2.7 + bb.wob * 1.7) * 0.16) * dt;
      bb.vy = Math.min(BUB_VMAX, bb.vy + BUB_BUOY * dt);
      bb.y += bb.vy * dt;
      bA[o] = bb.x;
      bA[o + 1] = bb.y;
      bA[o + 2] = bb.z;
      bA[o + 3] = bb.r;
      // Fades as it nears the surface as well as with age, so they pop rather
      // than sliding through the ceiling.
      const near = Math.min(1, (surf - bb.y) / 0.35);
      bB[o] = Math.min(1, (1 - u) * 1.6) * near;
      bB[o + 1] = bb.seed;
    }

    pAattr.needsUpdate = true;
    pBattr.needsUpdate = true;
    bAattr.needsUpdate = true;
    bBattr.needsUpdate = true;
  }

  function applyEnv(env) {
    if (!env) return;
    // The marks take the light rather than being lit: they are alpha over the
    // water and a white that ignores the hour reads as paper at dusk.
    const k = 0.36 + 0.64 * (env.dayFactor ?? 1);
    uColor.value.copy(env.foamTint ?? new THREE.Color(0xffffff)).multiplyScalar(k);
    uBubColor.value.setRGB(0.88 * k + 0.12, 0.94 * k + 0.06, 1.0 * k);
    uOpacity.value = 0.55 + 0.45 * (env.dayFactor ?? 1);
  }

  return {
    group,
    update,
    applyEnv,
    uniforms: { uColor, uOpacity, uBubColor },
    dispose() {
      quad.dispose();
      puffGeo.dispose(); bubGeo.dispose();
      puffMat.dispose(); bubMat.dispose();
    },
  };
}
