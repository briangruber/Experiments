// What the boat does to the water.
//
// A world-anchored window that follows the hull, held in a ping-pong pair of
// buffers and advanced one wave-equation step a frame:
//
//   R  ripple height        the transient rings that spread from the transom
//   G  ripple velocity      the other half of the integrator
//   B  churn foam           accumulates, decays over a few seconds -> the trail
//   A  Kelvin arms          rewritten every frame -> the crisp, current V
//
// Everything is stamped by an additive pass, so one mechanism serves the
// transom churn, the spreading arms of the wake and any outside caller of
// disturb() (a breaching monster, a dropped anchor, a thrown lure).
//
// The window is recentred on the boat each frame, snapped to a texel, and the
// simulation resamples the previous field at the shifted UV — so the field is
// anchored in the world and the trail stays where it was laid.
//
// Ported from GLSL to TSL, and there are two ways to run it:
//
//   fragment  the reference implementation. A QuadMesh does the wave step into
//             a half-float RenderTarget, then an instanced additive draw stamps
//             on top of it. Every WebGL-backed run uses this.
//   compute   a single kernel per texel that does the step and then walks the
//             stamp list itself, storing into a StorageTexture. The wave step
//             is per-texel work with nothing to rasterise, and because the
//             recentring shift is snapped to a whole texel the resample is an
//             exact texel fetch — so both paths produce the same field, bit for
//             bit in the sim and to blend precision in the stamps.
//
// The compute path is chosen at build time on a WebGPU backend. Nothing outside
// this file can tell which one ran.

import * as THREE from 'three';
import {
  Fn, attribute, varying, textureLoad, textureStore, uniform, uniformArray,
  uv, vec2, vec4, float, int, uint, ivec2, uvec2,
  min, max, step, smoothstep, clamp, length, positionGeometry,
  instanceIndex, Loop, texture,
} from 'three/tsl';

const MAX_STAMPS = 224;
const TRAIL_MAX = 64;
const TRAIL_LIFE = 5.0;        // seconds an arm keeps sweeping outward
const TRAIL_STEP = 0.62;       // metres of travel between trail samples
const KELVIN_TAN = 0.3536;     // tan(19.47 deg) — the half-angle of the wedge
const PENDING_MAX = 48;

/**
 * @param {object} opts
 * @param {THREE.Renderer} opts.renderer
 * @param {number} [opts.size]        simulation resolution (power of two)
 * @param {number} [opts.worldSize]   metres covered by the window
 */
export function createWake({ renderer, size = 256, worldSize = 128 } = {}) {
  const texelWorld = worldSize / size;
  const useCompute = renderer?.backend?.isWebGPUBackend === true;

  // --- uniforms, shared by both paths --------------------------------------
  const uTexel = uniform(vec2(1 / size, 1 / size));
  const uShift = uniform(vec2(0, 0));      // uv offset that undoes this frame's recentring
  const uSpeed = uniform(0.052);           // c^2 dt^2 in texels; < 0.5 for stability
  const uDamp = uniform(0.988);            // velocity damping
  const uHeightDecay = uniform(0.9975);
  const uFoamDecay = uniform(0.996);
  const uCenter = uniform(vec2(0, 0));
  const uWorld = uniform(worldSize);

  // --- state ---------------------------------------------------------------
  const center = new THREE.Vector2(0, 0);
  const shift = new THREE.Vector2();

  // trail ring: x, z, rightX, rightZ, speed, emitTime
  const trail = new Float32Array(TRAIL_MAX * 6);
  let trailCount = 0;
  let trailHead = 0;
  let travel = 0;

  // outside disturbances waiting for the next step: x, z, strength, radius
  const pending = new Float32Array(PENDING_MAX * 4);
  let pendingCount = 0;

  // this frame's stamps, in the same layout the instanced attributes want
  const centers = new Float32Array(MAX_STAMPS * 2);
  const params = new Float32Array(MAX_STAMPS * 4);
  let stampCount = 0;
  let cleared = false;
  const _clearColor = new THREE.Color();

  // ---------------------------------------------------------------------------
  // the fragment path — the reference
  // ---------------------------------------------------------------------------
  let rtA = null, rtB = null;
  let simPrev = null;                 // TextureNode whose .value is the ping-pong read
  let simMaterial = null, stampMaterial = null;
  let simQuad = null, stampGeometry = null, stampScene = null, quadCamera = null;
  let centerAttr = null, paramAttr = null;

  // ---------------------------------------------------------------------------
  // the compute path
  // ---------------------------------------------------------------------------
  let storeA = null, storeB = null;
  let stepAB = null, stepBA = null, clearA = null, clearB = null;
  let stampVecA = null, stampVecB = null;
  let uStampCount = null, uShiftTexels = null;
  let pong = false;

  if (!useCompute) {
    const makeRT = () => {
      const t = new THREE.RenderTarget(size, size, {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
        stencilBuffer: false,
        generateMipmaps: false,
        colorSpace: THREE.NoColorSpace,
      });
      t.texture.wrapS = t.texture.wrapT = THREE.ClampToEdgeWrapping;
      return t;
    };

    rtA = makeRT();
    rtB = makeRT();

    // The previous field. `.value` is swapped between the ping-pong pair every
    // frame — a uniform rebind, not a recompile.
    simPrev = texture(rtA.texture);
    const fetch = (p) => simPrev.sample(clamp(p, vec2(0.0015), vec2(0.9985)));

    simMaterial = new THREE.NodeMaterial();
    simMaterial.depthTest = false;
    simMaterial.depthWrite = false;
    simMaterial.fragmentNode = Fn(() => {
      const suv = uv().add(uShift).toVar();

      const c = fetch(suv).toVar();
      const xl = fetch(suv.sub(vec2(uTexel.x, 0.0))).toVar();
      const xr = fetch(suv.add(vec2(uTexel.x, 0.0))).toVar();
      const yd = fetch(suv.sub(vec2(0.0, uTexel.y))).toVar();
      const yu = fetch(suv.add(vec2(0.0, uTexel.y))).toVar();

      const lap = xl.r.add(xr.r).add(yd.r).add(yu.r).sub(c.r.mul(4.0));
      const vel = c.g.add(lap.mul(uSpeed)).mul(uDamp).toVar();
      const h = c.r.add(vel).mul(uHeightDecay).toVar();

      // Foam softens a little as it ages, then decays. The diffusion is kept
      // very weak on purpose: a few seconds of a strong kernel turns the trail
      // into one enormous cloud instead of a lace that holds its shape.
      const foam = c.b.mul(0.94)
        .add(xl.b.add(xr.b).add(yd.b).add(yu.b).mul(0.015))
        .mul(uFoamDecay).toVar();

      // Kill everything at the window edge so ripples leave instead of
      // bouncing, and so the recentre never smears clamped edge texels inward.
      const e = min(uv(), uv().oneMinus()).toVar();
      const inside = smoothstep(0.0, 0.055, min(e.x, e.y)).toVar();
      // Anything the recentre pulled in from outside the old window is invalid.
      const o = step(vec2(0.0), suv).mul(step(suv, vec2(1.0))).toVar();
      inside.mulAssign(o.x.mul(o.y));

      return vec4(h.mul(inside), vel.mul(inside), foam.mul(inside), 0.0);
    })();

    simQuad = new THREE.QuadMesh(simMaterial);

    // --- the stamp pass ----------------------------------------------------
    stampGeometry = new THREE.InstancedBufferGeometry();
    stampGeometry.setAttribute('position', new THREE.BufferAttribute(
      new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    stampGeometry.setIndex([0, 1, 2, 0, 2, 3]);
    centerAttr = new THREE.InstancedBufferAttribute(centers, 2);
    paramAttr = new THREE.InstancedBufferAttribute(params, 4);
    centerAttr.setUsage(THREE.DynamicDrawUsage);
    paramAttr.setUsage(THREE.DynamicDrawUsage);
    stampGeometry.setAttribute('aCenter', centerAttr);
    stampGeometry.setAttribute('aParams', paramAttr);
    stampGeometry.instanceCount = 0;

    const aCenter = attribute('aCenter', 'vec2');
    const aParams = attribute('aParams', 'vec4');   // radius, heightAmp, foamAmp, armAmp
    const vLocal = varying(positionGeometry.xy, 'vLocal');
    const vParams = varying(aParams, 'vParams');

    stampMaterial = new THREE.NodeMaterial();
    stampMaterial.vertexNode = Fn(() => {
      const world = aCenter.add(positionGeometry.xy.mul(aParams.x));
      const p = world.sub(uCenter).div(uWorld).add(0.5);
      // p is the field's uv. A QuadMesh puts v = 0 at clip y = +1 — the same
      // top-left convention the node renderer uses everywhere — so the sim pass
      // lays the field down that way and the stamps have to agree. Hence the
      // negated y rather than the plain `uv * 2 - 1` the GLSL version used
      // against a PlaneGeometry.
      return vec4(p.x.mul(2.0).sub(1.0), float(1.0).sub(p.y.mul(2.0)), 0.0, 1.0);
    })();
    stampMaterial.fragmentNode = Fn(() => {
      const f = smoothstep(0.0, 1.0, length(vLocal)).oneMinus().toVar();
      f.assign(f.mul(f).mul(float(3.0).sub(f.mul(2.0))));
      return vec4(vParams.y.mul(f), 0.0, vParams.z.mul(f), vParams.w.mul(f));
    })();
    stampMaterial.transparent = true;
    stampMaterial.depthTest = false;
    stampMaterial.depthWrite = false;
    stampMaterial.side = THREE.DoubleSide;   // the flipped y reverses the winding
    stampMaterial.blending = THREE.CustomBlending;
    stampMaterial.blendEquation = THREE.AddEquation;
    stampMaterial.blendSrc = THREE.OneFactor;
    stampMaterial.blendDst = THREE.OneFactor;
    stampMaterial.blendEquationAlpha = THREE.AddEquation;
    stampMaterial.blendSrcAlpha = THREE.OneFactor;
    stampMaterial.blendDstAlpha = THREE.OneFactor;

    const stampMesh = new THREE.Mesh(stampGeometry, stampMaterial);
    stampMesh.frustumCulled = false;
    stampScene = new THREE.Scene();
    stampScene.add(stampMesh);
    quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  } else {
    const makeStore = () => {
      const t = new THREE.StorageTexture(size, size);
      t.type = THREE.HalfFloatType;
      t.format = THREE.RGBAFormat;
      t.minFilter = THREE.LinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      t.generateMipmaps = false;
      t.colorSpace = THREE.NoColorSpace;
      return t;
    };

    storeA = makeStore();
    storeB = makeStore();

    // The stamp list, as uniform arrays rather than instanced attributes: the
    // kernel walks it per texel instead of the rasteriser walking it per quad.
    stampVecA = [];   // x, z, radius, heightAmp
    stampVecB = [];   // foamAmp, armAmp
    for (let i = 0; i < MAX_STAMPS; i++) {
      stampVecA.push(new THREE.Vector4());
      stampVecB.push(new THREE.Vector4());
    }
    const uStampA = uniformArray(stampVecA, 'vec4');
    const uStampB = uniformArray(stampVecB, 'vec4');
    uStampCount = uniform(0, 'int');
    // The recentre in whole texels. It is always a whole number of texels, so
    // the fragment path's bilinear resample and this exact fetch agree.
    uShiftTexels = uniform(vec2(0, 0));

    const LO = int(0);
    const HI = int(size - 1);

    const buildStep = (srcTex, dstTex) => Fn(() => {
      const px = instanceIndex.mod(uint(size));
      const py = instanceIndex.div(uint(size));
      const ix = int(px).toVar();
      const iy = int(py).toVar();

      const sx = ix.add(int(uShiftTexels.x)).toVar();
      const sy = iy.add(int(uShiftTexels.y)).toVar();
      // Same clamp-to-edge the fragment path gets from the sampler.
      const grab = (ox, oy) => textureLoad(srcTex, ivec2(
        min(max(sx.add(int(ox)), LO), HI),
        min(max(sy.add(int(oy)), LO), HI),
      ));

      const c = grab(0, 0).toVar();
      const xl = grab(-1, 0).toVar();
      const xr = grab(1, 0).toVar();
      const yd = grab(0, -1).toVar();
      const yu = grab(0, 1).toVar();

      const lap = xl.r.add(xr.r).add(yd.r).add(yu.r).sub(c.r.mul(4.0));
      const vel = c.g.add(lap.mul(uSpeed)).mul(uDamp).toVar();
      const h = c.r.add(vel).mul(uHeightDecay).toVar();
      const foam = c.b.mul(0.94)
        .add(xl.b.add(xr.b).add(yd.b).add(yu.b).mul(0.015))
        .mul(uFoamDecay).toVar();

      const vUv = vec2(float(ix), float(iy)).add(0.5).div(float(size)).toVar();
      const suv = vUv.add(uShift).toVar();
      const e = min(vUv, vUv.oneMinus()).toVar();
      const inside = smoothstep(0.0, 0.055, min(e.x, e.y)).toVar();
      const o = step(vec2(0.0), suv).mul(step(suv, vec2(1.0))).toVar();
      inside.mulAssign(o.x.mul(o.y));

      const out = vec4(h.mul(inside), vel.mul(inside), foam.mul(inside), 0.0).toVar();

      // The stamps. Same falloff as the instanced quad, evaluated at this
      // texel's world position instead of interpolated across a quad.
      const world = uCenter.add(vUv.sub(0.5).mul(uWorld)).toVar();
      Loop(uStampCount, ({ i }) => {
        const a = uStampA.element(i).toVar();
        const b = uStampB.element(i).toVar();
        const local = world.sub(a.xy).div(a.z).toVar();
        const f = smoothstep(0.0, 1.0, length(local)).oneMinus().toVar();
        f.assign(f.mul(f).mul(float(3.0).sub(f.mul(2.0))));
        out.addAssign(vec4(a.w.mul(f), 0.0, b.x.mul(f), b.y.mul(f)));
      });

      textureStore(dstTex, uvec2(px, py), out);
    })().compute(size * size);

    const buildClear = (dstTex) => Fn(() => {
      const px = instanceIndex.mod(uint(size));
      const py = instanceIndex.div(uint(size));
      textureStore(dstTex, uvec2(px, py), vec4(0.0));
    })().compute(size * size);

    stepAB = buildStep(storeA, storeB);
    stepBA = buildStep(storeB, storeA);
    clearA = buildClear(storeA);
    clearB = buildClear(storeB);
  }

  function clearBuffers() {
    if (useCompute) {
      renderer.computeAsync(clearA);
      renderer.computeAsync(clearB);
      pong = false;
      api.texture = storeA;
      cleared = true;
      return;
    }
    const prev = renderer.getRenderTarget();
    const c = renderer.getClearColor(_clearColor);
    const a = renderer.getClearAlpha();
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(rtA);
    renderer.clear(true, false, false);
    renderer.setRenderTarget(rtB);
    renderer.clear(true, false, false);
    renderer.setClearColor(c, a);
    renderer.setRenderTarget(prev);
    cleared = true;
  }

  function push(x, z, radius, height, foam, arm) {
    if (stampCount >= MAX_STAMPS) return;
    const i = stampCount++;
    centers[i * 2] = x;
    centers[i * 2 + 1] = z;
    params[i * 4] = radius;
    params[i * 4 + 1] = height;
    params[i * 4 + 2] = foam;
    params[i * 4 + 3] = arm;
  }

  function disturb(x, z, strength = 1, radius = 2.5) {
    if (pendingCount >= PENDING_MAX) return;
    const i = pendingCount++;
    pending[i * 4] = x;
    pending[i * 4 + 1] = z;
    pending[i * 4 + 2] = strength;
    pending[i * 4 + 3] = Math.max(0.4, radius);
  }

  function reset() {
    trailCount = 0;
    trailHead = 0;
    travel = 0;
    pendingCount = 0;
    clearBuffers();
  }

  function update(ctx) {
    if (!cleared) clearBuffers();

    const dt = Math.min(0.05, Math.max(1 / 240, ctx.dt || 1 / 60));
    const now = ctx.time || 0;
    const boat = ctx.boat;

    // --- recentre, snapped to a texel so the resample is lossless -----------
    const ax = boat ? boat.position.x : ctx.camera.position.x;
    const az = boat ? boat.position.z : ctx.camera.position.z;
    const cx = Math.round(ax / texelWorld) * texelWorld;
    const cz = Math.round(az / texelWorld) * texelWorld;
    shift.set((cx - center.x) / worldSize, (cz - center.y) / worldSize);
    center.set(cx, cz);
    if (Math.abs(shift.x) > 0.45 || Math.abs(shift.y) > 0.45) {
      shift.set(0, 0);
      trailCount = 0;
      trailHead = 0;
      clearBuffers();
    }

    // --- collect this frame's stamps ----------------------------------------
    stampCount = 0;

    for (let i = 0; i < pendingCount; i++) {
      const s = pending[i * 4 + 2];
      const r = pending[i * 4 + 3];
      push(pending[i * 4], pending[i * 4 + 1], r, -0.30 * s, 0.16 * s, 0.30 * s);
    }
    pendingCount = 0;

    if (boat) {
      const speed = Math.abs(boat.speed || 0);
      // ctx.boat.wakeStrength is an optional hook for the boat controller
      // (planing, hard turns). It starts at 0 in main.js, so treat 0 as "unset".
      const ws = (typeof boat.wakeStrength === 'number' && boat.wakeStrength > 0)
        ? Math.min(2.5, boat.wakeStrength) : 1;
      const spd = Math.min(1.4, (speed / 6.0) * ws);
      const fx = boat.forward.x, fz = boat.forward.z;
      const rx = boat.right.x, rz = boat.right.z;
      const bx = boat.position.x, bz = boat.position.z;

      // Transom churn: a forced oscillator right behind the hull. This is what
      // feeds the ripple sim and the bright broken water at the stern.
      if (speed > 0.35) {
        const osc = Math.sin(now * 12.6);
        const hAmp = 0.62 * spd * dt * 60.0 * 0.016;
        const fAmp = 1.7 * spd * dt;
        push(bx - fx * 2.15 - rx * 0.62, bz - fz * 2.15 - rz * 0.62, 1.05, hAmp * osc, fAmp, 0.50 * spd);
        push(bx - fx * 2.15 + rx * 0.62, bz - fz * 2.15 + rz * 0.62, 1.05, hAmp * osc, fAmp, 0.50 * spd);
        push(bx - fx * 3.7, bz - fz * 3.7, 1.9, -hAmp * 0.55, fAmp * 0.45, 0.22 * spd);
        // Bow break — a thinner, quieter pair.
        push(bx + fx * 1.9, bz + fz * 1.9, 0.85, hAmp * 0.35, fAmp * 0.35, 0.30 * spd);

        travel += speed * dt;
        if (travel >= TRAIL_STEP) {
          travel = 0;
          const i = trailHead;
          trail[i * 6] = bx - fx * 2.1;
          trail[i * 6 + 1] = bz - fz * 2.1;
          trail[i * 6 + 2] = rx;
          trail[i * 6 + 3] = rz;
          trail[i * 6 + 4] = speed;
          trail[i * 6 + 5] = now;
          trailHead = (trailHead + 1) % TRAIL_MAX;
          trailCount = Math.min(TRAIL_MAX, trailCount + 1);
        }
      } else {
        travel = 0;
      }
    }

    // --- the Kelvin arms ----------------------------------------------------
    // The wedge is stationary relative to the hull, so an arm born at p0 has
    // swept KELVIN_TAN * v0 * age metres sideways by now. These go into A only,
    // and the simulation zeroes A every step — so the V is redrawn crisp each
    // frame instead of accumulating into a solid white triangle. The persistent
    // trail is the transom churn in B and nothing else.
    for (let k = 0; k < trailCount; k++) {
      const i = (trailHead - 1 - k + TRAIL_MAX * 2) % TRAIL_MAX;
      const age = now - trail[i * 6 + 5];
      if (age < 0 || age > TRAIL_LIFE) continue;
      const v0 = trail[i * 6 + 4];
      const spread = KELVIN_TAN * v0 * age;
      const fade = 1 - age / TRAIL_LIFE;
      const amp = fade * fade;
      const radius = 0.42 + 0.055 * spread + 0.03 * v0;
      const arm = 1.0 * amp * Math.min(1, v0 / 5.0);
      const px = trail[i * 6], pz = trail[i * 6 + 1];
      const ux = trail[i * 6 + 2], uz = trail[i * 6 + 3];
      push(px + ux * spread, pz + uz * spread, radius, 0, 0, arm);
      push(px - ux * spread, pz - uz * spread, radius, 0, 0, arm);
    }

    // --- step ---------------------------------------------------------------
    uShift.value.copy(shift);
    uCenter.value.copy(center);
    uFoamDecay.value = Math.exp(-dt / 4.2);
    uHeightDecay.value = Math.exp(-dt / 9.0);

    if (useCompute) {
      uShiftTexels.value.set(Math.round(shift.x * size), Math.round(shift.y * size));
      for (let i = 0; i < stampCount; i++) {
        stampVecA[i].set(centers[i * 2], centers[i * 2 + 1], params[i * 4], params[i * 4 + 1]);
        stampVecB[i].set(params[i * 4 + 2], params[i * 4 + 3], 0, 0);
      }
      uStampCount.value = stampCount;
      renderer.computeAsync(pong ? stepBA : stepAB);
      api.texture = pong ? storeA : storeB;
      pong = !pong;
      return;
    }

    simPrev.value = rtA.texture;

    const prevTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(rtB);
    simQuad.render(renderer);

    if (stampCount > 0) {
      centerAttr.needsUpdate = true;
      paramAttr.needsUpdate = true;
      stampGeometry.instanceCount = stampCount;
      renderer.setRenderTarget(rtB);
      renderer.render(stampScene, quadCamera);
    }
    renderer.setRenderTarget(prevTarget);

    const t = rtA; rtA = rtB; rtB = t;
    api.texture = rtA.texture;
  }

  const api = {
    texture: useCompute ? storeA : rtA.texture,
    center,
    worldSize,
    size,
    texelWorld,
    backend: useCompute ? 'compute' : 'fragment',
    disturb,
    update,
    reset,
    dispose() {
      if (rtA) rtA.dispose();
      if (rtB) rtB.dispose();
      if (storeA) storeA.dispose();
      if (storeB) storeB.dispose();
      if (stampGeometry) stampGeometry.dispose();
      if (simMaterial) simMaterial.dispose();
      if (stampMaterial) stampMaterial.dispose();
    },
  };

  return api;
}
