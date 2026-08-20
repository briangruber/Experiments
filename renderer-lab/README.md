# Renderer Lab

GPU-driven rendering experiments on top of three.js WebGPU + TSL. Stage one:
**frustum culling in a compute shader feeding an indirect draw call**, with the
CPU never learning how many objects are visible.

## Why this and not anti-aliasing

The original plan for this lab started with temporal anti-aliasing. Reading the
three.js source made that redundant — r184/r185 already ship a real TRAA
implementation, along with several other things it is easy to assume are
missing:

| capability | status in three r184 |
| --- | --- |
| Temporal AA with velocity + neighbourhood clamp | ships — `TRAANode` |
| Motion vectors | ships — `VelocityNode`, MRT `velocity` output |
| SSGI, SSR, GTAO, denoise, FSR1, SMAA, FXAA | ship as `tsl/display/` addons |
| Meshlet clusterizer | vendored library present (`meshopt_clusterizer`), nothing consumes it |
| Indirect draw plumbing | backend calls `drawIndexedIndirect`/`drawIndirect`; `geometry.setIndirect()` is public API |
| **Anything that drives an indirect draw from a compute pass** | **missing** |
| **GPU-side culling** | **missing** — `BatchedMesh` frustum-culls in a JavaScript loop |
| **Cluster LOD** | **missing** |

So the shading language is not the gap, and neither is post-processing. The gap
is the *submission architecture*: three.js still walks the scene graph on the
CPU and issues a draw call per object. That is what this lab attacks.

TRAA is wired up here as a toggle, using the built-in node rather than a
reimplementation.

## What it does

Three ways to draw the same N objects, switchable at runtime:

| mode | draw calls | culling | notes |
| --- | --- | --- | --- |
| `meshes` | one per visible object | CPU, per object | what a normal three.js scene does |
| `instanced` | 1 | none | cheap CPU, every instance vertex-shaded |
| `gpu` | 1 (indirect) | GPU compute | one draw call *and* only visible instances shaded |

The GPU path works like this:

1. A compute pass tests every instance's bounding sphere against the six frustum
   planes.
2. Survivors are compacted into an index buffer, their slot claimed with a
   single `atomicAdd`.
3. That same `atomicAdd` targets the `instanceCount` field of a WebGPU indirect
   draw-argument buffer, so the draw call's own parameters are produced on the
   GPU.
4. The render pass issues one `drawIndirect`, and the vertex stage reads the
   compacted list to recover each surviving instance's transform.

No readback, no stall, no CPU involvement in the visibility decision.

## Running

```
# serve the folder and open index.html — there is no build step
python3 -m http.server -d . 8000
```

Query parameters: `?mode=gpu|instanced|meshes`, `?count=24000`, `?traa=0`.

Requires a browser with WebGPU. There is no WebGL fallback: indirect draw calls
and storage-buffer atomics have no WebGL equivalent, and the lab says so rather
than silently degrading.

## Verifying

```
xvfb-run -a node tools/verify.mjs                     # culling correctness
xvfb-run -a node tools/verify.mjs verify-render.html  # indirect draw correctness
xvfb-run -a node tools/verify.mjs verify-velocity.html
```

`verify.mjs` exits non-zero on failure, so all three double as regression tests.

- **`verify.html`** runs the compute cull across eight camera poses and compares
  the surviving set against `THREE.Frustum`/`THREE.Sphere` — an implementation
  independent of the Gribb–Hartmann extraction inside `GPUCuller`. It requires
  exact set equality, not just matching counts.
- **`verify-render.html`** renders the same view twice, once as a plain
  `InstancedMesh` drawing everything and once through the culled indirect path,
  and requires the two images to match. Culling only removes off-screen
  geometry, so a correct implementation is pixel-identical to not culling at
  all. It also asserts the frame is not saturated, because a fully covered frame
  would make the comparison vacuous.
- **`verify-velocity.html`** compares the custom motion vectors against three's
  built-in `velocity` node. It **skips** in environments without working
  multi-target render targets — see below.

Both shipped tests were checked against deliberate breakage: reverting the
near-plane convention makes `verify.html` fail two poses (303 and 770 instances
leaking through), and dropping every eighth instance makes `verify-render.html`
fail on image mismatch.

## Two things worth knowing if you build on this

**The near plane is convention-dependent.** OpenGL clip space puts the near
plane at `z = -w`, giving the familiar `row3 + row2` extraction. WebGPU, like
D3D and Metal, puts it at `z = 0`, so the near plane is `row2` alone.
`WebGPURenderer` produces WebGPU-convention matrices. Using the GL form silently
over-reports visibility near the camera — and with a typical near distance of
0.5 it is nearly undetectable, which is why `verify.html` includes two poses
with a deliberately deep near plane.

**The built-in velocity node does not respect `positionNode`.** `VelocityNode`
builds its motion vector from `positionLocal` and the object's model matrix,
regardless of what the material's `positionNode` computes. The GPU-driven path
derives world position in the vertex shader from a storage buffer, so the
built-in node sees one unit icosahedron at the origin and produces wrong motion
for every instance — which TRAA turns into visible smearing.
`src/post/staticVelocity.js` replaces it, computing velocity from the same world
position the vertex stage used, against an explicitly unjittered previous
view-projection.

## Environment note

WebGPU **canvas presentation** does not work under SwiftShader in some container
images: the device is lost the moment a canvas context is configured. This is
not a three.js or lab issue — a plain WebGPU triangle drawn to a canvas fails
identically with no library involved, while compute passes and offscreen render
targets work fine.

Consequences:

- `tools/shot.mjs` (screenshot capture) cannot run in such an environment.
- `tools/verify.mjs` can, and does — it uses only compute and offscreen render
  targets.
- `verify-velocity.html` additionally needs multi-attachment render targets,
  which also produce no output there, so it reports `SKIPPED` rather than a
  misleading failure. **The velocity module is therefore reasoned about and
  written, but not yet verified against the built-in node.** Run it on a machine
  with a working WebGPU stack to close that gap.

## Single-file build

The whole lab bundles into one self-contained HTML file (no imports, no
network) for publishing as an artifact:

```
node tools/build-artifact.mjs          # -> dist/gpu-driven-culling.html
```

`tools/artifact/app.js` is a thin DOM shell only; all rendering logic is
imported from `src/`, so the artifact and the served prototype exercise the same
code. The build escapes non-ASCII markup to numeric entities, because the host
wrapper owns `<head>` and a missing charset would otherwise turn every em dash
into mojibake.

## Layout

```
index.html                   entry point
src/culling/GPUCuller.js     compute cull + indirect draw args  ← the core
src/post/staticVelocity.js   motion vectors for shader-positioned geometry
src/scene/stressScene.js     the three draw modes
src/ui/                      HUD
tools/verify.mjs             test runner
tools/verify*.html           the tests
tools/shot.mjs               screenshot capture
vendor/three/                three.js r0.184.0, MIT
```

## Next

In rough order of value, and all tractable on today's WebGPU:

1. **HZB occlusion culling** — depth pyramid from last frame, second cull pass.
   Extends the existing compute pass rather than replacing it.
2. **Multi-geometry batching** — one indirect draw *per geometry* from a single
   cull dispatch, which is what makes this useful for real scenes rather than
   one repeated mesh.
3. **Cluster LOD** — `meshopt_clusterizer` is already vendored in three; a
   compute pass selecting cluster LODs by screen-space error is the natural
   next step. Note that Nanite's software rasteriser is *not* reachable: it
   needs 64-bit atomics, which WebGPU does not have.
