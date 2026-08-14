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
   | the refraction pass (what the sea looks down into) | `node tools/run-probe.mjs prototypes/refraction-probe.html` — reads the target back rather than judging the picture |
   | the swell mound's curved spine (`swellLift()` in `water-surface.js`) | `node tools/check-swell-curve.mjs` — no GPU: transcribes both the mound's and the mesh's formulas to CPU JS and checks they land on the same point |
   | spray/foam where the sea dragon breaks the surface | `node tools/run-probe.mjs prototypes/spray-breach-probe.html` — isolates the effect by proximity to the surface, not just presence of the animal |
   | the sea dragon's real particle spray where it breaches, including the one-shot breach burst (`ctx.craft*`'s `dragonSpray`/`dragonImpact` in `three-main.js`, `this.climb` in `seadragon.js`) | `node tools/run-probe.mjs prototypes/dragon-spray-probe.html` — checks the shared emitter's own uniforms, that the burst spikes then fades rather than holding, and that a vehicle riding at the same time takes priority over the animal |
   | any mesh displacing the water's own geometry (`waterDisplaceScale()` in `water-surface.js`) | `node tools/run-probe.mjs prototypes/water-displace-probe.html` — reads uHullPush/uSwellAmp directly, confirms the enable switch and the strength multiplier both reach the hull hollow AND the dragon's swell mound |
   | the follow camera's own orbit while watching the sea dragon (`demo/three-main.js`'s `followOrbitYaw/Pitch`) | `node tools/run-probe.mjs prototypes/dragon-follow-orbit-probe.html` — drags yaw/pitch the same way the pointer handler would and checks the rig actually orbits instead of snapping back |
   | the settings panel's dock-vs-sheet breakpoint (`demo/ui.css`) | `node tools/run-probe.mjs prototypes/settings-dock-probe.html` (mouse, narrow → docked column) and `node tools/run-probe.mjs prototypes/settings-sheet-phone-probe.html --touch` (phone → bottom sheet still fires) |
   | the settings panel's own close control (`demo/ui.js`) | `node tools/run-probe.mjs prototypes/settings-stuck-open-probe.html --touch` — collapsing the small HUD used to take #settings-btn, the panel's only close control, with it |
   | every settings control's hover tooltip and per-group Copy button (`demo/param-hints.js`, `demo/ui.js`) | `node tools/run-probe.mjs prototypes/settings-tooltips-probe.html` — checks all ~418 controls carry a real tooltip and that Copy neither empties nor toggles its section |
   | picking up the sea dragon's unfinished work | read [`docs/sea-dragon-handoff.md`](docs/sea-dragon-handoff.md) FIRST - it lists what was already tried and failed |
   | the frame-rate governor / anything performance | `npm run check:adapt` |
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
  gpu/three-compat.js browser/three shims (swizzle) — must install before device work
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
