# Backend decision: Three.js yes, WebGPU not yet

Recorded because "port to WebGPU" is the kind of decision that is expensive to
reverse and easy to make on vibes.

## WebGPU: no, for now

WebGPU's decisive advantage for this workload is **compute shaders**. The only
part of the renderer that would use them is the simulation — the FFT cascades,
the spray integration, the wake stamp — all of which are currently fragment
passes into float textures because WebGL2 has no compute.

So the question is what fraction of a frame the simulation actually is, and how
much faster compute would make it. Both are now measured on real hardware —
an Apple M4 Max, Chrome, WebGPU on Metal.

**How much of the frame is the simulation?** `Profile`, in the demo's Actions
panel, ablates it: run normally, no-op `Ocean.update`, run again, with the frame
cap and the adaptive controller disabled so neither can absorb the saving.

```
2011 x 1047, 256² x 4 cascades      37.7 fps    26.56 ms / frame
without the simulation                          25.76 ms
simulation                                       0.80 ms   ->  3.0%
```

**How much faster is compute?** `prototypes/webgpu-vs-webgl.html`, same machine,
with both backends cross-checked to zero relative error so they are provably
doing the same work:

```
FFT 256² x 4, fragment passes (WebGL2)          0.34 ms
FFT 256² x 4, compute + shared memory (WebGPU)  0.09 ms   ->  3.96x
```

**Multiply them.** A 3.96× speedup removes 75% of 0.80 ms:

```
0.60 ms saved out of 26.56 ms   ->  37.7 fps becomes 38.6 fps
```

**Under one frame per second.** That is the entire return on translating ~170 KB
of GLSL to WGSL, and it is measured rather than argued.

Against that ~1 fps ceiling, the costs are:Against that ~8% ceiling, the costs are:

- **~170 KB of GLSL ES 3.00 to translate to WGSL.** The shaders are the asset
  here; they are also the part most likely to acquire subtle bugs in
  translation, and the least amenable to review.
- **Three's WebGPU path prefers TSL** (its node-based shading language) over raw
  WGSL, so "port to Three + port to WebGPU" is not one rewrite, it is two, and
  the second one has no clean escape hatch for hand-written shaders.
- **A compatibility regression.** WebGL2 runs essentially everywhere; WebGPU is
  still arriving on Safari and Firefox outside Windows.

WebGPU *is* available in this headless environment (SwiftShader adapter, 256
invocations per workgroup, 1 GB storage buffers), so a port would not cost us
the verification loop. That was the one hard blocker and it is not there. The
economics are still wrong.

**Revisit when** the simulation grows enough to matter — much larger FFTs,
many more spray particles, GPU-side buoyancy queries for a fleet of boats — or
when the fragment work has already been cut and the sim is what is left.

### What to do instead, for speed

In descending order of measured value:

`Profile` breaks the frame down by stage, so this list can be checked against the
machine in front of you rather than taken on trust. On the measurement above,
25.76 ms of a 26.56 ms frame is fragment and vertex work — so everything worth
doing is there:

1. **Half-resolution clouds with a depth-aware upsample.** Read the cloud-march
   row from `Profile`; halving its pixel count typically saves several times what
   the whole simulation costs. Not done, and the biggest win available.
2. **Spray overdraw.** Pure fill, drawn last over everything.
3. **Water grid LOD**, for the vertex-bound case on mobile.

Note what `Profile` deliberately does not report: the sea surface. It is drawn
first and writes depth, so removing it hands every one of its pixels to the cloud
march and the frame can come out *slower*. An ablation only means something for a
stage whose removal does not change what the others cost.

## Three.js: yes

Currently `src/three/` is an *adapter*: it borrows the renderer's context and
draws with its own programs. That gets the important thing — a shared depth
buffer — but the sea is not a `THREE.Mesh`, so Three's fog, shadow maps, tone
mapping and material system cannot reach it.

A native port makes the sea a real mesh with a real material, which buys all of
those plus scene-graph sorting, XR and post-processing that composes properly.

It is tractable for one specific reason: **the shaders are plain GLSL ES 3.00
strings**, and `THREE.RawShaderMaterial` with `glslVersion: THREE.GLSL3` accepts
them nearly verbatim. The work is the resource plumbing — render targets,
ping-pong, texture arrays, uniform wiring — not the physics. Confirmed present
in the installed Three: `WebGLArrayRenderTarget` and
`setRenderTarget(target, layer, mip)`, which is what the four FFT cascades need.

The trade to be explicit about: a native port puts a **hard Three dependency**
into the library. Today `abyssal-ocean` has none, and the WebGL2 build is what
the standalone demo runs on. The plan keeps both — `src/` stays
renderer-agnostic and the Three-native backend sits beside it — rather than
replacing one with the other.

## Feasibility, verified

`prototypes/three-native-probe.html` (run it with
`node tools/run-probe.mjs prototypes/three-native-probe.html`) checks the four
mechanisms the port depends on, before rewriting anything against them. All
pass:

```
PASS  WebGLArrayRenderTarget: render + read back per layer
PASS  Multiple render targets (FFT assembly writes 2)
PASS  INIT_SPECTRUM_FS compiles under RawShaderMaterial
PASS  ASSEMBLE_FS compiles under RawShaderMaterial
PASS  WATER_VS + WATER_FS compile as a Mesh material
```

The important one is the last three: **the existing GLSL compiles under Three
unmodified.** The shaders are the asset, and they survive the port intact.

Three conventions the port has to follow, each found by the probe failing first:

1. **The vertex attribute must be called `position`.** Three sizes a draw and
   culls it from `geometry.attributes.position`; an attribute named `a_pos` or
   `aRT` is invisible to both, so the draw count is zero and nothing renders —
   silently, with no error. Renaming it in the GLSL costs the WebGL2 path
   nothing, because that path binds by `layout(location=0)` and never looks at
   the name.
2. **`mesh.frustumCulled = false`** where `position` has two components. Three's
   bounding-sphere computation assumes three.
3. **`RawShaderMaterial` does not inject precision qualifiers** — unlike
   `ShaderMaterial`, it prepends only the `#version` line and the defines. Our
   `program()` prepends them, so a shader that compiles in the WebGL2 path fails
   here until the header is added back.

And one non-issue that looks like a bug: `readRenderTargetPixels` honours its
layer argument only for **cube** targets. On an array target it silently reads
whichever layer is currently attached. Bind the layer with `setRenderTarget`
first. The renderer never needs this — cascades are read as `sampler2DArray` —
but it will mislead anyone writing a test.

## Plan

1. `src/three-native/passes.js` — fullscreen-triangle pass runner over Three
   render targets, replacing `Blitter` + raw FBO ping-pong.
2. Port `Ocean` onto it, and verify numerically against the WebGL2 `Ocean`:
   same seed and parameters must give the same displacement field.
3. Port `Sky` (one LUT target, one background pass).
4. Water becomes a real `THREE.Mesh` + `RawShaderMaterial`, which is the point
   of the exercise — fog, shadows, tone mapping and scene-graph sorting all
   start working at that step.
5. `Spray`, `Wake`, `Post` — all optional, all the same shape of work.
6. Keep `src/` (WebGL2) and the adapter working throughout. The demo runs on
   the WebGL2 path and should not regress.


---

## Confirmed on real hardware

The whole simulation, both backends, on an M4 Max — not a microbenchmark of the
FFT but the actual spectrum, evolution, butterflies and assembly, run through
`prototypes/backend-compare.html`:

```
128² x 4 cascades, 8 steps       WebGL2 fragment   27.10 ms
                                 WebGPU compute     4.50 ms   ->  6.02x
worst relative deviation                            1.40e-5
texels beyond 1e-3                                  0 / 65536, every cascade
```

Two things to take from it.

**The translation is correct on real Metal**, not merely on a software
rasteriser. Every cascade agrees and the difference image is black.

**6.02× is larger than either earlier estimate** — the FFT microbenchmark said
3.96×, SwiftShader said 4.16×. Real hardware gives compute more room than either
predicted, because the full simulation is more dispatch-bound than the isolated
FFT was.

It does not change the decision, and the arithmetic is worth doing rather than
assuming. 6.02× removes 83% of the simulation, the simulation is 3.0% of a
frame, so the saving is 2.5% of one:

```
0.80 ms -> 0.13 ms   ->   26.56 ms frame becomes 25.89 ms   ->   37.7 fps becomes 38.6 fps
```

Still under one frame per second, from a speedup half again larger than the one
the estimate was built on. That is the point of measuring the share as well as
the ratio: a 6x on 3% of the work is a 2.5% saving no matter how good the 6x is.
