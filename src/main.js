import { getContext, program, setUniforms, texture2D, framebuffer, depthBuffer, Blitter } from './gl.js';
import { WATER_VS, WATER_FS } from './shaders/water.js';
import { Ocean, DEFAULT_CASCADES } from './ocean.js';
import { Sky } from './sky.js';
import { Spray } from './spray.js';
import { Post } from './post.js';
import { Camera } from './camera.js';
import { WaveRunner } from './waverunner.js';
import { Craft } from './craft.js';
import { UI, applyPreset } from './ui.js';
import { defaults, PRESETS } from './presets.js';
import { DEG, v3, clamp } from './math.js';

const canvas = document.getElementById('gl');
const gl = getContext(canvas);
const blit = new Blitter(gl);

const params = structuredClone(defaults);
const startPreset = new URLSearchParams(location.search).get('preset');
applyPreset(params, PRESETS[startPreset] ? startPreset : 'Golden Hour Swell');

const camera = new Camera(canvas);
const sky = new Sky(gl, blit);
const post = new Post(gl, blit);
let ocean = new Ocean(gl, { size: params.fftSize, cascades: DEFAULT_CASCADES });
let spray = new Spray(gl, blit, { size: params.sprayTexSize });
const pWater = program(gl, WATER_VS, WATER_FS, 'water');
const waveRunner = new WaveRunner(gl, blit);
const craft = new Craft(gl);

// ---------------------------------------------------------------- radial grid
let grid = null;
function buildGrid() {
  if (grid) { gl.deleteVertexArray(grid.vao); gl.deleteBuffer(grid.vbo); gl.deleteBuffer(grid.ibo); }
  const R = Math.round(params.gridRadial), A = Math.round(params.gridAngular);
  const verts = new Float32Array((R + 1) * A * 2);
  let o = 0;
  for (let i = 0; i <= R; i++) {
    const t = i / R;
    for (let j = 0; j < A; j++) { verts[o++] = t; verts[o++] = j / A; }
  }
  const idx = new Uint32Array(R * A * 6);
  let k = 0;
  for (let i = 0; i < R; i++) {
    for (let j = 0; j < A; j++) {
      const j1 = (j + 1) % A;
      const a = i * A + j, b = i * A + j1, c = (i + 1) * A + j, d = (i + 1) * A + j1;
      idx[k++] = a; idx[k++] = c; idx[k++] = b;
      idx[k++] = b; idx[k++] = c; idx[k++] = d;
    }
  }
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const ibo = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  grid = { vao, vbo, ibo, count: idx.length };
}
buildGrid();

// --------------------------------------------------------------- render target
let hdr = null, hdrFbo = null, depthRb = null, W = 1, H = 1;
function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(2, Math.round(canvas.clientWidth * dpr * params.renderScale));
  const h = Math.max(2, Math.round(canvas.clientHeight * dpr * params.renderScale));
  if (w === W && h === H && hdr) return;
  W = w; H = h;
  canvas.width = w; canvas.height = h;
  if (hdr) { gl.deleteTexture(hdr.tex); gl.deleteFramebuffer(hdrFbo); gl.deleteRenderbuffer(depthRb); }
  hdr = texture2D(gl, {
    width: w, height: h, internalFormat: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT,
    filter: gl.LINEAR, wrap: gl.CLAMP_TO_EDGE,
  });
  depthRb = depthBuffer(gl, w, h);
  hdrFbo = framebuffer(gl, [hdr], { depth: depthRb });
  post.resize(w, h);
  resetAccum();
}
window.addEventListener('resize', () => { resize(); resetAccum(); });

// ----------------------------------------------------------------- derived sim
const sunDir = v3(), moonDir = v3(), windVec3 = v3();
function derive() {
  const el = params.sunElevation * DEG, az = params.sunAzimuth * DEG;
  sunDir[0] = Math.cos(el) * Math.sin(az);
  sunDir[1] = Math.sin(el);
  sunDir[2] = -Math.cos(el) * Math.cos(az);
  const mel = params.moonElevation * DEG, maz = params.moonAzimuth * DEG;
  moonDir[0] = Math.cos(mel) * Math.sin(maz);
  moonDir[1] = Math.sin(mel);
  moonDir[2] = -Math.cos(mel) * Math.cos(maz);
  const wd = params.windDirDeg * DEG;
  windVec3[0] = Math.cos(wd) * params.windSpeed;
  windVec3[1] = 0;
  windVec3[2] = Math.sin(wd) * params.windSpeed;

  params.windDir = wd;
  params.swellDir = params.swellDirDeg * DEG;
  params.sunIrradiance = new Float32Array([
    params.sunTint[0] * params.sunIntensity,
    params.sunTint[1] * params.sunIntensity,
    params.sunTint[2] * params.sunIntensity,
  ]);
  params.moonColor = new Float32Array([0.55, 0.68, 1.0].map((c) => c * params.moonIntensity * 2.4));
  camera.fov = params.fov;
  camera.speed = params.moveSpeed;
}

// Cascade fade distances: a patch stops contributing once its texels are far
// smaller than a pixel, which is also where its energy becomes pure roughness.
function fadeDistances() {
  return new Float32Array(ocean.L.map((L) => clamp(L * 38, 200, 60000)));
}

// -------------------------------------------------------------- photo mode
const mainWakeBuf = new Float32Array(28 * 4);
const HALTON = [];
(function () {
  const h = (i, b) => { let f = 1, r = 0; while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); } return r; };
  for (let i = 1; i <= 256; i++) HALTON.push([h(i, 2) - 0.5, h(i, 3) - 0.5]);
})();
let photo = false, accumIndex = 0;
function resetAccum() { accumIndex = 0; }
camera.moved = true;

// --------------------------------------------------------------------- UI glue
const ui = new UI(document.getElementById('ui'), params, (ev) => {
  if (ev.type === 'preset') {
    applyPreset(params, ev.name);
    ocean.dirty = true;
    ui.syncAll();
    derive();
    resetAccum();
    return;
  }
  if (ev.type === 'reseed') {
    params.seed = 1 + Math.floor(Math.random() * 9998);
    ocean.setSeed(params.seed);
    ui.syncAll();
    ui.toast('New sea generated');
    resetAccum();
    return;
  }
  if (ev.type === 'reset') { applyPreset(params, ui.presetSelect.value); ocean.dirty = true; ui.syncAll(); resetAccum(); return; }
  if (ev.type === 'photo') { togglePhoto(); return; }
  if (ev.type === 'ride') { toggleRide(); return; }
  if (ev.type === 'copy') {
    const clean = {};
    for (const k of Object.keys(defaults)) clean[k] = params[k];
    const text = JSON.stringify(clean, null, 2);
    Promise.resolve(navigator.clipboard?.writeText(text) ?? Promise.reject())
      .then(() => ui.toast('Settings copied to clipboard'))
      .catch(() => {
        console.log(text);
        ui.toast('Clipboard blocked \u2014 settings printed to the console');
      });
    return;
  }
  if (ev.type === 'save') { savePng(); return; }

  const it = ev.item;
  if (it.rebuild) ocean.dirty = true;
  if (it.rebuildSim) { ocean = new Ocean(gl, { size: params.fftSize, cascades: DEFAULT_CASCADES }); ocean.setSeed(params.seed); }
  if (it.rebuildGrid) buildGrid();
  if (it.rebuildSpray) spray = new Spray(gl, blit, { size: params.sprayTexSize });
  if (it.resize) resize();
  derive();
  resetAccum();
});
ui.presetSelect.value = PRESETS[startPreset] ? startPreset : 'Golden Hour Swell';

function toggleRide() {
  waveRunner.active = !waveRunner.active;
  document.body.classList.toggle('riding', waveRunner.active);
  if (waveRunner.active) {
    savedView = { pos: [...camera.pos], yaw: camera.yaw, pitch: camera.pitch, fov: camera.fov };
    waveRunner.reset(camera);
    if (photo) togglePhoto();
  } else if (savedView) {
    camera.pos.set(savedView.pos);
    camera.yaw = savedView.yaw; camera.pitch = savedView.pitch;
    camera.fov = savedView.fov; camera.roll = 0;
  }
  camera.locked = waveRunner.active;
  resetAccum();
  ui.toast(waveRunner.active ? 'Wave runner \u2014 W throttle, A/D steer, V view' : 'Free camera');
}
let savedView = null;

function togglePhoto() {
  photo = !photo;
  resetAccum();
  ui.toast(photo ? 'Photo mode — accumulating' : 'Photo mode off');
}

function savePng() {
  canvas.toBlob((b) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b);
    a.download = `abyssal-${Date.now()}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  });
  ui.toast('Frame saved');
}

// The panel must be dismissable without a keyboard, so the button is the
// primary control and the H shortcut just drives the same state.
const panelToggle = document.getElementById('panel-toggle');
function setPanel(open) {
  document.body.classList.toggle('panel-hidden', !open);
  document.getElementById('ui').classList.toggle('hidden', !open);
  panelToggle?.setAttribute('aria-expanded', String(open));
}
panelToggle?.addEventListener('click', () => {
  setPanel(document.body.classList.contains('panel-hidden'));
});
// On a phone the panel is a bottom sheet; open it by default and the visitor
// arrives at a wall of sliders instead of the sea.
setPanel(!window.matchMedia('(max-width: 760px), (pointer: coarse)').matches);

window.addEventListener('keydown', (e) => {
  if (e.target && /input|select|textarea/i.test(e.target.tagName)) return;
  if (e.code === 'KeyH') setPanel(document.body.classList.contains('panel-hidden'));
  if (e.code === 'KeyP') togglePhoto();
  if (e.code === 'KeyR') toggleRide();
  if (e.code === 'KeyV' && waveRunner.active) {
    params.wrView = params.wrView >= 0.5 ? 0 : 1;
    ui.syncAll();
    ui.toast(params.wrView >= 0.5 ? 'Chase camera' : 'Rider view');
    resetAccum();
  }
  if (e.code === 'KeyO') savePng();
});

// ------------------------------------------------------------------ frame loop
const hudFps = document.getElementById('hud-fps');
let last = performance.now(), fpsAvg = 60, simTime = 0, frames = 0;
let fpsFrames = 0, fpsWindow = 0, hudDue = true;
// Below 10 fps the integer readout collapses to '0'; a tenth is the difference
// between 'slow' and 'not running'.
const fmtFps = (f) => (f < 10 ? f.toFixed(1) : f.toFixed(0));

function frame(now) {
  const dtRaw = (now - last) / 1000;
  last = now;
  const dt = Math.min(dtRaw, 1 / 20);
  fpsFrames++; fpsWindow += dtRaw;
  if (fpsWindow >= 0.5) { fpsAvg = fpsFrames / fpsWindow; fpsFrames = 0; fpsWindow = 0; hudDue = true; }
  frames++;

  resize();
  derive();

  camera.moved = false;

  const frozen = photo && accumIndex > 0;
  if (!frozen) simTime += dt;
  const stepDt = frozen ? 0 : dt;

  ocean.update(stepDt, params);

  // The craft has to read the surface the ocean just wrote, and the camera has
  // to be told where the craft ended up, so both sit between the sim and the
  // basis update rather than at the top of the frame.
  if (waveRunner.active && !frozen) {
    waveRunner.probe(params, ocean);
    waveRunner.update(dt, params, camera.keys, camera);
  }
  camera.locked = waveRunner.active;
  // Handheld drift and sea bob nudge the camera every frame, which would reset
  // the accumulator every frame; photo mode locks the tripod off.
  camera.update(dt, photo ? { ...params, handheld: 0, cameraBob: 0 } : params);
  if (camera.moved) resetAccum();
  sky.updateLUT(params, sunDir, Math.max(camera.pos[1], 1));

  const jitter = photo ? HALTON[accumIndex % HALTON.length] : [0, 0];
  camera.matrices(W, H, jitter[0], jitter[1]);

  // Wake polyline and hull emitter, flattened for the shaders. Ages are relative
  // to now so the water shader can fade each point without a clock of its own.
  const WAKE_MAX = 28;
  const wakeBuf = mainWakeBuf;
  let wakeCount = 0;
  if (waveRunner.active) {
    const tr = waveRunner.trail;
    wakeCount = Math.min(tr.length, WAKE_MAX);
    for (let i = 0; i < wakeCount; i++) {
      const t = tr[i];
      wakeBuf[i * 4] = t[0]; wakeBuf[i * 4 + 1] = t[1];
      wakeBuf[i * 4 + 2] = t[2]; wakeBuf[i * 4 + 3] = t[3];
    }
  }
  const cf = waveRunner.active
    ? [Math.sin(waveRunner.heading), -Math.cos(waveRunner.heading)]
    : [0, 1];

  const ctx = {
    camPos: camera.pos, camRight: camera.right, camUp: camera.up,
    viewProj: camera.viewProj, invViewProj: camera.invViewProj,
    sunDir, moonDir, windVec3, time: simTime,
    craftPos: waveRunner.active
      ? new Float32Array([waveRunner.pos[0], waveRunner.deckY ?? 0, waveRunner.pos[2]])
      : new Float32Array([0, -1e4, 0]),
    craftFwd: new Float32Array(cf),
    craftRight: new Float32Array([-cf[1], cf[0]]),
    craftSpeed: waveRunner.active ? Math.abs(waveRunner.speed) : 0,
    craftTurn: waveRunner.active ? waveRunner.yawRate : 0,
    craftAmount: waveRunner.active ? params.craftSprayAmount : 0,
  };

  if (!frozen) spray.update(stepDt, params, ctx, ocean);

  // --- scene ---
  gl.bindFramebuffer(gl.FRAMEBUFFER, hdrFbo);
  gl.viewport(0, 0, W, H);
  gl.clearColor(0, 0, 0, 1);
  gl.clearDepth(1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);
  gl.depthMask(true);
  gl.disable(gl.CULL_FACE);
  gl.useProgram(pWater);
  setUniforms(gl, pWater, {
    ...sky.atmosphereUniforms(params),
    uDisp: ocean.disp, uSlope: ocean.slope, uFoam: ocean.foamTex,
    uPatch: ocean.patchSizes, uFade: fadeDistances(),
    uCascadeCount: ocean.cascadeCount, uDetailScale: params.detailScale,
    uViewProj: camera.viewProj, uCamPos: camera.pos,
    uGridCenter: new Float32Array([camera.pos[0], camera.pos[2]]),
    uRMin: params.rMin, uRMax: params.rMax,
    uHeightScale: params.heightScale, uHorizScale: params.horizScale,
    uEarthCurve: params.earthCurve, uSeaLevel: params.seaLevel,
    uSkyLUT: sky.lut, uSunDir: sunDir, uMoonDir: moonDir,
    uSunColor: params.sunIrradiance, uMoonColor: params.moonColor,
    uTime: simTime,
    uScatterColor: params.scatterColor, uAbsorption: params.absorption,
    uScatterAmount: params.scatterAmount,
    uSSSStrength: params.sssStrength, uSSSPower: params.sssPower, uSSSHeight: params.sssHeight,
    uSSSDepth: params.sssDepth,
    uBaseRoughness: params.baseRoughness, uRoughnessGain: params.roughnessGain,
    uRoughnessMax: params.roughnessMax, uWindAniso: params.windAniso,
    uWindSpeed: params.windSpeed,
    uFoamAmount: params.foamAmount, uFoamRoughness: params.foamRoughness,
    uFoamTint: params.foamTint, uFoamDetail: params.foamDetail, uFoamLift: params.foamLift,
    uFoamSharp: params.foamSharp, uFoamCrisp: params.foamCrisp, uFoamStreak: params.foamStreak,
    uFoamOpacity: params.foamOpacity,
    uFoamColor: params.foamColor,
    uSunAngularRadius: params.sunAngularRadius, uSpecIntensity: params.specIntensity,
    uSkyAmbient: params.skyAmbient, uSkyBlur: params.skyBlur,
    uGlitter: params.glitter, uGlitterScale: params.glitterScale,
    uWaterIOR: params.waterIOR, uAerial: params.aerial,
    uWindDirV: new Float32Array([Math.cos(params.windDir), Math.sin(params.windDir)]),
    uSpecClamp: params.specClamp, uHorizonBend: params.horizonBend,
    uWake: wakeBuf, uWakeCount: wakeCount,
    uWakeCentre: new Float32Array([waveRunner.pos[0], waveRunner.pos[2]]),
    uWakeRadius: 40 + params.wakeWidth * 6 + (waveRunner.speed || 0) * params.wakeLife,
    uWakeWidth: params.wakeWidth, uWakeLife: params.wakeLife,
    uWakeStrength: waveRunner.active ? params.wakeStrength : 0,
    uWakeSpread: params.wakeSpread, uWakeArmRate: params.wakeArmRate,
    uWakeArm: params.wakeArm, uWakeCentre2: params.wakeCentre,
    uInterReflect: params.interReflect, uWaveAO: params.waveAO,
    uWaveShadow: params.waveShadow, uShadowScale: params.shadowScale,
    uCapillary: params.capillary, uCapillaryScale: params.capillaryScale,
    uSpecAA: params.specAA, uGrazeFocus: params.grazeFocus,
    uSSSBias: params.sssBias, uFoamFar: params.foamFar,
  });
  gl.bindVertexArray(grid.vao);
  gl.drawElements(gl.TRIANGLES, grid.count, gl.UNSIGNED_INT, 0);
  gl.bindVertexArray(null);

  // Spray needs the displacement field too: billboards fade against the real
  // water height instead of showing a hard intersection edge.
  if (waveRunner.active) {
    // The waterline is the sea, not the deck: using deckY put almost the whole
    // hull below it, which is why it painted dark and read as glass.
    craft.wetLine = waveRunner.probeH[0];
    craft.setTransform(
      // The hull's designed waterline sits above its keel, so the origin has to
      // ride proud of the surface or the sea closes over the deck.
      [waveRunner.pos[0], (waveRunner.deckY ?? 0) + params.craftLift, waveRunner.pos[2]],
      waveRunner.heading, waveRunner.pitchTrim,
      waveRunner.bank + waveRunner.rollTrim, params.craftScale,
    );
    craft.draw(params, ctx, sky.lut);
  }

  // Sky after the sea: its triangle sits on the far plane under a LEQUAL test,
  // so the volumetric cloud march - the most expensive shading in the frame -
  // only runs on pixels the ocean left empty.
  sky.drawBackground(params, ctx);

  spray.draw(params, ctx, sky.lut, sky.atmosphereUniforms(params), ocean);

  gl.disable(gl.DEPTH_TEST);

  // --- post ---
  let src = hdr;
  if (photo) {
    accumIndex++;
    src = post.accumulate(hdr, accumIndex);
  }
  post.render(src, params, dt, simTime, { photo, sample: accumIndex });

  if (hudDue) {
    hudDue = false;
    hudFps.textContent = waveRunner.active
      ? `${waveRunner.speedKts.toFixed(0)} kn \u00b7 ${fmtFps(fpsAvg)} fps${waveRunner.airborne ? ' \u00b7 AIR' : ''}`
      : photo
      ? `photo · ${Math.min(accumIndex, params.photoSamples)}/${Math.round(params.photoSamples)} samples`
      : `${fmtFps(fpsAvg)} fps · ${W}×${H} · ${ocean.N}² × ${ocean.cascadeCount}`;
  }

  requestAnimationFrame(frame);
}

derive();
resize();
ocean.buildSpectrum(params);
// Two warm-up steps so the very first presented frame already has foam history.
ocean.update(1 / 60, params);
document.getElementById('boot').classList.add('gone');
requestAnimationFrame(frame);

window.abyssal = { params, ocean, camera, ui, gl, get spray() { return spray; }, get frames() { return frames; } };
