# Backend decision: Three.js yes, WebGPU not yet

Recorded because "port to WebGPU" is the kind of decision that is expensive to
reverse and easy to make on vibes.

## WebGPU: no, for now

WebGPU's decisive advantage for this workload is **compute shaders**. The only
part of the renderer that would use them is the simulation — the FFT cascades,
the spray integration, the wake stamp — all of which are currently fragment
passes into float textures because WebGL2 has no compute.

So the question is what fraction of a frame the simulation actually is.
Measured by ablation (`tools/probe-backend.mjs`: run normally, then no-op
`Ocean.update`, with the frame cap and the adaptive controller both disabled so
neither can absorb the saving):

```
frame, full                 909.1 ms
frame, simulation disabled  833.3 ms
simulation                   75.8 ms   ->  8.3% of the frame
```

**Making the simulation infinitely fast would win under a tenth of a frame.**
The other 92% is fragment and vertex work — the volumetric cloud march, the
water BRDF, spray overdraw — and an ALU-bound raymarch costs exactly the same
number of ALU cycles in WebGPU as in WebGL2. No API change makes it faster.

Caveat, stated because it matters: this was measured on SwiftShader (CPU
rasterisation), not real hardware, so the exact ratio will move. The direction
will not — a prior ablation on the same build put the cloud march alone at
about a fifth of the frame, which is already more than twice the entire
simulation.

Against that ~8% ceiling, the costs are:

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

1. **Half-resolution clouds with a depth-aware upsample.** The march is ~20% of
   the frame; halving its pixel count saves more than making the entire
   simulation free. This is the single biggest win available and it is not done.
2. **Spray overdraw.** Second-largest item, and it is pure fill.
3. **Water grid LOD**, for the vertex-bound case on mobile.

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
