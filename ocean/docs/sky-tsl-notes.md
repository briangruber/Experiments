# The sky in TSL: driving it, and proving it right

The five modules under `src/gpu/tsl/` are the sky's physics re-expressed as node
graphs, so one source compiles to WGSL on WebGPU and GLSL on WebGL2 and Three's
backend fallback covers the shaders as well as the renderer
([webgpu-port.md](webgpu-port.md)). They are libraries, not passes. Nothing in
them creates a material, a render target or a draw call.

This document is the missing half: how a driver assembles them into the two
passes `src/sky.js` runs today, what every uniform is against its source
expression, and what counts as proof that the port draws the same sky.

Read alongside [webgpu-port.md](webgpu-port.md) (why TSL at all) and the module
headers, which carry the per-function reasoning and are not repeated here.

---

## 0. What exists, and what a driver still has to write

| module | ports | status |
| --- | --- | --- |
| `noise.js` | `NOISE_GLSL` + `remap01`, `spread01`, `bayer4` | complete |
| `atmosphere.js` | `ATMOSPHERE_GLSL` | complete |
| `sky-lut.js` | `SKY_LUT_MAP_GLSL` + `SKY_LUT_FS` main | complete |
| `cloud-field.js` | `SKY_BG_FS`'s density field | complete |
| `cloud-march.js` | `SKY_BG_FS`'s march and lighting | complete |

**So the LUT pass can be assembled today and the background pass cannot.** Of
`SKY_BG_FS`, everything from `discAngle` down to `main()` is still GLSL only:

`discAngle`, `refractFlatten`, `capRadiance`, `sampleSky`, `sampleSkyDither`,
`cirrusLayer`, `starField`, and `main()` itself — the ray reconstruction from
`uInvViewProj`, `pxAng`, the night factor, the sun and moon discs, the moon
aureole, the cirrus composite, the final `col*(1-cl.a) + cl.rgb`, and
`ABYSSAL_OUT`.

None of that is blocked. The TSL each piece needs exists: `fwidth` for `pxAng`,
`textureSize` for `sampleSkyDither`'s texel size, `texture(...).level(0)` for the
explicit-LOD fetches, `atan(y,x)` (which emits `atan2` on WGSL). It is simply not
written. A driver that wants a cloud deck before then must supply `air`,
`skyTop`, `skyLow`, `sunCol`, `moonCol` and the fragment coordinate itself and
call `marchClouds` directly — which is exactly what the parameter list is shaped
for (see notes 6 and 7 in `cloud-march.js`).

---

## 1. Assembling the passes

### Pass A — the LUT bake

`Sky.updateLUT` in `src/sky.js`, one draw into a 512×256 RGBA16F target.

```js
import { QuadMesh } from 'three/webgpu';
import { NodeMaterial } from 'three/webgpu';
import { uv } from 'three/tsl';
import { skyLutFragment, LUT_W, LUT_H, setSkyLutUniforms } from './tsl/sky-lut.js';
import { setAtmosphereUniforms } from './tsl/atmosphere.js';

const target = new RenderTarget( LUT_W, LUT_H, {
  type: HalfFloatType,               // gl.RGBA16F — raw radiance is far outside 8-bit
  format: RGBAFormat,
  colorSpace: NoColorSpace,          // linear radiance, no transfer function
  wrapS: RepeatWrapping,             // azimuth is periodic; the seam at u = 0 must blend
  wrapT: ClampToEdgeWrapping,        // latitude is not periodic
  minFilter: LinearMipmapLinearFilter,
  magFilter: LinearFilter,
  generateMipmaps: true,             // spray.js reads mip 3 and mip 4 as diffuse irradiance
  depthBuffer: false,
} );

const material = new NodeMaterial();
material.fragmentNode = skyLutFragment( uv() );
material.depthTest = false;
material.depthWrite = false;

const quad = new QuadMesh( material );   // NOT a PlaneGeometry quad — see below
```

**The quad choice is load-bearing and is currently mis-documented.** The
`USAGE` header in `sky-lut.js` (lines 81–89) says a Three fullscreen quad's
`uv()` matches `FS_VERT`'s `vUv = a_pos*0.5+0.5`. It does not, and following it
bakes the table mirrored in v with nothing erroring. The requirement, stated
correctly:

> **v = 0 must land on the row drawn at NDC top.**

Because that is what the read side does on *both* backends. `TextureNode`
flips v on the GLSL backend for any `isRenderTargetTexture`
(`nodes/accessors/TextureNode.js`: the flag set at :907, the flip in `setupUV`
at :326–340) and
does not flip on WGSL (`GLSLNodeBuilder.isFlipY()` is true,
`WGSLNodeBuilder.isFlipY()` is false), and those two exactly cancel the two
framebuffer row orders. So sampling the baked target at v = 0 returns the row
drawn at NDC top, on WebGPU and on WebGL2 alike.

Which write conventions round-trip:

| source of the bake uv | uv.y at NDC top | round-trips? |
| --- | --- | --- |
| `QuadMesh` (`uv` `[0,-1, 0,1, 2,1]` vs `position` `[-1,3, -1,-1, 3,-1]`) | 0 | **yes** |
| `screenUV` (y-flipped into the WebGPU convention on WebGL) | ~0 | **yes** |
| `PlaneGeometry(2,2)` | 1 | **no — mirrored** |
| `FS_VERT` (`a_pos*0.5+0.5`, the shipping GLSL) | 1 | n/a — reads its own way |

`FS_VERT` puts the zenith row at NDC top and the raw WebGL2 read path is
symmetric with it, so the shipping pair is self-consistent; it is only as a
description of Three's `uv()` that the header is wrong. Get this wrong and
`dirToSkyUv()` at the zenith reads the row written for the nadir: the background
gradient, the water reflection fetch, all three spray programs and `demo/craft.js`
all read the sky inverted about the horizon at once, with no error anywhere.

**When to re-bake.** `src/sky.js:56–64` keeps a 20-value signature and skips the
draw when it is unchanged — the LUT is a function of direction alone, so flying
around does not invalidate it. Replicate that signature exactly, including its
one subtlety: the trigger is `Math.round(Math.log2(Math.max(eyeHeight,1))*4)`, a
quarter-octave bucket, while the value uploaded to `uEyeHeight` is the raw
height. Bucketing the uploaded value instead would change the bake.

After the draw, mips have to be regenerated (`gl.generateMipmap` in the GLSL
path; `generateMipmaps: true` on the target for the node renderers).

**Nothing in this pass is per-frame.** All twelve of its uniforms change only
when the sun moves, the atmosphere parameters are edited, or the eye height
crosses a bucket — which is the entire reason the pass exists as a cache.

**Tone mapping and colour space must not touch it.** `NodeMaterial.setupOutput`
applies only fog and premultiplied alpha, and the renderer's tone-mapping and
output-colour-space conversion happen in its own output quad
(`Renderer.js:1826`), not in a material drawing into a render target — so the
default path is already correct. The check is that a read-back has values well
above 1.0. `SKY_LUT_FS` applies no display transform and neither does
`skyLutFragment`, deliberately: everything downstream scales and mixes this
radiance before any display transform sees it.

### Pass B — the background

`Sky.drawBackground` in `src/sky.js`. Depth-tested against the ocean already
drawn, writing no depth:

```js
material.depthTest  = true;
material.depthFunc  = LessEqualDepth;   // gl.LEQUAL
material.depthWrite = false;            // gl.depthMask(false)
material.blending   = NoBlending;
```

The GLSL gets its geometry from `FS_VERT_FAR` — a fullscreen triangle at
`gl_Position = vec4(a_pos, 1.0, 1.0)`, i.e. pinned to the far plane so `LEQUAL`
lets it fill only where nothing was drawn. A Three equivalent is a mesh whose
`vertexNode` emits the same clip position, or Three's own background mechanism;
either way the depth state above is what makes it composite correctly.

The ray is reconstructed exactly as the GLSL does, from `uInvViewProj` and
`uCamPos`, rather than from Three's camera nodes — same expression, same result,
and it keeps the comparison against `sky.json` honest:

```
vec4 ndc = vec4(vUv*2.0-1.0, 1.0, 1.0);
vec3 rd  = normalize((uInvViewProj*ndc).xyz/w - uCamPos);
```

Then the cloud call, with the two parameters the GLSL did not have:

```js
const cl = marchClouds( uCamPos, rd, uSunDir, sunCol, uMoonDir, moonCol,
                        skyTop, skyLow, air, fragCoord );
```

- `air` is `sampleSky(rd)` — the **explicit LOD 0** fetch, never the dithered
  variant. An implicit fetch crosses mip levels partway up the sky and lays
  horizontal seams across the frame.
- `fragCoord` must be **y-up**, i.e. `gl_FragCoord.xy`. `screenCoordinate` is
  *not* `gl_FragCoord`: on the WebGL backend Three emits
  `vec2(gl_FragCoord.x, screenSize.y - gl_FragCoord.y)` for it. Feeding that to
  the Bayer dither mirrors the dither phase vertically — statistically identical,
  visually indistinguishable, and not pixel-identical to `sky.json`. It is the
  single largest source of per-pixel difference in an otherwise correct port, and
  section 3 is partly about it.

**Which nodes change per frame**, given the shared uniform set:

| cadence | nodes |
| --- | --- |
| every frame | `uInvViewProj`, `uCamPos`, `uTime` |
| every frame *if* time-of-day animates | `uSunDir`, `uMoonDir`, `uMoonColor`, `uSunIrradiance` |
| every frame *if* the governor is active | `uCloudSteps` (`p.cloudStepScale`) |
| every frame *if* exposure adapts | `uOutExposure` (LDR output path only) |
| on parameter edit only | everything else — all 8 atmosphere, all cloud shape and lighting, all star, disc and cirrus knobs |

**Uniform ownership is split across three modules and there are three setters,
all of which must be called.** This is deliberate: the atmosphere block is shared
with the water and spray passes and is not the sky's to own.

```js
setAtmosphereUniforms( p );        // atmosphere.js — 8, shared with water/spray
setSkyLutUniforms( p, sunDir, eyeHeight );   // sky-lut.js — 4, of which 3 the background also reads
setCloudUniforms( p, ctx );        // cloud-field.js — 14, incl. uTime/uCamPos/uWindDirV
setCloudMarchUniforms( p );        // cloud-march.js — 8
```

Never declare a second `uniform()` node for a value another module already owns.
Two nodes for one value means two uploads and one of them will eventually be
forgotten — the modules import each other's nodes for exactly this reason
(`cloud-march.js` imports `uCloudAltitude` and friends rather than redeclaring
them).

The remaining 17 background uniforms have no node yet; they arrive with the
functions listed in section 0.

---

## 2. The uniform lists

### Pass A — LUT bake (12)

`Sky.updateLUT`, `src/sky.js:71–80`.

| node | module | source expression in `src/sky.js` |
| --- | --- | --- |
| `uTurbidity` | atmosphere | `p.turbidity` |
| `uOzone` | atmosphere | `p.ozone` |
| `uSunIrradiance` | atmosphere | `p.sunIrradiance` (vec3) |
| `uMieG` | atmosphere | `p.mieG` |
| `uAtmoExposure` | atmosphere | `p.atmoExposure` |
| `uMultiScatter` | atmosphere | `p.skyMultiScatter` |
| `uMSFloor` | atmosphere | `p.skyMSFloor` |
| `uMSHeight` | atmosphere | `p.skyMSHeight` |
| `uSunDir` | sky-lut | `sunDir` argument — `derived.sunDir`, `(cos el·sin az, sin el, −cos el·cos az)` |
| `uEyeHeight` | sky-lut | `eyeHeight` argument — `Math.max(camPos[1], 1)` at every call site |
| `uMoonDir` | sky-lut | `moonDirOf(p)` — same three lines as `derive.js:26–29` |
| `uMoonColor` | sky-lut | `p.moonColor` (vec3) — zero switches the moon march off via `dot(c,c) > 1e-8` |

The first eight are literally `Sky.atmosphereUniforms(p)`.

### Pass B — background (50: the 8 shared + 42 of its own)

`Sky.drawBackground`, `src/sky.js:95–141`. "node" is blank where the port has
none yet.

| uniform | node / module | source expression in `src/sky.js` |
| --- | --- | --- |
| `uTurbidity` … `uMSHeight` | atmosphere (8) | `...this.atmosphereUniforms(p)`, as above |
| `uSkyLUT` | — | `this.lut` — pass A's target; `texture(lut, uvNode).level(0)` |
| `uInvViewProj` | — | `ctx.invViewProj` (mat4) |
| `uCamPos` | `uCamPos` / cloud-field | `ctx.camPos` |
| `uSunDir` | `uSunDir` / sky-lut | `ctx.sunDir` — same `derived.sunDir` pass A gets |
| `uMoonDir` | `uMoonDir` / sky-lut | `ctx.moonDir` |
| `uMoonColor` | `uMoonColor` / sky-lut | `p.moonColor` |
| `uTime` | `uTime` / cloud-field | `ctx.time` |
| `uWindDirV` | `uWindDirV` / cloud-field | `ctx.windVec3` — a **velocity**, m/s, not a unit direction |
| `uSunAngularRadius` | — | `p.sunAngularRadius` |
| `uSunDiscIntensity` | — | `p.sunDiscIntensity` |
| `uCloudCoverage` | cloud-field | `p.cloudCoverage` |
| `uCloudDensity` | cloud-field | `p.cloudDensity` |
| `uCloudAltitude` | cloud-field | `p.cloudAltitude` |
| `uCloudThickness` | cloud-field | `p.cloudThickness` |
| `uCloudSpeed` | cloud-field | `p.cloudSpeed` |
| `uCloudDetail` | cloud-field | `p.cloudDetail` |
| `uCloudScale` | cloud-field | `p.cloudScale` |
| `uCloudShape` | cloud-field | `p.cloudShape` |
| `uCloudAnvil` | cloud-field | `p.cloudAnvil` |
| `uCloudMaxDist` | cloud-field | `p.cloudDistance` — **name differs** |
| `uCloudFade` | cloud-field | `p.cloudFade` |
| `uCloudSteps` | cloud-march | `Math.max(8, Math.round(p.cloudSteps * (p.cloudStepScale ?? 1)))` — **not** `p.cloudSteps` |
| `uCloudExtinction` | cloud-march | `p.cloudExtinction` |
| `uCloudMS` | cloud-march | `p.cloudMultiScatter` — **name differs** |
| `uCloudPowder` | cloud-march | `p.cloudPowder` |
| `uCloudSilver` | cloud-march | `p.cloudSilver` |
| `uCloudAmbient` | cloud-march | `p.cloudAmbient` |
| `uCloudAmbFloor` | cloud-march | `p.cloudAmbientFloor` — **name differs** |
| `uCloudHaze` | cloud-march | `p.cloudHaze` |
| `uCirrus` | — | `p.cirrus` |
| `uCirrusAlt` | — | `p.cirrusAltitude` |
| `uCirrusCurl` | — | `p.cirrusCurl` |
| `uCirrusMask` | — | `p.cirrusMask` |
| `uStars` | — | `p.stars` |
| `uStarSize` | — | `p.starSize` |
| `uStarCutoff` | — | `1.0 - 0.05 * p.starDensity` — **an inversion**: the knob reads "how much of the field shows", the shader wants the hash cutoff, which runs the other way |
| `uStarColorTemp` | — | `p.starColorTemp` |
| `uSunLimb` | — | `p.sunLimbDarkening` |
| `uDiscFlatten` | — | `p.sunRefractFlatten` |
| `uDiscCap` | — | `p.sunDiscCap` |
| `uSkyDither` | — | `p.skyDither` |
| `uOutExposure` | — | `this.outExposure` — LDR output path only (`LDR_OUTPUT_GLSL`) |

Five of these are traps and all five are in the "name differs" or "expression
differs" rows: `uCloudMaxDist`/`cloudDistance`, `uCloudMS`/`cloudMultiScatter`,
`uCloudAmbFloor`/`cloudAmbientFloor`, `uCloudSteps`'s governor product, and
`uStarCutoff`'s inversion. `setCloudUniforms` and `setCloudMarchUniforms` already
encode the first four; the fifth belongs to the star field, which is unported.

---

## 3. Proving it correct

The existing WebGL2 renderer draws this same sky, so the check is an image diff
at a fixed camera and fixed parameters. The rig, the reference and the comparator
all already exist:

```
node tools/run-probe.mjs prototypes/sky-golden.html --save test/out/sky-tsl.json
node tools/compare-image.mjs test/golden/sky.json test/out/sky-tsl.json diff.pgm
```

`prototypes/sky-golden.html` renders 160×100 of `Golden Hour Swell` at
`pos [0,12,0], yaw -0.6, pitch -0.02, fov 44, time 12.0` into an RGBA32F target
and dumps **every pixel** — in linear HDR, before any tonemapping, on purpose:
comparing after the post chain folds exposure, bloom and the tonemap into the
measurement, and a third of a stop of auto-exposure would swamp a real error in
the scattering. `test/golden/sky.json` holds that reference (mean 0.177351,
rms 0.258761, peak 0.724194). A TSL driver reproduces the same rig and writes the
same shape of file.

### The tolerance, and why pixel-exact is not the bar

`tools/compare-image.mjs` already sets it, and the bar is defensible:

- **distribution** — mean, rms, min, max each within **1% of the reference's own
  rms**. A dropped scattering term, a wrong phase function, a mis-mapped LUT
  direction, a lost octave: every real defect moves the energy in the image.
- **bulk of pixels** — the **99th percentile** of per-pixel luma error within
  **2% of rms**. This catches a *region* being wrong while tolerating edges that
  landed a step apart.
- **worst pixel is reported and is explicitly not a failure condition.** One
  pixel on a cloud edge can differ by a lot in a correct port, and failing on it
  teaches us to raise the threshold until nothing fails, which is worse than
  having no bar.

Pixel-exactness is the wrong bar here for reasons specific to this shader, not
as a general hedge:

1. **The dither phase.** If the driver feeds `screenCoordinate` rather than a
   y-up fragment coordinate, `bayer4` mirrors vertically. Every march starts at a
   different sub-step offset, so every cloud-edge pixel differs while the image is
   statistically identical. This is a *correct* port failing a pixel-exact test.
2. **The march is chaotic at edges by construction.** The start is dithered per
   pixel and the density field is sampled along the ray; one ulp of difference in
   a hash moves a sample across a density gradient, shifts an edge by a fraction
   of a step, and changes that pixel by percent while the sky it belongs to is
   unchanged.
3. **The LUT is half-float and bilinearly filtered.** RGBA16F carries a 10-bit
   mantissa, ~1e-3 relative. Every background pixel is a filtered fetch of it,
   plus a sub-texel jitter of `uSkyDither` texels. That alone floors the
   achievable agreement near 5e-4 before a single cloud is drawn — two orders
   above f32's 1.2e-7.
4. **Two compilers, not one.** WGSL and GLSL will contract `a*b+c` into an fma
   differently, use different polynomials for `sin`, `exp`, `pow`, and reach
   `atan2` versus `atan(y,x)` by different routes. The march sums hundreds of
   terms in an order neither backend need agree on.
5. **One line rides on unspecified behaviour.** `heightProfile`'s
   `smoothstep(topB, topA, h)` has `edge0 > edge1` deliberately (`cloud-field.js`
   note 3); both GLSL ES and WGSL call that undefined and both in practice compile
   it the same way. If WebGPU ever disagrees, cloud tops go flat — a systematic,
   region-sized difference the distribution check catches and a worst-pixel bound
   would drown in noise.
6. **The reference is one machine's.** `sky.json` was captured on one GPU.
   Demanding equality would make the golden file a property of that driver.

### Where bit-exactness *is* the bar, and is already met

The image diff is the integration check. It is deliberately the *last* one,
because it is the weakest: a mirrored LUT, a lost octave in a rarely-hit branch
and a mis-ordered accumulator can all hide inside a 2% percentile bound. The
unit-level checks are the strong ones, they were run on WebGL2 with the raw GLSL
compiled in the same page on the same GPU, and they are bit-exact:

| unit | result |
| --- | --- |
| `noise.js` | all nine functions bit-identical over 4000 random inputs, `oct = -1..10`, plus an exhaustive `bayer4` sweep over negative and fractional coordinates |
| `atmosphere.js` | 13 of 15 cases bit-exact, the other two within one f32 ulp (2.0e-7, driver mad-fusion inside the march), all eight uniforms driven away from their defaults |
| `cloud-field.js` | worst abs diff **0.0** over 5400 samples, all four early-return branches and both octave counts covered; 12 of 15 injected mutations detected, the 3 misses proven value-dead in the GLSL too |
| `cloud-march.js` | worst \|diff\| **0.0** in RGB and alpha over 4096 rays, 2875 carrying cloud — *after* the fix in section 4 |

Run those first. An image diff that fails after they pass is a driver bug — wrong
quad, wrong depth state, wrong fragment coordinate, wrong LOD on a fetch — not a
physics bug, and that is a much shorter list to search.

### The order to check in

1. **Units, on WebGL2, against the raw GLSL in the same page.** Bit-exact or it
   is wrong. `prototypes/verify-cloud-march.html` is the template.
2. **The LUT, texel by texel.** The bake has no dither, no march-start jitter and
   no screen coordinate: it is a deterministic function of `uv` and uniforms, so
   it should be near bit-exact on WebGL2 and a tight bound (1e-5 relative) is
   defensible. Read back all 512×256 and diff against the GLSL bake.
3. **The LUT's orientation, explicitly.** A v-mirrored table has *identical*
   statistics, so no distribution check will ever see it. Test it directly: bake,
   then assert that sampling through `dirToSkyUv(vec3(0,1,0))` is the blue zenith
   and `dirToSkyUv(vec3(0,-1,0))` is the dark nadir, and separately that
   `dirToSkyUv(skyUvToDir(uv)) ≈ uv` across the table. This is the check that
   would have caught defect L1 below.
4. **The background image**, through `compare-image.mjs` at the tolerances above.
5. **A negative control.** Change one octave count, or one lacunarity digit, and
   confirm the comparison fails. A check that cannot fail is not a check — this is
   what `compare-fingerprint.mjs` and the noise verification both do.

### The WebGPU half

None of this covers WGSL in this sandbox. Chromium 141 rejects the `swizzle`
property Three r185 passes to `createView`, on the render path only, so the
WebGPU render path cannot be verified headlessly here
([webgpu-port.md](webgpu-port.md), "Known environment issue"). Every result above
is the WebGL2 backend. The WGSL side needs one run on a real browser, and the
same three checks — LUT texel diff, LUT orientation, image diff — are the ones to
run there.

---

## 4. Defects verification found

Four of the five modules verified clean: `noise.js`, `atmosphere.js`,
`cloud-field.js` and the whole node graph of `sky-lut.js` are faithful
transcriptions, confirmed by compiling through r185's real `GLSLNodeBuilder` and
`WGSLNodeBuilder` and diffing against the GLSL. Two defects were found, in the
two remaining places, and **neither is fixed as of this writing.** Both are one
line.

### M1 — `cloud-march.js:517`: integer `min` breaks the WebGL2 build

**Not fixed.** Severity: fatal, on the backend this port exists to serve.

```js
const maxIter = steps.mul( int( 4 ) ).min( int( 256 ) ).toVar();   // int min int
```

`MathNode.generate` in r185 has a backend-specific special case:

```js
} else if ( coordinateSystem === WebGLCoordinateSystem &&
            ( method === MathNode.MIN || method === MathNode.MAX ) ) {
```

which forces a **scalar** second operand to be built as `'float'` regardless of
its actual type. It exists so `vec3.min(0.5)` works in GLSL. With two `int`
operands it emits `nodeVar28 = min( ( nodeVar23 * 4 ), 256.0 );` into
`int nodeVar28;`. GLSL ES 3.00 has no `min(int, float)` overload, so the fragment
shader does not compile:

```
ERROR: 0:1698: 'min' : no matching overloaded function found
'assign' : cannot convert from 'const mediump float' to 'highp int'
```

The program never links and the whole sky background draws nothing — measured
`sum|rgb| = 0.00` over the frame against `12269.33` for the shipping GLSL.

This is the **only** int-typed `min`/`max` in the entire TSL port; every other
`.min`/`.max` across all five modules is float-float and unaffected. WGSL is not
affected — the special case is gated on `WebGLCoordinateSystem` — so a
WebGPU-only test would never see it, and it breaks precisely the fallback.

Fix, built and measured:

```js
const maxIter = int( float( steps ).mul( 4.0 ).min( 256.0 ) ).toVar();
```

Exact for any `steps` in f32 integer range. `select( a.greaterThan( b ), b, a )`
also works. `prototypes/verify-cloud-march.html` is the reproducer — currently
FAILS on the unpatched module and PASSES bit-exact with the one line corrected:

```
node tools/run-probe.mjs prototypes/verify-cloud-march.html
```

With that line fixed the port is bit-exact against `SKY_BG_FS` over 4096 rays,
and every item on the translator's own unverified list checks out: the
restructured break-guard, the three-way `continue` tree, the snapshotted `dt`,
the JS-unrolled light cone, the MS octave series and its analytic tail, powder,
silver lining, the Bayer dither, `hazeTr` and the distance fade.

### L1 — `sky-lut.js` USAGE header, lines 81–89: wrong quad convention

**Not fixed.** Severity: silent, and it inverts the entire sky.

The node graph is exact. The *instruction* is wrong: the header claims a Three
fullscreen quad's `uv()` is "the same convention" as `FS_VERT`'s
`vUv = a_pos*0.5+0.5`. `QuadMesh` carries `uv` `[0,-1, 0,1, 2,1]` against
`position` `[-1,3, -1,-1, 3,-1]` — uv.y = 0 at NDC top, the exact vertical
opposite. `PlaneGeometry(2,2)` gives uv.y = 1 at NDC top, which *is* what the
header describes, and which is the one that does not round-trip. Both verified by
instantiating them from this repo's `node_modules`.

Consequence: bake on the quad the header points you at and the table is stored
mirrored in v with nothing erroring. Every consumer reads the sky inverted about
the horizon at once — background gradient, water reflection, all three spray
programs, `craft.js`.

The header also mis-states the symptom as "the sky renders upside down below the
horizon and nowhere else". A v mirror swaps zenith and nadir, so it is wrong
*everywhere* — which is what a maintainer would be hunting for.

Fix: state the requirement as "**v = 0 must land on the row drawn at NDC top**"
(which the header's own preceding sentence already gets right), and name
`QuadMesh` or `screenUV` rather than `FS_VERT`'s `a_pos*0.5+0.5`. Section 1 above
is written the corrected way.

### H1 — `noise.js` header: an unreproducible measurement claim

**Not a defect in the translation; a documentation and hygiene gap, not fixed.**

`noise.js`'s header states the module was "rendered side by side with NOISE_GLSL
running on the same GPU … BIT-EXACTLY". The translation is faithful — that was
independently confirmed — but the evidence is not reproducible from this repo:
nothing in `prototypes/`, `test/` or `tools/` references `src/gpu/tsl/noise.js`,
and the whole `src/gpu/tsl/` directory is untracked (`git status`: `?? src/gpu/tsl/`).

Every other module carries the same class of claim. The fix is a committed probe
per module in the shape of `prototypes/verify-cloud-march.html`, which is the one
that does exist and does run.
