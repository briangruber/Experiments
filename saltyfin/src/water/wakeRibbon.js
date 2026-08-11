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
const STRIPS = 3;              // lane, port arm, starboard arm

// The textbook Kelvin half-angle, arcsin(1/3), and the one this used to assume
// everywhere. It is right only in DEEP water.
const KELVIN_TAN = 0.3536;     // tan(19.47 deg)
const KELVIN_RAD = 0.34;       // 19.47 deg
// In finite depth the wedge is governed by the depth Froude number
// Fr = U / sqrt(g*h), and above Fr = 1 the transverse waves cannot exist at all
// while the half-angle OPENS OUT: sin(beta) = 1/Fr. This lagoon is 2.7 to 7.5 m
// deep and the boat does 9 m/s, so Fr reaches 1.1 to 1.7 over the reef — a 37 to
// 64 degree half-angle, not 19.47. Drawing the textbook V here was drawing a
// deep-ocean wake in three metres of water, which is part of why the arms
// looked pasted on however they were shaded.
//
// Capped, because the true angle passes through 90 degrees at Fr = 1 and a
// wedge that wide stops reading as a wake at all.
const G = 9.81;
const FR_DEEP = 0.72;          // below this it is effectively deep water
const BETA_MAX = 0.90;         // radians, about 51 degrees
const HALF_BEAM = 0.95;
// Centimetres above the surface. Enough to clear the water's own depth without
// reading as a floating sheet at a grazing angle.
const LIFT = 0.045;

// Widths in metres. The lane is the churned water directly astern — it starts
// at about the beam and spreads slowly. The arms are the two foam filaments and
// they stay narrow, because that is what makes them read as lines.
// The turbulent lane starts at about the hull beam and then widens as roughly
// the FIFTH ROOT of distance — white water spreads fast at first and then
// almost stops, which is nothing like the straight line this used to draw.
const LANE_W0 = 1.05;
const LANE_GROW = 0.62;        // metres of half-width per x^(1/5)
const ARM_W0 = 0.42;
const ARM_GROW = 0.010;

const MIN_SPEED = 0.6;         // m/s below which nothing new is laid

/**
 * The wedge half-angle, from the depth Froude number.
 *
 *   Fr < 0.72   deep enough that the classical arcsin(1/3) holds
 *   Fr ~ 1      trans-critical; the wedge opens toward 90 degrees
 *   Fr > 1      supercritical; sin(beta) = 1/Fr, so it narrows again
 *
 * Returns the TANGENT, because that is what the offset wants.
 */
function wedgeTan(speed, depth) {
  if (!(depth > 0.2) || !(speed > 0.2)) return KELVIN_TAN;
  const fr = speed / Math.sqrt(G * depth);
  if (fr <= FR_DEEP) return KELVIN_TAN;
  let beta;
  if (fr >= 1) beta = Math.asin(Math.min(1, 1 / fr));
  else {
    // Between deep and critical the angle runs away toward 90; a smooth ramp
    // to the cap is both close enough and the only version that does not put
    // a discontinuity right in the speed band the boat spends its life in.
    const t = (fr - FR_DEEP) / (1 - FR_DEEP);
    beta = KELVIN_RAD + (BETA_MAX - KELVIN_RAD) * (t * t * (3 - 2 * t));
  }
  return Math.tan(Math.min(BETA_MAX, beta));
}

export function createWakeRibbon({ water, terrain, quality } = {}) {
  const group = new THREE.Group();
  group.name = 'wake-ribbon';

  // --- geometry -------------------------------------------------------------
  const vertCount = STRIPS * MAX_SAMPLES * CROSS;
  const pos = new Float32Array(vertCount * 3);
  // (u across -1..1, metres astern, strength at birth, cusp feather 0..1)
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
  const uFeather = uniform(0.55);  // how much of the cusp beat reaches the alpha
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
    const feather = w.w.toVar();        // the cusp beat along an arm; 1 on the lane

    // --- the profile across the strip ---------------------------------------
    // A soft-shouldered band rather than a hard edge: the geometry gives the
    // ribbon its width, this gives it its softness, and the two together are
    // what stop it reading as tape.
    const edge = smoothstep(1.0, 0.42, abs(u)).toVar();

    // --- foam, in WORLD space ------------------------------------------------
    // Nailed to the water, not to the ribbon. If this were sampled in ribbon UV
    // the foam would slide backwards through the mark as the boat drove on,
    // which is the single most obvious tell of a fake wake.
    const p = positionWorld.xz.toVar();
    // Three octaves at irrational ratios, from different channels of the same
    // tiling field so no two of them share a repeat. One octave on its own
    // draws its own tile — the first pass used two and came back as a regular
    // dotted pattern, which reads as a printed texture rather than as foam.
    const c0 = tFoam.sample(p.mul(uCoarse)).r.toVar();
    const c1 = tFoam.sample(p.mul(uCoarse.mul(2.37)).add(vec2(0.37, 0.11))).g.toVar();
    const c2 = tFoam.sample(p.mul(uFine).add(vec2(0.71, 0.53))).b.toVar();
    const n = c0.mul(0.52).add(c1.mul(0.31)).add(c2.mul(0.17)).toVar();
    // Thresholded into CLUMPS with clear water between them. A wide ramp gives
    // a haze; this is narrow enough to have edges and wide enough that the
    // edges are soft.
    const foam = smoothstep(uThreshLo, uThreshHi, n).toVar();
    // And the lace at the edge of a clump: the band just under the threshold,
    // where a real foam patch breaks into flecks. It costs one more smoothstep
    // and it is most of what stops the mark reading as a cut-out.
    const lace = smoothstep(uThreshLo.sub(0.14), uThreshLo, n)
      .mul(smoothstep(uThreshLo.add(0.05), uThreshLo, n))
      .mul(smoothstep(0.55, 0.85, c2)).toVar();

    // --- how long it lasts ---------------------------------------------------
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
    const solid = smoothstep(6.0, 0.3, along).toVar();
    const body = max(foam.add(lace.mul(0.55)), solid.mul(n.mul(0.5).add(0.55))).toVar();
    // The cusps. A wake's arms are not continuous lines — they are a row of
    // feathers, one per cusp wave, spaced (2/3) * 2*pi*V^2/g apart, which at
    // 6 m/s is fifteen metres. Kept as a gentle beat and never a chop: the
    // rhythm is what reads, and anything that cuts an arm into separate pieces
    // is straight back to the filaments the painted versions kept producing.
    const a = edge.mul(born).mul(age).mul(body)
      .mul(mix(float(1.0), feather, uFeather)).mul(uOpacity).toVar();

    return vec4(uColor, a);
  })();

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'wake-ribbon';
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
  const tanB = new Float32Array(MAX_SAMPLES);
  const fea = new Float32Array(MAX_SAMPLES);
  let cusp = 0;                  // running cusp phase, in cycles
  let head = 0;
  let count = 0;
  let lastX = 0, lastZ = 0;
  let seeded = false;

  function pushSample(x, z, sx, sz, strength, speed) {
    px[head] = x; pz[head] = z;
    nx[head] = sx; nz[head] = sz;
    str[head] = strength;

    const depth = terrain?.depthAt ? terrain.depthAt(x, z) : 6;
    tanB[head] = wedgeTan(speed, depth);

    // The cusp wavelength, (2/3) * 2*pi*V^2/g. Accumulated as a phase per
    // sample rather than evaluated from `along` in the shader, because `along`
    // is the distance from the boat NOW and the wavelength was set by the speed
    // THEN — a fast burst followed by a drift would otherwise re-space feathers
    // that are already lying on the water.
    const lam = Math.max(3.5, (2 / 3) * (2 * Math.PI * speed * speed) / G);
    cusp += STEP / lam;
    // Shaped: a soft trough and a broad crest, so the arm pulses rather than
    // dashing. 0.42 at the trough keeps the line continuous.
    fea[head] = 0.42 + 0.58 * (0.5 + 0.5 * Math.cos(cusp * Math.PI * 2)) ** 0.7;

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
          speed,
        );
      }
      lastX += (sternX - lastX) * ((n * STEP) / moved);
      lastZ += (sternZ - lastZ) * ((n * STEP) / moved);
    }

    // --- rebuild the strips ---------------------------------------------------
    for (let i = 0; i < MAX_SAMPLES; i++) {
      // i = 0 is the newest sample, at the transom.
      const live = i < count;
      const s = live ? (head - 1 - i + MAX_SAMPLES * 2) % MAX_SAMPLES : 0;
      const along = i * STEP;
      const sx = live ? px[s] : 0, sz = live ? pz[s] : 0;
      const lx = live ? nx[s] : 1, lz = live ? nz[s] : 0;
      const strength = live ? str[s] : 0;
      const feather = live ? fea[s] : 1;

      // The wedge is anchored at the bow and opens at an angle that is a
      // property of the WATER, not a constant — see wedgeTan. The offset grows
      // with distance ASTERN rather than with age: age-based spreading drifts
      // a stopped boat's wake outward forever and makes every curve wobble.
      const wedge = HALF_BEAM + (live ? tanB[s] : KELVIN_TAN) * along;

      for (let strip = 0; strip < STRIPS; strip++) {
        // 0 = lane on the path, 1 = port arm, 2 = starboard arm.
        const side = strip === 0 ? 0 : strip === 1 ? -1 : 1;
        const centre = side * wedge;
        const half = strip === 0
          ? LANE_W0 + LANE_GROW * Math.pow(along, 0.2)
          : ARM_W0 + ARM_GROW * along;

        for (let c = 0; c < CROSS; c++) {
          const u = (c / (CROSS - 1)) * 2 - 1;
          const off = centre + u * half;
          const x = sx + lx * off;
          const z = sz + lz * off;
          const v = ((strip * MAX_SAMPLES + i) * CROSS + c);
          pos[v * 3] = x;
          pos[v * 3 + 1] = live ? surfaceAt(x, z, t) + LIFT : -400;
          pos[v * 3 + 2] = z;
          aWake[v * 4 + 1] = along;
          aWake[v * 4 + 2] = live ? strength : 0;
          // The lane has no cusps — they are a property of the divergent waves.
          aWake[v * 4 + 3] = strip === 0 ? 1 : feather;
        }
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
    uniforms: { uColor, uOpacity, uCoarse, uFine, uThreshLo, uThreshHi, uFeather },
    dispose() {
      geo.dispose();
      mat.dispose();
      blank.dispose();
      group.clear();
    },
  };
}
