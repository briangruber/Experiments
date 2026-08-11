// The wake, as geometry.
//
// This is the sixth attempt and the first one that is not painted into the
// water shader, because the previous five all failed for the same reason and it
// was never the tuning. The wake simulation field is 0.5 m per texel on desktop
// and 1.0 m on a phone. Real wake foam has structure at 10-20 cm. You cannot cut
// a crisp mark out of a field four times coarser than the mark: threshold it low
// and it floods into two solid ski tracks, threshold it high and it disappears,
// and every clever middle — contour noise, Reinhard knees, erosion, a mottle —
// turns into scribbles or a lozenge. There is no number that fixes a resolution.
//
// So the wake is a RIBBON MESH that follows the boat's path. Three strips in one
// geometry: the churned lane astern, and the two divergent arms of the Kelvin
// wedge. They carry real UVs, so the foam inside them has whatever resolution
// the texture has rather than whatever the sim has, and their EDGES are edges —
// the width of an arm is a number in metres here, not an accident of where a
// blurry field happens to cross a threshold.
//
// Three things this has to get right that a painted wake never had to:
//
//   IT MUST LIE ON THE WAVES. Every vertex takes its height from
//   water.sampleHeight, the same Gerstner train the surface itself uses, plus a
//   few centimetres of lift. A flat ribbon over a moving sea reads as a sticker
//   instantly.
//
//   IT MUST NOT SWIM. The foam texture is sampled in WORLD space, not in ribbon
//   UV. A sample's x and z never change once recorded — only its height follows
//   the swell — so world-space foam is nailed to the water and the mark stays
//   where it was laid down while the boat drives away from it.
//
//   IT MUST NOT PINCH. On a hard turn the inside edge of a widening ribbon can
//   cross itself and fold into a bright knot. The lateral offset is clamped
//   against the local turn radius, which is what keeps the inside edge outside
//   the centre of the turn.

import * as THREE from 'three';
import {
  Fn, texture, uniform, vec2, vec3, vec4, float,
  max, min, mix, pow, smoothstep, abs, positionWorld, attribute,
} from 'three/tsl';
import { LAYER, setLayers } from '../core/layers.js';

// One sample every this many metres of travel. 0.45 m gives 22 cross-sections
// in the first ten metres, which is where all the shape is; coarser than about
// 0.7 and a hard turn visibly polygonises.
const STEP = 0.45;
// How long the trail is. 70 m at 9 m/s is about eight seconds of wake, which is
// roughly how long a small boat's foam stays white in calm water.
const LENGTH = 70;
const MAX_SAMPLES = Math.ceil(LENGTH / STEP) + 2;
// Vertices across each strip. Two would do — the fragment shader has u and can
// shape the profile itself — but five lets the geometry itself carry the
// widening, which keeps the texture from stretching on the outer half.
const CROSS = 5;
const STRIPS = 1;              // just the lane. See below.

// The Kelvin V is GONE, and with it wedgeTan, the depth Froude number, the
// cusp beat and the two arm strips that carried them.
//
// It was correct and it looked wrong. Two narrow filaments held at a computed
// angle off the hull read as two painted lines no matter how they were shaded
// — the angle is right, the physics behind it is right, and the eye still sees
// a decal. What a small boat actually leaves at a glance is one churned lane
// that spreads, breaks into lace and dissolves, so that is all this draws now.
//
// Centimetres above the surface. Enough to clear the water's own depth without
// reading as a floating sheet at a grazing angle.
const LIFT = 0.045;

// The lane starts about a beam wide and spreads as the FIFTH ROOT of distance
// — white water widens fast at first and then almost stops. It is wider than
// it was because it is now the whole wake rather than the middle third of one:
// 1.25 m at the transom out to about 3.7 m of half-width at the tail.
const LANE_W0 = 1.25;
const LANE_GROW = 1.05;        // metres of half-width per x^(1/5)

const MIN_SPEED = 0.6;         // m/s below which nothing new is laid
// Seconds a section of wake stays on the water.
//
// The first version had no clock in it at all: the fade was a function of
// distance astern, and distance astern only grows while the boat is moving. So
// the moment you throttled off, the whole trail froze exactly as it was and sat
// there for ever. Foam dissolves on its own schedule — this is what makes it go
// away when the boat stops, and what makes the tail end rather than simply run
// out of ribbon.
const LIFE = 10.0;


export function createWakeRibbon({ water, terrain, quality } = {}) {
  const group = new THREE.Group();
  group.name = 'wake-ribbon';

  // --- geometry -------------------------------------------------------------
  const vertCount = STRIPS * MAX_SAMPLES * CROSS;
  const pos = new Float32Array(vertCount * 3);
  // (u across -1..1, metres astern, strength at birth, unused)
  const aWake = new Float32Array(vertCount * 4);

  const quads = STRIPS * (MAX_SAMPLES - 1) * (CROSS - 1);
  const idx = new Uint32Array(quads * 6);
  let k = 0;
  for (let s = 0; s < STRIPS; s++) {
    const base = s * MAX_SAMPLES * CROSS;
    for (let i = 0; i < MAX_SAMPLES - 1; i++) {
      for (let c = 0; c < CROSS - 1; c++) {
        const a = base + i * CROSS + c;
        const b = a + 1;
        const d = a + CROSS;
        const e = d + 1;
        idx[k++] = a; idx[k++] = d; idx[k++] = b;
        idx[k++] = b; idx[k++] = d; idx[k++] = e;
      }
    }
  }
  for (let s = 0; s < STRIPS; s++) {
    for (let i = 0; i < MAX_SAMPLES; i++) {
      for (let c = 0; c < CROSS; c++) {
        const v = (s * MAX_SAMPLES + i) * CROSS + c;
        aWake[v * 4] = (c / (CROSS - 1)) * 2 - 1;
        aWake[v * 4 + 1] = i * STEP;
        aWake[v * 4 + 2] = 0;
        aWake[v * 4 + 3] = 1;
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(pos, 3);
  posAttr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', posAttr);
  const wakeAttr = new THREE.BufferAttribute(aWake, 4);
  wakeAttr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aWake', wakeAttr);
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  // The ribbon moves with the boat and is only ever a few tens of metres long;
  // a bounding sphere would have to be recomputed every frame to be right, and
  // it would never usefully cull.
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

  // --- material -------------------------------------------------------------
  const blank = new THREE.DataTexture(
    new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType,
  );
  blank.colorSpace = THREE.NoColorSpace;
  blank.wrapS = blank.wrapT = THREE.RepeatWrapping;
  blank.needsUpdate = true;
  const tFoam = texture(blank);

  const uTime = uniform(0);
  const uColor = uniform(new THREE.Color(0xffffff));
  const uOpacity = uniform(1);
  const uCoarse = uniform(0.20);   // world cycles/m of the big foam patches
  const uFine = uniform(1.20);     // and of the flecks inside them
  // How far the foam threshold climbs from transom to tail. This is the fade.
  const uErode = uniform(0.30);
  const uThreshLo = uniform(0.44);
  const uThreshHi = uniform(0.62);

  const mat = new THREE.NodeMaterial();
  mat.name = 'SaltyFinWakeRibbon';
  mat.transparent = true;
  mat.depthWrite = false;
  mat.depthTest = true;
  mat.side = THREE.DoubleSide;
  mat.fog = false;
  mat.lights = false;
  mat.blending = THREE.NormalBlending;

  mat.fragmentNode = Fn(() => {
    const w = attribute('aWake', 'vec4').toVar();
    const u = w.x.toVar();              // -1..1 across the strip
    const along = w.y.toVar();          // metres astern
    const born = w.z.toVar();           // 0..1 strength when this section was laid

    // --- the profile across the lane ----------------------------------------
    // Soft-shouldered, and softer at the outside than it was: the lane is the
    // whole wake now, so its edge is where the mark meets clear water and a
    // crisp one reads as tape.
    const edge = smoothstep(1.0, 0.30, abs(u)).toVar();

    // --- foam, in WORLD space ------------------------------------------------
    // Nailed to the water, not to the ribbon. If this were sampled in ribbon UV
    // the foam would slide backwards through the mark as the boat drove on,
    // which is the single most obvious tell of a fake wake.
    const p = positionWorld.xz.toVar();
    // Three octaves at irrational ratios, from different channels of the same
    // tiling field so no two of them share a repeat. The finest one CRAWLS —
    // a slow drift, not a scroll — which is what makes the lace boil in place
    // instead of sitting there like a decal. Static noise on a static mark is
    // the difference between foam and a printed texture, and it costs one add.
    const drift = vec2(uTime.mul(0.021), uTime.mul(-0.014)).toVar();
    const c0 = tFoam.sample(p.mul(uCoarse)).r.toVar();
    const c1 = tFoam.sample(p.mul(uCoarse.mul(2.37)).add(vec2(0.37, 0.11))).g.toVar();
    const c2 = tFoam.sample(p.mul(uFine).add(vec2(0.71, 0.53)).add(drift)).b.toVar();
    const n = c0.mul(0.46).add(c1.mul(0.30)).add(c2.mul(0.24)).toVar();

    // --- how long it lasts, and HOW it goes ----------------------------------
    // The fade is not an opacity ramp. Foam does not dim — it breaks up. So the
    // threshold RISES along the trail: near the transom almost everything is
    // above it and the mark is solid white water; by the tail only the very
    // brightest flecks clear it, and what is left is a scatter of lace that
    // then runs out. The alpha ramp still exists underneath, but the erosion is
    // what the eye actually reads as "dissolving".
    const decay = smoothstep(0.0, LENGTH * 0.85, along).toVar();
    const lo = uThreshLo.add(decay.mul(uErode)).toVar();
    const hi = uThreshHi.add(decay.mul(uErode)).toVar();

    // Clumps, and the lace at their edges: the band just under the threshold,
    // where a real foam patch breaks into flecks. The lace is weighted UP as
    // the clumps erode away, so the tail is all lace and no body.
    const foam = smoothstep(lo, hi, n).toVar();
    const lace = smoothstep(lo.sub(0.16), lo, n)
      .mul(smoothstep(lo.add(0.06), lo, n))
      .mul(smoothstep(0.42, 0.80, c2)).toVar();

    // Fast in for the first half metre so nothing pops at the transom, then a
    // long tail. Squared, because foam dies by dissolving rather than by
    // dimming evenly.
    const life = smoothstep(LENGTH, 0.0, along).toVar();
    const fadeIn = smoothstep(0.0, 0.6, along).toVar();
    const age = life.mul(life).mul(fadeIn).toVar();

    // The churn right at the transom is white WATER rather than foam — but it
    // still boils, so it is a high floor under the noise rather than a plate.
    // A flat plate welded to the stern is what the painted versions all ended
    // up as and it is the single most recognisable way to get this wrong.
    // Shorter and much more broken than it was. At 5 m long with a 0.55 floor
    // under the noise this came out as a hard white slab welded to the transom
    // — the exact failure the paragraph above is about, reintroduced by me the
    // moment the arms were removed and the lane became the whole wake. 2.6 m,
    // and the noise now carries almost all of it, so the churn boils instead
    // of being a plate.
    const solid = smoothstep(2.6, 0.2, along).toVar();
    const body = max(
      foam.add(lace.mul(mix(float(0.7), float(1.9), decay))),
      solid.mul(n.mul(0.9).add(0.16)),
    ).toVar();

    const a = edge.mul(born).mul(age).mul(body).mul(uOpacity).toVar();

    return vec4(uColor, a);
  })();

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'wake-ribbon-mesh';
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  // After the water, which is opaque and writes depth. depthWrite is off here,
  // so the ribbon never occludes anything and never fights the surface.
  mesh.renderOrder = 12;
  group.add(mesh);
  // Beauty pass only. It must not appear in the refraction texture, which is a
  // view from ABOVE the water of what is below it, and there is nothing to
  // reflect it in.
  setLayers(group, LAYER.MAIN);

  // --- the path -------------------------------------------------------------
  // A ring buffer of where the boat has been: position, the lateral unit vector
  // at that moment, and how hard it was working.
  const px = new Float32Array(MAX_SAMPLES);
  const pz = new Float32Array(MAX_SAMPLES);
  const nx = new Float32Array(MAX_SAMPLES);
  const nz = new Float32Array(MAX_SAMPLES);
  const str = new Float32Array(MAX_SAMPLES);
  const bt = new Float32Array(MAX_SAMPLES);
  let head = 0;
  let count = 0;
  let lastX = 0, lastZ = 0;
  let seeded = false;

  function pushSample(x, z, sx, sz, strength, speed, now) {
    px[head] = x; pz[head] = z;
    nx[head] = sx; nz[head] = sz;
    str[head] = strength;
    bt[head] = now;

    head = (head + 1) % MAX_SAMPLES;
    if (count < MAX_SAMPLES) count++;
  }

  const surfaceAt = (x, z, t) => (water?.()?.sampleHeight ? water().sampleHeight(x, z, t) : 0);

  function update(ctx) {
    const b = ctx.boat;
    const t = ctx.time;
    uTime.value = t;

    // The stern, which is where a wake starts.
    const sternX = b.position.x - b.forward.x * 2.0;
    const sternZ = b.position.z - b.forward.z * 2.0;

    if (!seeded) {
      lastX = sternX; lastZ = sternZ; seeded = true;
    }

    const speed = Math.abs(b.speed);
    const moved = Math.hypot(sternX - lastX, sternZ - lastZ);
    if (moved >= STEP) {
      // One sample per STEP even if the boat covered several in a frame, so a
      // frame hitch cannot leave a gap in the ribbon.
      const n = Math.min(6, Math.floor(moved / STEP));
      const dx = (sternX - lastX) / moved, dz = (sternZ - lastZ) / moved;
      for (let i = 1; i <= n; i++) {
        const f = (i * STEP) / moved;
        pushSample(
          lastX + (sternX - lastX) * f,
          lastZ + (sternZ - lastZ) * f,
          -dz, dx,
          speed < MIN_SPEED ? 0 : Math.min(1, (speed - MIN_SPEED) / 3.4),
          speed, t,
        );
      }
      lastX += (sternX - lastX) * ((n * STEP) / moved);
      lastZ += (sternZ - lastZ) * ((n * STEP) / moved);
    }

    // How far past the last stored sample the boat is, as a fraction of a step.
    // THIS IS THE WHOLE FIX FOR THE STUTTER.
    //
    // `along` used to be `i * STEP` — a per-index constant. A new sample is only
    // stored every 0.45 m, and the instant one is, every existing section's
    // index goes up by one and its `along` jumps by a whole 0.45 m at once. Every
    // quantity derived from it jumped with it: the wedge offset, the lane width,
    // the fade, the cusp spacing. At nine metres a second that is a discrete
    // shove twenty times a second, which is exactly the stepping. Carrying the
    // fraction makes `along` slide continuously between samples, and because a
    // section at frac = 1 lands on precisely the position the next index gives
    // it at frac = 0, the hand-off is seamless.
    const frac = Math.min(1, Math.hypot(sternX - lastX, sternZ - lastZ) / STEP);
    const nowStr = speed < MIN_SPEED ? 0 : Math.min(1, (speed - MIN_SPEED) / 3.4);

    // --- rebuild the strips ---------------------------------------------------
    for (let i = 0; i < MAX_SAMPLES; i++) {
      // Row 0 is the LIVE transom, not the newest stored sample. Pinning the
      // head of the ribbon to a sample that is up to a step behind the boat is
      // the other half of the stutter: the join would drift back from the hull
      // and then snap forward every time a sample was laid.
      let live, sx, sz, lx, lz, strength, along, born;
      if (i === 0) {
        live = true;
        sx = sternX; sz = sternZ;
        lx = -b.forward.z; lz = b.forward.x;
        strength = nowStr;
        along = 0;
        born = 1;
      } else {
        const j = i - 1;
        live = j < count;
        const s = live ? (head - 1 - j + MAX_SAMPLES * 2) % MAX_SAMPLES : 0;
        along = (frac + j) * STEP;
        sx = live ? px[s] : 0; sz = live ? pz[s] : 0;
        lx = live ? nx[s] : 1; lz = live ? nz[s] : 0;
        strength = live ? str[s] : 0;
        // Foam dissolves on a clock, not on a distance. Held for the first
        // third of its life and gone by the end of it, so a wake left behind by
        // a boat that has stopped still goes away.
        const age = live ? (t - bt[s]) / LIFE : 1;
        const q = Math.min(1, Math.max(0, (age - 0.30) / 0.70));
        born = live ? 1 - q * q * (3 - 2 * q) : 0;
      }

      const half = LANE_W0 + LANE_GROW * Math.pow(along, 0.2);

      for (let c = 0; c < CROSS; c++) {
        const u = (c / (CROSS - 1)) * 2 - 1;
        const off = u * half;
        const x = sx + lx * off;
        const z = sz + lz * off;
        const v = (i * CROSS + c);
        pos[v * 3] = x;
        pos[v * 3 + 1] = live ? surfaceAt(x, z, t) + LIFT : -400;
        pos[v * 3 + 2] = z;
        aWake[v * 4 + 1] = along;
        aWake[v * 4 + 2] = live ? strength * born : 0;
        aWake[v * 4 + 3] = 1;
      }
    }
    posAttr.needsUpdate = true;
    wakeAttr.needsUpdate = true;
  }

  function applyEnv(env) {
    if (!env) return;
    // Foam is a diffuse white scatterer lit by the whole dome, so it tracks the
    // ambient rather than the key — at sunset a wake is still the brightest
    // thing outside the light path, and at night it is nearly gone.
    const lit = 0.30 + 0.70 * env.dayFactor;
    uColor.value.copy(env.foamTint).multiplyScalar(0.86 + 0.14 * env.dayFactor);
    uOpacity.value = 0.70 * lit + 0.08;
  }

  return {
    group,
    update,
    applyEnv,
    /** The foam texture, swapped in once the water has built its detail field. */
    setFoamTexture(tex) { if (tex) tFoam.value = tex; },
    uniforms: { uColor, uOpacity, uCoarse, uFine, uThreshLo, uThreshHi, uErode },
    dispose() {
      geo.dispose();
      mat.dispose();
      blank.dispose();
      group.clear();
    },
  };
}
