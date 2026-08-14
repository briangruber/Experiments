// GPU spray, spindrift and sea mist, in TSL.
//
// One simulation pass over two float render targets, plus three draw programs:
// the instanced billboards' vertex and fragment stages, and the storm-haze
// fullscreen layer. Ported from the shipping WebGL2 path, by line range:
//
//   SAMPLE_OCEAN          src/shaders/spray.js:16-98
//   SPRAY_PARTICLE_GLSL   src/shaders/spray.js:103-138
//   SPRAY_SIM_FS          src/shaders/spray.js:140-484
//   SPRAY_VS              src/shaders/spray.js:486-612
//   SPRAY_FS              src/shaders/spray.js:614-704
//   SPRAY_HAZE_FS         src/shaders/spray.js:715-792
//   the CPU side          src/spray.js:1-184
//
// Runs on WebGPU and on WebGL2 from this one source: three compiles these node
// graphs to WGSL or to GLSL depending on the backend. No wgslFn, no glslFn.
//
// The physics is unchanged. Every constant, sign, clamp and magic number below
// is the one that shipped, and the GLSL comments explaining *why* each is what
// it is are carried across with them - several of these numbers look arbitrary
// and are not, so the comment is load-bearing documentation.
//
// WHAT IS STORED, AND WHAT IS NOT
//
// Only pos.w (life remaining, in seconds) and vel.w (birth energy, SIGNED -
// negative marks hull water rather than sea spray) are stored per particle.
// Class (droplet vs mist), total lifetime, size and the particle's place along
// its tear-off sheet are pure functions of the particle index, so both stages
// recover them without spending a channel each. That is SPRAY_PARTICLE_GLSL,
// exported below as five Fns which the sim and the draw pass share verbatim.
//
// ===========================================================================
// ELEVEN THINGS A READER COMING FROM THE GLSL WILL OTHERWISE GET WRONG
//
// The first three produce a wrong image while compiling perfectly on both
// backends, which is the class of defect docs/tsl-porting-rules.md exists for.
//
// ---------------------------------------------------------------------------
// 1. THE SIM INDEXES IN uv(), NOT glScreenUV() - AND THAT IS WHAT MAKES THE
//    PORT BIT-EXACT.
//
//    Porting rule 9. The sim is a fragment ping-pong over two float targets, so
//    the destination texel and the sampler must be expressed in the same space
//    or the two y-flips (framebuffer orientation, and TextureNode.setupUV's
//    render-target flip) compose instead of cancelling.
//
//      const uvN = uv();                       // QuadGeometry's uv
//      P   = posTex.sample( uvN ).level( 0 )
//      fid = floor(uvN.y*S)*S + floor(uvN.x*S)
//
//    and the draw pass addresses the same space from the instance index:
//
//      uvp = (vec2( id % S, id / S ) + 0.5) / S
//
//    glScreenUV() is the GLSL's vUv (v = 0 at the bottom) and is the right call
//    for a pass whose output is a PICTURE - the haze layer below uses it. Here
//    the state texture is an INDEX SPACE, not a picture. Whatever row uv()
//    writes, a TextureNode .sample() at that same uv reads back: the flips
//    cancel on WebGL and neither fires on WebGPU, for exactly the reason the sky
//    LUT round-trips (see the header of ./sky-driver.js). Nothing outside the
//    system ever observes which physical texel holds particle fid.
//
//    Using glScreenUV() here would mirror the fid<->texel assignment in y: the
//    draw pass would read particle fid = row*S + col out of the texel the sim
//    gave particle (S-1-row)*S + col. Every particle would then be drawn with
//    another particle's class, size, lifetime and shred position. sprayIsMist,
//    sprayRadius, sprayLifeTotal and sprayShred are all pure functions of fid,
//    so nothing would crash and nothing would look obviously broken - the sea
//    would just make the wrong spray.
//
// ---------------------------------------------------------------------------
// 2. THE GLSL'S uWind IS ./cloud-field.js's uWindDirV - A VELOCITY. IMPORTED,
//    NEVER REDECLARED, AND NEVER ./water-common.js's uWindDir.
//
//    src/spray.js passes `uWind: ctx.windVec3`, and setCloudUniforms writes
//    exactly that into uWindDirV. So spray's uWind IS uWindDirV, in metres per
//    second, with magnitude U10. The sim depends on that magnitude in five
//    places: `length(uWind)` gates the whole emitter, the log wind profile is
//    `uWind * (1 + uShear*log(...))`, the launch inherits `uWind*uLaunchWind`,
//    spindrift is set to `uWind * (0.65 + 0.35*s1)`, and the haze drift is
//    `uWind.xz * uTime * 0.35`.
//
//    This is the exact OPPOSITE of ./water-common.js note 1: the water's
//    `uWindDir` is a UNIT direction and must never be fed a velocity, and
//    spray's `uWind` is a velocity and must never be fed a unit direction. At
//    the default windSpeed of 11 they differ by a factor of 11 in both
//    directions.
//
//    Same class of trap one level down, and the reason a uniform is RENAMED
//    here: SPRAY_FS's `uAerial` is p.sprayAerial = 0.0012, an extinction
//    coefficient per metre. ./water-surface.js already exports a `uAerial` that
//    is p.aerial = 1.0, a dimensionless weight. Importing it would compile and
//    would multiply the spray's aerial-perspective exponent by 833, so this
//    module declares **uSprayAerial** - an accidental import is then a visible
//    mistake rather than a plausible-looking one.
//
//    Two more that look like collisions and are not:
//      uCraftPos is ctx.craftPos (waveRunner.pos, the WORLD frame).
//        ./water-surface.js's uHullPos is waveRunner.surfXZ(), the LAGRANGIAN
//        frame the displacement fields are indexed in. Different vectors.
//      uCraftBeam is p.wrBeam = 0.6. ./water-common.js's uWakeBeam is
//        max(p.wrBeam, 0.3) * 1.6 = 0.96.
//
// ---------------------------------------------------------------------------
// 3. THE PING-PONG NEEDS TWO MATERIALS PER PROGRAM, NOT ONE WITH A SWAPPED
//    TextureNode.value.
//
//    prototypes/tsl-pingpong-probe.html measured this: reassigning a
//    TextureNode's .value between draws does NOT invalidate the WebGPU bind
//    group, so every pass reads whichever texture was bound first. It works on
//    WebGL2, where the sampler is re-resolved per draw. Ship-green-on-the-
//    fallback, silently-stale-on-the-target-backend.
//
//    So spraySimFragment and sprayPosition take their source texture NODES as
//    arguments and ./spray-driver.js builds one material per read-parity. This
//    also satisfies porting rule 11 by construction: the driver builds each
//    material from the REAL target's texture, so no placeholder can bake the
//    wrong textureLoad-vs-textureSampleLevel choice into a shader.
//    stateTexturePlaceholder() exists only so a compile probe can build the
//    graphs with no renderer, and it carries SPRAY_STATE_RT_OPTIONS' filter,
//    wrap and mip state exactly for the same reason.
//
// ---------------------------------------------------------------------------
// 4. MRT: outputStruct, RETURNED DIRECTLY, NEVER A Fn CALL.
//
//    The GLSL writes `layout(location=0) out vec4 oPos;` and
//    `layout(location=1) out vec4 oVel;`. In TSL that is
//    `outputStruct( oPos, oVel )`, which OutputStructNode.generate turns into
//    two `layout( location = n ) out vec4 mn;` on GLSL and an @location output
//    struct on WGSL. NodeMaterial.setup (three.webgpu.js:21358) does
//
//        if ( fragmentNode.isOutputStructNode !== true )
//            fragmentNode = fragmentNode.convert( builder.getOutputType() );
//
//    so spraySimFragment MUST hand back the OutputStructNode itself. Wrapping
//    the body in Fn(...) makes material.fragmentNode a ShaderCallNode whose
//    isOutputStructNode is undefined; three then collapses the struct to a
//    single vec4, the velocity attachment is never written, and the simulation
//    quietly runs on a stale velocity field.
//
//    THE DEVIATION FROM ./ocean-sim.js's SHAPE, AND WHY. ocean-sim.js's MRT
//    stages are `outputStruct( fnA(), fnB() )` - two Fns, each building one
//    attachment, sharing a plain-JS builder. That works there because the
//    duplicated work is a couple of texel fetches. It will not do here: oPos
//    and oVel come out of ONE branchy body with a 16-iteration retry loop and
//    a four-way source pick, so two copies would not only double the cost but
//    could in principle take DIFFERENT BRANCHES if a compiler contracted the
//    two identical trees differently - a particle with one source's position
//    and another's velocity.
//
//    So the body is ONE Fn returning a two-member `struct`, called ONCE, and
//    the two members are handed to outputStruct:
//
//        const s = spraySimBody( posTex, velTex );
//        return outputStruct( s.get( 'oPos' ), s.get( 'oVel' ) );
//
//    ShaderCallNodeInternal.getOutputNode caches on the CALL node
//    (three.webgpu.js:4268), so one call node builds its body exactly once and
//    the two MemberNodes read the same struct var. Verified by generating both
//    shaders headlessly: GLSL emits one copy of the body then
//    `m0 = nodeVar.oPos; m1 = nodeVar.oVel;`, WGSL emits one copy then
//    `output.m0 = ...; output.m1 = ...;`.
//
//    Do NOT use `mrt({ ... })` instead: MRTNode.setup resolves names against
//    renderer.getRenderTarget().textures at build time, and the merge path only
//    runs when material.fragmentNode is null. outputStruct is order-based and
//    matches the GLSL's location layout one to one.
//
// ---------------------------------------------------------------------------
// 5. uViewProj IS GONE; THE SUB-PIXEL TEST USES THREE'S CAMERA.
//
//    SPRAY_VS needs a view-projection matrix for two different jobs.
//      (a) gl_Position - handled by positionNode returning a WORLD-space
//          position and letting three build modelViewProjection, exactly as
//          ./water-surface.js note 5 prescribes. The driver therefore keeps the
//          billboard mesh's matrixWorld at identity, matrixAutoUpdate off and
//          frustumCulled off.
//      (b) the sub-pixel growth test, which projects P and P + uCamUp*size
//          itself and needs the actual matrix inside the shader. That is
//          `cameraProjectionMatrix.mul( cameraViewMatrix )`, NOT a uViewProj
//          uniform of our own: a second copy of the camera set from ctx.viewProj
//          is precisely porting rule 13's trap, correct in one draw order and
//          wrong in the other, and it is unnecessary because the mesh's model
//          matrix is identity.
//
//    The GL/WebGPU depth-range difference between the two projection
//    conventions does not reach this code: c0 and c1 are consumed only as
//    `length(c1.xy/max(c1.w,1e-3) - c0.xy/c0.w) * 0.5 * uViewportH` and
//    `c0.w > 1e-3`, and both conventions agree on xy and w.
//
//    uViewportH stays a uniform rather than becoming screenSize.y: it is read
//    in the VERTEX stage, and the driver sets it from the bound render target's
//    height, which is what the GLSL means by drawingBufferHeight even when the
//    frame is going into an HDR FBO.
//
// ---------------------------------------------------------------------------
// 6. WHERE .level() GOES, AND WHERE IT MUST NOT.
//
//    uPos / uVel, every fetch, both stages : .level(0). Mandatory in the vertex
//      stage (no derivatives) and free everywhere else - the targets are
//      Nearest+Nearest FloatType, so WGSL emits textureLoad() regardless and
//      generateTextureLevel converts the normalized uv to a texel index itself.
//    uDisp / uFoam, every fetch, both stages : .level(0). The GLSL is explicit -
//      `textureLod(uDisp, uvc, 0.0)` - and spray.js:88-89 says why: spawn sites
//      are random per fragment, so an implicit derivative would pick a near-top
//      mip where every crest has averaged away. It is also what makes these
//      fetches legal on WGSL, because they sit inside the retry Loop and two
//      nested Ifs, i.e. non-uniform control flow.
//    uSkyLUT in SPRAY_VS (vAmb) : .level(4.0). Vertex stage.
//    uSkyLUT in SPRAY_HAZE_FS   : .level(4.0) zenith tap, .level(3.0) view tap.
//    uSkyLUT in SPRAY_FS (`far`): NO .level() - IMPLICIT LOD. The GLSL writes a
//      plain `texture(uSkyLUT, dirToSkyUv(-V))` and the table is mipped, so this
//      is NOT the same value as a level-0 fetch. It sits at the top level of the
//      fragment function (uniform control flow), so it is legal on WGSL. This is
//      why ./sky-background.js's sampleSky() - which is .level(0) - must not be
//      imported for it, and neither must ./water-brdf.js's two-argument one.
//
// ---------------------------------------------------------------------------
// 7. LINE-LEVEL TRAPS, EACH OF WHICH COMPILES WRONG-AND-SILENT.
//
//    - `.mix()` IS BANNED, all ~27 blends. mixElement is (t, e1, e2) =>
//      mix(e1, e2, t), so the RECEIVER IS THE FACTOR. Standalone mix(a, b, t)
//      only, and a bare JS number as the first argument is wrapped in float().
//      Porting rule 1.
//    - step(edge, x) in the standalone form, which is the GLSL's order. Two are
//      easy to read backwards:
//        sprayIsMist: step(hash11(...), uMistFrac) - the HASH is the edge, so a
//          higher uMistFrac makes MORE mist.
//        vHull: step(V.w, 0.0) - V.w is the EDGE and 0.0 the value, so vHull is
//          1 when V.w <= 0, i.e. when the birth energy was written negative to
//          mark hull water. Backwards, this lights all the sea spray as dense
//          hull whitewater and none of the hull spray.
//    - DESCENDING smoothstep EDGES, deliberate: SPRAY_VS's
//      `smoothstep(1.0, 0.62, age)`, the fade-out at the end of life. Both GLSL
//      ES and WGSL call edge0 >= edge1 undefined and both compile it to the
//      descending ramp. Preserve the ORDER; do not rewrite it as
//      smoothstep(0.62, 1.0, age).oneMinus(). (./water-surface.js note 3.)
//    - `vSeed*6.28318` in SPRAY_FS is the TRUNCATED literal and is NOT TAU_A.
//      TAU_A (6.28318530718) IS right for `hs.y * 6.28318530718` in the sim's
//      spawn azimuth, where the GLSL spells all twelve digits.
//    - PI is not used anywhere in this unit, so neither PI_A nor PI_W is here.
//    - `mod`: mod(fid,2), mod(floor(fid*0.5),2), mod(floor(fid*0.25),2),
//      mod(uFrame,2048). TSL's .mod() reproduces GLSL's x - y*floor(x/y) on both
//      backends (WGSL gets the tsl_mod polyfill), so a negative operand wraps
//      the same way. The three sign bits are the GLSL's fix for a cheap hash's
//      mean not being exactly 0.5 - the SIGN comes from the particle index and
//      only the MAGNITUDE from the hash - and a dead straight run measurably
//      sprayed more to starboard before it. Do not simplify them to hashes.
//    - Integer `%` and `/` on the instance index are int OperatorNodes (`a % b`,
//      `a / b` on both backends), verified by the ping-pong probe. They are NOT
//      min/max, so porting rule 2 does not apply to them. Rule 2 DOES apply to
//      the haze's step clamp - see note 9.
//    - `atan(vCorner.y, vCorner.x)` is the two-argument form; TSL emits atan on
//      GLSL and atan2 on WGSL, so the branch cut is the platform's and matches.
//    - Variable names that shadow across scopes in the GLSL land in separate JS
//      closures here and KEEP the GLSL's name, so a diff reads straight down:
//      `u` (the craft branch and the sea loop both call it sprayShred(fid)),
//      `energy` (craft branch vs sea loop), `v` (craft, sea, step). The one
//      exception is the sea loop's `wet`, spelled `wetRaft` here, because the
//      craft branch's `wet` (1 - uCraftAir) is still in scope in JS where in
//      GLSL it was not.
//
// ---------------------------------------------------------------------------
// 8. STRUCTURAL TRANSLATIONS.
//
//    - `out` parameters: `vec3 oceanAt(vec2 q, out vec2 dxz)` becomes a plain JS
//      node-graph builder returning `{ o, dxz }`, both .toVar()s - five floats,
//      so no vector packing fits (./water-common.js note 3, atmosphere.js's
//      aerialPerspective).
//    - The four `for (int c=0;c<4;c++){ if (c>=uCascadeCount) break; ... }`
//      loops are JS-unrolled with `If( int(c).lessThan(uCascadeCount), ... )`,
//      exactly as ./water-common.js's sampleCascadeDisp. Value-equivalent: on
//      the skipped iterations the GLSL body never ran either. THE ONE EXCEPTION
//      is oceanHeightFast's displacement loop, which is `for (int c=0;c<2;c++)`
//      in the GLSL and unrolls to FAST_CASCADE_CAP = 2 - see that function.
//    - `break` becomes a `done` int flag; `continue` at the top of a body
//      becomes an If around the rest of it; the GLSL's two early `return`s
//      become the `done`/`spawned` flags. Porting rule 6: no bool locals. There
//      are NO bool locals in src/shaders/spray.js to begin with - `buried`,
//      `isB`, `sd`, `side`, `wet`, `lead`, `mist` and `vHull` are all floats and
//      `tries`, `steps`, `id` and `w` are ints - so that rule costs nothing.
//    - Ternaries become select(cond, a, b); argument order is what it looks like
//      (porting rule 5). All six have a degenerate-normalise guard in the false
//      arm, and select compiles to a real select on both backends, so a NaN in
//      the unevaluated arm cannot leak through arithmetic.
//    - `discard` becomes Discard(cond). WGSL's discard does not terminate the
//      invocation the way GLSL's does, so the arithmetic after the first Discard
//      still runs for a discarded fragment; `pow(1.0 - d, vSoft)` with d > 1 is
//      then a NaN. It is discarded, so this is correct - do NOT "fix" it with a
//      clamp, which would change the value of live fragments at d exactly 1.
//
// ---------------------------------------------------------------------------
// 9. THE HAZE MARCH'S STEP COUNT IS A FLOAT UNIFORM ON PURPOSE.
//
//    The GLSL is `int steps = clamp(uHazeSteps, 4, 24);` with uHazeSteps an int.
//    That builds min/max with a scalar second operand on an INT, which is
//    porting rule 2 and breaks the WebGL2 backend only. So uHazeSteps is a
//    FLOAT uniform here (./cloud-march.js's uCloudSteps precedent) and the clamp
//    goes through float: `int( uHazeSteps.clamp( 4.0, 24.0 ) )`. Value-identical,
//    because the setter writes Math.round(p.sprayHazeSteps), an exact integer.
//
//    The loop is 1-BASED AND INCLUSIVE (`for (int i = 1; i <= 24; i++)`). TSL's
//    Loop end is EXCLUSIVE, so it is `{ start: int(1), end: int(25) }`. 25, not
//    24. Do not "correct" it.
//
// ---------------------------------------------------------------------------
// 10. DEAD CODE IN SAMPLE_OCEAN IS PORTED ANYWAY.
//
//    dispXZ, toLagrange and oceanHeight are defined in SAMPLE_OCEAN and CALLED
//    BY NOTHING in any of the three spray programs - oceanAt takes an already-
//    Lagrangian q, and oceanHeightFast does its own two-cascade inversion. They
//    are the block's documentation of why a world coordinate cannot be fed
//    straight into the FFT lookup; the comment at spray.js:21-28 records that
//    getting it wrong drowned every droplet on the frame it was born and
//    produced no spray at all at force 10. They are ported and exported anyway,
//    following ./water-common.js note 6's call on foamT. As plain JS builders
//    that nothing calls they emit not one instruction.
//
// ---------------------------------------------------------------------------
// 11. WHY setSprayOceanUniforms EXISTS INSTEAD OF CALLING setWaterCommonUniforms.
//
//    Porting rule 13 says every driver must set every uniform its stages read,
//    including ones another module declares. The spray stages read
//    ./water-common.js's uPatch, uCascadeCount, dispTexture, foamTexture and
//    uHeightScale, and ./water-surface.js's uSeaLevel.
//
//    setWaterCommonUniforms(p, ctx, ocean, wake) would set all of those - and,
//    handed no wake, would also force uWakeOn to 0. In the shipping frame order
//    (spray.update, water.render, spray.draw) the spray draw runs AFTER the
//    water draw, so calling it there would leave uWakeOn at 0 for whatever ran
//    next. A landmine rather than a bug today, which is the worst kind. So this
//    module owns a narrow setter that writes exactly what src/spray.js's own
//    setUniforms call writes and nothing else. It deliberately does NOT touch
//    uFade: the cascade fade is a water-surface concept and SAMPLE_OCEAN has no
//    cascadeWeight.
//
// ===========================================================================
// WHAT HAS BEEN VERIFIED, AND WHAT HAS NOT
//
// CHECKED. All three programs were built through three's own GLSLNodeBuilder and
// WGSLNodeBuilder headlessly - a WebGPURenderer constructed but not init()ed,
// with renderer.hasFeature stubbed - and the emitted source read against the
// GLSL. Six builds (three programs x two backends), run twice with
// `float32-filterable` present and absent, all compile.
//
// ONE THING THAT PROBE HAS TO GET RIGHT, or half of it is vacuous:
// renderer.coordinateSystem must be forced to WebGLCoordinateSystem for the GLSL
// build. MathNode.generate (three.webgpu.js:7300) gates porting rule 2's
// scalar-second-operand min/max rewrite on it, along with the scalar-first
// -operand step rewrite and the atan -> atan2 rename; an un-init'ed
// WebGPURenderer reports the WebGPU system, under which none of the three fire
// and rule 2 cannot be caught. Forced, and then in the emitted source:
//
//   - NO min or max anywhere takes an int first operand, in any of the three
//     programs - checked mechanically against the emitted GLSL's own int
//     declarations, which is the check porting rule 2 asks for. The one place
//     the GLSL would have produced one, `clamp(uHazeSteps, 4, 24)`, goes through
//     float by construction (note 9);
//   - atan(y, x) comes out as GLSL's two-argument atan and as WGSL's atan2;
//
//   - the sim writes TWO colour attachments (`m0`/`m1` on GLSL, `output.m0`/`m1`
//     on WGSL) from ONE copy of the body, which is note 4's whole point;
//   - the sim's state fetches are `textureLod(uPos, flip(uv), 0.0)` on GLSL and
//     `textureLoad(uPos, floor(uv*dim), 0)` on WGSL - one flip on the backend
//     that needs one, none on the backend that does not;
//   - `fid` is computed from the UNFLIPPED uv in both, so the fid<->uv mapping is
//     the same function in the sim and the draw pass (note 1);
//   - oceanHeightFast emits TWO guarded displacement blocks and FOUR height
//     blocks, in both stages (FAST_CASCADE_CAP);
//   - every uDisp/uFoam tap carries level 0, the two vertex/haze sky taps carry
//     levels 4 and 3, and SPRAY_FS's `far` comes out as a bare `texture(...)` /
//     `textureSample(...)` with no level (note 6);
//   - the retry loop is `for (int i = 0; i < 16; i++)` with the `done`/rate/energy
//     guards nested exactly as the GLSL's break and two continues; the haze march
//     is `for (int i = 1; i < 25; i++)` with `if (i <= steps)` (note 9);
//   - the four-way source pick is one if/else-if/else-if/else chain over the same
//     three cumulative weights, with all eight initialisers live before it;
//   - R_PLANET*R_PLANET and 2*R_PLANET are folded (40589641000000.0, 12742000.0)
//     while `1/(exp(3.2)-1)` stays an exp() on the GPU.
//
// NOT CHECKED. No rendered image. Porting rule 8's golden diff against the
// shipping WebGL2 path has not been run - there is no display in the environment
// this was written in - so every claim above is about emitted source, not about
// pixels. The highest-value check for whoever runs it next is note 1: read back
// rt[idx].textures[0] after a fixed number of steps from a fixed uFrame/uTime and
// confirm particle fid's life and position land at texel (fid % S, floor(fid/S))
// in the same uv space the draw pass addresses. Do it at size 160 or larger - a
// row there is 2560 bytes, comfortably past porting rule 10's 256-byte readback
// bar, and a probe at a smaller size is not. Then ablate with p.sprayOpacity,
// p.sprayMistOpacity, p.sprayHaze and ctx.craftAmount, which switch off the four
// layers independently.

import {
	Fn, If, Loop, float, int, vec2, vec3, vec4,
	mix, clamp, smoothstep, step, select, atan, distance,
	uniform, texture, uv, attribute, instanceIndex, varyingProperty,
	outputStruct, struct, Discard,
	cameraProjectionMatrix, cameraViewMatrix,
} from 'three/tsl';

import {
	DataTexture, RGBAFormat, FloatType, NearestFilter, ClampToEdgeWrapping,
} from 'three';

import { hash11, hash12, hash22, vnoise, fbm2 } from './noise.js';

import {
	R_PLANET, TAU_A, uSunIrradiance, uAtmoExposure, miePhase, sunTransmittance,
} from './atmosphere.js';

import { uSunDir, dirToSkyUv } from './sky-lut.js';
import { skyLutTexture, uInvViewProj, glScreenUV } from './sky-background.js';

// uCamPos, uTime and uWindDirV are the GLSL's uCamPos, uTime and uWind - see
// note 2. They live here because the cloud field needed them first; they belong
// to the frame, not to the clouds.
import { uCamPos, uTime, uWindDirV } from './cloud-field.js';

import {
	CASCADE_CAP, uPatch, uCascadeCount, uHeightScale,
	dispTexture, foamTexture, setCascadeTextures,
} from './water-common.js';

import { uSeaLevel } from './water-surface.js';

import { smoothstep as smoothstepJS } from '../../math.js';

// ---- constants ---------------------------------------------------------------

// oceanHeightFast's displacement loop bound. NOT ./water-common.js's
// CASCADE_CAP (4) - the GLSL really does write `for (int c=0;c<2;c++)` there and
// only there, and the comment above it says why. Unrolling this to 4 "for
// consistency" changes the height every droplet is drowned against and every
// waterline is faded against.
export const FAST_CASCADE_CAP = 2;

// SPRAY_HAZE_FS's `const float KS = 3.2`. A JS number used as a literal; the
// `norm` derived from it stays NODE math (see sprayHazeFragment) so the GPU's
// exp() is the one that runs, as it does today.
const KS = 3.2;

// The pos/vel target state, in one place so the driver and
// stateTexturePlaceholder() cannot drift (porting rule 11).
//
// src/spray.js:17-22 builds both textures RGBA32F / FLOAT / NEAREST /
// CLAMP_TO_EDGE, and `count: 2` is what puts oPos and oVel on one framebuffer,
// exactly as `framebuffer(gl, [pos, vel])` does.
//
// Nearest+Nearest AND FloatType each make WGSLNodeBuilder.isUnfilterable true,
// so every fetch is emitted as textureLoad(). That is exactly what is wanted
// here - a texel fetch - and generateTextureLevel converts the normalized uv to
// a texel index itself, so `.sample(uv)` is still the correct call.
export const SPRAY_STATE_RT_OPTIONS = /*@__PURE__*/ Object.freeze( {
	type: FloatType,
	format: RGBAFormat,
	count: 2,
	minFilter: NearestFilter,
	magFilter: NearestFilter,
	wrapS: ClampToEdgeWrapping,
	wrapT: ClampToEdgeWrapping,
	generateMipmaps: false,
	depthBuffer: false,
	stencilBuffer: false,
	anisotropy: 1,
} );

// ---- the state textures ------------------------------------------------------

/**
 * A 1x1 RGBA FloatType zero texture carrying SPRAY_STATE_RT_OPTIONS' filter,
 * wrap and mip state exactly.
 *
 * Not inert: a graph built against a placeholder with the wrong filter state
 * bakes textureSampleLevel where textureLoad belongs (or the reverse) and keeps
 * it forever after, on WGSL only. The driver never uses this - it builds every
 * material from the real target textures - but a compile probe with no renderer
 * does, and it must compile to the same instruction.
 *
 * A fresh texture per call, so two graphs cannot end up sharing one.
 */
export function stateTexturePlaceholder() {

	const t = new DataTexture( new Float32Array( 4 ), 1, 1, RGBAFormat, FloatType );
	t.minFilter = SPRAY_STATE_RT_OPTIONS.minFilter;
	t.magFilter = SPRAY_STATE_RT_OPTIONS.magFilter;
	t.wrapS = SPRAY_STATE_RT_OPTIONS.wrapS;
	t.wrapT = SPRAY_STATE_RT_OPTIONS.wrapT;
	t.generateMipmaps = SPRAY_STATE_RT_OPTIONS.generateMipmaps;
	t.anisotropy = SPRAY_STATE_RT_OPTIONS.anisotropy;
	t.needsUpdate = true;
	return t;

}

/**
 * The ONLY sanctioned way to build a uPos/uVel TextureNode. Pass a real target
 * texture; pass nothing only in a compile probe.
 */
export function makeStateTextureNode( tex ) {

	return texture( tex ?? stateTexturePlaceholder() );

}

// ---- uniforms ----------------------------------------------------------------
// Defaults are the shipping defaults from src/presets.js, so this module
// evaluates to a sane spray before anything has called a setter.

// --- SPRAY_PARTICLE_GLSL: read by the SIM and by BOTH draw stages, exactly as
// Spray.particleUniforms(p) hands the same nine constants to both programs.

export const uMistFrac = /*@__PURE__*/ uniform( 0.0 );       // p.sprayMist
export const uLifetime = /*@__PURE__*/ uniform( 2.2 );       // p.sprayLifetime
export const uMistLifetime = /*@__PURE__*/ uniform( 7.0 );   // p.sprayMistLife
export const uSizeMin = /*@__PURE__*/ uniform( 0.018 );      // p.spraySizeMin
export const uSizeMax = /*@__PURE__*/ uniform( 0.15 );       // p.spraySizeMax
export const uMistSize = /*@__PURE__*/ uniform( 0.55 );      // p.sprayMistSize
export const uSheetSize = /*@__PURE__*/ uniform( 96.0 );     // p.spraySheet
export const uMistRadius = /*@__PURE__*/ uniform( 2.5 );     // p.sprayMistRadius
// The state textures' edge length. 160 on desktop, 96 on handheld
// (presets.js sprayTexSize); the driver's `size` is the one source.
export const uTexSize = /*@__PURE__*/ uniform( 160.0 );

// --- SPRAY_SIM_FS

export const uDt = /*@__PURE__*/ uniform( 1.0 / 60.0 );      // Math.min(dt, 0.05)
export const uFrame = /*@__PURE__*/ uniform( 0.0 );          // Spray.frame
export const uSpawnRadius = /*@__PURE__*/ uniform( 120.0 );  // p.sprayRadius
export const uSpawnRate = /*@__PURE__*/ uniform( 0.85 );     // p.sprayRate
export const uSpawnFocus = /*@__PURE__*/ uniform( 1.1 );     // p.sprayFocus
export const uFoldThreshold = /*@__PURE__*/ uniform( 0.30 ); // p.sprayThreshold
export const uFoldSoft = /*@__PURE__*/ uniform( 0.15 );      // p.sprayFoldSoft
export const uFoamBias = /*@__PURE__*/ uniform( 0.85 );      // p.sprayFoamBias
export const uWindMin = /*@__PURE__*/ uniform( 4.5 );        // p.sprayWindMin
export const uWindFull = /*@__PURE__*/ uniform( 18.0 );      // p.sprayWindFull
export const uMistWind = /*@__PURE__*/ uniform( 7.0 );       // p.sprayMistWind
export const uSheetRate = /*@__PURE__*/ uniform( 5.0 );      // p.spraySheetRate
export const uSheetSpread = /*@__PURE__*/ uniform( 2.2 );    // p.spraySheetSpread
// THE UNIFORM. sprayShred(id) below is the FUNCTION; they are different things.
export const uShred = /*@__PURE__*/ uniform( 1.6 );          // p.sprayShred
export const uGravity = /*@__PURE__*/ uniform( 9.4 );        // p.sprayGravity
export const uDrag = /*@__PURE__*/ uniform( 0.9 );           // p.sprayDrag
export const uMistDrag = /*@__PURE__*/ uniform( 4.0 );       // p.sprayMistDrag
export const uMistFall = /*@__PURE__*/ uniform( 0.06 );      // p.sprayMistFall
export const uMistRise = /*@__PURE__*/ uniform( 0.6 );       // p.sprayMistRise
export const uLaunchSpeed = /*@__PURE__*/ uniform( 4.6 );    // p.sprayLaunch
export const uLaunchUp = /*@__PURE__*/ uniform( 0.45 );      // p.sprayLaunchUp
export const uLaunchWind = /*@__PURE__*/ uniform( 0.35 );    // p.sprayLaunchWind
export const uTurbulence = /*@__PURE__*/ uniform( 2.0 );     // p.sprayTurbulence
export const uShear = /*@__PURE__*/ uniform( 0.35 );         // p.sprayShear

// --- SPRAY_SIM_FS, the hull emitter. A wave runner has four separate sources,
// not one, and each has its own geometry - see the birth block.

// ctx.craftPos, the WORLD frame. Parked far below the sea when nobody is riding,
// so the emitter costs a branch and nothing else. NOT water-surface's uHullPos.
export const uCraftPos = /*@__PURE__*/ uniform( 'vec3' );
export const uCraftFwd = /*@__PURE__*/ uniform( 'vec2' );    // ctx.craftFwd
export const uCraftRight = /*@__PURE__*/ uniform( 'vec2' );  // ctx.craftRight
export const uCraftSpeed = /*@__PURE__*/ uniform( 0.0 );     // ctx.craftSpeed
export const uCraftTurn = /*@__PURE__*/ uniform( 0.0 );      // ctx.craftTurn, signed yaw rate
export const uCraftAmount = /*@__PURE__*/ uniform( 0.0 );    // ctx.craftAmount
export const uCraftSpread = /*@__PURE__*/ uniform( 1.0 );    // p.craftSpraySpread
export const uCraftUp = /*@__PURE__*/ uniform( 1.0 );        // p.craftSprayUp
// p.wrBeam. NOT water-common's uWakeBeam, which is max(p.wrBeam,0.3)*1.6.
export const uCraftBeam = /*@__PURE__*/ uniform( 0.6 );
export const uCraftLen = /*@__PURE__*/ uniform( 1.6 );       // p.wrLength
export const uCraftPlane = /*@__PURE__*/ uniform( 6.0 );     // p.craftPlaneSpeed
export const uCraftPlaneFull = /*@__PURE__*/ uniform( 14.0 );// p.craftPlaneFull
export const uCraftLife = /*@__PURE__*/ uniform( 0.85 );     // p.craftSprayLife
export const uCraftPulse = /*@__PURE__*/ uniform( 0.30 );    // p.craftSprayPulse
export const uCraftLoad = /*@__PURE__*/ uniform( 0.0 );      // ctx.craftLoad, m/s^2
export const uCraftLoadFull = /*@__PURE__*/ uniform( 22.0 ); // p.craftLoadFull
export const uCraftSteer = /*@__PURE__*/ uniform( 0.0 );     // ctx.craftSteer
export const uCraftThrottle = /*@__PURE__*/ uniform( 0.0 );  // ctx.craftThrottle
export const uCraftSlip = /*@__PURE__*/ uniform( 0.0 );      // ctx.craftSlip, SIGNED m/s, + to starboard
export const uCraftAir = /*@__PURE__*/ uniform( 0.0 );       // ctx.craftAir, 1 = airborne
export const uCraftImpact = /*@__PURE__*/ uniform( 0.0 );    // ctx.craftImpact
export const uCraftJet = /*@__PURE__*/ uniform( 1.0 );       // p.craftJet
export const uCraftJetSpeed = /*@__PURE__*/ uniform( 17.0 ); // p.craftJetSpeed
export const uCraftJetAngle = /*@__PURE__*/ uniform( 0.60 ); // p.craftJetAngle, radians at full lock
export const uCraftJetRise = /*@__PURE__*/ uniform( 0.42 );  // p.craftJetRise
export const uCraftSheet = /*@__PURE__*/ uniform( 0.85 );    // p.craftSheet
export const uCraftSheetSpeed = /*@__PURE__*/ uniform( 0.42 );   // p.craftSheetSpeed
export const uCraftCurtain = /*@__PURE__*/ uniform( 1.15 );  // p.craftCurtain
export const uCraftCurtainSpeed = /*@__PURE__*/ uniform( 1.8 );  // p.craftCurtainSpeed
export const uCraftBurst = /*@__PURE__*/ uniform( 0.9 );     // p.craftBurst

// --- SPRAY_VS

export const uCamRight = /*@__PURE__*/ uniform( 'vec3' );    // ctx.camRight
export const uCamUp = /*@__PURE__*/ uniform( 'vec3' );       // ctx.camUp
export const uSizeScale = /*@__PURE__*/ uniform( 1.0 );      // p.spraySize
export const uStretch = /*@__PURE__*/ uniform( 0.014 );      // p.sprayStretch
export const uMistStretch = /*@__PURE__*/ uniform( 0.30 );   // p.sprayMistStretch
export const uMistGrow = /*@__PURE__*/ uniform( 2.0 );       // p.sprayMistGrow
export const uFadeNear = /*@__PURE__*/ uniform( 0.95 );      // p.sprayFadeNear
// p.sprayRadius - the SAME param as uSpawnRadius, deliberately a second uniform.
// src/spray.js:159-165: the fade must END where spawning ends. At 1.6x the spawn
// radius its window ran 134 m to 192 m while particles were only ever created
// out to 120 m, so it never touched the boundary it existed to soften - spray
// drew at full opacity right up to 120 m and then stopped, which is a hard step
// in density on a disc centred on the camera, i.e. a full-width horizontal line
// across the sea that travels with you.
export const uFadeFar = /*@__PURE__*/ uniform( 120.0 );
// gl.drawingBufferHeight. The driver overwrites it every draw from the bound
// target's height - see note 5.
export const uViewportH = /*@__PURE__*/ uniform( 1080.0 );
export const uMinPixels = /*@__PURE__*/ uniform( 1.15 );     // p.sprayMinPixels
export const uFarSoft = /*@__PURE__*/ uniform( 1.6 );        // p.sprayFarSoft

// --- SPRAY_FS

export const uOpacity = /*@__PURE__*/ uniform( 0.85 );       // p.sprayOpacity
export const uMistOpacity = /*@__PURE__*/ uniform( 0.0 );    // p.sprayMistOpacity
export const uScatter = /*@__PURE__*/ uniform( 1.0 );        // p.sprayScatter
export const uAmbient = /*@__PURE__*/ uniform( 0.6 );        // p.sprayAmbient
export const uMulti = /*@__PURE__*/ uniform( 0.05 );         // p.sprayMulti
export const uForwardG = /*@__PURE__*/ uniform( 0.80 );      // p.sprayForwardG
export const uBackG = /*@__PURE__*/ uniform( 0.35 );         // p.sprayBackG
export const uSurfFade = /*@__PURE__*/ uniform( 0.30 );      // p.spraySurfFade
// GLSL name is uAerial. RENAMED - see note 2. p.sprayAerial is an extinction
// coefficient per metre; water-surface's uAerial is a dimensionless weight of
// 1.0, and importing that one would multiply this exponent by 833.
export const uSprayAerial = /*@__PURE__*/ uniform( 0.0012 );
export const uGrain = /*@__PURE__*/ uniform( 0.85 );         // p.sprayGrain
export const uMistGrain = /*@__PURE__*/ uniform( 0.55 );     // p.sprayMistGrain
export const uGrainScale = /*@__PURE__*/ uniform( 5.2 );     // p.sprayGrainScale
export const uGrainAniso = /*@__PURE__*/ uniform( 1.5 );     // p.sprayGrainAniso
export const uHullOpacity = /*@__PURE__*/ uniform( 1.0 );    // p.craftSprayOpacity
export const uHullMulti = /*@__PURE__*/ uniform( 0.28 );     // p.craftSprayMulti

// --- SPRAY_HAZE_FS

// p.sprayHaze times a CPU wind gate. At the defaults (windSpeed 11 against
// sprayHazeWind 20) the gate is 0, so the driver skips the pass entirely.
export const uHazeDensity = /*@__PURE__*/ uniform( 0.0 );
export const uHazeHeight = /*@__PURE__*/ uniform( 12.0 );    // p.sprayHazeHeight
export const uHazeScatter = /*@__PURE__*/ uniform( 1.0 );    // p.sprayHazeScatter
export const uHazeAmbient = /*@__PURE__*/ uniform( 0.7 );    // p.sprayHazeAmbient
export const uHazeG = /*@__PURE__*/ uniform( 0.6 );          // p.sprayHazeG
export const uHazeSheets = /*@__PURE__*/ uniform( 0.7 );     // p.sprayHazeSheets
export const uHazeSheetScale = /*@__PURE__*/ uniform( 1.0 / 260.0 );  // 1/max(p.sprayHazeSheetSize,1)
// FLOAT, not int, and not optional - see note 9.
export const uHazeSteps = /*@__PURE__*/ uniform( 12.0 );     // Math.round(p.sprayHazeSteps)

// Vector defaults, spelled out because uniform('vecN') starts at zero.
uCraftPos.value.set( 0.0, - 1e4, 0.0 );   // parked below the sea
uCraftFwd.value.set( 0.0, 1.0 );
uCraftRight.value.set( 1.0, 0.0 );
uCamRight.value.set( 1.0, 0.0, 0.0 );
uCamUp.value.set( 0.0, 1.0, 0.0 );

// ---- the varyings ------------------------------------------------------------
// SPRAY_VS:499-501 and SPRAY_FS:618-620, one for one: same names, same types,
// no packing. sprayPosition() ASSIGNS them, sprayFragment() READS them, and they
// must be the positionNode and fragmentNode of ONE NodeMaterial or the fragment
// stage reads nothing (./water-surface.js note 4).
//
// Fourteen of them - ten float, one vec2, three vec3, 21 components. Not a risk:
// the shipping SPRAY_VS declares exactly these fourteen and links on WebGL2
// today, and three's NodeMaterial with a custom positionNode and fragmentNode
// adds none of its own. Do not "helpfully" pack them - the 1:1 mapping is what
// lets a diff against SPRAY_VS/SPRAY_FS read straight down.

export const vCorner = /*@__PURE__*/ varyingProperty( 'vec2', 'vCorner' );
export const vFade = /*@__PURE__*/ varyingProperty( 'float', 'vFade' );
export const vMist = /*@__PURE__*/ varyingProperty( 'float', 'vMist' );
export const vEnergy = /*@__PURE__*/ varyingProperty( 'float', 'vEnergy' );
export const vSoft = /*@__PURE__*/ varyingProperty( 'float', 'vSoft' );
export const vSeed = /*@__PURE__*/ varyingProperty( 'float', 'vSeed' );
export const vSize = /*@__PURE__*/ varyingProperty( 'float', 'vSize' );
export const vShape = /*@__PURE__*/ varyingProperty( 'float', 'vShape' );
export const vTex = /*@__PURE__*/ varyingProperty( 'float', 'vTex' );
export const vSurfDelta = /*@__PURE__*/ varyingProperty( 'float', 'vSurfDelta' );
export const vHull = /*@__PURE__*/ varyingProperty( 'float', 'vHull' );
export const vWorld = /*@__PURE__*/ varyingProperty( 'vec3', 'vWorld' );
export const vSun = /*@__PURE__*/ varyingProperty( 'vec3', 'vSun' );
export const vAmb = /*@__PURE__*/ varyingProperty( 'vec3', 'vAmb' );

// ---- SAMPLE_OCEAN ------------------------------------------------------------
//
// PLAIN JS NODE-GRAPH BUILDERS, NOT Fns - ./water-common.js note 3. Each
// contains a JS-unrolled cascade loop whose index picks a uniformArray element
// AND a texture-array layer, and both must be compile-time constants. They
// append to the current TSL stack, so they MUST be called from inside an Fn body.

// uniformArray.element() builds its index as `uint` unless the index node is
// already an integer type, which would emit `uPatch[ uint( 0.0 ) ]`. Wrapping
// the JS number in int() keeps the generated index a plain integer literal on
// both backends. One helper so the four call sites cannot disagree.
function patchOf( c ) {

	return uPatch.element( int( c ) );

}

// The FFT fields are indexed by the undisplaced (Lagrangian) coordinate, but a
// particle lives at a world point, and choppiness moves the surface several
// metres horizontally on a storm sea. Feeding a world coordinate straight into
// the lookup therefore reports the height of whatever water happens to share the
// crest's label - which in a big sea is often metres above the particle, so
// every droplet drowned on the frame it was born and force 10 produced no spray
// at all. Two fixed-point iterations invert the mapping to well inside a
// billboard's width.
//
//   vec2 dispXZ(vec2 q){
//     vec2 d = vec2(0.0);
//     for (int c=0;c<4;c++){
//       if (c >= uCascadeCount) break;
//       d += textureLod(uDisp, vec3(q/uPatch[c], float(c)), 0.0).xz;
//     }
//     return d;
//   }
//
// UNREFERENCED by this module's own passes - see note 10.
export function dispXZ( q ) {

	const qV = q.toVar();
	const d = vec2( 0.0 ).toVar();

	for ( let c = 0; c < CASCADE_CAP; c ++ ) {

		// GLSL: `if (c >= uCascadeCount) break;`
		If( int( c ).lessThan( uCascadeCount ), () => {

			d.addAssign(
				dispTexture.sample( qV.div( patchOf( c ) ) ).depth( int( c ) ).level( 0 ).xz,
			);

		} );

	}

	return d;

}

//   vec2 toLagrange(vec2 world){
//     vec2 q = world - dispXZ(world);
//     return world - dispXZ(q);
//   }
//
// UNREFERENCED by this module's own passes - see note 10.
export function toLagrange( world ) {

	const w = world.toVar();
	const q = w.sub( dispXZ( w ) ).toVar();

	return w.sub( dispXZ( q ) );

}

//   float heightAt(vec2 q){
//     float h = 0.0;
//     for (int c=0;c<4;c++){
//       if (c >= uCascadeCount) break;
//       h += textureLod(uDisp, vec3(q/uPatch[c], float(c)), 0.0).y;
//     }
//     return h;
//   }
export function heightAt( q ) {

	const qV = q.toVar();
	const h = float( 0.0 ).toVar();

	for ( let c = 0; c < CASCADE_CAP; c ++ ) {

		If( int( c ).lessThan( uCascadeCount ), () => {

			h.addAssign(
				dispTexture.sample( qV.div( patchOf( c ) ) ).depth( int( c ) ).level( 0 ).y,
			);

		} );

	}

	return h;

}

//   float oceanHeight(vec2 world){ return heightAt(toLagrange(world)); }
//
// UNREFERENCED by this module's own passes - see note 10.
export function oceanHeight( world ) {

	return heightAt( toLagrange( world ) );

}

// The same answer to within a few centimetres for a third of the fetches, which
// is what both callers here actually need: one decides whether a droplet has
// drowned and the other fades a billboard out over a 30 cm band. The short
// cascades contribute millimetres of *horizontal* displacement, so inverting the
// mapping over the two longest ones and doing it once is plenty - and this runs
// per particle in the sim and per vertex in the draw pass, six times per
// billboard, which made it the most expensive thing in the whole spray system.
//
//   float oceanHeightFast(vec2 world){
//     vec2 d = vec2(0.0);
//     for (int c=0;c<2;c++){
//       if (c >= uCascadeCount) break;
//       d += textureLod(uDisp, vec3(world/uPatch[c], float(c)), 0.0).xz;
//     }
//     return heightAt(world - d);
//   }
//
// NOTE THE BOUND: the displacement loop is FAST_CASCADE_CAP = 2, and the
// heightAt() it calls is still the full CASCADE_CAP = 4.
export function oceanHeightFast( world ) {

	const w = world.toVar();
	const d = vec2( 0.0 ).toVar();

	for ( let c = 0; c < FAST_CASCADE_CAP; c ++ ) {

		If( int( c ).lessThan( uCascadeCount ), () => {

			d.addAssign(
				dispTexture.sample( w.div( patchOf( c ) ) ).depth( int( c ) ).level( 0 ).xz,
			);

		} );

	}

	return heightAt( w.sub( d ) );

}

// x: height, y: fresh whitecap fraction (water tumbling this instant),
// z: total whitecap fraction (tumbling plus the raft it leaves behind).
//
// The foam pass already answers "is this crest breaking" properly - crest-line
// averaging, a ridge test across the crest, a forward-face gate and a threshold
// expressed in units of the sea's own RMS compression. Re-deriving that here
// from a raw single-texel Jacobian was the reason spray came off large stretches
// of merely steep water instead of off breakers, so the emission reads the foam
// pass's own answer. Channel y is the dense crest foam that exists only while
// the water is actually tumbling; x includes the long-lived raft.
// q is a Lagrangian coordinate; dxz returns the horizontal displacement so the
// caller can place the particle at the world point that label lands on.
//
//   vec3 oceanAt(vec2 q, out vec2 dxz){
//     float h = 0.0, fresh = 0.0, tot = 0.0;
//     dxz = vec2(0.0);
//     for (int c=0;c<4;c++){
//       if (c >= uCascadeCount) break;
//       vec3 uvc = vec3(q/uPatch[c], float(c));
//       // Explicit LOD: spawn sites are random per fragment, so the implicit
//       // derivatives would pick a near-top mip where every crest has averaged away.
//       vec4 d = textureLod(uDisp, uvc, 0.0);
//       h += d.y; dxz += d.xz;
//       vec4 f = textureLod(uFoam, uvc, 0.0);
//       fresh += f.y;
//       tot   += f.x;
//     }
//     return vec3(h, fresh, tot);
//   }
//
// The `out vec2 dxz` becomes a second returned .toVar(). Call it exactly as the
// GLSL reads:  const { o, dxz } = oceanAt( xz );
export function oceanAt( q ) {

	const qV = q.toVar();

	const h = float( 0.0 ).toVar();
	const fresh = float( 0.0 ).toVar();
	const tot = float( 0.0 ).toVar();
	const dxz = vec2( 0.0 ).toVar();

	for ( let c = 0; c < CASCADE_CAP; c ++ ) {

		If( int( c ).lessThan( uCascadeCount ), () => {

			// The GLSL packs the layer into a vec3 uv; TSL takes it as .depth().
			const uvc = qV.div( patchOf( c ) ).toVar();

			const d = dispTexture.sample( uvc ).depth( int( c ) ).level( 0 ).toVar();
			h.addAssign( d.y );
			dxz.addAssign( d.xz );

			const f = foamTexture.sample( uvc ).depth( int( c ) ).level( 0 ).toVar();
			fresh.addAssign( f.y );
			tot.addAssign( f.x );

		} );

	}

	const o = vec3( h, fresh, tot ).toVar();

	return { o, dxz };

}

// ---- SPRAY_PARTICLE_GLSL -----------------------------------------------------
// Per-particle constants derived from the index alone. Shared verbatim by the
// simulation and the draw pass so both agree without a round trip through the
// state textures.

// float sprayIsMist(float id){ return step(hash11(id*0.01571 + 0.317), uMistFrac); }
//
// step(edge, x): the HASH is the edge and uMistFrac the value, so a higher
// uMistFrac makes MORE mist. Backwards this inverts the whole population.
export const sprayIsMist = /*@__PURE__*/ Fn( ( [ id ] ) => {

	return step( hash11( id.mul( 0.01571 ).add( 0.317 ) ), uMistFrac );

} );

// Droplets are a near-field effect - past a hundred metres or so they are
// sub-pixel and carry nothing. The suspended veil is the opposite: it is what
// the middle distance is made of, so it works over a much larger disc.
//
// float sprayReach(float id, float radius){ return radius * mix(1.0, max(uMistRadius,1.0), sprayIsMist(id)); }
export const sprayReach = /*@__PURE__*/ Fn( ( [ id, radius ] ) => {

	return radius.mul( mix( float( 1.0 ), uMistRadius.max( 1.0 ), sprayIsMist( id ) ) );

} );

// Where this particle sits along its tear-off sheet: 0 is the leading edge that
// the wind rips off first, 1 the trailing tail that shreds into fine droplets.
// A block of consecutive ids therefore spans one whole sheet, which is what
// turns a burst into something with a front and a wake instead of a fountain.
//
// float sprayShred(float id){ return fract(id / max(uSheetSize, 1.0)); }
//
// THIS IS NOT uShred, which is a length in metres. Different things.
export const sprayShred = /*@__PURE__*/ Fn( ( [ id ] ) => {

	return id.div( uSheetSize.max( 1.0 ) ).fract();

} );

// float sprayLifeTotal(float id){
//   float r = hash11(id*0.02311 + 7.13);
//   // The leading sheet is heavy water and falls back quickly; the shredded tail
//   // is what stays airborne and streams downwind.
//   float u = sprayShred(id);
//   return mix(uLifetime * (0.30 + 1.10*r) * (0.55 + 0.85*u),
//              uMistLifetime * (0.45 + 1.20*r), sprayIsMist(id));
// }
export const sprayLifeTotal = /*@__PURE__*/ Fn( ( [ id ] ) => {

	const r = hash11( id.mul( 0.02311 ).add( 7.13 ) ).toVar();
	const u = sprayShred( id ).toVar();

	return mix(
		uLifetime.mul( float( 0.30 ).add( r.mul( 1.10 ) ) ).mul( float( 0.55 ).add( u.mul( 0.85 ) ) ),
		uMistLifetime.mul( float( 0.45 ).add( r.mul( 1.20 ) ) ),
		sprayIsMist( id ),
	);

} );

// Spray is overwhelmingly small droplets with a thin tail of big ones, so the
// uniform sample is cubed rather than used straight. The leading edge of a
// sheet is still coherent water, so it carries the large parcels.
//
// float sprayRadius(float id){
//   float r = hash11(id*0.04173 + 3.77);
//   float u = sprayShred(id);
//   float drop = mix(uSizeMin, uSizeMax, r*r*r) * (0.55 + 0.75*(1.0-u)*(1.0-u));
//   return mix(drop, uMistSize * (0.4 + 1.5*r), sprayIsMist(id));
// }
//
// NOT p.sprayRadius, which is the spawn disc (uSpawnRadius / uFadeFar).
export const sprayRadius = /*@__PURE__*/ Fn( ( [ id ] ) => {

	const r = hash11( id.mul( 0.04173 ).add( 3.77 ) ).toVar();
	const u = sprayShred( id ).toVar();
	const oneMinusU = float( 1.0 ).sub( u ).toVar();

	const drop = mix( uSizeMin, uSizeMax, r.mul( r ).mul( r ) )
		.mul( float( 0.55 ).add( oneMinusU.mul( oneMinusU ).mul( 0.75 ) ) ).toVar();

	return mix( drop, uMistSize.mul( float( 0.4 ).add( r.mul( 1.5 ) ) ), sprayIsMist( id ) );

} );

// ---- SPRAY_SIM_FS ------------------------------------------------------------

// The two colour attachments, as a struct so the whole simulation can be ONE Fn
// body and still come out of outputStruct - see note 4.
//
//   layout(location=0) out vec4 oPos;   // xyz world, w life remaining (s)
//   layout(location=1) out vec4 oVel;   // xyz velocity, w birth energy (SIGNED)
const SPRAY_STATE_STRUCT = /*@__PURE__*/ struct( { oPos: 'vec4', oVel: 'vec4' }, 'SpraySimOut' );

// SPRAY_SIM_FS main(). See note 1 for why the index space is uv() and note 4 for
// why this is a struct rather than two Fns.
const spraySimBody = /*@__PURE__*/ Fn( ( [ posTex, velTex ] ) => {

	// vec4 P = texture(uPos, vUv); vec4 V = texture(uVel, vUv);
	//
	// uv(), NOT glScreenUV(): this is an INDEX SPACE, not a picture - note 1.
	const uvN = uv().toVar();
	const P = posTex.sample( uvN ).level( 0 ).toVar();
	const V = velTex.sample( uvN ).level( 0 ).toVar();

	// float fid = floor(vUv.y*uTexSize)*uTexSize + floor(vUv.x*uTexSize);
	const fid = uvN.y.mul( uTexSize ).floor().mul( uTexSize )
		.add( uvN.x.mul( uTexSize ).floor() ).toVar();

	const mist = sprayIsMist( fid ).toVar();
	// uWindDirV IS the GLSL's uWind - a VELOCITY in m/s, so its LENGTH is U10.
	const wind = uWindDirV.length().toVar();
	const wdir = select( wind.greaterThan( 0.01 ), uWindDirV.div( wind ), vec3( 1.0, 0.0, 0.0 ) ).toVar();
	const tang = vec3( wdir.z.negate(), 0.0, wdir.x ).toVar();
	const ep = uFrame.mod( 2048.0 ).toVar();
	const reach = sprayReach( fid, uSpawnRadius ).toVar();

	const oPos = vec4( 0.0 ).toVar();
	const oVel = vec4( 0.0 ).toVar();

	If( P.w.lessThanEqual( 0.0 ), () => {

		// ------------------------------------------------------------- birth
		//
		// The GLSL's fall-through, `oPos = vec4(P.xyz, 0.0); oVel = V;`, sits at
		// the END of this branch and is reached when neither the hull nor any of
		// the retries claimed the particle. Here it is the INITIAL value, written
		// first and overwritten by whichever path fires - value-identical, and it
		// is what removes the need for a third flag.
		oPos.assign( vec4( P.xyz, 0.0 ) );
		oVel.assign( V );

		// The hull is a far denser source than the open sea whenever it is
		// working, so it gets first claim on a dead particle. Droplets, never
		// mist: what the hull throws is heavy water, not spindrift.
		//
		// A wave runner does not have "a spray". It has four sources, each with
		// its own place on the hull, its own launch direction and its own shape,
		// and which of them is loud depends entirely on what the rider is doing:
		//
		//   1  the pump jet, leaving the steering nozzle wherever the bars point
		//   2  the chine sheets, peeled off the planing surfaces and thrown out flat
		//   3  the slip curtain, shovelled up by a hull sliding sideways out of a turn
		//   4  the bow burst, thrown forward when the hull lands or punches a crest
		//
		// The previous emitter had one point, one direction, and a wide random
		// cone laid over the top to break up the parallel streaks that direction
		// produced. The cone worked, but it is isotropic: it threw away every bit
		// of directional information the launch had, which is exactly why a hard
		// turn looked the same as a straight run. Each source now gets a cone of
		// its own, oriented along something physical, and its own weight.
		//
		// A displacement hull throws almost nothing: below planing speed a ski
		// just pushes a bow wave and a little wash, so the terms below have
		// thresholds rather than slopes through the origin.
		const plane = smoothstep( uCraftPlane, uCraftPlaneFull, uCraftSpeed ).toVar();
		const load = smoothstep( float( 2.0 ), uCraftLoadFull, uCraftLoad ).toVar();
		const slipS = uCraftSlip.toVar();               // signed, m/s, positive to starboard
		const slipA = slipS.abs().toVar();
		const wet = float( 1.0 ).sub( uCraftAir ).toVar();   // out of the water, out of water

		// Water does not shed at a constant rate: a chine bites, sheds a sheet
		// and reloads. Each source runs on its own clock, because one shared
		// pulse made the whole plume breathe as a single object rather than as
		// several.
		const pJet = float( 0.72 ).add( uTime.mul( 19.7 ).sin().mul( 0.28 ) ).toVar();
		const pSheet = float( 0.28 ).add(
			float( 0.5 ).add(
				uTime.mul( 8.7 ).add( hash11( uTime.mul( 3.0 ).floor() ).mul( 13.0 ) ).sin().mul( 0.5 ),
			).pow( 1.7 ).mul( 0.72 ),
		).toVar();
		const pCurt = float( 0.34 ).add(
			float( 0.5 ).add( uTime.mul( 5.9 ).add( 2.1 ).sin().mul( 0.5 ) ).pow( 1.4 ).mul( 0.66 ),
		).toVar();

		// The pump runs off throttle, not off speed - which is why a ski standing
		// still on full lock still throws a tail, and why a carve that has
		// scrubbed all its speed does not go quiet.
		const wJet = uCraftJet.mul( uCraftThrottle )
			.mul( float( 0.30 ).add( plane.mul( 0.70 ) ) ).mul( pJet ).mul( wet ).toVar();
		const wSheet = uCraftSheet.mul( plane ).mul( pSheet ).mul( wet ).toVar();
		// Sideslip and hull load are what a carve actually is, and both survive
		// the speed a carve destroys.
		const wCurt = uCraftCurtain
			.mul( clamp( slipA.mul( 0.40 ).add( load.mul( 0.95 ) ), 0.0, 2.0 ) )
			.mul( pCurt ).mul( wet ).toVar();
		const wBurst = uCraftBurst.mul( uCraftImpact ).mul( 3.2 ).toVar();
		const wTot = wJet.add( wSheet ).add( wCurt ).add( wBurst ).toVar();

		const craftDrive = uCraftAmount.mul( float( 1.0 ).sub( mist ) ).mul( uCraftPulse )
			.mul( clamp( wTot, 0.0, 2.2 ) ).toVar();

		// GLSL: `if (craftDrive > 0.001 && hash12(...) < craftDrive){ ...; return; }`
		//
		// TSL has no short-circuiting &&, so hash12 is evaluated even when
		// craftDrive is 0. It is pure arithmetic with nothing to protect -
		// ./water-common.js note 7 makes the same call for wakeAt's two `||`s.
		const spawned = int( 0 ).toVar();

		If( craftDrive.greaterThan( 0.001 ).and(
			hash12( vec2( fid.mul( 0.0173 ).add( 5.7 ), ep.mul( 0.531 ) ) ).lessThan( craftDrive ),
		), () => {

			const hA = hash22( vec2( fid.mul( 0.311 ).add( 1.3 ), ep.mul( 0.617 ) ) ).toVar();   // where on the hull
			const hB = hash22( vec2( fid.mul( 0.719 ).add( 9.1 ), ep.mul( 0.233 ) ) ).toVar();   // where in the cone
			const hC = hash22( vec2( fid.mul( 1.093 ).add( 3.7 ), ep.mul( 0.409 ) ) ).toVar();   // how fast, how long
			const pick = hash12( vec2( fid.mul( 1.31 ).add( 4.4 ), ep.mul( 0.751 ) ) )
				.mul( wTot.max( 1e-5 ) ).toVar();
			const u = sprayShred( fid ).toVar();     // 0 leading edge, 1 shredded tail

			// A cheap hash does not have a mean of exactly 0.5, and a cone built
			// as (h*2 - 1) turns that small offset into a systematic sideways lean
			// of the entire plume: a dead straight run measurably sprayed more to
			// starboard than to port. Taking the *sign* from the particle index
			// and only the magnitude from the hash is symmetric whatever the
			// hash's mean is, and it costs nothing. Two independent bit planes, so
			// the two cone axes do not end up correlated into a diagonal.
			const sgnW = fid.mod( 2.0 ).mul( 2.0 ).sub( 1.0 ).toVar();
			const sgnN = fid.mul( 0.5 ).floor().mod( 2.0 ).mul( 2.0 ).sub( 1.0 ).toVar();
			const coin = fid.mul( 0.25 ).floor().mod( 2.0 ).mul( 2.0 ).sub( 1.0 ).toVar();   // exact 50/50 side

			const F = vec3( uCraftFwd.x, 0.0, uCraftFwd.y ).toVar();
			const Rt = vec3( uCraftRight.x, 0.0, uCraftRight.y ).toVar();
			const UP = vec3( 0.0, 1.0, 0.0 );        // GLSL: const vec3 UP
			const hullVel = F.mul( uCraftSpeed ).add( Rt.mul( slipS ) ).toVar();
			const spreadK = uCraftSpread.max( 0.0 ).toVar();
			const liftK = uCraftUp.max( 0.0 ).toVar();

			// The eight values the four branches write, with the GLSL's
			// initialisers. Those initialisers are live code, not decoration: they
			// are what an unreachable fifth case would produce.
			const org = vec3( 0.0 ).toVar();         // launch point, hull-relative
			const axis = F.negate().toVar();         // centre of the launch cone
			const relV = float( 1.0 ).toVar();       // launch speed relative to the hull
			const inherit = float( 0.4 ).toVar();    // how much of the hull's own motion it keeps
			const aWide = float( 0.3 ).toVar();      // cone half-angles, in and across the sheet
			const aNar = float( 0.3 ).toVar();
			const energy = float( 0.5 ).toVar();
			const lifeK = float( 1.0 ).toVar();      // heavy parcels hang around longer than fine ones

			If( pick.lessThan( wJet ), () => {

				// 1. Pump jet. The nozzle steers with the bars, and that single
				// fact is what makes a rooster tail sweep across a turn instead of
				// always trailing the hull's own heading. It is also aimed slightly
				// up, which is what stands the tail up behind the craft rather than
				// firing it flat.
				const na = uCraftJetAngle.mul( clamp( uCraftSteer, - 1.0, 1.0 ) ).toVar();
				axis.assign(
					F.negate().mul( na.cos() ).add( Rt.mul( na.sin() ) )
						.add( UP.mul( uCraftJetRise ).mul( liftK ) ).normalize(),
				);
				org.assign(
					F.negate().mul( uCraftLen ).mul( 0.95 )
						.add( Rt.mul( coin ).mul( hA.x ).mul( uCraftBeam ).mul( 0.25 ) )
						.add( UP.mul( float( 0.10 ).add( hA.y.mul( 0.26 ) ) ) ),
				);
				// A jet is coherent where it leaves and torn apart further along,
				// so the tail of each burst opens out far wider than its head.
				aWide.assign( float( 0.09 ).add( u.mul( 0.44 ) ).mul( spreadK ) );
				aNar.assign( float( 0.06 ).add( u.mul( 0.34 ) ).mul( spreadK ) );
				relV.assign(
					uCraftJetSpeed.mul( float( 0.60 ).add( hC.x.mul( 0.55 ) ) )
						.mul( float( 0.35 ).add( uCraftThrottle.mul( 0.65 ) ) ),
				);
				// The jet leaves at roughly the speed the hull is doing, in the
				// opposite direction, so in world terms the tail hangs almost still
				// behind the craft. Inheriting the hull's velocity here would fire
				// it forwards.
				inherit.assign( 0.16 );
				energy.assign( float( 0.45 ).add( uCraftThrottle.mul( 0.85 ) ) );
				lifeK.assign( 1.2 );

			} ).ElseIf( pick.lessThan( wJet.add( wSheet ) ), () => {

				// 2. Chine sheets. A planing hull's deadrise deflects water
				// sideways and slightly forward, leaving as a thin flat sheet - so
				// this cone is wide in the horizontal and almost closed in the
				// vertical. Anything else and the wings either side of a planing
				// hull come out as a cloud.
				//
				// `buried` is a FLOAT +/-1, not a bool.
				const buried = select( uCraftTurn.greaterThanEqual( 0.0 ), float( 1.0 ), float( - 1.0 ) ).toVar();
				const turnAmt = clamp( uCraftTurn.abs().mul( 1.6 ), 0.0, 0.85 ).toVar();
				// The buried rail does most of the work; the one the bank has
				// lifted clear does almost none. With no turn the exact coin splits
				// the two chines evenly, and the hash only ever biases *towards*
				// the buried side.
				const sd = mix( coin, buried, step( hA.y, turnAmt ) ).toVar();
				const isB = step( float( 0.5 ), sd.mul( buried ).mul( 0.5 ).add( 0.5 ) ).toVar();
				const sideGain = mix( float( 1.0 ).sub( turnAmt.mul( 0.80 ) ), float( 1.0 ).add( turnAmt ), isB ).toVar();
				org.assign(
					F.mul( hA.x.sub( 0.45 ) ).mul( uCraftLen ).mul( 1.1 )
						.add( Rt.mul( sd ).mul( uCraftBeam ).mul( 0.95 ) )
						.add( UP.mul( 0.05 ) ),
				);
				axis.assign(
					Rt.mul( sd ).mul( 0.86 ).add( F.mul( 0.42 ) )
						.add( UP.mul( 0.16 ).mul( liftK ) ).normalize(),
				);
				aWide.assign( float( 0.22 ).add( u.mul( 0.26 ) ).mul( spreadK ) );
				aNar.assign( float( 0.045 ).add( u.mul( 0.075 ) ).mul( spreadK ) );
				relV.assign( uCraftSpeed.mul( uCraftSheetSpeed ).mul( float( 0.70 ).add( hC.x.mul( 0.50 ) ) ) );
				inherit.assign( 0.50 );
				energy.assign( float( 0.30 ).add( plane.mul( 0.85 ) ).mul( sideGain ) );
				lifeK.assign( 0.85 );

			} ).ElseIf( pick.lessThan( wJet.add( wSheet ).add( wCurt ) ), () => {

				// 3. Slip curtain. In a carve the velocity lags the heading, so the
				// hull is travelling partly sideways and shovelling water with its
				// flank. That wall goes up and out on the side it is sliding
				// towards - the outside of the turn - which is the opposite side to
				// the chine sheet above, and getting the two on the correct sides is
				// most of what makes a hard turn read as a hard turn.
				const side = select( slipA.greaterThan( 0.05 ), slipS.sign(), coin ).toVar();
				org.assign(
					F.negate().mul( uCraftLen ).mul( float( 0.10 ).add( hA.x.mul( 0.70 ) ) )
						.add( Rt.mul( side ).mul( uCraftBeam ).mul( float( 0.80 ).add( hA.y.mul( 0.40 ) ) ) )
						.add( UP.mul( 0.06 ) ),
				);
				axis.assign(
					Rt.mul( side ).mul( 0.72 ).add( UP.mul( 0.62 ).mul( liftK ) )
						.sub( F.mul( 0.14 ) ).normalize(),
				);
				aWide.assign( float( 0.30 ).add( u.mul( 0.32 ) ).mul( spreadK ) );
				aNar.assign( float( 0.18 ).add( u.mul( 0.26 ) ).mul( spreadK ) );
				relV.assign(
					slipA.mul( uCraftCurtainSpeed ).add( load.mul( 4.5 ) ).add( uCraftSpeed.mul( 0.10 ) )
						.mul( float( 0.60 ).add( hC.x.mul( 0.60 ) ) ),
				);
				inherit.assign( 0.45 );
				energy.assign( clamp( float( 0.40 ).add( slipA.mul( 0.22 ) ).add( load.mul( 1.10 ) ), 0.0, 2.2 ) );
				lifeK.assign( 1.3 );

			} ).Else( () => {

				// 4. Bow burst. Landing off a crest or punching through one throws
				// water forward and up in a crown, and it is left behind almost at
				// once.
				org.assign(
					F.mul( uCraftLen ).mul( float( 0.60 ).add( hA.x.mul( 0.50 ) ) )
						.add( Rt.mul( coin ).mul( hA.y ).mul( uCraftBeam ).mul( 0.8 ) )
						.add( UP.mul( 0.04 ) ),
				);
				axis.assign( F.mul( 0.42 ).add( UP.mul( 0.86 ).mul( liftK ) ).normalize() );
				aWide.assign( float( 0.70 ).add( u.mul( 0.30 ) ).mul( spreadK ) );
				aNar.assign( float( 0.50 ).add( u.mul( 0.30 ) ).mul( spreadK ) );
				relV.assign(
					uCraftSpeed.mul( 0.35 ).add( uCraftImpact.mul( 9.0 ) )
						.mul( float( 0.50 ).add( hC.x.mul( 0.80 ) ) ),
				);
				inherit.assign( 0.35 );
				energy.assign( float( 0.55 ).add( uCraftImpact.mul( 1.35 ) ) );
				lifeK.assign( 1.1 );

			} );

			// The cone, oriented on the source's own axis. One tangent is
			// horizontal and the other carries the vertical, so a sheet can be
			// broad and flat while a splash is broad both ways - which one
			// isotropic cone cannot do.
			const wide = UP.cross( axis ).toVar();
			const wl = wide.length().toVar();
			wide.assign( select( wl.greaterThan( 1e-3 ), wide.div( wl ), vec3( 1.0, 0.0, 0.0 ) ) );
			const nar = axis.cross( wide ).toVar();
			const dir = axis
				.add( wide.mul( aWide.min( 1.25 ).tan() ).mul( sgnW ).mul( hB.x ) )
				.add( nar.mul( aNar.min( 1.25 ).tan() ).mul( sgnN ).mul( hB.y ) )
				.normalize().toVar();

			const v = hullVel.mul( inherit ).add( dir.mul( relV ) ).toVar();
			// Whatever leaves the hull immediately meets the craft's own apparent
			// wind.
			v.addAssign( uWindDirV.sub( hullVel ).mul( 0.08 ) );

			oPos.assign( vec4(
				uCraftPos.add( org ),
				uCraftLife.mul( float( 0.35 ).add( hC.y.mul( 0.80 ) ) ).mul( lifeK ),
			) );
			// Negative energy marks this as hull water rather than sea spray. It
			// costs no channel - the draw pass reads the magnitude and the sign
			// separately - and it is what lets a dense sheet thrown by a hull be
			// lit as the thick multiple-scattering whitewater it is, rather than as
			// a few wind-torn droplets that happen to be in the same place.
			oVel.assign( vec4( v, clamp( energy, 0.05, 1.35 ).negate() ) );

			spawned.assign( int( 1 ) );   // the GLSL's `return`

		} );

		If( spawned.equal( int( 0 ) ), () => {

			// Whitecaps start tearing at about F4 and the air is solid spindrift by
			// F10; mist needs a much stronger wind than ballistic droplets do.
			const gate = mix(
				smoothstep( uWindMin, uWindFull, wind ),
				smoothstep( uMistWind, uMistWind.add( 12.0 ), wind ),
				mist,
			).toVar();

			// Breaking water covers a few percent of the sea, so most candidate
			// sites are rejected. Retrying in proportion to the step keeps the
			// population the same whether the sim is running at 60 fps or at 3 -
			// one attempt per frame would make the whole system quietly frame-rate
			// dependent.
			const sheet = fid.div( uSheetSize.max( 1.0 ) ).floor().toVar();
			const u = sprayShred( fid ).toVar();
			const lead = float( 1.0 ).sub( u ).toVar();
			const tries = int( clamp( uDt.mul( 60.0 ).add( 0.5 ), 1.0, 16.0 ) ).toVar();

			// GLSL: `for (int t = 0; t < 16; t++){ if (t >= tries) break; ... }`.
			// The break is a `done` int flag every later iteration tests. A Loop and
			// not a JS unroll: the body indexes nothing at compile time, and sixteen
			// unrolled copies of an oceanAt() would be four hundred lines of
			// texture fetches.
			const done = int( 0 ).toVar();

			Loop( { start: int( 0 ), end: int( 16 ) }, ( { i } ) => {

				If( done.equal( int( 0 ) ).and( i.lessThan( tries ) ), () => {

					// Water is torn off a crest in sheets, not droplet by droplet: a
					// block of consecutive particles shares one tear-off site, so a
					// burst reads as a sheet shredding rather than a fountain of
					// independent dots. Each sheet runs on its own phase so they do
					// not all let go on the same tick.
					const epoch = uTime.mul( uSheetRate )
						.add( hash11( sheet.mul( 0.913 ).add( 4.1 ) ).mul( 8.0 ) ).floor()
						.add( float( i ).mul( 37.0 ) ).toVar();

					// GLSL: `if (hash12(...) > uSpawnRate * gate) continue;` - a
					// continue at the top of the body is an If around the rest of it,
					// so this is the positive complement.
					//
					// The rate roll is per tear-off event, not per particle. Rolling
					// it per particle decorrelates the block and hands back the
					// fountain of independent dots the sheet exists to avoid - and,
					// now that only a few percent of candidate sites are on breaking
					// water, it also throws away most of the few attempts a low frame
					// rate can afford.
					If( hash12( vec2( sheet.mul( 0.017 ).add( 3.1 ), epoch.mul( 0.311 ) ) )
						.lessThanEqual( uSpawnRate.mul( gate ) ), () => {

						const hs = hash22( vec2( sheet.mul( 0.7315 ).add( 1.7 ), epoch ) ).toVar();

						// Radial bias on the spawn disc. An exponent of 0.5 spreads
						// the budget uniformly over the area, which spends nearly all
						// of it on parcels smaller than a pixel; anything much above 1
						// piles a third of the population into the first ten metres,
						// where a handful of huge billboards smear over the whole
						// lower frame. Just past 1 is the compromise: density falling
						// as 1/r, which is roughly constant per unit of screen area.
						const r = reach.mul(
							float( 0.05 ).add( hs.x.pow( uSpawnFocus.max( 0.2 ) ).mul( 0.95 ) ),
						).toVar();
						// TAU_A is 6.28318530718 - the same twelve digits the GLSL
						// spells here. (SPRAY_FS's vSeed*6.28318 is NOT this number.)
						const a = hs.y.mul( TAU_A ).toVar();
						const base = uCamPos.xz.add( vec2( a.cos(), a.sin() ).mul( r ) ).toVar();

						const j1 = hash12( vec2( fid.mul( 0.037 ), epoch ) ).sub( 0.5 ).toVar();
						const j2 = hash12( vec2( fid.mul( 0.053 ).add( 5.0 ), epoch ) ).sub( 0.5 ).toVar();
						// The sheet lies along the crest line, i.e. across the wind,
						// and its tail is already trailing downwind at the moment it
						// lets go.
						const xz = base
							.add( tang.xz.mul( j1.mul( uSheetSpread ).mul( 2.0 ) ) )
							.add( wdir.xz.mul( u.mul( uShred ).add( j2.mul( uSheetSpread ).mul( 0.3 ) ) ) )
							.toVar();

						// vec2 dxz; vec3 o = oceanAt(xz, dxz);
						const { o, dxz } = oceanAt( xz );

						// Ballistic droplets are thrown by the break itself, so they
						// need water that is tumbling right now. Spindrift is scraped
						// off the surface of any whitewater by the wind, so the raft
						// counts too - which is why a gale grows a veil long after the
						// individual breakers have passed.
						const T = uFoldThreshold.max( 0.01 ).toVar();
						const brk = smoothstep( T.mul( clamp( uFoldSoft, 0.0, 0.95 ) ), T, o.y ).toVar();
						// GLSL calls this one `wet` too; the craft branch's `wet` is
						// still in JS scope here, so this one is spelled apart.
						const wetRaft = smoothstep(
							T.mul( 0.25 ).mul( clamp( uFoldSoft, 0.0, 0.95 ) ), T.mul( 0.25 ), o.z,
						).toVar();
						const energy = clamp(
							mix(
								mix( wetRaft, brk, clamp( uFoamBias, 0.0, 1.0 ) ),
								brk.max( wetRaft.mul( 0.7 ) ),
								mist,
							), 0.0, 1.0,
						).toVar();

						// GLSL: `if (energy <= 0.015) continue;` - again the positive
						// complement wrapped round the rest of the body.
						If( energy.greaterThan( 0.015 ), () => {

							// Born just clear of the lip, the leading edge highest. The
							// site was chosen in Lagrangian coordinates because that is
							// the frame the foam and fold fields live in; the particle
							// has to start where that piece of water actually is.
							const p = vec3(
								xz.x.add( dxz.x ),
								o.x.mul( uHeightScale ).add( uSeaLevel ).add( 0.06 )
									.add( float( 0.25 ).add( lead.mul( 0.45 ) ).mul( energy ) ),
								xz.y.add( dxz.y ),
							).toVar();

							const s1 = hash12( vec2( fid.mul( 0.071 ), epoch.mul( 0.23 ) ) ).toVar();
							const s2 = hash12( vec2( fid.mul( 0.091 ).add( 3.0 ), epoch.mul( 0.29 ) ) ).toVar();
							const s3 = hash12( vec2( fid.mul( 0.113 ).add( 9.0 ), epoch.mul( 0.31 ) ) ).toVar();

							// A spilling crest throws water forward along its own
							// travel and the wind immediately takes it: mostly
							// downwind, only modestly up. The leading edge leaves
							// fastest, which is what stretches the sheet as it flies.
							// The per-particle spread has to stay small or the block
							// turns into a starburst of spokes instead of one sheet
							// moving together.
							const v = wdir.mul(
								uLaunchSpeed
									.mul( float( 0.30 ).add( energy.mul( 0.95 ) ) )
									.mul( float( 0.30 ).add( lead.mul( 1.05 ) ) )
									.mul( float( 0.72 ).add( s1.mul( 0.42 ) ) ),
							).add( vec3( 0.0, 1.0, 0.0 ).mul(
								uLaunchSpeed.mul( uLaunchUp )
									.mul( float( 0.25 ).add( energy ) )
									.mul( float( 0.25 ).add( lead.mul( 0.95 ) ) )
									.mul( float( 0.55 ).add( s2.mul( 0.5 ) ) ),
							) ).add( tang.mul(
								s3.sub( 0.5 ).mul( uLaunchSpeed ).mul( 0.26 )
									.mul( float( 0.25 ).add( u.mul( 0.85 ) ) ),
							) ).toVar();

							v.addAssign( uWindDirV.mul( uLaunchWind ) );
							// Spindrift never has its own momentum - it leaves with the air.
							v.assign( mix(
								v,
								uWindDirV.mul( float( 0.65 ).add( s1.mul( 0.35 ) ) )
									.add( vec3( 0.0, uMistRise.mul( float( 0.4 ).add( s2 ) ), 0.0 ) ),
								mist,
							) );

							oPos.assign( vec4( p, sprayLifeTotal( fid ) ) );
							oVel.assign( vec4( v, energy ) );

							done.assign( int( 1 ) );   // the GLSL's `return`

						} );

					} );

				} );

			} );

		} );

	} ).Else( () => {

		// -------------------------------------------------------------- step
		const v = V.xyz.toVar();
		const sz = sprayRadius( fid ).toVar();
		// Drag time constant scales with droplet size: fine spray locks onto the
		// air within a metre, a heavy blob keeps flying ballistically.
		const k = mix( uDrag.mul( clamp( float( 0.16 ).div( sz.max( 0.02 ) ), 0.3, 5.0 ) ), uMistDrag, mist ).toVar();

		// Log wind profile. The shear is what bends spindrift streaks over and
		// makes the top of a plume outrun its base. .log() is MathNode.LOG, the
		// natural log, as the GLSL's log() is.
		const air = uWindDirV.mul(
			float( 1.0 ).add( uShear.mul(
				float( 1.0 ).add( P.y.sub( uSeaLevel ).max( 0.0 ).mul( 0.4 ) ).log(),
			) ),
		).toVar();
		v.addAssign( air.sub( v ).mul( clamp( k.mul( uDt ), 0.0, 1.0 ) ) );
		v.y.subAssign( uGravity.mul( mix( float( 1.0 ), uMistFall, mist ) ).mul( uDt ) );

		// Eddies scale with the wind that made them. The +31.0 and +77.0 are
		// scalar broadcasts onto all three components, as in the GLSL.
		const turb = vec3(
			vnoise( P.xyz.mul( 0.11 ).add( uTime.mul( 0.5 ) ) ),
			vnoise( P.xyz.mul( 0.11 ).add( 31.0 ).add( uTime.mul( 0.5 ) ) ),
			vnoise( P.xyz.mul( 0.11 ).add( 77.0 ).add( uTime.mul( 0.5 ) ) ),
		).sub( 0.5 ).toVar();
		v.addAssign(
			turb.mul( uTurbulence ).mul( float( 0.4 ).add( wind.mul( 0.05 ) ) )
				.mul( mix( float( 1.0 ), float( 2.2 ), mist ) ).mul( uDt ),
		);

		const p = P.xyz.add( v.mul( uDt ) ).toVar();
		const life = P.w.sub( uDt ).toVar();

		const surf = oceanHeightFast( p.xz ).mul( uHeightScale ).add( uSeaLevel ).toVar();
		If( p.y.lessThan( surf ), () => {

			life.assign( 0.0 );

		} );
		// Just past the fade rather than well past it: a particle out at 1.7x the
		// spawn radius has been invisible for a long time and is still costing a
		// simulation slot that a visible one could have had.
		If( distance( p.xz, uCamPos.xz ).greaterThan( reach.mul( 1.15 ) ), () => {

			life.assign( 0.0 );

		} );

		oPos.assign( vec4( p, life.max( 0.0 ) ) );
		oVel.assign( vec4( v, V.w ) );

	} );

	return SPRAY_STATE_STRUCT( oPos, oVel );

} );

/**
 * SPRAY_SIM_FS main(), as a two-attachment fragment node.
 *
 *   material.fragmentNode = spraySimFragment( posNode, velNode );
 *
 * A PLAIN FUNCTION returning the OutputStructNode itself - see note 4. Never
 * wrap the result in Fn().
 *
 * @param {TextureNode} posTex - the pos half of the target being READ.
 * @param {TextureNode} velTex - the vel half of the same target.
 */
export function spraySimFragment( posTex, velTex ) {

	// ONE call node, so the body is built once; two members off it.
	const s = spraySimBody( posTex, velTex );

	return outputStruct( s.get( 'oPos' ), s.get( 'oVel' ) );

}

// ---- SPRAY_VS ----------------------------------------------------------------

/**
 * SPRAY_VS main() minus gl_Position (note 5). Returns the WORLD-space billboard
 * corner and assigns all fourteen varyings as a side effect, exactly as the GLSL
 * does.
 *
 *   material.positionNode = sprayPosition( posNode, velNode );
 *
 * THE DEAD-PARTICLE PATH IS COLLAPSED, NOT PUSHED OFF SCREEN. The GLSL writes
 * `gl_Position = vec4(2,2,2,1)` and returns; positionNode cannot return a
 * clip-space vector, so every one of a dead particle's six corners returns the
 * same world point instead. All its triangles then have zero area and rasterise
 * no fragments - value-identical to an out-of-frustum quad, and cheaper.
 *
 * vSun and vAmb are assigned FIRST because the GLSL computes them ABOVE its
 * early return and the dead path inherits them.
 */
export const sprayPosition = /*@__PURE__*/ Fn( ( [ posTex, velTex ] ) => {

	// layout(location=0) in vec2 aCorner
	const aCorner = attribute( 'aCorner', 'vec2' );

	// int id = gl_InstanceID; int w = int(uTexSize);
	// vec2 uv = (vec2(float(id % w), float(id / w)) + 0.5) / uTexSize;
	//
	// instanceIndex is uint (gl_InstanceID / instance_index), so it is cast once.
	// `%` and `/` on ints are plain integer operators on both backends - porting
	// rule 2 is about min/max and does not apply.
	const idI = int( instanceIndex ).toVar();
	const w = int( uTexSize ).toVar();
	const uvp = vec2(
		float( idI.mod( w ) ).add( 0.5 ).div( uTexSize ),
		float( idI.div( w ) ).add( 0.5 ).div( uTexSize ),
	).toVar();

	const P = posTex.sample( uvp ).level( 0 ).toVar();
	const V = velTex.sample( uvp ).level( 0 ).toVar();

	// Both of these are constant over the whole draw, and the transmittance is an
	// eight step march. A billboard field this dense would pay for it millions of
	// times per frame in the fragment stage, so it is resolved here instead.
	//
	// uSunIrradiance IS the GLSL's uSunColor (both are p.sunIrradiance).
	vSun.assign(
		uSunIrradiance
			.mul( sunTransmittance( vec3( 0.0, uCamPos.y.max( 1.0 ).add( R_PLANET ), 0.0 ), uSunDir ) )
			.mul( uAtmoExposure )
			.mul( smoothstep( float( - 0.09 ), float( 0.02 ), uSunDir.y ) ),
	);
	vAmb.assign( skyLutTexture.sample( dirToSkyUv( vec3( 0.0, 1.0, 0.0 ) ) ).level( 4.0 ).rgb );

	// The GLSL's dead-particle values, verbatim, assigned before the live body
	// overwrites every one of them.
	vFade.assign( 0.0 );
	vCorner.assign( aCorner );
	vWorld.assign( vec3( 0.0 ) );
	vMist.assign( 0.0 );
	vEnergy.assign( 0.0 );
	vSoft.assign( 1.0 );
	vSeed.assign( 0.0 );
	vSize.assign( 0.0 );
	vShape.assign( 0.0 );
	vTex.assign( 0.0 );
	vSurfDelta.assign( 1.0 );
	vHull.assign( 0.0 );

	const world = vec3( 0.0 ).toVar();

	If( P.w.greaterThan( 0.0 ), () => {

		const fid = float( idI ).toVar();
		const mist = sprayIsMist( fid ).toVar();
		const shred = sprayShred( fid ).toVar();
		const age = float( 1.0 ).sub( clamp( P.w.div( sprayLifeTotal( fid ).max( 0.01 ) ), 0.0, 1.0 ) ).toVar();

		// Droplets hold their size and evaporate; mist keeps spreading as it disperses.
		const grow = mix(
			mix( float( 0.75 ), float( 1.15 ), age ),
			mix( float( 0.5 ), uMistGrow, age ),
			mist,
		).toVar();
		const size = sprayRadius( fid ).mul( uSizeScale ).mul( grow ).toVar();

		const dist = distance( uCamPos, P.xyz ).toVar();
		const far = sprayReach( fid, uFadeFar ).toVar();
		// Symmetric ramps at both ends of life and an absolute near clamp. The
		// relative one - so a puff the camera drifts into dissolves instead of
		// filling the frame - has to wait until the streak length is known.
		//
		// smoothstep(1.0, 0.62, age) HAS ITS EDGES DESCENDING ON PURPOSE. Keep the
		// order; do not rewrite it as smoothstep(0.62, 1.0, age).oneMinus().
		const fade = smoothstep( float( 0.0 ), float( 0.10 ), age )
			.mul( smoothstep( float( 1.0 ), float( 0.62 ), age ) )
			.mul( smoothstep( uFadeNear, uFadeNear.mul( 4.0 ), dist ) )
			.mul( float( 1.0 ).sub( smoothstep( far.mul( 0.7 ), far, dist ) ) )
			.toVar();

		// Most of the sea's spray is smaller than a pixel. Rasterised as-is it
		// either vanishes or twinkles, so anything under a pixel is grown to a
		// floor and dimmed by the same factor in area: the scattered energy is
		// preserved and a distant plume reads as the faint veil it actually is.
		//
		// THE GLSL's uViewProj, rebuilt from three's camera - note 5. The mesh's
		// model matrix is identity, so this IS uViewProj.
		const viewProj = cameraProjectionMatrix.mul( cameraViewMatrix ).toVar();
		const c0 = viewProj.mul( vec4( P.xyz, 1.0 ) ).toVar();
		const c1 = viewProj.mul( vec4( P.xyz.add( uCamUp.mul( size.max( 1e-4 ) ) ), 1.0 ) ).toVar();
		const spx = uMinPixels.toVar();

		If( c0.w.greaterThan( 1e-3 ), () => {

			const px = c1.xy.div( c1.w.max( 1e-3 ) ).sub( c0.xy.div( c0.w ) ).length()
				.mul( 0.5 ).mul( uViewportH ).toVar();
			const bump = clamp( uMinPixels.div( px.max( 1e-4 ) ), 1.0, 48.0 ).toVar();
			size.mulAssign( bump );
			fade.divAssign( bump.mul( bump ) );
			spx.assign( px.max( uMinPixels ) );

		} );

		// How much of this billboard's own structure the raster can actually
		// resolve. Everything below - outline raggedness, edge hardness, the
		// droplet texture - keys off this rather than off distance, because a
		// two-pixel parcel is a two-pixel parcel whether it is ten metres away or
		// two hundred, and drawing detail into it only buys speckle.
		const res = smoothstep( float( 1.6 ), float( 8.0 ), spx ).toVar();

		// Anisotropic billboard: the quad is stretched along the screen projection
		// of the velocity, which is what turns fast mist into streaks and leaves
		// slow droplets round. The projection length also handles foreshortening
		// for free.
		const rel = V.xyz.sub( uWindDirV.mul( 0.35 ) ).toVar();
		const rs = rel.length().toVar();
		const vd = select( rs.greaterThan( 0.01 ), rel.div( rs ), vec3( 0.0, 1.0, 0.0 ) ).toVar();
		const s = vec2( vd.dot( uCamRight ), vd.dot( uCamUp ) ).toVar();
		const sl = s.length().toVar();
		const ax = select( sl.greaterThan( 1e-4 ), s.div( sl ), vec2( 1.0, 0.0 ) ).toVar();
		const ay = vec2( ax.y.negate(), ax.x ).toVar();

		// The smear is an exposure, not a style knob: the parcel is drawn out by
		// the distance it covers while the shutter is open. Dividing by its own
		// size is what makes this read as spray - a fine droplet turns into a
		// filament while a heavy blob of the same speed barely elongates at all,
		// so one launch produces a whole range of shapes. Setting it as a raw
		// multiplier instead gave every particle the same aspect ratio and the
		// frame filled with parallel tracer streaks. The leading edge of a sheet
		// is still connected water, so it draws out further than the shredded tail
		// behind it.
		//
		// GLSL: uStretch * (0.6 + 1.0*(1.0-shred)). The `1.0*` is an exact
		// identity and is dropped.
		const smear = rs.mul( sl ).mul( mix(
			uStretch.mul( float( 0.6 ).add( float( 1.0 ).sub( shred ) ) ),
			uMistStretch,
			mist,
		) ).toVar();
		const elong = clamp( float( 1.0 ).add( smear.div( size.mul( 2.0 ).max( 0.02 ) ) ), 1.0, 8.0 ).toVar();
		// Stretching at constant area keeps a streak from also getting brighter.
		const q = ax.mul( aCorner.x.mul( size ).mul( elong ) )
			.add( ay.mul( aCorner.y.mul( size ).div( elong.sqrt() ) ) ).toVar();
		// Now that the quad's real extent is known: nothing may subtend more than
		// a modest fraction of the frame, or one near particle smears over
		// everything.
		fade.mulAssign( smoothstep( float( 1.2 ), float( 3.2 ), dist.div( size.mul( elong ).max( 0.02 ) ) ) );

		world.assign( P.xyz.add( uCamRight.mul( q.x ) ).add( uCamUp.mul( q.y ) ) );

		// Height clearance above the water, evaluated per vertex rather than per
		// fragment: the surface is flat to well under a millimetre over a
		// billboard, so interpolating the clearance across the quad gives the same
		// soft waterline for a twelfth of the texture fetches. Inverting the
		// Lagrangian mapping is not cheap and the fragment stage runs it millions
		// of times.
		vSurfDelta.assign( world.y.sub( oceanHeightFast( P.xz ).mul( uHeightScale ).add( uSeaLevel ) ) );
		vWorld.assign( world );
		vCorner.assign( aCorner );
		vFade.assign( fade );
		vMist.assign( mist );
		vEnergy.assign( V.w.abs() );
		// step(V.w, 0.0): V.w is the EDGE, 0.0 the value, so vHull is 1 when the
		// birth energy was written NEGATIVE to mark hull water.
		vHull.assign( step( V.w, float( 0.0 ) ) );
		vSize.assign( size );
		vSeed.assign( fid.mul( 0.618034 ).fract() );
		// Mist has no edge at all, and anything too small to resolve must be a
		// smooth veil rather than a hard dot, or the whole far field turns to
		// speckle.
		vSoft.assign( mix( float( 1.9 ), float( 2.8 ), mist ).add( uFarSoft.mul( float( 1.0 ).sub( res ) ) ) );
		// A torn scrap of water has a ragged outline once it is big enough to show one.
		vShape.assign( res.mul( float( 1.0 ).sub( mist.mul( 0.6 ) ) ) );
		vTex.assign( res );

	} );

	// WORLD space. Three's MVP finishes the job - note 5.
	return world;

} );

// ---- SPRAY_FS ----------------------------------------------------------------

/**
 * SPRAY_FS main(). Returns vec4(col*a, a) - PREMULTIPLIED, so the driver's
 * blend is ONE / ONE_MINUS_SRC_ALPHA.
 *
 *   material.fragmentNode = sprayFragment();
 */
export const sprayFragment = /*@__PURE__*/ Fn( () => {

	// A torn scrap of water is not a disc: a per-particle angular ripple keeps
	// the billboards from reading as a field of identical soft circles.
	const th = atan( vCorner.y, vCorner.x ).toVar();
	// vSeed*6.28318 is the TRUNCATED literal the GLSL spells. It is NOT TAU_A.
	const d = vCorner.length().mul( float( 1.0 ).add( vShape.mul(
		th.mul( 3.0 ).add( vSeed.mul( 6.28318 ) ).sin().mul( 0.24 )
			.add( th.mul( 7.0 ).add( vSeed.mul( 11.3 ) ).sin().mul( 0.13 ) ),
	) ) ).toVar();

	// GLSL: `if (d > 1.0) discard;`
	//
	// WGSL's discard does not terminate the invocation, so pow(1.0 - d, vSoft)
	// below still runs for a discarded fragment and is a NaN when d > 1. That is
	// correct - the fragment is discarded - and must NOT be "fixed" with a clamp,
	// which would change the value of live fragments at d exactly 1.
	Discard( d.greaterThan( 1.0 ) );

	// Weakly-breaking crests emit too, but faintly: the emission ramp is soft so
	// that spray production is continuous in how hard the crest is breaking
	// rather than a switch, and the birth energy has to carry that gradation
	// through to the opacity.
	const a = float( 1.0 ).sub( d ).pow( vSoft ).mul( vFade )
		.mul( mix( uOpacity, uMistOpacity, vMist ) )
		.mul( mix( float( 1.0 ), uHullOpacity, vHull ) )
		.mul( mix(
			float( 0.08 ).add( vEnergy.max( 0.0 ).pow( 0.6 ).mul( 0.92 ) ),
			float( 0.25 ).add( vEnergy.mul( 0.75 ) ),
			vMist,
		) ).toVar();

	// The one thing that separates spray from cotton wool. A parcel of spray is a
	// few thousand droplets with gaps between them, not a smooth gaussian, and a
	// smooth gaussian is exactly what a soft radial falloff draws. The mask lives
	// in billboard space so it stretches with the streak, and it is squashed
	// along the direction of travel because the wind draws every shred out into
	// filaments. It is faded out below a few pixels, where it could only alias.
	const g = mix( uGrain, uMistGrain, vMist ).mul( vTex ).toVar();

	If( g.greaterThan( 0.002 ), () => {

		const q = vec2( vCorner.x.div( uGrainAniso.max( 0.05 ) ), vCorner.y ).mul( uGrainScale )
			.add( vec2( vSeed.mul( 91.7 ), vSeed.mul( 57.3 ).add( 13.0 ) ) ).toVar();
		const n = fbm2( q, int( 2 ) ).toVar();
		// Rescaled back to roughly unit mean, so adding structure does not quietly
		// darken the whole system and get compensated for with opacity.
		a.mulAssign( mix( float( 1.0 ), clamp( n.sub( 0.34 ).mul( 3.4 ), 0.0, 1.0 ).mul( 1.55 ), g ) );

	} );

	// Fade out as the billboard enters the water instead of showing the hard
	// intersection edge a depth-tested quad would give. The band has to grow with
	// the billboard or a distant one held at the pixel floor cuts hard again.
	a.mulAssign( smoothstep( float( 0.0 ), uSurfFade.max( vSize.mul( 0.9 ) ), vSurfDelta ) );
	Discard( a.lessThan( 0.002 ) );

	const toCam = uCamPos.sub( vWorld ).toVar();
	const dist = toCam.length().toVar();
	const V = toCam.div( dist.max( 1e-4 ) ).toVar();

	// vSun is the solar irradiance reaching this altitude and vAmb the average
	// sky radiance, both resolved in the vertex stage.
	const sun = vSun.toVar();
	const amb = vAmb.toVar();

	// Water droplets scatter almost everything forward. Two lobes: a very narrow
	// one for the halo right around the sun and a broad one for the general glow,
	// plus a weak backscatter shoulder. Front-lit spray gets almost nothing from
	// this, which is exactly why backlit spray is the shot.
	const mu = V.dot( uSunDir ).negate().toVar();
	const phase = miePhase( mu, uForwardG ).mul( 0.62 )
		.add( miePhase( mu, uForwardG.mul( 0.55 ) ).mul( 0.30 ) )
		.add( miePhase( mu, uBackG.abs().negate() ).mul( 0.08 ) ).toVar();

	// Multiple scattering inside a dense sheet leaks light in every direction and
	// is what keeps front-lit spray white rather than grey.
	// sun is irradiance in LUT units, phase is per steradian, so the product is
	// already an outgoing radiance - no 4pi anywhere.
	// Water thrown by a hull is a dense sheet, and a dense sheet scatters light
	// many times inside itself before it leaves. That multiple scattering is what
	// makes real hull spray read as bright white from any direction, front-lit or
	// not - the single-scattering Mie lobe alone only lights it when the sun is
	// behind it, which left it a dull grey wash in every other shot.
	const multi = uMulti.mul( mix( float( 1.0 ), float( 1.7 ), vMist ) ).add( uHullMulti.mul( vHull ) ).toVar();
	const col = sun.mul( phase ).mul( uScatter )
		.add( sun.mul( multi ) )
		.add( amb.mul( uAmbient ).mul( mix( float( 1.0 ), float( 1.5 ), vHull ) ) ).toVar();

	// Distant spray has to sit back into the air like everything else.
	//
	// IMPLICIT LOD - no .level(). The GLSL writes a plain texture() and the table
	// is mipped, so this is not the same value as a level-0 fetch. Uniform
	// control flow here, so it is legal on WGSL. See note 6.
	const far = skyLutTexture.sample( dirToSkyUv( V.negate() ) ).rgb.toVar();
	const t = dist.negate().mul( uSprayAerial ).exp().toVar();
	col.assign( mix( far, col, t ) );

	return vec4( col.mul( a ), a );

} );

// ---- SPRAY_HAZE_FS -----------------------------------------------------------
//
// A wind-gated layer of suspended mist hugging the sea. The source function is
// constant along a given view ray, so all the march has to produce is the
// optical depth - which is where the physics lives. Two things matter: the sea
// curves away under a grazing ray, so the path through the layer is bounded
// instead of running thirty kilometres and painting a flat white band along the
// horizon, and the spume is torn off in drifting sheets rather than spread
// evenly, so the layer has to have structure.

/**
 * SPRAY_HAZE_FS main(). Returns vec4(col*alpha, alpha) - PREMULTIPLIED.
 *
 *   material.fragmentNode = sprayHazeFragment();
 *
 * This one IS a picture, so its screen coordinate is glScreenUV() - the GLSL's
 * FS_VERT vUv, v = 0 at the bottom - and not uv(). Contrast note 1.
 */
export const sprayHazeFragment = /*@__PURE__*/ Fn( () => {

	// vec4 c = uInvViewProj * vec4(vUv*2.0 - 1.0, 1.0, 1.0);
	// vec3 rd = normalize(c.xyz/c.w - uCamPos);
	const c = uInvViewProj.mul( vec4( glScreenUV().mul( 2.0 ).sub( 1.0 ), 1.0, 1.0 ) ).toVar();
	const rd = c.xyz.div( c.w ).sub( uCamPos ).normalize().toVar();

	const H = uHazeHeight.max( 0.5 ).toVar();
	const h0 = uCamPos.y.sub( uSeaLevel ).max( 0.0 ).toVar();
	const hTop = H.mul( 7.0 ).toVar();

	// Distances along the ray, on the curved sea. b and the discriminant come
	// from intersecting |camera + t*rd| with a sphere concentric with the planet.
	//
	// R_PLANET*R_PLANET is folded in JS: the double product is exact below 2^53
	// and rounds to the same float32 the GLSL compiler produces. ./atmosphere.js
	// already does this for R_ATMOS*R_ATMOS.
	const Rc = h0.add( R_PLANET ).toVar();
	const b = Rc.mul( rd.y ).toVar();
	const tEnd = float( 0.0 ).toVar();
	const discSea = b.mul( b ).sub( Rc.mul( Rc ).sub( R_PLANET * R_PLANET ) ).toVar();

	If( rd.y.lessThan( 0.0 ).and( discSea.greaterThan( 0.0 ) ), () => {

		tEnd.assign( b.negate().sub( discSea.sqrt() ) );        // the ray meets the water

	} ).Else( () => {

		const Rt = hTop.max( h0.add( 1.0 ) ).add( R_PLANET ).toVar();
		tEnd.assign( b.negate().add(
			b.mul( b ).add( Rt.mul( Rt ) ).sub( Rc.mul( Rc ) ).max( 0.0 ).sqrt(),
		) );                                                    // it leaves out of the top

	} );

	tEnd.assign( clamp( tEnd, 0.0, 80000.0 ) );
	Discard( tEnd.lessThan( 0.5 ) );

	// Geometric step spacing: the near field is where the structure is visible
	// and the far field only contributes a slowly varying tail.
	//
	// KS stays a JS literal; `norm` stays NODE math, so the GPU's exp() is the
	// one that runs, as it does today. Folding exp(3.2) in JS would be a last-ulp
	// change to every optical-depth sample.
	const norm = float( 1.0 ).div( float( KS ).exp().sub( 1.0 ) ).toVar();
	// GLSL: `int steps = clamp(uHazeSteps, 4, 24);` with uHazeSteps an int, which
	// is porting rule 2 on WebGL2. Through float instead - see note 9.
	const steps = int( uHazeSteps.clamp( 4.0, 24.0 ) ).toVar();
	const drift = uWindDirV.xz.mul( uTime ).mul( 0.35 ).toVar();

	const od = float( 0.0 ).toVar();
	const tPrev = float( 0.0 ).toVar();

	// GLSL: `for (int i = 1; i <= 24; i++){ if (i > steps) break; ... }`.
	// 1-BASED AND INCLUSIVE; TSL's end is EXCLUSIVE, so 25. Do not "correct" it.
	Loop( { start: int( 1 ), end: int( 25 ) }, ( { i } ) => {

		If( i.lessThanEqual( steps ), () => {

			const t1 = tEnd.mul(
				float( KS ).mul( float( i ) ).div( float( steps ) ).exp().sub( 1.0 ),
			).mul( norm ).toVar();
			const tm = tPrev.add( t1 ).mul( 0.5 ).toVar();
			// Height above the curved sea, to second order - exact enough at these
			// scales and far cheaper than a length().
			const hz = h0.add( tm.mul( rd.y ) )
				.add( tm.mul( tm ).mul( float( 1.0 ).sub( rd.y.mul( rd.y ) ) ).div( 2.0 * R_PLANET ) )
				.toVar();
			const dens = hz.max( 0.0 ).negate().div( H ).exp().toVar();

			If( uHazeSheets.greaterThan( 0.001 ), () => {

				const q = uCamPos.xz.add( rd.xz.mul( tm ) ).sub( drift ).mul( uHazeSheetScale ).toVar();
				dens.mulAssign( mix(
					float( 1.0 ),
					float( 0.25 ).add( fbm2( q, int( 3 ) ).mul( 1.75 ) ),
					clamp( uHazeSheets, 0.0, 1.0 ),
				) );

			} );

			od.addAssign( dens.mul( t1.sub( tPrev ) ) );
			tPrev.assign( t1 );

		} );

	} );

	const alpha = float( 1.0 ).sub( od.max( 0.0 ).negate().mul( uHazeDensity ).exp() ).toVar();
	Discard( alpha.lessThan( 0.002 ) );

	const sunTr = sunTransmittance( vec3( 0.0, uCamPos.y.max( 1.0 ).add( R_PLANET ), 0.0 ), uSunDir ).toVar();
	const sun = uSunIrradiance.mul( sunTr ).mul( uAtmoExposure )
		.mul( smoothstep( float( - 0.09 ), float( 0.02 ), uSunDir.y ) ).toVar();
	// Half zenith average, half the sky actually behind the layer: a haze bank
	// that ignores where it is being looked at reads as flat grey paint.
	const amb = mix(
		skyLutTexture.sample( dirToSkyUv( vec3( 0.0, 1.0, 0.0 ) ) ).level( 4.0 ).rgb,
		skyLutTexture.sample( dirToSkyUv( rd ) ).level( 3.0 ).rgb,
		float( 0.5 ),
	).toVar();

	const mu = rd.dot( uSunDir ).toVar();
	const phase = miePhase( mu, uHazeG ).mul( 0.75 ).add( miePhase( mu, uHazeG.mul( 0.4 ) ).mul( 0.25 ) ).toVar();
	const col = sun.mul( phase ).mul( uHazeScatter ).add( amb.mul( uHazeAmbient ) ).toVar();

	return vec4( col.mul( alpha ), alpha );

} );

// ---- uniform plumbing --------------------------------------------------------
// Mirrors src/spray.js's four setUniforms blocks, split the way the GLSL splits
// them. A driver calls all of them - porting rule 7.

const NO_CRAFT_POS = [ 0, - 1e4, 0 ];
const NO_CRAFT_FWD = [ 0, 1 ];
const NO_CRAFT_RIGHT = [ 1, 0 ];

/**
 * Spray.particleUniforms(p) plus uTexSize (src/spray.js:49-55).
 *
 * Class, lifetime and size are index-derived in the shaders, so the sim and the
 * draw path have to be handed exactly the same constants - which is why this is
 * its own block and both entry points call it.
 *
 * @param {object} p - the parameter set (src/presets.js `defaults`).
 * @param {number} texSize - the state textures' edge length (Spray's `size`).
 */
export function setSprayParticleUniforms( p, texSize ) {

	uMistFrac.value = p.sprayMist;
	uLifetime.value = p.sprayLifetime;
	uMistLifetime.value = p.sprayMistLife;
	uSizeMin.value = p.spraySizeMin;
	uSizeMax.value = p.spraySizeMax;
	uMistSize.value = p.sprayMistSize;
	uSheetSize.value = p.spraySheet;
	uMistRadius.value = p.sprayMistRadius;
	uTexSize.value = texSize;

}

/**
 * The SPRAY_SIM_FS-only block, including the whole craft emitter
 * (src/spray.js:66-108).
 *
 * `dt` is the RAW step: this function applies Math.min(dt, 0.05) itself, as
 * Spray.update does. A step longer than 50 ms would otherwise let a particle
 * tunnel through the sea surface between the position update and the drown test.
 *
 * @param {object} p
 * @param {object} ctx - the per-frame context (camPos, windVec3, craft*).
 * @param {number} dt - seconds since the last update, unclamped.
 * @param {number} frame - Spray.frame, incremented once per update.
 */
export function setSpraySimUniforms( p, ctx, dt, frame ) {

	uDt.value = Math.min( dt, 0.05 );
	uFrame.value = frame;

	uSpawnRadius.value = p.sprayRadius;
	uSpawnRate.value = p.sprayRate;
	uSpawnFocus.value = p.sprayFocus;
	uFoldThreshold.value = p.sprayThreshold;
	uFoldSoft.value = p.sprayFoldSoft;
	uFoamBias.value = p.sprayFoamBias;
	uWindMin.value = p.sprayWindMin;
	uWindFull.value = p.sprayWindFull;
	uMistWind.value = p.sprayMistWind;
	uSheetRate.value = p.spraySheetRate;
	uSheetSpread.value = p.spraySheetSpread;
	uShred.value = p.sprayShred;
	uGravity.value = p.sprayGravity;
	uDrag.value = p.sprayDrag;
	uMistDrag.value = p.sprayMistDrag;
	uMistFall.value = p.sprayMistFall;
	uMistRise.value = p.sprayMistRise;
	uLaunchSpeed.value = p.sprayLaunch;
	uLaunchUp.value = p.sprayLaunchUp;
	uLaunchWind.value = p.sprayLaunchWind;
	uTurbulence.value = p.sprayTurbulence;
	uShear.value = p.sprayShear;

	// The hull. Parked far below the sea with zero amount when nobody is riding,
	// so the emitter costs a branch and nothing else (src/spray.js:84-91).
	const cp = ctx?.craftPos ?? NO_CRAFT_POS;
	const cf = ctx?.craftFwd ?? NO_CRAFT_FWD;
	const cr = ctx?.craftRight ?? NO_CRAFT_RIGHT;
	uCraftPos.value.set( cp[ 0 ], cp[ 1 ], cp[ 2 ] );
	uCraftFwd.value.set( cf[ 0 ], cf[ 1 ] );
	uCraftRight.value.set( cr[ 0 ], cr[ 1 ] );
	uCraftSpeed.value = ctx?.craftSpeed ?? 0;
	uCraftTurn.value = ctx?.craftTurn ?? 0;
	uCraftAmount.value = ctx?.craftAmount ?? 0;
	uCraftLoad.value = ctx?.craftLoad ?? 0;
	// What the rider is doing, which is what decides where the water goes.
	uCraftSteer.value = ctx?.craftSteer ?? 0;
	uCraftThrottle.value = ctx?.craftThrottle ?? 0;
	uCraftSlip.value = ctx?.craftSlip ?? 0;
	uCraftAir.value = ctx?.craftAir ?? 0;
	uCraftImpact.value = ctx?.craftImpact ?? 0;

	uCraftSpread.value = p.craftSpraySpread;
	uCraftUp.value = p.craftSprayUp;
	uCraftPlane.value = p.craftPlaneSpeed;
	uCraftPlaneFull.value = p.craftPlaneFull;
	uCraftLife.value = p.craftSprayLife;
	uCraftPulse.value = p.craftSprayPulse;
	uCraftLoadFull.value = p.craftLoadFull;
	// p.wrBeam and p.wrLength - the hull's own dimensions, NOT the wake's.
	// ctx may override them: every spawn site below places particles within
	// these two lengths of uCraftPos, so a NON-vehicle body driving this
	// emitter (the sea dragon breaching - demo/three-main.js's dragonSpray)
	// must hand in its own footprint or every particle spawns inside its mesh
	// and is depth-tested away - measured exactly that way, invisible spray
	// with every uniform reading correct, before this fallback existed.
	uCraftBeam.value = ctx?.craftBeam ?? p.wrBeam;
	uCraftLen.value = ctx?.craftLen ?? p.wrLength;
	uCraftJet.value = p.craftJet;
	uCraftJetSpeed.value = p.craftJetSpeed;
	uCraftJetAngle.value = p.craftJetAngle;
	uCraftJetRise.value = p.craftJetRise;
	uCraftSheet.value = p.craftSheet;
	uCraftSheetSpeed.value = p.craftSheetSpeed;
	uCraftCurtain.value = p.craftCurtain;
	uCraftCurtainSpeed.value = p.craftCurtainSpeed;
	uCraftBurst.value = p.craftBurst;

}

/**
 * The SPRAY_VS + SPRAY_FS-only block (src/spray.js:148-177).
 *
 * @param {object} p
 * @param {object} ctx - { camRight, camUp, ... }
 * @param {number} viewportH - the bound target's height in pixels; the GLSL's
 *   gl.drawingBufferHeight. See note 5.
 */
export function setSprayDrawUniforms( p, ctx, viewportH ) {

	if ( ctx?.camRight ) uCamRight.value.set( ctx.camRight[ 0 ], ctx.camRight[ 1 ], ctx.camRight[ 2 ] );
	if ( ctx?.camUp ) uCamUp.value.set( ctx.camUp[ 0 ], ctx.camUp[ 1 ], ctx.camUp[ 2 ] );

	uSizeScale.value = p.spraySize;
	uStretch.value = p.sprayStretch;
	uMistStretch.value = p.sprayMistStretch;
	uMistGrow.value = p.sprayMistGrow;
	uFadeNear.value = p.sprayFadeNear;
	// p.sprayRadius, the SAME param as uSpawnRadius - see uFadeFar's declaration.
	uFadeFar.value = p.sprayRadius;
	uViewportH.value = viewportH;
	uMinPixels.value = p.sprayMinPixels;
	uFarSoft.value = p.sprayFarSoft;

	uOpacity.value = p.sprayOpacity;
	uMistOpacity.value = p.sprayMistOpacity;
	uScatter.value = p.sprayScatter;
	uAmbient.value = p.sprayAmbient;
	uMulti.value = p.sprayMulti;
	uForwardG.value = p.sprayForwardG;
	uBackG.value = p.sprayBackG;
	uSurfFade.value = p.spraySurfFade;
	uSprayAerial.value = p.sprayAerial;
	uGrain.value = p.sprayGrain;
	uMistGrain.value = p.sprayMistGrain;
	uGrainScale.value = p.sprayGrainScale;
	uGrainAniso.value = p.sprayGrainAniso;
	uHullOpacity.value = p.craftSprayOpacity;
	uHullMulti.value = p.craftSprayMulti;

}

/**
 * p.sprayHaze * smoothstep(p.sprayHazeWind, p.sprayHazeWind + 16, p.windSpeed)
 * - src/spray.js:118-119, using src/math.js's smoothstep so the two paths cannot
 * drift.
 *
 * Exported so a driver can reproduce Spray.drawHaze's `if (density <= 1e-7)
 * return` without duplicating the formula. At the defaults (windSpeed 11 against
 * sprayHazeWind 20) this is 0 and the pass is skipped entirely.
 *
 * NOTE the CPU gate is ASCENDING; the descending smoothstep in this unit is
 * SPRAY_VS's end-of-life fade. Do not confuse them.
 */
export function sprayHazeDensity( p ) {

	return p.sprayHaze * smoothstepJS( p.sprayHazeWind, p.sprayHazeWind + 16.0, p.windSpeed );

}

/**
 * The SPRAY_HAZE_FS block (src/spray.js:125-134).
 *
 * uHazeDensity is sprayHazeDensity(p) - the CPU-gated value, not p.sprayHaze -
 * and uHazeSheetScale is 1/max(p.sprayHazeSheetSize, 1).
 */
export function setSprayHazeUniforms( p, ctx ) {

	void ctx;   // taken so every spray setter has the same shape

	uHazeDensity.value = sprayHazeDensity( p );
	uHazeHeight.value = p.sprayHazeHeight;
	uHazeScatter.value = p.sprayHazeScatter;
	uHazeAmbient.value = p.sprayHazeAmbient;
	uHazeG.value = p.sprayHazeG;
	uHazeSheets.value = p.sprayHazeSheets;
	uHazeSheetScale.value = 1.0 / Math.max( p.sprayHazeSheetSize, 1 );
	// Math.round, exactly as src/spray.js:133 - the value is an exact integer
	// living in a float uniform. See note 9.
	uHazeSteps.value = Math.round( p.sprayHazeSteps );

	// uSeaLevel is ./water-surface.js's, but the HAZE reads it (sprayHazeFragment
	// takes uCamPos.y - uSeaLevel as the eye height above the sea) and the GL path
	// sets it inside drawHaze's own uniform block at src/spray.js:131. So it is
	// set here rather than left to setSprayOceanUniforms, which drawHaze does not
	// and should not call - drawHaze has no `ocean` argument.
	//
	// This is porting rule 13. Left out, the haze shades against whatever sea
	// level the water driver or a previous spray draw happened to leave behind:
	// correct in one draw order and wrong in another, with nothing raising a word.
	uSeaLevel.value = p.seaLevel;

}

/**
 * The cascade description the spray reads out of ./water-common.js and
 * ./water-surface.js, and NOTHING else.
 *
 * Deliberately not setWaterCommonUniforms() - see note 11: that one would force
 * uWakeOn to 0 when handed no wake, and the spray draws AFTER the water.
 *
 * @param {object} p
 * @param {object} ocean - an Ocean whose update() has already run this frame.
 */
export function setSprayOceanUniforms( p, ocean ) {

	if ( ocean ) {

		const patch = ocean.patchSizes;   // getter: allocates, so read it once

		for ( let i = 0; i < CASCADE_CAP; i ++ ) {

			// `?? 1` for ./water-common.js's reason: patchSizes is length
			// cascadeCount, not necessarily CASCADE_CAP, and UniformArrayNode.update
			// copies undefined into a Float32Array as NaN. The `c < uCascadeCount`
			// guard means that slot is never sampled, so it is a latent trap rather
			// than a live bug - but a NaN in a uniform buffer is not something to
			// leave lying in the frame.
			uPatch.array[ i ] = patch[ i ] ?? 1;

		}

		uCascadeCount.value = ocean.cascadeCount;

		// disp and foam only. The spray never reads uSlope, so it is left alone
		// rather than unbound. Only adopt real three Textures: an Ocean backed by
		// raw GL has none, and that driver binds through setCascadeTextures itself.
		setCascadeTextures( {
			disp: ocean.disp?.isTexture ? ocean.disp : undefined,
			foam: ocean.foamTex?.isTexture ? ocean.foamTex : undefined,
		} );

	}

	uHeightScale.value = p.heightScale;
	uSeaLevel.value = p.seaLevel;

}
