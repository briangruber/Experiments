// The wave simulation, driven. The node-graph counterpart of src/ocean.js: it
// owns the render targets, the thirteen materials, the pass schedule and the mip
// protocol, and it exposes the same surface an `Ocean` does - N, L, C, time,
// dirty, seed, spinUp, whitecap, foamIdx, disp, slope, foamTex, cascadeCount,
// patchSizes, bandLimits, choppinessFor, kChar, breakLods, breakWeights,
// buildSpectrum, update, setSeed - so setWaterCommonUniforms(p, ctx, sim, wake)
// binds it unchanged and a caller can hold either behind one interface.
//
// Ported from src/ocean.js: _buildTargets (the target table), buildSpectrum,
// update and _foamStep (the schedule, the order and the spin-up).
//
// Runs on WebGPU and on WebGL2 from one source. The stage graphs are in
// ./ocean-sim.js; read that file's header first - the index-space and
// orientation argument lives there and everything here depends on it.
//
// At N = 256, C = 4, stages = 8 a steady frame is
//   4 evolve + 64 fft + 4 assemble + 4 foam + 4 publish = 80 renderer.render()
// calls; the shipping GL path issues 76 equivalent draws through Blitter. A
// rebuild frame adds 4 spectrum draws and 30 x 4 spin-up foam draws.
//
// ---------------------------------------------------------------------------
// 1. NEVER REASSIGN A TextureNode's .value TO ANOTHER RENDER TARGET
//
// This is the single rule that shapes the material list, and it is why there are
// thirteen materials rather than six.
//
// NodeSampledTexture.update() returns true when the object changes, but the bind
// group is only rebuilt when `binding.generation !== textureData.generation`
// (three.webgpu.js:33006), and `textureData.generation = texture.version`
// (:34276) is 0 for every render-target texture that has never been marked
// needsUpdate. So swapping one render target for another leaves generation
// equal, the bind group is NOT rebuilt, and WebGPU keeps reading whichever
// texture was bound first. WebGL2 re-resolves the sampler per draw and is
// unaffected: the "compiles on both, wrong on one" class again, and the one it
// is wrong on is the backend this port is for. Measured in
// prototypes/tsl-pingpong-probe.html, which builds two materials for exactly
// this reason.
//
// So: ONE MATERIAL PER (stage, source binding).
//
//   matSpectrum(noise) | matEvolve(h0) | matFft[v][srcIsPing] (4)
//   | matAssemble(ping0, ping1) | matFoam[srcIsFoam0] (2)
//   | matPublish[srcIsFoam0] (2) | matPrime1 | matPrime2      = 13
//   (+ one readout material per readable source, built lazily by readLayer)
//
// Bumping texture.version to force a rebuild is NOT a workaround: for a
// render-target texture, updateTexture then destroys and recreates the GPU
// texture (three.webgpu.js:34182), discarding its contents.
//
// The corollary is note 3: the water cannot be handed the alternating foam
// buffer either.
//
// ---------------------------------------------------------------------------
// 2. THE MIP PROTOCOL FOR disp AND slope IS A FIDELITY DECISION, NOT AN
//    ENGINEERING ONE
//
// src/ocean.js:391-395 regenerates the disp and slope chains AFTER the foam
// loop, so the foam pass reads every level above 0 from the PREVIOUS FRAME, and
// on the first frame after a rebuild from a never-populated (zero) chain. That
// staleness is not an accident this port may quietly improve: it is what the
// foam has been tuned against (docs/ocean-sim-port-notes.md §1.3 rules on
// exactly this case). Reproducing it takes three things:
//
//   a) assembleRT is created with generateMipmaps TRUE, because three sizes the
//      chain's storage from needsMipmaps() AT TEXTURE CREATION (:34261-34262) -
//      a target created with the flag false can never be mipped afterwards.
//   b) the constructor then PRIMES it: one zero-filling draw per layer, which
//      three follows with an automatic regeneration (finishRender, :71644 on
//      WebGL and :85005 on WebGPU, regenerate every colour attachment whose
//      texture has generateMipmaps === true). That leaves a zero chain.
//      generateMipmaps is then set FALSE on both attachments, forever.
//   c) update() therefore writes level 0 with no auto-generation, the foam loop
//      reads the stale chain, and only AFTER the foam loop and AFTER restoring
//      the previous render target does it call renderer.backend.generateMipmaps
//      on disp and slope - the exact analogue of ocean.js's
//      gl.generateMipmap(TEXTURE_2D_ARRAY), present on both backends
//      (:72477 WebGL, :85926 WebGPU) and regenerating every layer.
//
// The restore-first ordering matters: do not regenerate a texture that is still
// attached to the bound framebuffer.
//
// backend.generateMipmaps is not public API, so the constructor asserts it
// exists rather than silently skipping the chain. If a future three renames it,
// the one-line fallback is to leave generateMipmaps true on assembleRT and drop
// the two explicit calls - which gives the foam FRESH mips: probably a better
// sea, definitely a different one, and it belongs in its own commit.
//
// THE FOAM TARGETS ARE THE OTHER WAY ROUND and keep generateMipmaps TRUE
// forever: ocean.js:424-425 regenerates the foam chain at the end of EVERY step,
// spin-up steps included, because the scale-free threshold reads <x^2> off the
// 1x1 top mip of what the previous step wrote. Three's automatic regeneration
// fires once per LAYER pass instead of once per step - four times the work,
// identical final state, and no read happens in between, because a step reads
// the OTHER buffer. They are primed to zero at construction so the first foam
// step reads a defined chain (in GL that is texStorage3D's
// undefined-but-in-practice-zero contents).
//
// ---------------------------------------------------------------------------
// 3. THE PUBLISH PASS
//
// Ocean.foamTex alternates between foam[0] and foam[1] every step. Handing that
// alternation to the water's foamTexture node is exactly note 1's hazard, so on
// WebGPU the sea's foam would silently freeze on whichever buffer was bound
// first. One extra fullscreen pass per cascade after the foam loop copies the
// current foam layer into foamOutRT, whose texture is the same object forever,
// and `this.foamTex` is that. It runs once per FRAME, not once per spin-up step:
// the water never sees intermediate spin-up states. It is texel-exact - see
// foamPublishFragment's docblock.
//
// disp and slope need no publish pass; they are single targets with stable
// identities.
//
// ---------------------------------------------------------------------------
// 4. THE FFT PARITY IS WHY assemble CAN HARD-BIND ping
//
// 2 * stages is even, so an even number of swaps returns the result to pingRT -
// and the last pass wrote there. That is what lets matAssemble bind pingRT's two
// attachments once. Getting it wrong reads a half-transformed field, which looks
// like a plausible but wrong ocean rather than like an error.
//
// ---------------------------------------------------------------------------
// 5. WHAT THIS CLASS DELIBERATELY DOES NOT HAVE
//
// Ocean.measure() has NO counterpart here. It reads specific mip levels through
// gl.framebufferTextureLayer, and the three renderer exposes no route to a
// non-zero mip level of an array layer as a readable attachment.
// prototypes/ocean-tsl.html's fingerprint replaces it. readLayer() below is the
// verification hook that does exist, and it reads level 0 only.
//
// ---------------------------------------------------------------------------
// 6. WEBGPU FEATURE DEPENDENCY
//
// disp is FloatType and is read FILTERED - by the foam pass's foldAt and by the
// water's vertex stage. WGSLNodeBuilder.isUnfilterable (three.webgpu.js:79070)
// fires for FloatType when 'float32-filterable' is absent, which would silently
// turn every disp fetch into a textureLoad: no bilinear, no mips, no error.
// Three requests every adapter-supported feature at device creation, so this is
// present on essentially all desktop adapters, and the existing TSL water path
// already depends on it (water-driver.js uploads FloatType cascade fields with
// LinearMipmapLinearFilter). The constructor checks and warns rather than
// silently downgrading; `sim.float32Filterable` records the answer.

import * as THREE from 'three/webgpu';
import { texture, vec4, outputStruct } from 'three/tsl';

import {
	initSpectrumFragment, timeEvolveFragment, fftFragment, assembleFragment,
	foamFragment, foamPublishFragment,
	setSimGrid, setSpectrumUniforms, setEvolveUniforms, setFftUniforms,
	setAssembleUniforms, setFoamUniforms, setPublishUniforms,
} from './ocean-sim.js';

// Re-deriving ANY of these is how the first WGSL attempt got five things wrong at
// once (src/gpu/ocean-compute.js:18-23): the butterfly table transposed and its
// twiddle sign flipped, the noise reseeded per cascade instead of drawn as one
// stream, and all three band formulas different. There is exactly one
// implementation of each and it lives in src/ocean.js.
import {
	DEFAULT_CASCADES, FOAM_WEIGHTS,
	butterflyData, cascadeNoise, bandLimitsOf, kCharOf, choppinessOf,
	whitecapFraction, breakLodsOf, breakWeightsOf, foamCutoffOf,
} from '../../ocean.js';

/**
 * The gaussian field h0 is seeded from, as ONE array texture indexed by uLayer.
 *
 * src/ocean.js:221-234 splits cascadeNoise's output into C separate 2D textures;
 * cascadeNoise's layout is already layer-major ((c*N*N + i)*4), which is exactly
 * DataArrayTexture's, so this is the same bytes with one binding instead of four.
 * A port that reads layer 0 for every cascade gets four perfectly correlated
 * cascades (docs/ocean-sim-port-notes.md §2).
 *
 * NearestFilter on both filters is not a preference: on WGSL it is what makes
 * the spectrum's fetch a textureLoad, i.e. an exact texel, which is what
 * texelFetch was (porting rule 11).
 */
export function noiseArrayTexture( N, C, seed ) {

	const t = new THREE.DataArrayTexture( cascadeNoise( N, C, seed ), N, N, C );
	t.name = 'abyssal.oceanNoise';
	t.format = THREE.RGBAFormat;
	t.type = THREE.FloatType;
	t.minFilter = THREE.NearestFilter;
	t.magFilter = THREE.NearestFilter;
	t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
	t.generateMipmaps = false;
	// DataArrayTexture defaults flipY to false and is not a render target, so
	// TextureNode's flip never fires for it: data row r is index row r, exactly as
	// in the GL path (./ocean-sim.js note 2c). Set explicitly so a future default
	// change is a visible edit here.
	t.flipY = false;
	t.needsUpdate = true;
	return t;

}

/**
 * The butterfly table: `stages` WIDE and N TALL, written by butterflyData at
 * (y * stages + s) * 4. One table serves every cascade, so it has no layer and
 * is a plain 2D texture. src/ocean.js:210-216.
 *
 * Upload butterflyData(N).data UNCHANGED: the wing sign lives in the twiddle and
 * stage 0's .z/.w carry the bit-reversal permutation.
 */
export function butterflyTexture( N ) {

	const bf = butterflyData( N );
	const t = new THREE.DataTexture( bf.data, bf.stages, N, THREE.RGBAFormat, THREE.FloatType );
	t.name = 'abyssal.oceanButterfly';
	t.minFilter = THREE.NearestFilter;
	t.magFilter = THREE.NearestFilter;
	t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
	t.generateMipmaps = false;
	t.flipY = false;
	t.needsUpdate = true;
	return t;

}

// Does the backend actually filter FloatType textures? Note 6. The two backends
// spell the same capability differently: WGSLNodeBuilder.isAvailable maps
// 'float32Filterable' to the 'float32-filterable' device feature on WebGPU
// (three.webgpu.js:80715) and to the OES_texture_float_linear extension on
// WebGL2 (:65667), and renderer.hasFeature() only knows the WebGPU spelling.
function hasFloatFiltering( renderer ) {

	const backend = renderer.backend;
	if ( backend?.isWebGPUBackend ) return renderer.hasFeature( 'float32-filterable' ) === true;
	return backend?.extensions?.has?.( 'OES_texture_float_linear' ) === true;

}

export class TslOceanSim {

	/**
	 * @param {THREE.WebGPURenderer} renderer - already init()ed. The constructor
	 *   draws: it primes the mip chains (note 2), so it needs a live backend.
	 * @param {object} [opts]
	 * @param {number} [opts.size=256] - field resolution N. Power of two.
	 * @param {number[]} [opts.cascades=DEFAULT_CASCADES] - patch sizes in metres.
	 */
	constructor( renderer, { size = 256, cascades = DEFAULT_CASCADES } = {} ) {

		this.renderer = renderer;
		this.N = size;
		this.L = cascades.slice();
		this.C = this.L.length;

		// The Ocean-compatible mutable state, same names and same initial values
		// as src/ocean.js's constructor.
		this.time = 0;
		this.dirty = true;
		this.seed = 1337;
		this.spinUp = 0;
		this.whitecap = 0;
		this.foamIdx = 0;

		// Note 2: fail loudly rather than quietly ship a sea whose foam threshold
		// has no normaliser.
		if ( typeof renderer.backend?.generateMipmaps !== 'function' ) {

			throw new Error(
				'TslOceanSim: renderer.backend.generateMipmaps is not a function. The ' +
				'disp/slope mip chains are regenerated explicitly after the foam loop to ' +
				'reproduce src/ocean.js\'s one-frame-stale mips, and there is no other ' +
				'route to that. See note 2 in src/gpu/tsl/sim-driver.js.',
			);

		}

		this.float32Filterable = hasFloatFiltering( renderer );
		if ( ! this.float32Filterable ) {

			console.warn(
				'TslOceanSim: this backend cannot filter FloatType textures ' +
				'(float32-filterable / OES_texture_float_linear). Every displacement fetch ' +
				'degrades to an unfiltered texel load - no bilinear and no mips - which ' +
				'shows up as a blocky sea and a foam field with no breaker-scale footprint, ' +
				'not as an error. See note 6 in src/gpu/tsl/sim-driver.js.',
			);

		}

		this.butterflyTex = butterflyTexture( this.N );
		// One source for the stage count: the table's own width.
		this.stages = this.butterflyTex.image.width;
		// floor(log2(N)) IS the last level of a chain of floor(log2(N))+1 levels,
		// so this is the value the GLSL's literal 32.0 clamped to on GL.
		this.topLod = Math.floor( Math.log2( this.N ) );

		this.noiseTex = noiseArrayTexture( this.N, this.C, this.seed );

		this._buildTargets();
		setSimGrid( { N: this.N, stages: this.stages, topLod: this.topLod } );
		this._buildMaterials();

		// One QuadMesh reused across every pass, with the material swapped before
		// each render - three's documented usage. No vertexNode: porting rule 14 is
		// about passes that must sit BEHIND geometry, and these render into their
		// own offscreen targets where QuadMesh's own ortho camera is exactly right.
		this.quad = new THREE.QuadMesh( this.matPrime1 );

		this._prime();

	}

	// ---- the Ocean-compatible surface ---------------------------------------

	get cascadeCount() { return this.C; }

	get patchSizes() { return new Float32Array( this.L ); }

	// Note 3: STABLE object. Never foamRT[this.foamIdx].texture.
	get foamTex() { return this.foamOutRT.textures[ 0 ]; }

	bandLimits( c ) { return bandLimitsOf( this.L, this.C, c ); }

	choppinessFor( c, p ) { return choppinessOf( this.C, c, p ); }

	kChar( c ) { return kCharOf( this.L, this.C, this.N, c ); }

	breakLods( scale ) { return breakLodsOf( this.L, this.C, this.N, scale ); }

	breakWeights( scale ) { return breakWeightsOf( this.L, this.C, this.N, scale ); }

	/**
	 * src/ocean.js:245-250. Mutates the noise IN PLACE and marks it for re-upload;
	 * it must never be replaced with a fresh DataArrayTexture, because the
	 * TextureNode built from it is baked into the spectrum material's bind group
	 * (note 1).
	 */
	setSeed( seed ) {

		if ( seed === this.seed ) return;
		this.seed = seed;
		this.noiseTex.image.data.set( cascadeNoise( this.N, this.C, seed ) );
		this.noiseTex.needsUpdate = true;
		this.dirty = true;

	}

	// ---- targets -------------------------------------------------------------

	// src/ocean.js:169-219, as three RenderTargets.
	//
	// `depth: C` is what makes each attachment an ARRAY texture (three.core.js
	// sets isArrayTexture when image.depth > 1), which is what makes the sampler
	// come out sampler2DArray on GLSL and texture_2d_array<f32> on WGSL, and what
	// lets the water read it with .depth(int(c)) unchanged. A layer is selected
	// for WRITING with renderer.setRenderTarget(rt, layer): _activeCubeFace
	// doubles as the array layer on both backends (three.webgpu.js:73330/:73333,
	// gl.framebufferTextureLayer; :84273/:84341 baseArrayLayer), and the render-pass
	// descriptor cache key includes activeCubeFace (:33862) so per-layer
	// descriptors do not collide.
	//
	// Multiple colour attachments live on ONE target - you cannot build an FBO
	// from two RenderTargets - which is why pingA/pingB share pingRT and disp and
	// slope share assembleRT, exactly as ocean.js:203-205 attaches two textures to
	// one FBO.
	_buildTargets() {

		const N = this.N, C = this.C;

		// The FFT working set. NEAREST + CLAMP + no mips == gl.js's
		// textureArray(RGBA32F, NEAREST, CLAMP) at ocean.js:171-177, and on WGSL
		// Nearest+Nearest is what turns every fetch into a textureLoad, i.e. the
		// exact texel texelFetch read (porting rule 11).
		const fftTarget = ( count ) => new THREE.RenderTarget( N, N, {
			count, depth: C,
			type: THREE.FloatType, format: THREE.RGBAFormat,
			minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
			wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
			generateMipmaps: false, anisotropy: 1, depthBuffer: false,
		} );

		this.h0RT = fftTarget( 1 );          // ocean.js:173
		this.pingRT = fftTarget( 2 );        // ocean.js:174-175, pingA/pingB
		this.pongRT = fftTarget( 2 );        // ocean.js:176-177, pongA/pongB
		this.h0RT.textures[ 0 ].name = 'abyssal.oceanH0';

		// ONE target, TWO HETEROGENEOUS attachments, exactly as ocean.js:205's FBO:
		// disp is RGBA32F because the vertex stage reads it and slope is RGBA16F.
		// Per-attachment format is legal on both backends (WebGL attaches each
		// texture independently; the WebGPU pipeline builds one colour target per
		// texture via getTextureFormatGPU, three.webgpu.js:74563-74567) and the
		// shipping GL path already mixes the two in one FBO.
		//
		// IF SOME WebGPU DRIVER EVER REJECTS THE MIX: make slope FloatType too. That
		// costs memory and bandwidth and changes no behaviour - it is what the
		// compute port did (docs/ocean-sim-port-notes.md §3.4).
		//
		// generateMipmaps TRUE HERE IS WHAT ALLOCATES THE CHAIN. It is switched off
		// in _prime() and never switched back on - note 2.
		this.assembleRT = new THREE.RenderTarget( N, N, {
			count: 2, depth: C,
			type: THREE.FloatType, format: THREE.RGBAFormat,
			minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
			wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping,
			generateMipmaps: true, anisotropy: 1, depthBuffer: false,
		} );

		this.disp = this.assembleRT.textures[ 0 ];
		this.slope = this.assembleRT.textures[ 1 ];
		this.disp.name = 'abyssal.oceanDisp';
		this.slope.name = 'abyssal.oceanSlope';
		// Before the first render, so no GPU texture has been created from the
		// FloatType the constructor gave both attachments.
		this.slope.type = THREE.HalfFloatType;
		// Anisotropy is not a quality knob when matching a reference: re-uploading
		// slope and foam without it left the distribution matching to 0.15% while
		// 27% of pixels were beyond 2%, because at grazing incidence an isotropic
		// mip fetch averages the wrong footprint (porting rule 12). ocean.js:188.
		this.slope.anisotropy = 8;

		// ocean.js:190-194. LINEAR AND REPEAT ARE NOT COSMETIC HERE, unlike on the
		// FFT pair: the foam pass samples its previous field at uv - duv and at four
		// diffusion taps that are NOT texel centres and DO leave [0,1]. The mip
		// chain is the scale-free threshold's normaliser and is regenerated by three
		// at the end of every layer pass - note 2.
		const foamTarget = ( aniso ) => new THREE.RenderTarget( N, N, {
			count: 1, depth: C,
			type: THREE.HalfFloatType, format: THREE.RGBAFormat,
			minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
			wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping,
			generateMipmaps: true, anisotropy: aniso, depthBuffer: false,
		} );

		// aniso 1 on the working pair: every read of them in the foam pass is an
		// explicit-LOD fetch, which anisotropy does not touch.
		this.foamRT = [ foamTarget( 1 ), foamTarget( 1 ) ];
		// aniso 8 on the published field, because the water's sampleCascadeSurface
		// takes an IMPLICIT-LOD fetch of it - porting rule 12 again.
		this.foamOutRT = foamTarget( 8 );
		this.foamOutRT.textures[ 0 ].name = 'abyssal.oceanFoam';

		// readLayer's destination, allocated on first use.
		this.readoutRT = null;
		this._readoutMats = new Map();

	}

	// ---- materials -----------------------------------------------------------

	_buildMaterials() {

		const mk = ( name, node ) => {

			const m = new THREE.NodeMaterial();
			m.name = 'abyssal.oceanSim.' + name;
			m.fragmentNode = node;
			m.depthTest = false;
			m.depthWrite = false;
			m.transparent = false;
			return m;

		};

		// Every material is built from the REAL target's texture, which is what
		// satisfies porting rule 11 by construction: there is no placeholder that
		// could bake the wrong textureLoad-vs-textureSampleLevel choice into a
		// shader (./ocean-sim.js note 7).
		this.matSpectrum = mk( 'spectrum', initSpectrumFragment( texture( this.noiseTex ) ) );
		this.matEvolve = mk( 'evolve', timeEvolveFragment( texture( this.h0RT.textures[ 0 ] ) ) );

		const bf = texture( this.butterflyTex );
		// matFft[vertical][0] reads pingRT, [1] reads pongRT. Four materials, and
		// the source half of the product is forced by note 1.
		this.matFft = [ false, true ].map( ( vertical ) => [ this.pingRT, this.pongRT ].map(
			( rt, i ) => mk(
				`fft.${ vertical ? 'v' : 'h' }.${ i === 0 ? 'ping' : 'pong' }`,
				fftFragment( bf, texture( rt.textures[ 0 ] ), texture( rt.textures[ 1 ] ), vertical ),
			),
		) );

		// Hard-bound to ping. Note 4: 2 * stages is even, so the transform always
		// lands there.
		this.matAssemble = mk( 'assemble', assembleFragment(
			texture( this.pingRT.textures[ 0 ] ), texture( this.pingRT.textures[ 1 ] ),
		) );

		const dispTex = texture( this.disp );
		const slopeTex = texture( this.slope );
		// matFoam[i] READS foamRT[i] and is drawn into foamRT[1-i].
		this.matFoam = this.foamRT.map( ( rt, i ) => mk(
			`foam.${ i }`, foamFragment( texture( rt.textures[ 0 ] ), dispTex, slopeTex ),
		) );
		this.matPublish = this.foamRT.map( ( rt, i ) => mk(
			`publish.${ i }`, foamPublishFragment( texture( rt.textures[ 0 ] ) ),
		) );

		// The two priming materials (note 2). matPrime2 must be an outputStruct and
		// not a single vec4, or NodeMaterial writes attachment 0 only and
		// assembleRT's slope chain is never allocated-and-zeroed.
		this.matPrime1 = mk( 'prime1', vec4( 0.0 ) );
		this.matPrime2 = mk( 'prime2', outputStruct( vec4( 0.0 ), vec4( 0.0 ) ) );

	}

	_allMaterials() {

		return [
			this.matSpectrum, this.matEvolve, ...this.matFft.flat(), this.matAssemble,
			...this.matFoam, ...this.matPublish, this.matPrime1, this.matPrime2,
			...this._readoutMats.values(),
		];

	}

	// ---- drawing -------------------------------------------------------------

	// One fullscreen pass into one layer of one target. Each of these is its own
	// renderer.render() and therefore its own submit, which is what makes changing
	// uniforms between draws safe: queue.writeBuffer and queue.submit are ordered
	// on the queue.
	_draw( target, layer, material ) {

		this.renderer.setRenderTarget( target, layer );
		this.quad.material = material;
		this.quad.render( this.renderer );

	}

	// autoClear defaults to TRUE and every renderer.render() would clear the bound
	// target first (porting rule 15). Every pass here overwrites every texel of
	// every attachment, so the clear is pure cost - but it is also global renderer
	// state, so it is saved and restored around anything that draws.
	//
	// The active cube face and mip level are saved with the target because
	// setRenderTarget writes all three (three.webgpu.js:61759) and the layer this
	// unit writes IS the cube-face slot - restoring the target without them would
	// leave the caller bound to layer 3 of its own target. This is the same triple
	// RendererUtils.resetRendererState saves (:44237-44238).
	_begin() {

		return {
			target: this.renderer.getRenderTarget(),
			cubeFace: this.renderer.getActiveCubeFace(),
			mipLevel: this.renderer.getActiveMipmapLevel(),
			autoClear: this.renderer.autoClear,
		};

	}

	_end( saved ) {

		this.renderer.setRenderTarget( saved.target, saved.cubeFace, saved.mipLevel );
		this.renderer.autoClear = saved.autoClear;

	}

	// Zero level 0 of assembleRT and of all three foam targets, and let three
	// generate the zero chains, then switch disp/slope off mipping forever.
	// Note 2 (b).
	_prime() {

		const saved = this._begin();

		try {

			this.renderer.autoClear = false;

			for ( let c = 0; c < this.C; c ++ ) {

				this._draw( this.assembleRT, c, this.matPrime2 );
				this._draw( this.foamRT[ 0 ], c, this.matPrime1 );
				this._draw( this.foamRT[ 1 ], c, this.matPrime1 );
				this._draw( this.foamOutRT, c, this.matPrime1 );

			}

			// From here on, assemble writes level 0 and nothing else; update() rebuilds
			// the chain explicitly, AFTER the foam loop.
			this.disp.generateMipmaps = false;
			this.slope.generateMipmaps = false;

		} finally {

			this._end( saved );

		}

	}

	// ---- the frame -----------------------------------------------------------

	/**
	 * src/ocean.js:297-322. Four draws into h0RT, one per cascade.
	 *
	 * @param {object} p - the parameter set. derive(p, d) must have run.
	 */
	buildSpectrum( p ) {

		const saved = this._begin();

		// try/finally, not because a pass is expected to fail, but because
		// autoClear and the bound target are GLOBAL renderer state: the derive()
		// guard in setSpectrumUniforms throws on the very first iteration, and
		// leaking autoClear = false out of that would leave the caller's next frame
		// unclearing with nothing pointing back here.
		try {

			this.renderer.autoClear = false;

			for ( let c = 0; c < this.C; c ++ ) {

				const [ kLow, kHigh ] = this.bandLimits( c );
				setSpectrumUniforms( p, { L: this.L[ c ], kLow, kHigh, layer: c } );
				this._draw( this.h0RT, c, this.matSpectrum );

			}

		} finally {

			this._end( saved );

		}

		this.dirty = false;
		this.spinUp = 30;   // ~9 s of foam life, run on the next update

	}

	/**
	 * src/ocean.js:324-396, the whole frame.
	 *
	 * Must run BEFORE the water is drawn, and the water must be pointed at
	 * sim.disp / sim.slope / sim.foamTex - setWaterCommonUniforms(p, ctx, sim,
	 * wake) does that automatically from the Ocean-compatible surface above, and
	 * re-binding the same objects every frame is a no-op.
	 *
	 * @param {number} dt - seconds of wall time.
	 * @param {object} p - the parameter set.
	 */
	update( dt, p ) {

		const saved = this._begin();

		try {

			this.renderer.autoClear = false;

			if ( this.dirty ) this.buildSpectrum( p );
			this.time += dt * p.timeScale;

			for ( let c = 0; c < this.C; c ++ ) {

				// 1. evolve h(k, t) into the ping buffers
				setEvolveUniforms( p, {
					L: this.L[ c ], time: this.time, choppy: this.choppinessFor( c, p ), layer: c,
				} );
				this._draw( this.pingRT, c, this.matEvolve );

				// 2. 2 * log2(N) butterfly passes, horizontal then vertical
				let readIsPing = true;
				for ( let v = 0; v < 2; v ++ ) {

					for ( let s = 0; s < this.stages; s ++ ) {

						setFftUniforms( { stage: s, layer: c } );
						this._draw(
							readIsPing ? this.pongRT : this.pingRT, c,
							this.matFft[ v ][ readIsPing ? 0 : 1 ],
						);
						readIsPing = ! readIsPing;

					}

				}

				// 3. assemble displacement + slope + Jacobian. Reads ping - note 4.
				setAssembleUniforms( p, { kChar: this.kChar( c ), layer: c } );
				this._draw( this.assembleRT, c, this.matAssemble );

			}

			// 4. temporal foam. SEPARATE loop from the cascade loop because every
			// cascade's breaking test reads displacement mips that must all be current
			// (ocean.js:373-377).
			//
			// The raft left by a breaker lives several seconds, so after a change of sea
			// state the field needs that long to reach its equilibrium coverage. Rather
			// than show a foamless ocean for the first seconds (or, on a slow frame
			// budget, the first half minute) the spin-up runs the same integrator over a
			// frozen wave field until the raft has filled in.
			//
			// Foam ages in wave time, not wall time: the decay rates are tied to the
			// life of a breaker, so a slowed or hurried sea has to carry its foam with
			// it or the whitecaps outlive the waves that made them.
			const foamDt = Math.min( dt * p.timeScale, 0.1 );
			const steps = this.spinUp > 0 ? this.spinUp : 0;
			this.spinUp = 0;
			for ( let s = 0; s <= steps; s ++ ) this._foamStep( s < steps ? 0.3 : foamDt, p );

			// 5. publish the current foam buffer into the field the water reads - note 3.
			for ( let c = 0; c < this.C; c ++ ) {

				setPublishUniforms( { layer: c } );
				this._draw( this.foamOutRT, c, this.matPublish[ this.foamIdx ] );

			}

		} finally {

			// 6. Unbind BEFORE regenerating: do not mip a texture that is still
			// attached to the bound framebuffer. ocean.js:391-395 does the same in the
			// same order. In the finally so a failed frame cannot leave autoClear off
			// or the sim's last layer bound - the two regenerations below are outside
			// it, because a frame that threw has nothing worth mipping.
			this._end( saved );

		}

		this.renderer.backend.generateMipmaps( this.disp );
		this.renderer.backend.generateMipmaps( this.slope );

	}

	// src/ocean.js:398-426. One foam integration step over every cascade.
	//
	// The foam chain is regenerated by three at the end of each layer pass, because
	// the foam targets keep generateMipmaps true - note 2.
	_foamStep( dtStep, p ) {

		const next = 1 - this.foamIdx;

		// Once per STEP, outside the cascade loop, exactly as ocean.js:404-405.
		this.whitecap = whitecapFraction( p.windSpeed, p.foamCoverage, p.foamWindMin );
		const cutoff = foamCutoffOf( this.whitecap );
		const patch = this.patchSizes;
		const lods = breakLodsOf( this.L, this.C, this.N, p.foamBreakScale );

		for ( let c = 0; c < this.C; c ++ ) {

			setFoamUniforms( p, {
				L: this.L[ c ], patch: patch[ c ], compLod: lods[ c ],
				weight: FOAM_WEIGHTS[ c ], layer: c, dt: dtStep, cutoff,
			} );
			this._draw( this.foamRT[ next ], c, this.matFoam[ this.foamIdx ] );

		}

		this.foamIdx = next;

	}

	// ---- verification --------------------------------------------------------

	/**
	 * Read one layer of one field back, in SIM INDEX ORDER (row 0 = index row 0),
	 * directly comparable to the GL path's gl.readPixels of fbo.assemble[c].
	 *
	 * VERIFICATION ONLY - it stalls the pipeline and allocates a target on first
	 * use. It exists because readRenderTargetPixelsAsync CANNOT read a layer of an
	 * array target on the WebGL backend: WebGLTextureUtils.copyTextureToBuffer
	 * attaches with framebufferTexture2D(..., gl.TEXTURE_2D, ...) and ignores
	 * faceIndex except for cube maps (three.webgpu.js:70144), so a
	 * TEXTURE_2D_ARRAY gives an incomplete framebuffer. WebGPU handles it. So this
	 * goes through a readout pass onto a plain 2D FloatType target first.
	 *
	 * Two row flips are involved and they are the only ones in this unit done by
	 * hand: readPixelsBottomUp normalises the backends to each other, after which
	 * buffer row j is INDEX ROW N-1-j on both, and the loop below reverses that.
	 *
	 * @param {'disp'|'slope'|'foam'} which
	 * @param {number} layer
	 * @returns {Promise<Float32Array>} RGBA, N*N*4, row 0 = index row 0.
	 */
	async readLayer( which, layer ) {

		const src = which === 'disp' ? this.disp
			: which === 'slope' ? this.slope
				: which === 'foam' ? this.foamTex : null;

		if ( src === null ) {

			throw new Error( `TslOceanSim.readLayer: unknown field "${ which }" (disp|slope|foam)` );

		}

		if ( this.readoutRT === null ) {

			this.readoutRT = new THREE.RenderTarget( this.N, this.N, {
				count: 1, depth: 1,
				type: THREE.FloatType, format: THREE.RGBAFormat,
				minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
				wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
				generateMipmaps: false, depthBuffer: false,
			} );

		}

		// One material per readable source texture - note 1 applies here too.
		let mat = this._readoutMats.get( src );
		if ( mat === undefined ) {

			mat = new THREE.NodeMaterial();
			mat.name = 'abyssal.oceanSim.readout.' + which;
			mat.fragmentNode = foamPublishFragment( texture( src ) );
			mat.depthTest = false;
			mat.depthWrite = false;
			mat.transparent = false;
			this._readoutMats.set( src, mat );

		}

		const saved = this._begin();

		try {

			this.renderer.autoClear = false;
			setPublishUniforms( { layer } );
			this._draw( this.readoutRT, 0, mat );

		} finally {

			this._end( saved );

		}

		// Imported dynamically and deliberately: prototypes/readback.js is a probe
		// helper (it also enforces WebGPU's 256-byte row-pitch rule, porting rule
		// 10), and src/ must not carry a static dependency on prototypes/ for a
		// method the shipping path never calls.
		const { readPixelsBottomUp } = await import( '../../../prototypes/readback.js' );
		const px = await readPixelsBottomUp( this.renderer, this.readoutRT, this.N, this.N );

		const out = new Float32Array( px.length );
		const stride = this.N * 4;
		for ( let y = 0; y < this.N; y ++ ) {

			out.set( px.subarray( ( this.N - 1 - y ) * stride, ( this.N - y ) * stride ), y * stride );

		}

		return out;

	}

	dispose() {

		for ( const rt of [
			this.h0RT, this.pingRT, this.pongRT, this.assembleRT,
			this.foamRT[ 0 ], this.foamRT[ 1 ], this.foamOutRT, this.readoutRT,
		] ) rt?.dispose();

		for ( const m of this._allMaterials() ) m.dispose();

		this.noiseTex.dispose();
		this.butterflyTex.dispose();

	}

}
