import * as THREE from '../vendor/three/three.module.js';
import { OrbitControls } from '../vendor/three/OrbitControls.js';
import { defaults, resolve, diff } from './knobs.js';
import { SCENES, SCENE_IDS } from './scenes.js';
import { DEFAULT_SELECTION, SLOTS, slotKnobs, deriveKnobs, variant } from './slots/index.js';
import { polarGrid, fullscreenTriangle } from './grid.js';
import { oceanMaterial, sandMaterial, skyMaterial, postMaterial, probeMaterial, syncKnobUniforms } from './materials.js';

export function createApp(canvas, opts = {}) {
  const errors = [];
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,          // the wave field is filtered analytically instead
    powerPreference: 'high-performance',
    preserveDrawingBuffer: true,
  });
  renderer.autoClear = false;
  renderer.setPixelRatio(1);   // fixed, so a capture is reproducible across machines

  const scene = new THREE.Scene();
  const skyScene = new THREE.Scene();
  const postScene = new THREE.Scene();
  const flatCam = new THREE.Camera();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 60000);

  let hdr = new THREE.WebGLRenderTarget(2, 2, {
    type: THREE.HalfFloatType,
    depthBuffer: true,
    stencilBuffer: false,
  });

  const geo = polarGrid();
  const tri = fullscreenTriangle();

  // ---- mutable state -------------------------------------------------------
  let sceneId = opts.scene && SCENES[opts.scene] ? opts.scene : SCENE_IDS[0];
  let selection = Object.assign({}, DEFAULT_SELECTION, opts.variants || {});
  let overrides = {};                 // user edits on top of the scene
  let knobs = {};
  let ocean, sand, sky, post, oceanMesh, sandMesh;
  let probeMat = null, probeRT = null, probeScene = null;
  let time = 0;
  let lastWall = 0;
  const frameTimes = [];
  const timingPixel = new Uint8Array(4);
  let frameNo = 0;

  function baseKnobs() {
    return resolve(defaults, slotKnobs(selection), SCENES[sceneId].knobs);
  }

  function rebuild() {
    knobs = resolve(baseKnobs(), overrides);
    Object.assign(knobs, deriveKnobs(selection, knobs));

    for (const m of [ocean, sand, sky, post, probeMat]) m?.dispose();
    probeMat = null; probeScene = null;
    scene.clear(); skyScene.clear(); postScene.clear();

    ocean = oceanMaterial(selection, knobs);
    sand = sandMaterial(selection, knobs, ocean.uniforms);
    sky = skyMaterial(selection, knobs, ocean.uniforms);
    post = postMaterial(ocean.uniforms);
    post.uniforms.uHdr.value = hdr.texture;

    sandMesh = new THREE.Mesh(geo, sand);
    sandMesh.frustumCulled = false;
    sandMesh.renderOrder = 0;
    scene.add(sandMesh);

    oceanMesh = new THREE.Mesh(geo, ocean);
    oceanMesh.frustumCulled = false;
    oceanMesh.renderOrder = 1;
    scene.add(oceanMesh);

    skyScene.add(new THREE.Mesh(tri, sky));
    postScene.add(new THREE.Mesh(tri, post));
    sync();
  }

  function sync() {
    knobs = resolve(baseKnobs(), overrides);
    // Derived last: a variant computing from wind speed must see the final one.
    Object.assign(knobs, deriveKnobs(selection, knobs));
    syncKnobUniforms(ocean.uniforms, knobs);
    sandMesh.visible = knobs.shoreEnabled > 0.5;

    const el = THREE.MathUtils.degToRad(knobs.sunElevationDeg);
    const az = THREE.MathUtils.degToRad(knobs.sunAzimuthDeg);
    ocean.uniforms.uSunDir.value.set(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)).normalize();

    if (camera.fov !== knobs.fov) { camera.fov = knobs.fov; camera.updateProjectionMatrix(); }
  }

  function applyCamera() {
    const c = SCENES[sceneId].camera;
    camera.position.set(...c.position);
    camera.lookAt(...c.target);
    if (controls) { controls.target.set(...c.target); controls.update(); }
  }

  let controls = null;
  if (opts.controls !== false) {
    controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.maxPolarAngle = Math.PI * 0.62;
    controls.minDistance = 2;
    controls.maxDistance = 900;
  }

  function setSize(w, h) {
    renderer.setSize(w, h, false);
    hdr.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    ocean.uniforms.uResolution.value.set(w, h);
    // World units covered by one pixel, per unit of distance. Both shader
    // stages derive their level of detail from this.
    ocean.uniforms.uPixelAngle.value = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / h;
  }

  // Sample the wave field on a regular world-space grid and read it back as
  // floats. Slow (a GPU stall), so it is never on the render path - the
  // measurement harness calls it directly.
  function probe({ resolution = 256, extent = 512, origin = [0, 0], time: t } = {}) {
    sync();
    if (!probeMat) {
      probeMat = probeMaterial(selection, knobs, ocean.uniforms);
      probeScene = new THREE.Scene();
      probeScene.add(new THREE.Mesh(tri, probeMat));
    }
    if (!probeRT || probeRT.width !== resolution) {
      probeRT?.dispose();
      probeRT = new THREE.WebGLRenderTarget(resolution, resolution, {
        type: THREE.FloatType,
        depthBuffer: false,
        stencilBuffer: false,
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
      });
    }
    probeMat.uniforms.uProbeOrigin.value.set(origin[0], origin[1]);
    probeMat.uniforms.uProbeExtent.value = extent;
    probeMat.uniforms.uProbeRes.value = resolution;
    ocean.uniforms.uTime.value = t ?? time;

    renderer.setRenderTarget(probeRT);
    renderer.clear(true, false, false);
    renderer.render(probeScene, flatCam);
    const buf = new Float32Array(resolution * resolution * 4);
    renderer.readRenderTargetPixels(probeRT, 0, 0, resolution, resolution, buf);
    renderer.setRenderTarget(null);

    // Interleaved RGBA -> named planes, so a metric reads `height` not `[i*4]`.
    const n = resolution * resolution;
    const out = {
      resolution, extent, origin, time: t ?? time,
      metresPerSample: extent / resolution,
      height: new Float32Array(n),
      coverage: new Float32Array(n),
      fold: new Float32Array(n),
      subRough: new Float32Array(n),
    };
    for (let i = 0; i < n; i++) {
      out.height[i] = buf[i * 4];
      out.coverage[i] = buf[i * 4 + 1];
      out.fold[i] = buf[i * 4 + 2];
      out.subRough[i] = buf[i * 4 + 3];
    }
    return out;
  }

  const invVP = new THREE.Matrix4();

  function renderFrame() {
    sync();
    // Keep the dense middle of the grid under the camera. The wave field is a
    // function of world position, so sliding the tessellation does not slide
    // the sea.
    oceanMesh.position.set(camera.position.x, 0, camera.position.z);
    sandMesh.position.set(camera.position.x, 0, camera.position.z);

    ocean.uniforms.uTime.value = time;
    ocean.uniforms.uCamPos.value.copy(camera.position);
    ocean.uniforms.uPixelAngle.value = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / Math.max(hdr.height, 1);

    camera.updateMatrixWorld();
    invVP.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).invert();
    sky.uniforms.uInvViewProj.value.copy(invVP);

    renderer.setRenderTarget(hdr);
    renderer.clear(true, true, true);
    renderer.render(skyScene, flatCam);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    renderer.clear(true, true, true);
    renderer.render(postScene, flatCam);
  }

  // ---- public surface ------------------------------------------------------
  const api = {
    THREE, renderer, camera, controls, errors,
    get sceneId() { return sceneId; },
    get knobs() { return Object.assign({}, knobs); },
    get selection() { return Object.assign({}, selection); },

    setScene(id) {
      if (!SCENES[id]) throw new Error(`no scene "${id}"`);
      sceneId = id;
      overrides = {};
      sync();
      applyCamera();
    },
    setVariants(sel) {
      for (const [slot, id] of Object.entries(sel)) {
        if (!SLOTS.includes(slot)) throw new Error(`no slot "${slot}"`);
        variant(slot, id);              // throws if the id is unknown
        selection[slot] = id;
      }
      rebuild();
      setSize(renderer.domElement.width, renderer.domElement.height);
    },
    setKnobs(patch) { Object.assign(overrides, patch); sync(); },
    resetKnobs() { overrides = {}; sync(); },
    // What this viewer has changed relative to the scene as published. The
    // thing worth posting, and the thing an agent should be handed.
    tuning() { return diff(baseKnobs(), resolve(baseKnobs(), overrides)); },
    setTime(t) { time = t; },
    getTime() { return time; },
    setSize,
    renderFrame,
    probe,
    applyCamera,
    // Free camera, for a human nudging the view before capturing a fixture.
    cameraState() {
      return {
        position: camera.position.toArray().map((v) => +v.toFixed(3)),
        target: controls ? controls.target.toArray().map((v) => +v.toFixed(3)) : SCENES[sceneId].camera.target,
      };
    },
    stats() {
      const s = frameTimes.slice().sort((a, b) => a - b);
      const pick = (q) => (s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0);
      return { samples: s.length, medianMs: pick(0.5), p95Ms: pick(0.95), fps: s.length ? 1000 / pick(0.5) : 0 };
    },
    resetStats() { frameTimes.length = 0; },
  };

  renderer.getContext().canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    errors.push('webgl context lost');
  });

  rebuild();
  applyCamera();
  setSize(canvas.clientWidth || 1280, canvas.clientHeight || 720);

  // Shader compilation errors surface as a console message from three; capture
  // them so the headless harness can exit non-zero instead of shipping a black
  // frame.
  const origError = console.error.bind(console);
  console.error = (...a) => { errors.push(a.map(String).join(' ')); origError(...a); };

  api.startLoop = (onFrame) => {
    let raf;
    const tick = (now) => {
      raf = requestAnimationFrame(tick);
      const dt = lastWall ? Math.min((now - lastWall) / 1000, 0.05) : 0.016;
      lastWall = now;
      time += dt;
      if (controls) controls.update();
      // Timing a frame requires forcing it to finish, and forcing it every frame
      // would itself cost more than it measures. So sample: one frame in thirty
      // is followed by a one-pixel readback, which blocks until the GPU is
      // actually done. Without this the counter reports command-submission time
      // and cheerfully claims 700fps on a 2-second frame.
      const measure = (frameNo % 30) === 0;
      const t0 = performance.now();
      renderFrame();
      if (measure) {
        const gl = renderer.getContext();
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, timingPixel);
        frameTimes.push(performance.now() - t0);
        if (frameTimes.length > 90) frameTimes.shift();
      }
      frameNo++;
      onFrame?.(api);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  };

  return api;
}
