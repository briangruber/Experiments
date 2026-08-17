// The one-call entry point: Abyssal as a component in YOUR three.js project.
//
// Everything under src/gpu/tsl/ is usable on its own, but wiring it takes
// project knowledge that should not be the price of admission: the compat shim
// must be installed before the first texture view, the sky LUT must be baked
// before the water can shade (the sea reflects the sky it renders), the passes
// have a required order (sea first, sky depth-tested behind it, spray on top,
// post last), and the drivers speak an internal `ctx` rig rather than a
// THREE.Camera. This module is that knowledge, packaged:
//
//   import { createAbyssal } from 'abyssal/three';
//
//   const abyssal = await createAbyssal( { canvas, preset: 'Tropical Noon' } );
//   abyssal.renderer.setAnimationLoop( () => abyssal.frame( camera ) );
//
// and the ocean, sky, spray and tonemapped image are on the canvas, WebGPU
// when the machine has it, WebGL2 when it does not - one source, both
// backends, verified pixel-identical (see docs/tsl-porting-rules.md).
//
// The facade OWNS the frame: it clears, draws your scene (if you hand it one),
// then the sea over it, then the sky behind everything, then spray, then the
// post chain onto the canvas. If instead you want the pieces inside a frame
// you own, use the drivers directly - this file doubles as the reference for
// the order and the uniforms they need.

import * as THREE from 'three/webgpu';

import { TslOceanSim } from './tsl/sim-driver.js';
import { TslSky } from './tsl/sky-driver.js';
import { TslWater } from './tsl/water-driver.js';
import { TslSpray } from './tsl/spray-driver.js';
import { TslPost } from './tsl/post-driver.js';
import { TslUnderwater } from './tsl/underwater-driver.js';
import { setUnderwaterUniforms } from './tsl/underwater.js';
import { installThreeCompat } from './three-compat.js';
import { cameraUnderwater } from '../underwater.js';

import { newParams, PRESETS, applyPreset } from '../presets.js';
import { CLOUD_TYPES, CLOUD_TYPE_NAMES, applyCloudType } from '../cloud-types.js';
import { createDerived, derive } from '../derive.js';

export { PRESETS, CLOUD_TYPES, CLOUD_TYPE_NAMES };

const _vp = /*@__PURE__*/ new THREE.Matrix4();
const _ivp = /*@__PURE__*/ new THREE.Matrix4();
const _size = /*@__PURE__*/ new THREE.Vector2();

/**
 * Build the whole Abyssal stack on a canvas or an existing renderer.
 *
 * @param {object} opts
 * @param {HTMLCanvasElement} [opts.canvas] - a canvas to own. The facade
 *   creates a THREE.WebGPURenderer on it (installing the compat shims first,
 *   which is the part that is easy to forget and impossible to debug).
 * @param {THREE.WebGPURenderer} [opts.renderer] - alternatively, a renderer
 *   you already created and initialised. Pass one or the other, not both.
 * @param {string} [opts.backend] - 'auto' (default) tries WebGPU and lets
 *   three fall back to WebGL2; 'webgl' forces the fallback; 'webgpu' demands
 *   WebGPU and REJECTS if the machine has none, so the word means something.
 * @param {string} [opts.preset] - a name from PRESETS. Default 'Golden Hour Swell'.
 * @param {string} [opts.clouds] - a name from CLOUD_TYPE_NAMES ('cirrus',
 *   'cumulus', 'stratus', 'nimbus', 'cumulonimbus') to override the preset's
 *   cloud parameters with a real genus. Omit to keep the preset's own sky.
 * @param {THREE.Scene} [opts.scene] - your objects. Rendered into the same
 *   HDR frame, depth-shared with the sea: your boat occludes the water and
 *   the water occludes its hull below the waterline.
 * @param {boolean} [opts.water] - default true. False skips the whole ocean
 *   (simulation, surface, spray) - a sky-and-clouds dome for your own ground.
 * @param {boolean} [opts.spray] - default true (ignored when water is false).
 * @param {boolean} [opts.post] - default true: the frame ends tonemapped on
 *   the canvas (or `output`). False leaves linear HDR in `.hdrTexture` and
 *   draws nothing to the canvas - bring your own tonemapper.
 * @param {THREE.RenderTarget} [opts.output] - post's destination when you
 *   want the finished LDR frame in a target instead of on the canvas.
 * @param {object} [opts.overrides] - parameter overrides applied on top of
 *   the preset (and cloud type), e.g. { fftSize: 128 } to shrink the FFT.
 *
 * @returns {Promise<object>} the instance - see the Object.assign at the end
 *   for the full surface.
 */
export async function createAbyssal( {
	canvas = null,
	renderer = null,
	backend = 'auto',
	preset = 'Golden Hour Swell',
	clouds = null,
	scene = null,
	water: wantWater = true,
	spray: wantSpray = true,
	post: wantPost = true,
	output = null,
	overrides = null,
} = {} ) {

	if ( ! canvas && ! renderer ) throw new Error( 'createAbyssal: pass a canvas or a renderer.' );

	// Before ANY device work. Patching GPUTexture.prototype.createView is global,
	// so this also covers a renderer the caller made - provided its first real
	// frame has not happened yet, which is why the docs say to call us early.
	installThreeCompat();

	if ( ! renderer ) {

		renderer = new THREE.WebGPURenderer( {
			canvas,
			forceWebGL: backend === 'webgl',
			antialias: false,
			alpha: false,
		} );
		await renderer.init();

	}

	const isWebGPU = !! renderer.backend?.isWebGPUBackend;
	if ( backend === 'webgpu' && ! isWebGPU ) {

		throw new Error( 'createAbyssal: backend "webgpu" was demanded but the renderer '
			+ 'initialised on WebGL2. This machine or browser has no usable WebGPU device.' );

	}

	// Every pass draws into a target another pass reads; nothing may clear
	// implicitly behind our back.
	renderer.autoClear = false;

	const params = newParams( preset );
	if ( clouds ) applyCloudType( params, clouds );
	if ( overrides ) Object.assign( params, overrides );
	const derived = createDerived();
	derive( params, derived );

	// TslSky FIRST: its constructor binds the real, mipped LUT before any other
	// material is built, and on WGSL the sampling instruction is chosen from
	// whatever is bound at build time (porting rule 11 - this line's position is
	// load-bearing).
	const sky = new TslSky( renderer );

	let sim = null, water = null, spray = null;
	if ( wantWater ) {

		sim = new TslOceanSim( renderer, { size: params.fftSize } );
		sim.setSeed( params.seed );
		sim.buildSpectrum( params );
		water = new TslWater( renderer, params );
		water.setFields( { disp: sim.disp, slope: sim.slope, foam: sim.foamTex } );
		if ( wantSpray ) spray = new TslSpray( renderer, { size: params.sprayTexSize } );

	}

	const post = wantPost ? new TslPost( renderer ) : null;
	if ( post ) post.seedAdapt();
	const underwater = new TslUnderwater( renderer );

	let hdr = null;
	const sizeTo = ( w, h ) => {

		if ( post ) post.resize( w, h );
		if ( hdr ) hdr.dispose();
		hdr = new THREE.RenderTarget( w, h, {
			type: THREE.HalfFloatType,
			format: THREE.RGBAFormat,
			minFilter: THREE.LinearFilter,
			magFilter: THREE.LinearFilter,
			depthBuffer: true,
			generateMipmaps: false,
		} );
		hdr.texture.name = 'abyssal.hdr';

	};

	let time = 0;
	let skyDirty = true;

	// The rig every driver takes, refreshed per frame from the caller's camera.
	const ctx = {
		camPos: new Float32Array( 3 ),
		camFwd: new Float32Array( 3 ),
		camRight: new Float32Array( 3 ),
		camUp: new Float32Array( 3 ),
		fov: 40,
		viewProj: null,
		invViewProj: null,
		sunDir: null, moonDir: null, windVec3: null,
		time: 0,
	};

	/**
	 * Render one complete frame through `camera` (a THREE.PerspectiveCamera you
	 * position however you like - OrbitControls, a flythrough, anything).
	 *
	 * @param {THREE.Camera} camera
	 * @param {number} [dt] - seconds since the last frame. Omit it and the
	 *   facade measures wall time itself, capped at 100 ms so a background tab
	 *   does not return as a tsunami.
	 */
	let lastNow = null;
	function frame( camera, dt = null ) {

		const now = performance.now();
		if ( dt == null ) dt = lastNow == null ? 0 : Math.min( ( now - lastNow ) / 1000, 0.1 );
		lastNow = now;
		time += dt * ( params.timeScale ?? 1 );

		renderer.getDrawingBufferSize( _size );
		const w = Math.max( 8, _size.x ), h = Math.max( 8, _size.y );
		if ( ! hdr || hdr.width !== w || hdr.height !== h ) sizeTo( w, h );

		derive( params, derived );

		// The drivers take the rig as flat arrays; three's Matrix4.elements is
		// already the column-major layout they expect.
		camera.updateMatrixWorld( true );
		_vp.multiplyMatrices( camera.projectionMatrix, camera.matrixWorldInverse );
		_ivp.copy( _vp ).invert();
		const e = camera.matrixWorld.elements;
		ctx.camPos[ 0 ] = e[ 12 ]; ctx.camPos[ 1 ] = e[ 13 ]; ctx.camPos[ 2 ] = e[ 14 ];
		// Three cameras look down local -Z; that column is the view forward.
		ctx.camFwd[ 0 ] = - e[ 8 ]; ctx.camFwd[ 1 ] = - e[ 9 ]; ctx.camFwd[ 2 ] = - e[ 10 ];
		ctx.camRight[ 0 ] = e[ 0 ]; ctx.camRight[ 1 ] = e[ 1 ]; ctx.camRight[ 2 ] = e[ 2 ];
		ctx.camUp[ 0 ] = e[ 4 ]; ctx.camUp[ 1 ] = e[ 5 ]; ctx.camUp[ 2 ] = e[ 6 ];
		ctx.fov = camera.fov ?? params.fov;
		ctx.aspect = camera.aspect ?? ( w / Math.max( h, 1 ) );
		ctx.viewProj = _vp.elements;
		ctx.invViewProj = _ivp.elements;
		ctx.sunDir = derived.sunDir;
		ctx.moonDir = derived.moonDir;
		ctx.windVec3 = derived.windVec3;
		ctx.time = time;

		if ( sim ) sim.update( dt, params );
		if ( spray ) spray.update( dt, params, ctx, sim );

		// The LUT is a function of sun/moon/eye height only - 512x256 of
		// scattering integrals, far too much to redo per frame. It re-bakes when
		// a preset or cloud type lands, or when you call markSkyDirty() after
		// moving the sun yourself.
		if ( skyDirty ) {

			sky.updateLUT( params, derived.sunDir, Math.max( ctx.camPos[ 1 ], 1 ) );
			skyDirty = false;

		}

		renderer.setRenderTarget( hdr );
		renderer.setClearColor( 0x000000, 1 );
		renderer.clear( true, true, false );

		// Your scene first (it writes real depth), then the sea against it, then
		// the sky depth-tested behind everything - the cloud march, the most
		// expensive thing per pixel, never runs where geometry already won - and
		// spray on top.
		if ( scene ) renderer.render( scene, camera );
		if ( water ) water.render( params, ctx, sim, camera );
		if ( cameraUnderwater( params, ctx.camPos[ 1 ] ) ) underwater.render( params, ctx );
		else {

			setUnderwaterUniforms( params, ctx );
			sky.drawBackground( params, ctx );

		}
		if ( spray ) spray.draw( params, ctx, sim, camera );

		renderer.setRenderTarget( null );

		if ( post ) post.render( hdr.texture, params, dt, time, output ? { output } : {} );

	}

	const api = {
		renderer,
		backend: isWebGPU ? 'webgpu' : 'webgl',
		fellBack: backend === 'auto' && ! isWebGPU,
		params, derived,
		sky, sim, water, spray, post,
		frame,
		get hdrTexture() { return hdr?.texture ?? null; },
		get time() { return time; },

		presets: Object.keys( PRESETS ),
		cloudTypes: CLOUD_TYPE_NAMES,

		/** Swap the whole scene preset (sea state, sun, clouds - everything). */
		setPreset( name ) {

			applyPreset( params, name );
			if ( sim ) sim.dirty = true;   // the wave spectrum is preset-shaped too
			skyDirty = true;

		},

		/**
		 * Put a real cloud genus over whatever preset is active: 'cirrus',
		 * 'cumulus', 'stratus', 'nimbus', 'cumulonimbus'. Only cloud parameters
		 * change - the light, the sea and the time of day stay the preset's.
		 */
		setClouds( name ) {

			applyCloudType( params, name );
			skyDirty = true;

		},

		/** After changing sun/moon/turbidity parameters directly. */
		markSkyDirty() { skyDirty = true; },

		dispose() {

			hdr?.dispose();
			sim?.dispose?.();
			water?.dispose?.();
			spray?.dispose?.();
			post?.dispose?.();
			sky?.dispose?.();

		},
	};

	return api;

}
