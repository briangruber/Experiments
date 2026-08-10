// Everything that changes when the camera goes under.
//
// The renderer already knew about `ctx.cameraUnderwater` — post.js tints the
// composite with it — but a tint is not a submersion. Put the camera at −1.6 m
// with only that and you get the scene as lit from above with a blue filter on
// it: the seabed runs to the horizon with no falloff, the hull is a black
// silhouette because nothing fills the shadow side, and the whole frame has the
// contrast of a daylight shot. Water does three things that a filter cannot.
//
//   1. It EATS light with distance. Two metres of clear tropical water is
//      nothing; thirty is a wall. That is fog, and it is most of the effect —
//      it is what gives an underwater shot its depth and its scale.
//   2. It flattens the light. The sun arrives as a soft dome through a rough
//      ceiling instead of as a hard key, and the water itself glows, so the
//      shadow side of everything lifts.
//   3. It is FULL OF STUFF. Perfectly clear water renders as vacuum. The motes
//      are what make it read as a fluid you are inside of rather than as a
//      tinted void, and they are the cheapest thing in this file.
//
// This module owns all three. It reaches into the lights and the fog that
// main.js set from the environment preset and blends them toward a submerged
// set by `amount`, so the transition through the surface is continuous and
// nothing here has to know how the presets are built. Call it AFTER
// applyEnvToLights() — it is a modifier on that result, not a replacement.
//
// It also owns the mote field, which follows the camera and wraps, so a fixed
// budget of quads covers wherever you are.

import * as THREE from 'three';
import {
  Fn, uniform, vec2, vec3, vec4, float,
  max, mix, pow, smoothstep, fract, sin, abs, normalize, length,
  cameraPosition, cameraViewMatrix, cameraProjectionMatrix, positionGeometry,
  attribute, varyingProperty,
} from 'three/tsl';
import { LAYER, setLayers } from '../core/layers.js';
import { makeRng } from '../core/rng.js';

// How far you can see. Near is where the haze starts, far is where it has
// closed completely. Real clear tropical water at 30 m of visibility is the
// upper end of what a diver ever gets; the lagoon here is deliberately at the
// clear end of plausible because the whole point of the place is that you can
// see into it. These are the DAY numbers — night scales them down hard, since
// the only light down there is a lantern and the moon.
const FOG_NEAR = 3.0;
const FOG_FAR = 46.0;

// Motes. 260 quads is 520 triangles, which is a rounding error against a 40k
// seabed, and it is the single biggest change to whether the frame reads as
// water. They live in a cube that follows the camera and wraps, so density is
// constant wherever you are and none of them is ever behind you for long.
const MOTE_COUNT = 260;
const MOTE_BOX = 22;          // metres, cube edge
const MOTE_SIZE = [0.012, 0.052];

// Light shafts. Six long, soft, additive blades hanging from the ceiling along
// the sun's bearing. Not a volumetric — a volumetric at this budget is a grey
// smear — but six blades with a strong vertical gradient and a slow sway read
// as god rays at every framing I have shot them at, and they cost six quads.
const SHAFT_COUNT = 7;
const SHAFT_SPAN = 15.0;      // metres the fan is spread across
const SHAFT_LEN = 26.0;

/** Cheap 2D hash, matched between the mote geometry and its shader. */
function buildMotes(rng) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(MOTE_COUNT * 4 * 3);      // corner offsets, unused as position
  const centre = new Float32Array(MOTE_COUNT * 4 * 3);
  const corner = new Float32Array(MOTE_COUNT * 4 * 2);
  const seed = new Float32Array(MOTE_COUNT * 4);
  const idx = new Uint16Array(MOTE_COUNT * 6);

  const CO = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  for (let i = 0; i < MOTE_COUNT; i++) {
    const cx = (rng.next() - 0.5) * MOTE_BOX;
    const cy = (rng.next() - 0.5) * MOTE_BOX;
    const cz = (rng.next() - 0.5) * MOTE_BOX;
    // Size in the seed's fractional part is a trick that keeps the attribute
    // count down; the shader pulls both out of it.
    const s = MOTE_SIZE[0] + (MOTE_SIZE[1] - MOTE_SIZE[0]) * rng.next() ** 2.2;
    for (let c = 0; c < 4; c++) {
      const v = i * 4 + c;
      pos[v * 3] = 0; pos[v * 3 + 1] = 0; pos[v * 3 + 2] = 0;
      centre[v * 3] = cx; centre[v * 3 + 1] = cy; centre[v * 3 + 2] = cz;
      corner[v * 2] = CO[c][0] * s;
      corner[v * 2 + 1] = CO[c][1] * s;
      seed[v] = i * 0.61803398875;
    }
    const b = i * 4;
    idx.set([b, b + 1, b + 2, b, b + 2, b + 3], i * 6);
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aCentre', new THREE.BufferAttribute(centre, 3));
  geo.setAttribute('aCorner', new THREE.BufferAttribute(corner, 2));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), MOTE_BOX);
  return geo;
}

function buildShafts() {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(SHAFT_COUNT * 4 * 3);
  const uvs = new Float32Array(SHAFT_COUNT * 4 * 2);
  const seed = new Float32Array(SHAFT_COUNT * 4);
  const idx = new Uint16Array(SHAFT_COUNT * 6);
  for (let i = 0; i < SHAFT_COUNT; i++) {
    const t = SHAFT_COUNT === 1 ? 0.5 : i / (SHAFT_COUNT - 1);
    const x = (t - 0.5) * SHAFT_SPAN;
    // Blades widen as they fall, like a beam through a rough ceiling does.
    const w0 = 0.28 + 0.42 * ((i * 7919) % 13) / 13;
    const w1 = w0 * 2.6;
    const quad = [[x - w0, 0], [x + w0, 0], [x + w1, -SHAFT_LEN], [x - w1, -SHAFT_LEN]];
    for (let c = 0; c < 4; c++) {
      const v = i * 4 + c;
      pos[v * 3] = quad[c][0];
      pos[v * 3 + 1] = quad[c][1];
      pos[v * 3 + 2] = 0;
      uvs[v * 2] = c === 0 || c === 3 ? 0 : 1;
      uvs[v * 2 + 1] = c < 2 ? 1 : 0;
      seed[v] = i * 1.37;
    }
    const b = i * 4;
    idx.set([b, b + 1, b + 2, b, b + 2, b + 3], i * 6);
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), SHAFT_LEN * 1.5);
  return geo;
}

export function createUnderwater({ ctx, scene, lights, seed = 1 } = {}) {
  const group = new THREE.Group();
  group.name = 'underwater';
  const rng = makeRng((seed ^ 0x9e3b17) >>> 0);

  const uTime = uniform(0);
  const uAmount = uniform(0);
  const uWaterTint = uniform(new THREE.Color(0x2fa8bd));
  const uMoteBright = uniform(1);
  const uShaftDir = uniform(new THREE.Vector2(0, -1));
  const uShaftBright = uniform(1);

  // --- motes ---------------------------------------------------------------
  // Billboarded in the vertex shader against the view matrix's basis rather
  // than with a sprite: 260 sprites is 260 draw calls, and one geometry is one.
  const moteMat = new THREE.NodeMaterial();
  moteMat.name = 'UnderwaterMotes';
  moteMat.transparent = true;
  moteMat.depthWrite = false;
  moteMat.blending = THREE.AdditiveBlending;
  moteMat.side = THREE.DoubleSide;
  moteMat.fog = false;
  moteMat.lights = false;

  const vMoteFade = varyingProperty('float', 'vMoteFade');
  const vMoteUv = varyingProperty('vec2', 'vMoteUv');

  moteMat.vertexNode = Fn(() => {
    const c = attribute('aCentre', 'vec3').toVar();
    const k = attribute('aCorner', 'vec2').toVar();
    const s = attribute('aSeed', 'float').toVar();

    // Drift: slow, mostly downward-and-sideways, with a per-mote phase so the
    // field never moves as a sheet. Real suspended matter mills about; it does
    // not fall, and anything that all moves one way reads as snow.
    const drift = vec3(
      sin(uTime.mul(0.19).add(s.mul(9.1))).mul(0.55).add(uTime.mul(0.06)),
      sin(uTime.mul(0.13).add(s.mul(5.7))).mul(0.42).sub(uTime.mul(0.035)),
      sin(uTime.mul(0.16).add(s.mul(7.3))).mul(0.55),
    ).toVar();

    // Wrap into a box that follows the camera. fract() of the offset keeps the
    // density uniform however far the boat has travelled, and because the box
    // is centred on the eye there is never an edge in frame.
    const p = c.add(drift).div(MOTE_BOX).add(0.5).toVar();
    const w = vec3(fract(p.x), fract(p.y), fract(p.z)).sub(0.5).mul(MOTE_BOX).toVar();
    const world = cameraPosition.add(w).toVar();

    // Fade at the box edge — a mote must never pop, and the wrap is a hard
    // teleport. Also fade the very near ones, which would otherwise be huge
    // soft discs across the middle of the frame.
    const d = length(w).toVar();
    vMoteFade.assign(
      smoothstep(MOTE_BOX * 0.5, MOTE_BOX * 0.30, d)
        .mul(smoothstep(0.32, 1.05, d))
        // Twinkle: they are irregular flakes turning over in the light.
        .mul(float(0.45).add(abs(sin(uTime.mul(1.7).add(s.mul(21.7)))).mul(0.55))),
    );
    vMoteUv.assign(k.div(max(length(k), 1e-5)).mul(length(k)).div(MOTE_SIZE[1]));

    const view = cameraViewMatrix.mul(vec4(world, 1.0)).toVar();
    view.xy.addAssign(k);
    return cameraProjectionMatrix.mul(view);
  })();

  moteMat.fragmentNode = Fn(() => {
    const r = length(vMoteUv).toVar();
    const a = pow(smoothstep(1.0, 0.0, r), 1.8).mul(vMoteFade).mul(uAmount).mul(uMoteBright);
    // Motes are lit by the water around them, so they are the water's colour
    // pushed toward white — never a picked grey.
    return vec4(mix(uWaterTint, vec3(1.0), 0.55).mul(a.mul(1.6)), a);
  })();

  const motes = new THREE.Mesh(buildMotes(rng), moteMat);
  motes.name = 'motes';
  motes.frustumCulled = false;      // it is always exactly around the camera
  motes.renderOrder = 6;
  group.add(motes);

  // --- light shafts --------------------------------------------------------
  const shaftMat = new THREE.NodeMaterial();
  shaftMat.name = 'UnderwaterShafts';
  shaftMat.transparent = true;
  shaftMat.depthWrite = false;
  shaftMat.blending = THREE.AdditiveBlending;
  shaftMat.side = THREE.DoubleSide;
  shaftMat.fog = false;
  shaftMat.lights = false;

  const vShaftUv = varyingProperty('vec2', 'vShaftUv');
  const vShaftSeed = varyingProperty('float', 'vShaftSeed');

  shaftMat.vertexNode = Fn(() => {
    const p = positionGeometry.toVar();
    const s = attribute('aSeed', 'float').toVar();
    // Sway. The ceiling is moving, so the beams coming through it wander; a
    // static beam is the thing that gives a fake volumetric away instantly.
    p.x.addAssign(sin(uTime.mul(0.36).add(s.mul(2.1))).mul(0.85)
      .mul(p.y.negate().div(SHAFT_LEN).add(0.15)));
    // Billboard about the vertical only — a shaft is a vertical sheet, and
    // spinning it to face the camera fully makes it lie down as you look up.
    const dir = vec3(uShaftDir.x, 0.0, uShaftDir.y).toVar();
    const rightW = normalize(vec3(dir.z, 0.0, dir.x.negate())).toVar();
    const world = cameraPosition
      .add(dir.mul(9.0))
      .add(rightW.mul(p.x))
      .add(vec3(0.0, p.y, 0.0)).toVar();
    vShaftUv.assign(vec2(p.x, p.y));
    vShaftSeed.assign(s);
    return cameraProjectionMatrix.mul(cameraViewMatrix.mul(vec4(world, 1.0)));
  })();

  shaftMat.fragmentNode = Fn(() => {
    // Falls off down its length and across its width, with a flicker that is
    // slower than the motes' — the ceiling ripple that makes it is metres wide.
    const down = smoothstep(0.0, 1.0, vShaftUv.y.negate().div(SHAFT_LEN)).oneMinus().toVar();
    const across = smoothstep(1.0, 0.0, abs(vShaftUv.x).div(1.5)).toVar();
    const flick = float(0.55)
      .add(sin(uTime.mul(0.9).add(vShaftSeed.mul(4.3))).mul(0.25))
      .add(sin(uTime.mul(1.7).add(vShaftSeed.mul(9.1))).mul(0.20)).toVar();
    const a = down.mul(down).mul(across).mul(flick).mul(uAmount).mul(uShaftBright).toVar();
    return vec4(mix(uWaterTint, vec3(1.0), 0.72).mul(a.mul(0.30)), a.mul(0.30));
  })();

  const shafts = new THREE.Mesh(buildShafts(), shaftMat);
  shafts.name = 'shafts';
  shafts.frustumCulled = false;
  shafts.renderOrder = 5;
  group.add(shafts);

  // Underwater props belong in the beauty pass only: they must not appear in
  // the refraction texture (which is a view from ABOVE the water and would get
  // a second copy of the motes composited into it) and there is nothing to
  // reflect them in.
  setLayers(group, LAYER.MAIN);
  group.visible = false;

  // --- the light and fog blend --------------------------------------------
  // Saved on the first frame, before anything here has touched them, so the
  // blend always runs from the environment's own values rather than from
  // yesterday's blend. Re-read every frame from the light itself for the same
  // reason: main.js writes them from the preset on every clock tick.
  const waterFogColor = new THREE.Color();
  const keyColor = new THREE.Color();
  const hemiSky = new THREE.Color();
  const hemiGround = new THREE.Color();

  let applied = 0;

  /**
   * Blend the scene toward "we are inside the water" by `amount` (0..1).
   * Call once per frame, after applyEnvToLights().
   */
  function update(env, amount, time) {
    uTime.value = time;
    const a = Math.max(0, Math.min(1, amount));
    uAmount.value = a;

    const on = a > 0.004;
    if (group.visible !== on) group.visible = on;
    // Nothing below costs anything at the surface, and every frame of a normal
    // session is at the surface. Bail before touching a light.
    if (!on && applied <= 0.004) { applied = a; return; }
    applied = a;

    // The colour of the water body, which is what everything down here is lit
    // by and hazed by. Mid rather than deep: deep is the colour of a column you
    // are looking THROUGH from above, and standing in it you are much closer to
    // the scattered mid tone.
    waterFogColor.copy(env.waterMid).lerp(env.waterScatter, 0.45);
    uWaterTint.value.copy(waterFogColor).multiplyScalar(1.9);

    // Fog is deliberately NOT touched any more.
    //
    // It used to be pushed to a 3-46 m ramp on the water colour, and that was
    // the right instinct with the wrong tool: THREE.Fog is one colour and a
    // linear ramp, and what water actually does is exp(-sigma*d) with sigma
    // six times larger in red than in blue — the SEPARATION between the
    // channels with distance is the entire depth cue. water/underwaterFx.js
    // now does that per pixel from the scene depth buffer, and leaving this
    // here as well double-counted the haze: the reef went to a flat wash at
    // eight metres and the pass had nothing left to work with.

    // Light. The key comes through a rough ceiling: dimmer, greener, and much
    // softer, while the ambient dome goes UP because the water itself is the
    // source down here. Without the ambient lift every hull and every coral
    // head is a black cut-out and the frame reads as a cave.
    const { keyLight, hemi, fillLight } = lights;
    if (keyLight) {
      keyColor.copy(env.keyColor).lerp(waterFogColor, 0.55 * a);
      keyLight.color.copy(keyColor);
      keyLight.intensity = env.keyIntensity * (1 - 0.62 * a);
    }
    if (hemi) {
      hemiSky.copy(env.ambientSky).lerp(waterFogColor, 0.72 * a);
      hemiGround.copy(env.ambientGround).lerp(waterFogColor, 0.55 * a);
      hemi.color.copy(hemiSky);
      hemi.groundColor.copy(hemiGround);
      hemi.intensity = env.ambientIntensity * (1 + 1.15 * a);
    }
    if (fillLight) {
      fillLight.color.copy(hemiSky);
      fillLight.intensity = (0.18 + 0.22 * env.dayFactor) * (1 + 1.6 * a);
    }

    // Shafts hang along the sun's bearing and die with it. keyDir points FROM
    // the origin TOWARD the sun, so the shafts want the opposite in plan.
    const kx = env.keyDir.x, kz = env.keyDir.z;
    const kl = Math.hypot(kx, kz) || 1;
    uShaftDir.value.set(kx / kl, kz / kl);
    uShaftBright.value = Math.max(0, env.keyDir.y) * env.dayFactor * 1.25;
    uMoteBright.value = 0.35 + 0.85 * env.dayFactor;
  }

  return {
    group,
    update,
    /** Uniforms, so a capture or the ocean panel can push these around. */
    uniforms: { uAmount, uMoteBright, uShaftBright, uWaterTint },
    dispose() {
      motes.geometry.dispose();
      shafts.geometry.dispose();
      moteMat.dispose();
      shaftMat.dispose();
      group.clear();
    },
  };
}
