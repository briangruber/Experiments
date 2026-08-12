import { getContext, texture2D, framebuffer, depthBuffer, Blitter } from '../src/gl.js';
import { WaterSurface } from '../src/water.js';
import { Ocean, DEFAULT_CASCADES } from '../src/ocean.js';
import { Sky } from '../src/sky.js';
import { Spray } from '../src/spray.js';
import { Post } from '../src/post.js';
import { Camera } from './camera.js';
import { WaveRunner } from './waverunner.js';
import { Wake } from '../src/wake.js';
import { Craft } from './craft.js';
import { UI, applyPreset } from './ui.js';
import { defaults, PRESETS } from '../src/presets.js';
import { createDerived, derive as deriveScene } from '../src/derive.js';
import { clamp } from '../src/math.js';

const canvas = document.getElementById('gl');
// The GPU preference is fixed at context creation and cannot be changed
// afterwards, so it comes straight from the defaults (or ?gpu= for a one-off)
// rather than from the live parameter set.
const gl = getContext(canvas, {
  powerPref: new URLSearchParams(location.search).get('gpu') || defaults.powerPref,
  keepBuffer: new URLSearchParams(location.search).has('keepbuffer'),
});
const blit = new Blitter(gl);

const params = structuredClone(defaults);
const startPreset = new URLSearchParams(location.search).get('preset');
applyPreset(params, PRESETS[startPreset] ? startPreset : 'Golden Hour Swell');

const camera = new Camera(canvas);
const sky = new Sky(gl, blit);
const post = new Post(gl, blit);
let ocean = new Ocean(gl, { size: params.fftSize, cascades: DEFAULT_CASCADES });
let spray = new Spray(gl, blit, { size: params.sprayTexSize });
const water = new WaterSurface(gl, params);
const waveRunner = new WaveRunner(gl, blit);
let wake = new Wake(gl, blit, { size: params.wakeTexSize });
const craft = new Craft(gl);

// --------------------------------------------------------------- render target
let hdr = null, hdrFbo = null, depthRb = null, W = 1, H = 1;
function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, Math.max(params.dprCap, 0.5));
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
const derived = createDerived();
const { sunDir, moonDir, windVec3 } = derived;
function derive() {
  deriveScene(params, derived);
  camera.fov = params.fov;
  camera.speed = params.moveSpeed;
}

// Scratch vectors for the per-frame uniform block. Allocating a fresh
// Float32Array per uniform per frame is a dozen short-lived objects every frame,
// which is exactly the sort of thing that shows up as jitter on a phone rather
// than as a lower average frame rate.
const vCraftPos = new Float32Array(3), vCraftFwd = new Float32Array(2);
const vCraftRight = new Float32Array(2);
// The hull's footprint on the water, handed to WaterSurface each frame.
const hull = { pos: new Float32Array(3), fwd: new Float32Array(2), push: 0, plane: 0 };
const smoothstep01 = (a, b, x) => {
  const t = clamp((x - a) / Math.max(b - a, 1e-5), 0, 1);
  return t * t * (3 - 2 * t);
};
const set2 = (a, x, y) => { a[0] = x; a[1] = y; return a; };
const set3 = (a, x, y, z) => { a[0] = x; a[1] = y; a[2] = z; return a; };

// -------------------------------------------------------------- photo mode
const HALTON = [];
(function () {
  const h = (i, b) => { let f = 1, r = 0; while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); } return r; };
  for (let i = 1; i <= 256; i++) HALTON.push([h(i, 2) - 0.5, h(i, 3) - 0.5]);
})();
// Water on the lens. It arrives when the camera is inside the plume - which in
// chase view is exactly where the rooster tail goes - and dries off on its own
// clock afterwards, so a hard burst lingers for a second or two the way it does
// on a real housing.
let lensWet = 0;
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
  if (ev.type === 'view') { toggleView(); return; }
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
  if (ev.type === 'quiet') { toggleQuiet(); return; }

  const it = ev.item;
  if (it.rebuild) ocean.dirty = true;
  if (it.rebuildSim) { ocean = new Ocean(gl, { size: params.fftSize, cascades: DEFAULT_CASCADES }); ocean.setSeed(params.seed); }
  if (it.rebuildGrid) water.buildGrid(params);
  if (it.rebuildSpray) spray = new Spray(gl, blit, { size: params.sprayTexSize });
  if (it.rebuildWake) wake = new Wake(gl, blit, { size: params.wakeTexSize });
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
    wake.clear();
    if (photo) togglePhoto();
  } else if (savedView) {
    camera.pos.set(savedView.pos);
    camera.yaw = savedView.yaw; camera.pitch = savedView.pitch;
    camera.fov = savedView.fov; camera.roll = 0;
  }
  camera.locked = waveRunner.active;
  ui.syncAll();
  resetAccum();
  ui.toast(waveRunner.active ? 'Wave runner \u2014 W throttle, A/D steer, V view' : 'Free camera');
}
let savedView = null;

function toggleView() {
  if (!waveRunner.active) return;
  params.wrView = params.wrView >= 0.5 ? 0 : 1;
  ui.syncAll();
  ui.toast(params.wrView >= 0.5 ? 'Chase camera' : 'Rider view');
  resetAccum();
}

// One switch for everything that costs power rather than picture. Everything it
// touches is a normal parameter, so it is a starting point rather than a mode -
// move any of them afterwards and they stay moved.
const LOUD = { fpsCap: 60, dprCap: 1.75, targetFps: 40, renderScaleMax: 1.0, cloudSteps: 48 };
const QUIET = { fpsCap: 30, dprCap: 1.15, targetFps: 30, renderScaleMax: 0.8, cloudSteps: 32 };
let quiet = false;
function toggleQuiet() {
  quiet = !quiet;
  Object.assign(params, quiet ? QUIET : LOUD);
  ui.syncAll();
  resize();
  derive();
  resetAccum();
  ui.toast(quiet ? 'Quiet mode \u2014 half the frames, fewer pixels' : 'Full quality');
}

function togglePhoto() {
  photo = !photo;
  resetAccum();
  ui.toast(photo ? 'Photo mode — accumulating' : 'Photo mode off');
}

// preserveDrawingBuffer is off - it costs a full-frame copy on every single frame
// to serve a button pressed a handful of times a session - so the backbuffer is
// only readable inside the task that drew it. Flag it here and grab it at the end
// of the next frame instead.
let pngPending = false;
function savePng() { pngPending = true; }

function writePng() {
  pngPending = false;
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
  if (e.code === 'KeyV') toggleView();
  if (e.code === 'KeyO') savePng();
});

// ------------------------------------------------------------------ frame loop
const hudFps = document.getElementById('hud-fps');
let last = performance.now(), fpsAvg = 60, simTime = 0, frames = 0;
let fpsFrames = 0, fpsWindow = 0, hudDue = true;
// Adaptive resolution. A fixed mobile budget cannot know whether it is on an
// iPhone 12 or a 16 Pro, so the renderer measures itself and trims pixels until
// it hits the target. Coarse steps on a one-second cadence: every change
// reallocates the HDR targets, so thrashing would cost more than it saves.
let qAccum = 0, qFrames = 0;
// True when the frame rate is being held down by the cap rather than by the GPU.
// Without this the controller reads "we have headroom" from a frame rate the cap
// itself is setting, and climbs quality until it has spent exactly the power the
// cap was meant to save.
function cappedOut(fps) {
  return params.fpsCap > 0 && fps >= params.fpsCap * 0.92;
}

function adaptQuality(dtRaw) {
  if (!params.adaptiveQuality) return;
  qAccum += dtRaw; qFrames++;
  if (qAccum < 1.0) return;
  const fps = qFrames / qAccum;
  qAccum = 0; qFrames = 0;
  // Three levers, spent in the order a measured frame says they are worth. On a
  // riding frame the volumetric cloud march is the largest single item - about a
  // fifth of it - the spray draw is next, and the water grid is third; trimming
  // pixels touches all of them at once, so it goes first and furthest.
  const lo = params.renderScaleMin, hi = params.renderScaleMax;
  if (fps < params.targetFps * 0.9) {
    if (params.renderScale > lo) {
      params.renderScale = Math.max(lo, params.renderScale - 0.08);
    } else if (params.cloudStepScale > params.cloudStepMin) {
      params.cloudStepScale = Math.max(params.cloudStepMin, params.cloudStepScale - 0.15);
    } else if (params.gridScale > params.gridScaleMin) {
      params.gridScale = Math.max(params.gridScaleMin, params.gridScale - 0.12);
      water.buildGrid(params);
    }
  } else if (fps > params.targetFps * 1.25 && !cappedOut(fps)) {
    // Given back in the reverse order, cheapest first, so quality returns without
    // immediately spending the headroom that allowed it.
    if (params.gridScale < 1) {
      params.gridScale = Math.min(1, params.gridScale + 0.06);
      water.buildGrid(params);
    } else if (params.cloudStepScale < 1) {
      params.cloudStepScale = Math.min(1, params.cloudStepScale + 0.08);
    } else if (params.renderScale < hi) {
      params.renderScale = Math.min(hi, params.renderScale + 0.04);
    }
  }
}
// Below 10 fps the integer readout collapses to '0'; a tenth is the difference
// between 'slow' and 'not running'.
const fmtFps = (f) => (f < 10 ? f.toFixed(1) : f.toFixed(0));

// The renderer's duty cycle. Left uncapped it runs at the display's refresh -
// 120 Hz on a recent laptop - and the adaptive controller below then raises
// quality until it is *just* missing the target, so between them they consume
// every watt the machine will give. That is the right behaviour for a benchmark
// and the wrong one for something you leave open.
//
// Capping has to SKIP frames rather than lower quality: quality knobs trade
// picture for frame rate, and neither of those is what makes a laptop hot. Only
// doing less work per second does.
let lastPresent = 0;
function shouldSkip(now) {
  if (params.fpsCap <= 0) return false;
  // A visible but unfocused window keeps getting rAF at full rate; only a hidden
  // tab is throttled by the browser. Idling here is what stops it heating the
  // machine behind whatever you switched to.
  const cap = document.hasFocus() ? params.fpsCap : Math.min(params.fpsCap, params.fpsCapIdle);
  // A hair under the period, or a cap equal to the refresh rate lands just the
  // wrong side of every other vsync and halves the frame rate instead.
  if (now - lastPresent < 1000 / cap - 1.2) return true;
  lastPresent = now;
  return false;
}

function frame(now) {
  if (!pngPending && shouldSkip(now)) { requestAnimationFrame(frame); return; }
  const dtRaw = (now - last) / 1000;
  last = now;
  const dt = Math.min(dtRaw, 1 / 20);
  fpsFrames++; fpsWindow += dtRaw;
  if (fpsWindow >= 0.5) { fpsAvg = fpsFrames / fpsWindow; fpsFrames = 0; fpsWindow = 0; hudDue = true; }
  frames++;

  adaptQuality(dtRaw);
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
    waveRunner.probe(params, ocean, wake);
    waveRunner.update(dt, params, camera.keys, camera);
    // The wake field has to be stamped before anything reads it, and it reads
    // the hull state the update just produced.
    wake.update(dt, params, waveRunner);
  }
  camera.locked = waveRunner.active;
  // Handheld drift and sea bob nudge the camera every frame, which would reset
  // the accumulator every frame; photo mode locks the tripod off.
  camera.update(dt, photo ? { ...params, handheld: 0, cameraBob: 0 } : params);
  if (camera.moved) resetAccum();
  sky.updateLUT(params, sunDir, Math.max(camera.pos[1], 1));

  const jitter = photo ? HALTON[accumIndex % HALTON.length] : [0, 0];
  camera.matrices(W, H, jitter[0], jitter[1]);

  const cf = waveRunner.active
    ? [Math.sin(waveRunner.heading), -Math.cos(waveRunner.heading)]
    : [0, 1];

  const ctx = {
    camPos: camera.pos, camRight: camera.right, camUp: camera.up,
    viewProj: camera.viewProj, invViewProj: camera.invViewProj,
    sunDir, moonDir, windVec3, time: simTime,
    craftPos: waveRunner.active
      ? set3(vCraftPos, waveRunner.pos[0], waveRunner.deckY ?? 0, waveRunner.pos[2])
      : set3(vCraftPos, 0, -1e4, 0),
    craftFwd: set2(vCraftFwd, cf[0], cf[1]),
    craftRight: set2(vCraftRight, -cf[1], cf[0]),
    craftSpeed: waveRunner.active ? Math.abs(waveRunner.speed) : 0,
    craftTurn: waveRunner.active ? waveRunner.yawRate : 0,
    craftAmount: waveRunner.active ? params.craftSprayAmount : 0,
    craftLoad: waveRunner.active ? (waveRunner.hullLoad ?? 0) : 0,
    // The rider's inputs and the hull's attitude, which is what the spray
    // emitter needs to know to point the water anywhere sensible.
    craftSteer: waveRunner.active ? waveRunner.steerIn : 0,
    craftThrottle: waveRunner.active ? (waveRunner.throttle ?? 0) : 0,
    craftSlip: waveRunner.active ? (waveRunner.slipSigned ?? 0) : 0,
    craftAir: waveRunner.active && waveRunner.airborne ? 1 : 0,
    craftImpact: waveRunner.active ? waveRunner.impact : 0,
  };

  if (!frozen) spray.update(stepDt, params, ctx, ocean);

  // --- scene ---
  gl.bindFramebuffer(gl.FRAMEBUFFER, hdrFbo);
  gl.viewport(0, 0, W, H);
  gl.clearColor(0, 0, 0, 1);
  gl.clearDepth(1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  // The hull footprint. Placed in the frame the displacement fields are indexed
  // by, not in world space - see WaveRunner.surfXZ. At the world position instead,
  // the hollow and bow wave sat 1.3 to 1.7 m off the craft on the default sea and
  // slid about as the waves went under it, which read as a ripple hanging off the
  // bow.
  if (waveRunner.active) {
    const s = waveRunner.surfXZ();
    set3(hull.pos, s[0], waveRunner.deckY ?? 0, s[1]);
    hull.push = params.hullPush;
    // The hollow only exists once the hull is actually loading the water.
    hull.plane = Math.min(1, 0.35 + 0.65 * Math.abs(waveRunner.speed) / Math.max(params.craftPlaneFull, 1));
  } else {
    set3(hull.pos, 0, -1e4, 0);
    hull.push = 0;
    hull.plane = 0;
  }
  set2(hull.fwd, cf[0], cf[1]);

  water.render(params, ctx, ocean, sky, { wake, wakeActive: waveRunner.active, hull });

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
      waveRunner.heading,
      waveRunner.pitchTrim + params.craftPitchOffset,
      waveRunner.bank + waveRunner.rollTrim + params.craftRollOffset,
      params.craftScale, params.craftYawOffset,
    );
    craft.draw(params, ctx, sky.lut, sky.atmosphereUniforms(params));
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
  // How much of the hull's own output is reaching the glass. Driven by the same
  // readings the spray emitter uses, and falling off with how far the camera is
  // sitting behind the emitter - so pulling the chase rig back genuinely clears
  // the lens as well as the frame.
  if (!frozen) {
    let src2 = 0;
    if (waveRunner.active) {
      const dx = camera.pos[0] - waveRunner.pos[0];
      const dy = camera.pos[1] - (waveRunner.deckY ?? 0);
      const dz = camera.pos[2] - waveRunner.pos[2];
      const flat = Math.hypot(dx, dz) || 1e-3;
      // What matters is whether the camera is sitting *in* the plume, not how
      // close it is to the nozzle. The jet throws water aft at fifteen to twenty
      // metres a second and it hangs there, so a chase rig twenty metres directly
      // astern is squarely in the path while one the same distance off to the side
      // is in clean air. Modelling it as a simple radius meant that pulling the
      // camera back to see past the spray also dried the lens off completely,
      // which is the opposite of what happens.
      const aft = -(dx * cf[0] + dz * cf[1]) / flat;      // 1 = directly astern
      const lat = Math.abs(-dx * cf[1] + dz * cf[0]);
      const wide = 2.0 + 0.22 * flat;                     // the plume spreads aft
      const far = Math.hypot(flat, dy);
      let inPlume = smoothstep01(-0.15, 0.55, aft)
                  * Math.exp(-((lat / wide) ** 2))
                  * (1 - smoothstep01(params.lensReach, params.lensReach * 2.2, far))
                  * Math.exp(-Math.max(dy - 1.5, 0) / 4);
      // Riding it, you are inside the plume by definition.
      inPlume = Math.max(inPlume, 1 - smoothstep01(1.5, 5.0, far));
      const spd = clamp(Math.abs(waveRunner.speed) / Math.max(params.wrTopSpeed, 1), 0, 1);
      src2 = clamp((spd * params.lensSpray
                  + (waveRunner.hullLoad ?? 0) * 0.018
                  + waveRunner.impact * 1.6) * inPlume, 0, 1);
      if (waveRunner.airborne) src2 *= 0.15;
    }
    const rate = src2 > lensWet ? params.lensWetRate : params.lensDry;
    lensWet += (src2 - lensWet) * (1 - Math.exp(-rate * dt));
  }
  post.render(src, params, dt, simTime, { photo, sample: accumIndex, lensWet });

  if (hudDue) {
    hudDue = false;
    hudFps.textContent = waveRunner.active
      ? `${waveRunner.speedKts.toFixed(0)} kn \u00b7 ${fmtFps(fpsAvg)} fps${
          waveRunner.airborne ? ` \u00b7 AIR ${(waveRunner.airTime ?? 0).toFixed(1)}s` : ''}`
      : photo
      ? `photo · ${Math.min(accumIndex, params.photoSamples)}/${Math.round(params.photoSamples)} samples`
      : `${fmtFps(fpsAvg)} fps · ${W}×${H} · ${ocean.N}² × ${ocean.cascadeCount}`;
  }

  // Last thing in the frame: the backbuffer is still intact here, and is not once
  // this task yields.
  if (pngPending) writePng();

  requestAnimationFrame(frame);
}

derive();
resize();
ocean.buildSpectrum(params);
// Two warm-up steps so the very first presented frame already has foam history.
ocean.update(1 / 60, params);
document.getElementById('boot').classList.add('gone');
requestAnimationFrame(frame);

window.abyssal = {
  params, ocean, camera, ui, gl, waveRunner,
  get spray() { return spray; },
  get wake() { return wake; },
  get lensWet() { return lensWet; },
  post,
  get frames() { return frames; },
};
