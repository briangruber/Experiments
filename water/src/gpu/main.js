// Churn — WebGPU/TSL backend.
//
// Same tank, paddle, barrel, and interaction as the WebGL2 app, with the
// simulation in true 3D storage textures (src/gpu/fluid3d.js) and rendering
// as TSL node materials: opaque pass (paddle/barrel/edges) with depth, a
// reduced-resolution raymarch pass, and a composite/ACES/vignette pass.
// window.water keeps the same interface, plus captureTo2D() for headless
// captures (WebGPU canvas presentation doesn't composite in headless
// Chromium, so captures read pixels back and blit them to a 2D canvas).

import { applyWebGPUCompat } from './compat.js';
import * as THREE from '../../vendor/three.webgpu.min.js';

const {
  Fn, If, Loop, Break, uniform, texture, texture3D, uv,
  float, vec2, vec3, vec4, normalWorld, positionWorld, cameraPosition,
} = THREE.TSL;
import { Fluid3D } from './fluid3d.js';

const QUALITY = {
  low: { N: 64, jacobi: 14, steps: 96, scale: 0.6, dpr: 1.0 },
  med: { N: 96, jacobi: 20, steps: 128, scale: 0.7, dpr: 1.0 },
  high: { N: 128, jacobi: 26, steps: 160, scale: 0.8, dpr: 1.25 },
  ultra: { N: 160, jacobi: 30, steps: 200, scale: 0.9, dpr: 1.25 },
};

export async function start() {
  applyWebGPUCompat();

  const query = new URLSearchParams(location.search);
  const qName = QUALITY[query.get('q')] ? query.get('q') : 'high';
  const Q = QUALITY[qName];

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

  const canvas = document.getElementById('gl');
  const boot = document.getElementById('boot');
  const sunDir = new THREE.Vector3(0.30, -1.0, -0.35).normalize();

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
  renderer.backend.device.lost.then((info) => {
    console.error('[devicelost]', info.reason || 'unknown', info.message);
  });
  // stage bisection for debugging: ?skip=sim,opaque,ray,final
  const skip = new Set((query.get('skip') || '').split(',').filter(Boolean));
  // ?present=rt keeps the final pass off the swapchain (headless Chromium's
  // WebGPU presentation crashes the GPU process); pair with captureTo2D()
  const presentToRT = query.get('present') === 'rt';

  const fluid = new Fluid3D(renderer, { N: Q.N, jacobi: Q.jacobi, lightDir: sunDir });
  fluid.clear();

  // --------------------------------------------------------------- camera --

  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 50);
  const orbit = { az: 0.5, el: 0.12, dist: 3.4 };
  function updateCamera() {
    orbit.el = Math.max(-0.55, Math.min(1.25, orbit.el));
    orbit.dist = Math.max(1.7, Math.min(8, orbit.dist));
    const ce = Math.cos(orbit.el);
    camera.position.set(
      Math.sin(orbit.az) * ce * orbit.dist,
      Math.sin(orbit.el) * orbit.dist,
      Math.cos(orbit.az) * ce * orbit.dist);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
  }
  updateCamera();

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

  const paddleHalf = new THREE.Vector3(0.30, 0.05, 0.20);
  const paddle = new THREE.Mesh(
    new THREE.BoxGeometry(paddleHalf.x * 2, paddleHalf.y * 2, paddleHalf.z * 2), bodyMaterial());
  paddle.position.set(0.45, -0.25, 0.1);
  opaqueScene.add(paddle);

  const barrelHalf = new THREE.Vector3(0.13, 0.17, 0.13);
  const barrel = new THREE.Mesh(
    new THREE.BoxGeometry(barrelHalf.x * 2, barrelHalf.y * 2, barrelHalf.z * 2), bodyMaterial());
  barrel.visible = false;
  opaqueScene.add(barrel);

  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(2, 2, 2)),
    new THREE.LineBasicMaterial({
      color: new THREE.Color(0.10, 0.22, 0.30),
      transparent: true, opacity: 0.14,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
  opaqueScene.add(edges);

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
  const uWaterScatter = uniform(new THREE.Vector3(0.012, 0.032, 0.058));
  const uFoamScatter = uniform(7.0);
  const uFoamAbsorb = uniform(0.35);
  const uAmbientTop = uniform(new THREE.Vector3(0.11, 0.16, 0.20));
  const uAmbientDeep = uniform(new THREE.Vector3(0.008, 0.03, 0.055));
  const uExposure = uniform(params.exposure);
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
    const nx0 = h(0, 0, 0).mix(h(1, 0, 0), s.x);
    const nx1 = h(0, 1, 0).mix(h(1, 1, 0), s.x);
    const nx2 = h(0, 0, 1).mix(h(1, 0, 1), s.x);
    const nx3 = h(0, 1, 1).mix(h(1, 1, 1), s.x);
    return nx0.mix(nx1, s.y).mix(nx2.mix(nx3, s.y), s.z);
  };

  const raymarchMaterial = new THREE.MeshBasicNodeMaterial();
  raymarchMaterial.colorNode = Fn(() => {
    const suv = uv();
    const ndc = suv.mul(2).sub(1);
    const far4 = uInvProjView.mul(vec4(ndc, 1, 1));
    const dir = far4.xyz.div(far4.w).sub(uCamPos).normalize();

    const inv = vec3(1).div(dir);
    const ta = vec3(-1).sub(uCamPos).mul(inv);
    const tb = vec3(1).sub(uCamPos).mul(inv);
    const lo = ta.min(tb);
    const hi = ta.max(tb);
    const t0 = lo.x.max(lo.y).max(lo.z).max(0).toVar();
    const t1 = hi.x.min(hi.y).min(hi.z).toVar();

    // depth clamp against the opaque pass. WebGPU render targets store
    // top-down; every RT sampled through bottom-up quad uv gets the same flip
    const d = texture(depthTexture, vec2(suv.x, float(1).sub(suv.y))).x;
    If(d.lessThan(1), () => {
      const near = float(camera.near), far = float(camera.far);
      const dist = near.mul(far).div(far.sub(d.mul(far.sub(near))));
      t1.assign(t1.min(dist.div(dir.dot(uCamFwd).max(1e-4))));
    });

    const L = vec3(0).toVar();
    const T = vec3(1).toVar();
    If(t1.greaterThan(t0), () => {
      const n = float(uSteps);
      const dt = t1.sub(t0).div(n);
      const jp = vec3(suv.mul(997), uFrame).mul(0.1031).fract();
      const jq = jp.add(jp.dot(jp.zyx.add(31.32)));
      const jit = jq.x.add(jq.y).mul(jq.z).fract();
      const mu = dir.dot(uSun);
      const phase = mu.add(1).mul(0.5).pow(2).mul(0.6).add(0.4);
      const t = t0.add(jit.mul(dt)).toVar();

      Loop({ start: 0, end: 400 }, ({ i }) => {
        If(float(i).greaterThanEqual(n).or(t.greaterThanEqual(t1)), () => { Break(); });
        const p = uCamPos.add(dir.mul(t));
        const pv = p.mul(0.5).add(0.5).mul(N);
        const foamRaw = texture3D(fluid.foamTexture, pv.div(N), float(0)).x;
        const foam = foamRaw.mul(noise3(pv.mul(0.55)).mul(0.8).add(0.6));
        const lt = texture3D(fluid.lightTexture, pv.div(N), float(0)).x;

        const sigS = uWaterScatter.add(vec3(uFoamScatter).mul(foam));
        const sigT = uWaterAbsorb.add(sigS).add(vec3(uFoamAbsorb).mul(foam));
        const h = p.y.mul(0.5).add(0.5).clamp(0, 1);
        const Li = uSunColor.mul(lt.mul(phase))
          .add(uAmbientDeep.mix(uAmbientTop, h).mul(lt.pow(0.6).mul(0.88).add(0.12)));

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
    const meanT = T.x.add(T.y).add(T.z).div(3);
    return vec4(L, meanT);
  })();
  const raymarchScene = quadPass(raymarchMaterial);

  const finalMaterial = new THREE.MeshBasicNodeMaterial();
  finalMaterial.colorNode = Fn(() => {
    const suv = uv();
    const flip = vec2(suv.x, float(1).sub(suv.y));
    const scene = texture(opaqueRT.texture, flip);
    const vol = texture(volRT.texture, flip);
    const col = scene.rgb.mul(vol.a).add(vol.rgb).toVar();
    // vignette, ACES, grain (output color space handles the sRGB transform)
    const q = suv.sub(0.5);
    col.mulAssign(float(1).sub(q.dot(q).mul(2.2).mul(0.32)));
    col.mulAssign(uExposure);
    const a = col.mul(col.mul(2.51).add(0.03));
    const b = col.mul(col.mul(2.43).add(0.59)).add(0.14);
    col.assign(a.div(b).clamp(0, 1));
    col.addAssign(hash12(suv.mul(913.7).add(uTimeR.fract().mul(71.3))).sub(0.5).mul(0.012));
    // the readback target gets no renderer color-space encode; the canvas
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
    opaqueRT.setSize(w, h);
    volRT.setSize(Math.floor(w * Q.scale), Math.floor(h * Q.scale));
    capRT.setSize(w, h);
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

  function pointerRay(e) {
    const r = canvas.getBoundingClientRect();
    raycaster.setFromCamera(new THREE.Vector2(
      ((e.clientX - r.left) / r.width) * 2 - 1,
      -((e.clientY - r.top) / r.height) * 2 + 1), camera);
    return raycaster.ray;
  }
  function rayBox(ray) {
    const inv = new THREE.Vector3(1 / ray.direction.x, 1 / ray.direction.y, 1 / ray.direction.z);
    const a = new THREE.Vector3(-1, -1, -1).sub(ray.origin).multiply(inv);
    const b = new THREE.Vector3(1, 1, 1).sub(ray.origin).multiply(inv);
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
    const hit = raycaster.intersectObject(paddle, false);
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
        if (drag.pinch > 0) orbit.dist *= drag.pinch / d;
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
      orbit.az -= dx * 0.005;
      orbit.el += dy * 0.005;
      updateCamera();
    } else if (drag.mode === 'paddle') {
      const ray = pointerRay(e);
      const p = new THREE.Vector3();
      if (ray.intersectPlane(drag.plane, p)) {
        paddleTarget.copy(p.sub(drag.offset)).clampScalar(-0.66, 0.66);
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
        fluid.burst = { pos: p.clampScalar(-0.92, 0.92), vel: 1.4, up: 1.1, foam: 1.6, radius: 0.18 };
        lastInteract = clock.elapsedTime;
      }
    }
    drag.mode = null;
  }
  canvas.addEventListener('pointerup', (e) => endPointer(e, false));
  canvas.addEventListener('pointercancel', (e) => endPointer(e, true));
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    orbit.dist *= Math.exp(e.deltaY * 0.0012);
    updateCamera();
  }, { passive: false });

  const spinBtn = document.getElementById('spin-btn');
  const spinPaddleBtn = document.getElementById('spin-paddle-btn');
  function syncButtons() {
    spinBtn.classList.toggle('active', params.autoSpin);
    spinBtn.setAttribute('aria-pressed', String(params.autoSpin));
    spinPaddleBtn.classList.toggle('active', params.paddleSpin);
    spinPaddleBtn.setAttribute('aria-pressed', String(params.paddleSpin));
  }
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
  syncButtons();

  window.addEventListener('keydown', (e) => {
    if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code === 'Space') { params.stir = !params.stir; e.preventDefault(); }
    else if (e.code === 'KeyO') toggleSpin();
    else if (e.code === 'KeyR') togglePaddleSpin();
    else if (e.code === 'KeyB') dropBarrel();
    else if (e.code === 'KeyC') fluid.clear();
    else if (e.code === 'KeyH') document.body.classList.toggle('ui-hidden');
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
  for (const el of document.querySelectorAll('#stats [data-k]')) statEls[el.dataset.k] = el;
  const fpsCounter = { frames: 0, t: performance.now() / 1000, fps: 0 };
  const simMs = { v: 0 };
  function updateHud() {
    statEls.res.textContent = `${W} × ${H}`;
    statEls.grid.textContent = `${Q.N}³ · ${(Q.N ** 3 / 1e6).toFixed(2)} M voxels`;
    if (statEls.backend) statEls.backend.textContent = 'WebGPU';
    statEls.simLabel.textContent = 'Simulate, CPU';
    statEls.renLabel.textContent = 'Render, CPU';
    statEls.sim.textContent = `${simMs.v.toFixed(2)} ms`;
    statEls.ren.textContent = '—';
    statEls.parts.textContent = '—';
    statEls.fps.textContent = fpsCounter.fps ? fpsCounter.fps.toFixed(1) : '—';
    statEls.vram.textContent = `${Math.round((fluid.bytes + W * H * 8 * 2) / (1 << 20))} MiB`;
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
    const stirring = params.stir && (t - lastInteract > 4 || lastInteract < 0);
    if (stirring && drag.mode !== 'paddle') {
      const s = stirPhase + t * params.stirSpeed;
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

  const barrelState = { active: false, age: 0 };
  const barrelVel = new THREE.Vector3();
  const barrelAngVel = new THREE.Vector3();
  const barrelRot3 = new THREE.Matrix3();
  const barrelRot4 = new THREE.Matrix4();
  const fluidBarrel = {
    on: true, pos: barrel.position, vel: barrelVel, angVel: barrelAngVel,
    half: barrelHalf, rot: barrelRot3,
  };
  const explosionQueue = [];

  function dropBarrel() {
    if (barrelState.active) return;
    barrelState.active = true;
    barrelState.age = 0;
    barrel.position.set((Math.random() - 0.5) * 0.7, 0.95, (Math.random() - 0.5) * 0.7);
    barrel.rotation.set(Math.random() * 0.5, Math.random() * 6.28, Math.random() * 0.5);
    barrelVel.set(0, -2.3, 0);
    barrelAngVel.set(1.1, 0.4, 0.8);
    barrel.visible = true;
    const x = barrel.position.x, z = barrel.position.z;
    explosionQueue.push(
      { pos: new THREE.Vector3(x, 0.87, z), vel: 0.5, up: -1.1, foam: 0.9, radius: 0.19 },
      { pos: new THREE.Vector3(x, 0.76, z), vel: 0.25, up: 0.55, foam: 0.55, radius: 0.15 },
    );
  }

  function updateBarrel(dt) {
    fluid.barrel = null;
    if (!barrelState.active) return;
    barrelState.age += dt;
    barrelVel.y -= 1.8 * dt;
    barrelVel.multiplyScalar(Math.exp(-dt * 2.3));
    barrel.position.addScaledVector(barrelVel, dt);
    barrel.position.x = Math.max(-0.8, Math.min(0.8, barrel.position.x));
    barrel.position.z = Math.max(-0.8, Math.min(0.8, barrel.position.z));
    barrel.rotation.x += barrelAngVel.x * dt;
    barrel.rotation.y += barrelAngVel.y * dt;
    barrel.rotation.z += barrelAngVel.z * dt;
    barrel.updateMatrixWorld();

    if (barrel.position.y < -0.5 || barrelState.age > 2.2) {
      barrelState.active = false;
      barrel.visible = false;
      const p = barrel.position.clone();
      explosionQueue.push(
        { pos: p, vel: -2.0, up: -0.3, foam: 0.0, radius: 0.42 },
        { pos: p, vel: -1.2, up: 0.0, foam: 0.5, radius: 0.36 },
        { pos: p, vel: 3.4, up: 2.6, foam: 3.0, radius: 0.36 },
        { pos: p, vel: 2.2, up: 1.9, foam: 1.7, radius: 0.44 },
        { pos: p, vel: 1.2, up: 1.2, foam: 0.9, radius: 0.52 },
      );
      return;
    }
    barrelRot4.extractRotation(barrel.matrixWorld);
    barrelRot3.setFromMatrix4(barrelRot4).transpose();
    fluid.barrel = fluidBarrel;
  }

  // ----------------------------------------------------------------- loop --

  function renderFrame(target) {
    if (!skip.has('opaque')) {
      renderer.setRenderTarget(opaqueRT);
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
      updateBarrel(dt);
      if (!fluid.burst && explosionQueue.length) fluid.burst = explosionQueue.shift();
      const s0 = performance.now();
      fluid.step(dt, t % 512);
      simMs.v = simMs.v * 0.9 + (performance.now() - s0) * 0.1;
    }
    uTimeR.value = t;
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
    setHalt(v) { capturing = v; },
    burst(x, y, z, foam = 1.5, vel = 1.2) {
      fluid.burst = {
        pos: new THREE.Vector3(x, y, z).clampScalar(-0.92, 0.92),
        vel, up: 1.0, foam, radius: 0.18,
      };
    },
    paddleTo(x, y, z) {
      paddleTarget.set(x, y, z).clampScalar(-0.66, 0.66);
      lastInteract = clock.elapsedTime;
    },
    dropBarrel,
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
  // first frame before declaring success, so boot.js can fall back on failure
  renderFrame(null);
  requestAnimationFrame(frame);
}
