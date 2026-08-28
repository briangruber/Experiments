import * as THREE from 'three';
import { PARAMS, get, set } from './params.js';
import { WakeField } from './wakeField.js';
import { Ocean } from './ocean.js';
import { makeBoat } from './boat.js';
import { Backdrop } from './backdrop.js';
import { heightAt } from './lakeHeight.js';
import { Park } from './park.js';
import { Shore } from './shore.js';
import { AbyssalSea, PRESET_NAMES, SCENE_TUNE, PRESETS } from './abyssalSea.js';
import { OceanBody } from './oceanBody.js';
import { WakeBridge } from './wakeBridge.js';
import { Spray } from './spray.js';
import { loadBoat, BOATS } from './boatLibrary.js';
import { buildUI, buildBoatPicker } from './ui.js';


// URL overrides: ?arms.angle=18&boat.speed=15 — handy for headless captures.
//
// FIRST, before anything is built. These used to run after construction, which
// silently broke every override that a constructor reads once -- the shore's
// bay radius, its tree and boulder counts, the boat model. The value changed
// and the object had already been made from the old one.
for (const [k, v] of new URLSearchParams(location.search)) {
  if (k.includes('.')) set(k, v);
}

const canvas = document.getElementById('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setClearColor(0x0a1017);
// Tone-map the MESHES.
//
// The boat models arrived textured and rendered white, and the cause was
// exposure rather than loading: ambient 1.1 plus a 2.2 directional is a great
// deal of light in three's modern units, and a MeshStandardMaterial under it
// clips to white with the texture still perfectly bound. The old placeholder
// was flat grey, so nothing ever showed it.
//
// This only touches three's own materials. Abyssal and the lab ocean are raw
// shader programs that tonemap and encode themselves, and three does not
// inject its tonemapping into those -- so the sea is untouched and the meshes
// land in the same range as it.
// NEUTRAL, not ACES.
//
// ACES rolls highlights toward white -- that is its filmic look, and it is
// what was quietly draining the colour out of the boats: measured on the
// inflatable, whose texture is navy and yellow on white, mean saturation came
// out 0.374 under ACES against 0.432 under Neutral at the same brightness,
// with NOTHING clipped in either. So the hulls were never blown out; the
// curve was desaturating them by design.
//
// Khronos PBR Neutral exists for exactly this case -- showing an asset's own
// albedo rather than grading a photograph of it. The sea is unaffected either
// way: it is a raw shader program that tonemaps itself.
renderer.toneMapping = THREE.NeutralToneMapping;
// SHADOWS. Nothing in the scene cast one until now, and that is the loudest
// single tell against realism -- a headland with no shadow on its own rock
// reads as a painted backdrop no matter how good its surface is. One
// directional shadow map, sized to the bay, costs one extra pass.
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
// Halved against the pre-tonemapping values: ACES maps a much wider range in,
// so the same numbers would still clip.
const ambient = new THREE.AmbientLight(0xa8c0d8, 0.55);
scene.add(ambient);
const sun = new THREE.DirectionalLight(0xfff2e0, 1.15);
sun.castShadow = true;
// The frustum has to cover the whole bay, not the default 10 m box, or the
// shadows simply are not there. 2048 over ~900 m is about half a metre per
// texel, which is the scale rock detail lives at.
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 2600;
sun.shadow.camera.left = -520; sun.shadow.camera.right = 520;
sun.shadow.camera.top = 520; sun.shadow.camera.bottom = -520;
// Sloped rock self-shadows badly at grazing sun without a bias.
sun.shadow.bias = -0.0006;
sun.shadow.normalBias = 0.6;
scene.add(sun);
scene.add(sun.target);
// The lagoon's answer light: bright water throws a cyan glow UP at anything
// floating on it. Sky half black -- the AmbientLight already covers the sky's
// share -- so this only lifts down-facing surfaces: the wet band at the
// waterline, and above all the submerged half of the hull, which without it
// photographs near-black and turns the refraction view into a shadow.
const bounce = new THREE.HemisphereLight(0x000000, 0xaee6e0, 0.9);
scene.add(bounce);

const camera = new THREE.PerspectiveCamera(38, 1, 0.5, 3000);

// The Kelvin waves are the finest thing the field has to carry, and at 1024
// over a 340 m window (~0.33 m/texel) their cusp lines visibly stair-step.
// 2048 fixes it, at 4x the memory -- so phones keep the smaller one.
const narrow = matchMedia('(max-width: 720px)').matches;
const wake = new WakeField(renderer, narrow ? 1024 : 2048);
const ocean = new Ocean(wake, 520, 560);
const backdrop = new Backdrop();
// The park: lawn, stone coping, trees, and the pond the boats keep to. The
// pond is a hole in the lawn — Abyssal's sea still runs to the horizon and
// the lawn simply covers it from the rim outward, so no water shader knows
// the pond exists.
// Open water again. The park (lawn, coping, trees) is built only when
// lake.pond asks for it: a pond rim is a lovely toy but it is also a hard
// edge in every frame, and the sea reads better running to the horizon.
const park = get('lake.pond') > 1 ? new Park(get('lake.pond')) : null;
if (park) scene.add(park.group);
// The lagoon shore: rock, shelves, headland and pines, built once at startup
// (it is a place, not an effect -- rebuilding it per frame would be absurd).
const shore = get('shore.on') > 0.5
  ? new Shore({ bay: get('shore.bay'), rugged: get('shore.rugged'),
      relief: get('shore.relief'), trees: Math.round(get('shore.trees')),
      boulders: Math.round(get('shore.boulders')) })
  : null;
if (shore) scene.add(shore.group);
// Air. The far lawn and treeline haze out; the sea ignores this and hazes
// itself in its own shader, which is fine — land and water do haze apart.
if (park) scene.fog = new THREE.Fog(0xd4e2ec, 420, 2400);
// Air over the bay. The far headland has to haze or it reads as a cardboard
// cut-out against the sky; the sea ignores this and hazes itself.
if (get('shore.on') > 0.5) scene.fog = new THREE.Fog(0xcfe3ef, 900, 5200);

// The terrain is gone from the scene. It was an 11 m-per-vertex heightfield
// shaded flat against the old analytic sky, and against Abyssal's water it
// read as an olive wall on the horizon -- worse than no land at all. The
// module stays (the lake maths still shapes the sea bed), but nothing draws
// it; open water to the horizon is Abyssal's own far sea, which knows how to
// meet the sky.

// Two seas, one at a time. The lab's own is a single analytic shader built to
// iterate on the wake; Abyssal is an FFT sea with a volumetric sky, vendored
// whole (see abyssalSea.js) with every one of its wake and foam systems shut
// off. Kept side by side rather than swapped outright so the two can be
// compared on the same wake, in the same frame, without a reload -- which is
// the only way to tell whether a difference is the water or the wake.
let sea = null;
try {
  sea = new AbyssalSea(renderer);
} catch (e) {
  // A vendored sea that fails to build must not take the prototype with it:
  // the wake is the point, and the analytic ocean can still carry it.
  console.warn('Abyssal sea unavailable, falling back to the lab ocean:', e.message);
}
const useAbyssal = () => sea !== null && get('scene.abyssal') > 0.5;
// Our field, their water. This is the seam the whole swap hangs on.
const wakeBridge = sea ? new WakeBridge(renderer, wake) : null;
let sceneTuned = false;   // the default scene's tune is applied on frame one
if (sea) sea.setWake(wakeBridge);

// Only the analytic path owns a sky dome, a far sea and a water plane; Abyssal
// draws all three itself, around the scene rather than inside it.
const labSky = new THREE.Group();
labSky.add(backdrop.sky, backdrop.sea, ocean.mesh);
scene.add(labSky);

// The hull is a holder the chosen model is swapped into, so OceanBody keeps
// one object to pose and nothing downstream cares which boat is showing.
const boat = new THREE.Group();
const placeholder = makeBoat();
boat.add(placeholder);
scene.add(boat);

let shownModel = -1;
async function showBoat(i) {
  const idx = Math.round(i);
  if (idx === shownModel) return;
  shownModel = idx;
  // The last slot is the original placeholder: blocky, but the only hull whose
  // proportions were built to match the wake's own maths, so it stays the
  // reference to compare a loaded model against.
  if (idx >= BOATS.length) {
    boat.clear(); boat.add(placeholder);
    return;
  }
  try {
    const model = await loadBoat(BOATS[idx].id);
    if (shownModel !== idx) return;          // superseded while loading
    boat.clear(); boat.add(model);
  } catch (e) {
    // A model that fails to parse must not take the prototype with it: the
    // wake is the point, and the placeholder can carry it.
    console.warn(`boat "${BOATS[idx]?.id}" failed to load:`, e.message);
    boat.clear(); boat.add(placeholder);
  }
}
showBoat(get('boat.model'));

// The hull as an object that owns its own chain: how it sits, where it cuts,
// what it throws. main.js drives the helm and nothing else about it.
const spray = new Spray(3000);
scene.add(spray.points);
const body = new OceanBody(boat, { spray, seed: 7 });

// --------------------------------------------------------------- boat state --
// Position is the BOW: the arms are born there, so that is the anchor.
const state = { x: 0, z: 0, heading: 0, course: 0, t: 0, speed: 0, turn: 0 };

// --------------------------------------------------------------------- boot --
const hud = document.getElementById('hud');
const BACKEND = renderer.getContext() instanceof WebGL2RenderingContext ? 'webgl2' : 'webgl1';
const BUILD = 'b24';   // bumped on each publish, so a stale tab is obvious

function setView(mode) {
  if (mode === 'top') { view.topDown = true; view.pitch = -Math.PI / 2; view.yaw = 0; }
  if (mode === 'chase') { view.topDown = false; view.pitch = -0.42; view.yaw = 0; view.dist = 46; }
  if (mode === 'field') hud.dataset.field = hud.dataset.field === '1' ? '' : '1';
  syncViewButtons();
}

function syncViewButtons() {
  for (const b of hud.querySelectorAll('[data-view]')) {
    const m = b.dataset.view;
    b.classList.toggle('on', m === 'field' ? hud.dataset.field === '1'
                           : m === 'top' ? view.topDown : !view.topDown);
  }
}

for (const b of hud.querySelectorAll('[data-view]'))
  b.addEventListener('click', () => setView(b.dataset.view));

for (const b of hud.querySelectorAll('[data-zoom]'))
  b.addEventListener('click', () => zoomBy(b.dataset.zoom === 'in' ? 0.72 : 1.38));

// On a phone the rail covers most of the screen, so the canvas gets it first.
if (narrow) document.body.classList.add('rail-closed');

const chromeToggle = document.getElementById('chrome-toggle');
function setChrome(hidden) {
  document.body.classList.toggle('hide-ui', hidden);
  chromeToggle.textContent = hidden ? 'Show UI' : 'Hide UI';
  chromeToggle.setAttribute('aria-pressed', String(hidden));
}
chromeToggle.addEventListener('click', () => setChrome(!document.body.classList.contains('hide-ui')));

const railToggle = document.getElementById('rail-toggle');
railToggle?.addEventListener('click', () => {
  const closed = document.body.classList.toggle('rail-closed');
  railToggle.setAttribute('aria-expanded', String(!closed));
});
railToggle?.setAttribute('aria-expanded', String(!narrow));

// Cost defaults follow the device; both stay editable in the Performance group.
if (narrow || devicePixelRatio > 2.5) {
  set('quality.renderScale', 1);
  set('quality.oceanDetail', 260);
} else {
  set('quality.renderScale', Math.min(devicePixelRatio, 2));
}
// The two pickers sit above every slider, in their own box.
//
// Which boat and which weather are the first things anyone changes, and
// neither is a quantity -- there is no meaningful value between "Pirate" and
// "Yacht", or between "Calm Lake" and "Storm". A slider is the wrong control
// for both, and burying them among sixteen groups of real sliders is the
// wrong place.
// The refraction target: the scene photographed before the water draws, so
// the water can look through itself at the submerged half of the hull. Depth
// rides along -- it is what separates "topsides in front of the water" (skip;
// drawn again after) from "keel behind it" (composite, murked by depth).
let refrRT = null;
function ensureRefrRT(w, h) {
  if (refrRT && refrRT.width === w && refrRT.height === h) return;
  refrRT?.dispose();
  const depthTexture = new THREE.DepthTexture(w, h);
  refrRT = new THREE.WebGLRenderTarget(w, h, { depthTexture });
}

const uiRoot = document.getElementById('ui');
const quick = document.createElement('div');
quick.className = 'quick';
uiRoot.appendChild(quick);

const picker = buildBoatPicker(quick,
  [...BOATS.map((b) => ({ label: b.label })), { label: 'Blocky' }],
  {
    title: 'Boat',
    initial: Math.round(get('boat.model')),
    onPick: (i) => { set('boat.model', i); showBoat(i); },
  });

const scenePicker = buildBoatPicker(quick,
  PRESET_NAMES.map((n) => ({ label: n })),
  {
    title: 'Scene',
    initial: Math.round(get('scene.preset')),
    onPick: (i) => { set('scene.preset', i); },
  });

const ui = buildUI(uiRoot, {
  onChange: (path) => {
    if (path === '*' || path === 'boat.model') {
      const i = Math.round(get('boat.model'));
      showBoat(i);
      picker.select(i);          // keep the picker honest after a paste or reset
    }
    if (path === '*' || path === 'scene.preset') {
      scenePicker.select(Math.round(get('scene.preset')));
    }
    // Re-fit the drawn hull: both 'Hull length' and 'Model scale' feed the
    // target size, and the fit is where scale actually lives (an outer scale
    // on the holder is divided straight back out by this same call).
    for (const c of boat.children) c.userData?.scaleTo?.();
  },
});

// ------------------------------------------------------------------- camera --
// A set of shots, cycled with C, and nothing that moves discontinuously.
//
// Every quantity the camera is built from -- yaw, pitch, distance and the point
// it looks at -- is smoothed toward its target rather than assigned. That is
// what makes a turn feel like a camera following a boat instead of a rig bolted
// to it, and it means switching shots ANIMATES between them for free: the
// target changes, the smoothing carries the eye across, and there is no cut.
//
// The smoothing is exponential and frame-rate independent: 1 - exp(-dt/tau),
// not a fixed per-frame fraction. A fixed fraction ties the response to the
// frame rate, so the same camera drifts lazily at 30 fps and snaps at 120 --
// and this prototype's frame time swings hard whenever the field is re-baked.
//
// tau is the time constant in seconds: roughly, how long to cover two thirds of
// the remaining gap. Bigger is looser. The wide shots are tight because their
// geometry is what you are reading; the close ones are loose because at that
// range a tight camera transmits every twitch of the helm.
const CAMERAS = [
  { id: 'top',     label: 'Top-down',   pitch: -Math.PI / 2, dist: 155, yaw: 0,
    world: true,  lead: 0.00, tau: 0.30, lookTau: 0.30 },
  { id: 'chase',   label: 'Chase',      pitch: -0.42, dist: 78, yaw: 0,
    world: false, lead: 0.16, tau: 0.70, lookTau: 0.45 },
  { id: 'quarter', label: 'Quarter',    pitch: -0.20, dist: 52, yaw: 0.85,
    world: false, lead: 0.10, tau: 1.00, lookTau: 0.60 },
  { id: 'water',   label: 'Waterline',  pitch: -0.05, dist: 38, yaw: 2.10,
    world: false, lead: 0.04, tau: 1.30, lookTau: 0.80 },
  { id: 'free',    label: 'Free orbit', pitch: -0.55, dist: 130, yaw: 0,
    world: true,  lead: 0.00, tau: 0.18, lookTau: 0.18 },
];

let camIndex = 0;
const view = { pitch: CAMERAS[0].pitch, yaw: 0, dist: CAMERAS[0].dist,
               topDown: true, follow: true };

// Where the eye actually is, as opposed to where the shot says it should be.
const smooth = { yaw: 0, pitch: view.pitch, dist: view.dist,
                 look: new THREE.Vector3(), ready: false };

/** Frame-rate independent approach: covers 1-1/e of the gap every tau seconds. */
const approach = (cur, target, tau, dt) =>
  cur + (target - cur) * (1 - Math.exp(-dt / Math.max(tau, 1e-3)));

/**
 * The same, on a circle. A heading crossing +/-pi must take the short way
 * round: unwrapped, the camera swings 350 degrees to follow a 10 degree turn,
 * which reads as the whole world spinning rather than the boat turning.
 */
const approachAngle = (cur, target, tau, dt) => {
  const d = ((target - cur + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  return cur + d * (1 - Math.exp(-dt / Math.max(tau, 1e-3)));
};

function useCamera(i, { snap = false } = {}) {
  camIndex = ((i % CAMERAS.length) + CAMERAS.length) % CAMERAS.length;
  const c = CAMERAS[camIndex];
  view.pitch = c.pitch;
  view.dist = c.dist;
  view.yaw = c.yaw;
  view.topDown = c.id === 'top';
  if (snap) { smooth.ready = false; }
  const tag = document.getElementById('cam-name');
  if (tag) {
    tag.textContent = c.label;
    tag.classList.add('show');
    clearTimeout(useCamera._t);
    useCamera._t = setTimeout(() => tag.classList.remove('show'), 1400);
  }
  return c;
}

// Camera input. One pointer orbits, two pinch to zoom and twist the heading —
// on a phone there is no wheel, so pinch is the only way to get the whole wake
// in frame, and without it the view is stuck wherever it started.
const pointers = new Map();
let pinch = null;

const zoomBy = (f) => { view.dist = THREE.MathUtils.clamp(view.dist * f, 6, 1400); };

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  pinch = null;
});

canvas.addEventListener('pointermove', (e) => {
  const prev = pointers.get(e.pointerId);
  if (!prev) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (pointers.size === 1) {
    view.yaw -= (e.clientX - prev.x) * 0.005;
    view.pitch = THREE.MathUtils.clamp(view.pitch - (e.clientY - prev.y) * 0.005, -Math.PI / 2, -0.03);
    view.topDown = false;
    syncViewButtons();
  } else if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const span = Math.hypot(a.x - b.x, a.y - b.y);
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    if (pinch) {
      if (pinch.span > 1) zoomBy(pinch.span / Math.max(span, 1));
      let d = ang - pinch.ang;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      view.yaw += d;
    }
    pinch = { span, ang };
  }
});

const release = (e) => {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = null;
};
canvas.addEventListener('pointerup', release);
canvas.addEventListener('pointercancel', release);
addEventListener('pointerup', release);

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  zoomBy(Math.exp(e.deltaY * 0.0012));
}, { passive: false });

// Double-tap / double-click reframes, so a lost view is always one gesture away.
canvas.addEventListener('dblclick', () => setView('top'));

const keys = new Set();
const STEER_KEYS = new Set(['arrowleft', 'arrowright', 'arrowup', 'arrowdown']);

addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  keys.add(k);
  // Arrows would scroll the page out from under the canvas.
  if (STEER_KEYS.has(k)) e.preventDefault();
  if (k === 't') setView('top');
  if (k === 'h') setChrome(!document.body.classList.contains('hide-ui'));
  if (k === 'f') setView('field');
  // Shift+C steps back through the shots, so overshooting the one you wanted
  // does not mean going round the whole cycle again.
  if (k === 'c') useCamera(camIndex + (e.shiftKey ? -1 : 1));
});
addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));

// ----------------------------------------------------------------- wake view --
// A small inset showing the raw field texture, so it is obvious whether an odd
// look is coming from the wake maths or from the water shading.
const fieldScene = new THREE.Scene();
const fieldCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const fieldQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
  uniforms: { uTex: { value: wake.rt.texture } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy,0.0,1.0); }',
  fragmentShader: `
    varying vec2 vUv; uniform sampler2D uTex;
    void main(){
      vec4 t = texture2D(uTex, vUv);
      // white = surface foam, teal = subsurface bubbles, dim red = displacement
      vec3 c = vec3(clamp(t.r, 0.0, 1.5)) * 0.8;
      c += vec3(0.0, 0.55, 0.62) * clamp(t.a, 0.0, 1.5) * 0.75;
      c.r += clamp(abs(t.g) * 0.9, 0.0, 0.5) * 0.35;
      gl_FragColor = vec4(pow(c, vec3(0.85)), 1.0);
    }`,
}));
fieldScene.add(fieldQuad);

// The camera part of the URL overrides stays here, because `view` does not
// exist until further down.
for (const [k, v] of new URLSearchParams(location.search)) {
  if (k === 'cam') { const [p, y, d] = v.split(',').map(Number); view.pitch = p; view.yaw = y; view.dist = d; view.topDown = false; }
}
// The boat holder was filled before the overrides ran, so a ?boat.model= in
// the URL changed the number and left the old hull showing.
showBoat(get('boat.model'));

const viewport = { w: 1, h: 1 };   // CSS pixels

function resize() {
  const w = Math.max(innerWidth, 1), h = Math.max(innerHeight, 1);
  viewport.w = w; viewport.h = h;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  // Droplets are sized in METRES, so their pixel size depends on the viewport
  // and the field of view. Recomputing here keeps a droplet the same physical
  // size whatever the window does, instead of drifting with it.
  spray.setPixelScale(h * renderer.getPixelRatio(), camera.fov);
}
addEventListener('resize', resize);
resize();

// --------------------------------------------------------------------- loop --
let last = performance.now();
let fpsAcc = 0, fpsN = 0;
let lastScale = -1;

// Sim is stepped independently of rendering, so a slow (or headless) frame rate
// shortens the wake rather than silently rewinding the boat.
function stepSim(dt) {
  state.t += dt;

  // Up/down arrows work the throttle rather than setting a speed: they move the
  // target, the hull's own inertia does the rest, and the slider follows so the
  // panel never disagrees with the boat.
  const rate = get('boat.throttleRate') * dt;
  let throttle = 0;
  if (keys.has('arrowup')) throttle += rate;
  if (keys.has('arrowdown')) throttle -= rate;
  if (throttle !== 0) {
    const lim = PARAMS.boat.speed;
    set('boat.speed', Math.max(lim.min, Math.min(lim.max, get('boat.speed') + throttle)));
    ui.refresh();
  }

  let target = get('boat.speed');
  let turn = get('boat.turnRate') * Math.PI / 180;

  // Shore avoidance: look ahead, and if the water is running out, put the helm
  // over towards whichever side is deeper. Without it the boat simply drives up
  // the hillside, which is a strange thing for a lake to allow.
  const av = get('lake.avoid');
  if (av > 0.001) {
    const hx0 = Math.sin(state.heading), hz0 = Math.cos(state.heading);
    const reach = 70 + state.speed * 4;
    if (heightAt(state.x + hx0 * reach, state.z + hz0 * reach) > -2.0) {
      const a = 0.85;
      // Heading DECREASES for positive turn (see the helm note below), so this
      // is the side a positive turn actually takes the boat towards.
      const hp = state.heading - a, hn = state.heading + a;
      const dStar = heightAt(state.x + Math.sin(hp) * reach, state.z + Math.cos(hp) * reach);
      const dPort = heightAt(state.x + Math.sin(hn) * reach, state.z + Math.cos(hn) * reach);
      turn += (dStar < dPort ? 1 : -1) * get('boat.steerRate') * Math.PI / 180 * av;
    }
  }

  // The pond wall: assist steers along the rim like a thumb on the stick,
  // and the clamp in confine() is the soft bump when steering was not enough.
  // Heading rate is -turn (see the helm note below), so the assist enters
  // negated.
  if (park) turn -= park.confine(state, dt, get('boat.steerRate') * Math.PI / 180 * 1.3);
  if (shore) turn -= shore.confine(state, dt, get('boat.steerRate') * Math.PI / 180 * 1.3);

  const hard = keys.has('shift') ? get('boat.hardTurn') : 1;
  const steer = get('boat.steerRate') * Math.PI / 180 * hard;
  if (keys.has('arrowleft') || keys.has('a')) turn -= steer;
  if (keys.has('arrowright') || keys.has('d')) turn += steer;
  if (keys.has('w')) target *= 1.6;
  if (keys.has('s')) target *= 0.35;

  // The slider is a target, not the speed. A hull cannot step from rest to
  // planing in one frame, and if it does the wake it emits steps with it --
  // which is what puts a straight cut across the water behind.
  const a = get('boat.accel') * dt;
  state.speed += Math.sign(target - state.speed) * Math.min(a, Math.abs(target - state.speed));

  // Negated: the chase camera sits behind the hull, and in that view a rising
  // heading swings the bow toward +X, which is screen LEFT. So starboard helm
  // has to decrease heading -- and this makes a positive Turn slider mean
  // "to starboard" as well.
  //
  // Three things separate this from the sprite-pivot it used to be:
  //
  //  · the rudder BITES, it does not switch. The yaw rate eases toward the
  //    commanded one over ~0.35 s, so a tapped key nudges the bow instead of
  //    snapping it, and the bank spring downstream sees a ramp, not a step.
  //  · yaw authority scales with speed. A rudder is a wing in the propwash;
  //    with no water moving over it a boat cannot turn on the spot, however
  //    hard the wheel is over.
  //  · the COURSE lags the heading. When the bow comes round, the hull keeps
  //    carrying along its old track while the keel claws the velocity vector
  //    around -- which is why a real boat carves through a turn crabbed a few
  //    degrees bow-in, instead of rotating about its own axis like a compass
  //    needle. Movement runs on the course; only the mesh runs on the heading.
  const cmd = -turn;
  state.turn += (cmd - state.turn) * (1 - Math.exp(-dt / 0.35));
  const authority = THREE.MathUtils.smoothstep(state.speed, 0.4, 4.0);
  state.heading += state.turn * authority * dt;
  // Grip: how fast the keel pulls the track onto the heading. Low grip is a
  // skidding flat-bottom skiff; high grip is a deep-vee on rails.
  const gripTau = THREE.MathUtils.lerp(1.3, 0.12, get('boat.grip'));
  let dCourse = state.heading - state.course;
  dCourse = ((dCourse + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  state.course += dCourse * (1 - Math.exp(-dt / gripTau));
  // Cap the crab.
  //
  // The exponential chase alone has no bound: hard over at 20 m/s with a
  // slack keel the track lagged the heading by nearly half a second, which is
  // ten metres of clear water between the hull and the foam it is supposedly
  // throwing -- the boat visibly sliding off its own wake. A real hull skids
  // in a hard turn, but the slip angle stays modest; past that the keel bites.
  const crabMax = get('boat.crabMax') * Math.PI / 180;
  let crab = state.heading - state.course;
  crab = ((crab + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  if (Math.abs(crab) > crabMax) state.course = state.heading - Math.sign(crab) * crabMax;
  const hx = Math.sin(state.course), hz = Math.cos(state.course);
  state.x += hx * state.speed * dt;
  state.z += hz * state.speed * dt;
  // The BOW, not the simulated pivot. The field treats arc 0 as the stem and
  // carves the hull's footprint from there; anchoring it at the pivot while
  // the hull is drawn ahead of it opens a hull-shaped hole in the foam right
  // behind the transom.
  // The anchor sits at the BOW -- along the HEADING, because that is where
  // the hull geometrically is -- while the tangent is the COURSE, because
  // that is the way the water was actually swept.
  const bowAhead = body.bowOffset();
  const bhx = Math.sin(state.heading), bhz = Math.cos(state.heading);
  wake.pushSample(state.x + bhx * bowAhead, state.z + bhz * bowAhead,
                  hx, hz, state.t, state.speed, state.turn);
  // ...and where the hull ITSELF is, which is not the same thing the moment
  // the boat crabs: the sample is the track, this is the boat.
  wake.setHull(state.x + bhx * bowAhead, state.z + bhz * bowAhead, state.heading);

  return { hx, hz };
}

// ?prewarm=90 — run 90 seconds of boat before the first frame, so a capture (or
// a reload mid-tuning) starts with a full-length wake instead of a stub.
const PREWARM = +(new URLSearchParams(location.search).get('prewarm') ?? NaN) || window.__PREWARM || 0;
for (let i = 0; i < PREWARM * 30; i++) stepSim(1 / 30);

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;

  const { hx, hz } = stepSim(dt);
  // Sit the hull the way its speed says it should. The model's origin is at the
  // stem, so trimming about it would swing the bow instead of lifting it: the
  // rotation is compensated to hold a pivot near the aft quarter at the
  // waterline, which is roughly where a planing hull actually pivots.
  // The body carries the prototype's own state object, so the helm above and
  // everything below still read the same `state`.
  body.state = state;
  // Spray lands on the real surface, not on y = 0: with any swell at all a
  // flat waterline sinks droplets into crests and floats them over troughs.
  const seaH = useAbyssal() && sea ? (x, z) => sea.heightAt(x, z) : null;
  body.step(dt, seaH);
  spray.step(dt, seaH);
  const att = body.att;
  // Centre the field a little astern: that is where the wake actually is.
  // Zoomed in you cannot see the far wake anyway, and a smaller window puts far
  // more texels where you ARE looking -- at close range this is worth several
  // times the resolution. It costs nothing to change: the field is re-baked from
  // the path every frame, so there is no accumulated state to invalidate.
  const baseExtent = get('field.extent');
  const wantExtent = THREE.MathUtils.clamp(smooth.dist * 2.2, 45, baseExtent);
  const fieldExtent = THREE.MathUtils.lerp(baseExtent, wantExtent, get('field.adaptive'));
  // Astern along the PATH, not along the current course.
  //
  // The window is a circle of radius extent/2 (wakeAt gates on it), and
  // offsetting it down the course line is only "astern" while the boat is
  // going straight. Hard over, the wake curves away from that line and the
  // freshest foam -- the part right behind the hull -- fell outside the
  // circle and was cut off, which reads exactly as the wake coming unstuck
  // from the boat. The path knows where the wake went; ask it.
  const back = wake.backAlongPath(fieldExtent * 0.56);
  const fx = back ? (state.x + back.x) * 0.5 : state.x - hx * fieldExtent * 0.28;
  const fz = back ? (state.z + back.z) * 0.5 : state.z - hz * fieldExtent * 0.28;
  wake.focus(fx, fz, fieldExtent);
  wake.update(state.t);

  // Camera. Nothing here is assigned straight from state: every term is
  // smoothed toward its target, which is what stops a turn from snapping the
  // whole frame and what animates the cut when C changes shot.
  const shot = CAMERAS[camIndex];
  // A world-locked shot holds a fixed heading and does not swing with the boat.
  // Rotating the frame with the hull makes the boat look stationary and the sea
  // look like it is turning -- the opposite of what a turn should read as, and
  // it hides the very thing a turn is worth watching for.
  const targetYaw = shot.world ? view.yaw : state.heading + view.yaw;
  const lookTarget = new THREE.Vector3(
    state.x - hx * view.dist * shot.lead, 0, state.z - hz * view.dist * shot.lead);

  if (!smooth.ready) {
    // First frame, or straight after a snap: start ON the target rather than
    // sliding in from wherever the last shot left the eye.
    smooth.yaw = targetYaw; smooth.pitch = view.pitch; smooth.dist = view.dist;
    smooth.look.copy(lookTarget);
    smooth.ready = true;
  } else {
    smooth.yaw = approachAngle(smooth.yaw, targetYaw, shot.tau, dt);
    smooth.pitch = approach(smooth.pitch, view.pitch, shot.tau * 0.6, dt);
    smooth.dist = approach(smooth.dist, view.dist, shot.tau * 0.6, dt);
    const k = 1 - Math.exp(-dt / Math.max(shot.lookTau, 1e-3));
    smooth.look.lerp(lookTarget, k);
  }

  const cy = Math.sin(-smooth.pitch), cr = Math.cos(-smooth.pitch);
  const off = new THREE.Vector3(
    -Math.sin(smooth.yaw) * cr, cy, -Math.cos(smooth.yaw) * cr).multiplyScalar(smooth.dist);
  camera.position.copy(smooth.look).add(off);
  // Never let the eye sink under the sea: the waterline shot sits low enough
  // that a crest passing the camera would otherwise put it briefly underwater,
  // which reads as the picture glitching rather than as a wave.
  camera.position.y = Math.max(camera.position.y, 0.6);
  camera.up.set(0, 1, 0);
  camera.lookAt(smooth.look);

  const sd = new THREE.Vector3(
    Math.cos(get('ocean.sunElev') * Math.PI / 180) * Math.sin(get('ocean.sunAzim') * Math.PI / 180),
    Math.sin(get('ocean.sunElev') * Math.PI / 180),
    Math.cos(get('ocean.sunElev') * Math.PI / 180) * Math.cos(get('ocean.sunAzim') * Math.PI / 180),
  );
  sun.position.copy(sd).multiplyScalar(700).add(boat.position);
  // The shadow camera looks from the light AT the boat, so its frustum
  // follows what you are actually looking at rather than the world origin.
  sun.target.position.copy(boat.position);
  sun.target.updateMatrixWorld();
  sun.target.position.copy(boat.position);
  sun.target.updateMatrixWorld();

  renderer.toneMappingExposure = get('scene.meshExposure');
  const scale = Math.min(devicePixelRatio, get('quality.renderScale'));
  if (scale !== lastScale) { lastScale = scale; renderer.setPixelRatio(scale); resize(); }
  // Same trick as the wake field: close in, a smaller plane puts the vertices
  // where they are visible. Quantised to a few buckets so it rebuilds rarely.
  const wantPlane = THREE.MathUtils.clamp(smooth.dist * 6, 70, 520);
  const bucket = [80, 130, 200, 320, 520].find((b) => b >= wantPlane) ?? 520;
  const planeSize = THREE.MathUtils.lerp(520, bucket, get('field.adaptive'));
  ocean.setDetail(get('quality.oceanDetail'), Math.round(planeSize / 10) * 10);

  const abyssal = useAbyssal();
  labSky.visible = !abyssal;
  if (abyssal) {
    const want = PRESET_NAMES[Math.round(get('scene.preset')) % PRESET_NAMES.length];
    // `|| !sceneTuned`: setPreset is a no-op for the scene the sea was BUILT
    // with, so without this the default scene never received its tune and
    // whatever the sliders last saved beat the look the preset was given.
    if (sea.setPreset(want) || !sceneTuned) {
      sceneTuned = true;
      // A scene is a look, not just a spectrum: its curated water values land
      // in the same live params the sliders drive, so the panel agrees and
      // everything stays adjustable from where the scene put it.
      const t = SCENE_TUNE[want];
      if (t) {
        set('lake.floorDepth', t.floor);
        set('lake.caustics', t.caustics);
        set('lake.weed', t.weed);
        set('scene.waterTint', t.tint);
        set('scene.waterGlow', t.glow);
        // The scene owns the light: write its sun into the panel so the
        // Water & light sliders start from what the preset asked for and
        // adjust from there, rather than silently overriding it.
        const ap = PRESETS[want];
        if (ap) {
          // The scene tune may override the preset's sun: a preset authored
          // for open ocean at noon puts the light straight overhead, which
          // flattens rock and makes shallow water read as a lit pool. An
          // afternoon sun models the same geometry for free.
          const want2 = SCENE_TUNE[want];
          if (want2?.sun !== undefined) set('ocean.sunElev', want2.sun);
          else if (ap.sunElevation !== undefined) set('ocean.sunElev', ap.sunElevation);
          if (ap.sunAzimuth !== undefined) set('ocean.sunAzim', ap.sunAzimuth);
        }
        ui.refresh();
      }
    }
  }
  if (abyssal) {
    // One sun for the whole frame. Abyssal's atmosphere owns it, so the boat
    // and the terrain take their light from there rather than from the lab's
    // own sun slider, which is on a different scale entirely (see abyssalSea.js).
    // Exposure, live: the sea and sky tonemap themselves, so this is the one
    // knob that moves the whole water image at once.
    const ex = get('ocean.exposure');
    sea.water.exposure = ex;
    if (sea.sky) sea.sky.exposure = ex;
    const asd = sea.sunDirection();
    if (asd) {
      sd.set(asd[0], asd[1], asd[2]);
      sun.position.copy(sd).multiplyScalar(700).add(boat.position);
  // The shadow camera looks from the light AT the boat, so its frustum
  // follows what you are actually looking at rather than the world origin.
  sun.target.position.copy(boat.position);
  sun.target.updateMatrixWorld();
      sun.target.position.copy(boat.position);
      sun.target.updateMatrixWorld();
    }
    // ...and the sun's COLOUR and STRENGTH, not just where it is. A fixed
    // white directional at a fixed intensity is what left the hulls looking
    // like white plastic at golden hour: with the sun four degrees up, N.L is
    // near zero on every upward face and a flat blue-grey ambient was doing
    // nearly all the lighting.
    const sl = sea.sunLight();
    if (sl) {
      const gain = get('scene.meshSun');
      sun.color.setRGB(sl.colour[0], sl.colour[1], sl.colour[2]);
      // 2.2, down from 3.2: brighter is less saturated even without clipping,
      // because the tone curve compresses as it rises. 0.455 mean saturation
      // here against 0.432 at 3.2, and the hull still reads as sunlit.
      sun.intensity = sl.strength * gain * 2.2;
      // The sky fills in as the sun goes: at dusk it is most of the light
      // there is, which is why the ambient is floored rather than tracking
      // the sun to zero.
      ambient.intensity = sl.sky * gain * 0.9;
      // Water-bounce tracks the sky term: an overcast pond glows less.
      bounce.intensity = sl.sky * gain * 1.5;
    }
  }
  if (!abyssal) {
    ocean.update(state.t, camera.position, state.x, state.z, wake);
    backdrop.update(camera, sd, state.t);
  }

  renderer.setViewport(0, 0, viewport.w, viewport.h);
  renderer.setScissorTest(false);
  if (abyssal) {
    // Sea, scene, sky -- in that order, for the reasons in abyssalSea.js.
    sea.update(dt, camera);
    // Probe the hull's four corners AFTER the sim update, so the cascades the
    // probe samples are this frame's. The body consumed last frame's smoothed
    // reading in step() above -- one frame of latency by design; the fence
    // never stalls the pipeline.
    body.applyWaves(sea.probeWaves(body.corners(), dt), get('boat.buoy'));

    // Photograph the scene for the water to refract. Tone mapping off for the
    // photo: the water composites it into its own HDR and tonemaps once at
    // output -- through the mesh curve too it would be graded twice.
    let refr = null;
    if (get('scene.refraction') > 0.001) {
      const bw = renderer.domElement.width, bh = renderer.domElement.height;
      ensureRefrRT(bw, bh);
      const tm = renderer.toneMapping;
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.setRenderTarget(refrRT);
      renderer.clear(true, true, true);
      renderer.render(scene, camera);
      renderer.setRenderTarget(null);
      renderer.toneMapping = tm;
      const glc = renderer.getContext();
      const ct = renderer.properties.get(refrRT.texture)?.__webglTexture;
      const dtx = renderer.properties.get(refrRT.depthTexture)?.__webglTexture;
      if (ct && dtx) refr = {
        color: { target: glc.TEXTURE_2D, tex: ct },
        depth: { target: glc.TEXTURE_2D, tex: dtx },
        res: new Float32Array([bw, bh]),
        amount: get('scene.refraction') * 0.06,
        // Murk well under 1: the hull is METRES away through water that the
        // sea shader already colours -- full absorption on top of that erased
        // the keel a hand's width below the waterline.
        // Divided by clarity for the same reason the sea's absorption is:
        // the submerged half of a hull is seen through the same water as the
        // bottom, so one slider has to move both or they disagree.
        near: camera.near, far: camera.far, murk: 0.35 / Math.max(get('scene.clarity'), 0.05),
      };
    }
    // Tell the sea where the hull is, so the bed gets its shadow.
    //
    // The seafloor block already casts one -- it projects the hull's footprint
    // down the sun vector onto the bed -- but it is gated on uHullPush, and
    // nothing here had ever passed a hull, so the sea did not know a boat
    // existed and the bottom stayed evenly lit under it.
    //
    // push is deliberately tiny. It gates the shadow (a threshold) but SCALES
    // the surface displacement (hullLift multiplies by it), so a small value
    // buys the full shadow without Abyssal's own hull hollow fighting our
    // wake for the same water.
    const shadow = get('scene.hullShadow');
    const hull = shadow > 0.001 ? {
      pos: new Float32Array([boat.position.x, boat.position.y, boat.position.z]),
      fwd: new Float32Array([Math.sin(state.heading), Math.cos(state.heading)]),
      push: 0.02 * shadow,
      plane: 1,
    } : undefined;
    sea.render(scene, camera, { ...(refr ? { refr } : {}), ...(hull ? { hull } : {}) });
  } else {
    renderer.autoClear = true;
    renderer.render(scene, camera);
  }

  if (hud.dataset.field === '1') {
    const s = Math.round(Math.min(viewport.w, viewport.h) * 0.3);
    const m = 12;
    renderer.setScissorTest(true);
    renderer.setViewport(m, m, s, s);
    renderer.setScissor(m, m, s, s);
    renderer.render(fieldScene, fieldCam);
    renderer.setScissorTest(false);
  }

  fpsAcc += 1 / Math.max(dt, 1e-4); fpsN++;
  if (fpsN >= 30) {
    // Backend and build, next to the frame rate.
    //
    // "Is this a WebGPU thing?" is a fair question to ask of a water sim, and
    // it should be answerable without reading source: this app is WebGL2 only
    // -- three's WebGLRenderer plus a hand-written WebGL2 ocean sharing the
    // same context -- and there is no WebGPU path to switch to. The build
    // stamp is here for the other half of that question: whether the page you
    // are looking at is the one that was just published, or a cached one.
    hud.querySelector('#fps').textContent =
      `${Math.round(fpsAcc / fpsN)} fps · ${BACKEND} · ${BUILD}`;
    fpsAcc = 0; fpsN = 0;
  }
  window.__ready = true;
}
requestAnimationFrame(frame);

// Expose for the headless capture harness.
window.__wake = { PARAMS, set, get, state, view, renderer, wake, ocean, stepSim, sea, wakeBridge, body, spray };
