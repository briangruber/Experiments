// Fireflies on the shoreline, after dark.
//
// The cheapest kind of life the bay can buy: one instanced draw of ~100
// camera-facing quads whose entire behaviour lives on the GPU. Placement
// happens once at build against the real terrain, and from then on the CPU's
// whole involvement is writing one float a frame (uTime). No per-instance
// loop, no attribute upload, ever — the wake already spends the particle
// budget on a few hundred live structs a frame, and ambience must not.
//
// They hide by ALPHA, never by visibility. uNight is zero all day, so the
// mesh draws a hundred invisible quads — a rounding error — and its pipeline
// exists from the warm-up render. Toggling `visible` at dusk instead would
// hand back the synchronous pipeline compile that warmUpClock() exists to
// remove, on the first frame of the one transition everyone watches.

import * as THREE from 'three';
import {
  Fn, attribute, uniform, positionLocal, uv, vec3, vec4, float,
  sin, cos, length, smoothstep, max, mix, fract, pow, cameraPosition,
} from 'three/tsl';
import { LAYER, setLayers } from '../core/layers.js';
import { makeRng } from '../core/rng.js';

const TAU = Math.PI * 2;

// The working set at full quality. Ninety sparks across a 520 m square is
// sparse on purpose: fireflies read as an EVENT you catch out of the corner
// of the frame, and a lawn of them reads as fairy lights.
const SHORE_COUNT = 90;
const TOWN_COUNT = 12;
const FIELD = 260;              // sample square half-extent, metres
// The beach ring: land, but LOW land. Between these heights is the grass
// line just above the surf; below it the spark sits in the water, above it
// it drifts over bare hillside rock, and both read as a bug in the other
// sense of the word.
const SHORE_BAND = [0.4, 5.0];
const HOVER = [0.5, 1.8];       // metres above the ground they were dealt
// The stilt town is over open water and can never pass the land test, so it
// gets its own dozen, hung above the boardwalk lanterns.
const TOWN_AT = [-60, 40];
const TOWN_RADIUS = 16;
const TOWN_DECK_Y = 2.9;
// The band covers a few percent of the square, so 400 tries almost always
// lands. When it does not, the firefly is quietly dropped — one missing
// spark is invisible, a retry loop on a pathological seed is a hung build.
const ATTEMPTS = 400;
const SIZE = [0.05, 0.09];      // quad width, metres

export function createFireflies(opts = {}) {
  const terrain = opts.terrain;
  const quality = opts.quality || {};
  const rng = makeRng(((opts.seed ?? 1) ^ 0xF1EF1E) >>> 0);

  const nShore = Math.max(30, Math.round(SHORE_COUNT * (quality.geometry ?? 1)));

  const isLand = terrain && typeof terrain.isLand === 'function' ? terrain.isLand : null;
  const landHeight = terrain && typeof terrain.landHeight === 'function' ? terrain.landHeight : null;

  // (baseX, baseY, baseZ, seed) per firefly, written once. Everything else —
  // wander, blink, size — the shader derives from the seed, so one static
  // vec4 is the whole per-instance state.
  const placed = [];

  // Rejection-sampled against the real terrain rather than a hand-authored
  // list, so a reseeded bay still gets its shoreline right.
  if (isLand && landHeight) {
    for (let i = 0; i < nShore; i++) {
      for (let a = 0; a < ATTEMPTS; a++) {
        const x = rng.range(-FIELD, FIELD);
        const z = rng.range(-FIELD, FIELD);
        if (!isLand(x, z)) continue;
        const h = landHeight(x, z);
        if (h < SHORE_BAND[0] || h > SHORE_BAND[1]) continue;
        placed.push(x, h + rng.range(HOVER[0], HOVER[1]), z, rng.next());
        break;
      }
    }
  }
  for (let i = 0; i < TOWN_COUNT; i++) {
    const ang = rng.range(0, TAU);
    const rad = TOWN_RADIUS * Math.sqrt(rng.next());   // uniform over the disc
    placed.push(
      TOWN_AT[0] + Math.cos(ang) * rad,
      TOWN_DECK_Y + rng.range(1.0, 2.0),
      TOWN_AT[1] + Math.sin(ang) * rad,
      rng.next(),
    );
  }
  const n = placed.length / 4;

  const group = new THREE.Group();
  group.name = 'fireflies';

  const uTime = uniform(0);
  const uNight = uniform(0);
  const uColor = uniform(new THREE.Color(0xFFD98A));

  const quad = new THREE.PlaneGeometry(1, 1);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = quad.index;
  geo.attributes.position = quad.attributes.position;
  geo.attributes.uv = quad.attributes.uv;
  geo.instanceCount = n;
  geo.setAttribute('aFly', new THREE.InstancedBufferAttribute(new Float32Array(placed), 4));

  const mat = new THREE.NodeMaterial();
  mat.name = 'Fireflies';
  mat.transparent = true;
  mat.depthWrite = false;
  mat.depthTest = true;
  mat.blending = THREE.AdditiveBlending;
  mat.side = THREE.DoubleSide;
  mat.fog = false;
  mat.lights = false;

  const aFly = attribute('aFly', 'vec4');

  // Base point plus a Lissajous wander. The rates are deliberately glacial —
  // 0.13..0.31 rad/s is a twenty-to-fifty-second figure — because the BLINK
  // carries the life; the drift only has to be nonzero so a spark caught
  // mid-flash is never in the same place twice. Three coprime-ish rate
  // hashes keep any two flies from ever phase-locking.
  mat.positionNode = Fn(() => {
    const base = aFly.xyz.toVar();
    const s = aFly.w.toVar();

    const rx = float(0.13).add(fract(s.mul(5.71)).mul(0.18)).toVar();
    const ry = float(0.13).add(fract(s.mul(9.33)).mul(0.18)).toVar();
    const rz = float(0.13).add(fract(s.mul(3.97)).mul(0.18)).toVar();
    const c = base.add(vec3(
      sin(uTime.mul(rx).add(s.mul(31.7))).mul(0.7),
      sin(uTime.mul(ry).add(s.mul(17.3))).mul(0.35),
      cos(uTime.mul(rz).add(s.mul(23.1))).mul(0.7),
    )).toVar();

    // Camera-facing, same construction as the wake's bubbles: a glowing dot
    // should be round from the beach, from the boat, and from the water.
    const size = float(SIZE[0]).add(fract(s.mul(13.7)).mul(SIZE[1] - SIZE[0])).toVar();
    const toCam = cameraPosition.sub(c).toVar();
    const right = vec3(toCam.z, 0.0, toCam.x.negate()).toVar();
    const rn = right.div(max(length(right), 1e-4)).toVar();
    return c.add(rn.mul(positionLocal.x.mul(size)))
      .add(vec3(0.0, 1.0, 0.0).mul(positionLocal.y.mul(size)));
  })();

  mat.fragmentNode = Fn(() => {
    const d = uv().sub(0.5).mul(2.0).toVar();
    const r = length(d).toVar();
    const s = aFly.w.toVar();

    // The blink: cubing the sine turns a shimmer into pulses with dark gaps
    // between them, which is the difference between a firefly and an LED.
    // Per-fly rate AND phase, so the shore never flashes in unison.
    const blink = pow(
      sin(uTime.mul(s.mul(0.9).add(0.5)).add(s.mul(20.0))).mul(0.5).add(0.5),
      3.0,
    ).toVar();

    // A soft dot with a hot centre. Additive over the night frame, so alpha
    // is the brightness and the white push in the core is what makes the
    // bright frames of the blink actually glare.
    const glow = smoothstep(1.0, 0.12, r).toVar();
    const core = smoothstep(0.4, 0.0, r).toVar();
    const a = glow.mul(blink).mul(uNight).toVar();
    return vec4(mix(uColor, vec3(1.0), core.mul(0.55)), a);
  })();

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'fireflies';
  // The swarm spans the whole bay and InstancedBufferGeometry has no useful
  // bounds anyway; a hundred quads is cheaper than culling them.
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.renderOrder = 13;
  setLayers(mesh, LAYER.MAIN);
  group.add(mesh);

  function update(ctx) {
    uTime.value = ctx.time;
  }

  function applyEnv(env) {
    if (!env) return;
    // nightFactor^1.5 keeps them dark through golden hour and sunset — a
    // firefly against an orange sky is a dust speck — and brings them up
    // only once the shore itself has gone to blue.
    const nf = Math.max(0, Math.min(1, env.nightFactor ?? 0));
    uNight.value = Math.pow(nf, 1.5);
  }

  return {
    group,
    update,
    applyEnv,
    uniforms: { uNight, uColor },
    dispose() {
      quad.dispose();
      geo.dispose();
      mat.dispose();
    },
  };
}
