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
