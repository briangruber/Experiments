# The wave simulation in compute: what the driver owes the kernels

Five WGSL kernels now sit in [`src/gpu/kernels/`](../src/gpu/kernels/). There is
no driver yet. This is the contract that driver has to satisfy, and the argument
for how we will know it is right.

Read [webgpu-port.md](webgpu-port.md) for why the port is shaped this way. Read
[`src/shaders/oceanSim.js`](../src/shaders/oceanSim.js) and
[`src/ocean.js`](../src/ocean.js) before changing anything here: they remain the
source of record, and every kernel is a translation of one of them.

| file | export | form | replaces |
| --- | --- | --- | --- |
| `spectrum.js` | `INIT_SPECTRUM_WGSL` | `wgslFn` snippet, `fn initSpectrum(...) -> void` with `ptr<storage,...>` params | `INIT_SPECTRUM_FS` |
| `evolve.js` | `TIME_EVOLVE_WGSL` | full module, `@group(0)` bindings, `@workgroup_size(8,8,1)` | `TIME_EVOLVE_FS` |
| `fft.js` | `FFT_STAGE_WGSL`, `FFT_SHARED_WGSL`, `FFT_WGSL` (= stage) | full modules; shared one is `@workgroup_size(256,1,1)` + `var<workgroup>` | `FFT_FS` |
| `assemble.js` | `ASSEMBLE_WGSL` | full module, `@workgroup_size(8,8,1)` | `ASSEMBLE_FS` |
| `foam.js` | `FOAM_WGSL` | full module, `@workgroup_size(8,8,1)` | `FOAM_FS` |

**Two shapes, deliberately.** `INIT_SPECTRUM_WGSL` is a `wgslFn` body, because it
is a plain per-texel function and TSL can bind its parameters directly. The other
four declare their own bind groups, because `FFT_SHARED_WGSL` needs
`var<workgroup>` and `@builtin(local_invocation_id)`, which do not survive
`wgslFn`'s function wrapping - and once one kernel is a raw module it is less
confusing for its siblings to be too. The driver has to drive both, or rewrap the
spectrum kernel as a module (its header explains the two parser constraints that
apply if you keep it as `wgslFn`: the string must start with `fn initSpectrum(`
and the parameter list must contain no parentheses).

---

## 1. Pass order, buffers, and where the races are

### The buffers

At the shipping configuration, `N = 256`, `C = 4` cascades, `stages = log2(N) = 8`.
Everything is `array<vec4<f32>>`. Level-0 indexing is the rule stated at the top
of every kernel:

```
idx = layer * N * N + y * N + x
```

| buffer | elements | bytes | lifetime | written by | read by |
| --- | --- | --- | --- | --- | --- |
| `noise` | `C*N*N` = 262144 | 4 MiB | per seed | CPU (`mulberry32`/`gauss2`) | spectrum |
| `butterfly` | `stages*N` = 2048 | 32 KiB | per `N` | CPU (`butterflyData`) | fft |
| `h0` | `C*N*N` | 4 MiB | per rebuild | spectrum | evolve |
| `pingA`, `pingB` | `C*N*N` each | 4 MiB each | per frame, transient | evolve, fft | fft, assemble |
| `pongA`, `pongB` | `C*N*N` each | 4 MiB each | per frame, transient | fft | fft |
| `disp` pyramid | 349524 | 5.33 MiB | per frame | assemble (level 0), reduction (1..8) | foam, render |
| `slope` pyramid | 349524 | 5.33 MiB | per frame | assemble (level 0), reduction | foam, render |
| `foam[0]`, `foam[1]` pyramids | 349524 each | 5.33 MiB each | per foam step, alternating | foam (level 0), reduction | foam, render |

About 45 MiB total. That is roughly double what the GL path holds, because the
storage-buffer contract makes `slope` and both `foam` targets f32 where
`_buildTargets()` created them `RGBA16F`. Section 3 explains why that costs
accuracy in the comparison but not in the physics.

**The butterfly buffer is the one exception to the indexing rule.**
`butterflyData(N)` writes at `(y * stages + s) * 4`: the table is `stages` wide and
`N` tall, so `bf = butterfly[axis * uStages + uStage]`. It has no layer - one
table serves every cascade. Upload `butterflyData(N).data` unchanged; the wing
sign lives in the twiddle and stage 0's `.z`/`.w` carry the bit-reversal
permutation, both of which the FFT kernels depend on.

**Pyramid layout** (only `disp`, `slope`, `foam` need it - the foam kernel is the
only pass that filters, and it filters all three):

```
S(l)           = max(N >> l, 1)
levelBase(0)   = 0
levelBase(l+1) = levelBase(l) + C * S(l) * S(l)
idx            = levelBase(l) + layer*S(l)*S(l) + y*S(l) + x
```

Level 0 of a pyramid is byte-for-byte the plain rule, which is what lets the
assemble kernel write straight into it and the foam kernel's output be the level
0 of the next foam pyramid. At `N = 256` there are 9 levels (`floor(log2 N) + 1`,
matching `texStorage3D` in `gl.js`), the last one 1x1, and 87381 elements per
layer.

### The frame

```
if (dirty) {
  for c in 0..C-1:  dispatch spectrum(c)      // h0
  spinUp = 30
}

for c in 0..C-1:
  dispatch evolve(c)                          // h0 -> pingA, pingB
  fft(c)                                      // see below
  dispatch assemble(c)                        // -> disp[level0], slope[level0]

foamDt = min(dt * timeScale, 0.1)
for s in 0..spinUp:                           // spinUp+1 iterations
  step = (s < spinUp) ? 0.3 : foamDt
  for c in 0..C-1: dispatch foam(c, step)     // foam[i] -> foam[1-i][level0]
  reduce foam[1-i]                            // levels 1..8, EVERY step
  i = 1 - i
spinUp = 0

reduce disp                                   // levels 1..8
reduce slope                                  // AFTER the foam loop - see below
```

That is `ocean.js:update()` transcribed. Three orderings in it are load-bearing:

1. **The foam loop is separate from the cascade loop.** Every cascade's breaking
   test reads the displacement of its own cascade at a mip, so every assemble must
   have run before any foam step does.
2. **The foam pyramid is rebuilt after every step, spin-up steps included.** The
   scale-free threshold reads `<x^2>` off the 1x1 top mip of the field the previous
   step wrote (`sampleLod(SRC_FOAM, layer, uv, 32.0).w`). Skip the reduction on
   spin-up steps and the threshold has no normaliser for 30 of the 31 iterations.
3. **`disp` and `slope` are reduced after the foam loop, not before it.** This is
   the one place where the obvious engineering is wrong for fidelity: `ocean.js`
   calls `generateMipmap` at the end of `update()`, so every level above 0 that
   `foldAt()` reads is *one frame stale*, and on the first frame after a rebuild it
   is a never-populated chain. Reducing eagerly changes the foam field. It probably
   changes it for the better. It is still a behaviour change, it will fail the
   fingerprint, and it belongs in its own commit rather than smuggled in under a
   port. Match the GL ordering first, prove the port, then change it deliberately.

Consequence of (3): the pyramid levels above 0 must be **zero-initialised at
allocation**. `texStorage3D` gives GL defined-but-unspecified contents that in
practice read as zero, and the first foam step reads exactly those levels.

### The FFT schedule and its parity

Per cascade, `2 * log2(N)` dispatches with `FFT_STAGE_WGSL`: `log2(N)` at
`uVertical = 0`, then `log2(N)` at `uVertical = 1`, swapping `(src0,src1)` with
`(dst0,dst1)` after each. 64 dispatches per frame at `N = 256, C = 4`.

`FFT_SHARED_WGSL` replaces the whole inner loop with **two** dispatches per
cascade - one per direction, `(N, 1, 1)` workgroups of 256 threads each - because
one workgroup carries a whole line through all `log2(N)` stages in shared memory.
8 dispatches per frame instead of 64. That is the 3.96x measured on an M4 Max.

**The result always lands in `ping`.** The pass count is `2 * log2(N)`, which is
even for every `N`, so an even number of swaps returns `srcA/srcB` to
`pingA/pingB` - and the last pass wrote there. The same is true of the shared
kernel's two dispatches. So `assemble` can hard-bind `pingA`/`pingB` as `src0`/`src1`
rather than tracking the swap; `assemble.js`'s header warns you to bind "whichever
pair the ping-pong ended on", and the answer is always the ping pair. Getting this
wrong reads a half-transformed field, which looks like a plausible but wrong ocean.

There is no `1/N^2` scaling anywhere. The GLSL has none either; the only
post-processing is the `(-1)^(x+y)` sign the assemble pass applies.

### What must be double-buffered, and why

| pass | reads | writes | race? |
| --- | --- | --- | --- |
| spectrum | `noise` (read-only) | `h0` at own idx | no |
| evolve | `h0` (read-only) | `ping{A,B}` at own idx | no |
| fft (stage) | `src{0,1}` across the line | `dst{0,1}` at own idx | **yes if in place** |
| fft (shared) | `src{0,1}`, one line per workgroup | `dst{0,1}`, the same line | safe in place, but keep ping-pong |
| assemble | `ping{A,B}` (read-only) | `disp`, `slope` at own idx | no |
| foam | `foam[i]` at neighbours **and its 1x1 top mip** | `foam[1-i]` at own idx | **yes if in place** |

Two hard requirements:

**The FFT stage kernel must ping-pong.** A butterfly gathers from `bf.z` and
`bf.w`, positions anywhere along the transform axis - the read set of an
invocation is not its write set, and within a stage some invocation will read a
texel another has already overwritten. There is no barrier at that granularity in
a dispatch.

**The foam pass must ping-pong.** It reads its own previous field at `uv - duv`,
at four diffusion taps around that, and - decisively - at LOD 32, which is a
reduction over the *whole* previous field of the layer. Writing in place makes the
result depend on workgroup scheduling and the normaliser a reduction over a
half-updated field. A fragment pass got this for free, because you cannot bind a
render target as a texture. Compute does not. `foam[0]`/`foam[1]` and a `foamIdx`
flip, exactly as `ocean.js` has it.

The shared FFT kernel could legitimately run in place - a workgroup's read set is
exactly its write set, and no two workgroups touch the same line - but WebGPU
validation rejects binding one buffer as both `read` and `read_write` in a bind
group, and keeping the ping-pong costs nothing.

### The per-cascade loop

Every pass is dispatched once per cascade with `uLayer` rebound, because `uL`,
`uKLow`, `uKHigh`, `uChoppy`, `uKChar` and `uWeight` are per-cascade scalars. All
`C` cascades could collapse into one dispatch using the z dimension - but only if
those six become `vec4` arrays indexed by layer, the way `uPatch` and `uCompLod`
already are in `FoamParams`. That is a worthwhile follow-up and it is not free:
it changes five uniform block layouts. Ship the loop first.

Dispatch sizes: `ceil(N/8) x ceil(N/8) x 1` for spectrum, evolve, assemble and
foam (32x32 at `N = 256`); the FFT kernels as above. Every kernel carries a
`gid >= N` bounds guard because a padded dispatch would otherwise store into the
next row or the next layer - a fragment pass got its bounds from the viewport.

### The reduction kernel does not exist yet

Nothing in `src/gpu/kernels/` replaces `generateMipmap`. It has to be written, and
it has exactly one constraint that matters: **plain 2x2 box averages, level by
level.** Not a Gaussian, not a weighted downsample. `generateMipmap` on a
power-of-two texture is a box filter, and the foam kernel's LOD-32 reads are used
as *means* - `cvar` is `<x^2>` over the tile and `rms` is `<|grad h|^2>`. Anything
else silently changes the breaking threshold's normalisation.

Budget note: naively that is `log2(N) = 8` dispatches per pyramid per frame, and
during a 31-step foam spin-up, `31 * (4 + 8) = 372` dispatches in a single frame.
The GL path paid the same cost inside `generateMipmap`; it is a hitch after a
parameter change, not a steady-state cost.

---

## 2. Uniforms, and how often each one moves

Four cadences:

- **static** - fixed once `N` and the cascade list are chosen. Upload at
  allocation and never again. Changing `fftSize` reallocates everything anyway.
- **per rebuild** - changes only when the spectrum is rebuilt (`ocean.dirty`),
  which `demo/schema.js` marks with `rebuild: true` on 17 controls.
- **per frame** - re-uploaded every `update()`.
- **per dispatch** - `uLayer`, `uStage`, `uVertical`; changes inside the frame.

### spectrum - `INIT_SPECTRUM_WGSL`

20 floats plus `uLayer`, plus two buffers. Bind `uNoise` read-only and `h0`
read_write, matching the pointer access modes in the signature.

| uniform | source in `ocean.js` | cadence |
| --- | --- | --- |
| `uN` | `this.N` | static |
| `uL` | `this.L[c]` | static |
| `uKLow`, `uKHigh` | `bandLimits(c)` | static |
| `uLayer` | `c` | per dispatch |
| `uWindSpeed`, `uFetch`, `uWindDir`, `uDepth` | `p.*` (`uWindDir` from `derive()`) | per rebuild |
| `uSpread`, `uSpreadTail`, `uAlignment` | `p.*` | per rebuild |
| `uGamma` | `p.peakEnhancement` | per rebuild |
| `uTailSat` | `p.tailSaturation` | per rebuild |
| `uSwellAmount`, `uSwellPeriod`, `uSwellDir`, `uSwellSpread`, `uSwellWidth` | `p.*` | per rebuild |
| `uAmplitude`, `uShortWaveFade` | `p.*` | per rebuild |

`uKLow`/`uKHigh` are static because `bandLimits(c)` reads only `this.L` and
`this.C`. The seed does not appear here at all - it lives in the `noise` buffer,
one layer per cascade. **The per-cascade noise must be indexed with `uLayer`**;
the GL path had four independent 2D noise textures and a port that reads layer 0
for every cascade gets four perfectly correlated cascades.

### evolve - `TIME_EVOLVE_WGSL`

`EvolveParams`, 32 bytes: `uN, uL, uTime, uDepth, uChoppy, uLoopPeriod : f32`,
`uLayer : u32`, `_pad : u32`.

| uniform | source | cadence |
| --- | --- | --- |
| `uN`, `uL` | `this.N`, `this.L[c]` | static |
| `uTime` | `this.time += dt * p.timeScale` | per frame |
| `uDepth` | `p.depth` | per frame (also a rebuild param) |
| `uChoppy` | `choppinessFor(c, p)` | per frame, per cascade |
| `uLoopPeriod` | `p.loopPeriod` | per frame |
| `uLayer` | `c` | per dispatch |

`uChoppy` is `p.choppiness * (1 + (p.choppyLong - 1) * t)` - a frame parameter and
a cascade parameter at once, so the block is rewritten for every one of the `C`
dispatches regardless.

### fft - `FFT_STAGE_WGSL` / `FFT_SHARED_WGSL`

`FFTParams`, 32 bytes, shared by both kernels: `uN : f32`, then
`uStages, uStage, uVertical, uLayer : u32` and three pad words.

| uniform | source | cadence |
| --- | --- | --- |
| `uN` | `this.N` | static |
| `uStages` | `this.stages` = `log2(N)` | static |
| `uStage` | `s` | per dispatch (stage kernel only; ignored by the shared kernel) |
| `uVertical` | `v` | per dispatch |
| `uLayer` | `c` | per dispatch |

`uStages` is new: the fragment path got the butterfly table's width from the
texture dimensions, a flat buffer has to be told. It is both the row stride of the
table and the stage count.

### assemble - `ASSEMBLE_WGSL`

`AssembleParams`, 32 bytes: `uN, uChoppy, uKChar, uStokes : f32`, `uLayer : u32`,
three pad words.

| uniform | source | cadence |
| --- | --- | --- |
| `uN` | `this.N` | static |
| `uKChar` | `kChar(c)` | static |
| `uStokes` | `p.crestSharpen` | per frame |
| `uChoppy` | `choppinessFor(c, p)` | per frame - **and deliberately unused** |
| `uLayer` | `c` | per dispatch |

`uKChar` reads only `bandLimits(c)`, `this.L` and `this.N`, so it is static.
`uChoppy` is declared and set because `ASSEMBLE_FS` declares and sets it, and the
GLSL body never references it either: the choppiness gain is already baked into
`D_x`, `D_z`, `dD_x/dx`, `dD_z/dz` and `dD_x/dz` by the evolve pass. Applying it
again squares up the horizontal displacement and folds the Jacobian far too early
- whitecaps everywhere. Leave it unused.

### foam - `FOAM_WGSL`

`FoamParams`, 112 bytes: two `vec4<f32>` then twenty scalar words, already a
multiple of 16, so it uploads as one 28-word block with no interior padding.

| uniform | source | cadence |
| --- | --- | --- |
| `uPatch` | `patchSizes` (`vec4`) | static |
| `uN`, `uL` | `this.N`, `this.L[c]` | static |
| `uCascadeCount` | `this.C` | static |
| `uCompLod` | `breakLods(p.foamBreakScale)` (`vec4`) | per frame |
| `uCutoff` | `probit(whitecapFraction(...) * ACTIVE_SHARE / GATE_PASS)` | per frame |
| `uDt` | `0.3` during spin-up, else `min(dt*timeScale, 0.1)` | **per step** |
| `uWeight` | `FOAM_WEIGHTS[c]` | static, per cascade |
| `uSoft, uFaceBias, uDecay, uFreshDecay, uInject, uSpreadRate, uThin` | `p.foam*` | per frame |
| `uDrift, uBreakScale, uCrestAniso, uRidge, uBreakup` | `p.foam*` | per frame |
| `uWindDir` | `p.windDir` | per frame |
| `uLayer` | `c` | per dispatch |

Three things here bite:

- **`uCascadeCount` was dead in the GLSL.** `FOAM_FS` declares it and never
  references it, so `gl.js`'s `setUniforms` skipped it silently (`if (!info)
  continue`). Here it is the layer stride of every mip level above 0. A driver that
  leaves it zero gets a pyramid where every LOD resolves to level 0, a breaking
  test with no normaliser, and foam that looks *nearly* right. Assert it is
  non-zero.
- **`uDt` changes within the frame**, not just between frames: 30 spin-up steps at
  `0.3` then one real step. The uniform block is rewritten `(spinUp+1) * C` times.
- **`uWindDir` is both a rebuild parameter and a per-frame foam uniform.**
  `windDirDeg` carries `rebuild: true`, so a change to it rebuilds the spectrum -
  but the foam block has to carry the current value every frame anyway.

`probit`, `whitecapFraction`, `ACTIVE_SHARE`, `GATE_PASS`, `FOAM_WEIGHTS`,
`breakLods` and `breakWeights` all stay on the CPU exactly as they are.

### One allocation note

`minUniformBufferOffsetAlignment` is 256 bytes. If you pack per-cascade blocks into
one buffer and address them with dynamic offsets - which is the sane thing to do
with a `C`-iteration loop - the stride is 256 bytes and a 32-byte `EvolveParams`
wastes 224 of them. Irrelevant at `C = 4`; worth knowing before someone
"optimises" it into a tight array and gets a validation error.

---

## 3. Proving it, and what tolerance is honest

The harness exists already, from commit `225cda3`. Nothing here needs inventing;
it needs wiring to the new driver.

```
prototypes/ocean-golden.html      captures a fingerprint from the WebGL2 sim
test/golden/ocean-64.json         the committed reference (N=64, 8 steps)
tools/compare-fingerprint.mjs     the comparator, with the tolerances baked in
tools/run-probe.mjs               runs a prototype page headlessly
```

The reference is `preset "Golden Hour Swell"`, `seed 1337`, `dt = 1/60`, 8 steps,
4 cascades, and it is **bit-reproducible run to run** - every channel diffs at
`0.00e+0`. That is the fact the whole tolerance argument rests on: the headroom
below is headroom for compiler differences, not cover for jitter, so any
difference the port shows is signal.

### What to run

1. **Write `prototypes/ocean-wgsl-golden.html`** emitting the identical JSON
   schema from the compute driver: same `config` block (the comparator's config
   guard bites on `N`, `steps`, `dt`, `preset`, `seed`, `cascades`), same readback
   of the `disp` field's four channels, same 256 samples on `stride = 7919 % (N*N)`,
   same `toFixed(6)`. Anything less and you are comparing different runs.
2. **Regenerate the golden at the shipping size too**:
   `node tools/run-probe.mjs "prototypes/ocean-golden.html?n=256&steps=8"`.
   `N = 64` exercises the strided loops in `FFT_SHARED_WGSL` (256 threads, only 32
   pairs of work per stage - correct, just idle), but `N = 256` is what ships and is
   what `LINE`/`WG` are sized for. `test/golden/` is committed; `test/out/` is
   gitignored.
3. **Run the WGSL path on both backends** - auto (WebGPU) and `forceWebGL`. Per
   `webgpu-port.md` the sandbox's Chromium cannot verify the WebGPU *render* path
   (the `createView` swizzle skew), but compute runs on both, which is the whole
   reason this phase is testable headlessly.
4. **Compare**: `node tools/compare-fingerprint.mjs test/golden/ocean-256.json
   test/out/wgsl-256.json`.

### The tolerances, and where they come from

`compare-fingerprint.mjs` holds three numbers:

| bar | value | on |
| --- | --- | --- |
| `STAT_TOL` | `1e-4` relative | mean / rms / min / max, per channel, scaled by rms |
| `SAMPLE_TOL` | `1e-3` relative | per texel |
| `SAMPLE_FAIL_FRACTION` | `0.005` | share of texels allowed past `SAMPLE_TOL` |

f32 carries ~1.2e-7 of relative precision. A 256-point FFT is 8 stages of
complex multiply-accumulate and its error grows like `sqrt(N)`, which puts the
floor around **2e-6 relative**. `1e-4` on statistics and `1e-3` per texel leave
roughly an order of magnitude and two of headroom over that floor, while still
catching every failure mode that matters - a dropped term, a flipped sign, a wrong
index all move things by *percent*.

The two checks fail differently, which is why there are two. Statistics catch a
lost normalisation or a missing term, which move the distribution but may leave
any single texel plausible. Samples catch a localised geometry error - a wrong
conjugate index, an off-by-one in the bit reversal, a bad wrap at the tile edge -
which barely moves the statistics at all. The commit proved both bite: a 0.5%
energy error fails on statistics, and a four-element sample shift, which leaves
the statistics untouched, fails on 1023 of 1024 texels.

### Why a bitwise match is the wrong bar

It would fail a correct port, and the response to a bar that fails correct work is
always to loosen it until it passes - which is worse than having no bar. Five
independent reasons it cannot hold across backends:

1. **Contraction.** Metal will fold `a*b + c` into an `fma` where the GLSL path did
   not. One contracted multiply-add in `cmul` changes the low bit, and the FFT then
   spends 8 stages amplifying it.
2. **Transcendentals.** `sin`, `cos`, `tanh`, `exp`, `pow`, `log` are
   implementation-defined to a few ULP in both GLSL ES and WGSL, and nothing
   requires the two to use the same polynomial. `cexp(w * uTime)` alone differs, on
   every mode, every frame.
3. **`inverseSqrt`.** `sqrt` is correctly rounded; `inverseSqrt` is not. The foam
   pass calls it three times per texel.
4. **Deliberate format changes.** `slope` and both `foam` targets were `RGBA16F` in
   `_buildTargets()` and are f32 here, because the porting contract for this
   directory is storage buffers of `vec4<f32>`. Half precision is ~5e-4 relative,
   so *the port is more accurate than the reference* on those fields and differs
   from it by construction. This is precisely why `SAMPLE_TOL` is `1e-3` and why the
   foam field cannot be held to the FFT's bar.
5. **Filter weights.** Hardware bilinear uses fixed-point subtexel weights -
   typically 8 bits - where `foam.js`'s hand-rolled `bilinear()` uses full f32. The
   foam pass takes eleven filtered samples per texel.

### Where bitwise *is* the right bar

Two places, and both are cheap and sharp:

- **`FFT_STAGE_WGSL` against `FFT_SHARED_WGSL`, same backend, same input.** One
  compiler, one arithmetic order, the same twiddles fetched from the same table,
  the same `t + w*b` per butterfly. The stage-0 permutation is folded into the load
  in one and into the table's `.z`/`.w` in the other, but that is the same gather of
  the same values. They must agree bit for bit; if they do not, one of them is
  wrong. The translator already established `0/262144` mismatches in a
  mutation-tested CPU simulation against the real `butterflyData` table - reproduce
  that as a node test rather than trusting a one-off.
- **A backend against itself.** The reference is bit-reproducible; so should the
  port be. A driver that is not run-to-run deterministic has an ordering bug -
  almost certainly a missing ping-pong.

### Stage the verification; do not debug five kernels at once

A whole-pipeline fingerprint tells you *that* something is wrong, not *where*. In
order, each stage isolating one kernel:

- **A. `h0` only.** Dispatch spectrum, read `h0` back, compare against a GL
  `readPixels` of `fbo.h0[c]`. No FFT, no time, no accumulation. Only `pow`, `exp`,
  `log`, `tanh` and `atan2` can differ - hold it to **1e-6 relative**. This catches
  the whole spectrum, the band limits, the Nyquist-line zeroing and the conjugate
  index in one shot.
- **B. Evolve at `uTime = 0`.** `cexp(0) = (1, 0)`, so `h = h0.xy + conj(h0.zw)` and
  every transcendental except `sqrt`/`tanh` drops out of the rotation. A pure
  algebra check on the packing and the eight derivative fields.
- **C. FFT on an impulse.** Zero the field, set one mode at a known `(kx, ky)`, and
  check the transform is a sinusoid of the right wavelength, amplitude and phase in
  the right direction. This is the check that catches a bit-reversal or axis-select
  error, which a full-field statistic averages into nothing.
- **D. Assemble.** The committed fingerprint, as-is. It reads attachment 0 of the
  assemble pass, so it covers A through D end to end.
- **E. Foam.** *The golden page does not cover this at all.* It needs its own
  fingerprint - `foam[foamIdx]` level 0 per cascade plus the 1x1 top mip - at a
  looser bar (**1e-2**), for the four reasons above plus the stale-mip ordering.
  Cross-check it against `measure()`: total `foam` coverage should land near
  `foamTarget`, which is `whitecapFraction()` and is independent of the port.

### Two things the harness must be shown to do

**It must be able to fail against the new driver.** The negative controls in
`225cda3` proved the comparator bites against the *GL* path; re-run them against
the WGSL one, or all you have proved is that the JSON parser works. Perturb
`uAmplitude` by 0.5% in the compute driver and confirm the statistics fail; shift
the sample walk by four elements and confirm 1023 of 1024 texels fail.

**It must reject a dead field.** `ocean-golden.html` already asserts
`stats[1].rms > 1e-5` per cascade before it will serve as a reference, because a
field of zeros matches a broken port perfectly. Keep that assertion in the WGSL
page too - it is the check that catches a driver that dispatched nothing.

---

## 4. What the verification pass found

Five units reviewed - spectrum, evolve, fft, assemble, foam. **Zero number-changing
defects.** Nothing was fixed because nothing was broken: every constant, sign,
clamp, guard, cast and index matches the GLSL expression for expression, and the
FFT was additionally mutation-tested at `0/262144` f32 mismatches against the real
`butterflyData` table.

What the review *did* surface is a set of deviations that change no numbers, and a
set of obligations that fall on the driver rather than on the kernels. Those are
listed below because "no defects" is not the same as "nothing to do", and every
one of these is a way the port can still come out wrong.

| unit | finding | class | status |
| --- | --- | --- | --- |
| spectrum | none | - | clean. Noise and `h0` linear indexing agree with the GL texel layout and with `evolve.js`. |
| evolve | written as a module with explicit bindings rather than a `wgslFn` snippet | form, not numbers | intentional - see §0 |
| evolve | `uLayer` `int` -> `u32` | representation | bit-identical for the non-negative `Int32Array` the driver writes |
| evolve | the `>= N` bounds guard is a no-op at an exact dispatch | dead code | kept: it is not dead for a padded dispatch |
| evolve | the 32-byte uniform block is correct by WGSL rules but **untested** | driver obligation | assert block size and field offsets once, in the driver |
| fft | `LINE = 256` hardcoded | limit | non-numeric at the shipped `N = 256`; blocks `N > 256` until raised |
| fft | in-place aliasing would be rejected by WebGPU validation | moot | the kept ping-pong makes it moot - do not remove it |
| assemble | `slope` stored f32 where GL used `RGBA16F` | mandated by the storage-buffer contract | verified it cannot clip or denormal at these magnitudes; bit-level drift, not a physics change |
| assemble | `uChoppy` declared and unused | faithful to `ASSEMBLE_FS` | **do not "fix"** - see §2 |
| assemble | mip reduction still owed | driver obligation | §1: the reduction kernel does not exist |
| assemble | ping-pong parity | driver obligation | §1: always lands in `ping` |
| foam | f32 vs `RGBA16F`, and f32 vs fixed-point filter weights | precision | expected; sets the `1e-3`/`1e-2` bars in §3 |
| foam | stale-mip ordering | driver obligation | §1(3): reduce `disp`/`slope` **after** the foam loop, or the port fails the fingerprint |
| foam | `uCascadeCount`, dead in the GLSL, is load-bearing here | driver obligation | §2: assert it is uploaded and non-zero |

Three of those obligations are the ones most likely to be got wrong, because each
is something the fragment pipeline supplied for free and compute does not: the mip
reduction (`generateMipmap`), the read-write separation on foam (a render target
cannot be bound as a texture), and the stale-mip ordering (an accident of where
`generateMipmap` sat in `update()` that the foam physics has been tuned against).
