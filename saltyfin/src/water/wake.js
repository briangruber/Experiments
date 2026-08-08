// What the boat does to the water.
//
// A world-anchored window that follows the hull, held in a ping-pong pair of
// render targets and advanced one wave-equation step a frame:
//
//   R  ripple height        the transient rings that spread from the transom
//   G  ripple velocity      the other half of the integrator
//   B  churn foam           accumulates, decays over a few seconds -> the trail
//   A  Kelvin arms          rewritten every frame -> the crisp, current V
//
// Everything is stamped by an instanced additive pass, so one mechanism serves
// the transom churn, the spreading arms of the wake and any outside caller of
// disturb() (a breaching monster, a dropped anchor, a thrown lure).
//
// The window is recentred on the boat each frame, snapped to a texel, and the
// simulation resamples the previous field at the shifted UV — so the field is
// anchored in the world and the trail stays where it was laid.

import * as THREE from 'three';

const QUAD_VERT = /* glsl */`
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const SIM_FRAG = /* glsl */`
varying vec2 vUv;
uniform sampler2D tPrev;
uniform vec2  uTexel;
uniform vec2  uShift;       // uv offset that undoes this frame's recentring
uniform float uSpeed;       // c^2 dt^2 in texels; < 0.5 for stability
uniform float uDamp;        // velocity damping
uniform float uHeightDecay;
uniform float uFoamDecay;

vec4 fetch(vec2 uv){ return texture2D(tPrev, clamp(uv, vec2(0.0015), vec2(0.9985))); }

void main(){
  vec2 uv = vUv + uShift;

  vec4 c  = fetch(uv);
  vec4 xl = fetch(uv - vec2(uTexel.x, 0.0));
  vec4 xr = fetch(uv + vec2(uTexel.x, 0.0));
  vec4 yd = fetch(uv - vec2(0.0, uTexel.y));
  vec4 yu = fetch(uv + vec2(0.0, uTexel.y));

  float lap = xl.r + xr.r + yd.r + yu.r - 4.0 * c.r;
  float vel = (c.g + lap * uSpeed) * uDamp;
  float h   = (c.r + vel) * uHeightDecay;

  // Foam softens a little as it ages, then decays. The diffusion is kept very
  // weak on purpose: a few seconds of a strong kernel turns the trail into one
  // enormous cloud instead of a lace that holds its shape.
  float foam = (c.b * 0.94 + (xl.b + xr.b + yd.b + yu.b) * 0.015) * uFoamDecay;

  // Kill everything at the window edge so ripples leave instead of bouncing,
  // and so the recentre never smears clamped edge texels inward.
  vec2 e = min(vUv, 1.0 - vUv);
  float inside = smoothstep(0.0, 0.055, min(e.x, e.y));
  // Anything the recentre pulled in from outside the old window is invalid.
  vec2 o = step(vec2(0.0), uv) * step(uv, vec2(1.0));
  inside *= o.x * o.y;

  gl_FragColor = vec4(h * inside, vel * inside, foam * inside, 0.0);
}
`;

const STAMP_VERT = /* glsl */`
attribute vec2 aCenter;
attribute vec4 aParams;      // radius, heightAmp, foamAmp, armAmp
varying vec2 vLocal;
varying vec4 vParams;
uniform vec2  uCenter;
uniform float uWorld;
void main(){
  vLocal = position.xy;
  vParams = aParams;
  vec2 world = aCenter + position.xy * aParams.x;
  vec2 uv = (world - uCenter) / uWorld + 0.5;
  gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
}
`;

const STAMP_FRAG = /* glsl */`
varying vec2 vLocal;
varying vec4 vParams;
void main(){
  float d = length(vLocal);
  float f = 1.0 - smoothstep(0.0, 1.0, d);
  f = f * f * (3.0 - 2.0 * f);
  gl_FragColor = vec4(vParams.y * f, 0.0, vParams.z * f, vParams.w * f);
}
`;

const MAX_STAMPS = 224;
const TRAIL_MAX = 64;
const TRAIL_LIFE = 5.0;        // seconds an arm keeps sweeping outward
const TRAIL_STEP = 0.62;       // metres of travel between trail samples
const KELVIN_TAN = 0.3536;     // tan(19.47 deg) — the half-angle of the wedge
const PENDING_MAX = 48;

/**
 * @param {object} opts
 * @param {THREE.WebGLRenderer} opts.renderer
 * @param {number} [opts.size]        simulation resolution (power of two)
 * @param {number} [opts.worldSize]   metres covered by the window
 */
export function createWake({ renderer, size = 256, worldSize = 128 } = {}) {
  const texelWorld = worldSize / size;

  const makeRT = () => {
    const t = new THREE.WebGLRenderTarget(size, size, {
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

  let rtA = makeRT();
  let rtB = makeRT();

  const simMaterial = new THREE.ShaderMaterial({
    vertexShader: QUAD_VERT,
    fragmentShader: SIM_FRAG,
    uniforms: {
      tPrev: { value: null },
      uTexel: { value: new THREE.Vector2(1 / size, 1 / size) },
      uShift: { value: new THREE.Vector2() },
      uSpeed: { value: 0.052 },
      uDamp: { value: 0.988 },
      uHeightDecay: { value: 0.9975 },
      uFoamDecay: { value: 0.996 },
    },
    depthTest: false,
    depthWrite: false,
  });

  const quadGeometry = new THREE.PlaneGeometry(2, 2);
  const simQuad = new THREE.Mesh(quadGeometry, simMaterial);
  simQuad.frustumCulled = false;
  const simScene = new THREE.Scene();
  simScene.add(simQuad);
  const quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  // --- the stamp pass -------------------------------------------------------

  const centers = new Float32Array(MAX_STAMPS * 2);
  const params = new Float32Array(MAX_STAMPS * 4);

  const stampGeometry = new THREE.InstancedBufferGeometry();
  stampGeometry.setAttribute('position', new THREE.BufferAttribute(
    new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
  stampGeometry.setIndex([0, 1, 2, 0, 2, 3]);
  const centerAttr = new THREE.InstancedBufferAttribute(centers, 2);
  const paramAttr = new THREE.InstancedBufferAttribute(params, 4);
  centerAttr.setUsage(THREE.DynamicDrawUsage);
  paramAttr.setUsage(THREE.DynamicDrawUsage);
  stampGeometry.setAttribute('aCenter', centerAttr);
  stampGeometry.setAttribute('aParams', paramAttr);
  stampGeometry.instanceCount = 0;

  const stampMaterial = new THREE.ShaderMaterial({
    vertexShader: STAMP_VERT,
    fragmentShader: STAMP_FRAG,
    uniforms: {
      uCenter: { value: new THREE.Vector2() },
      uWorld: { value: worldSize },
    },
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    blendEquationAlpha: THREE.AddEquation,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneFactor,
  });

  const stampMesh = new THREE.Mesh(stampGeometry, stampMaterial);
  stampMesh.frustumCulled = false;
  const stampScene = new THREE.Scene();
  stampScene.add(stampMesh);

  // --- state ----------------------------------------------------------------

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

  let stampCount = 0;
  let cleared = false;
  const _clearColor = new THREE.Color();

  function clearBuffers() {
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
    const u = simMaterial.uniforms;
    u.tPrev.value = rtA.texture;
    u.uShift.value.copy(shift);
    u.uFoamDecay.value = Math.exp(-dt / 4.2);
    u.uHeightDecay.value = Math.exp(-dt / 9.0);

    const prevTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(rtB);
    renderer.render(simScene, quadCamera);

    if (stampCount > 0) {
      centerAttr.needsUpdate = true;
      paramAttr.needsUpdate = true;
      stampGeometry.instanceCount = stampCount;
      stampMaterial.uniforms.uCenter.value.copy(center);
      renderer.render(stampScene, quadCamera);
    }
    renderer.setRenderTarget(prevTarget);

    const t = rtA; rtA = rtB; rtB = t;
    api.texture = rtA.texture;
  }

  const api = {
    texture: rtA.texture,
    center,
    worldSize,
    size,
    texelWorld,
    disturb,
    update,
    reset,
    dispose() {
      rtA.dispose();
      rtB.dispose();
      quadGeometry.dispose();
      stampGeometry.dispose();
      simMaterial.dispose();
      stampMaterial.dispose();
    },
  };

  return api;
}
