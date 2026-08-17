# Abyssal — guide for coding agents (humans welcome too)

This file is the fast path for an agent asked to *use* this package in another
project, or to *work on* this repository. Everything here is checkable; when a
claim has a verifying command, it is listed. If you learn one thing from this
file: **this repo runs on measurement, not eyeballing** — every subsystem has a
headless check, and a change is not done until the relevant check passes.

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
import { createAbyssal } from 'abyssal-ocean/webgpu';

const abyssal = await createAbyssal({
  canvas,                        // or renderer: an existing THREE.WebGPURenderer
  preset: 'Golden Hour Swell',   // see src/presets.js for all names
  clouds: 'cumulus',             // optional: cirrus|cumulus|stratus|nimbus|cumulonimbus
  scene,                         // optional THREE.Scene — shares the frame's depth
});

const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.5, 40000);
abyssal.renderer.setAnimationLoop(() => abyssal.frame(camera));   // no dt arg: it measures wall time
```

Working references to copy from: [`examples/webgpu-ocean.html`](examples/webgpu-ocean.html)
(full stack + user meshes) and [`examples/webgpu-sky.html`](examples/webgpu-sky.html)
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

   | you touched | run |
   | --- | --- |
   | anything (smoke) | `npm run check` (WebGL2 demo) · `npm run check:bundle:three` (three/WebGPU demo) |
   | Three.js examples or facade | `npm run check:examples` |
   | the wave runner (rider, craft, wake, probe, ride camera) | `npm run check:ride` |
   | the seaplane (taxi, takeoff, flight, landing) | `npm run check:fly` |
   | the fishing boat (`demo/boatModel.js`, a second WaveRunner via `remapParams`) | `npm run check:boat` |
   | the boat's bow/stern orientation or its waterline (`boatYawOffset`/`boatLift` in `presets.js`) | `node tools/run-probe.mjs prototypes/boat-bow-recheck.html --shot shots/x.png` (orthographic top-down, markers at the literal hull tips - the earlier vertex-density read was wrong and drove stern-first, caught live) and `node tools/run-probe.mjs prototypes/boat-waterline-recheck.html --shot shots/x.png` (mesh posed exactly as poseCraft() would, next to a plane at sea level) - both need eyes on the screenshot, check-boat.mjs only tests the physics |
   | what touches the water (floats, wingtip, the hollow) | `npm run check:contact` |
   | the craft's reflection in the sea | `npm run check:reflect` |
   | the craft's shadow on the sea, and that it has the hull's shape | `npm run check:shadow` |
   | the sea dragon: visible under the sea, swimming, holding station | `npm run check:dragon` |
   | piloting the sea dragon (cruise-hold speed/heading/pitch, leap, Strouhal beat) | `npm run check:dragon-pilot` — no GPU: steps `SeaDragon.pilot()` and checks a released key holds course, W/S change speed, Arrow Up does the same, Shift+Up raises cruise faster than Up alone, A turns, E climbs, Space winds up then leaps, falls deeper than it started, and floats back to that depth at the previous cruise speed, Level zeros pitch and holds depth, and the tail beats faster at speed |
   | the sea-dragon mesh picker (`sdModel` in `presets.js`, `demo/dragon-models.js`) | `npm run check:dragon-models` — no GPU: both assets resolve, the param enumerates Current vs Sea serpent, both quantized meshes have the nose on -Z and a sane length axis |
   | the sea dragon's jaw (`sdGape`, `SeaDragon.gape`, hinge in `src/creature-jaw.js` / `creatureVertex`) | `npm run check:dragon-jaw` — no GPU: the slider lifts the chin, 0 leaves the bind pose, the skull and the belly stay put, a live gape of 1 releases the shut, and the Sea serpent uses its own reared-head hinge |
   | the leap splash field (CPU twin still in `src/splash-field.js`; the demo does not drive `uSplashEnergy` — landing is waterline particles until the back-mound look is right) | `node tools/check-splash-field.mjs` — no GPU: the unused field still opens a hole, a broken-wall crown, a delayed centre jet, foam in the crater, and an elongated cavity. Demo wiring: `prototypes/dragon-spray-probe.html` asserts a landing does **not** write the crater and does fire waterline particles |
   | the wind-foam field (Jacobian-gated lace + grain, `foamField` in `water-detail.js` / `src/foam-lace.js`) | `node tools/check-foam-lace.mjs` — no GPU: far field stays mean 0.5, fold=0 is empty, the field is a warped F2−F1 web with torn edges (navy interiors, varied cell scale, not a closed hex tray), filaments have width (not discs, 1-pixel wires, a cloud, or a picket fence), cores are brighter than mid-edge, and wake churn is a milky aerated film (not a Voronoi honeycomb) — and `node tools/run-probe.mjs prototypes/foam-lace-probe.html --shot shots/foam-lace.png` for the top-down look |
   | leftover Kelvin physics (`src/kelvin-wake.js`; unused by the demo) | `node tools/check-kelvin-wake.mjs` — no GPU: the unused module still produces a 19.47° chevron of oscillating gravity waves. `prototypes/dragon-spray-probe.html` asserts the animal writes `kelvinOn !== 1` and does not stamp the vehicle field |
   | hull-wake foam vs the travelling V (`wakeAt()` in `src/wake.js` / `wake-sample.js`) | `node tools/check-wake-sample.mjs` — no GPU: the snout is not a ruler, the V still has height once the arms leave the track, and foam stays on the track instead of scanning out with the arms |
   | the sea dragon's simple V (`src/v-wake.js`, `sdVWake` / `sdVWakeAmp` / `sdVWakeLen` / `sdVWakeMid` / `sdVWakeLife`) | `node tools/check-v-wake.mjs` — no GPU: two soft ridges at the shipped angle, nothing ahead of the snout, empty between the arms unless `mid` is on, fade with fetch, no snout spike, strength follows depth for *new* wake, a written V stays after a dive and dies after life, the live stamp slides to a jumped waterline cut instead of teleporting, and its foam channel is always zero — leftover module; `prototypes/dragon-spray-probe.html` asserts the demo writes `uVWakeOn` off |
   | persistent sea-dragon trail foam (`src/wake-foam.js`, `uWakeFoamA/B` in `water-surface.js`) | `node tools/check-wake-foam.mjs` — no GPU: a waterline cut deposits foam, old stamps never chase the body, the field drifts, broadens and shears, dies after its lifetime, and stays at the 16-stamp shader cap. Leftover module; `prototypes/dragon-spray-probe.html` asserts `uWakeFoamCount` stays 0 |
   | leftover waterline foam (`src/leftover-foam.js`; unused by the demo — splash is particles) | `node tools/check-leftover-foam.mjs` — no GPU: the unused field still drops a patch, the patch stays after the sites go empty, zero gain creates nothing, a leap can drop a patch with no sites, the buffer stays at 16, and patches die after life. `prototypes/dragon-spray-probe.html` asserts `uLeftoverFoamCount` stays 0 |
   | the refraction pass (what the sea looks down into) | `node tools/run-probe.mjs prototypes/refraction-probe.html` — reads the target back rather than judging the picture |
   | camera-under-the-sea look (column fog, Snell's window, shafts; `underwater` in `presets.js`) | `node tools/check-underwater.mjs` — no GPU: looking up is the depth, looking down hits the visibility cap, red dies first, the window is ~48.6°, and the look-off switch stays dry — and `node tools/run-probe.mjs prototypes/underwater-probe.html` for the live pass (column on under the sea, looking down is blue-green not tan, looking up is brighter, the switch and an above-water camera turn it off) |
   | the swell mound's animated spine/heave and body occupancy (`swellLift()` in `water-surface.js`, `src/body-displace.js`) | `node tools/check-swell-curve.mjs` — no GPU: transcribes the occupancy stations' and mesh's lateral + vertical wave formulas to CPU JS, checks they agree, and proves a pitched landing hollows at the wet tip (not a mid-body Gaussian), beside-body is empty, deeper is deeper, and jump-out releases airborne stations |
   | fluke footprints / the just-under pressure dome (`src/fluke-slicks.js`, `flukeSlickCore` / `swellDomeCore` in `water-surface.js`) | `node tools/check-fluke-slicks.mjs` — no GPU: a stroke peak drops a print at the fluke, a loaf or a deep tail does not, the slick is glassy at the centre and faded at the rim, the buffer stays at the 16-stamp cap, prints die after life and transition out with zero pop, and the dome is one ellipse on the mass (not a spine rail) |
   | the top/bottom smeared band from barrel lens distortion (`distortionScale` in `src/distortion-uv.js`, composite in `src/gpu/tsl/post.js` / `src/shaders/post.js`) | `node tools/check-distortion-uv.mjs` — no GPU: barrel must keep the top/bottom mid-edges inside the texture; pincushion must still pin the corners |
   | the last-ring horizon pin vs a downward look (`horizonPinAmount` in `src/horizon-pin.js`) | `node tools/check-horizon-pin.mjs` — no GPU: a horizon camera keeps the pin; a swim-down camera drops it; a banked look that still sees the horizon in a corner keeps it; rebuilding the basis after a fast look updates `fwd` |
   | waterline spray sites on a piercing mesh (`placeBreachEmitters` in `src/breach-emitters.js`) | `node tools/check-breach-emitters.mjs` — no GPU: a synthetic head-and-fin profile must place every site on the waterline and none in the underwater neck between them |
   | spray/foam where the sea dragon breaks the surface | `node tools/run-probe.mjs prototypes/spray-breach-probe.html` — isolates the effect by proximity to the surface, not just presence of the animal |
   | the sea dragon's real particle spray where it breaches or leaps (`dragonSpray`/`dragonImpact`/`dragonHighPoint()` in `three-main.js`, `this.climb` in `seadragon.js`, `placeBreachEmitters` + `ctx.craftSites`/`craftPierce` in `spray.js`) | `node tools/run-probe.mjs prototypes/dragon-spray-probe.html` — tests at the animal's REAL minimum staging depth (the gates key off the PITCHED high point, `dragonHighPoint()`, never the origin — the origin can't come near the surface, and a porpoising body's nose/tail ride up to `sdLength/2·sin(pitch)` above what a level posture would), that its real swim speed reaches the same 6..14 m/s plane gate the vehicles obey (pinned, not the Wave Runner sliders), that `sdSpraySize` / `sdSprayOpacity` / `sdSprayLife` drive the sheet rather than the Spray group, that `sdSprayEmitters` simultaneous waterline sites sit on the animal at sea level and are spread along the cut rather than stacked, that a near-surface swim writes no boat wake / no Kelvin V / no simple V / no stamp-foam, that the spawn footprint spans the animal rather than the ski, that the burst spikes then fades, that unused splash leftovers stay off (`uLeftoverFoamCount` is 0), and that a vehicle riding at the same time takes the particle system back |
   | any mesh displacing the water's own geometry (`waterDisplaceScale()` in `water-surface.js`) | `node tools/run-probe.mjs prototypes/water-displace-probe.html` — reads uHullPush/uSwellAmp directly, confirms the enable switch and the strength multiplier both reach the hull hollow AND the dragon's back mound |
   | the follow camera's own orbit while watching the sea dragon (`demo/three-main.js`'s `followOrbitYaw/Pitch`) | `node tools/run-probe.mjs prototypes/dragon-follow-orbit-probe.html` — drags yaw/pitch the same way the pointer handler would and checks the rig actually orbits instead of snapping back |
   | the Look button's top-down sea station (`lookAtSea()` in `three-main.js`) | `node tools/run-probe.mjs prototypes/sea-look-probe.html` — steps off every craft, drops follow, parks the camera overhead looking down, and stays put while the animal swims |
   | the settings panel's dock-vs-sheet breakpoint (`demo/ui.css`) | `node tools/run-probe.mjs prototypes/settings-dock-probe.html` (mouse, narrow → docked column) and `node tools/run-probe.mjs prototypes/settings-sheet-phone-probe.html --touch` (phone → bottom sheet still fires) |
   | the settings panel living inside the HUD (`demo/three-shell.html`) | `node tools/run-probe.mjs prototypes/settings-stuck-open-probe.html --touch` — sliders are a child of #hud, so collapsing the instrument hides them with it rather than stranding a second surface over the sea |
   | every settings control's hover tooltip and per-group Copy button (`demo/param-hints.js`, `demo/ui.js`) | `node tools/run-probe.mjs prototypes/settings-tooltips-probe.html` — checks all ~418 controls carry a real tooltip and that Copy neither empties nor toggles its section |
   | the Perf overlay (stage toggles + ablation) | `node tools/run-probe.mjs prototypes/perf-debug-probe.html` — flipping Waves / Particles / Sky / Sea / Sea dragon zeros that stage's `perfTimes.ran` and leaves the others on |
   | picking up the sea dragon's unfinished work | read [`docs/sea-dragon-handoff.md`](docs/sea-dragon-handoff.md) FIRST - it lists what was already tried and failed |
   | the frame-rate governor / anything performance | `npm run check:adapt` |
   | the duty-cycle frame cap (`src/fps-cap.js`, `fpsCap` / `fpsCapIdle` / `fpsCapBattery`) | `node tools/check-fps-cap.mjs` — no GPU: 0 is uncapped, a focused plug uses fpsCap, idle and battery take the tighter ceiling, a lower fpsCap is not raised, skip keeps a 60-on-60 refresh from halving, and a 30 fps battery hold is marked capped so adaptive quality does not drop the picture |
   | the dragon's body wave in isolation | `node tools/run-probe.mjs prototypes/dragon-swim.html --shot shots/dragon-swim.png` |
   | the propeller's blades and their spin weights | `node tools/run-probe.mjs prototypes/prop-spin.html --shot shots/prop-spin.png` |
   | facade internals | `node tools/run-probe.mjs prototypes/facade-probe.html` |
   | cloud recipes | `node tools/run-probe.mjs prototypes/cloud-types.html --shot shots/clouds.png` |
   | FFT simulation | `npm run check:sim` (bit-exact golden compare) |
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
  gpu/abyssal.js     createAbyssal() — the facade; also the pass-order reference
  gpu/tsl/           TSL node graphs: sim, sky, water, spray, post (one source → WGSL+GLSL)
  gpu/tsl/refraction-driver.js  what the sea looks down INTO — colour + its own depth
  gpu/tsl/water-clip.js         the waterline split, as a uniform (read it before touching that)
  gpu/tsl/underwater.js         the water column when the camera is under the sea
  underwater.js                 CPU twin of that column (path, Beer-Lambert, Snell's window)
  gpu/three-compat.js browser/three shims (swizzle) — must install before device work
  fluke-slicks.js    fluke footprints + the just-under pressure dome
  cloud-types.js     the five genera, tuned by measurement (prototypes/cloud-types.html)
  three/             classic WebGL2 adapter
  shaders/           the original GLSL (reference implementation for the TSL port)
demo/           the app: main.js/index.html (WebGL2) · three-*.{js,html} (three/WebGPU)
examples/       copy-paste integrations, all covered by check:examples
prototypes/     one-question probe pages (see run-probe)
test/golden/    image fingerprints — the contract
tools/          build (bundle*.mjs), checks (check-*.mjs), probes (run-probe.mjs)
docs/           parameters.md (generated — edit source, run npm run docs:params),
                threejs.md, physics.md, tsl-porting-rules.md, port notes
```

### Known gaps (honest list)

- CPU-side wave height / buoyancy has no general API yet (`demo/waverunner.js`
  has a working async probe).
- The wake field and rideable craft are WebGL2-demo-only; not yet ported to TSL.
- Clouds march at full resolution; half-res + depth-aware upsample is the
  obvious unclaimed win.
- The refraction pass (`src/gpu/tsl/refraction-driver.js`) is wired in the demo
  only — `createAbyssal`'s `scene` option still draws your meshes into the HDR
  frame against the sea's depth, not into the water. The pieces to change that
  are exported (`setRefractionTextures`, `applyWaterClip`); the facade does not
  call them yet.
- The waterline clip cuts at MEAN sea level plus a seam, not at the displaced
  surface — see `src/gpu/tsl/water-clip.js`. In a big swell that is wrong by the
  wave height at that point, which is why the seam exists.
- Headless WebGPU in CI-like sandboxes renders into targets but cannot present
  to a canvas — checks run the WebGL2 backend or capture to a target; real
  WebGPU presentation needs a real browser/device.
