# Abyssal — guide for coding agents (humans welcome too)

This file is the fast path for an agent asked to *use* this package in another
project, or to *work on* this repository. Everything here is checkable; when a
claim has a verifying command, it is listed. If you learn one thing from this
file: **this repo runs on measurement, not eyeballing** — every subsystem has a
headless check, and a change is not done until the relevant check passes.

**File-only unless asked.** Measurement means those headless checks, not the
agent opening the demo, the wake bench, or any other live page to look at it.
The user is the eyes. No browser MCP, headed Chromium, or screenshot loops
unless they explicitly ask.

## What this is

`abyssal-ocean`: a photoreal FFT ocean + volumetric sky, usable two ways:

| entry | import | backend | dependencies |
| --- | --- | --- | --- |
| **`abyssal-ocean/webgpu`** (recommended) | `createAbyssal()` from `src/gpu/abyssal.js` | WebGPU, automatic WebGL2 fallback | `three` ≥ r185 |
| **`abyssal-ocean/three`** (classic) | `AbyssalWater`, `AbyssalSky` from `src/three/index.js` | WebGL2 only | none — reads matrices off any camera |

Also exported: `abyssal-ocean` (raw WebGL2 components: `Ocean`, `Sky`,
`WaterSurface`), `abyssal-ocean/presets` (named scene presets),
`abyssal-ocean/cloud-types` (the five real cloud genera as recipes).

## Integrating into a user's project

### The one-call path (start here)

```js
import * as THREE from 'three/webgpu';           // NOT 'three' — the webgpu build
import { createAbyssal, SKI, createOceanLitMaterial } from 'abyssal-ocean/webgpu';

const abyssal = await createAbyssal({
  canvas,                        // or renderer: an existing THREE.WebGPURenderer
  preset: 'Golden Hour Swell',   // see src/presets.js for all names
  clouds: 'cumulus',             // optional: cirrus|cumulus|stratus|nimbus|cumulonimbus
  scene,                         // optional THREE.Scene — shares the frame's depth
});

const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.5, 40000);
abyssal.renderer.setAnimationLoop(() => abyssal.frame(camera));   // no dt arg: it measures wall time
// A camera that CHASES a body must aim from the third argument, not before the
// call: frame() steps the bodies itself, so a camera placed outside it trails
// the mesh by velocity × dt, and since dt is never the same two frames running
// that lag swings — a metre of fore/aft judder at planing speed.
//   abyssal.frame(camera, null, { onBodies: aimCamera });

// A mesh you only scene.add() occludes the sea. To float / drop / wake:
abyssal.bodies.add(boat, { mass: 1200, float: true, wake: true, splash: 'impact' });
// A box that planes like the ski — same stepper, different numbers.
// createOceanLitMaterial, not MeshStandardMaterial: Three's lights do not
// share the sea's sun transmittance / sky LUT / haze.
const box = new THREE.Mesh(new THREE.BoxGeometry(2.0, 1.15, 3.2), createOceanLitMaterial({ color: 0xc45a2a }));
const ski = abyssal.bodies.add(box, { ...SKI });
ski.throttle = 1;   // or write vel / heading; the ocean does the water
// Just-under look from the sea dragon: dorsal dome, nose heap, laminar loaf.
ski.swell = { on: 1, dome: 0.4, bow: 0.5, mound: 0.22 };
// Wake recipe: gravity-wave leftover + foam-energy ribbon. Airborne
// whitewater is spray emitters, not leftover bubble splash.
ski.wake = { on: 1, physics: 1, depth: 0.56, beam: 0.9, foam: 1.1, persist: 10.9, motor: 0.4, damp: 1.8, emit: 4 };
// beam: 'auto' follows the mesh width (size.x).
		// Spray from the waterline: `sites` is how many cuts emit at once.
		// hull: 0 (default) sheds at those cuts. hull: 1 is the ski's jet / chines.
		// Birth stays on the mesh cut (not 0.35×beam outboard / 0.22×LOA ahead).
		// Parcel size is `params.spraySize`, cone is `craftSpraySpread`.
		ski.spray = { on: 1, sites: 4, hull: 1 };
// Cyan buoyancy probes + magenta spray cuts on the mesh.
ski.debug = true;
// A pole through the sea at one mesh point (default: middle top).
ski.pierce = { on: 1, r: 0.4, height: 8, life: 6, gain: 1, rim: 0.06, bow: 0.3, side: 0.22, trench: 0.4 };
```

Working references to copy from: [`examples/webgpu-ocean.html`](examples/webgpu-ocean.html)
(full stack + user meshes), [`examples/webgpu-bodies.html`](examples/webgpu-bodies.html)
(crates that fall and hulls whose wakes cross),
[`examples/webgpu-box-ski.html`](examples/webgpu-box-ski.html)
(the jet-ski GLB with `SKI` coefficients plus the sea dragon as an
`OceanBody` — `SeaDragon` steers or you take the helm with M, `creatureVertex` still swims), and [`examples/webgpu-sky.html`](examples/webgpu-sky.html)
(`water: false` sky dome). The facade itself,
[`src/gpu/abyssal.js`](src/gpu/abyssal.js), is documented as the reference for
pass order and driver wiring if the user needs the pieces inside a frame they own.

Options that change the shape of the integration:
`water: false` (sky only) · `spray: false` · `post: false` (you tonemap; read
`abyssal.hdrTexture`) · `output: renderTarget` (finished LDR into a target) ·
`backend: 'webgpu' | 'webgl' | 'auto'` (`'webgpu'` **rejects** rather than
silently falling back) · `overrides: { fftSize: 128, ... }` (any parameter).

Runtime controls: `setPreset(name)`, `setClouds(name)`, `markSkyDirty()` after
changing sun/moon/turbidity params directly, `params` (live, ~380 knobs, all
documented in [`docs/parameters.md`](docs/parameters.md)), `dispose()`.

### The classic WebGL2 path

Zero-dependency; works with `THREE.WebGLRenderer` r120+. Full guide with render
order, colour management, and an honest what-does-not-integrate list:
[`docs/threejs.md`](docs/threejs.md). Examples: `examples/water-and-sky.html`,
`water-only.html`, `sky-only.html`.

### Pitfalls that cost real debugging time (all measured)

- **Import `three/webgpu`, not `three`**, for the webgpu path. Mixing builds in
  one page breaks class identity checks.
- **`frame(camera)` without dt** in `setAnimationLoop` — the loop's argument is
  a millisecond timestamp, not a delta; passing it makes time race.
- If the user creates their own `WebGPURenderer` **before** `createAbyssal`,
  the compat shim may install after views were created; prefer letting the
  facade create the renderer, or call `installThreeCompat()` from
  `src/gpu/three-compat.js` first.
- **A canvas holds one context type for life.** A fallback from WebGPU to
  WebGL2 needs a fresh canvas element (`demo/three-app.js` `freshCanvas()` is
  the reference).
- `cloudCoverage` is a threshold over weather noise: **1.0 does not close the
  deck**. Overcast recipes legitimately run 1.2–1.4 (see `src/cloud-types.js`).
- After changing sun parameters directly, call `markSkyDirty()` — the sky LUT
  (512×256 of scattering integrals) only re-bakes on demand.
- **`MeshStandardMaterial` + a white `DirectionalLight` does not match the
  sea.** That is a studio lamp. Use `createOceanLitMaterial({ color })` so the
  mesh takes the same reddened sun, sky-LUT ambient, and aerial perspective.

### How to verify an integration works

Assert on pixels, not on the absence of exceptions — every failure mode seen
while building this produced a silently blank or uniform frame rather than a
throw. Minimum check (the pattern `tools/check-examples.mjs` uses): draw the
canvas into a 2d canvas, compute luma mean/std, require `std > 3` and no
console errors. A sea-and-sky frame at default presets has visibly different
top and bottom band means; two near-zero bands means nothing drew.

## Working on this repository

### Ground rules

1. **Every subsystem has a check; run the one you touched.** All are headless
   and hermetic (CDN requests are served from the local `three` install).

   Know which kind you are running. A `node tools/check-*.mjs` row marked
   *no GPU* is pure CPU maths and finishes in under a second — that is the
   loop to sit in while iterating. Anything that boots a browser (`npm run
   check`, `check:examples`, `check:ride`, `check:boat`, `check:fly`, any
   `run-probe.mjs`) takes minutes and will bury the machine, so run those
   deliberately, one at a time, not as a sweep.

   | you touched | run |
   | --- | --- |
   | the near field where a mesh goes through the surface (`src/pierce.js`) | `node tools/check-pierce.mjs` — no GPU, under a second. See the row below |
   | leftover trench behind a pole cut (`src/pierce-carve.js`) | `node tools/check-pierce-carve.mjs` — no GPU, under a second |
   | the simulated height field (`src/ripple-field.js`) | `node tools/check-ripple-field.mjs` — no GPU, under a second |
   | anything (smoke) | `npm run check` (WebGL2 demo) · `npm run check:bundle:three` (three/WebGPU demo). Every browser check runs against the BUILT `dist/`, so a source change is invisible to them until `npm run build:three`. Two rules the hand-written bundler cannot bend: no `export { x } from './y.js'` (import the binding and re-export it in a separate statement), and no comments inside an import's braces — it rewrites the list onto one line, so a `//` would comment out the rest of the destructure. It fails loudly on the first, silently on the second |
   | a shader that will not compile on the WebGL2 backend | `half` is a reserved word in GLSL ES, and TSL's `toVar()` carries the JS variable name straight into the generated source, so `const half = ....toVar()` or a layout input named `half` kills the whole water shader. Same trap for any other GLSL keyword — `sampler`, `input`, `output`, `filter` |
   | a shader that reads the cascade textures (`disp` / `slope` / `foam`) | Loop over the cascades **unrolled in JS**, `for (let c = 0; c < CASCADE_CAP; c++)` inside `If( int(c).lessThan(uCascadeCount), ... )`, picking the patch with `cascadeArrayElement(uPatch, c)` and the array layer with `.depth( int( c ) )` — `water-common.js` note 2. A TSL `Loop` with a runtime index compiles and runs and is WRONG: it silently reads cascade 0 for every c. `craft-probe.js` did this, so the hull felt only the long swell — dead still on any sea whose energy sits in the shorter cascades (Tropical Lagoon read 0.00000 m on water standing 0.0165 m up), and in a storm it summed four decorrelated copies of the swell into a sea twice as tall that the hull could not stay in. Measure it with `node tools/probe-bob.mjs --preset "..." --verify`, which compares the probe against the displacement layers on a stopped clock |
   | Three.js examples or facade | `npm run check:examples` |
   | the wave runner (rider, craft, wake, probe, ride camera) | `npm run check:ride` |
   | the seaplane (taxi, takeoff, flight, landing) | `npm run check:fly` |
   | the fishing boat (`demo/boatModel.js`, a second WaveRunner with `prefix: 'boat'`) | `npm run check:boat` |
   | OceanBody drop / float / `wake` recipe / swell / spray / pierce pole / SKI box (CPU) | `node tools/check-ocean-body.mjs` — includes a vertical rod at the middle-top mesh point: above the sea it is off, at the waterline `half === 0`, a rod that does not reach the sea is off, a taller one punches a well down to the base, and the amber cylinder stays off unless `pierce.marker` is on. Also includes mirrored port/starboard birth IDs for a balanced straight-run chine sheet. Jump-out / dive-in splash plates are out: an impact with no waterline cut is quiet, and a cutting dragon stays `sprayBody === 'dragon'` (no `dragonSplash`, no `entryDraw`). Planing ride is Water Pro-style: five hull samples, first-order height follow (`heightSmoothing`), and partial wave tilt (`rotationInfluence`). `hover` is ride height (0 is the hydrostatic waterline); writing `throttle` still drives. `springiness` / `launch` is how readily a crest throws the hull. A storm swell is ridden instead of bounced; a rising face into a falling crest can still launch unless springiness is 0. A leap snaps the just-under loaf off and does not stamp wake under the flying body (exit splash is not a landing hit); leftover rings stay on the sea. A landing / sounding (`jumpPhase === 'water'`) does not raise the swim loaf as a lingering dome. A profiled swimmer (`sprayStations`) stamps leftover foam behind the same waterline runs spray uses (one heading-line ribbon per head / spine / tail cut, ski-narrow `foamBeam`, not every emitter — those glued a blob to the body); rings stay on those cuts. No cut, no surface work, and no landing slap means no wake. Surface work uses a body-height slack (`wakeSurfaceSlack`) so a 60 m animal just under still leaves leftover foam; a ski-sized hull still dies at 2.4 m, and a deep body still does not stamp. A raised tail still writes the stern ribbon. `wake.kelvin` is the following V (ski stays `kelvinOn === 0`). `BodyList` steps `FlukeSlickField` and `applySwellUniforms` writes the prints even when the loaf is off |
   | two hulls, one wake field (CPU twin of the multi-stamp) | `node tools/check-wake-interact.mjs` |
   | live bodies on the facade (drop + overlapping wakes) | `node tools/run-probe.mjs prototypes/bodies-probe.html --shot shots/bodies.png` |
   | the boat's bow/stern orientation or its waterline (`boatYawOffset`/`boatLift` in `presets.js`) | `node tools/run-probe.mjs prototypes/boat-bow-recheck.html --shot shots/x.png` (orthographic top-down, markers at the literal hull tips - the earlier vertex-density read was wrong and drove stern-first, caught live) and `node tools/run-probe.mjs prototypes/boat-waterline-recheck.html --shot shots/x.png` (mesh posed exactly as poseCraft() would, next to a plane at sea level) - both need eyes on the screenshot, check-boat.mjs only tests the physics |
   | what touches the water (floats, wingtip, the hollow) | `npm run check:contact` |
   | the craft's reflection in the sea | `npm run check:reflect` |
   | the craft's shadow on the sea, and that it has the hull's shape | `npm run check:shadow` |
   | the sea dragon: visible under the sea, swimming, holding station | `npm run check:dragon` |
   | piloting the sea dragon (cruise-hold speed/heading/pitch, leap, Strouhal beat) | `npm run check:dragon-pilot` — no GPU: steps `SeaDragon.pilot()` and checks a released key holds course, W/S change speed, Arrow Up does the same, Shift+Up raises cruise faster than Up alone, A turns, E climbs, a fast E climb that breaks the surface leaves the water without Space and falls on g (higher when the run is fast), Space winds up then leaps on a gravity arc (higher when the run is fast; airborne fall is g, not a float), airborne beat holds travel cadence, not slow motion, falls deeper than it started, and floats back to that depth at the previous cruise speed, Level zeros pitch and holds depth, and the tail beats faster at speed |
   | the sea-dragon mesh picker (`sdModel` in `presets.js`, `demo/dragon-models.js`) | `npm run check:dragon-models` — no GPU: both assets resolve, the param enumerates Current vs Sea serpent, both quantized meshes have the nose on -Z and a sane length axis |
   | the sea dragon's jaw (`sdGape`, `SeaDragon.gape`, hinge in `src/creature-jaw.js` / `creatureVertex`) | `npm run check:dragon-jaw` — no GPU: the slider lifts the chin, 0 leaves the bind pose, the skull and the belly stay put, a live gape of 1 releases the shut, and the Sea serpent uses its own reared-head hinge |
   | the leap splash field (CPU twin still in `src/splash-field.js`; the demo does not drive `uSplashEnergy` — landing is waterline particles until the back-mound look is right) | `node tools/check-splash-field.mjs` — no GPU: the unused field still opens a hole, a broken-wall crown, a delayed centre jet, foam in the crater, and an elongated cavity. Demo wiring: `prototypes/dragon-spray-probe.html` asserts a landing does **not** write the crater and does fire waterline particles |
   | the wind-foam field (Jacobian-gated lace + grain, `foamField` in `water-detail.js` / `src/foam-lace.js`) | `node tools/check-foam-lace.mjs` — no GPU: far field stays mean 0.5, fold=0 is empty, the warped F2−F1 web has torn, finite-width filaments rather than discs, wires, cloud, or a closed hex tray, and cores are brighter than edges. Authored coordinates can stretch and breathe through the carry/shear/strain and lace morph knobs; both shaders read the same uniforms. This is wind/shore detail only. Hull wake coverage now uses the separate packed coarse/fine/breakup texture described below, so its random ribbon cannot inherit the old centred lace stamp. Use `node tools/run-probe.mjs prototypes/foam-lace-probe.html --shot shots/foam-lace.png` for the wind-lace look. |
   | leftover hull foam energy (`src/foam-energy.js`) | `node tools/check-foam-energy.mjs` — no GPU: parked injects nothing, a crawl still paints, and the hull sweep writes one connected, flat-topped transom ribbon (not twin dotted lanes, circular coins, or a delayed slab). The A→B sweep is only this frame's cutwater travel, so `foamEnergyLiveHull` also stamps the live waterline (bow to transom + a short wash) whenever `hullLen` is set — a yaw keeps churn on the stern at motor 0 without painting an infinite heading strip. Path-only tests omit `hullLen` and stay sweep-gated. The ribbon is mirrored, ignores teleports, brushes long first-frame leaps, and decays with `params.wakeFoamDecay` / `wake.persist`. With a real LOA the film is bright at the cutwater and the transom and quieter amidships (`foamEnergyAlong`) so a look-down wake has an ocean window between bow spray and stern wash — path-only stamps without `hullLen` stay the old solid stencil. The uploaded leftover tile carries visible height (raw height + live occupancy cancel) and vertical velocity; `-dh/dt × grad(h)` backtraces existing foam, and once the hull outruns leftover the film rides leftover faces at leftover *c* (same kinematics as `leftoverBubbleRide`) so it can open with the Mach V — the 0.45 m/s cap is the displacement-speed floor, not a lid on the arms. Wave activity drives anisotropic neighbour exchange. Kelvin half-angle diverge (`wakeFoamDiverge`, tan θ_K = 1/√8) is an optional live-heading peel and stays off; it must not be the way the ribbon opens. The peel sets how fast water leaves the hull and nothing else — it carries no arm locus. Gating it on `|lat| ≈ beam·0.42 + aft·tanθ` put a ridge in the advection velocity along that ray, advection sharpened the ridge into a drawn line, and because the ray is straight in the LIVE frame a turn swept a painted V clean across the older curved trail. Where the arms actually end up is the wave field's business. `FOAM_ENERGY_PEEL_MEMORY` is half a second for the same reason: that is about as long as the live heading can honestly claim to be the water's own frame, and at three seconds it owned some sixty metres of trail that the wheel then dragged round with it. Bare waves still cannot create foam, and `wakeFoamWaveCarry: 0` restores the fixed ribbon. The divergent peel ramps across the centreline instead of flipping on `sign(lat)` (a one-texel reversal tore a ruled seam along the live heading, which a turn then swept across the older curved trail as a drawn edge on the V), and it releases water further astern than `FOAM_ENERGY_PEEL_MEMORY` seconds of travel so the wheel cannot rotate a whole trail that was laid under a different heading. Existing foam compresses on lifted active water rather than printing every crest. One RGBA asset packs coarse cells, fine lace, and sparse breakup; wake energy selects dense fresh suds, cellular mid-trail foam, then a torn old tail. The wake pack is sampled in a rotated unrelated UV frame and the live energy field never mixes the stamp record window back in. |
   | persistent body wake (`src/body-wake.js` + stamp field + `src/foam-energy.js`) | `node tools/check-ocean-body.mjs` + `node tools/check-wake-interact.mjs` + `node tools/check-foam-energy.mjs` — vehicles keep analytic Kelvin and stamp height off (`kelvinOn === 0`, stamp depth 0). `wake.kelvin: 1` is the opt-in following chevron (the ski-demo dragon). Leftover stern foam is an energy field injected along the hull sweep (a ski uses the origin ribbon; a piercing mesh uses one ribbon behind each spray run), then decayed into the same foamF / foamR channels as whitecaps. Kelvin foam stays off so the following V is height, not a white stencil on the body. Expanding rings stay as water waves — they do not print leftover foam circles. The live wave is full expanding rings in `src/wake-wave.js` (`node tools/check-wake-wave.mjs`): how hard and at what angle the hull hits the water writes them with full Froude number physics ($Fr_L = v/\sqrt{gL}$, $Fr_h = v/\sqrt{gh}$, peaking at transition hump speed $Fr_L \approx 0.5$, planing relief on-plane $Fr_L > 0.8$, dynamic yaw/slip carving on PWCs, and shallow-water resonance as $Fr_h \to 1.0$), each crest is a circle in world XZ, leftover rings keep opening after a stop or a jump, overlapping rings add, and turning around still hits a leftover crest. A profiled body drops one ring lane per pierce run (same sites as spray). A landing slap is one hollow crown (capped height, born as a ring not a filled hill), not a dome under every pierce. A mesh can trade white water for displaced water: `wake.foam: 0` leaves the ribbon nothing to deposit (arm / churn / trail all 0) while `wave` (ring height gain on `depth` × `strength`), `waveWidth` (crest thickness), `waveLife` (seconds) and `waveGap` (metres of travel between rings, 0 = auto from body length so a 60 m animal does not spend all sixteen stamps in half a second) shape the rings. Those ride on the contact, so a long animal's slow swell and a ski's short ripples share one field. That is the box-ski dragon: no foam, no Kelvin, rings plus a V. `prototypes/dragon-spray-probe.html` asserts the three-main animal writes `kelvinOn !== 1` |
   | the simulated height field (`src/ripple-field.js`) | `node tools/check-ripple-field.mjs` — no GPU, because the field itself runs on the CPU: a ring travels at the wave speed you asked for and at the same speed whatever the frame rate did (the demo this came from bakes the timestep into its constants, so its waves double in speed at 120 Hz), a quarter-second stall is substepped rather than exploded past the CFL limit, energy only falls, displacement conserves water, the border absorbs instead of reflecting a pool wall back at the body, and following the body shifts the tile by WHOLE cells so the field is never resampled into mush. The object term is Evan Wallace's: add back the volume the body vacated and subtract what it fills now. That current negative occupancy is retained for simulation but tracked separately and added back only for rendering, so it radiates the collar / heap / hollow / rings without opening a metre-deep vertex moat under the moving hull. A broad beam-scaled gate then fades wave height off the vertex mesh at the live hull while the footprint bends fragment normals and roughness for a mesh-independent contact distortion. It is deliberately non-dispersive — one wave speed for every wavelength — so the far wake of a big fast body still belongs to `src/v-wake.js` and the FFT sea. Compare it against the analytic model with the **near field** button in `examples/pierce-lab.html`. `src/gpu/tsl/ripple-field.js` only uploads the tile, so there is no second implementation to drift |
   | the near field at a pierce site (`src/pierce.js`, twin `src/gpu/tsl/pierce.js`, mesh recipe `src/body-pierce.js`) | `node tools/check-pierce.mjs` — no GPU: the head is v²/2g with a cap, height goes as speed² and not as size, water heaps ahead, the shoulders are pulled DOWN (that is the read that makes a fin look like it is cutting), a hollow opens behind the trailing edge and lengthens with speed, a parked site keeps only its collar, one held clear of the sea does nothing, and the outline is a segment so a chord and a rod behave the same at the same distance from the steel. Reaches are multiples of the site's own size, never metres, so a fin's setting transfers to a hull cut. Tune it by hand in `examples/pierce-lab.html` (no FFT / sky / spray — it opens instantly, and **copy knobs** puts the tuned numbers on the clipboard). Radiating waves are NOT in this module: the rings are `src/wake-wave.js`. A mesh drives this through `pierce: { on, r, height, life, gain, rim, bow, side, trench }` on OceanBody — a profiled mesh cuts along the waterline (the same pierce runs spray uses); a box without a profile still uses a vertical rod. `life` is seconds the leftover trail stays behind (`node tools/check-ocean-body.mjs`, `node tools/check-pierce-carve.mjs`) |
   | gravity-wave hull wake (`src/wake-physics.js` + leftover tile `src/ripple-field.js`) | `node tools/check-wake-physics.mjs` + leftover claims in `node tools/check-ocean-body.mjs` — no GPU: Fr = U/√(gL), leftover speed c = √(gL/2π), parked writes nothing, moving and planing hulls leave height in world XZ, and turns do not rotate old water. The hull only displaces water (`hullRippleSite` + `RippleField.displaceMove`); three speed bands radiate from the posed waterline cuts on one 320 m tile. Raw simulation keeps the live negative occupancy, but visible height adds that source footprint back: outgoing waves remain while the boat no longer sits in a triangulated hole. Physics hulls also skip the older analytic vertex hollow, and a beam-scaled footprint fades both physics fields off the near-hull vertex mesh (sides / bow only — aft of the transom the fade is ~1 m so leftover is born on the stern). Low-amplitude wave normals, animated ruffle, and roughness provide the local contact/refraction distortion instead. `BodyList.step` rides the raw leftover with the same occupancy cancellation, and `leftoverSurge` lets a face change speed. Wave slope is only half the deck angle: `hullRunningTrim(Fr)` adds the hull's own attitude against the water, so a boat sits on its lines at displacement speed, rears to ~7.5° bow-up at the hump (Fr ≈ 0.55) where it is climbing its own bow wave, then settles to ~3° once it is planing and eases further as speed shortens the wetted length. `hullTrimFromAccel` squats the stern under throttle. It is one continuous curve, not a switch between the `wakeRegime` names — a step there would snap the whole deck as the boat worked up through the hump. `trim: 0` on a body restores a deck that only ever follows the wave. Leftover remains height; `leftoverChurn` paints leftover crests (not troughs) when `uRippleFoam` is on (`wakeFoamWaveCarry × wake.foam`), so whitewater rides the V peaks and foam ribbon 0 leaves leftover as water. That crest foam fades on the live hull (`1 − 0.85·geometryMask`) so an old heading's leftover does not sit as a detached white mass on the turning transom. Motor / bow leftover boil is a dt-scaled 60 Hz rate (`leftoverSplashHeight`), not a per-frame fountain, and leftover `|h|` is capped (`LEFTOVER_HEIGHT_CAP`) so a crawl or an unfocused tab cannot stand the vertex mesh up as a tower. `wake.emit` 0 writes no leftover at all, including those jets. `wake.damp` below 1.8 shortens leftover hard enough to see at planing speed. The tile is 256² (still 320 m) — the older 384² field was the same water at 2.25× the CPU. Physics whitewater is separate and opt-in: `wake.foam` writes the connected packed-texture surface ribbon, while `wake.bubbles.splash` adds sparse airborne particles (settling particles are not the default ribbon). Lime / amber emit points are the actual waterline writes; `wake.emit` / `wake.emitMax` is an optional cap, omitted means the full waterline, and `0` writes nothing. The analytic Kelvin field remains numbers-only. Bench: [`examples/webgpu-wake-physics.html`](examples/webgpu-wake-physics.html) (`H` settings, `G` leftover-height debug, click the FPS chip / `P` for the stage overlay). The bench keeps `fpsCap` / idle / adaptive off (those stood leftover up as a tower) and instead ships a thinner sea + short cloud march so the leftover field is the thing you pay for. |
   | hull-wake foam vs the travelling V (`wakeAt()` in `src/wake.js` / `wake-sample.js`) | `node tools/check-wake-sample.mjs` — no GPU: the snout is not a ruler, the V still has height once the arms leave the track, and foam stays on the track instead of scanning out with the arms |
   | the sea dragon's simple V (`src/v-wake.js`, `sdVWake` / `sdVWakeAmp` / `sdVWakeLen` / `sdVWakeMid` / `sdVWakeLife`) | `node tools/check-v-wake.mjs` — no GPU: two soft ridges at the shipped angle, nothing ahead of the snout, empty between the arms unless `mid` is on, fade with fetch, no snout spike, strength follows depth for *new* wake, a written V stays after a dive and dies after life, the live stamp slides to a jumped waterline cut instead of teleporting, and its foam channel is always zero. The facade (`createAbyssal` / box-ski) writes this from the foremost live spray site (`wakeSpraySites`, then a metre aft), including an escort that is still cutting — only a leap or a deep body stops new stamps. Amp and arm width follow how much of the mesh is through the sea, times heading speed. The mesh recipe wins over the `sd*` sliders — `wake.v` (master, 0 refuses the chevron), `vAmp`, `vLen`, `vWidth`, `vAngle`, `vMid`, `vLife`, and `vChurn` for the churned lane between the arms, whose 0 is the only way the V writes no white at all (`uVWakeChurn` in the TSL twin). Leftover foam is a heading-line ribbon behind each spray run. Classic `demo/three-main.js` still forces `uVWakeOn` off; `prototypes/dragon-spray-probe.html` asserts that |
   | persistent sea-dragon trail foam (`src/wake-foam.js`, `uWakeFoamA/B` in `water-surface.js`) | `node tools/check-wake-foam.mjs` — no GPU: a waterline cut deposits foam, old stamps never chase the body, the field drifts, broadens and shears, dies after its lifetime, and stays at the 16-stamp shader cap. Leftover module; `prototypes/dragon-spray-probe.html` asserts `uWakeFoamCount` stays 0 |
   | leftover wake whitewater (`src/leftover-bubbles.js`) | `node tools/check-leftover-bubbles.mjs` — no GPU: off until asked, splash starts in the air and becomes foam when it hits the sea, foam sits on leftover height and rides leftover slope so it spreads with the crest, dies after life, amount 0 + splash 0 / parked birth nothing, `count` / `max` is the live pool cap |
   | leftover waterline foam (`src/leftover-foam.js`; unused by the demo — splash is particles) | `node tools/check-leftover-foam.mjs` — no GPU: the unused field still drops a patch, the patch stays after the sites go empty, zero gain creates nothing, a leap can drop a patch with no sites, the buffer stays at 16, and patches die after life. `prototypes/dragon-spray-probe.html` asserts `uLeftoverFoamCount` stays 0 |
   | the refraction pass (what the sea looks down into) | `node tools/run-probe.mjs prototypes/refraction-probe.html` — reads the target back rather than judging the picture |
   | camera-under-the-sea look (column fog, Snell's window, shafts; `underwater` in `presets.js`) | `node tools/check-underwater.mjs` — no GPU: looking up is the depth, looking down hits the visibility cap, red dies first, the window is ~48.6°, and the look-off switch stays dry — and `node tools/run-probe.mjs prototypes/underwater-probe.html` for the live pass (column on under the sea, looking down is blue-green not tan, looking up is brighter, the switch and an above-water camera turn it off) |
   | virtual seafloor through the surface (`src/seafloor.js`, floor block in `water-surface.js` / `WATER_FS`) | `node tools/check-seafloor.mjs` — no GPU: the bed is under the interface (Lambert E/π, not an HDR slab; a look-down ripple gets a sky film, a sideways look does not), a tilted facet moves the look-down and the sun hit, look-down refraction skips the short chop cascade (13 cm grit), the sunlight on the sand is two or three small broken caustic sheets at the sun-entry that multiply the bed (not a white Voronoi stamp, not a dotted second octave, not Jacobian filaments, not dive `uwCaustic`, not (1−F1) discs, not a sine lattice) and fade with depth and view distance, cell size is `floorCausticSize` (1 = shipped ~0.3 m), that web's brightness is a sun gain (facing / focusing swell — not a random envelope) and slides with the same `sdRefract` look-through warp as the rocks (lighting slope, not the mipped Snell N), sand / reef is metre-scale patches (not a texel hash), sand stays warm, a lone `floorDepth` is a flat shelf, a live min/max range is sandbars and channels that stay inside those depths, Tropical Lagoon is a shallow bed whose column is sky-cyan (not a lime dye), with glitter / capillaries / caustics below the speckle band, and film grain stays off |
   | rocks / coral on that bed (`src/seafloor-props.js`, instanced in `src/gpu/seafloor-props.js`) | `node tools/check-seafloor-props.mjs` — no GPU: no bed is empty, Tropical Lagoon plants a mixed garden, the same seed repeats, coral prefers reef and rocks prefer sand, every prop sits on the heightfield (not at sea level), nothing pokes through past a small emerge, the ski neighbourhood stays clear, sizes / yaws / tints vary, they are spaced not stacked, the GPU path instances (not one GLB clone per rock, not OceanBodies), and the ski demo plants + syncs on preset and swims the sea dragon as an OceanBody |
   | the swell mound's animated spine/heave and body occupancy (`swellLift()` in `water-surface.js`, `src/body-displace.js`) | `node tools/check-swell-curve.mjs` — no GPU: transcribes the occupancy stations' and mesh's lateral + vertical wave formulas to CPU JS, checks they agree, and proves a pitched landing hollows at the wet tip (not a mid-body Gaussian), beside-body is empty, deeper is deeper, and jump-out releases airborne stations |
   | fluke footprints / the just-under pressure dome (`src/fluke-slicks.js`, `flukeSlickCore` / `swellDomeCore` in `water-surface.js`) | `node tools/check-fluke-slicks.mjs` — no GPU: a stroke peak drops a print at the fluke, a loaf or a deep tail does not, a raised fluke still prints on the sea under it, the slick is glassy at the centre and faded at the rim, the buffer stays at the 16-stamp cap, prints die after life and transition out with zero pop, and the dome is one ellipse on the mass (not a spine rail). The ski demo drives this through `BodyList.stepFlukes` / `applySwellUniforms` (not only `demo/three-main.js`) |
   | the top/bottom smeared band from barrel lens distortion (`distortionScale` in `src/distortion-uv.js`, composite in `src/gpu/tsl/post.js` / `src/shaders/post.js`) | `node tools/check-distortion-uv.mjs` — no GPU: barrel must keep the top/bottom mid-edges inside the texture; pincushion must still pin the corners |
   | the last-ring horizon pin vs a downward look (`horizonPinAmount` in `src/horizon-pin.js`) | `node tools/check-horizon-pin.mjs` — no GPU: a horizon camera keeps the pin; a swim-down camera drops it; a banked look that still sees the horizon in a corner keeps it; rebuilding the basis after a fast look updates `fwd` |
   | waterline spray sites on a piercing mesh (`placeBreachEmitters` in `src/breach-emitters.js`) | `node tools/check-breach-emitters.mjs` — no GPU: a synthetic head-and-fin profile must place every site on the waterline and none in the underwater neck between them |
   | spray/foam where the sea dragon breaks the surface | `node tools/run-probe.mjs prototypes/spray-breach-probe.html` — isolates the effect by proximity to the surface, not just presence of the animal |
   | the sea dragon's real particle spray where it breaches (`dragonSpray`/`dragonHighPoint()` in `three-main.js`, `placeBreachEmitters` + `ctx.craftSites`/`craftPierce` in `spray.js`) | `node tools/run-probe.mjs prototypes/dragon-spray-probe.html` — tests at the animal's REAL minimum staging depth (the gates key off the PITCHED high point, `dragonHighPoint()`, never the origin), that `sdSpraySize` / `sdSprayOpacity` / `sdSprayLife` drive the waterline sheet rather than the Spray group, that leftover leap energy with the body clear of the waterline does not keep emitters, that a landing does not switch to the retired jump-splash sliders, that unused splash leftovers stay off (`uLeftoverFoamCount` is 0), and that a vehicle riding at the same time takes the particle system back |
   | any mesh displacing the water's own geometry (`waterDisplaceScale()` in `water-surface.js`) | `node tools/run-probe.mjs prototypes/water-displace-probe.html` — reads uHullPush/uSwellAmp directly, confirms the enable switch and the strength multiplier both reach the hull hollow AND the dragon's back mound |
   | the follow camera's own orbit while watching the sea dragon (`demo/three-main.js`'s `followOrbitYaw/Pitch`) | `node tools/run-probe.mjs prototypes/dragon-follow-orbit-probe.html` — drags yaw/pitch the same way the pointer handler would and checks the rig actually orbits instead of snapping back |
   | the Look button's top-down sea station (`lookAtSea()` in `three-main.js`) | `node tools/run-probe.mjs prototypes/sea-look-probe.html` — steps off every craft, drops follow, parks the camera overhead looking down, and stays put while the animal swims |
   | the settings panel's dock-vs-sheet breakpoint (`demo/ui.css`) | `node tools/run-probe.mjs prototypes/settings-dock-probe.html` (mouse, narrow → docked column) and `node tools/run-probe.mjs prototypes/settings-sheet-phone-probe.html --touch` (phone → bottom sheet still fires) |
   | the settings panel living inside the HUD (`demo/three-shell.html`) | `node tools/run-probe.mjs prototypes/settings-stuck-open-probe.html --touch` — sliders are a child of #hud, so collapsing the instrument hides them with it rather than stranding a second surface over the sea |
   | every settings control's hover tooltip and per-group Copy button (`demo/param-hints.js`, `demo/ui.js`) | `node tools/run-probe.mjs prototypes/settings-tooltips-probe.html` — checks all ~418 controls carry a real tooltip and that Copy neither empties nor toggles its section |
   | the Perf overlay (stage toggles + ablation) | `node tools/run-probe.mjs prototypes/perf-debug-probe.html` — flipping Waves / Particles / Sky / Sea / Refraction zeros that stage's `perfTimes.ran` and leaves the others on. Live GPU is timestamp queries; Hottest is the last Measure snapshot (not live). Box-ski Measure ranks with GPU timestamps when the backend supports them. Seafloor props is its own toggle (`floor`) |
   | picking up the sea dragon's unfinished work | read [`docs/sea-dragon-handoff.md`](docs/sea-dragon-handoff.md) FIRST - it lists what was already tried and failed |
   | the frame-rate governor / anything performance | `npm run check:adapt` |
   | the duty-cycle frame cap (`src/fps-cap.js`, `fpsCap` / `fpsCapIdle` / `fpsCapBattery`) | `node tools/check-fps-cap.mjs` — no GPU: 0 is uncapped, a focused plug uses fpsCap, idle and battery take the tighter ceiling, a lower fpsCap is not raised, skip keeps a 60-on-60 refresh from halving, a 30 fps battery hold is marked capped so adaptive quality does not drop the picture, and both `createAbyssal.frame()` and the ride demo actually skip (box-ski used to present every display tick) |
   | the dragon's body wave in isolation | `node tools/run-probe.mjs prototypes/dragon-swim.html --shot shots/dragon-swim.png` |
   | the propeller's blades and their spin weights | `node tools/run-probe.mjs prototypes/prop-spin.html --shot shots/prop-spin.png` |
   | facade internals | `node tools/run-probe.mjs prototypes/facade-probe.html` |
   | cloud recipes | `node tools/run-probe.mjs prototypes/cloud-types.html --shot shots/clouds.png` |
   | FFT simulation | `npm run check:sim` (bit-exact golden compare). WebGPU uses the workgroup-memory kernel (`FFT_SHARED_WGSL`); WebGL2 keeps the fragment butterflies |
   | TSL sky/water/post/spray | `node tools/run-probe.mjs prototypes/<stage>-tsl.html --save test/out/x.json && node tools/compare-image.mjs test/golden/<stage>.json test/out/x.json` |

2. **The TSL code compiles to both WGSL and GLSL from one source.** Before
   editing anything under `src/gpu/tsl/`, read
   [`docs/tsl-porting-rules.md`](docs/tsl-porting-rules.md) — 18 rules, each
   bought with a real bug (chained `.mix()`, per-backend function caches,
   WebKit's 8 KB private-space budget, readback row order…). Rule numbers are
   cited in code comments; do not delete a "load-bearing" comment without
   reading its rule.
3. **Golden images are the contract.** `test/golden/*.json` are rendered
   fingerprints at a fixed rig; `tools/compare-image.mjs` enforces 1%
   distribution / 2% at the 99th percentile. If your change intentionally
   alters the image, regenerate the golden in the same commit and say why.
4. **Probes over speculation.** `prototypes/` holds one-page experiments that
   answer exactly one question each, runnable via
   `node tools/run-probe.mjs prototypes/<name>.html` (add `--shot out.png` to
   see what it drew — pages draw into a `#view` canvas). When diagnosing,
   prefer writing a probe to guessing; when fixed, keep the probe as the
   regression test.
5. Screenshots for humans: `tools/shot.mjs` (single frame + stats),
   `tools/visit.mjs` (scripted interactive session).

### Map

```
src/            the library (no DOM, no globals)
  ocean-body.js      OceanBody + BodyList — float / drop / wake / swell / spray / pierce / debug flags (CPU)
  body-swell.js      just-under dome / bow heap / laminar loaf (CPU twin of uSwell*)
  body-wake.js       per-mesh wave + textured stern-foam recipe
  body-pierce.js     one mesh rod → circular well to the base when it meets the sea
  pierce-carve.js    leftover trench behind that rod, fading over `life`
  pierce.js          near field where a solid goes through the surface:
                     collar, heap ahead, shoulders down, hollow astern
                     — `node tools/check-pierce.mjs`, bench in
                     `examples/pierce-lab.html`
  ripple-field.js    the same disturbance simulated instead of painted:
                     displace water, let a wave equation carry it
                     — `node tools/check-ripple-field.mjs`
  wake-physics.js    gravity-wave experiment: Fr, leftover speed c,
                     occupancy site + displace gain, and the Froude
                     running trim that sets how far the bow rides up.
                     The sea is the ripple tile, not the following
                     Kelvin field
                     — `node tools/check-wake-physics.mjs`
  wake-wave.js       rings from how hard / at what angle the hull hits
                     — `node tools/check-wake-wave.mjs`
  foam-energy.js     leftover hull sweep foam; rings stay as water waves
                     — `node tools/check-foam-energy.mjs`
  leftover-bubbles.js  splash + foam-on-hit specks on the physics bench (`wake.bubbles`)
                     — `node tools/check-leftover-bubbles.mjs`
  body-spray.js      per-mesh spray recipe + mirrored straight-run side pairing
  gpu/body-debug.js  Three overlay for `debug: true` (spray cuts + buoyancy probes)
  wake-interact.js   age-once, stamp-N policy for the shared wake field
  gpu/abyssal.js     createAbyssal() — the facade; also the pass-order reference
  gpu/tsl/           TSL node graphs: sim, sky, water, spray, post (one source → WGSL+GLSL)
  gpu/tsl/refraction-driver.js  what the sea looks down INTO — colour + its own depth
  gpu/tsl/water-clip.js         the waterline split, as a uniform (read it before touching that)
  gpu/tsl/underwater.js         the water column when the camera is under the sea
  underwater.js                 CPU twin of that column (path, Beer-Lambert, Snell's window)
  gpu/three-compat.js browser/three shims (swizzle) — must install before device work
  fluke-slicks.js    fluke footprints + the just-under pressure dome
  seafloor.js        virtual bed through the surface (sand / reef /
                     focused sunlight on the sand, `sdRefract` look-through)
                     — `node tools/check-seafloor.mjs`
  seafloor-props.js  rocks / coral scattered on that bed
                     — `node tools/check-seafloor-props.mjs`
  cloud-types.js     the five genera, tuned by measurement (prototypes/cloud-types.html)
  three/             classic WebGL2 adapter
  shaders/           the original GLSL (reference implementation for the TSL port)
demo/           the app: main.js/index.html (WebGL2) · three-*.{js,html} (three/WebGPU)
  params-inspector.js  Sea panel for `abyssal.params` — `node tools/check-params-inspector.mjs`
examples/       copy-paste integrations, all covered by check:examples
prototypes/     one-question probe pages (see run-probe)
test/golden/    image fingerprints — the contract
tools/          build (bundle*.mjs), checks (check-*.mjs), probes (run-probe.mjs)
docs/           parameters.md (generated — edit source, run npm run docs:params),
                threejs.md, physics.md, tsl-porting-rules.md, port notes
```

### Known gaps (honest list)

- Ride / fly / swim *controllers* still live in the demo. Any mesh can already
  plane or float through `abyssal.bodies.add` (`src/ocean-body.js`, spread
  `SKI` for the ski numbers). The ride demo has not been moved off
  `WaveRunner` yet. See [`examples/webgpu-box-ski.html`](examples/webgpu-box-ski.html).
- Clouds march at full resolution; half-res + depth-aware upsample is the
  obvious unclaimed win.
- The refraction pass is owned by `createAbyssal()` when you pass a `scene`:
  the ocean photographs every mesh under the waterline, then the beauty pass
  draws what is above it. Box-ski swims the sea dragon that way (`OceanBody`
  + `createCreatureMaterial`). The ride demo still has its own dragon-only path.
- The waterline clip cuts at MEAN sea level plus a seam, not at the displaced
  surface — see `src/gpu/tsl/water-clip.js`. In a big swell that is wrong by the
  wave height at that point, which is why the seam exists.
- Headless WebGPU in CI-like sandboxes renders into targets but cannot present
  to a canvas — checks run the WebGL2 backend or capture to a target; real
  WebGPU presentation needs a real browser/device.
