// The TSL post chain, driven. The node-graph counterpart of src/post.js: it owns
// every render target the chain needs, the ten materials, and the draw order -
// and exposes the same resize / accumulate / render shape, so a caller can hold
// either one behind the same interface.
//
// Runs on WebGPU and on WebGL2 from this one source. Three compiles the graphs in
// ./post.js to WGSL or to GLSL depending on the backend the renderer initialised
// with. See docs/tsl-porting-rules.md.
//
// ---------------------------------------------------------------------------
// 1. renderer.outputColorSpace MUST BE LinearSRGBColorSpace, OR THE FRAME GETS
//    GAMMA APPLIED TWICE
//
//    This constructor sets it, and that is a side effect on a renderer the sky
//    and the water share. It is deliberate and it is not optional.
//
//    Renderer.needsFrameBufferTarget (three r185, three.webgpu.js:61627-61634) is
//
//        currentToneMapping !== NoToneMapping
//     || currentColorSpace !== ColorManagement.workingColorSpace
//
//    and currentColorSpace (61693-61697) returns renderer.outputColorSpace
//    whenever `isOutputTarget` - i.e. whenever the bound target is the canvas or
//    the renderer's own output target (61704-61708). WebGPURenderer defaults
//    outputColorSpace to SRGBColorSpace (59365), and workingColorSpace is
//    'srgb-linear'. So out of the box three would allocate an intermediate
//    framebuffer and run an OUTPUT PASS (_renderOutput, 60994) applying the sRGB
//    OETF on top of the composite's own pow(1/2.2). That is a washed-out image,
//    not an error, and it looks exactly like a grading mistake.
//
//    Two facts that make the rest of the chain safe:
//      - when the bound target is one of ours, isOutputTarget is false and
//        currentColorSpace is forced to the working space, so no intermediate
//        target is inserted for the eight passes that draw into render targets;
//      - getPreferredCanvasFormat (74651) returns
//        navigator.gpu.getPreferredCanvasFormat(), i.e. bgra8unorm and NOT the
//        -srgb variant, so writing display-encoded bytes straight at the canvas
//        is correct and matches what gl.bindFramebuffer(FRAMEBUFFER, null) does
//        on the WebGL2 path.
//
//    toneMapping is set to NoToneMapping for the same reason: this module tone
//    maps, and it does it in the composite where the GLSL does.
//
// ---------------------------------------------------------------------------
// 2. EVERY MATERIAL SETS fragmentNode, AND NONE SETS vertexNode
//
//    fragmentNode is what keeps three's own output transform out of the shader:
//    NodeMaterial.setup (21294-21372) consults builder.context.getOutput only on
//    the fragmentNode === null branch.
//
//    NO vertexNode, on any of the ten. Porting rule 14 is about a fullscreen pass
//    that has to sit BEHIND geometry - the sky, drawn after the sea, which needs
//    the far-plane trick to be depth-tested against it. Every pass here owns its
//    whole destination, has depth testing off, and has nothing to be behind.
//    Adding `vec4(positionGeometry.xy, 1, 1)` here by reflex would be harmless
//    today and misleading forever, so it is called out rather than left implicit.
//
// ---------------------------------------------------------------------------
// 3. THE LUM TARGET IS THE ONE WITH generateMipmaps: true, AND THAT IS THE WHOLE
//    METERING REDUCTION
//
//    ADAPT reads textureLod(uLum, vec2(0.5), 8.0) out of a 256x256 target, i.e.
//    the 1x1 top of its mip chain - the weighted sums of the whole frame. The
//    GLSL path calls gl.generateMipmap after the LUM draw (src/post.js:144-145).
//    There is no equivalent call in the three API and none is needed: both
//    backends regenerate a render target's mips in finishRender when
//    texture.generateMipmaps === true (WebGL backend 71641-71650, WebGPU backend
//    84995-85009).
//
//    KNOWN FIDELITY RISK, RECORDED RATHER THAN "FIXED": WebGL's generateMipmap
//    and WebGPU's shader-based reduction are both 2x2 boxes but are not
//    guaranteed bit-identical on RGBA16F, and test/golden/post.json records the
//    adapt sequence to six figures. Compare adaptSeq with a RELATIVE tolerance.
//    Do NOT replace the mip reduction with an explicit pyramid - that changes the
//    values the reference was captured with, which is the opposite of a fix.
//
// ---------------------------------------------------------------------------
// 4. renderer.autoClear IS FORCED OFF FOR THE WHOLE CHAIN (porting rule 15)
//
//    Inside the chain this is discipline rather than a correctness requirement:
//    every pass covers its entire destination and no pass reads its own
//    destination (UP, ACCUM and ADAPT all ping-pong onto a different target).
//
//    It IS load-bearing for the CALLER. The scene HDR texture handed to render()
//    is read again at step 3 (prefilter) and step 6 (composite), long after other
//    targets have been bound; and in photo mode the history target the caller got
//    back from accumulate() has to survive to the end. With autoClear left at its
//    default, every QuadMesh.render() would clear whatever is bound first, and
//    the caller's own frame would be gone.
//
// ---------------------------------------------------------------------------
// 5. UPDATING uTexel BETWEEN DRAWS THAT SHARE A MATERIAL IS SAFE
//
//    Worth recording because it is the one thing that would quietly make all five
//    DOWN draws use the last texel size. Renderer._renderScene calls
//    backend.finishRender() per render, and on WebGPU that ends with
//    submit(device, encoder.finish()) (84991); uniform values reach the GPU
//    through device.queue.writeBuffer (81165 ff.), which is ordered against
//    submits on the same queue. So draw N sees the value written before draw N,
//    not the value written before draw N+1.
//
// ---------------------------------------------------------------------------
// 6. srcTexture IS ONE NODE SHARED BY ACCUM, PREFILTER, LUM AND COMPOSITE
//
//    That mirrors the GLSL, where all four programs declare `uniform sampler2D
//    uSrc`. It is safe because accumulate() and render() each set it at entry and
//    run to completion; photo mode calls accumulate() first and passes its result
//    into render() (demo/main.js:543 then :582), so the two never interleave.
//
//    THE TEXTURE HANDED TO render() AND accumulate() MUST BE A RENDER TARGET'S.
//    ./post.js's srcUV() assumes the sampler flip that TextureNode.update turns on
//    for `texture.isRenderTargetTexture === true` (13255-13261). A plain
//    DataTexture passed in as `src` would skip that flip on WebGL2 and sample the
//    frame upside down there while looking right on WebGPU - the worst possible
//    shape of bug. There is nothing to assert against cheaply, so it is stated
//    here instead.
//
// ---------------------------------------------------------------------------
// 7. THE ADAPT TARGETS ARE SEEDED BY A DRAW, NOT BY DATA OR BY A CLEAR
//
//    src/post.js:34-37 creates them WITH [0.18, log2(0.18), log2(0.18), 1]. A
//    RenderTarget cannot be initialised with data, and setClearColor takes a
//    THREE.Color, which is colour-managed and cannot carry log2(0.18) = -2.4739.
//    So a one-pixel constant quad is the only exact route. That value is why
//    ADAPT_FS:160's `if (prev.r <= 0.0)` never fires, why the metering pass reads
//    log2(0.18) as the frame-1 key, and why the golden adaptSeq starts at
//    0.179579 instead of at a transient.
//
//    The history targets are cleared to zero at allocation for a related reason:
//    ACCUM computes mix(h, c, uBlend) = h*(1-a) + c*a, and h*0 does not kill a
//    NaN, so sample 1 of a photo-mode accumulation would inherit whatever was in
//    that memory.

import * as THREE from 'three/webgpu';

import {
	MIPS, LUM_SIZE,
	srcTexture, downSrcTexture, upSrcTexture, upPrevTexture,
	bloomTexture, glareTexture, historyTexture, lumTexture, ldrTexture,
	adaptTexture, adaptPrevTexture,
	uPrefilterTexel, uDownTexel, uUpTexel, uFxaaTexel, uRes, uBlend, uAmount,
	prefilterFragment, downFragment, upFragment, lumFragment, adaptFragment,
	accumFragment, compositeFragment, fxaaFragment,
	adaptSeedFragment, adaptReadFragment,
	setPostUniforms,
} from './post.js';

// src/post.js:54. Integer halving with a floor of 1, so the pyramid keeps
// descending past a 1-pixel edge instead of collapsing to 0.
const half = ( x ) => Math.max( 1, x >> 1 );

// Every post FBO in src/gl.js:163 is colour-only.
const NO_DEPTH = { depthBuffer: false, stencilBuffer: false };

function hdrTarget( w, h ) {

	const rt = new THREE.RenderTarget( w, h, {
		type: THREE.HalfFloatType,
		format: THREE.RGBAFormat,
		minFilter: THREE.LinearFilter,
		magFilter: THREE.LinearFilter,
		wrapS: THREE.ClampToEdgeWrapping,
		wrapT: THREE.ClampToEdgeWrapping,
		generateMipmaps: false,
		...NO_DEPTH,
	} );
	return rt;

}

export class TslPost {

	/**
	 * @param {THREE.WebGPURenderer} renderer - already init()ed. The adapt targets
	 *   are seeded here with a draw, so the backend has to exist.
	 */
	constructor( renderer ) {

		this.renderer = renderer;

		// See note 1. This module owns the OETF and the tone curve; three must not
		// add a second helping of either on the way to the canvas.
		renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
		renderer.toneMapping = THREE.NoToneMapping;

		this.size = [ 0, 0 ];

		// r = linear effective key (what resolveExposure divides by), g = its log2,
		// b = the log2 robust key the metering pass needs fed back to it. RGBA32F
		// because g and b are negative for anything darker than middle grey, and
		// NEAREST because a 1x1 has nothing to filter (src/post.js:34-37).
		this.adapt = [ 0, 1 ].map( () => new THREE.RenderTarget( 1, 1, {
			type: THREE.FloatType,
			format: THREE.RGBAFormat,
			minFilter: THREE.NearestFilter,
			magFilter: THREE.NearestFilter,
			wrapS: THREE.ClampToEdgeWrapping,
			wrapT: THREE.ClampToEdgeWrapping,
			generateMipmaps: false,
			...NO_DEPTH,
		} ) );
		this.adapt[ 0 ].texture.name = 'abyssal.post.adapt0';
		this.adapt[ 1 ].texture.name = 'abyssal.post.adapt1';
		this.adaptIdx = 0;

		// Verification only. A 1x1 RGBA32F target has a 16-byte row, and WebGPU's
		// buffer copy needs a 256-byte pitch - readRenderTargetPixelsAsync does not
		// compensate and returns interleaved padding without erroring (porting rule
		// 10). 64 texels x 16 bytes = 1024 clears the bar, and height 1 makes the
		// row order moot.
		this.adaptStage = new THREE.RenderTarget( 64, 1, {
			type: THREE.FloatType,
			format: THREE.RGBAFormat,
			minFilter: THREE.NearestFilter,
			magFilter: THREE.NearestFilter,
			wrapS: THREE.ClampToEdgeWrapping,
			wrapT: THREE.ClampToEdgeWrapping,
			generateMipmaps: false,
			...NO_DEPTH,
		} );
		this.adaptStage.texture.name = 'abyssal.post.adaptStage';

		// Ten fullscreen passes. Every one sets fragmentNode and none sets
		// vertexNode - see note 2. depthTest/depthWrite off and NoBlending mirror
		// src/post.js:131-132's gl.disable(DEPTH_TEST) / gl.disable(BLEND); the
		// GLSL path sets them once for the whole chain, three carries them per
		// material.
		const mk = ( name, node ) => {

			const mat = new THREE.NodeMaterial();
			mat.name = `abyssal.post.${ name }`;
			mat.fragmentNode = node;
			mat.depthTest = false;
			mat.depthWrite = false;
			mat.transparent = false;
			mat.blending = THREE.NoBlending;
			return { mat, quad: new THREE.QuadMesh( mat ) };

		};

		this.passes = {
			prefilter: mk( 'prefilter', prefilterFragment() ),
			down: mk( 'down', downFragment() ),
			up: mk( 'up', upFragment() ),
			lum: mk( 'lum', lumFragment() ),
			adapt: mk( 'adapt', adaptFragment() ),
			accum: mk( 'accum', accumFragment() ),
			composite: mk( 'composite', compositeFragment() ),
			fxaa: mk( 'fxaa', fxaaFragment() ),
			adaptSeed: mk( 'adaptSeed', adaptSeedFragment() ),
			adaptRead: mk( 'adaptRead', adaptReadFragment() ),
		};

		this.seedAdapt();

	}

	/**
	 * Write ADAPT_SEED into BOTH adapt targets. Called from the constructor; also
	 * public, because a golden run that wants the recorded adapt sequence has to
	 * start from the seed rather than from wherever the last frame left the iris.
	 * See note 7.
	 */
	seedAdapt() {

		const r = this.renderer;
		const prev = r.getRenderTarget();
		const prevAuto = r.autoClear;
		r.autoClear = false;

		for ( let i = 0; i < 2; i ++ ) {

			r.setRenderTarget( this.adapt[ i ] );
			this.passes.adaptSeed.quad.render( r );

		}

		this.adaptIdx = 0;
		r.setRenderTarget( prev );
		r.autoClear = prevAuto;

	}

	/**
	 * Allocate the size-dependent targets. Mirrors Post.resize(w, h) and is a
	 * no-op when the size has not changed.
	 */
	resize( w, h ) {

		if ( this.size[ 0 ] === w && this.size[ 1 ] === h ) return;
		this.size = [ w, h ];

		this.chain?.forEach( ( t ) => t.dispose() );
		this.up?.forEach( ( t ) => t && t.dispose() );
		this.lum?.dispose();
		this.ldr?.dispose();
		this.history?.forEach( ( t ) => t.dispose() );

		this.chain = [];
		this.up = [];
		let cw = half( w ), ch = half( h );
		for ( let i = 0; i < MIPS; i ++ ) {

			this.chain.push( hdrTarget( cw, ch ) );
			this.chain[ i ].texture.name = `abyssal.post.chain${ i }`;
			// Separate upsample targets: reading and writing one texture in the same
			// pass is a feedback loop, so the additive chain needs its own buffers.
			// They are the SAME SIZE as chain[i], not half of it - UP reads a smaller
			// level and writes at this one's resolution.
			this.up.push( i < MIPS - 1 ? hdrTarget( cw, ch ) : null );
			if ( this.up[ i ] ) this.up[ i ].texture.name = `abyssal.post.up${ i }`;
			cw = half( cw ); ch = half( ch );

		}

		// Two (weighted log-luminance, weight) pairs -- the robust key and the
		// bright population -- so the mip pyramid reduces each to a weighted mean.
		// generateMipmaps TRUE is the reduction; see note 3.
		this.lum = new THREE.RenderTarget( LUM_SIZE, LUM_SIZE, {
			type: THREE.HalfFloatType,
			format: THREE.RGBAFormat,
			minFilter: THREE.LinearMipmapLinearFilter,
			magFilter: THREE.LinearFilter,
			wrapS: THREE.ClampToEdgeWrapping,
			wrapT: THREE.ClampToEdgeWrapping,
			generateMipmaps: true,
			...NO_DEPTH,
		} );
		this.lum.texture.name = 'abyssal.post.lum';

		// The composite's own output, 8-bit because that is where the dither and
		// the grain expect the quantisation to happen.
		//
		// colorSpace MUST be NoColorSpace. getFormat (77654 ff., the RGBAFormat +
		// UnsignedByteType case at 77841) picks rgba8unorm-srgb whenever the
		// texture's colour space has an sRGB transfer, which would encode a second
		// time over the composite's own pow(1/2.2). src/post.js:80-83 uses plain
		// gl.RGBA8. (NoColorSpace is also three's default for a render target
		// texture, so this line is documentation of a requirement rather than a
		// correction - do not "clean it up" by deleting it.)
		this.ldr = new THREE.RenderTarget( w, h, {
			type: THREE.UnsignedByteType,
			format: THREE.RGBAFormat,
			colorSpace: THREE.NoColorSpace,
			minFilter: THREE.LinearFilter,
			magFilter: THREE.LinearFilter,
			wrapS: THREE.ClampToEdgeWrapping,
			wrapT: THREE.ClampToEdgeWrapping,
			generateMipmaps: false,
			...NO_DEPTH,
		} );
		this.ldr.texture.name = 'abyssal.post.ldr';

		this.history = [ 0, 1 ].map( () => hdrTarget( w, h ) );
		this.history[ 0 ].texture.name = 'abyssal.post.history0';
		this.history[ 1 ].texture.name = 'abyssal.post.history1';
		this.histIdx = 0;

		// See note 7: h*(1-a) does not kill a NaN, so the history cannot be left as
		// whatever was in that memory.
		this._clearHistory();

	}

	_clearHistory() {

		const r = this.renderer;
		const prev = r.getRenderTarget();
		// Save and restore the caller's clear state - this is the renderer the sky
		// and the water draw with.
		const prevColor = new THREE.Color();
		r.getClearColor( prevColor );
		const prevAlpha = r.getClearAlpha();
		r.setClearColor( 0x000000, 0 );

		for ( let i = 0; i < 2; i ++ ) {

			r.setRenderTarget( this.history[ i ] );
			r.clear( true, false, false );

		}

		r.setClearColor( prevColor, prevAlpha );
		r.setRenderTarget( prev );

	}

	/**
	 * Temporal accumulation used by photo mode: n frames of jitter, no motion.
	 * Mirrors Post.accumulate(src, sampleIndex).
	 *
	 * @param {THREE.Texture} src - the scene HDR texture for this sample.
	 * @param {number} sampleIndex - 1-based.
	 * @returns {THREE.Texture} the accumulated result, to hand to render().
	 */
	accumulate( src, sampleIndex ) {

		const r = this.renderer;
		const prev = r.getRenderTarget();
		const prevAuto = r.autoClear;
		r.autoClear = false;

		const next = 1 - this.histIdx;
		srcTexture.value = src;
		historyTexture.value = this.history[ this.histIdx ].texture;
		uBlend.value = 1.0 / Math.max( sampleIndex, 1 );

		r.setRenderTarget( this.history[ next ] );
		this.passes.accum.quad.render( r );
		this.histIdx = next;

		r.setRenderTarget( prev );
		r.autoClear = prevAuto;
		return this.history[ this.histIdx ].texture;

	}

	/**
	 * Run the whole chain. Mirrors Post.render(src, p, dt, time, opts), including
	 * the order, which matters in two places (see the adapt swap at step 2 and the
	 * up-chain's source selection at step 5).
	 *
	 * @param {THREE.Texture} src - the scene HDR texture, or accumulate()'s output.
	 * @param {object} p - the params object.
	 * @param {number} dt - seconds since the last frame.
	 * @param {number} time - the SAME simulation clock the sky and water get.
	 * @param {object} [opts] - { photo, sample, lensWet, output }.
	 */
	render( src, p, dt, time, opts = {} ) {

		const r = this.renderer;
		const [ w, h ] = this.size;

		const prevTarget = r.getRenderTarget();
		const prevAuto = r.autoClear;
		r.autoClear = false;   // porting rule 15, note 4

		setPostUniforms( p, { time, dt, lensWet: opts.lensWet } );
		srcTexture.value = src;

		// --- 1. auto exposure -------------------------------------------------
		if ( p.autoExposure > 0 ) {

			// LUM and ADAPT read the OLD adapt; PREFILTER and COMPOSITE read the NEW
			// one, because src/post.js flips adaptIdx before building the exposure
			// uniforms. Two texture nodes, on purpose.
			adaptPrevTexture.value = this.adapt[ this.adaptIdx ].texture;

			r.setRenderTarget( this.lum );
			this.passes.lum.quad.render( r );
			// The mip chain is regenerated by the backend in finishRender because the
			// target has generateMipmaps set - there is no gl.generateMipmap to call
			// here. See note 3.
			lumTexture.value = this.lum.texture;

			const nx = 1 - this.adaptIdx;
			r.setRenderTarget( this.adapt[ nx ] );
			this.passes.adapt.quad.render( r );
			this.adaptIdx = nx;

		}

		// --- 2. the stop the prefilter and the composite must agree on ---------
		// AFTER the swap - src/post.js:171.
		adaptTexture.value = this.adapt[ this.adaptIdx ].texture;

		// --- 3. bloom prefilter into chain[0] ---------------------------------
		// uTexel is 1/w, 1/h of the FULL-RES source, not of the half-res target.
		uPrefilterTexel.value.set( 1 / w, 1 / h );
		r.setRenderTarget( this.chain[ 0 ] );
		this.passes.prefilter.quad.render( r );

		// --- 4. downsample --------------------------------------------------
		for ( let i = 1; i < MIPS; i ++ ) {

			const s = this.chain[ i - 1 ];
			downSrcTexture.value = s.texture;
			uDownTexel.value.set( 1 / s.width, 1 / s.height );
			r.setRenderTarget( this.chain[ i ] );
			this.passes.down.quad.render( r );

		}

		// --- 5. upsample and accumulate the octaves ----------------------------
		for ( let i = MIPS - 1; i > 0; i -- ) {

			// The first step reads the bottom of the DOWN chain; every later step
			// reads the up-target the previous step wrote.
			const small = i === MIPS - 1 ? this.chain[ i ] : this.up[ i ];
			upSrcTexture.value = small.texture;
			upPrevTexture.value = this.chain[ i - 1 ].texture;
			uUpTexel.value.set( 1 / small.width, 1 / small.height );
			r.setRenderTarget( this.up[ i - 1 ] );
			this.passes.up.quad.render( r );

		}

		// --- 6. composite ------------------------------------------------------
		// Which upsample level feeds the wide veiling-glare / halation tap. It
		// carries the sum of every octave from here down, i.e. the broad tail of
		// the point spread function only -- no ring hugging the highlight.
		const glareLevel = Math.max( 1, Math.min( MIPS - 2, Math.round( p.glareSpread ) ) );
		bloomTexture.value = this.up[ 0 ].texture;
		glareTexture.value = this.up[ glareLevel ].texture;
		uRes.value.set( w, h );
		r.setRenderTarget( this.ldr );
		this.passes.composite.quad.render( r );

		// --- 7. FXAA + grain, to the screen ------------------------------------
		// A converged photo-mode frame is already supersampled; running full FXAA
		// over it would only throw away the detail the accumulation just bought.
		// Early samples have not bought any yet, so hand over gradually.
		uAmount.value = opts.photo
			? p.fxaa * Math.max( 0.12, 1 - ( opts.sample || 0 ) / 12 )
			: p.fxaa;
		ldrTexture.value = this.ldr.texture;
		uFxaaTexel.value.set( 1 / w, 1 / h );
		r.setRenderTarget( opts.output ?? null );
		this.passes.fxaa.quad.render( r );

		r.setRenderTarget( prevTarget );
		r.autoClear = prevAuto;

	}

	/**
	 * Read the current adapt value back. Verification only - the golden run
	 * records adapt.r after each of sixteen frames.
	 *
	 * Staged through a 64x1 target because a 1x1 RGBA32F row is 16 bytes and
	 * WebGPU's copy needs a 256-byte pitch; see the adaptStage comment.
	 *
	 * @returns {Promise<Float32Array>} four floats: (key, log2 key, robust key, 1).
	 */
	async readAdapt() {

		const r = this.renderer;
		const prev = r.getRenderTarget();
		const prevAuto = r.autoClear;
		r.autoClear = false;

		adaptTexture.value = this.adapt[ this.adaptIdx ].texture;
		r.setRenderTarget( this.adaptStage );
		this.passes.adaptRead.quad.render( r );

		r.setRenderTarget( prev );
		r.autoClear = prevAuto;

		const raw = await r.readRenderTargetPixelsAsync( this.adaptStage, 0, 0, 64, 1 );
		const px = raw instanceof Float32Array ? raw : new Float32Array( raw.buffer ?? raw );
		return px.slice( 0, 4 );

	}

	dispose() {

		this.chain?.forEach( ( t ) => t.dispose() );
		this.up?.forEach( ( t ) => t && t.dispose() );
		this.lum?.dispose();
		this.ldr?.dispose();
		this.history?.forEach( ( t ) => t.dispose() );
		this.adapt.forEach( ( t ) => t.dispose() );
		this.adaptStage.dispose();
		for ( const k of Object.keys( this.passes ) ) this.passes[ k ].mat.dispose();

	}

}
