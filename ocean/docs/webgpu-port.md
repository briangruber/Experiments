# The WebGPU port: architecture

WebGPU first, WebGL2 as the fallback, and simple to use from a Three.js project.
This is how, and why this shape rather than another.

Read [backend-decision.md](backend-decision.md) first if you want the
performance context. Short version: the measured speed win is under 1 fps, so
**this port is not about frame rate.** It is about Three.js moving to WebGPU,
about compute unlocking things WebGL2 cannot do at all (GPU-side buoyancy for a
fleet of objects, far larger spectra), and about WebGL2's long deprecation arc.
Judging it by frame rate would be judging it against a goal it does not have.

---

## The decision: build on `THREE.WebGPURenderer`

Not a hand-rolled dual backend. `WebGPURenderer` already *is* both things asked
for:

- It ships a `WebGPUBackend` and a `WebGLBackend` and picks between them, so the
  fallback is the renderer's job rather than ours.
- It is Three.js, so "works simply with Three.js projects" stops being an
  integration problem and becomes the default.

The alternative — our own abstraction over raw WebGPU and raw WebGL2 — means
writing and maintaining the fallback ourselves, and leaves the Three.js story
exactly where it is today: an adapter borrowing a context.

## The shader problem, and the way through it

The shaders are the asset: ~170 KB of GLSL carrying the spectrum, the water
BRDF and the cloud march. A port stands or falls on what happens to them.

There is **no usable GLSL→WGSL transpiler** to lean on. Checked: `naga` on npm
is not the Rust crate, `@webgpu/glslang` only reaches SPIR-V, and the rest do not
exist. So the source has to be handled deliberately.

Three strategies, and what each costs:

| | cost | risk |
| --- | --- | --- |
| Rewrite everything as TSL node graphs | total rewrite before *anything* runs | very high — physics re-expressed in an unfamiliar form, all at once |
| Hand-write WGSL and keep GLSL, unlinked | two shader sets that drift | high |
| **TSL for structure, raw shader source for the dense cores** | WGSL written once per function | low — function at a time, each verifiable |

The third is what this port does, and the probe confirms it works.

**`wgslFn` and `glslFn` both exist**, so a node can be backed by raw source. The
existing GLSL is reused *verbatim* on the WebGL path — which is why the fallback
cannot regress, it is running the code that already shipped — and only the WGSL
has to be written. That is a mechanical translation, done one function at a
time, and each one can be checked by running both backends and comparing
numbers.

## What the probe established

`prototypes/tsl-backend-probe.html`, via
`node tools/run-probe.mjs prototypes/tsl-backend-probe.html`:

```
PASS  three/webgpu and three/tsl import                    638 TSL exports
PASS  TSL escape hatches and control flow                  wgslFn, glslFn, Fn, storage,
                                                           instancedArray, instanceIndex,
                                                           texture, textureStore,
                                                           workgroupArray, workgroupBarrier,
                                                           atomicAdd, Loop, If
PASS  WebGPURenderer initialises (auto)                    backend: WebGPU
FAIL  TSL material renders on WebGPU                       see "known environment issue"
PASS  TSL COMPUTE runs on WebGPU                           [1,4,7,10,13,16]
PASS  WebGPURenderer falls back with forceWebGL            backend: WebGL2
PASS  TSL material renders on WebGL2
PASS  TSL COMPUTE runs on WebGL2                           [1,4,7,10,13,16]
PASS  Both backends agree numerically
PASS  wgslFn: raw WGSL runs and matches a CPU reference
```

**The load-bearing result is that TSL compute runs on the WebGL2 backend too.**
WebGL2 has no compute shaders; Three emulates them. That was the fact the whole
architecture turned on, because if compute had been WebGPU-only the ocean
simulation would have needed two separate implementations and two separate sets
of bugs. It does not. One compute kernel, both backends, numerically identical.

`workgroupArray` and `workgroupBarrier` are present, which is what the
shared-memory FFT — the one measured 3.96× win — actually needs.

### Known environment issue

The single failure is `createView` rejecting a `swizzle` property in
`GPUTextureViewDescriptor`. That is Three r185 calling a newer WebGPU surface
than this sandbox's Chromium 141 implements, on the **render** path only —
compute runs on the same device in the same process. It is a version skew, not
an architectural limit, and it does not appear on a current desktop Chrome.

Worth knowing because it means **the WebGPU render path cannot be verified
headlessly here.** Compute can. Until the sandbox's Chromium catches up with
Three, WebGPU rendering has to be checked on a real browser, and the WebGL2
backend is the one the automated checks can cover.

## Plan

Each phase leaves the tree working. The existing raw-WebGL2 renderer in `src/`
keeps running the demo throughout and is not touched until the end, so there is
always something that works.

1. **Foundation.** `src/gpu/renderer.js`: create a `WebGPURenderer`, report the
   backend it landed on, expose it to the demo and to host applications.
2. **Ocean simulation → TSL compute.** The FFT cascades, spectrum and foam.
   Verified by running the existing `Ocean` and the new one on the same seed and
   parameters and diffing the displacement fields. This is the phase with a real
   payoff on WebGPU, and it is testable headlessly on both backends.
3. **Sky.** Atmosphere LUT and the cloud march, as `wgslFn`/`glslFn` pairs.
4. **Water surface.** A real `THREE.Mesh` with a `NodeMaterial` — the point at
   which Three's fog, shadows and tone mapping start applying to the sea, which
   the current adapter cannot offer.
5. **Spray, wake, post.**
6. **Switch the demo over**, and reduce `src/three/` from an adapter to a thin
   convenience layer over what is by then native.

Sequencing note: WebGPU and WebGL2 cannot share a canvas or a device, so there
is no half-ported frame — a phase is not "done" until its stage runs on the new
renderer. Phases 2–5 are therefore developed against the probe harness and the
equivalence tests rather than against a running demo, and the demo moves in one
step at phase 6.


---

## Correction: raw WGSL cannot be driven through TSL

Measured after the kernels were written, by `prototypes/wgslfn-storage-probe.html`.
This changes the plan, and it reverses something stated above.

**`wgslFn` does not accept `ptr<storage, ...>` parameters.** Three's only pointer
concept is `pointerNode`, and that is for atomics — there is no general
storage-pointer parameter in the node system. The probe confirms it from both
ends:

```
WebGPU: vec4 storage fill                 PASS
WebGPU: vec4 storage readback             PASS
WebGPU: wgslFn with ptr<storage> params   ran without error, wrote NOTHING
WebGL2: wgslFn with ptr<storage> params   throws (isStorageInstancedBufferAttribute)
```

The silent zero-write on WebGPU is the dangerous half: no exception, no warning,
a kernel that appears to run and does nothing. Only comparing against a CPU
reference caught it.

So the earlier claim that "TSL compute runs on both backends, therefore one
implementation serves both" is true only for kernels written as **pure TSL node
graphs**. It is not true for raw WGSL, which is what the physics is written in.

### What this means for the five kernels

They are not wrong — all six modules compile clean. They are simply not
drivable the way this document assumed.

And the assumption that needed correcting is the opposite of the one flagged:
the four kernels that declare their own `@group`/`@binding` are in the **right**
shape, because they are driven directly on the device. It is `INIT_SPECTRUM_WGSL`,
written as a `wgslFn` snippet, that has to be converted to a raw module like its
siblings.

### Revised architecture

| | simulation | surface, sky, post |
| --- | --- | --- |
| WebGPU | the raw WGSL compute modules, dispatched on `renderer.backend.device` | TSL node materials |
| WebGL2 fallback | the existing GLSL fragment pipeline, unchanged | TSL node materials |

Two simulation implementations, which is what the original architecture was
trying to avoid. It is still the right trade, for a reason the measurements
already established: the fallback implementation **already exists, already
ships, and is the reference the port is being checked against**. The alternative
— rewriting the spectrum, the FFT, the assembly and the foam as TSL node graphs
so one source serves both — is a full re-expression of the physics in an
unfamiliar form, to buy a path that currently works, for a measured saving of
under 1 fps.

The shared-memory FFT stays WebGPU-only regardless. That was always true:
`var<workgroup>` has no WebGL2 equivalent, and the stage-wise kernel is the
portable one.
