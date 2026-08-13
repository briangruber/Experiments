# Using Abyssal in a Three.js scene

> **There are two ways in, and this page documents the classic one.**
> If you are starting fresh, the `abyssal-ocean/webgpu` entry is the smaller
> integration: `createAbyssal({ canvas, scene })` builds the whole stack —
> sea, sky, spray, post — as native three.js node materials (TSL), runs on
> WebGPU with automatic WebGL2 fallback, and takes a plain
> `THREE.PerspectiveCamera`. See the README's first example and
> `examples/webgpu-ocean.html` / `examples/webgpu-sky.html`. Everything below
> is the original WebGL2 adapter, which remains supported and dependency-free.

Abyssal is not built on Three.js. It is hand-written WebGL2 with no dependencies,
and this is a real adapter rather than a wrapper around Three materials. That
choice has consequences in both directions, and this page is mostly about being
precise on what they are.

The short version: the sea and the sky share your renderer's WebGL context, so
they share its **depth buffer** — objects in your scene occlude and are occluded
by the waves correctly. They do not go through Three's material system, so
Three's fog, shadow maps, and colour management do not apply to them.

---

## Install

```
npm install abyssal-ocean
```

There is no `three` dependency and no peer dependency. The adapter never imports
Three; it reads three matrices off whatever camera you hand it. Any Three version
with `WebGLRenderer.resetState()` (r120 and later) works, from a bundler, an
import map, or a CDN.

---

## The whole integration

```js
import * as THREE from 'three';
import { AbyssalWater, AbyssalSky } from 'abyssal-ocean/three';
import { newParams } from 'abyssal-ocean';

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.autoClear = false;                 // required — see "Render order"

// One shared parameter set: both components agree about the sun, the wind and
// the air, and the atmosphere table is built once instead of twice.
const params = newParams('Golden Hour Swell');
const sky   = new AbyssalSky(renderer, { params });
const water = new AbyssalWater(renderer, { params, sky });

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 1 / 20);

  water.update(dt, camera);       // step the wave simulation
  sky.update(dt, camera);         // advance clouds, refresh the atmosphere table

  renderer.clear();
  water.render(camera);           // sea first: writes colour and depth
  renderer.render(scene, camera); // your objects, depth-tested against the waves
  sky.render(camera);             // sky last: fills only what nothing covered
});
```

Either component works alone. `new AbyssalWater(renderer, { preset: 'Storm Front' })`
with no sky is fine — the water still needs an atmosphere to reflect, so it keeps
a private radiance table that is never drawn.

Runnable versions of all three arrangements are in [`examples/`](../examples):
`water-and-sky.html`, `water-only.html`, `sky-only.html`.

---

## Render order

Three rules, and they are not stylistic:

**`renderer.autoClear = false`.** Otherwise `renderer.render()` wipes the sea that
`water.render()` just drew.

**Water before your scene.** It writes depth. Anything you render afterwards
depth-tests against the real displaced wave surface, which is what makes a piling
show a moving waterline instead of a straight cut.

**Sky last.** It is one triangle pinned to the far plane under a `LEQUAL` test
that writes no depth, so the volumetric cloud march — by far the most expensive
shading in the frame — only runs on pixels nothing else covered. Drawing it first
still looks right and costs several times more.

If your scene has a `scene.background`, Three paints it inside `render()` and will
clear the depth buffer doing so. Draw the water *after* `renderer.render()` in
that case (`water-only.html` does exactly this), or drop the background and use
`AbyssalSky`.

---

## Colour

Both shaders compute scene-referred radiance. A sunlit crest is around 20, and the
sun's specular path is far higher. That is correct for this renderer, whose own
pipeline lands the frame in an RGBA16F target and tonemaps afterwards — and wrong
for a Three canvas, which is display-referred and clamps everything above 1.0 to
white.

So the adapter defaults to `output: 'ldr'`: exposure and an ACES fit applied at the
end of each fragment shader.

```js
new AbyssalWater(renderer, { params, exposure: 1.4 });   // stops of exposure
```

This is a fallback that makes the simple case look right, not the good path. Each
component tonemaps in isolation, so the sea and the sky roll off their highlights
separately and no bloom is possible across them.

For a real pipeline, render into a half-float target and tonemap the composed
frame once:

```js
const hdr = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType });
const water = new AbyssalWater(renderer, { params, output: 'hdr' });
const sky   = new AbyssalSky(renderer,   { params, output: 'hdr' });

renderer.setRenderTarget(hdr);
renderer.clear();
water.render(camera);
renderer.render(scene, camera);
sky.render(camera);
renderer.setRenderTarget(null);
// ... your tonemap / bloom pass reads hdr.texture
```

`output` is fixed when the component is constructed: it selects a shader variant,
so it cannot be changed at runtime.

---

## Lighting your own objects

The components expose the sun so your materials can agree with the water:

```js
sun.position.set(...water.sunDirection).multiplyScalar(500);
sun.color.setRGB(...water.sunColor);
```

`sunDirection` is a world-space unit vector pointing *towards* the sun.
`sunColor` is the sun's tint normalised to a peak of 1. Absolute intensity is
deliberately not offered: `params.sunIntensity` is on a physical scale that has
no meaning to a `THREE.DirectionalLight`, and guessing a conversion would look
authoritative while being made up. Set your light's intensity to taste.

---

## What integrates, and what does not

**Works:**

| | |
| --- | --- |
| Depth | Shared buffer. Your objects occlude the sea and the sea occludes them, per pixel, against the displaced surface. |
| Camera | Any `THREE.Camera` — perspective or orthographic — read fresh each frame. Move it however you like. |
| Render targets | Draws into whatever target is bound, including a `WebGLRenderTarget` and MRT-free post chains. |
| Resize | Nothing cached per-size; `renderer.setSize()` is enough. |
| Multiple renderers | Each component adopts one renderer's context and holds nothing global. |

**Does not work, by construction:**

| | |
| --- | --- |
| `THREE.Fog` / `FogExp2` | Applied in Three's material shaders. The sea has its own physical aerial perspective instead (`params.aerial`); the sky is atmospheric all the way down. |
| Shadow maps | Your lights do not cast onto the water. The sea self-shadows its own waves (`params.waveShadow`). |
| `renderer.toneMapping` / `outputColorSpace` | Applied inside Three's shaders, so they do not reach a foreign draw. See "Colour". |
| Materials, `onBeforeCompile`, `MeshStandardMaterial` | The sea is not a `THREE.Mesh`. It has no material to override. |
| `logarithmicDepthBuffer: true` | Our draws write standard depth; mixing conventions gives wrong occlusion. Leave it off. |
| `WebGPURenderer` | WebGL2 only. |

**Untested:** WebXR, `renderer.setScissorTest`, and multiview. They may work;
nothing here has verified them, so they are not claimed.

---

## Buoyancy and CPU-side wave height

**Not provided yet.** This is the largest known gap.

The wave field lives in GPU textures. Reading it back on the CPU is possible — the
demo does it, with a four-point probe shader and an asynchronous `PIXEL_PACK_BUFFER`
readback with a fence, because a synchronous `readPixels` stalls the pipeline
behind the entire ocean simulation — but that machinery is currently entangled with
the demo's craft and wake and is not exposed as a general API.

Until it is: `water.ocean` gives you the `Ocean` instance, whose `disp` texture
array holds the per-cascade displacement, indexed by *undisplaced* coordinate.
`demo/waverunner.js` has a working probe to copy from. Note the subtlety that
made it hard the first time — the fields are Lagrangian, so the value at world
point *p* is not the value at texture coordinate *p*, and inverting that takes a
fixed-point iteration the probe shader performs.

---

## Performance

The cloud march dominates a frame with sky in it (roughly a fifth of it, measured
by ablation), the water grid is next, and both scale with resolution before
anything else.

```js
params.cloudSteps = 32;      // 48 default; the single biggest sky lever
params.fftSize = 128;        // 256 default — construction-time, see below
params.gridRadial = 200;     // 400 default \  grid density; call
params.gridAngular = 320;    // 640 default /  water.rebuildGrid() after
params.cloudStepScale = 0.6; // continuous 0..1 multiplier on cloudSteps
params.gridScale = 0.7;      // continuous 0..1 multiplier on the grid
```

`cloudStepScale` and `gridScale` exist to be driven by an adaptive controller —
they are continuous and cheap to change (`gridScale` still needs
`rebuildGrid()`). `fftSize` is fixed at construction; pass it to the constructor
rather than setting it after.

Full list in [parameters.md](parameters.md).

---

## Troubleshooting

**Everything is white.** You are on the HDR path with an LDR target. Use the
default `output: 'ldr'`, or render into a `HalfFloatType` target.

**The sea disappears when your scene renders.** `renderer.autoClear` is still
true, or a `scene.background` is clearing depth. See "Render order".

**Nothing draws at all, no errors.** Usually Three's state cache disagreeing with
reality. Every Abyssal entry point restores state on the way out; if you are
calling into the internals directly, wrap your calls with `restoreThreeState()`
from `abyssal-ocean/three`'s context module.

**`Abyssal needs EXT_color_buffer_float`.** The simulation runs in float render
targets. There is no fallback path; the extension is effectively universal on
WebGL2 outside of very old mobile drivers.

**The sea is flat.** `water.rebuild()` after changing wind, fetch, depth, swell or
amplitude — those change the spectrum, which is not rebuilt every frame.
