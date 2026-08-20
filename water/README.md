# Churn — volumetric fluid tank

An interactive, real-time volumetric water simulation in the browser, after
[@key_vfx's EmberGen tank clip](https://x.com/key_vfx/status/1696182009922457679):
a glass box of deep blue water churned into billowing clouds of foam by a
paddle you drag around, rendered with volumetric light scattering on a black
void. Built on three.js (WebGL2), no build step.

## Running

Serve the folder and open `index.html`:

```
cd water
npx http-server .        # or any static server
```

`?q=low|med|high` selects the simulation grid (64³ / 81³ / 100³ — default
high). `?dtcap=0.15` raises the per-frame simulation time cap, useful on slow
(software) GPUs.

**Interaction** — drag the paddle to stir; drag anywhere else to orbit; click
for a burst; wheel/pinch to zoom. `Space` toggles the auto-stir,
`C` clears the tank, `Q` cycles quality, `P` pauses, `H` hides the UI.

## How it works

- **Simulation** — a 3D stable-fluids solver (semi-Lagrangian RK2 advection,
  buoyancy, vorticity confinement, ~20 Jacobi pressure iterations) runs on the
  GPU over a Z-slice atlas texture (N³ voxels as N tiles in a 2D RGBA16F
  target). Neighbour access is exact `texelFetch`; trilinear sampling is two
  hardware bilinear taps clamped inside their tiles. The paddle injects
  momentum and "foam" (aerated water) where it sweeps; foam rises, curls, and
  slowly dissolves.
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
seeds plumes, `--no-ui` hides the HUD.
