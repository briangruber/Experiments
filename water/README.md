# Churn — volumetric fluid tank

An interactive, real-time volumetric water simulation in the browser, after
[@key_vfx's EmberGen tank clip](https://x.com/key_vfx/status/1696182009922457679):
a glass tank filled with deep blue water — a real waterline with air above it
— churned into billowing clouds of foam by a paddle you drag around and
barrels you drop through the surface. Volumetric light scattering, caustics
and surface glints on a black void. Built on three.js (WebGL2), no build
step.

## Running

Serve the folder and open `index.html`:

```
cd water
npx http-server .        # or any static server
```

`?q=low|med|high|ultra` selects the simulation grid (64³ / 81³ / 100³ / 128³
— default high; ultra wants a discrete GPU). `?dtcap=0.15` raises the
per-frame simulation time cap, useful on slow (software) GPUs.

**Interaction** — drag the paddle to stir; drag anywhere else to orbit; click
for a burst; wheel/pinch to zoom. Buttons (and keys): `B` drops an exploding
barrel, `R` spins the paddle like a paddle-wheel (slider sets the rate),
`O` orbits the camera, `F` goes full screen, `H` hides the interface.
`Space` toggles the auto-stir, `C` clears the tank, `Q` cycles quality,
`P` pauses.

With the interface hidden the tank fills the window and only a faint corner
button remains, so pointer- and touch-only users can bring the controls back;
`F` plus `H` gives an uninterrupted full-screen view. Adding the `no-chrome`
class to `<body>` removes that last button too (what `--no-ui` captures use).

## Backends

WebGPU is opt-in via `?gpu=1` while it catches up — the WebGL2 app has the
free surface, caustics, bloom and bubble particles that backend does not have
yet.

The app boots WebGPU when asked with `?gpu=1` (`src/gpu/` —
`WebGPURenderer` + TSL compute over true 3D storage textures, hardware
trilinear sampling, grid presets 64³–160³) and falls back to the WebGL2 app
otherwise (`src/main.js` — the Z-slice-atlas pipeline, the default). The HUD
shows the active backend. The WebGPU backend is v1: no bloom
or bubble particles yet, and composite transmittance is scalar.

`src/gpu/compat.js` carries three small shims for older Dawn builds
(createView `swizzle`, implicit 3d view dimension, and stripping
RENDER_ATTACHMENT from 3d textures, whose zero-init path builds invalid 2d
views there). `?present=rt` renders the final pass off-swapchain for headless
capture (`tools/shot.mjs --gpu`), where frames are also paced to real device
completion so readbacks can't starve behind the queue.

## How it works

- **Free surface** — the tank is filled to `y = 0.72` with air above. The
  solver treats the waterline as a lid (no flow up through it) and buoyancy
  fades as bubbles approach, so plumes decelerate and mushroom outward
  instead of piling into a ceiling; foam that reaches it pops, leaving a raft
  floating just underneath. The raymarch clips to the water half-space and
  shades the crossing: sun glint off rippled normals, a Fresnel rim that
  stays dark because the room is black, refraction of the view ray on entry,
  and — looking up from below — the silvery mirror of total internal
  reflection with the foam raft printed on it. Impacts (barrel entry,
  detonation, bursts) push expanding rings into a small ripple buffer the
  surface normal reads from.
- **Caustics** — computed in the light-volume pass (once per voxel per frame,
  not per march step) by walking back up the light path to the surface, which
  is what turns the pattern into descending shafts.
- **Simulation** — a 3D stable-fluids solver (semi-Lagrangian RK2 advection,
  buoyancy, vorticity confinement, ~20 Jacobi pressure iterations) runs on the
  GPU over a Z-slice atlas texture (N³ voxels as N tiles in a 2D target).
  Neighbour access is exact `texelFetch`; trilinear sampling is two hardware
  bilinear taps clamped inside their tiles. The foam field advects with a
  limited MacCormack scheme (forward + reverse + clamped anti-diffusion
  correction), which keeps plume filaments crisp. The paddle and the barrel
  couple as rigid bodies (translation + ω×r per voxel), injecting momentum
  and "foam" (aerated water); foam rises, curls, and slowly dissolves.
- **Light volume** — per frame, every voxel marches toward the light
  accumulating foam optical depth (plus an analytic clear-water term), giving
  self-shadowed billows.
- **Rendering** — a reduced-resolution raymarch (MRT: inscatter + rgb
  transmittance) integrates Beer–Lambert absorption for the blue water and
  strong white scattering for foam, using the light volume and a
  forward-leaning phase; a render-time noise erosion fakes sub-grid detail.
  Full-res opaque pass (paddle) with a depth texture stops the rays.
  GPU bubble particles (positions advected by the velocity field in a
  ping-pong float texture) sparkle on the shell of the plumes. Composite,
  two-level bloom, ACES tonemap, vignette and grain finish the frame.

## Tools

```
node tools/shot.mjs --out shots/frame.png --q low --dtcap 0.15 --wait 20000
```

Headless capture + validation harness (serves the folder, renders in
Chromium/SwiftShader, screenshots, prints image statistics). Exits non-zero
on any WebGL/JS error or a flat image, so it doubles as a smoke test.
`--camera az,el,dist` sets the view, `--burst "x,y,z,amount"` (repeatable)
seeds plumes, `--barrel` (with `--barrel-tail <ms>`) drops one through the
surface so the splash is still developing at capture time, `--no-ui` hides the
HUD, `--gpu` tests the WebGPU backend
(SwiftShader WebGPU adapter + readback-based capture; expect ~0.2 fps).
