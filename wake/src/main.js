import * as THREE from 'three';
import { PARAMS, get, set } from './params.js';
import { WakeField } from './wakeField.js';
import { SurfaceState } from './surfaceState.js';
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
import { Bubbles } from './bubbles.js';
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

// ENVIRONMENT LIGHTING.
//
// The scene had a sun, a flat ambient and a bounce, and that is enough to
// light a shape but not to make a MATERIAL look real: a PBR surface wants to
// see a whole sky, because what sells wet rock or a painted hull is the
// gradient it reflects, not the single highlight. This is the HDRI step from
// Nathan Pointer's landscape write-up, done without an HDRI: the environment
// is drawn here, as an equirectangular strip -- sky above, sun-warmed haze at
// the horizon, lagoon cyan below -- and run through PMREM so three can use it
// for image-based lighting.
//
// Painting it rather than downloading one has a real advantage beyond the
// bytes: it is built from the SAME sun the sea and the boats use, so when the
// scene changes weather the reflections change with it, which a fixed HDRI
// could never do.
function buildEnvironment(sunDir, sunCol, skyLift) {
  const W = 256, H = 128;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  const img = g.createImageData(W, H);
  const el = Math.max(sunDir?.y ?? 0.6, 0.02);
  for (let y = 0; y < H; y++) {
    // v = 0 at the zenith, 1 at nadir.
    const v = y / (H - 1);
    const up = Math.cos(v * Math.PI);
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      let r, gg, b;
      if (up > 0) {
        // Sky: deeper overhead, paler toward the horizon, which is the
        // gradient that makes a curved surface read as curved.
        const t = Math.pow(up, 0.6);
        r = 0.36 + (0.10 - 0.36) * t;
        gg = 0.56 + (0.28 - 0.56) * t;
        b = 0.82 + (0.62 - 0.82) * t;
      } else {
        // Below the horizon is water, and it is bright: a hull floating on a
        // lagoon is lit from underneath nearly as much as from above.
        const t = Math.pow(-up, 0.7);
        r = 0.30 + (0.16 - 0.30) * t;
        gg = 0.58 + (0.46 - 0.58) * t;
        b = 0.62 + (0.52 - 0.62) * t;
      }
      // The sun's own glow, wide and soft: a hard disc in an env map produces
      // a hard reflection, and at this resolution it would alias badly.
      const azi = (x / W) * Math.PI * 2;
      const sunAzi = Math.atan2(sunDir?.x ?? 0, sunDir?.z ?? 1) + Math.PI;
      let dAzi = Math.abs(((azi - sunAzi + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      const dEl = Math.abs(Math.acos(Math.max(-1, Math.min(1, up))) - Math.acos(Math.min(1, el)));
      const glow = Math.exp(-(dAzi * dAzi + dEl * dEl) * 3.2) * 1.6 * skyLift;
      r += (sunCol?.[0] ?? 1) * glow;
      gg += (sunCol?.[1] ?? 1) * glow;
      b += (sunCol?.[2] ?? 0.9) * glow;
      img.data[i] = Math.min(255, r * 255);
      img.data[i + 1] = Math.min(255, gg * 255);
      img.data[i + 2] = Math.min(255, b * 255);
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.Texture(cv);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromEquirectangular(tex).texture;
  pmrem.dispose();
  tex.dispose();
  return env;
}
let envTex = null;
let envStamp = '';

// FAR PLANE 3000 -> 60000, and this is what put a grey band at the horizon.
//
// The water grid runs out to rMax (42 km) and its outermost ring is PINNED to
// the sightline tangent, which is what makes the sea meet the horizon exactly.
// Both of those sit far outside a 3 km far plane, so they were clipped away and
// never drawn: the sea simply stopped at 3 km, and above that the sky pass drew
// its own below-horizon limb into the gap. Measured from a 155 m eye, water at
// 3 km lands at -2.96 deg while the geometric horizon is at -0.40 deg, which is
// two and a half degrees of grey -- and it grows as the camera climbs, which is
// exactly when it was reported.
//
// It is also why raising rMax did nothing: the far plane clipped first.
//
// Depth precision is fine. Almost all of it lives near the NEAR plane, which is
// untouched at 0.5 m: a 24-bit buffer still resolves about 12 microns at ten
// metres and about a metre at three kilometres, which is open sea.
const camera = new THREE.PerspectiveCamera(38, 1, 0.5, 60000);

// The Kelvin waves are the finest thing the field has to carry, and at 1024
// over a 340 m window (~0.33 m/texel) their cusp lines visibly stair-step.
// 2048 fixes it, at 4x the memory -- so phones keep the smaller one.
const narrow = matchMedia('(max-width: 720px)').matches;
const wake = new WakeField(renderer, narrow ? 1024 : 2048);
// What the water KEEPS. The field above is re-derived every frame; this is
// only ever added to and faded, so foam laid on the water stays where it was
// laid whatever the boat does next. See surfaceState.js.
const surface = new SurfaceState(renderer, wake, 1024);
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

// REBUILDABLE, because the sliders were doing nothing.
//
// "Built once at startup" was right about the cost and wrong about the
// consequence: bay radius, ruggedness, relief, pines and boulders all feed
// geometry that is baked in the constructor, so moving any of them changed a
// number nobody ever read again. A coast is not an effect and should not be
// rebuilt per frame -- but it does have to be rebuilt when the thing that
// defines it changes, which is what this does, and only for those paths.
let shore = null;
function buildShore() {
  if (shore) {
    scene.remove(shore.group);
    shore.group.traverse((o) => {
      o.geometry?.dispose?.();
      const m = o.material;
      if (Array.isArray(m)) m.forEach((x) => x.dispose?.()); else m?.dispose?.();
    });
    shore = null;
  }
  // CLEARED BEFORE THE EARLY RETURN, not after it.
  //
  // The water reads the coast through a baked height map. Sitting below the
  // return, this line ran only when a shore was BUILT -- so switching the shore
  // off tore down the mesh and left the sea still reading the map of a coast
  // that no longer existed. Its extent is a square, 3.4 bay radii on a side, so
  // from above it showed as a pale diamond of wrongly shallow water with the
  // real sea around it: the map's own edge, drawn.
  if (get('shore.on') <= 0.5) return;
  shore = new Shore({ bay: get('shore.bay'), rugged: get('shore.rugged'),
    boulders: Math.round(get('shore.boulders')) });
  scene.add(shore.group);
}
buildShore();
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
// The bridge hands the water the surface state's texture beside the field's.
if (wakeBridge) wakeBridge.surface = surface;
let sceneTuned = false;   // the default scene's tune is applied on frame one
// Declared with the shore itself, above: buildShore() clears it, and that
// call happens long before this point in the file.
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
// The hull's ACTUAL drawn extent, measured off the model rather than inferred.
//
// Everything downstream needs to know where the transom is, and the arithmetic
// answer -- boat.length x Model scale -- is only as good as the assumption that
// the fit landed exactly on it. That assumption is fine for the GLBs, whose
// scaleTo() normalises them to precisely that length, and it is NOT fine for
// the blocky placeholder, which is built to its own proportions and never went
// through the fit. Measuring is one Box3 per model change and cannot be wrong.
//
// Cached because it only moves when the model or its scale does; recomputed
// from the same onChange that re-runs scaleTo.
const hullSpan = { len: 9.9, stern: 9.9, beam: 2.6, height: 2.0 };
const _hullBox = new THREE.Box3();
function measureHull() {
  if (!boat.children.length) return;
  // In the boat group's own frame: the model sits under it with its origin at
  // the stem and +Z forward, so minZ is the transom.
  boat.updateWorldMatrix(false, true);
  const q = boat.quaternion.clone(), pos = boat.position.clone();
  boat.quaternion.identity(); boat.position.set(0, 0, 0);
  boat.updateWorldMatrix(false, true);
  _hullBox.setFromObject(boat);
  boat.quaternion.copy(q); boat.position.copy(pos);
  boat.updateWorldMatrix(false, true);
  if (!isFinite(_hullBox.min.z) || _hullBox.isEmpty()) return;
  hullSpan.len = Math.max(_hullBox.max.z - _hullBox.min.z, 0.5);
  // How far aft of the origin the transom actually is. For a fitted GLB this
  // is the hull length; for anything whose origin is not at the stem it is not,
  // and that difference is exactly what puts a wake off the back of a boat.
  hullSpan.stern = Math.max(-_hullBox.min.z, 0.5);
  // Across and up as well, for anything that needs the hull's real shape
  // rather than just how long it is -- the reflection proxy above all.
  hullSpan.beam = Math.max(_hullBox.max.x - _hullBox.min.x, 0.3);
  hullSpan.height = Math.max(_hullBox.max.y - _hullBox.min.y, 0.3);
  measureStations();
}

// ---------------------------------------------------------------------------
// WHERE THE HULL ACTUALLY IS, station by station.
//
// Everything that needed to know where the boat meets the water has so far
// asked a formula: a half-width curve for the spray cuts, and a keel line
// solved from the trim angle for the wake's anchor. Both are centreline
// arithmetic on a hull shape nobody measured, and neither has ever looked at
// the mesh -- which is why the wake started ahead of a bow that was out of the
// water, and why nothing about it changed when she heeled into a turn.
//
// So: sample the real geometry once per model into stations along her length.
// For each station, the lowest point (the keel there) and how far outboard the
// hull reaches down at that depth (the chine). That is enough to ask, every
// frame and under any attitude, which parts of her are actually wet.
const HULL_STATIONS = 28;
const hullStations = [];

function measureStations() {

  hullStations.length = 0;
  const zMin = _hullBox.min.z, zMax = _hullBox.max.z;
  const span = Math.max(zMax - zMin, 1e-3);
  const keel = new Float32Array(HULL_STATIONS).fill(Infinity);
  const half = new Float32Array(HULL_STATIONS);
  // Vertices in the BOAT GROUP's frame, with its own transform neutralised --
  // the same frame the box above was taken in, so the two agree.
  const q = boat.quaternion.clone(), pos = boat.position.clone();
  boat.quaternion.identity(); boat.position.set(0, 0, 0);
  boat.updateWorldMatrix(false, true);
  const inv = new THREE.Matrix4().copy(boat.matrixWorld).invert();
  const v = new THREE.Vector3(), m = new THREE.Matrix4();
  boat.traverse((o) => {
    const g = o.isMesh && o.geometry?.attributes?.position;
    if (!g) return;
    m.multiplyMatrices(inv, o.matrixWorld);
    for (let i = 0; i < g.count; i++) {
      v.fromBufferAttribute(g, i).applyMatrix4(m);
      const t = (v.z - zMin) / span;
      const k = Math.min(HULL_STATIONS - 1, Math.max(0, Math.floor(t * HULL_STATIONS)));
      if (v.y < keel[k]) keel[k] = v.y;
    }
  });
  // Second pass for the half-width, now that each station's keel is known:
  // only vertices in the bottom third of that station count, so a railing or a
  // flybridge overhang cannot report itself as the chine.
  boat.traverse((o) => {
    const g = o.isMesh && o.geometry?.attributes?.position;
    if (!g) return;
    m.multiplyMatrices(inv, o.matrixWorld);
    for (let i = 0; i < g.count; i++) {
      v.fromBufferAttribute(g, i).applyMatrix4(m);
      const t = (v.z - zMin) / span;
      const k = Math.min(HULL_STATIONS - 1, Math.max(0, Math.floor(t * HULL_STATIONS)));
      if (!isFinite(keel[k])) continue;
      if (v.y > keel[k] + hullSpan.height * 0.33) continue;
      const a = Math.abs(v.x);
      if (a > half[k]) half[k] = a;
    }
  });
  boat.quaternion.copy(q); boat.position.copy(pos);
  boat.updateWorldMatrix(false, true);
  for (let k = 0; k < HULL_STATIONS; k++) {
    if (!isFinite(keel[k])) continue;
    hullStations.push({
      z: zMin + (k + 0.5) / HULL_STATIONS * span,
      keel: keel[k],
      half: half[k],
    });
  }
  // Bow first, so "the forward-most wet station" is a walk from the front.
  hullStations.sort((a, b) => b.z - a.z);

}

// The live waterline: which stations are wet, and where the hull first cuts in.
//
// Each station's chine points are carried through the boat's ACTUAL world
// matrix -- so pitch, heel and heave are all in it for free, and none of it has
// to be re-derived from the trim angle. Heeled into a turn the outboard chine
// goes under while the inboard one lifts, and the two sides report different
// entry points, which is exactly the asymmetry a turning hull has and the old
// centreline solve could not represent at all.
const _stnV = new THREE.Vector3();
const waterline = { cuts: [], entry: 0, port: 0, star: 0, wet: 0 };

function updateWaterline(seaY) {

  waterline.cuts.length = 0;
  waterline.entry = waterline.port = waterline.star = 0;
  waterline.wet = 0;
  if (!hullStations.length) return waterline;
  boat.updateWorldMatrix(false, false);
  const stem = hullStations[0].z;
  let firstP = null, firstS = null;
  for (const st of hullStations) {
    // Both chines at the keel's depth. A vee hull's widest wetted point at a
    // station is where the bottom meets the topsides, and that is what cuts.
    for (let side = -1; side <= 1; side += 2) {
      _stnV.set(side * st.half, st.keel, st.z).applyMatrix4(boat.matrixWorld);
      if (_stnV.y > seaY) continue;
      waterline.wet++;
      // Metres aft of the stem, along the hull -- the same measure the wake's
      // anchor and the spray cuts are written in.
      const aft = stem - st.z;
      if (side < 0 && firstP === null) firstP = aft;
      if (side > 0 && firstS === null) firstS = aft;
      // Reported at the SURFACE, not at the keel: the cut is where the hull
      // passes through the water, and that is what a marker should stand on.
      // With how far aft it is and which side, for the surface sim: the bow
      // and the quarter make different white, and the two sides differ in a
      // turn.
      waterline.cuts.push(_stnV.x, seaY, _stnV.z, aft, side);
    }
  }
  waterline.port = firstP ?? 0;
  waterline.star = firstS ?? 0;
  // The wake starts where the hull FIRST touches, whichever side that is: one
  // chine down in a turn is still a hull cutting water, and waiting for both
  // would put the wake astern of the side doing the work.
  waterline.entry = firstP === null ? (firstS ?? 0)
                  : firstS === null ? firstP : Math.min(firstP, firstS);
  return waterline;

}

async function showBoat(i) {
  const idx = Math.round(i);
  if (idx === shownModel) return;
  shownModel = idx;
  // The last slot is the original placeholder: blocky, but the only hull whose
  // proportions were built to match the wake's own maths, so it stays the
  // reference to compare a loaded model against.
  if (idx >= BOATS.length) {
    boat.clear(); boat.add(placeholder);
    measureHull();
    return;
  }
  try {
    const model = await loadBoat(BOATS[idx].id);
    if (shownModel !== idx) return;          // superseded while loading
    boat.clear(); boat.add(model);
    measureHull();
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
// In the SCENE, because the refraction pass photographs the scene -- that is
// how these get under the water instead of on top of it.
// Sized for the worst case the sliders allow: 2400 a second against a climb of
// a couple of seconds. Under-size the pool and emission starts cannibalising
// live bubbles, which shows as holes in the densest part of the plume.
// EMITTER MARKERS -- where the sim thinks each source of water is.
//
// Every one of these is a world position the code computes and then trusts. A
// marker turns that trust into something falsifiable: if the bubble source is
// drawn ten metres astern of the transom, the arithmetic is answering a
// different question from the one being asked, and no amount of re-deriving it
// on paper will show that.
//
// depthTest off, so they read THROUGH the hull and the water -- the whole point
// is to see a source that is hidden inside or beneath something.
// Enough for every station's two chines (28 x 2) plus the dozen fixed markers.
// mark() drops anything past the cap silently, and a waterline that quietly
// stops halfway down the hull is worse than no debug view at all.
const DEBUG_MARKS = 160;
const debugMarks = (() => {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(DEBUG_MARKS * 3), 3));
  g.setAttribute('aCol', new THREE.BufferAttribute(new Float32Array(DEBUG_MARKS * 3), 3));
  g.setDrawRange(0, 0);
  const m = new THREE.ShaderMaterial({
    transparent: true, depthTest: false, depthWrite: false,
    uniforms: { uScale: { value: 600 } },
    vertexShader: [
      'attribute vec3 aCol; varying vec3 vCol; uniform float uScale;',
      'void main(){ vCol = aCol;',
      '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
      '  gl_Position = projectionMatrix * mv;',
      '  gl_PointSize = clamp(uScale * 0.55 / max(-mv.z, 0.1), 6.0, 44.0); }',
    ].join('\n'),
    fragmentShader: [
      'precision highp float; varying vec3 vCol;',
      'void main(){',
      '  vec2 q = gl_PointCoord * 2.0 - 1.0;',
      '  float d = dot(q, q);',
      '  if (d > 1.0) discard;',
      '  float ring = smoothstep(0.30, 0.72, d) * (1.0 - smoothstep(0.86, 1.0, d));',
      '  gl_FragColor = vec4(vCol, ring * 0.95 + 0.12); }',
    ].join('\n'),
  });
  const pts = new THREE.Points(g, m);
  pts.frustumCulled = false;
  pts.renderOrder = 999;
  return pts;
})();
scene.add(debugMarks);
let _markN = 0;
function mark(x, y, z, r, gg, b) {
  if (_markN >= DEBUG_MARKS) return;
  const p = debugMarks.geometry.attributes.position.array;
  const c = debugMarks.geometry.attributes.aCol.array;
  p[_markN * 3] = x; p[_markN * 3 + 1] = y; p[_markN * 3 + 2] = z;
  c[_markN * 3] = r; c[_markN * 3 + 1] = gg; c[_markN * 3 + 2] = b;
  _markN++;
}

const bubbles = new Bubbles(9000);
scene.add(bubbles.points);
let _bubDebt = 0;
// Where the surface is, for releasing and popping bubbles.
//
// MEAN SEA LEVEL, deliberately, and not sea.heightAt(): that is a stub which
// forwards to a water.heightAt that does not exist and returns 0 for every
// point -- it is what made an earlier choppiness measurement read as a dead
// flat ocean at every setting. Passing it here would look like it tracked the
// swell while doing nothing of the sort. The real reader is the GPU probe, and
// its 64 slots are already spoken for by the hull and the rocks. Bubbles live a
// metre or two down and pop within a wave height of the top, so mean level is
// honest at the scale that matters; a fixed value that is right on average
// beats a function that is wrong everywhere.
const BUB_SURFACE = () => 0;
// SPRAY IS NOT IN THE MAIN SCENE, and that is a render-order fix, not a
// preference.
//
// The order is water -> scene -> sky, and the sky is one triangle at the far
// plane drawn under LEQUAL writing no depth, so the expensive cloud march only
// runs where nothing has covered it. Droplets are drawn with depthWrite off --
// deliberately, so they do not occlude each other and cut hard rims into one
// another -- which means a droplet thrown above the horizon leaves the depth
// buffer at the far plane exactly where it is. The sky then passes LEQUAL there
// and paints straight over it. Spray simply vanished the moment it crossed the
// skyline, which is where a curtain of it is most visible.
//
// Drawn in its own pass after the sea, against the depth buffer everything else
// just wrote, so the hull and the water still occlude it and the sky no longer
// can. It is also out of the refraction photograph now, which is right: water
// in the air is not something the surface should be refracting.
const sprayScene = new THREE.Scene();
sprayScene.add(spray.points);
const body = new OceanBody(boat, { spray, seed: 7 });

// --------------------------------------------------------------- boat state --
// Position is the BOW: the arms are born there, so that is the anchor.
const state = { x: 0, z: 0, heading: 0, course: 0, t: 0, speed: 0, turn: 0 };

// --------------------------------------------------------------------- boot --
const hud = document.getElementById('hud');
const BACKEND = renderer.getContext() instanceof WebGL2RenderingContext ? 'webgl2' : 'webgl1';
const BUILD = 'c17';   // bumped on each publish, so a stale tab is obvious

function setView(mode) {
  if (mode === 'top') { view.topDown = true; view.pitch = -Math.PI / 2; view.yaw = 0; }
  if (mode === 'chase') { view.topDown = false; view.pitch = -0.42; view.yaw = 0; view.dist = 46; }
  if (mode === 'field') hud.dataset.field = hud.dataset.field === '1' ? '' : '1';
  // A view you flick on and off while watching something move wants a button,
  // not a slider buried in a panel -- the whole point of it is to be compared
  // against the lit sea a second later.
  if (mode === 'waves') set('scene.waveDebug', get('scene.waveDebug') > 0.5 ? 0 : 1);
  // WHERE EVERY EMITTER ACTUALLY IS, drawn as markers on top of the scene.
  //
  // Arithmetic said the bubble emitter was at the transom to the centimetre and
  // it has now looked wrong twice, which means the arithmetic is answering a
  // different question from the one being asked. A marker cannot be argued
  // with: it is either on the back of the boat or it is not.
  if (mode === 'emit') set('scene.debugEmit', get('scene.debugEmit') > 0.5 ? 0 : 1);
  syncViewButtons();
}

function syncViewButtons() {
  for (const b of hud.querySelectorAll('[data-view]')) {
    const m = b.dataset.view;
    b.classList.toggle('on', m === 'field' ? hud.dataset.field === '1'
                           : m === 'waves' ? get('scene.waveDebug') > 0.5
                           : m === 'emit' ? get('scene.debugEmit') > 0.5
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
// ---------------------------------------------------------------- reflection --
//
// The scene rendered a second time from a camera mirrored through the water
// plane. This is what puts the actual boat -- masts, superstructure, the dark
// hull against white topsides -- into the water, where the ray-ellipsoid proxy
// can only ever manage a boat-shaped smear.
//
// Half resolution by default and worth every pixel saved: this is a full extra
// draw of the scene, the same cost the refraction pass was measured at. A
// reflection is a mirror image seen through a moving surface; it is the least
// resolution-critical thing in the frame.
let reflRT = null;
const reflCam = new THREE.PerspectiveCamera();
const _reflMat = new THREE.Matrix4();
// Projects a world point into the reflection target's 0..1 texture space.
// The half-scale-and-bias turns clip space into UV.
// Scratch for the refraction buffer's clear colour, and the renderer's own,
// saved so the main pass is handed back exactly what it had.
const _refrClear = new THREE.Color();
const _clearWas = new THREE.Color();
let _clearWasA = 1;
const _reflBias = new THREE.Matrix4().set(
  0.5, 0, 0, 0.5,
  0, 0.5, 0, 0.5,
  0, 0, 0.5, 0.5,
  0, 0, 0, 1);
const _clipPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

function ensureReflRT(w, h) {
  if (reflRT && reflRT.width === w && reflRT.height === h) return;
  reflRT?.dispose();
  reflRT = new THREE.WebGLRenderTarget(w, h);
  // MIPMAPPED, so the reflection can be blurred by sampling a coarser level
  // rather than by taking many taps. One trilinear fetch at a chosen level
  // costs the same as a sharp one; a blur kernel wide enough to look like wet
  // glass would be dozens of taps per pixel across the whole sea.
  //
  // It also fixes a second thing for free: a sharp reflection minified into the
  // distance aliases badly, crawling as the boat moves. Mip levels are exactly
  // the fix for that, and this pass had none.
  reflRT.texture.minFilter = THREE.LinearMipmapLinearFilter;
  reflRT.texture.magFilter = THREE.LinearFilter;
  reflRT.texture.generateMipmaps = true;
}

/**
 * Render the mirrored view and hand back what the water needs to sample it.
 *
 * `seaY` is the water plane. Everything below it is clipped away: the mirrored
 * camera sits under the sea looking up, so without a clip the submerged half of
 * the hull is reflected too and the boat gets a second keel growing out of its
 * waterline.
 */
function renderReflection(seaY) {
  const amt = get('scene.planarRefl');
  if (amt <= 0.001) return null;
  const bw = renderer.domElement.width, bh = renderer.domElement.height;
  const k = Math.max(0.2, Math.min(1, get('scene.planarScale')));
  ensureReflRT(Math.max(2, Math.round(bw * k)), Math.max(2, Math.round(bh * k)));

  // Mirror the camera through y = seaY. Reflecting the position is one
  // subtraction; reflecting the ORIENTATION is the part that is easy to get
  // wrong -- negate the Y of the forward and up vectors and look from there,
  // which flips pitch while leaving yaw and roll alone.
  camera.updateMatrixWorld();
  const p = camera.position;
  reflCam.copy(camera);
  reflCam.position.set(p.x, 2 * seaY - p.y, p.z);
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
  fwd.y *= -1; up.y *= -1;
  reflCam.up.copy(up);
  reflCam.lookAt(reflCam.position.clone().add(fwd));
  reflCam.updateMatrixWorld();
  reflCam.updateProjectionMatrix();

  _reflMat.copy(_reflBias)
    .multiply(reflCam.projectionMatrix)
    .multiply(reflCam.matrixWorldInverse);

  _clipPlane.constant = -seaY + 0.02;
  const oldPlanes = renderer.clippingPlanes;
  const oldAlpha = renderer.getClearAlpha();
  renderer.clippingPlanes = [_clipPlane];
  renderer.setRenderTarget(reflRT);
  // Transparent clear: alpha is the coverage mask the shader blends on, so
  // "no geometry here" has to be distinguishable from "geometry that happens
  // to be black". Without it the pass paints a dim rectangle over the sea.
  renderer.setClearAlpha(0);
  renderer.clear(true, true, true);
  renderer.render(scene, reflCam);
  renderer.setRenderTarget(null);
  renderer.setClearAlpha(oldAlpha);
  renderer.clippingPlanes = oldPlanes;

  const glc = renderer.getContext();
  const ct = renderer.properties.get(reflRT.texture)?.__webglTexture;
  if (!ct) return null;
  // Build the chain EXPLICITLY rather than trusting the renderer to have done
  // it on unbind. Whether that happens depends on three's internal bookkeeping
  // for this target, and a missing chain does not error -- it silently samples
  // level 0 at every LOD, so the blur slider would do nothing at all and look
  // like the shader was ignoring it.
  glc.bindTexture(glc.TEXTURE_2D, ct);
  glc.generateMipmap(glc.TEXTURE_2D);
  glc.bindTexture(glc.TEXTURE_2D, null);
  // How many levels there actually are, so the shader's blur can run to the top
  // of the chain and no further -- past it, the LOD clamps and the control
  // stops responding partway along its travel.
  const levels = Math.floor(Math.log2(Math.max(reflRT.width, reflRT.height)));
  return {
    color: { target: glc.TEXTURE_2D, tex: ct },
    matrix: new Float32Array(_reflMat.elements),
    amount: amt,
    distort: get('scene.planarDistort') * 0.02,
    blur: get('scene.planarBlur'),
    maxLod: Math.max(levels, 1),
    // Where the reflection starts, so the fade can run outward from the boat
    // rather than from the eye. Without this the fade would measure from the
    // world origin, which is a fixed point the boat drives away from.
    origin: new Float32Array([boat.position.x, boat.position.z]),
    fade: get('scene.planarFade'),
    opacity: get('scene.planarOpacity'),
  };
}

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
    // The wave-motion button and the slider are two handles on one value, so
    // moving either has to light the other -- including a wholesale paste.
    if (path === '*' || path === 'scene.waveDebug'
      || path === 'scene.debugEmit') syncViewButtons();
    // Re-fit the drawn hull: both 'Hull length' and 'Model scale' feed the
    // target size, and the fit is where scale actually lives (an outer scale
    // on the holder is divided straight back out by this same call).
    //
    // GATED ON THE PATHS THAT ACTUALLY FEED IT. This used to run on EVERY
    // parameter change, so moving any slider in the panel -- bed distortion,
    // cloud cover, anything -- re-seated and re-scaled the hull. The fit
    // re-normalises to the target length and re-seats the model on its
    // waterline, so the boat visibly jumped and changed size for a frame, which
    // reads exactly like the buoyancy being disturbed by an unrelated control.
    // Nothing outside these paths changes the drawn size of a hull.
    if (path === '*' || path === 'boat.model'
      || path === 'boat.length' || path === 'boat.modelScale') {
      for (const c of boat.children) c.userData?.scaleTo?.();
      measureHull();
      // Re-frame with it. Changing the size of the boat is exactly the moment
      // the shot distance should follow, and the smoothing means it eases out
      // rather than cutting. A wheel-zoom afterwards still overrides it.
      view.dist = CAMERAS[camIndex].dist * hullScale();
    }
    // The coast is geometry, baked in its constructor. These are the paths that
    // change that geometry, so these are the paths that have to rebuild it.
    if (path === '*' || path === 'shore.on' || path === 'shore.bay'
      || path === 'shore.rugged' || path === 'shore.boulders') {
      buildShore();
    }
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

// Shot distances are quoted for a 9.9 m launch, which is what every one of
// them was framed against. A hull three and a half times that long -- the
// pirate at Model scale 3.5 -- sits three and a half times closer in frame, so
// the Waterline shot ends up against the transom instead of off the beam and
// reads as "the side view is looking at the back of the boat". Distance in
// HULL LENGTHS, and every shot frames the same picture whatever is drawn.
const REFERENCE_HULL = 9.9;
const hullScale = () => Math.max(0.35,
  get('boat.length') * Math.max(get('boat.modelScale'), 0.05) / REFERENCE_HULL);

function useCamera(i, { snap = false } = {}) {
  camIndex = ((i % CAMERAS.length) + CAMERAS.length) % CAMERAS.length;
  const c = CAMERAS[camIndex];
  view.pitch = c.pitch;
  view.dist = c.dist * hullScale();
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

// ---------------------------------------------------------------- painting --
// Foam straight onto the water, by hand.
//
// The surface sim is the thing that decides how foam LIVES -- how it fades,
// how air surfaces into it, how new white thins into residue -- and until now
// the only way to put anything on it was to drive the boat, which ties every
// look decision to the hull's sources. A brush cuts that knot: lay some down,
// watch what it does, tune the sim, and only then ask whether the boat is
// feeding it the right amounts.
//
// It is a mode. While it is on, a drag paints instead of orbiting, and the
// strokes are queued here and laid into the sim once per frame, dt-scaled like
// every other source, so holding the brush still lays foam at a rate rather
// than a lump per event.
let painting = false;
const paintBtn = document.getElementById('paint');
const strokes = [];                          // world x, z pairs, this frame
const _paintRay = new THREE.Raycaster();
const _paintPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const _paintHit = new THREE.Vector3();
const _paintNdc = new THREE.Vector2();
function setPainting(on) {
  painting = on;
  paintBtn?.setAttribute('aria-pressed', String(on));
  document.body.classList.toggle('painting', on);
  if (!on) strokes.length = 0;
}
paintBtn?.addEventListener('click', () => setPainting(!painting));
function paintAt(clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  _paintNdc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  _paintRay.setFromCamera(_paintNdc, camera);
  // The sea's mean level. Good enough for a brush: the surface is within a
  // wave height of it, and the stamp is metres across.
  if (_paintRay.ray.intersectPlane(_paintPlane, _paintHit)) strokes.push(_paintHit.x, _paintHit.z);
}

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  pinch = null;
  if (painting) paintAt(e.clientX, e.clientY);
});

canvas.addEventListener('pointermove', (e) => {
  const prev = pointers.get(e.pointerId);
  if (!prev) return;
  // Painting takes the drag. The orbit below never sees it.
  if (painting) { pointers.set(e.pointerId, { x: e.clientX, y: e.clientY }); paintAt(e.clientX, e.clientY); return; }
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
  if (k === 'v') setView('waves');
  // Shift+C steps back through the shots, so overshooting the one you wanted
  // does not mean going round the whole cycle again.
  if (k === 'c') useCamera(camIndex + (e.shiftKey ? -1 : 1));
  // Space shuts the throttle. Prevented, or it scrolls the page and re-presses
  // whichever button was last focused -- which up here is a camera change.
  if (k === ' ') { e.preventDefault(); stopEngines(); }
  if (k === 'p') setPainting(!painting);
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
  bubbles.setPixelScale(h * renderer.getPixelRatio(), camera.fov);
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
  // SHIFT IS "HARDER", WHATEVER YOU ARE DOING WITH IT.
  //
  // It already meant a harder turn; on the throttle it meant nothing at all, so
  // the same key was a modifier on one axis and dead on the other. Now it works
  // the throttle the way it works the helm -- opening her up or hauling her
  // back three times as fast -- which is what a hand on a lever actually does.
  const rate = get('boat.throttleRate') * dt
             * (keys.has('shift') ? get('boat.hardThrottle') : 1);
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
  // ASTERN, not "a bit less throttle".
  //
  // This was target *= 0.35, which is 35% of the SLIDER rather than of the
  // speed -- so holding it did not stop her at all, it settled her at a third
  // of whatever the slider said and left her there. On a boat, back means the
  // screw reversed: it stops her far harder than closing the throttle, and
  // then drives her astern, slowly, because a propeller is shaped to push one
  // way and a transom is not a bow.
  if (keys.has('s')) target = -get('boat.astern');

  // The slider is a target, not the speed. A hull cannot step from rest to
  // planing in one frame, and if it does the wake it emits steps with it --
  // which is what puts a straight cut across the water behind.
  //
  // And she comes off the throttle faster than she goes on it. A hull decays
  // its own way through the water, and a reversed screw is a brake with the
  // whole engine behind it -- one rate for both directions was why stopping
  // felt like waiting.
  const closing = target < state.speed;
  const a = get('boat.accel') * (closing ? get('boat.brake') : 1) * dt;
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
  // Authority on the SPEED THROUGH THE WATER, either way -- a rudder does not
  // care which direction the water is going past it, only that it is. And
  // going astern it works in reverse: the flow hits the other face, so the
  // stern walks the way the blade points and the bow swings opposite. Anyone
  // who has backed a boat into a berth knows the helm feels inverted; this is
  // why.
  const thruWater = Math.abs(state.speed);
  const authority = THREE.MathUtils.smoothstep(thruWater, 0.4, 4.0)
    * (state.speed < 0 ? -1 : 1);
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
  // WHERE THE WAKE STARTS, which is the end of the boat that is going first.
  //
  // Ahead, that is the stem, and the ribbon has always been anchored there.
  // Astern it is the transom -- she is travelling stern-first, so the transom
  // is what parts the water and the screws are right there making the mess.
  // Anchoring at the stem either way is why reversing streamed a V off the bow
  // with the plume ahead of the boat: the wake was being laid from the wrong
  // end of the hull.
  //
  // Either way the hull then occupies arc 0 to one hull-length back from the
  // anchor, which is what the wash and cavitation gates already assume.
  const hullDrawn = get('boat.length') * get('boat.modelScale');
  // ...AND AFT AGAIN TO WHERE SHE IS ACTUALLY TOUCHING.
  //
  // FROM THE MESH, not from the trim angle. body.contact solves the keel line
  // against the surface analytically, which is centreline arithmetic on a hull
  // shape nobody measured: it knows the pitch and nothing about the shape of
  // the forefoot, and it cannot represent heel at all -- so it gave the same
  // answer whether she was upright or laid over in a turn.
  //
  // updateWaterline() carries the sampled hull stations through the boat's real
  // world matrix, so pitch, heel and heave are all already in it. The entry is
  // simply the forward-most station that is under water, and in a turn the two
  // sides genuinely disagree, which is what a heeled hull does.
  //
  // The analytic solve stays as the fallback for the frame before the model has
  // loaded and been measured.
  const wl = updateWaterline(0);
  const contact = wl.wet ? wl.entry : (body.contact ?? 0);
  // ...AND IT MAY NOT TELEPORT.
  //
  // Ahead, the ribbon is anchored near the entry; astern, a hull-length back,
  // because going astern it is the transom parting the water. Both are right.
  // Switching between them on the SIGN of the speed is not: measured with the
  // shipped hull, the anchor jumps 22.16 m the instant speed crosses zero.
  //
  // Every arc in the reconstruction is measured from that anchor, and the arms,
  // the feathering and the fades are all functions of arc -- so a 22 m step in
  // the anchor is a 22 m step in the whole pattern, all at once, along the
  // entire length of the wake. That is the jump: not the foam moving, the ruler
  // it is drawn against moving out from under it.
  //
  // So the anchor walks. It is slew-limited to a few metres a second, which is
  // slower than she can change her mind but fast enough to be in the right
  // place well before the new wake is long enough to notice. Nothing already
  // laid is disturbed, because the samples behind it keep the positions they
  // were recorded at.
  const anchorWant = state.speed < 0 ? bowAhead - hullDrawn : bowAhead - contact;
  const slew = get('field.anchorSlew') * dt;
  _anchorOff += Math.max(-slew, Math.min(slew, anchorWant - _anchorOff));
  const anchorOff = _anchorOff;
  // Going ASTERN the track runs the other way down the same course line, so
  // the tangent handed to the field has to be the direction of TRAVEL, not the
  // direction the bow points. Without the flip the ribbon is laid backwards
  // over water the hull has not reached and the Kelvin terms see a negative
  // speed, which is a square root of a negative number two functions down.
  // Tell the field where the back of the boat actually is, measured off the
  // drawn model rather than derived from the sliders.
  wake.sternArc = hullSpan.stern;
  const way = state.speed < 0 ? -1 : 1;
  // HOW HARD THE SCREW IS WORKING, which is not how fast the boat is going.
  //
  // A propeller cavitates when it is asked for thrust it cannot convert: the
  // throttle is open and the water is not yet moving past the blades. That is
  // the gap between the speed commanded and the speed actually made -- large
  // when you open up from rest or throw her astern, and closing to nothing once
  // she is up and running. Astern counts double: a screw shaped to push one way
  // is a poor thing dragged backwards, and it cavitates readily.
  // Release bubbles at the screws. This is a SIM step, not a draw step: they
  // have to keep rising while the camera is elsewhere, or every time you look
  // back at the boat the column starts over.
  const gap0 = target - state.speed;
  const load = Math.min(1, Math.abs(gap0) / 5) * (state.speed < 0 ? 1 : 0.85)
             + (state.speed < 0 ? 0.25 : 0);
  // The load's SIGN carries the direction, which saves a second attribute for
  // one bit: the shader needs to know where along the ribbon the screws are,
  // and going astern they sit at the anchor rather than a hull-length aft of
  // it. Magnitude is the load exactly as before.
  // THE TANGENT IS THE HULL'S AXIS, not the track's.
  //
  // This was the course direction, and that is what let the wake come adrift
  // from the transom in a turn. The two differ by the crab angle -- up to
  // boat.crabMax, twelve degrees by default -- because a hull carves through a
  // turn pointing slightly inside its own track. The ribbon is laid PERPENDICULAR
  // to whatever tangent it is given, so on the course the near end of the wake
  // was square to the track while the boat was square to its heading, and the
  // stern swung clear of the foam it was supposedly making.
  //
  // Water leaves a hull perpendicular to the HULL. A crabbing boat lays a wake
  // slightly wider than its track and offset across it, which is exactly what
  // you see from a helicopter; laying it along the track instead is what opens
  // the gap. Older samples keep the tangent they were recorded with, so the
  // trail behind still follows the path actually travelled.
  wake.pushSample(state.x + bhx * anchorOff, state.z + bhz * anchorOff,
                  bhx * way, bhz * way, state.t, Math.abs(state.speed), state.turn,
                  Math.min(1, load) * way);

  // THE TRANSOM, from the measured hull -- one expression, used by both the
  // emitter and its debug marker so they cannot drift apart again.
  //
  // This was `drawnLen * 0.92` from before the hull was measured: 9.11 m aft of
  // the pivot where the real transom is 6.73 m, so the bubbles came out about
  // two and a half metres astern of the boat. I wrote the fix for this earlier
  // and it silently did nothing -- a string replace with no assertion, against
  // text that had already changed. Everything after that was reasoning about
  // code which was not running, including a probe whose numbers I checked
  // against the arithmetic I INTENDED rather than against the emitter.
  //
  // Hence one shared constant. The marker below reads this variable rather than
  // recomputing the same idea, so if it is ever wrong again it is at least
  // visibly wrong in the same place.
  // Plus an explicit offset, because "exactly on the transom" is not always
  // what you want: a screw hangs under the counter, an outboard stands off the
  // transom, and a long-shaft leg is further back still. Positive is astern.
  const sternBack = hullSpan.stern - body.bowOffset() + get('wash.bubAft');
  const sternX = state.x - bhx * sternBack;
  const sternZ = state.z - bhz * sternBack;
  // What the surface sim needs to know about the hull this frame: where the
  // transom is, which way she points, and how hard the screws are working.
  hullNow.sternX = sternX; hullNow.sternZ = sternZ;
  hullNow.hx = bhx; hullNow.hz = bhz; hullNow.load = load;
  // Rate rides the load the same way the cavitation does -- a screw under load
  // is exactly when a boat boils -- plus a floor from simply turning over, so
  // an idling engine still trickles.
  const bubLoad = Math.min(1, load);
  const turning = THREE.MathUtils.smoothstep(Math.abs(state.speed), 0.05, 1.2);
  const bubRate = get('wash.bubRate') * (0.12 * turning + 0.88 * bubLoad * turning);
  _bubDebt += bubRate * dt;
  let nb = Math.min(Math.floor(_bubDebt), 120);
  _bubDebt -= nb;
  if (nb > 0) {
    const nEng = Math.max(1, Math.round(get('boat.engines')));
    const gapE = get('boat.engineSpacing');
    const spread = get('wash.bubSpread');
    const depth = get('wash.bubDepth');
    const px = -bhz, pz = bhx;                 // port-positive normal
    while (nb-- > 0) {
      const e = (Math.floor(Math.random() * nEng) - (nEng - 1) * 0.5) * gapE;
      const lat = e + (Math.random() - 0.5) * spread;
      const along = Math.random() * spread * 0.8;
      const bx = sternX + px * lat - bhx * along;
      const bz = sternZ + pz * lat - bhz * along;
      bubbles.emit(bx, BUB_SURFACE(bx, bz) - depth * (0.35 + Math.random() * 0.9), bz);
    }
  }
  bubbles.update(dt, BUB_SURFACE, state.t);

  // The markers, from the SAME values the emitters just used -- not recomputed.
  // A marker derived a second time could agree with my arithmetic and still
  // disagree with the code that actually emits, which would make it a second
  // opinion rather than evidence.
  if (get('scene.debugEmit') > 0.5) {
    _markN = 0;
    // RED: where the bubbles are released. This is the one in question.
    mark(sternX, 0.05, sternZ, 1.0, 0.15, 0.15);
    // ORANGE: the measured transom. The SAME variable the emitter used, not the
    // same idea expressed twice -- that is what let these disagree.
    mark(sternX, 0.05, sternZ, 1.0, 0.55, 0.0);
    // GREEN: the stem, where the wake ribbon is anchored.
    mark(state.x + bhx * bowAhead, 0.05, state.z + bhz * bowAhead, 0.1, 1.0, 0.2);
    // BLUE: the sim point -- the pivot everything else is measured from.
    mark(state.x, 0.05, state.z, 0.2, 0.5, 1.0);
    // WHITE: the boat mesh's own origin, so a disagreement between where the
    // hull is DRAWN and where the sim thinks it is shows up immediately.
    mark(boat.position.x, 0.05, boat.position.z, 1, 1, 1);
    // CYAN: the spray cuts along the waterline -- the PARAMETRIC ones, from the
    // half-width curve, which is what the spray emitter uses.
    for (const c of body.cuts(4)) {
      const nx = -bhz, nz = bhx;
      mark(state.x + bhx * bowAhead - bhx * c.along + nx * c.lat, 0.05,
           state.z + bhz * bowAhead - bhz * c.along + nz * c.lat, 0.1, 0.9, 1.0);
    }
    // MAGENTA: where the MESH actually cuts the water, station by station, from
    // the sampled hull carried through the boat's real world matrix. These are
    // the ones to trust -- the cyan ones come from a formula, these come from
    // the boat. In a turn they go asymmetric, because a heeled hull is.
    for (let i = 0; i + 4 < waterline.cuts.length; i += 5) {
      mark(waterline.cuts[i], 0.05, waterline.cuts[i + 2], 1.0, 0.25, 0.85);
    }
    // YELLOW: the entry itself -- the forward-most point of the hull that is
    // under water, and where the wake ribbon is now anchored.
    if (waterline.wet) {
      const e = bowAhead - waterline.entry;
      mark(state.x + bhx * e, 0.06, state.z + bhz * e, 1.0, 0.95, 0.15);
    }
    debugMarks.geometry.setDrawRange(0, _markN);
    debugMarks.geometry.attributes.position.needsUpdate = true;
    debugMarks.geometry.attributes.aCol.needsUpdate = true;
    debugMarks.visible = true;
  } else if (debugMarks.visible) {
    debugMarks.visible = false;
  }
  bubbles.setSun(sea?.sunDirection?.(), camera);
  bubbles.setLight(sea?.sunLight?.());
  spray.setSun(sea?.sunDirection?.(), camera);
  spray.setLight(sea?.sunLight?.());
  // ...and where the hull ITSELF is, which is not the same thing the moment
  // the boat crabs: the sample is the track, this is the boat.
  wake.setHull(state.x + bhx * bowAhead, state.z + bhz * bowAhead, state.heading);

  return { hx, hz };
}

// ?prewarm=90 — run 90 seconds of boat before the first frame, so a capture (or
// a reload mid-tuning) starts with a full-length wake instead of a stub.
// STOP THE ENGINES.
//
// The throttle to zero, not the boat to zero. Shutting down does not stop a
// hull -- she carries her way and slows on her own drag, which is the whole
// difference between a boat and a car, and it is already modelled: the speed
// slider is a TARGET and boat.brake governs how fast she comes off it. So this
// sets the target and lets the physics do what it does.
const stopBtn = document.getElementById('stop');
function stopEngines() {
  set('boat.speed', 0);
  ui.refresh();
}
stopBtn?.addEventListener('click', stopEngines);

// The ribbon's anchor, carried between frames so it can walk rather than jump.
// Started at the ahead value, which is where she is at rest.
let _anchorOff = 0;
// Per-frame hull facts for the surface sim, filled in by stepSim.
const hullNow = { sternX: 0, sternZ: 0, hx: 0, hz: 1, load: 0 };

const speedEl = document.getElementById('speed');

const PREWARM = +(new URLSearchParams(location.search).get('prewarm') ?? NaN) || window.__PREWARM || 0;
// THE WHOLE SIM, not just the boat -- and OFF THE LOAD PATH.
//
// The prewarm used to step the hull alone and leave the field to reconstruct
// itself on the first frame, which it can, because it is a function of the
// path. The surface state is history, and a hull with no history laid behind
// it has no wake on the water; headless renders were showing a sim with five
// frames in it and calling it faint. So the prewarm runs the field and the
// surface too.
//
// But not synchronously. The first version did the GPU work inside the module
// script, and under a software renderer that held the page's load event past
// its thirty-second timeout: the verify failed on page.goto and every capture
// tool with it. So the loop runs in chunks of a few tens of milliseconds
// between tasks, the frame loop only draws until it is done, and __ready --
// which every capture tool waits on -- is set afterwards. The surface is
// stepped at a fifth of a second and only over the last half-minute of the
// run, which is all a foam half-life of twenty-odd seconds can still see.
let prewarmLeft = PREWARM * 30;
window.__prewarming = prewarmLeft > 0;
function prewarmChunk() {
  const t0 = performance.now();
  while (prewarmLeft > 0 && performance.now() - t0 < 40) {
    const i = PREWARM * 30 - prewarmLeft;
    stepSim(1 / 30);
    if (prewarmLeft <= 30 * 30 && i % 6 === 5) {
      const ext = get('field.extent');
      const hx = Math.sin(state.heading), hz = Math.cos(state.heading);
      const back = wake.backAlongPath(ext * 0.56);
      wake.focus(back ? (state.x + back.x) * 0.5 : state.x - hx * ext * 0.28,
                 back ? (state.z + back.z) * 0.5 : state.z - hz * ext * 0.28, ext);
      wake.update(state.t);
      feedSurface(0.2);
      surface.step(0.2);
    }
    prewarmLeft--;
  }
  if (prewarmLeft > 0) setTimeout(prewarmChunk, 0);
  else window.__prewarming = false;
}
if (prewarmLeft > 0) prewarmChunk();

// Waves bursting on the rocks that stand in the surf.
//
// The trigger is not a timer and not a random sprinkle: it is the SAME
// travelling-set phase the water shader draws the shore foam with. Each rock
// knows the water column over its base, the set's phase at that column is
// plain arithmetic, and a rock fires as the crest reaches it. So the spray
// arrives with the white line you can see running in, rather than beside it --
// which is the whole difference between spray that belongs to the sea and
// spray that is decoration parked on top of it.
//
// One-shot per set: armed on the way up, re-armed only once the phase has
// fallen well back, so a rock throws once per wave instead of chattering.
const _sprayRand = () => Math.random();
const _sOut = { x: 0, z: 0 };
// The craft's albedo for its reflection, as radiance is built from it in the
// shader. One neutral hull colour rather than a per-model palette: the image is
// a smeared blob a few metres across, and no one has ever identified a boat by
// the colour of its reflection.
const _craftTint = new Float32Array([0.42, 0.44, 0.47]);
// The upwind unit vector, reused every frame rather than allocated per droplet.
const _wUp = { x: 0, z: 0 };
let _splashCursor = 0;
function breakOnRocks(dt) {
  const sites = shore?.splashSites;
  const amt = get('shore.spray');
  if (!sites || !sites.length || amt <= 0.001 || !useAbyssal() || !sea) return;
  const t = sea.water?.ocean?.time;
  if (!(t >= 0)) return;

  const S = Math.max(get('foamMix.surfSpan'), 0.25);
  const T = Math.max(get('foamMix.surfPeriod'), 0.5);
  const range = get('shore.sprayRange');
  const r2 = range * range;
  const speed = get('shore.spraySpeed');
  const opt = {
    throw: 1, rise: get('shore.sprayRise'),
    life: get('shore.sprayLife'), spread: 0.9,
    // SMALLER than the boat's spray, not the same. Water shattering on stone
    // atomises; it is not the sheet a chine peels off, and at the hull's droplet
    // size these read as thrown polystyrene balls rather than as spray.
    size: get('spray.size') * get('shore.sprayDrop'),
  };
  // Which way the sea is running. The swell follows the wind, so the face of a
  // rock that takes the water is the one looking upwind -- and the burst comes
  // back off that face. Without this the direction was "away from the world
  // origin", which meant something only while there was a bay centred there.
  const windRad = (sea.params?.windDirDeg ?? 42) * Math.PI / 180;
  _wUp.x = -Math.sin(windRad); _wUp.z = -Math.cos(windRad);
  const seaHeight = sea.heightAt ? (x, z) => sea.heightAt(x, z) : null;
  const cx = camera.position.x, cz = camera.position.z;

  // BUDGET, and it has to be reckoned in droplets per SECOND, not per frame.
  // Measured, 763 rocks were in range with 195 of them hot at once, and letting
  // them all fire pinned the pool at its 3000 ceiling -- which is not merely
  // wasteful, it starves the boat's own spray, since the two share it. Steady
  // state is emission rate times droplet life, so the per-frame allowance is
  // the population we want divided by the life, divided by the frame rate.
  const want = 900 * amt;                                  // droplets alive
  let budget = Math.max(2, Math.round(want / Math.max(opt.life, 0.2) * dt));
  // And the scan is bounded too: at 30 fps a slice of 220 revisits every rock
  // about eight times a second, which is far finer than a seven-second set
  // needs, so nothing is missed and the cost stops scaling with the coastline.
  const SCAN = Math.min(sites.length, 220);

  for (let k = 0; k < SCAN && budget > 0; k++) {
    const s = sites[(_splashCursor + k) % sites.length];
    const dx = s.x - cx, dz = s.z - cz;
    const d2 = dx * dx + dz * dz;
    if (d2 > r2) { s.armed = false; continue; }
    const env = 0.5 + 0.5 * Math.sin((s.column / S + t / T) * Math.PI * 2);
    if (env < 0.62) { s.armed = false; continue; }
    if (s.armed || env < 0.88) continue;
    s.armed = true;
    // Bigger rocks throw more, and the far ones throw less because their
    // droplets are sub-pixel anyway -- this is the cost guard, not a look.
    const near = 1 - Math.sqrt(d2) / range;
    const n = Math.round(get('shore.sprayRate') * amt * s.r * 0.5
                       * (0.45 + 0.55 * near) * (0.6 + Math.random() * 0.8));
    if (n < 1) continue;
    budget -= n;
    // FIRE FROM THE FACE THE WATER IS ACTUALLY HITTING.
    //
    // This used to scatter droplets over a square of side 1.6r centred on the
    // rock, at one fixed height, and throw them away from the world origin --
    // which was the bay's centre back when there was a bay. Both are wrong now
    // and one always was: the origin is not a direction, and a box around a
    // rock puts as much water on its lee and its top as on the face taking the
    // sea. What you get is a rock with popcorn round it.
    //
    // The sea runs with the wind, so the struck face is the UPWIND arc. Pick a
    // point on that arc, at the waterline, and throw from there.
    for (let i = 0; i < n; i++) {
      // Anywhere on the windward half, weighted to the middle of it: the
      // corners of a rock take a glancing blow, the face takes it square.
      const th = (Math.random() + Math.random() - 1) * 1.15;   // +/- 66 deg
      const c = Math.cos(th), sn = Math.sin(th);
      // Rotate the upwind direction by th. This is the outward normal of the
      // rock at the point being struck, which is also the way the water comes
      // back off it.
      const nx = _wUp.x * c - _wUp.z * sn;
      const nz = _wUp.x * sn + _wUp.z * c;
      const px = s.x + nx * s.r * (0.82 + Math.random() * 0.3);
      const pz = s.z + nz * s.r * (0.82 + Math.random() * 0.3);
      // ON THE WATERLINE, not at a stored height. The sea here is moving, and
      // the whole point of a burst is that it happens where the crest meets the
      // stone -- a fixed y floats it over the troughs and drowns it in crests.
      const py = (seaHeight ? seaHeight(px, pz) : 0) + s.r * 0.12;
      _sOut.x = nx; _sOut.z = nz;
      spray.emit(px, py, pz, _sOut, _sOut,
                 speed * (0.55 + Math.random() * 0.9), _sprayRand, opt);
    }
  }
  _splashCursor = (_splashCursor + SCAN) % sites.length;
}

// WHERE WHITE IS MADE, this frame.
//
// Not shapes: sources. Each is a place the hull is doing something to the
// water right now, scaled by how hard. The pattern that results -- a thin band
// at walking pace, a wide V at speed, one side heavier in a turn -- is not
// drawn anywhere; it is what those sources add up to once the surface has kept
// them.
function feedSurface(dt) {
  surface.begin();
  // THE BRUSH, first, and regardless of whether the hull's sources are on:
  // the point of it is to test the sim with the boat out of the equation.
  if (strokes.length) {
    const r = get('paint.radius');
    const f = get('paint.foam') * dt, a = get('paint.air') * dt, n = get('paint.fresh') * dt;
    // A held brush queues one stroke per pointer event, which at a high event
    // rate would lay many times the intended amount. Split the frame's dose
    // across the strokes so the rate is per second of holding, not per event.
    const per = 1 / (strokes.length / 2);
    for (let i = 0; i + 1 < strokes.length; i += 2) {
      surface.splat(strokes[i], strokes[i + 1], 1, 0, r, r, f * per, a * per, n * per);
    }
    strokes.length = 0;
  }
  const gain = get('sim.on');
  if (gain <= 0.0001) return;
  const v = Math.abs(state.speed);
  const v0 = get('sim.threshold');
  const drive = Math.max(v - v0, 0);
  const L = get('boat.length') * get('boat.modelScale');
  const beam = get('boat.beam') * get('boat.modelScale');
  const hx = hullNow.hx, hz = hullNow.hz;
  // How hard she is carving: the coordinated-turn ratio, as everywhere else.
  const carve = Math.abs(state.speed * state.turn) / 9.81;
  const outSign = state.turn >= 0 ? 1 : -1;
  const fr = v / Math.sqrt(9.81 * Math.max(get('boat.length'), 0.5));
  // Regime. Below the hump a hull PUSHES water and the white is the turbulent
  // bow wave and the waterline shear; on the plane it THROWS it and the white
  // is the chine sheet and where it lands. One smooth handover.
  const planed = THREE.MathUtils.smoothstep(fr, get('boat.humpFroude') * 0.8, get('boat.humpFroude') * 2.0);

  // 1. THE WATERLINE. Every wet station, both sides, from the mesh.
  if (drive > 0 && waterline.wet) {
    const stationLen = L / HULL_STATIONS;
    const ha = stationLen * 0.7;
    // PER METRE OF HULL, not per second. A texel is under a station only for
    // as long as the hull takes to pass it, 2 ha / v, so a rate per second
    // laid a total that fell with speed: at 14 m/s the whole waterline came
    // to 0.03 of coverage and the residue gate ate it. Dividing the passage
    // time back out makes the number in the slider what a station lays where
    // it passes, and sqrt(drive) is how fast that grows with speed.
    const kW = get('sim.waterline') * gain * dt * v / (2 * ha);
    const work = Math.sqrt(drive);
    const c = waterline.cuts;
    for (let i = 0; i + 4 < c.length; i += 5) {
      const x = c[i], z = c[i + 2], aft = c[i + 3], side = c[i + 4];
      const t = Math.min(aft / Math.max(L, 1), 1);          // 0 stem, 1 transom
      // The bow does the shearing; the quarter follows in water the bow has
      // opened. Air (the turbulent bow wave, which will surface behind) is
      // bow-heavy; foam (the sheet already broken) grows aft.
      const bow = 1 - THREE.MathUtils.smoothstep(t, 0.0, 0.55);
      const along = THREE.MathUtils.smoothstep(t, 0.05, 0.7);
      // The outboard chine in a turn is the one buried and working.
      const outward = Math.sign(side) === outSign ? 1 : 0;
      const turnK = 1 + carve * 2.2 * outward;
      const air = kW * work * (0.9 * bow + 0.15) * (1 - planed * 0.5) * turnK;
      const foam = kW * work * (0.25 * bow + 0.55 * along) * (0.5 + planed * 0.8) * turnK;
      surface.splat(x, z, hx, hz, ha, 0.35 + 0.05 * aft + carve * outward * 0.8,
                    foam, air, foam);
    }
  }

  // 2. THE TRANSOM. Air by how hard the screws are working, plus the transom
  //    wave filling in behind a hull that is moving at all.
  if (v > 0.15) {
    const kT = get('sim.transom') * gain * dt;
    const thrust = Math.min(1, hullNow.load) * v + 0.35 * Math.pow(drive, 1.2);
    const back = 1.2 + 0.08 * v;
    surface.splat(hullNow.sternX - hx * back, hullNow.sternZ - hz * back, hx, hz,
                  back, beam * 0.55, kT * thrust * 0.15, kT * thrust, kT * thrust * 0.15);
  }

  // 3. WHERE THE SPRAY CAME DOWN. A droplet that hits the water is aerated
  //    surface, and this is the first thing that has ever done anything with
  //    the landings the spray has been reporting all along.
  const kL = get('sim.landing') * gain;
  const ld = spray.landings;
  for (let i = 0; i + 2 < ld.length; i += 3) {
    surface.splat(ld[i], ld[i + 1], hx, hz, 0.55, 0.55, kL * ld[i + 2], 0, kL * ld[i + 2]);
  }
}

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  // While the prewarm is still laying history, the sim belongs to it: stepping
  // here as well would advance the boat twice. Keep scheduling frames so the
  // page stays alive, and let __ready wait.
  if (window.__prewarming) return;

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
  breakOnRocks(dt);
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
  feedSurface(dt);
  // What floats on a wave field is carried downwind by it -- the Stokes
  // drift, a few percent of the wind. Slow, but it is why a raft never
  // stays exactly where it was made.
  {
    const sd = get('sim.drift') * dt;
    if (sd !== 0) {
      const wd = sea?.params?.windDir ?? (42 * Math.PI / 180);
      surface.drift(Math.cos(wd) * sd, Math.sin(wd) * sd);
    }
  }
  surface.step(dt);

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
    // How our wake disturbs the water rather than how it paints it. These read
    // OUR wake field inside the forked shader, so they are ours to drive --
    // they spent a long time pinned at zero by the quiet list meant for
    // Abyssal's own wake, which is why the ridge was displaced but never shaded
    // and the track never calmed the water it ran through.
    sea.params.wakeRelief = get('surface.relief');
    sea.params.wakeSlick = get('surface.slick');
    sea.params.wakeCalm = get('surface.calm');
    sea.params.churnRef = get('surface.churnRef');
    sea.params.slickRef = get('surface.slickRef');
    sea.params.slickReach = get('surface.slickReach');
    sea.params.slickSmooth = get('surface.slickSmooth');
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
      ambient.intensity = sl.sky * gain * 0.55;
      // Water-bounce tracks the sky term: an overcast pond glows less.
      bounce.intensity = sl.sky * gain * 0.95;
      // Rebuild the environment only when the light actually moves. It is a
      // PMREM convolution, far too expensive per frame and pointless to redo
      // while nothing about the sky has changed.
      const stamp = `${sd.x.toFixed(2)}|${sd.y.toFixed(2)}|${sl.sky.toFixed(2)}`;
      if (stamp !== envStamp) {
        envStamp = stamp;
        envTex?.dispose();
        envTex = buildEnvironment(sd, sl.colour, sl.sky);
        scene.environment = envTex;
      }
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
      // The pass is rendered SMALLER than the canvas but still sampled by a
      // normalised uv, so nothing downstream has to know: uRefrRes stays the
      // canvas size because gl_FragCoord is in canvas pixels, and the smaller
      // buffer is filtered up. The whole scene drawn twice at full size was
      // measured at ~18% of the frame, and the refracted image is warped and
      // murk-tinted before anyone sees it -- resolution spent there is
      // resolution thrown away.
      const rk = Math.max(0.25, Math.min(1, get('scene.refrScale')));
      ensureRefrRT(Math.max(2, Math.round(bw * rk)), Math.max(2, Math.round(bh * rk)));
      const tm = renderer.toneMapping;
      renderer.getClearColor(_clearWas);
      _clearWasA = renderer.getClearAlpha();
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.setRenderTarget(refrRT);
      // CLEAR TO THE WATER'S OWN COLOUR, not to black.
      //
      // The water does not ADD what it finds in this buffer, it MIXES TOWARD
      // it -- correct for a submerged hull, which really does replace the water
      // you would otherwise see through. But an additive particle drawn over a
      // black clear is black-plus-a-little-light, so mixing toward it turned
      // every bubble into a DARK smudge on bright turquoise. They were being
      // composited the whole time, just subtracting instead of adding.
      //
      // Clearing to the sea's own scattering colour makes an additive particle
      // read as water-plus-light, which is what a bubble is. Opaque geometry is
      // unaffected: it overwrites the clear before anything samples it.
      const sc = sea?.params?.scatterColor;
      if (sc) renderer.setClearColor(_refrClear.setRGB(sc[0], sc[1], sc[2]), 1);
      renderer.clear(true, true, true);
      renderer.render(scene, camera);
      renderer.setRenderTarget(null);
      if (sc) renderer.setClearColor(_clearWas, _clearWasA);
      renderer.toneMapping = tm;
      const glc = renderer.getContext();
      const ct = renderer.properties.get(refrRT.texture)?.__webglTexture;
      const dtx = renderer.properties.get(refrRT.depthTexture)?.__webglTexture;
      if (ct && dtx) refr = {
        color: { target: glc.TEXTURE_2D, tex: ct },
        depth: { target: glc.TEXTURE_2D, tex: dtx },
        res: new Float32Array([bw, bh]),
        // Distorted by the SAME control as the bed: a wavy surface displaces
        // everything under it by one physical mechanism, so it gets one knob.
        amount: get('scene.refraction') * 0.06 * get('lake.bedDistort'),
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
    // The hull is handed over for the bed shadow AND for the water cut, so it
    // goes across whenever either wants it -- turning the shadow off used to
    // take the cut with it, which is two unrelated things on one switch.
    const cut = get('boat.waterCut');
    const drawn = get('boat.length') * get('boat.modelScale');
    // CENTRED ON THE HULL, NOT ON ITS ORIGIN. The model's origin is at the STEM
    // (see the trim note above), so an ellipse centred on boat.position reaches
    // nearly half a boat-length AHEAD of the bow -- which is the oval of missing
    // water that appeared in front of her -- while leaving the after half of the
    // interior uncut and still full of sea. One mistake, both symptoms.
    const fx = Math.sin(state.heading), fz = Math.cos(state.heading);
    const cxm = boat.position.x - fx * drawn * 0.5;
    const czm = boat.position.z - fz * drawn * 0.5;
    const hull = (shadow > 0.001 || cut > 0.5) ? {
      pos: new Float32Array([boat.position.x, boat.position.y, boat.position.z]),
      fwd: new Float32Array([fx, fz]),
      push: 0.02 * shadow,
      plane: 1,
      cut: cut > 0.5 ? 1 : 0,
      cutPos: new Float32Array([cxm, czm]),
      // Inset, so the hull always overhangs its own hole and no gap opens at
      // the waterline however she is rolling.
      cutLen: drawn * 0.44,
      cutBeam: Math.max(get('boat.beam') * get('boat.modelScale') * 0.42, 0.3),
      // The white collar where the topsides go in. It rides the hull's REAL
      // ellipse, not the inset cut above -- the cut is pulled in so the hull
      // overhangs its own hole, so a collar on it is drawn underneath the boat
      // and cannot be seen.
      foam: get('boat.waterlineFoam'),
      foamW: get('boat.waterlineWidth'),
      wlLen: drawn * 0.5,
      wlBeam: Math.max(get('boat.beam') * get('boat.modelScale') * 0.5, 0.35),
      // HER OWN SPEED, because the water cannot find it out any other way.
      // uWakeSpeed is a hard 0 in wakeBridge -- correct, since the field we
      // hand over is already shaped and every Abyssal shaping uniform is
      // neutralised -- so the collar's speed gate was multiplied by zero and
      // drew nothing at all.
      speed: Math.abs(state.speed),
    } : undefined;
    // THE BOAT'S IMAGE IN THE WATER.
    //
    // A ray-sphere test against a proxy at the craft, already written into the
    // water shader and never switched on -- the lab handed it no craft, the
    // amount defaulted to 0, and the branch was dead. So the sea reflected the
    // sky and nothing standing on it.
    //
    // It is a PROXY, not a mirror, and that is the trade being made: no second
    // camera, no reflection pass, no doubling of the frame. R is already the
    // direction this fragment looks in the mirror, so if R points at the craft,
    // the craft is what it reflects -- and because R comes from the WAVY
    // normal, the wobble in the image is the real wave field's rather than a
    // planar pass's fake. What it cannot do is give you rigging.
    //
    // Centred at the hull's middle and lifted, so the blob sits over the boat's
    // visual mass rather than at the stem where the model's origin is.
    // The footprint the spray must keep out of, in the same terms the water's
    // own cut uses. Set every frame from the same numbers, so the two can never
    // drift apart into a boat whose sea is cut but whose spray is not.
    spray.hullCut = cut > 0.5 ? {
      x: cxm, z: czm, fx, fz,
      len: Math.max(drawn * 0.40, 0.3),
      beam: Math.max(get('boat.beam') * get('boat.modelScale') * 0.38, 0.25),
    } : null;
    const reflAmt = get('scene.boatReflect');
    const craft = reflAmt > 0.001 ? {
      pos: new Float32Array([cxm, boat.position.y + hullSpan.height * 0.30, czm]),
      // Half-extents from the MEASURED model: across, up, along. A boat is
      // roughly five times longer than it is wide, and a sphere sized to its
      // length is a disc five times too big in every other direction -- which
      // is precisely the pale circle this was drawing.
      half: new Float32Array([
        Math.max(hullSpan.beam * 0.5, 0.3),
        Math.max(hullSpan.height * 0.45, 0.3),
        Math.max(hullSpan.len * 0.5, 0.5),
      ]),
      fwd: new Float32Array([fx, fz]),
      size: Math.max(hullSpan.len * 0.5, 0.5),
      tint: _craftTint,
      amount: reflAmt,
      shadow: get('scene.boatShadow'),
    } : undefined;
    // Introduce the sea to the coast, once: the water reads this height field
    // to work out how deep it is over the real rock, which is what lets it
    // break there instead of on its own procedural bed. Done here rather than
    // at construction because the sea is built after the shore is.
    // NO COAST MAP. It was a baked texture over a finite extent, and
    // bedDepthAt() feathered back to the procedural bed at its rim -- so the
    // lagoon was a bright square of shaped bottom dropped into an ocean whose
    // floor sat 400 m down and read as flat dark blue. That square edge is
    // what you could see. The bed is procedural and unbounded now, with banks
    // and basins everywhere, so the map has nothing left to add and its rim
    // has nothing left to hide.
    // The mirrored view, before the water draws -- it is an input to it.
    const refl = renderReflection(0);
    sea.render(scene, camera, { ...(refr ? { refr } : {}), ...(hull ? { hull } : {}),
      ...(craft ? { craft } : {}), ...(refl ? { refl } : {}) });
    // After the sky, for the reason given where sprayScene is built.
    renderer.autoClear = false;
    renderer.render(sprayScene, camera);
  } else {
    renderer.autoClear = true;
    renderer.render(scene, camera);
    renderer.autoClear = false;
    renderer.render(sprayScene, camera);
  }

  // The speed, every frame -- not on the fps timer. It is the number you steer
  // by, and a readout that lags the throttle by half a second is worse than
  // none. Two decimals would shimmer at this update rate; one does not.
  if (stopBtn) {
    // Lit while the throttle is shut and she is still moving.
    const coasting = Math.abs(get('boat.speed')) < 0.05 && Math.abs(state.speed) > 0.25;
    stopBtn.dataset.coasting = coasting ? '1' : '';
  }
  if (speedEl) {
    const v = state.speed;
    speedEl.firstChild.textContent = Math.abs(v).toFixed(1);
    speedEl.lastChild.textContent = `${(Math.abs(v) * 1.94384).toFixed(1)} kn`;
    speedEl.dataset.astern = v < -0.05 ? '1' : '';
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
// `boat` and `scene` are here for the same reason everything else is: so a
// probe can ask the running page a question instead of me guessing at it. The
// boat's materials in particular are loaded from GLBs and can carry whatever
// the exporter chose, which is not knowable from this source.
window.__wake = { PARAMS, set, get, state, view, renderer, wake, surface, ocean, stepSim, sea, wakeBridge, body, spray, bubbles, shore, camera, boat, scene, hullNow, feedSurface };
