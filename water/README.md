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
for a burst; wheel/pinch to zoom. Buttons (and keys): `B` or `Space` drops an
exploding barrel, `R` spins the paddle like a paddle-wheel (slider sets the
rate), `O` orbits the camera, `X` takes the paddle out of the tank entirely,
`F` goes full screen, `H` hides the interface. Every click of `drop barrel`
adds another barrel — up to six can be in flight at once. `C` clears the tank,
`Q` cycles quality, `P` pauses.

The `auto-stir` button controls the paddle wandering the tank on its own. That
wandering is why the water starts moving a second or two after load with nobody
touching it — it is the paddle, not anything in the physics panel. In
particular the `swirl` knob is vorticity confinement: it sharpens curl the
solver already has, and turning it to zero makes the flow smoother without
stopping the stirring. To stop the motion, use `calm water`.

`calm water` is worth explaining, because "why won't it stop moving" has an
unobvious answer: foam is buoyant, so a tank goes on churning under its own
steam long after whatever stirred it has gone — the bubbles keep lifting the
water around them. So the button zeroes the velocity field *and* switches off
auto-stir, since the paddle re-forces the flow within a single frame and
zeroing velocity alone is undone before it is ever seen. The bubbles are kept
and settle on their own; `C` is what empties the tank.

Every control carries a hover tooltip explaining what it does, and `get the
code` prints the three.js that reproduces the settings currently on screen,
with a copy button.

**Physics** — the `physics` button opens sliders for the knobs that decide how
the water behaves; all of them are live and take effect on the next step:

| knob | what it does |
| --- | --- |
| bubble rise | how fast bubbles slip upward *through* the water. This is the difference between bubbles and smoke: the foam field advects with `velocity + rise` rather than with the flow alone. |
| buoyancy | how strongly aerated water lifts the fluid around it, which is what drives the plume. |
| bubble life | e-folding time of the bubble field. Bubbles mostly leave by popping at the surface, so this can be long. |
| aeration | foam injected per unit of churn by the paddle and barrels. |
| vorticity | vorticity confinement — how much fine curl the solver puts back after numerical damping. It sharpens eddies that already exist rather than creating them, so turning it to zero makes the flow smoother, not still. |
| water drag | velocity damping, the stand-in for viscosity. |
| caustics | strength of the light filaments. The field is median-normalised, so this redistributes light rather than adding exposure. |
| blast power | scales an explosion's impulse, foam and ring as it is armed, so the slider reaches explosions already queued. |
| vortex ring | circulation the blast seeds. A radial impulse alone just spreads and dies; the ring is what rolls the cap into a mushroom. |
| surface chop | amplitude of the surface ripples, which drives the glint and the refraction. |

The `scene` panel holds the knobs that decide how much there is to simulate:

| knob | what it does |
| --- | --- |
| grid | simulation resolution, 32³–160³. Cost goes as the cube of the side, so this is the main performance dial. Reallocates the volumes, so it reloads. |
| particles | how many bubble sprites are advected, 5 K–300 K. Decoration on top of the volumetric foam; they do not affect the fluid. Reloads. |
| tank size | the size of the glass the water sits in. The grid stays cubic and uniformly spaced — the tank is a box inside it and everything outside is solid wall — so resizing never disturbs the solver's finite differences. Live. |
| paddle size | how big a blade is doing the stirring. Live. |

`?n=`, `?p=` and `?tank=` set those three from the URL.

The frame rate stays on screen in the corner once the interface is hidden,
because on a GPU simulation it is the number most worth watching — twice now a
bug in this project has shown up first as a frame rate that was suspiciously
*good* (see "When the WebGPU tank looks empty").

With the interface hidden the tank fills the window and only a faint corner
button remains, so pointer- and touch-only users can bring the controls back;
`F` plus `H` gives an uninterrupted full-screen view. Adding the `no-chrome`
class to `<body>` removes that last button too (what `--no-ui` captures use).

## Backends

Two complete implementations, switchable at runtime: the `switch to webgpu` /
`switch to webgl2` button reloads with `?gpu=` flipped (keeping every other
parameter), and the HUD names the one you're on. The button hides itself when
the browser has no WebGPU adapter. WebGL2 is the default; `?gpu=1` opts in.

- `src/main.js` — WebGL2: the Z-slice-atlas pipeline (N³ voxels as tiles of a
  2D texture), MRT raymarch, ping-pong float-texture particles.
- `src/gpu/` — WebGPU: `WebGPURenderer` with the solver as TSL compute kernels
  over true 3D storage textures, hardware trilinear sampling, storage-buffer
  particles, grid presets 64³–160³.

Both have the free surface, caustics, bubble slip, the physics knobs, the
barrel pool and bloom. Two small differences remain in the WebGPU path: its
composite carries scalar rather than rgb transmittance, and its points have no
sprite coordinate, so bubbles are flat 2px dots rather than soft discs.

`src/gpu/compat.js` carries three Dawn shims. Two are the spec-derived
defaults (createView `swizzle`, implicit 3d view dimension). The third is
load-bearing: three.js ORs `RENDER_ATTACHMENT` onto every storage texture, and
Dawn zero-initialises a 3d texture carrying that bit through **per-slice 2d
views**, which are illegal against a 3d texture. Dawn does this lazily, at the
submit that first reads the volume, so the rejected command buffer is the one
carrying the solver's compute passes and the whole simulation silently stops
running. Volumes are never render targets here, so the bit is dropped.
`?compat=0` turns the strip off — which is how to test whether it is implicated
in a failure on a machine we can't reproduce on — and the HUD's backend line
then reads `WebGPU · no compat`.

`?present=rt` renders the final pass off-swapchain for headless
capture (`tools/shot.mjs --gpu`), where frames are also paced to real device
completion so readbacks can't starve behind the queue.

### The `.mix()` trap

`a.mix(b, t)` does **not** compile to `mix(a, b, t)` in this three.js build. The
method form binds the receiver as mix()'s *third* argument, so it emits
`mix(b, t, a)` — and in a trilinear fetch that makes the sampled texel the
interpolation weight. The generated WGSL for `c(0,1,1).mix(c(1,1,1), f.x)` is:

    mix( nodeVar4, vec4<f32>( nodeVar5.x ), nodeVar6 )
    //   c(1,1,1)   the blend factor f.x     c(0,1,1)

Every `sample()` extrapolated instead of interpolating, so the velocity field
went 0 → 16 → 59840 in two steps, saturated float16, and filled with NaN. The
tank then rendered beautifully and simulated nothing: foam was still injected,
but with no velocity to advect it, it clung where it spawned. WebGL never had
this because its `mix()` is hand-written GLSL.

Everything in `src/gpu/` therefore uses an explicit
`lerp(a, b, t) = a + (b - a) * t` rather than `.mix()`. If you add a `.mix()`
back, check the generated WGSL first.

### When the WebGPU tank looks empty

A dead solver and a tank nobody has stirred look identical on screen. Both of
the real bugs found here presented the same way — clear water, no foam, no
bubbles, at a *healthy* frame rate — by two unrelated mechanisms:

- a rejected command buffer takes every compute pass in it down with it, while
  the render passes, submitted separately, keep drawing; and
- a NaN in the velocity field, which is perfectly legal and raises nothing.

In both cases the water, the surface glints and the frame rate all look right
while nothing is being simulated, so a high frame rate is a symptom to check
rather than reassurance. Three things make that legible:

- **The diagnostics banner.** Uncaptured device errors, a lost device, and a
  compute kernel that failed to initialise are printed to a red panel in the
  bottom-left corner instead of only to the console, where nobody sees them
  without devtools open. If bubbles are missing and that panel is empty, the
  compute pipeline built and its submits were accepted.
- **`?view=foam`** renders the raw foam density along each ray with lighting,
  water colour, surface shading and the particle pass all bypassed — it works on
  both backends, so the same URL with and without `&gpu=1` is a direct
  comparison. A black tank means the simulation produced no foam; a visible
  plume means the foam is there and the problem is downstream in the shading.
- **`?diag=1`** reduces the volumes on the GPU each second and prints peak foam
  / velocity / pressure into the HUD's VRAM line, with an explicit `!! NaN in
  velocity` flag. Reach for this when the tank renders but nothing moves: a dead
  solver and an un-aerated tank look identical on screen and completely
  different here. Note that a GPU-side `max()` *hides* NaN — WGSL `max` returns
  the non-NaN operand — so the probe carries a sum alongside every maximum.

Note that bubbles only exist where something has aerated the water. With the
paddle hidden and no barrel dropped the tank is *correctly* empty, and
switching backends reloads the page, which empties it.

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
- **Underwater explosions** — a barrel detonates as an implosion followed by a
  blast, and the blast seeds a torus of poloidal circulation (up through the
  middle, out over the top, down the outside) that widens as it rises. Without
  that, a symmetric impulse just spreads and dies: the mushroom is circulation
  the solver has no reason to invent, and a uniform bubble slip velocity
  translates the plume rigidly, removing the very shear a cap rolls from.
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
  couples as a rigid body (translation + ω×r per voxel) and barrels as spheres
  from a uniform array, injecting momentum and "foam" (aerated water). Foam
  advects with the flow *plus* a slip velocity, so bubbles rise through the
  water instead of drifting with it like smoke.
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
node tools/bundle.mjs --out churn-artifact.html
```

Headless capture + validation harness (serves the folder, renders in
Chromium/SwiftShader, screenshots, prints image statistics). Exits non-zero
on any WebGL/JS error or a flat image, so it doubles as a smoke test.
`--camera az,el,dist` sets the view, `--burst "x,y,z,amount"` (repeatable)
seeds plumes, `--barrel` (with `--barrel-tail <ms>`) drops one through the
surface so the splash is still developing at capture time, `--no-ui` hides the
HUD, `--view foam` captures the foam-density debug view, `--diag` turns on the
GPU field probe, `--gpu` tests the
WebGPU backend
(SwiftShader WebGPU adapter + readback-based capture; expect ~0.2 fps).

`bundle.mjs` inlines the CSS and an esbuild bundle of `src/boot.js` — three.js
and both backends — into one self-contained HTML file, for hosts that allow no
external requests.
