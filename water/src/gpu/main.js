// Churn — WebGPU/TSL backend.
//
// Same tank, paddle, barrel, and interaction as the WebGL2 app, with the
// simulation in true 3D storage textures (src/gpu/fluid3d.js) and rendering
// as TSL node materials: opaque pass (paddle/barrel/fish) with depth, a
// reduced-resolution raymarch pass, and a composite/ACES/vignette pass.
// window.water keeps the same interface, plus captureTo2D() for headless
// captures (WebGPU canvas presentation doesn't composite in headless
// Chromium, so captures read pixels back and blit them to a 2D canvas).

import { applyWebGPUCompat, applyVolumeCompat } from './compat.js';
import * as THREE from '../../vendor/three.webgpu.min.js';

const {
  Fn, If, Loop, Break, uniform, texture, texture3D, uv,
  float, int, vec2, vec3, vec4, mat4, smoothstep, storage, instanceIndex, varying,
  normalWorld, positionWorld, cameraPosition,
  attribute, uniformArray, positionGeometry, normalGeometry, modelWorldMatrix,
} = THREE.TSL;
import { Fluid3D } from './fluid3d.js';
import {
  barrelGeometry, barrelTexture, BARREL_HALF,
  diverModel, diverTexture, DIVER_HALF,
} from '../model.js';
import { createVisitor } from '../visitor.js';
import { TUNE } from '../tune.js';
import { initChrome } from '../chrome.js';
import {
  buildPhysicsPanel, buildScenePanel, buildCodePanel, buildEmitterPanel,
  buildTunePanel, armBurst,
  gridOverride, particleOverride, tankOverride,
} from '../panel.js';

const QUALITY = {
  low: { N: 64, jacobi: 14, steps: 96, scale: 0.6, dpr: 1.0 },
  med: { N: 96, jacobi: 20, steps: 128, scale: 0.7, dpr: 1.0 },
  high: { N: 128, jacobi: 26, steps: 160, scale: 0.8, dpr: 1.25 },
  ultra: { N: 160, jacobi: 30, steps: 200, scale: 0.9, dpr: 1.25 },
};

export async function start() {
  applyWebGPUCompat();

  const query = new URLSearchParams(location.search);
  // A phone rendering 128³ is spending its whole frame on the solver; start
  // it one preset down unless ?q= says otherwise.
  const smallScreen = matchMedia('(max-width: 760px), (pointer: coarse)').matches;
  const qName = QUALITY[query.get('q')] ? query.get('q')
    : (smallScreen ? 'med' : 'high');
  // ?n= and ?p= override the preset's grid and particle count independently
  const Q = { ...QUALITY[qName] };
  Q.N = gridOverride(query, Q.N);
  const particleTarget = particleOverride(query,
    { low: 30000, med: 60000, high: 110000, ultra: 150000 }[qName] || 60000);

  const params = {
    quality: qName,
    stir: query.get('stir') !== '0',
    stirSpeed: 1.0,
    autoSpin: query.get('spin') === '1',
    spinSpeed: 0.22,
    paddleSpin: query.get('pspin') === '1',
    paddleSpinSpeed: Math.min(Math.max(+(query.get('pss') || 0) || 3.0, 0.5), 10),
    exposure: 1.25,
    paused: false,
    dtCap: Math.min(Math.max(+(query.get('dtcap') || 0) || 1 / 30, 1 / 240), 0.15),
  };

  // see src/gpu/fluid3d.js: a.mix(b, t) binds the receiver as mix()'s third
  // argument in this three.js build, so the lerp is written out by hand
  const lerp = (a, b, t) => a.add(b.sub(a).mul(t));

  const canvas = document.getElementById('gl');
  const boot = document.getElementById('boot');
  const sunDir = new THREE.Vector3(0.30, -1.0, -0.35).normalize();
  // the tank is a box inside the [-1,1] grid; the waterline keeps the same
  // fraction of its height whatever the size
  const FILL = 0.72;
  let tankHalf = tankOverride(query, 1);
  let SURFACE_Y = FILL * tankHalf;

  // headless capture mode renders on a detached canvas: the composited-but-
  // never-presented swapchain of a DOM canvas wedges the device timeline on
  // the SwiftShader adapter, starving buffer-map callbacks
  const headlessCapture = query.get('present') === 'rt';
  const renderCanvas = headlessCapture ? document.createElement('canvas') : canvas;
  const renderer = new THREE.WebGPURenderer({ canvas: renderCanvas, antialias: !headlessCapture });
  await renderer.init();
  if (!renderer.backend.isWebGPUBackend) {
    renderer.dispose();
    throw new Error('WebGPURenderer fell back to WebGL2; using the native WebGL2 app instead.');
  }
  // passes composite into shared targets, so clears are explicit — otherwise
  // drawing particles into compRT would wipe the composite underneath them
  renderer.autoClear = false;

  // Anything that goes wrong on a WebGPU device does so silently: validation
  // errors are dropped, a failed pipeline just never runs, and the frame still
  // composites. Route all of it to a visible banner so a broken backend can be
  // reported from a screenshot instead of a devtools session.
  const diagEl = document.getElementById('diag');
  const diagMsgs = [];
  function diag(msg) {
    if (diagMsgs.length >= 4 || diagMsgs.includes(msg)) return;
    diagMsgs.push(msg);
    console.error('[churn]', msg);
    if (!diagEl) return;
    diagEl.textContent = 'WebGPU error — the simulation is probably not running,\nso the tank will look like clear water:\n\n' + diagMsgs.join('\n\n');
    diagEl.hidden = false;
  }
  const device = renderer.backend.device;
  device.lost.then((info) => diag(`device lost (${info.reason || 'unknown'}): ${info.message}`));
  device.addEventListener('uncapturederror', (e) => diag(String(e.error && e.error.message || e.error)));

  // must run before Fluid3D allocates its volumes
  const compatForce = query.has('compat') ? query.get('compat') === '1' : undefined;
  const compat = await applyVolumeCompat(compatForce);
  // stage bisection for debugging: ?skip=sim,opaque,ray,final
  const skip = new Set((query.get('skip') || '').split(',').filter(Boolean));
  // ?present=rt keeps the final pass off the swapchain (headless Chromium's
  // WebGPU presentation crashes the GPU process); pair with captureTo2D()
  const presentToRT = query.get('present') === 'rt';

  const fluid = new Fluid3D(renderer, {
    N: Q.N, jacobi: Q.jacobi, lightDir: sunDir, surfaceY: SURFACE_Y, tank: tankHalf,
  });

  // ?diag=1: reduce the foam and velocity volumes to a peak each, read back
  // occasionally and print them in the HUD. A solver that isn't running reads
  // 0.000 / 0.000 while the tank still renders, which is otherwise impossible
  // to tell apart from "nothing has aerated the water yet".
  const wantProbe = query.get('diag') === '1';
  const PROBE_LANES = 64;
  let probeAttr = null, probeKernel = null, probeText = '—', probeBusy = false;
  if (wantProbe) {
    try {
      probeAttr = new THREE.StorageBufferAttribute(PROBE_LANES, 4);
      const probeBuf = THREE.TSL.storage(probeAttr, 'vec4', PROBE_LANES);
      const NP = Q.N;
      // each lane strides the volume so the whole grid is covered without atomics
      probeKernel = Fn(() => {
        const lane = instanceIndex;                 // one lane per z-slice
        const mf = float(0).toVar();
        const mv = float(0).toVar();
        const mp = float(0).toVar();
        const sv = float(0).toVar();                // a sum, so NaN survives
        Loop({ start: int(0), end: int(NP * NP) }, ({ i }) => {
          const c = THREE.TSL.ivec3(int(i).mod(int(NP)), int(i).div(int(NP)), int(lane));
          const vv = THREE.TSL.texture3DLoad(fluid.vel0, c, int(0)).xyz;
          mf.assign(mf.max(THREE.TSL.texture3DLoad(fluid.foamTexture, c, int(0)).x));
          mv.assign(mv.max(vv.length()));
          mp.assign(mp.max(THREE.TSL.texture3DLoad(fluid.prs0, c, int(0)).x.abs()));
          sv.addAssign(vv.x);
        });
        probeBuf.element(lane).assign(vec4(mf, mv, mp, sv));
      })().compute(PROBE_LANES);
    } catch (e) {
      probeText = 'probe unavailable';
      probeKernel = null;
    }
  }
  async function readProbe() {
    if (!probeKernel || probeBusy) return;
    probeBusy = true;
    try {
      renderer.compute(probeKernel);
      const raw = await renderer.getArrayBufferAsync(probeAttr);
      const f = new Float32Array(raw);
      let mf = 0, mv = 0, mp = 0, nan = false;
      for (let i = 0; i < PROBE_LANES; i++) {
        mf = Math.max(mf, f[i * 4]);
        mv = Math.max(mv, f[i * 4 + 1]);
        mp = Math.max(mp, f[i * 4 + 2]);
        if (!Number.isFinite(f[i * 4 + 3])) nan = true;
      }
      probeText = `${mf.toFixed(3)} / ${mv.toFixed(1)} / p${mp.toFixed(1)}`
        + (nan ? '  !! NaN in velocity' : '');
    } catch (e) {
      probeText = 'probe failed';
    }
    probeBusy = false;
  }
  fluid.clear();

  // --------------------------------------------------------------- camera --

  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 50);
  // Square on to the front wall. Any yaw puts a vertical corner seam down the
  // middle of the frame, which reads as a box rather than as open water.
  const orbit = { az: 0, el: 0.12, dist: 3.4 };
  let userZoomed = false;   // once true, resizing stops re-framing the tank
  // Distance that fits the tank in BOTH axes. A portrait phone has a much
  // narrower horizontal field than a desktop window at the same vertical
  // fov, so without this the tank is cropped off the sides.
  function fitDistance() {
    // The window spans the tank's FULL WIDTH, measured at its mid-plane rather
    // than at the front wall — see the WebGL app for why the literal fit puts
    // black wedges down the sides. The aspect floor of 1 turns it back into a
    // height fit on a portrait phone, where empty sky above the water would be
    // worse than losing the last of the width.
    const vt = Math.tan(camera.fov * Math.PI / 360);
    return TUNE.fitWidth * tankHalf / (vt * Math.max(camera.aspect, 1));
  }
  function updateCamera() {
    orbit.el = Math.max(-0.55, Math.min(1.25, orbit.el));
    orbit.dist = Math.max(0.15, Math.min(12, orbit.dist));
    const ce = Math.cos(orbit.el);
    camera.position.set(
      Math.sin(orbit.az) * ce * orbit.dist,
      Math.sin(orbit.el) * orbit.dist,
      Math.cos(orbit.az) * ce * orbit.dist);
    // Zoomed right in, the waterline would sit above the top edge and leave
    // nothing but a wall of water, so the camera aims below it. Once the frame
    // is tall enough to hold the whole tank there is nothing to dodge and the
    // tank should simply sit centred. Ease between the two so the wheel does
    // not make the view jump as it crosses over.
    const halfV = orbit.dist * Math.tan(camera.fov * Math.PI / 360);
    const near = Math.max(-0.35 * tankHalf,
      Math.min(0.15 * tankHalf, SURFACE_Y - halfV * 0.88));
    const wide = Math.min(1, Math.max(0, (halfV / tankHalf - 0.7) / 0.5));
    const aim = near * (1 - wide);
    camera.lookAt(0, aim, 0);
    camera.updateMatrixWorld();
  }

  // --------------------------------------------------------------- meshes --

  const opaqueScene = new THREE.Scene();

  const bodyMaterial = () => {
    const m = new THREE.MeshBasicNodeMaterial();
    m.colorNode = Fn(() => {
      const n = normalWorld.normalize();
      const v = cameraPosition.sub(positionWorld).normalize();
      const fr = float(1).sub(n.dot(v).abs()).pow(3);
      const diff = n.dot(uniform(sunDir).negate()).max(0);
      return vec4(
        vec3(0.016, 0.02, 0.026)
          .add(diff.mul(vec3(0.035, 0.045, 0.055)))
          .add(fr.mul(vec3(0.22, 0.45, 0.62)).mul(0.5)),
        1);
    })();
    return m;
  };

  const PADDLE_HALF_BASE = new THREE.Vector3(0.30, 0.05, 0.20);
  const paddleHalf = PADDLE_HALF_BASE.clone();
  // Half size to start: the full-size blade fills a lot of a tank seen whole,
  // and the slider goes up from here.
  const PADDLE_SCALE0 = 0.5;
  let paddleScale = PADDLE_SCALE0;
  const paddle = new THREE.Mesh(
    new THREE.BoxGeometry(paddleHalf.x * 2, paddleHalf.y * 2, paddleHalf.z * 2), bodyMaterial());
  paddle.position.set(0.45, -0.25, 0.1);
  opaqueScene.add(paddle);

  // Meshes lit BY the volume, not only casting into it. The bubble sprites and
  // the water both read this light volume; the solids between them were lit by
  // a flat constant, so a barrel crossed a caustic shaft without brightening
  // and sat under a plume without darkening. The sample is taken a step back up
  // the beam because the mesh puts its own occluder into that volume — read it
  // where the mesh is and it reads its own shadow.
  const uMeshTank = uniform(tankHalf);
  const uLightLift = uniform(0.16);
  const uSunU = uniform(sunDir);
  const volLight = (wp) => {
    const sp = wp.sub(uSunU.mul(uLightLift)).div(uMeshTank);
    return texture3D(fluid.lightTexture, sp.mul(0.5).add(0.5), float(0))
      .x.clamp(0, 1.6);
  };
  // the shared body of both mesh shaders: base colour, volume-lit
  const uFillUp = uniform(new THREE.Vector3(0.42, 0.52, 0.60));
  const uFillDown = uniform(new THREE.Vector3(0.045, 0.085, 0.115));
  const litByVolume = (map, n, wp) => {
    const v = cameraPosition.sub(wp).normalize();
    const fr = float(1).sub(n.dot(v).abs()).pow(3);
    const diff = n.dot(uSunU.negate()).max(0);
    const lt = volLight(wp);
    // Hemispheric fill — see the WebGL shader. Ambient underwater arrives
    // almost entirely from above, and that vertical gradient is most of what
    // tells you which way up a fish is; one flat term gave the back and the
    // belly the same value.
    const upness = n.y.mul(0.5).add(0.5).clamp(0, 1);
    const fill = lerp(uFillDown, uFillUp, upness.pow(1.4))
      .mul(float(0.25).add(lt.min(1).pow(0.6).mul(0.75)));
    return map.rgb.mul(fill.add(vec3(diff.mul(0.85).mul(lt))))
      .mul(vec3(0.92, 0.94, 1.0)).add(fr.mul(vec3(0.14, 0.28, 0.40)));
  };

  // A small drum. The mesh is the baked model, whose largest half extent is 1,
  // so one scale factor sets its size in tank units. Every barrel draws its own
  // size on the way in, and that size decides how big its explosion is — see
  // detonate(), and the WebGL app for the arithmetic behind it.
  const BARREL_SCALE = 0.085;    // the middle of the range, and the unit for `k`
  const BARREL_R = Math.hypot(BARREL_HALF[0], BARREL_HALF[1], BARREL_HALF[2]) * 0.62;
  // Slowest an aimed barrel may sink, in tank units a second.
  // Only a guard against a true stall, not a speed. It used to be 0.75, which
  // sat above the terminal velocity `water drag` implies for anything past
  // about 1 — so the floor, not the slider, decided how fast an aimed barrel
  // sank, and turning drag up did nothing to it. Low enough now that drag has
  // the whole range: a barrel takes about 1.6s to reach the mark at drag 0 and
  // about 7s at drag 10.
  const MIN_SINK = 0.18;
  const barrelGeo = barrelGeometry(THREE);
  // The same shading as the paddle, but over the model's baked base colour and
  // tinted toward the water so it reads as submerged rather than pasted on.
  const barrelMat = (() => {
    const m = new THREE.MeshBasicNodeMaterial();
    const map = texture(barrelTexture(THREE), uv());
    m.colorNode = Fn(() => vec4(
      litByVolume(map, normalWorld.normalize(), positionWorld), 1))();
    return m;
  })();
  // A pool that GROWS: it used to hold six and recycle the oldest live barrel,
  // which quietly deleted one mid-fall if you kept clicking.
  const barrels = [];
  function newBarrel() {
    const mesh = new THREE.Mesh(barrelGeo, barrelMat);
    mesh.visible = false;
    opaqueScene.add(mesh);
    const b = {
      mesh, vel: new THREE.Vector3(), spin: new THREE.Vector3(),
      age: 0, active: false, splashed: false,
      scale: BARREL_SCALE, k: 1, targetY: null, desc: null,
    };
    b.desc = { pos: mesh.position, vel: b.vel, radius: BARREL_SCALE * BARREL_R };
    barrels.push(b);
    return b;
  }
  function sizeBarrel(b, sc) {
    b.scale = sc;
    b.k = sc / BARREL_SCALE;
    b.mesh.scale.setScalar(sc);
    b.desc.radius = sc * BARREL_R;
  }

  // The visitor: same shading as the barrel, in the opaque pass so the volume
  // fogs it — it has to arrive already half dissolved.
  const diverScale = 0.30;
  // 0 = the fish itself, 1 = gone into the water. It fades toward the FOG
  // COLOUR rather than toward alpha because it is drawn in the opaque pass —
  // see the WebGL shader.
  const diverFade = uniform(1);
  const diverFog = uniform(new THREE.Vector3());
  const diverMat = new THREE.MeshBasicNodeMaterial();
  const diverParts = diverModel(THREE, diverMat);
  (() => {
    const map = texture(diverTexture(THREE), uv());
    // The same skinning the WebGL shader does, written out the same way: the
    // three rows per bone come in as a uniform array, and the deform is the
    // weighted sum of the four influences. Nothing here leans on three's own
    // skinning path — see src/model.js for why both backends do it by hand.
    const rows = uniformArray(diverParts.rows, 'vec4');
    const sIdx = attribute('skinIndex', 'uvec4');
    const sW = attribute('skinWeight', 'vec4');
    const boneMat = (i) => {
      const j = int(i).mul(3);
      const a = rows.element(j), b = rows.element(j.add(1)), c = rows.element(j.add(2));
      return mat4(a.x, b.x, c.x, float(0),
                  a.y, b.y, c.y, float(0),
                  a.z, b.z, c.z, float(0),
                  a.w, b.w, c.w, float(1));
    };
    const skin = boneMat(sIdx.x).mul(sW.x)
      .add(boneMat(sIdx.y).mul(sW.y))
      .add(boneMat(sIdx.z).mul(sW.z))
      .add(boneMat(sIdx.w).mul(sW.w));
    diverMat.positionNode = skin.mul(vec4(positionGeometry, 1)).xyz;
    // The normal has to ride the same deform, and a w of 0 drops the
    // translation column — which is mat3(skin) without needing a cast WGSL
    // has no constructor for. Carried across as an explicit varying because
    // the built-in normalWorld is built from the UNSKINNED attribute.
    const nWorld = varying(modelWorldMatrix.mul(
      vec4(skin.mul(vec4(normalGeometry, 0)).xyz, 0)).xyz);
    diverMat.colorNode = Fn(() => {
      const lit = litByVolume(map, nWorld.normalize(), positionWorld);
      return vec4(lerp(lit, diverFog, diverFade.clamp(0, 1)), 1);
    })();
  })();
  const diver = diverParts.mesh;
  diver.scale.setScalar(diverScale);
  opaqueScene.add(diver);
  const visitor = createVisitor(THREE, diverParts, tankHalf);

  // ------------------------------------------------------- render targets --

  let W = 2, H = 2;
  const depthTexture = new THREE.DepthTexture(W, H);
  const opaqueRT = new THREE.RenderTarget(W, H, {
    type: THREE.HalfFloatType, depthTexture, depthBuffer: true,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
  });
  const volRT = new THREE.RenderTarget(W, H, {
    type: THREE.HalfFloatType, depthBuffer: false,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
  });
  const capRT = new THREE.RenderTarget(W, H, { depthBuffer: false });
  const compRT = new THREE.RenderTarget(W, H, {
    type: THREE.HalfFloatType, depthBuffer: false,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
  });
  const bloomRT = () => new THREE.RenderTarget(W, H, {
    type: THREE.HalfFloatType, depthBuffer: false,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
  });
  const bloomA = bloomRT(), bloomB = bloomRT();

  // ---------------------------------------------------- fullscreen passes --

  const fsCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quadPass = (material) => {
    const scene = new THREE.Scene();
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    mesh.frustumCulled = false;
    scene.add(mesh);
    return scene;
  };

  const uInvProjView = uniform(new THREE.Matrix4());
  const uCamPos = uniform(new THREE.Vector3());
  const uCamFwd = uniform(new THREE.Vector3());
  const uSteps = uniform(Q.steps);
  const uFrame = uniform(0);
  const uTimeR = uniform(0);
  const uSun = uniform(sunDir);
  const uSunColor = uniform(new THREE.Vector3(3.6, 3.8, 3.9));
  const uWaterAbsorb = uniform(new THREE.Vector3(1.30, 0.50, 0.26));
  const uWaterScatter = uniform(new THREE.Vector3(0.020, 0.046, 0.076));
  const uFoamScatter = uniform(7.0);
  const uFoamAbsorb = uniform(0.35);
  const uAmbientTop = uniform(new THREE.Vector3(0.11, 0.16, 0.20));
  const uAmbientDeep = uniform(new THREE.Vector3(0.008, 0.03, 0.055));
  const uExposure = uniform(params.exposure);
  const uSurfaceY = uniform(SURFACE_Y);
  const uTank = uniform(tankHalf);
  // Snell's window: what the sky looks like through it, and how much gets in.
  const uSkyZenith = uniform(new THREE.Vector3(0.10, 0.26, 0.46));
  const uSkyHorizon = uniform(new THREE.Vector3(0.52, 0.66, 0.78));
  const uSkyDeep = uniform(new THREE.Vector3(0.014, 0.038, 0.058));
  const uSkyGain = uniform(0.55);
  const uSunVP = uniform(new THREE.Matrix4());
  const uShadowTexel = uniform(1 / 1024);
  const uOccK = uniform(1.0);
  const uOccSoft = uniform(2.0);
  const uChop = uniform(1);
  const debugFoam = query.get('view') === 'foam';
  const uDebugFoam = uniform(debugFoam ? 1 : 0);
  const rippleArr = Array.from({ length: 4 }, () => new THREE.Vector4(0, 0, -100, 0));
  const uRipples = THREE.TSL.uniformArray(rippleArr);
  const N = Q.N;

  const hash12 = (p) => {
    const p3 = vec3(p.x, p.y, p.x).mul(0.1031).fract();
    const q = p3.add(p3.dot(p3.yzx.add(33.33)));
    return q.x.add(q.y).mul(q.z).fract();
  };
  const noise3 = (p) => {
    const i = p.floor();
    const f = p.fract();
    const s = f.mul(f).mul(f.mul(-2).add(3));
    const h = (ox, oy, oz) => {
      const q = i.add(vec3(ox, oy, oz)).mul(0.1031).fract();
      const r = q.add(q.dot(q.zyx.add(31.32)));
      return r.x.add(r.y).mul(r.z).fract();
    };
    const nx0 = lerp(h(0, 0, 0), h(1, 0, 0), s.x);
    const nx1 = lerp(h(0, 1, 0), h(1, 1, 0), s.x);
    const nx2 = lerp(h(0, 0, 1), h(1, 0, 1), s.x);
    const nx3 = lerp(h(0, 1, 1), h(1, 1, 1), s.x);
    return lerp(lerp(nx0, nx1, s.y), lerp(nx2, nx3, s.y), s.z);
  };

  const raymarchMaterial = new THREE.MeshBasicNodeMaterial();
  // WebGPU render targets are stored flipped relative to quad uv; every pass
  // that samples one applies the same flip.
  const flipUV = (u) => vec2(u.x, float(1).sub(u.y));

  // Surface displacement: permanent chop plus decaying rings from impacts.
  // Ocean spectrum — see the WebGL shader for the model and why each part of
  // it is there. Returns height and slope together as vec3(h, dh/dx, dh/dz):
  // taking the normal by finite differences would cost four more evaluations
  // of the whole sum, and every component's slope falls out of the same
  // sin/cos anyway.
  const WAVE_N = 10, WAVE_K0 = 6.2, WAVE_STEP = 1.34;
  const WAVE_FALL = 0.62, WAVE_SCALE = 0.0085, WAVE_G = 2.4, WIND_ANGLE = 0.62;

  const waveField = (xz) => {
    const h = float(0).toVar();
    const gx = float(0).toVar();
    const gz = float(0).toVar();
    for (let i = 0; i < WAVE_N; i++) {
      // unrolled on the JS side: k, direction and amplitude are constants per
      // component, so none of this reaches the shader as arithmetic
      const k = WAVE_K0 * Math.pow(WAVE_STEP, i);
      const amp = Math.pow(WAVE_FALL, i);
      const jit = ((i * 0.6180339887) % 1) * 2 - 1;
      const spread = 0.30 + 1.05 * i / (WAVE_N - 1);
      const ang = WIND_ANGLE + jit * spread;
      const dx = Math.cos(ang), dz = Math.sin(ang);
      const ph = xz.x.mul(dx * k).add(xz.y.mul(dz * k))
        .sub(uTimeR.mul(Math.sqrt(WAVE_G * k))).add(i * 2.3999632);
      const sn = ph.sin().mul(0.5).add(0.5);
      h.addAssign(sn.mul(sn).mul(sn).mul(2).sub(0.625).mul(amp));
      const dh = sn.mul(sn).mul(ph.cos()).mul(3 * amp * k);
      gx.addAssign(dh.mul(dx));
      gz.addAssign(dh.mul(dz));
    }
    const sc = uChop.mul(WAVE_SCALE);
    h.mulAssign(sc); gx.mulAssign(sc); gz.mulAssign(sc);

    Loop({ start: int(0), end: int(4) }, ({ i }) => {
      const r = uRipples.element(i);
      If(r.w.greaterThan(0), () => {
        const age = uTimeR.sub(r.z);
        If(age.greaterThan(0).and(age.lessThan(7)), () => {
          const dv = xz.sub(vec2(r.x, r.y));
          const dd = dv.length();
          const ring = dd.sub(age.mul(0.85));
          const env = r.w.mul(0.05).mul(ring.abs().mul(-4.5).exp())
            .mul(age.mul(-0.55).exp()).div(dd.mul(1.5).add(1));
          h.addAssign(env.mul(ring.mul(20.0).sin()));
          const rg = env.mul(20.0).mul(ring.mul(20.0).cos()).div(dd.max(1e-4));
          gx.addAssign(dv.x.mul(rg));
          gz.addAssign(dv.y.mul(rg));
        });
      });
    });
    return vec3(h, gx, gz);
  };

  const waveH = (xz) => waveField(xz).x;

  // Where the ray meets the DISPLACED surface, not its mean plane — see the
  // WebGL shader for why a fixed-point solve will not do here.
  const surfaceT = (ro, rd, t0, t1, flatT) => {
    // bound on |waveH| — see the WebGL shader; derived rather than fixed at
    // the worst case so the steps below stay fine enough to resolve the crossing
    const A = uChop.mul(0.0305).add(0.07);
    const ia = uSurfaceY.add(A).sub(ro.y).div(rd.y);
    const ib = uSurfaceY.sub(A).sub(ro.y).div(rd.y);
    const ta = ia.min(ib).max(t0).toVar();
    const tb = ia.max(ib).min(t1).toVar();
    const out = flatT.toVar();
    If(tb.greaterThan(ta), () => {
      const dt = tb.sub(ta).div(24);
      const tp = ta.toVar();
      const qa = ro.add(rd.mul(ta));
      const fp = qa.y.sub(uSurfaceY).sub(waveH(vec2(qa.x, qa.z))).toVar();
      const hit = float(0).toVar();
      Loop({ start: 1, end: 25 }, ({ i }) => {
        const t = ta.add(dt.mul(float(i)));
        const q = ro.add(rd.mul(t));
        const f = q.y.sub(uSurfaceY).sub(waveH(vec2(q.x, q.z)));
        If(f.mul(fp).lessThanEqual(0).and(hit.equal(0)), () => {
          const dn = fp.sub(f);
          out.assign(tp.add(t.sub(tp).mul(fp.div(dn.abs().max(1e-8).mul(dn.sign()))
            .clamp(0, 1))));
          hit.assign(1);
          Break();
        });
        tp.assign(t);
        fp.assign(f);
      });
    });
    return out;
  };

  const waveNormal = (xz) => {
    const f = waveField(xz);
    return vec3(f.y.negate(), 1, f.z.negate()).normalize();
  };
  const foamAt = (p) => texture3D(fluid.foamTexture, p.mul(0.5).add(0.5), float(0)).x;

  raymarchMaterial.colorNode = Fn(() => {
    const suv = uv();
    const ndc = suv.mul(2).sub(1);
    const far4 = uInvProjView.mul(vec4(ndc, 1, 1));
    const rd = far4.xyz.div(far4.w).sub(uCamPos).normalize().toVar();
    const ro = uCamPos.toVar();

    const boxT = (o, d) => {
      const inv = vec3(1).div(d);
      const ta = vec3(uTank).negate().sub(o).mul(inv);
      const tb = vec3(uTank).sub(o).mul(inv);
      const lo = ta.min(tb);
      const hi = ta.max(tb);
      return vec2(lo.x.max(lo.y).max(lo.z), hi.x.min(hi.y).min(hi.z));
    };
    const tb0 = boxT(ro, rd);
    const t0 = tb0.x.max(0).toVar();
    const t1 = tb0.y.toVar();

    // depth clamp against the opaque pass
    const dep = texture(depthTexture, flipUV(suv)).x;
    const tOpaque = float(1e9).toVar();
    If(dep.lessThan(1), () => {
      const near = float(camera.near), far = float(camera.far);
      const dist = near.mul(far).div(far.sub(dep.mul(far.sub(near))));
      tOpaque.assign(dist.div(rd.dot(uCamFwd).max(1e-4)));
      t1.assign(t1.min(tOpaque));
    });

    // --- free surface -------------------------------------------------------
    const surfaceL = vec3(0).toVar();
    const surfMirror = float(0).toVar();   // >0 when the march draws a reflection
    If(rd.y.abs().greaterThan(1e-5), () => {
      const tS = surfaceT(ro, rd, t0, t1, uSurfaceY.sub(ro.y).div(rd.y));
      If(ro.y.greaterThan(uSurfaceY), () => {
        If(rd.y.greaterThanEqual(0).or(tS.greaterThanEqual(t1)), () => {
          t1.assign(t0);                       // stays in the air above the water
        }).ElseIf(tS.greaterThan(t0), () => {
          const ps = ro.add(rd.mul(tS));
          const wf = waveField(vec2(ps.x, ps.z));
          const nrm = vec3(wf.y.negate(), 1, wf.z.negate()).normalize();
          const cap = smoothstep(0.75, 2.1, vec2(wf.y, wf.z).length());
          const hv = uSun.negate().sub(rd).normalize();
          const spec = nrm.dot(hv).max(0).pow(220).mul(2.6)
            .add(nrm.dot(hv).max(0).pow(24).mul(0.12));
          const fres = float(0.02).add(float(0.98)
            .mul(float(1).sub(rd.negate().dot(nrm).max(0)).pow(5)));
          const raft = smoothstep(0.12, 1.1, foamAt(vec3(ps.x, uSurfaceY.sub(0.04), ps.z)));
          surfaceL.assign(uSunColor.mul(spec)
            .add(vec3(0.012, 0.035, 0.055).mul(fres))
            .add(vec3(0.34, 0.45, 0.53).mul(raft.max(cap))));
          // refract the view ray as it enters the water
          const rr = THREE.TSL.refract(rd, nrm, float(1 / 1.333));
          If(rr.dot(rr).greaterThan(0), () => {
            ro.assign(ps);
            rd.assign(rr.normalize());
            const nb = boxT(ro.add(rd.mul(1e-3)), rd);
            t0.assign(nb.x.max(0).add(1e-3));
            t1.assign(nb.y);
            If(tOpaque.lessThan(1e8), () => { t1.assign(t1.min(tOpaque.sub(tS).max(0))); });
          }).Else(() => { t1.assign(t0); });
        });
      }).ElseIf(rd.y.greaterThan(0).and(tS.lessThanEqual(t0)), () => {
        // crossed the waterline before reaching the tank: the whole span in the
        // box is air — see the WebGL shader
        t1.assign(t0);
      }).ElseIf(rd.y.greaterThan(0).and(tS.lessThan(t1)), () => {
        // Looking up from below. Inside Snell's window the surface is a window
        // onto a dark room; outside it, it is a mirror of the tank itself, so
        // the ceiling carries the plumes and the floor upside down.
        const ps = ro.add(rd.mul(tS));
        const wf = waveField(vec2(ps.x, ps.z));
        const nrm = vec3(wf.y.negate(), 1, wf.z.negate()).normalize();
        // whitecaps: slope stands in for the displacement Jacobian a height
        // field has no fold to test — see the WebGL shader
        const cap = smoothstep(0.75, 2.1, vec2(wf.y, wf.z).length());
        const cosI = rd.dot(nrm).max(0);
        const sinT2 = float(1.333 * 1.333).mul(float(1).sub(cosI.mul(cosI)));
        const raft = smoothstep(0.10, 1.0, foamAt(vec3(ps.x, uSurfaceY.sub(0.04), ps.z)));
        // Fresnel on top of the hard critical-angle cutoff, so the rim of the
        // window brightens smoothly instead of switching on.
        const fres = float(0.02).add(float(0.98).mul(float(1).sub(cosI).pow(5)));
        const mirror = smoothstep(0.80, 1.02, sinT2).max(fres).clamp(0, 1);
        // Through the window: the SKY. See the WebGL shader — a flat dark room
        // in here is the single reason the surface read as a lid, since dark
        // inside the window and a mirror of dark water outside leaves nothing
        // bright anywhere to read the water by.
        const through = uSkyDeep.toVar();
        const rt = THREE.TSL.refract(rd, nrm.negate(), float(1.333));
        If(rt.dot(rt).greaterThan(0), () => {
          const sdir = rt.normalize();
          const upness = sdir.y.clamp(0, 1);
          const sky = lerp(uSkyHorizon, uSkyZenith, upness.pow(0.55)).toVar();
          const sd = sdir.dot(uSun.negate()).max(0);
          sky.addAssign(uSunColor.mul(sd.pow(600).mul(2.2).add(sd.pow(26).mul(0.18))));
          through.assign(lerp(uSkyDeep, sky, uSkyGain));
        });
        surfaceL.assign(through.mul(float(1).sub(mirror))
          .add(lerp(vec3(0.30, 0.40, 0.48), vec3(0.45, 0.56, 0.64), mirror)
            .mul(raft.max(cap.mul(0.8)))));
        If(mirror.greaterThan(0.002), () => {
          // fold the ray back down and let the same march draw the reflection
          surfMirror.assign(mirror);
          ro.assign(ps);
          rd.assign(THREE.TSL.reflect(rd, nrm));
          const nb = boxT(ro.add(rd.mul(1e-3)), rd);
          t0.assign(nb.x.max(0).add(1e-3));
          t1.assign(nb.y);
        }).Else(() => { t1.assign(tS); });
      });
    });

    const L = vec3(0).toVar();
    const T = vec3(1).toVar();
    const peakFoam = float(0).toVar();
    If(t1.greaterThan(t0), () => {
      const n = float(uSteps);
      const dt = t1.sub(t0).div(n);
      const jp = vec3(suv.mul(997), uFrame).mul(0.1031).fract();
      const jq = jp.add(jp.dot(jp.zyx.add(31.32)));
      const jit = jq.x.add(jq.y).mul(jq.z).fract();
      const mu = rd.dot(uSun);
      const phase = mu.add(1).mul(0.5).pow(2).mul(0.6).add(0.4);
      const t = t0.add(jit.mul(dt)).toVar();

      Loop({ start: 0, end: 400 }, ({ i }) => {
        If(float(i).greaterThanEqual(n).or(t.greaterThanEqual(t1)), () => { Break(); });
        const p = ro.add(rd.mul(t));
        const pv = p.mul(0.5).add(0.5).mul(N);
        const foamRaw = texture3D(fluid.foamTexture, pv.div(N), float(0)).x;
        const foam = foamRaw.mul(noise3(pv.mul(0.55)).mul(0.8).add(0.6));
        peakFoam.assign(peakFoam.max(foamRaw));
        const lt = texture3D(fluid.lightTexture, pv.div(N), float(0)).x.toVar();

        // Geometry shadow, tested HERE rather than baked into the light volume
        // — see the WebGL raymarch: that volume is 64 voxels across the whole
        // tank, so a silhouette lands on a handful of them and the trilinear
        // filter wipes out what survives. One tap per step, jittered, and the
        // eighty-odd steps average into a penumbra on their own.
        const blocked = float(0).toVar();
        If(uOccK.greaterThan(0), () => {
          const lp = uSunVP.mul(vec4(p.mul(uTank), 1));
          const nd = lp.xyz.div(lp.w.max(1e-6));
          const ssuv = nd.xy.mul(0.5).add(0.5);
          const sdp = nd.z.mul(0.5).add(0.5).sub(0.0028);
          const ok = sdp.greaterThan(0).and(sdp.lessThan(1))
            .and(ssuv.x.greaterThan(0)).and(ssuv.x.lessThan(1))
            .and(ssuv.y.greaterThan(0)).and(ssuv.y.lessThan(1));
          If(ok, () => {
            const hp = vec3(suv.mul(997), float(i).add(uFrame)).mul(0.1031).fract();
            const hq = hp.add(hp.dot(hp.zyx.add(19.19)));
            const jt = vec2(hq.x.add(hq.y).mul(hq.z).fract(),
              hq.y.add(hq.z).mul(hq.x).fract()).sub(0.5);
            const gs = sdp.lessThanEqual(texture(fluid.sunRT.depthTexture,
              ssuv.add(jt.mul(uOccSoft.mul(2).mul(uShadowTexel))), float(0)).x)
              .select(float(1), float(0));
            // up to 1 the step loses the direct sun it cannot see, which is
            // the physical thing and far too polite to notice; past 1 it loses
            // its ambient too — see the WebGL raymarch
            blocked.assign(float(1).sub(gs).mul(uOccK));
            lt.mulAssign(float(1).sub(blocked.min(1)));
          });
        });

        const sigS = uWaterScatter.add(vec3(uFoamScatter).mul(foam));
        const sigT = uWaterAbsorb.add(sigS).add(vec3(uFoamAbsorb).mul(foam));
        const h = float(1).sub(uSurfaceY.sub(p.y).max(0).div(1.5)).clamp(0, 1);
        const Li = uSunColor.mul(lt.mul(phase))
          .add(lerp(uAmbientDeep, uAmbientTop, h).mul(lt.pow(0.6).mul(0.88).add(0.12)))
          .mul(float(1).sub(blocked.sub(1).clamp(0, 1)));

        const aStep = sigT.mul(dt).negate().exp();
        L.addAssign(T.mul(sigS).mul(Li).mul(vec3(1).sub(aStep)).div(sigT.max(vec3(1e-4))));
        T.mulAssign(aStep);
        If(T.x.max(T.y).max(T.z).lessThan(0.004), () => {
          T.assign(vec3(0));
          Break();
        });
        t.addAssign(dt);
      });
    });
    // ?view=foam bypasses lighting entirely: black means the sim produced no
    // foam; a visible plume means the problem is downstream in the shading
    const alpha = T.x.add(T.y).add(T.z).div(3).toVar();
    If(surfMirror.greaterThan(0), () => {
      // A reflected ray leaves through a wall of the tank, not into the room,
      // so its remaining transmittance lands on the tank's own dim interior.
      // Letting the real background through there tore the ceiling into black
      // patches wherever the reflection ran clear.
      L.addAssign(T.mul(lerp(uAmbientDeep, uAmbientTop, float(0.35))).mul(1.6));
      L.assign(L.mul(surfMirror));
      alpha.assign(float(1).sub(surfMirror));
    });
    If(uDebugFoam.greaterThan(0.5), () => {
      L.assign(vec3(peakFoam.mul(0.8)));
      surfaceL.assign(vec3(0));
      alpha.assign(float(0));
    });
    return vec4(L.add(surfaceL), alpha);
  })();

  const raymarchScene = quadPass(raymarchMaterial);

  // composite: opaque scene attenuated by the volume, plus its inscatter
  const compositeMaterial = new THREE.MeshBasicNodeMaterial();
  compositeMaterial.colorNode = Fn(() => {
    const suv = uv();
    const flip = vec2(suv.x, float(1).sub(suv.y));
    const scene = texture(opaqueRT.texture, flip);
    const vol = texture(volRT.texture, flip);
    return vec4(scene.rgb.mul(vol.a).add(vol.rgb), 1);
  })();
  const compositeScene = quadPass(compositeMaterial);

  const uBloomThreshold = uniform(0.75);
  const brightMaterial = new THREE.MeshBasicNodeMaterial();
  brightMaterial.colorNode = Fn(() => {
    const c = texture(compRT.texture, flipUV(uv())).rgb;
    const l = c.dot(vec3(0.2126, 0.7152, 0.0722));
    return vec4(c.mul(smoothstep(uBloomThreshold, uBloomThreshold.mul(2).add(0.15), l)), 1);
  })();
  const brightScene = quadPass(brightMaterial);

  const uBlurDir = uniform(new THREE.Vector2());
  const uBlurTex = texture(bloomA.texture);
  const blurMaterial = new THREE.MeshBasicNodeMaterial();
  blurMaterial.colorNode = Fn(() => {
    const suv = uv();
    const o1 = uBlurDir.mul(1.3846153846);
    const o2 = uBlurDir.mul(3.2307692308);
    const fuv = flipUV(suv);
    const tex = (off) => texture(uBlurTex).sample(fuv.add(off)).rgb;
    return vec4(tex(vec2(0, 0)).mul(0.227027)
      .add(tex(o1).add(tex(o1.negate())).mul(0.3162162162))
      .add(tex(o2).add(tex(o2.negate())).mul(0.0702702703)), 1);
  })();
  const blurScene = quadPass(blurMaterial);

  const finalMaterial = new THREE.MeshBasicNodeMaterial();
  finalMaterial.colorNode = Fn(() => {
    const suv = uv();
    const fuv = flipUV(suv);
    const col = texture(compRT.texture, fuv).rgb
      .add(texture(bloomA.texture, fuv).rgb.mul(0.28)).toVar();
    const q = suv.sub(0.5);
    col.mulAssign(float(1).sub(q.dot(q).mul(2.2).mul(0.32)));
    col.mulAssign(uExposure);
    const a = col.mul(col.mul(2.51).add(0.03));
    const b = col.mul(col.mul(2.43).add(0.59)).add(0.14);
    col.assign(a.div(b).clamp(0, 1));
    col.addAssign(hash12(suv.mul(913.7).add(uTimeR.fract().mul(71.3))).sub(0.5).mul(0.012));
    // the readback target gets no renderer colour-space encode; the canvas
    // path does, so only encode manually in headless capture mode
    if (headlessCapture) col.assign(col.max(0).pow(1 / 2.2));
    return vec4(col, 1);
  })();
  const finalScene = quadPass(finalMaterial);

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, Q.dpr);
    const w = Math.max(2, Math.floor(canvas.clientWidth * dpr));
    const h = Math.max(2, Math.floor(canvas.clientHeight * dpr));
    if (w === W && h === H) return;
    W = w; H = h;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (!userZoomed) { orbit.dist = fitDistance(); updateCamera(); }
    opaqueRT.setSize(w, h);
    volRT.setSize(Math.floor(w * Q.scale), Math.floor(h * Q.scale));
    capRT.setSize(w, h);
    compRT.setSize(w, h);
    bloomA.setSize(Math.max(w >> 2, 2), Math.max(h >> 2, 2));
    bloomB.setSize(Math.max(w >> 2, 2), Math.max(h >> 2, 2));
  }
  window.addEventListener('resize', resize);

  // ---------------------------------------------------------- interaction --

  const raycaster = new THREE.Raycaster();
  const pointers = new Map();
  const drag = {
    mode: null, moved: 0, t0: 0,
    plane: new THREE.Plane(), offset: new THREE.Vector3(),
    last: { x: 0, y: 0 }, pinch: 0,
  };
  const paddleTarget = paddle.position.clone();
  const paddleVel = new THREE.Vector3();
  let lastInteract = -10;
  const stirPhase = Math.random() * 20;
  // advanced only while stirring, so pausing and resuming is continuous
  let stirClock = 0;

  function pointerRay(e) {
    const r = canvas.getBoundingClientRect();
    raycaster.setFromCamera(new THREE.Vector2(
      ((e.clientX - r.left) / r.width) * 2 - 1,
      -((e.clientY - r.top) / r.height) * 2 + 1), camera);
    return raycaster.ray;
  }
  function rayBox(ray) {
    const inv = new THREE.Vector3(1 / ray.direction.x, 1 / ray.direction.y, 1 / ray.direction.z);
    const a = new THREE.Vector3(-tankHalf, -tankHalf, -tankHalf).sub(ray.origin).multiply(inv);
    const b = new THREE.Vector3(tankHalf, tankHalf, tankHalf).sub(ray.origin).multiply(inv);
    const lo = a.clone().min(b), hi = a.clone().max(b);
    const t0 = Math.max(lo.x, lo.y, lo.z), t1 = Math.min(hi.x, hi.y, hi.z);
    return t1 > Math.max(t0, 0) ? [Math.max(t0, 0), t1] : null;
  }

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [p1, p2] = [...pointers.values()];
      drag.pinch = Math.hypot(p1.x - p2.x, p1.y - p2.y);
      drag.mode = 'pinch';
      return;
    }
    if (pointers.size > 2) return;
    drag.moved = 0;
    drag.t0 = performance.now();
    drag.last = { x: e.clientX, y: e.clientY };
    pointerRay(e);
    const hit = paddleHidden ? [] : raycaster.intersectObject(paddle, false);
    if (hit.length) {
      drag.mode = 'paddle';
      drag.plane.setFromNormalAndCoplanarPoint(
        camera.getWorldDirection(new THREE.Vector3()).negate(), paddle.position);
      drag.offset.copy(hit[0].point).sub(paddle.position);
      paddleTarget.copy(paddle.position);
      lastInteract = clock.elapsedTime;
    } else {
      drag.mode = 'orbit';
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (drag.mode === 'pinch') {
      if (pointers.size >= 2) {
        const [p1, p2] = [...pointers.values()];
        const d = Math.hypot(p1.x - p2.x, p1.y - p2.y);
        if (drag.pinch > 0) { orbit.dist *= drag.pinch / d; userZoomed = true; }
        drag.pinch = d;
        updateCamera();
      }
      return;
    }
    if (pointers.size > 1 || !drag.mode) return;
    const dx = e.clientX - drag.last.x, dy = e.clientY - drag.last.y;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    drag.last = { x: e.clientX, y: e.clientY };
    if (drag.mode === 'orbit') {
      // deliberately inert: the view is fixed, so a drag on the water is only
      // ever a tap that missed. `spin view` still orbits on request.
    } else if (drag.mode === 'paddle') {
      const ray = pointerRay(e);
      const p = new THREE.Vector3();
      if (ray.intersectPlane(drag.plane, p)) {
        paddleTarget.copy(p.sub(drag.offset)).clampScalar(-0.66 * tankHalf, 0.66 * tankHalf);
      }
      lastInteract = clock.elapsedTime;
    }
  });
  function endPointer(e, cancelled) {
    pointers.delete(e.pointerId);
    if (drag.mode === 'pinch') {
      if (pointers.size < 2) drag.mode = null;
      return;
    }
    const quick = !cancelled && performance.now() - drag.t0 < 280 && drag.moved < 8;
    if (quick && drag.mode === 'orbit') {
      const ray = pointerRay(e);
      const t = rayBox(ray);
      if (t) {
        const p = ray.origin.clone().addScaledVector(ray.direction, t[0] + (t[1] - t[0]) * 0.35);
        // a tap sends a barrel down to that spot, splashing in on the way, and
        // it detonates when it gets there. It deliberately does NOT touch
        // lastInteract: that pauses the auto-stir, and it exists for dragging
        // the paddle, not for anything else you do to the tank.
        dropBarrel(p.clampScalar(-0.78 * tankHalf, 0.78 * tankHalf));
        addRipple(p.x, p.z, 0.35 + 0.55 * Math.max(0, (p.y + 0.6) / 1.3));
      }
    }
    drag.mode = null;
  }
  canvas.addEventListener('pointerup', (e) => endPointer(e, false));
  canvas.addEventListener('pointercancel', (e) => endPointer(e, true));
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    orbit.dist *= Math.exp(e.deltaY * 0.0012);
    userZoomed = true;
  userZoomed = true;
    updateCamera();
  }, { passive: false });

  const spinBtn = document.getElementById('spin-btn');
  const stirBtn = document.getElementById('stir-btn');
  // Stopping the water means stopping what is driving it too: the paddle
  // re-forces the flow within a single frame, so zeroing velocity on its own
  // is undone before it is ever seen.
  // The mobile bar: a barrel is the one thing worth doing without opening
  // anything, so it stays on screen; everything else is behind `controls`.
  // The frame rate is the one number always on screen; the rest of the
  // readout hides behind it until asked for.
  const fpsBtn = document.getElementById('fps-badge');
  fpsBtn.addEventListener('click', () => {
    const open = document.body.classList.toggle('stats-open');
    fpsBtn.setAttribute('aria-expanded', String(open));
  });
  const sheet = (open) => document.body.classList.toggle('sheet-open', open);
  document.getElementById('fab-barrel').addEventListener('click', () => dropBarrel());
  document.getElementById('fab-menu').addEventListener('click', () => sheet(true));
  document.getElementById('sheet-close').addEventListener('click', () => sheet(false));
  document.getElementById('clear-btn').addEventListener('click', () => fluid.clear());
  document.getElementById('calm-btn').addEventListener('click', () => {
    setStir(false);
    fluid.still();
  });
  const spinPaddleBtn = document.getElementById('spin-paddle-btn');
  function syncButtons() {
    spinBtn.classList.toggle('active', params.autoSpin);
    spinBtn.setAttribute('aria-pressed', String(params.autoSpin));
    spinPaddleBtn.classList.toggle('active', params.paddleSpin);
    spinPaddleBtn.setAttribute('aria-pressed', String(params.paddleSpin));
    stirBtn.classList.toggle('active', params.stir);
    stirBtn.setAttribute('aria-pressed', String(params.stir));
  }
  const setStir = (v) => { params.stir = v; syncButtons(); };
  stirBtn.addEventListener('click', () => setStir(!params.stir));
  const toggleSpin = () => { params.autoSpin = !params.autoSpin; syncButtons(); };
  const togglePaddleSpin = () => { params.paddleSpin = !params.paddleSpin; syncButtons(); };
  spinBtn.addEventListener('click', toggleSpin);
  spinPaddleBtn.addEventListener('click', togglePaddleSpin);
  document.getElementById('barrel-btn').addEventListener('click', () => dropBarrel());
  const speedSlider = document.getElementById('spin-speed-slider');
  const speedVal = document.getElementById('spin-speed-val');
  speedSlider.value = params.paddleSpinSpeed;
  speedVal.textContent = params.paddleSpinSpeed.toFixed(1);
  speedSlider.addEventListener('input', () => {
    params.paddleSpinSpeed = +speedSlider.value;
    speedVal.textContent = params.paddleSpinSpeed.toFixed(1);
    if (!params.paddleSpin) { params.paddleSpin = true; syncButtons(); }
  });
  const hidePaddleBtn = document.getElementById('hide-paddle-btn');
  // starts out of the tank: the water is left to barrels and taps unless you
  // bring the paddle back in
  let paddleHidden = true;
  function setPaddleHidden(v) {
    paddleHidden = v;
    paddle.visible = !v;
    // The check box says whether the paddle is IN the tank, so it reads the
    // opposite way round to the flag behind it.
    hidePaddleBtn.classList.toggle('active', !v);
    hidePaddleBtn.setAttribute('aria-pressed', String(!v));
    spinPaddleBtn.disabled = v;
    speedSlider.disabled = v;
    if (v) {
      paddleVel.set(0, 0, 0);
      paddleAngVel.set(0, 0, 0);
    }
  }
  hidePaddleBtn.addEventListener('click', () => setPaddleHidden(!paddleHidden));
  // The sun's view of the solids. Rendered before the light pass reads it, with
  // the meshes keeping their OWN materials — the fish is skinned in a custom
  // shader, and an override material would cast its bind pose.
  const sunCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 10);
  const sunVP = new THREE.Matrix4();
  function updateSunCamera() {
    const d = 3.0 * tankHalf;
    const e = 1.45 * tankHalf;
    sunCam.position.copy(sunDir).multiplyScalar(-d);
    sunCam.lookAt(0, 0, 0);
    sunCam.left = -e; sunCam.right = e; sunCam.top = e; sunCam.bottom = -e;
    sunCam.near = 0.01; sunCam.far = 2.2 * d;
    sunCam.updateProjectionMatrix();
    sunCam.updateMatrixWorld();
    sunVP.multiplyMatrices(sunCam.projectionMatrix, sunCam.matrixWorldInverse);
  }
  updateSunCamera();

  function setTank(v) {
    tankHalf = v;
    SURFACE_Y = FILL * tankHalf;
    fluid.tank = tankHalf;
    fluid.surfaceY = SURFACE_Y;
    uTank.value = tankHalf;
    uMeshTank.value = tankHalf;
    updateSunCamera();
    uSurfaceY.value = SURFACE_Y;
    paddleTarget.clampScalar(-0.66 * tankHalf, 0.66 * tankHalf);
    paddle.position.clampScalar(-0.66 * tankHalf, 0.66 * tankHalf);
  }

  buildPhysicsPanel(fluid.physics);
  // the geometry is authored once, so the mesh scales and the solver's
  // half-extents follow; extractRotation drops the scale, so the rigid-body
  // coupling is unaffected
  function setPaddleScale(v) {
    paddleScale = v;
    paddleHalf.copy(PADDLE_HALF_BASE).multiplyScalar(v);
    paddle.scale.setScalar(v);
    paddle.updateMatrixWorld();
  }
  buildScenePanel({
    gridN: Q.N,
    particleCount: particleTarget,
    tankHalf,
    onTank: setTank,
    paddleScale,
    onPaddleScale: setPaddleScale,
  });
  setTank(tankHalf);   // apply ?tank= to the glass, surface and clamps
  setPaddleScale(paddleScale);   // the blade starts at PADDLE_SCALE0
  buildEmitterPanel(fluid.emitter);   // mutated in place; the solver reads it each step
  buildTunePanel(TUNE, {
    blast: () => detonate(new THREE.Vector3(0, -0.1 * tankHalf, 0), clock.elapsedTime, 1),
    refit: () => { userZoomed = false; orbit.dist = fitDistance(); updateCamera(); },
    summon: () => visitor.begin(),
    scrub: (v) => {
      if (!visitor.state.mesh.visible) visitor.begin();
      visitor.state.t = v;
      visitor.update(0, tankHalf);
    },
  });

  buildCodePanel(() => ({
    backend: 'WebGPU', N: Q.N, jacobi: Q.jacobi, particleCount,
    tankHalf, paddleScale, physics: fluid.physics,
  }));
  syncButtons();
  initChrome({ backend: 'WebGPU' }); // hide-ui + fullscreen + backend switch

  window.addEventListener('keydown', (e) => {
    if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code === 'Space') { dropBarrel(); e.preventDefault(); }
    else if (e.code === 'KeyO') toggleSpin();
    else if (e.code === 'KeyR') togglePaddleSpin();
    else if (e.code === 'KeyX') setPaddleHidden(!paddleHidden);
    else if (e.code === 'KeyB') dropBarrel();
    else if (e.code === 'KeyC') fluid.clear();
    else if (e.code === 'KeyP') params.paused = !params.paused;
    else if (e.code === 'KeyQ') {
      const names = Object.keys(QUALITY);
      const q = new URLSearchParams(location.search);
      q.set('q', names[(names.indexOf(params.quality) + 1) % names.length]);
      if (params.stir) q.delete('stir'); else q.set('stir', '0');
      location.search = `?${q}`;
    }
  });

  // ------------------------------------------------------------------ hud --

  const statEls = {};
  for (const el of document.querySelectorAll('[data-k]')) statEls[el.dataset.k] = el;
  const fpsCounter = { frames: 0, t: performance.now() / 1000, fps: 0 };
  const simMs = { v: 0 };
  function updateHud() {
    statEls.res.textContent = `${W} × ${H}`;
    statEls.grid.textContent = `${Q.N}³ · ${(Q.N ** 3 / 1e6).toFixed(2)} M voxels`;
    if (statEls.backend) statEls.backend.textContent = compat.on ? 'WebGPU' : 'WebGPU · no compat';
    statEls.simLabel.textContent = 'Simulate, CPU';
    statEls.renLabel.textContent = 'Render, CPU';
    statEls.sim.textContent = `${simMs.v.toFixed(2)} ms`;
    statEls.ren.textContent = '—';
    statEls.parts.textContent = particleCount ? `${(particleCount / 1000).toFixed(1)} K` : '—';
    statEls.fps.textContent = fpsCounter.fps ? fpsCounter.fps.toFixed(1) : '—';
    if (statEls.fpsBadge) statEls.fpsBadge.textContent = fpsCounter.fps
      ? fpsCounter.fps.toFixed(fpsCounter.fps < 10 ? 1 : 0) : '—';
    statEls.vram.textContent = `${Math.round((fluid.bytes + W * H * 8 * 2) / (1 << 20))} MiB`;
    if (wantProbe) { readProbe(); statEls.vram.textContent += `  ·  foam/vel ${probeText}`; }
    statEls.stir.textContent =
      (params.stir ? 'auto' : 'manual') + (params.paddleSpin ? ' + spin' : '');
  }

  // ------------------------------------------------------- paddle & barrel --

  const clock = {
    last: performance.now() / 1000,
    elapsedTime: 0,
    rawDelta: 0,
    getDelta(paused) {
      const now = performance.now() / 1000;
      this.rawDelta = Math.min(now - this.last, 0.1);
      const dt = paused ? 0 : Math.min(now - this.last, params.dtCap);
      this.last = now;
      this.elapsedTime += dt;
      return dt;
    },
  };
  let frames = 0;
  const seedBursts = [
    { t: 0.15, pos: new THREE.Vector3(-0.30, -0.45, 0.05), vel: 1.2, up: 1.0, foam: 1.5, radius: 0.18 },
    { t: 0.45, pos: new THREE.Vector3(0.35, -0.25, 0.30), vel: 1.0, up: 0.8, foam: 1.2, radius: 0.18 },
    { t: 0.80, pos: new THREE.Vector3(0.05, -0.55, -0.30), vel: 1.3, up: 1.0, foam: 1.4, radius: 0.18 },
  ];

  const prevPaddle = paddle.position.clone();
  const instVel = new THREE.Vector3();
  const rotMat3 = new THREE.Matrix3();
  const rotMat4 = new THREE.Matrix4();
  const paddleAngVel = new THREE.Vector3();
  const prevQuat = paddle.quaternion.clone();
  const dQuat = new THREE.Quaternion();
  const angInst = new THREE.Vector3();
  let spinAngle = 0;
  const paddleState = {
    on: true, pos: paddle.position, vel: paddleVel, angVel: paddleAngVel,
    half: paddleHalf, rot: rotMat3,
  };

  function updatePaddle(dt, t) {
    if (paddleHidden) {
      prevPaddle.copy(paddle.position);
      prevQuat.copy(paddle.quaternion);
      paddleVel.set(0, 0, 0);
      paddleAngVel.set(0, 0, 0);
      fluid.paddle = null;
      return;
    }
    const stirring = params.stir && (t - lastInteract > 4 || lastInteract < 0);
    if (stirring && drag.mode !== 'paddle') {
      stirClock += dt * params.stirSpeed;
      const s = stirPhase + stirClock;
      paddleTarget.set(
        0.55 * Math.sin(0.62 * s + 1.0),
        -0.12 + 0.42 * Math.sin(0.47 * s + 2.1),
        0.55 * Math.sin(0.83 * s + 4.0));
      if (!params.paddleSpin) {
        paddle.rotation.set(
          0.55 * Math.sin(0.50 * s), 0.35 * s, 0.45 * Math.sin(0.71 * s + 1.0));
      }
    }
    if (params.paddleSpin) {
      spinAngle += dt * params.paddleSpinSpeed;
      paddle.rotation.set(spinAngle, 0.35, 0.0);
    }
    const k = 1 - Math.exp(-dt * (drag.mode === 'paddle' ? 20 : 6));
    paddle.position.lerp(paddleTarget, k);
    paddle.updateMatrixWorld();

    instVel.copy(paddle.position).sub(prevPaddle).divideScalar(Math.max(dt, 1e-4));
    paddleVel.lerp(instVel, 1 - Math.exp(-dt * 12));
    prevPaddle.copy(paddle.position);

    dQuat.copy(prevQuat).invert().premultiply(paddle.quaternion);
    if (dQuat.w < 0) { dQuat.x *= -1; dQuat.y *= -1; dQuat.z *= -1; dQuat.w *= -1; }
    const half = Math.min(Math.acos(Math.min(dQuat.w, 1)), 1.5);
    const sinHalf = Math.sin(half);
    if (sinHalf > 1e-5 && dt > 1e-4) {
      angInst.set(dQuat.x, dQuat.y, dQuat.z).divideScalar(sinHalf)
        .multiplyScalar(2 * half / dt).clampLength(0, 12);
    } else {
      angInst.set(0, 0, 0);
    }
    paddleAngVel.lerp(angInst, 1 - Math.exp(-dt * 12));
    prevQuat.copy(paddle.quaternion);

    rotMat4.extractRotation(paddle.matrixWorld);
    rotMat3.setFromMatrix4(rotMat4).transpose();
    fluid.paddle = paddleState;
  }

  const explosionQueue = [];
  const phaseHold = (ph) => (ph.hold ?? 0) * (ph.lift === 0 ? TUNE.cavityHold : 1);
  let blastPhase = null;   // the phase being held, and what is left of it
  let blastLeft = 0;
  const lastBlast = { pos: new THREE.Vector3(), until: -1 };
  const liveBarrels = [];



  // `at` aims the drop: the barrel falls straight down onto that x/z and
  // detonates when it reaches that depth, so a click lands the blast where
  // you pointed. Without it the barrel is scattered and blows up on the floor.
  function dropBarrel(at) {
    const b = barrels.find((x) => !x.active) || newBarrel();
    b.active = true;
    b.age = 0;
    b.splashed = false;
    sizeBarrel(b, TUNE.barrelFixed > 0 ? TUNE.barrelFixed
      : TUNE.barrelMin + Math.random() * (TUNE.barrelMax - TUNE.barrelMin));
    if (at) {
      b.mesh.position.set(at.x, 0.95 * tankHalf, at.z);
      // never above the waterline, or it would detonate before it got wet
      b.targetY = Math.min(at.y, SURFACE_Y - 0.06);
      b.vel.set(0, -2.3, 0);
    } else {
      b.mesh.position.set((Math.random() - 0.5) * 1.2 * tankHalf, 0.95 * tankHalf,
        (Math.random() - 0.5) * 1.2 * tankHalf);
      // An unaimed drop picks its own depth rather than running a fuse out to
      // the floor, so a handful dropped together stagger themselves up and
      // down the tank instead of all piling into the bottom.
      const lo = -0.72 * tankHalf, hi = SURFACE_Y - 0.15 * tankHalf;
      b.targetY = lo + Math.random() * (hi - lo);
      b.vel.set((Math.random() - 0.5) * 0.2, -2.3, (Math.random() - 0.5) * 0.2);
    }
    b.mesh.rotation.set(Math.random() * 0.5, Math.random() * 6.28, Math.random() * 0.5);
    b.spin.set(1.1, 0.4, 0.8);
    b.mesh.visible = true;
  }

  // A full detonation: implosion, then the blast — and the blast seeds a
  // vortex ring that widens as it rises, which is what rolls the cap into a
  // mushroom. Shared by a barrel reaching the end of its life and by a tap on
  // the water.
  // `k` is the barrel's size against BARREL_SCALE. The charge goes as its
  // VOLUME and the bubble a charge opens goes as the cube root of the charge,
  // so the cavity radius goes as k linearly; the foam amplitude is left alone
  // because the solver injects through a Gaussian of `radius`, making the gas
  // that goes in amplitude x radius^3 — already k^3. A bigger barrel blows a
  // bigger hole, not a denser one.
  function detonate(q, t, k = 1) {
    // Shared by every phase, so carrying it up carries the whole sequence.
    // `lift` says which of them float: the cavity stays where it went off while
    // it opens and is crushed, and only the rebound rises — a bubble at full
    // size displaces too much water to migrate, and jumps at the collapse.
    const rise = { vy: 0 };
    // An air-filled barrel does not simply burst. The cavity is at one
    // atmosphere while the water around it is not, so the water crushes it
    // first, the trapped air compresses, and it is the REBOUND that throws the
    // plume — the bubble pulse that makes a depth charge boom twice. The
    // pocket is injected as foam — aerated water is the only air this solver has —
    // because an inward pull through water that looks the same before and after
    // reads as nothing happening at all. Give the pocket to look at first, then
    // crush it: the crush phases add no air, so what is there gets squeezed.
    // The cavity is the three pinned phases: the pocket opening and the water
    // crushing it. Switching it off leaves only the rebound, which is the
    // plain blast this had before any of it — useful for telling how much of
    // the look is the cavity and how much is the plume it throws.
    if (TUNE.cavityOn) {
      explosionQueue.push(
      { pos: q, rise, lift: 0, vel: 1.1 * k, up: 0.1 * k, foam: 3.8, radius: 0.095 * k * TUNE.cavitySize, hold: 0.10, raw: true },
      { pos: q, rise, lift: 0, vel: -3.6 * k, up: -0.5 * k, foam: 0.0, radius: 0.24 * k * TUNE.cavitySize, hold: 0.24 },
      { pos: q, rise, lift: 0, vel: -2.4 * k, up: -0.2 * k, foam: 0.0, radius: 0.20 * k * TUNE.cavitySize, hold: 0.08 },
      );
    }
    explosionQueue.push(
      { pos: q, rise, lift: 1, vel: 3.2 * k, up: 1.2 * k, foam: 0.42, radius: 0.36 * k, ring: 2.6 * k, ringR: 0.28 * k, hold: 0.05 },
      { pos: q, rise, lift: 1, vel: 1.8 * k, up: 0.9 * k, foam: 0.24, radius: 0.44 * k, ring: 2.0 * k, ringR: 0.36 * k, hold: 0.05 },
      { pos: q, rise, lift: 1, vel: 0.9 * k, up: 0.6 * k, foam: 0.14, radius: 0.52 * k, ring: 1.4 * k, ringR: 0.44 * k, hold: 0.05 },
    );
    // Aliased, not copied, so the bubble sparkle rides up with the cavity.
    lastBlast.pos = q;
    lastBlast.until = t + 1.6;
    addRipple(q.x, q.z, 1.3 * k);
  }

  function updateBarrels(dt, t) {
    liveBarrels.length = 0;
    for (const b of barrels) {
      if (!b.active) continue;
      b.age += dt;
      const p = b.mesh.position;
      const wasAbove = p.y > SURFACE_Y;
      // Underwater drag is the barrel's own form drag plus the tank's
      // viscosity, so the `water drag` knob slows the barrel as well as the
      // fluid. Gravity is cut to about a third below the waterline, standing
      // in for the buoyancy of the water it displaces.
      // Drag acts on area and inertia on volume, so a given drag decelerates
      // as 1/size: a big drum sinks faster and holds its line.
      const kDrag = (wasAbove ? 0.15 : 2.3 + fluid.physics.drag * 1.5) / b.k;
      b.vel.y -= (wasAbove ? 6.0 : 1.8) * dt;
      b.vel.multiplyScalar(Math.exp(-dt * kDrag));
      // An aimed drop is a promise: it detonates at the depth you clicked. Drag
      // shapes how it gets there but must not be able to stall it — at `water
      // drag` 10 the terminal sink rate is under a fifth of a tank a second, so
      // the barrel would still be drifting down when its fuse ran out and would
      // blow up near the surface instead. Floor the sink rate so it always
      // arrives, in about a second and a half from the waterline.
      if (b.targetY != null && !wasAbove) b.vel.y = Math.min(b.vel.y, -MIN_SINK);
      p.addScaledVector(b.vel, dt);
      p.x = Math.max(-0.8 * tankHalf, Math.min(0.8 * tankHalf, p.x));
      p.z = Math.max(-0.8 * tankHalf, Math.min(0.8 * tankHalf, p.z));
      b.mesh.rotation.x += b.spin.x * dt;
      b.mesh.rotation.y += b.spin.y * dt;
      b.mesh.rotation.z += b.spin.z * dt;
      b.mesh.updateMatrixWorld();

      if (wasAbove && p.y <= SURFACE_Y && !b.splashed) {
        b.splashed = true;
        explosionQueue.push(
          { pos: new THREE.Vector3(p.x, SURFACE_Y - 0.05, p.z), vel: 0.55, up: -1.2, foam: 0.35, radius: 0.13 },
          { pos: new THREE.Vector3(p.x, SURFACE_Y - 0.15, p.z), vel: 0.28, up: 0.5, foam: 0.2, radius: 0.10 },
        );
        addRipple(p.x, p.z, 1.0);
      }

      // Reaching the mark is the only thing that fires an aimed barrel: neither
      // the fuse nor the floor gets to pre-empt it, or a deep click would
      // detonate short of where it was pointed. The long fuse is a safety net
      // for a barrel that somehow never arrives.
      // Every barrel has a mark now, aimed or drawn, so there is one rule.
      const done = p.y <= b.targetY || b.age > 20;
      if (done) {
        b.active = false;
        b.mesh.visible = false;
        detonate(p.clone(), t, Math.pow(b.k, TUNE.blastPow));
        continue;
      }
      if (p.y < SURFACE_Y) liveBarrels.push(b.desc);
    }
    fluid.barrels = liveBarrels;
  }

  // ------------------------------------------------------------ particles --
  // Bubble sparkle: positions live in a storage buffer advected by the
  // velocity field, drawn additively and gated to the shell of the plumes.
  // Wrapped so that a shader failure costs the sparkle, not the backend.
  let particleCount = 0;
  let particleUpdate = null;
  let particlePoints = null;
  const uPEmitter = uniform(new THREE.Vector3());
  const uPSpeed = uniform(0);
  const uPDt = uniform(0);
  const uPTime = uniform(0);
  const uPInit = uniform(1);
  const uPRise = uniform(0.33);
  try {
    particleCount = particleTarget;
    const posAttr = new THREE.StorageBufferAttribute(particleCount, 4);
    const posBuf = storage(posAttr, 'vec4', particleCount);

    const hash33 = (p) => {
      const q = p.mul(vec3(0.1031, 0.1030, 0.0973)).fract();
      const r = q.add(q.dot(q.yxz.add(33.33)));
      return r.xxy.add(r.yxx).mul(r.zyx).fract();
    };

    particleUpdate = Fn(() => {
      const s = posBuf.element(instanceIndex).toVar();
      const seed = vec3(float(instanceIndex), uPTime, float(instanceIndex).mul(0.37));
      const life = s.w.sub(uPDt).toVar();
      const p = s.xyz.toVar();

      If(uPInit.greaterThan(0.5), () => {
        const r = hash33(seed);
        p.assign(r.mul(1.7).sub(0.85));
        life.assign(r.x.mul(13.7).fract().mul(6));
      }).ElseIf(life.lessThanEqual(0).or(p.abs().greaterThan(vec3(uTank.mul(0.99))).any()), () => {
        const r = hash33(seed);
        p.assign(uPEmitter.add(r.mul(2).sub(1).mul(0.34))
          .clamp(vec3(uTank.mul(-0.98)), vec3(uTank.mul(0.98))));
        life.assign(r.y.mul(7.31).fract().mul(4).add(2.5));
        If(uPSpeed.lessThan(0.05).and(r.z.mul(5.17).fract().greaterThan(0.15)), () => {
          life.assign(-0.001);
        });
      }).Else(() => {
        const pv = p.mul(0.5).add(0.5);
        const v = texture3D(fluid.vel0, pv, float(0)).xyz.div(N * 0.5);
        const jig = hash33(p.mul(37).add(uPTime)).sub(0.5);
        const wob = uPTime.mul(5.5).add(s.w.mul(11)).sin().mul(0.035);
        p.assign(p.add(v.add(jig.mul(0.04))
          .add(vec3(wob, uPRise, wob.mul(0.6))).mul(uPDt))
          .clamp(vec3(uTank.mul(-0.995)), vec3(uTank.mul(0.995))));
      });
      If(p.y.greaterThan(uSurfaceY.sub(0.012)), () => { life.assign(-0.001); });
      posBuf.element(instanceIndex).assign(vec4(p, life));
    })().compute(particleCount);

    const pMat = new THREE.PointsNodeMaterial({
      transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, depthTest: false,
    });
    const pData = posBuf.toAttribute();
    pMat.positionNode = pData.xyz;
    pMat.sizeNode = float(2.0);
    const vAlpha = varying(Fn(() => {
      const s = pData;
      const pv = s.xyz.mul(0.5).add(0.5);
      const foam = texture3D(fluid.foamTexture, pv, float(0)).x;
      const shell = smoothstep(0.02, 0.18, foam).mul(float(1).sub(smoothstep(0.7, 1.8, foam)));
      const away = smoothstep(0.14, 0.40, s.xyz.distance(uPEmitter));
      const alive = s.w.greaterThan(0).select(float(1), float(0));
      return shell.mul(away).mul(alive).mul(s.w.mul(2).min(1));
    })());
    const vLight = varying(Fn(() => {
      const pv = pData.xyz.mul(0.5).add(0.5);
      return texture3D(fluid.lightTexture, pv, float(0)).x;
    })());
    pMat.colorNode = Fn(() => {
      // no per-point sprite coordinate in the WebGPU points path, so these are
      // flat 2px dots rather than soft discs — indistinguishable at that size
      const a = vAlpha.mul(0.30);
      const col = vec3(0.55, 0.75, 0.9).add(vec3(1.0, 0.95, 0.85).mul(vLight.mul(1.6))).mul(0.5);
      return vec4(col.mul(a), 1);
    })();

    const pGeo = new THREE.BufferGeometry();
    pGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(particleCount * 3), 3));
    particlePoints = new THREE.Points(pGeo, pMat);
    particlePoints.frustumCulled = false;
  } catch (e) {
    // this used to fail silently, which reads on screen as "the bubbles are
    // gone" with nothing to point at
    diag('bubble particles failed to initialise: ' + (e && e.message || e));
    particleCount = 0;
    particleUpdate = null;
    particlePoints = null;
  }
  const particleScene = new THREE.Scene();
  if (particlePoints) particleScene.add(particlePoints);

  // ----------------------------------------------------------------- loop --

  function renderFrame(target) {
    // The sun's view of the solids, and the settings that read it. This lives
    // in the RENDER phase, not the simulation one: a paused tank is still being
    // drawn and can still be orbited, so the shadow map and its knobs have to
    // keep reaching the shader either way. Having it inside the sim branch is
    // also what made a frozen A/B measure nothing — the uniforms never moved.
    renderer.setRenderTarget(fluid.sunRT);
    renderer.render(opaqueScene, sunCam);
    uSunVP.value.copy(sunVP);
    uShadowTexel.value = 1 / fluid.shadowSize;
    uOccK.value = TUNE.meshShadow;
    uOccSoft.value = TUNE.shadowSoft;
    uLightLift.value = TUNE.lightLift;
    uSkyGain.value = TUNE.skyGain;
    if (!skip.has('opaque')) {
      renderer.setRenderTarget(opaqueRT);
      renderer.clear();
      renderer.render(opaqueScene, camera);
    }
    uInvProjView.value.copy(camera.projectionMatrix)
      .multiply(camera.matrixWorldInverse).invert();
    uCamPos.value.copy(camera.position);
    camera.getWorldDirection(uCamFwd.value);
    uFrame.value = frames % 64;
    if (!skip.has('ray')) {
      renderer.setRenderTarget(volRT);
      renderer.render(raymarchScene, fsCamera);
    }
    if (!skip.has('final')) {
      renderer.setRenderTarget(compRT);
      renderer.render(compositeScene, fsCamera);
      // the foam view is meant to show the solver's output alone
      if (particlePoints && !debugFoam) renderer.render(particleScene, camera);

      renderer.setRenderTarget(bloomA);
      renderer.render(brightScene, fsCamera);
      uBlurTex.value = bloomA.texture;
      uBlurDir.value.set(1 / Math.max(bloomA.width, 2), 0);
      renderer.setRenderTarget(bloomB);
      renderer.render(blurScene, fsCamera);
      uBlurTex.value = bloomB.texture;
      uBlurDir.value.set(0, 1 / Math.max(bloomB.height, 2));
      renderer.setRenderTarget(bloomA);
      renderer.render(blurScene, fsCamera);

      renderer.setRenderTarget(presentToRT && target === null ? capRT : target);
      renderer.render(finalScene, fsCamera);
    }
    renderer.setRenderTarget(null);
  }

  let capturing = false;
  let inFlight = false;
  function frame() {
    requestAnimationFrame(frame);
    if (capturing) return; // don't contend with an in-flight readback
    if (inFlight) return;  // headless: wait for the device to catch up
    resize();
    const dt = clock.getDelta(params.paused);
    const t = clock.elapsedTime;

    if (params.autoSpin && drag.mode !== 'orbit' && drag.mode !== 'pinch') {
      orbit.az += clock.rawDelta * params.spinSpeed;
      updateCamera();
    }
    while (seedBursts.length && seedBursts[0].t <= t) {
      const b = seedBursts.shift();
      if (!fluid.burst) fluid.burst = b;
    }
    if (!params.paused && !skip.has('sim')) {
      updatePaddle(dt, t);
      updateBarrels(dt, t);
      visitor.update(dt, tankHalf);
      // the water it is dissolving into is the ambient at its own depth
      // Fades to BLACK, which is exact — see the WebGL app. By the time it is
      // fully faded it is behind the back wall with no water between it and
      // the black the scene is cleared to, so taking its own colour to zero
      // makes the pixel identical to one it never occupied.
      diverFade.value = visitor.state.fade;
      // Phases are HELD for a duration rather than fired one per frame. An
      // implosion two entries long lasted 33ms at 60fps, so all anyone ever saw
      // was the pop. Each frame takes its dt share of the phase, which keeps
      // the total impulse the same however fast the machine runs and makes the
      // collapse something you can watch. Scaling happens on arming, so the
      // sliders still reach explosions already queued.
      // Cleared every frame and re-armed below only while a cavity phase is
      // running, so a finished blast leaves no hole in the buoyancy field.
      fluid.u.pinK.value = 0;
      if (!fluid.burst) {
        if (blastLeft <= 0 && explosionQueue.length) {
          blastPhase = explosionQueue.shift();
          blastLeft = phaseHold(blastPhase);
        }
        if (blastPhase) {
          // The cavity rises while its own sequence plays out — holding the
          // late phases at the point of detonation fired them below the gas
          // that had already floated off, which read as a second explosion
          // somewhere else. Same balance the solver integrates for a foam
          // parcel: buoyancy against drag.
          const r = blastPhase.rise;
          if (r) {
            const ph = fluid.physics;
            r.vy += (ph.buoyancy * TUNE.cavityRise * (blastPhase.lift ?? 1)
                    - ph.drag * r.vy) * dt;
            blastPhase.pos.y = Math.min(SURFACE_Y - 0.03,
              blastPhase.pos.y + r.vy * dt);
          }
          const hold = phaseHold(blastPhase);
          fluid.burst = armBurst(blastPhase, fluid.physics,
            hold > 0 ? Math.min(dt / hold, 1) : 1);
          // Buoyancy is switched OFF inside the cavity while it opens and is
          // crushed, rather than fought with a downward push — see the WebGL
          // app for why a push can never balance.
          if (blastPhase.lift === 0) {
            fluid.u.pin.value.set(blastPhase.pos.x, blastPhase.pos.y, blastPhase.pos.z,
              Math.max(blastPhase.radius * 1.5, 0.05));
            fluid.u.pinK.value = TUNE.cavityAnchor;
          }
          blastLeft -= dt;
          if (blastLeft <= 0) blastPhase = null;
        }
      }
      const s0 = performance.now();
      fluid.step(dt, t % 512);
      if (particleUpdate) {
        let emitter = paddle.position;
        let effSpeed = paddleHidden
          ? 0 : Math.max(paddleVel.length(), paddleAngVel.length() * 0.28);
        const diving = barrels.find((b) => b.active && b.mesh.position.y < SURFACE_Y);
        if (diving) {
          emitter = diving.mesh.position;
          effSpeed = Math.max(diving.vel.length(), 0.6);
        } else if (t < lastBlast.until) {
          emitter = lastBlast.pos;
          effSpeed = 2.0;
        }
        uPEmitter.value.copy(emitter);
        uPSpeed.value = effSpeed;
        uPDt.value = dt;
        uPTime.value = t % 512;
        uPRise.value = fluid.physics.rise * 0.6;
        renderer.compute(particleUpdate);
        uPInit.value = 0;
      }
      simMs.v = simMs.v * 0.9 + (performance.now() - s0) * 0.1;
    }
    uTimeR.value = t % 512;
    uChop.value = fluid.physics.chop;
    renderFrame(null);
    if (headlessCapture) {
      // pace submissions to real completion: an unthrottled loop on the
      // software adapter grows an unbounded queue that starves readbacks
      inFlight = true;
      renderer.backend.device.queue.onSubmittedWorkDone().then(() => { inFlight = false; });
    }

    frames++;
    window.water.frames = frames;
    fpsCounter.frames++;
    const wall = performance.now() / 1000;
    if (wall - fpsCounter.t > 0.5) {
      fpsCounter.fps = fpsCounter.frames / (wall - fpsCounter.t);
      fpsCounter.frames = 0;
      fpsCounter.t = wall;
      updateHud();
    }
    if (frames === 3) boot.classList.add('hidden');
  }

  // --------------------------------------------------------------- handle --

  window.water = {
    params, fluid, orbit, frames: 0, backend: 'WebGPU', renderer, capRT,
    _rts: { opaqueRT, volRT, compRT, bloomA },
    setHalt(v) { capturing = v; },
    burst(x, y, z, foam = 0.5, vel = 1.2) {
      fluid.burst = {
        pos: new THREE.Vector3(x, y, z).clampScalar(-0.92 * tankHalf, 0.92 * tankHalf),
        vel, up: 1.0, foam, radius: 0.18,
      };
    },
    paddleTo(x, y, z) {
      paddleTarget.set(x, y, z).clampScalar(-0.66 * tankHalf, 0.66 * tankHalf);
      lastInteract = clock.elapsedTime;
    },
    dropBarrel,
    visitor,   // the easter egg, exposed so a capture can step into it
    barrels,
    tune: TUNE,

    physics: fluid.physics,
    setPaddleHidden: (v) => setPaddleHidden(v),
    isPaddleHidden: () => paddleHidden,
    camera(az, el, dist) {
      orbit.az = az; orbit.el = el; orbit.dist = dist;
      updateCamera();
    },
    clear: () => fluid.clear(),
    // Headless captures: WebGPU canvas presentation doesn't composite in
    // headless Chromium, so render into a target, read the pixels back, and
    // blit them onto a plain 2D canvas that screenshots can see.
    async captureTo2D() {
      capturing = true;
      try {
        renderFrame(capRT);
        const px = await renderer.readRenderTargetPixelsAsync(capRT, 0, 0, W, H);
      let c2 = document.getElementById('cap2d');
      if (!c2) {
        c2 = document.createElement('canvas');
        c2.id = 'cap2d';
        c2.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none';
        document.body.insertBefore(c2, document.getElementById('title')); // HUD stays on top
      }
      c2.width = W; c2.height = H;
      const ctx = c2.getContext('2d');
        const img = ctx.createImageData(W, H);
        // rows may be padded to WebGPU's 256-byte alignment; storage is
        // already top-down, so no row flip
        const rowPx = Math.round(px.length / (4 * H));
        for (let y = 0; y < H; y++) {
          img.data.set(px.subarray(y * rowPx * 4, y * rowPx * 4 + W * 4), y * W * 4);
        }
        for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
        ctx.putImageData(img, 0, 0);
        return true;
      } finally {
        capturing = false;
      }
    },
  };

  resize();
  updateCamera();
  // last, so every binding it touches (paddle velocities, the buttons) exists
  setPaddleHidden(paddleHidden);
  // first frame before declaring success, so boot.js can fall back on failure
  renderFrame(null);
  requestAnimationFrame(frame);
}
