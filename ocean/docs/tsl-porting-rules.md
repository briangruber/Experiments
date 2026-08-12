# Porting this project's GLSL to TSL

Rules learned by porting the simulation and the sky, every one of them from a
defect that actually happened. They are ordered by how badly they fail: the ones
at the top compile, run, and produce a wrong image.

The test of a port is a rendered image diffed against the shipping WebGL2 path,
not a compile. Two of the three defects below compiled perfectly on both
backends.

---

## 1. `.mix()` puts the object in a different slot than `.smoothstep()`

This is the worst one, because both read naturally and only one is what you
expect.

```js
smoothstepElement = ( x, low, high ) => smoothstep( low, high, x )   // object = VALUE
mixElement        = ( t, e1, e2 )    => mix( e1, e2, t )             // object = FACTOR
```

So `x.smoothstep(lo, hi)` is GLSL's `smoothstep(lo, hi, x)` — fine. But
`col.mix(target, alpha)` is **`mix(target, alpha, col)`**, not
`mix(col, target, alpha)`. It compiles, it runs, and it blends by the wrong
variable.

**Rule: never use `.mix()`. Always the standalone `mix(a, b, t)`,** whose
argument order is GLSL's.

Cost when missed: a cirrus veil drawn at nearly full strength with an alpha of
0.0008, because `col` was the blend factor.

## 2. `min`/`max` with a scalar second operand breaks WebGL2 only

`MathNode.generate` has a WebGL-only special case that forces a scalar second
operand of `min`/`max` to be built as `float`:

```js
steps.mul( int( 4 ) ).min( int( 256 ) )     // -> min(nodeVar23 * 4, 256.0) into an int
```

GLSL ES 3.00 has no `min(int, float)` overload, so the fragment shader fails to
compile — on WebGL2, while WebGPU is perfectly fine. Go through float and cast
back:

```js
int( float( steps ).mul( 4.0 ).min( 256.0 ) )
```

## 3. Screen v is upside down relative to this project's GLSL, on both backends

`screenUV` is `screenCoordinate / screenSize`, and `ScreenNode.generate` flips
`screenCoordinate` when `builder.isFlipY()` — true for `GLSLNodeBuilder`, false
for `WGSLNodeBuilder`, precisely so the two agree on WebGPU's top-down
convention. So **`screenUV.y = 0` is the TOP on both backends.**

This project's `FS_VERT`/`FS_VERT_FAR` set `vUv = a_pos*0.5+0.5`, so v = 0 is the
BOTTOM, and `gl_FragCoord` is bottom-up too. Exactly one flip is needed.
`glScreenUV()` and `glFragCoord()` in `src/gpu/tsl/sky-background.js` are that
flip; use them rather than flipping again downstream.

Measured in `prototypes/screenuv-probe.html`.

## 4. Sampling a render-target texture flips v on WebGL and not on WebGPU

`TextureNode.setupUV` flips v when `builder.isFlipY()` **and** the texture is a
render target (`texture.isRenderTargetTexture === true`).

Combined with framebuffer orientation — row 0 is the bottom under GL, the top
under WebGPU — the two flips **cancel** if a fullscreen bake writes with
`screenUV`. That is why the sky LUT round-trips on both backends from one code
path. `PlaneGeometry(2,2)`'s `uv()` is the opposite convention and is wrong on
both.

See the header of `src/gpu/tsl/sky-driver.js` for the full trace.

## 5. Things that are NOT problems

Checked, because each looked like one:

- **`atan(y, x)`** — TSL emits `atan(y,x)` on GLSL and `atan2(y,x)` on WGSL, so
  the branch cut is the platform's and matches.
- **`select(cond, a, b)`** — argument order is what it looks like.
- **`.smoothstep(lo, hi)`** — correct, see rule 1.
- **Precision** — `+61.7` style offsets inside noise fbm are fine; the cloud
  field uses the same pattern and matches bit-exactly.
- **`fwidth`** — exported (`MathNode.FWIDTH`) and equals the GLSL's.

## 6. Structural translations

- **`out` parameters do not exist.** Pack into a return vector; the GLSL's early
  `return 0.0` paths become the zero vector. See `cirrusLayer`.
- **`break` / `continue` do not translate.** A `continue` at the top of a loop
  body is an `If` around the rest of the body. A `break` becomes a `done` int
  flag every later iteration tests — value-equivalent, but the loop still spins
  to its bound, which costs. `Break()` exists in r185 but is unexercised here.
- **No `bool` locals.** Use `int` 0/1 vars and compare with `.equal(int(0))`.
- **Small fixed loops are unrolled in JS** when the index only picks
  compile-time constants (the star lattice, the light cone). Bit ops on a loop
  counter are not exercised on both backends.
- **Snapshot loop-carried reads with `.toVar()`** before a branch can change
  them, where the GLSL read them at the top of the iteration.
- **No `wgslFn` / `glslFn`, ever.** A raw-source node compiles for exactly one
  backend and puts the fallback back where it started.

## 7. Uniform ownership

The GLSL shares one uniform block per concern across programs
(`ATMOSPHERE_GLSL`, `CASCADE_COMMON`, ...). The TSL modules mirror that: each
module owns its uniforms and exports one `setXUniforms(p, ctx)`. A driver calls
all of them. Do not redeclare a uniform another module owns — import it.

## 8. How to verify

1. Render the shipping WebGL2 path at a fixed rig into linear HDR, before any
   tonemapping, and save every pixel. (`prototypes/sky-golden.html`)
2. Render the TSL path at the same rig, same params, same fingerprint shape.
   (`prototypes/sky-tsl.html`)
3. Diff with `tools/compare-image.mjs` — distribution within 1%, 99th percentile
   of per-pixel error within 2%.
4. **Ablate on both sides at once** when it mismatches. `?set=cirrus:0` applied
   to both probes cleared five modules in one run and localised the defect to
   one function.
5. When ablation runs out, transcribe the GLSL function to CPU JS and compare
   numbers. That is what proved `cirrusLayer` was right and the blend was wrong.
6. Compile-check both backends (`prototypes/tsl-sky-compile-probe.html`), and
   confirm the check can fail by reverting the fix.

---

## 9. The simulation can be three-native on both backends — as a fragment ping-pong

TSL **compute** does not work on the WebGL2 backend at all
(`prototypes/tsl-mechanics-probe.html`: 4/4 mechanics fail, one inside three
itself). So a compute-only simulation cannot serve the fallback.

A fragment ping-pong can. `prototypes/tsl-pingpong-probe.html` runs dependent
passes over swapped float render targets with a gather at a computed index, and
matches a CPU reference to 5e-7 on **both** backends, with multiple render
targets working on both. That makes the WGSL compute path an optimisation rather
than a requirement.

Two things it takes to get right, both measured:

- **Index in `uv`, never `screenCoordinate` + `.load()`.** `screenCoordinate` is
  already y-flipped on WebGL by `ScreenNode.generate`, and `TextureNode.setupUV`
  flips *again* for a `.load()` on a render-target texture
  (three.webgpu.js:12690). The two compose into a double flip and silently
  permute the field — worst error 1.5e+1 on both backends. Expressed in `uv`, the
  destination and the sampler are transformed the same way and the flips cancel,
  for the same reason the sky LUT round-trips. Use `NearestFilter` so a sample is
  a texel fetch.
- **`uv` row 0 is the NDC top; the readback's row 0 is the bottom.** They differ
  by a flip, consistently on both backends.

## 10. WebGPU readback needs a 256-byte row pitch

`readRenderTargetPixelsAsync` does not compensate for WebGPU's row-pitch rule. On
a target whose row is not a multiple of 256 bytes it returns the padded buffer
read at the unpadded stride, so rows interleave with padding. It does not throw.
Measured on an 8×8 RGBA32F target (128-byte rows), the row indices came back
`[0,0,1,0,2,0,3,0]` instead of a permutation — a plausible-but-wrong field.

Every real target here clears the bar (references are 160 wide = 2560 bytes; the
FFT is 128 or 256). `prototypes/readback.js` now throws rather than let a probe
at a small size mislead someone.

---

## 11. A texture's filter state is part of the SHADER on WGSL

`WGSLNodeBuilder.isUnfilterable` (three.webgpu.js:79067) is true when `minFilter`
**and** `magFilter` are both `NearestFilter`, and `generateTextureLevel` then
emits `textureLoad(...)` instead of `textureSampleLevel(...)`. That choice is
made when the node graph is **built**, from whatever texture is bound at that
moment — not at draw time, and not per draw.

So a placeholder texture is not inert. `DataTexture` and `DataArrayTexture`
default to `NearestFilter`; a material built before the real fields are bound
bakes an unfiltered nearest-texel fetch into the shader and keeps it forever
after. WebGL2 resolves the sampler per draw and is unaffected — the
"compiles on both, wrong on one" class again.

**Rule: give every placeholder the real resource's filter, wrap and mip state.**

`isUnfilterable` also fires for `FloatType` when the `float32Filterable` feature
is absent, which is worth knowing before choosing a target format.

## 12. Anisotropy is not a quality knob when matching a reference

`src/ocean.js` builds slope and foam with `aniso: 8`. Re-uploading those fields
without it left the *distribution* matching to 0.15% while **27% of pixels** were
beyond 2%: at grazing incidence — most of a seascape — an isotropic mip fetch
averages the wrong footprint. Setting `texture.anisotropy = 8` took the same
frame to 0/16000.

## 13. Per-frame uniforms belong to the frame, not to whoever declared them

`uCamPos`, `uTime` and `uWindDirV` live in `cloud-field.js` because the cloud
field needed them first, but the water stages read all three. The water driver
did not call `setCloudUniforms`, so:

- with the sky drawn first, the sea was pixel-exact (the sky's setter had
  already written them);
- with the sea drawn first, `uCamPos` was still `(0,0,0)`, every view vector was
  computed from the origin, and the near sea came back **4.5× too bright**.

Correct in one draw order and wrong in the other, silently. **Every driver must
set every uniform its stages read, including ones another module declares.**

## 14. A fullscreen pass that must sit BEHIND geometry needs `vertexNode`

`QuadMesh` renders through `OrthographicCamera(-1, 1, 1, -1, 0, 1)` with its
geometry at z = 0, which lands at the **near** plane — so a sky drawn after the
sea paints straight over it. (It comes back at exactly the sky reference's mean
radiance, which reads as "the water is black" rather than "the water was
overwritten".) Nudging the mesh toward the far plane trades one wrong depth for
another.

`QuadGeometry`'s positions are already the NDC fullscreen triangle
`[-1,3, -1,-1, 3,-1]` — the same triangle this project's `Blitter` uses — so
reproduce `FS_VERT_FAR` directly and bypass that camera:

```js
material.vertexNode = vec4( positionGeometry.x, positionGeometry.y, 1.0, 1.0 );
```

`z = w = 1` is the far plane under both GL's `[-1,1]` and WebGPU's `[0,1]` depth
conventions. This is what keeps the cloud raymarch — the most expensive thing in
the frame — off the half of the screen that is sea.

## 15. `renderer.autoClear` defaults to true

Every `renderer.render()` and every `QuadMesh.render()` clears the bound target
first. A multi-pass frame needs `renderer.autoClear = false` and one explicit
`renderer.clear()`.

## 16. WebGPU here draws but cannot PRESENT

In this headless sandbox, WebGPU renders into render targets correctly and fails
the moment anything targets the canvas swapchain:

```
A valid external Instance reference no longer exists.
```

`prototypes/webgpu-canvas-probe.html` narrows it to one quad with no app
involved: the same renderer draws into a `RenderTarget` (exact result) and then
drops the device presenting the identical draw to the canvas. WebGL2 does both.

So it is the sandbox, not the port — but it does mean **anything that only
presents is unverifiable here**. `boot()` therefore takes an `output` target, and
`prototypes/three-app-smoke.html` captures into it: every pass of the pipeline
runs, and only the swapchain blit is skipped.
