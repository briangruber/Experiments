// Abyssal on three.js — WebGPU by default, WebGL2 as the fallback, one source.
//
// This is the counterpart of demo/main.js, which drives the raw-GL renderer.
// Everything here goes through THREE.WebGPURenderer and the TSL node graphs in
// src/gpu/tsl/, so the same code compiles to WGSL on WebGPU and to GLSL on
// WebGL2 and the backend is a runtime choice rather than a build.
//
// Every stage below is verified against the shipping WebGL2 renderer, image by
// image, on both backends:
//
//   simulation   test/golden/ocean-64.json / ocean-256.json   bit-exact
//   sky          test/golden/sky.json                         0 / 16000 px
//   water        test/golden/water.json                       0 / 16000 px
//   post         test/golden/post.json                        0 / 16000 px + exact metering
//   spray        test/golden/spray.json                       2 / 16000 px
//
// See docs/tsl-porting-rules.md for what that cost and what it taught.
//
// ---------------------------------------------------------------------------
// NOT YET HERE: the craft and its wake.
//
// demo/craft.js and src/wake.js are still raw GL and are not part of this entry
// point. The sea, sky, spray and post chain are complete; riding the waverunner
// is demo/main.js only, for now. water-common.js already carries the wake
// sampling and its uniforms, so the remaining work is the wake field simulation
// and the craft mesh, not the water's side of it.

import * as THREE from 'three/webgpu';
import { texture, uv, vec4, float } from 'three/tsl';

import { TslOceanSim } from '../src/gpu/tsl/sim-driver.js';
import { TslSky } from '../src/gpu/tsl/sky-driver.js';
import { TslWater } from '../src/gpu/tsl/water-driver.js';
import { TslSpray } from '../src/gpu/tsl/spray-driver.js';
import { TslPost } from '../src/gpu/tsl/post-driver.js';

import { newParams, PRESETS, applyPreset } from '../src/presets.js';
import { createDerived, derive } from '../src/derive.js';
import { Camera } from './camera.js';
import { installThreeCompat } from '../src/gpu/three-compat.js';

// ---------------------------------------------------------------------------
// Backend selection.
//
// `auto` (the default) asks for WebGPU and lets three fall back to WebGL2 by
// itself. `?backend=webgl` forces the fallback. `?backend=webgpu` DEMANDS
// WebGPU and throws if it did not get it, which is what makes the button's
// "WebGPU" position mean something rather than silently showing the same thing
// twice.

// Read lazily, not at module scope, so the module is importable outside a
// browser (the headless checks do exactly that).
export function wantedBackend() {

	if ( typeof location === 'undefined' ) return 'auto';
	return ( new URLSearchParams( location.search ).get( 'backend' ) || 'auto' ).toLowerCase();

}

export async function createRenderer( canvas, want = wantedBackend() ) {

	// Before any device is created. See src/gpu/three-compat.js - without this,
	// three r185 cannot create a single texture view on Chromium 141+ and WebGPU
	// fails outright.
	installThreeCompat();

	const WANT = want;
	const renderer = new THREE.WebGPURenderer( {
		canvas,
		forceWebGL: WANT === 'webgl',
		antialias: false,
		alpha: false,
	} );
	await renderer.init();

	const isWebGPU = !! renderer.backend?.isWebGPUBackend;

	if ( WANT === 'webgpu' && ! isWebGPU ) {

		throw new Error(
			'backend=webgpu was requested but the renderer initialised on WebGL2. ' +
			'This machine or browser has no usable WebGPU device.',
		);

	}

	return { renderer, backend: isWebGPU ? 'webgpu' : 'webgl', fellBack: WANT === 'auto' && ! isWebGPU };

}

// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {HTMLCanvasElement} opts.canvas
 * @param {string} [opts.preset]
 * @param {string} [opts.backend]   'auto' | 'webgpu' | 'webgl'
 * @param {object} [opts.overrides] parameter overrides applied after the preset -
 *   used by the headless smoke check to shrink the workload, since a software
 *   rasteriser cannot carry a 256-point FFT and 16k particles a frame.
 * @param {THREE.RenderTarget} [opts.output] send the finished frame here instead of
 *   the canvas. The headless check needs this: WebGPU in this sandbox draws into
 *   render targets correctly but cannot PRESENT to a canvas swapchain
 *   (prototypes/webgpu-canvas-probe.html shows a one-quad draw failing with
 *   "A valid external Instance reference no longer exists"), so capturing the
 *   frame is the only way to exercise the whole pipeline there.
 * @param {Function} [opts.onReady]
 */
export async function boot( { canvas, preset = 'Golden Hour Swell', onReady, backend: want, overrides, output = null } = {} ) {

	const { renderer, backend, fellBack } = await createRenderer( canvas, want ?? wantedBackend() );

	// Every pass draws into a target that another pass reads, so nothing may
	// clear implicitly. Porting rule 15.
	renderer.autoClear = false;

	const params = newParams( preset );
	if ( overrides ) Object.assign( params, overrides );
	const derived = createDerived();
	derive( params, derived );

	const camera = new Camera( canvas );

	// TslSky FIRST: its constructor binds the real, mipped LUT before any other
	// material is built, and on WGSL the sampling instruction is chosen from
	// whatever is bound at build time (porting rule 11).
	const sky = new TslSky( renderer );
	const sim = new TslOceanSim( renderer, { size: params.fftSize } );
	sim.setSeed( params.seed );
	sim.buildSpectrum( params );

	const water = new TslWater( renderer, params );
	water.setFields( { disp: sim.disp, slope: sim.slope, foam: sim.foamTex } );

	const spray = new TslSpray( renderer, { size: params.sprayTexSize } );
	const post = new TslPost( renderer );

	// The three camera the sea is rasterised through. demo/camera.js owns the
	// rig; this mirrors its matrices onto a three camera each frame, because
	// waterPosition() returns world space and three builds the MVP from it.
	const cam3 = new THREE.PerspectiveCamera( camera.fov, 1, camera.near, camera.far );

	// ---- frame diagnostic -----------------------------------------------------
	//
	// The WebGPU render path cannot be checked where this was written: the sandbox
	// draws into render targets correctly but cannot present to a canvas at all.
	// So the app measures its own output and reports it, and the reader's machine
	// becomes the probe.
	//
	// Two horizontal bands of the finished HDR frame are averaged into a 64x1
	// target and read back once a second. Which band is "sky" depends on the
	// backend's framebuffer orientation, so both are reported and neither is
	// labelled - a sea-and-sky frame has one bright band and one darker one,
	// whatever the order. Two dark bands means nothing was drawn.
	//
	// 64 texels x 16 bytes is a 1024-byte row, which clears WebGPU's 256-byte
	// readback pitch rule. A narrower target would silently return padding.
	const diagRT = new THREE.RenderTarget( 64, 1, {
		type: THREE.FloatType, format: THREE.RGBAFormat,
		minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false,
	} );
	const diagSrc = texture( new THREE.DataTexture(
		new Float32Array( [ 0, 0, 0, 1 ] ), 1, 1, THREE.RGBAFormat, THREE.FloatType ) );
	diagSrc.value.minFilter = diagSrc.value.magFilter = THREE.LinearFilter;
	diagSrc.value.needsUpdate = true;

	const LUMA = ( c ) => c.r.mul( 0.2126 ).add( c.g.mul( 0.7152 ) ).add( c.b.mul( 0.0722 ) );
	const diagMat = new THREE.NodeMaterial();
	diagMat.fragmentNode = vec4(
		LUMA( diagSrc.sample( vec4( uv().x, 0.85, 0, 0 ).xy ) ),
		LUMA( diagSrc.sample( vec4( uv().x, 0.15, 0, 0 ).xy ) ),
		0, 1,
	);
	diagMat.depthTest = false; diagMat.depthWrite = false;
	const diagQuad = new THREE.QuadMesh( diagMat );

	let diagBusy = false;
	let diagAt = 0;
	const readDiag = async () => {

		if ( diagBusy ) return;
		diagBusy = true;
		try {

			const prev = renderer.getRenderTarget();
			renderer.setRenderTarget( diagRT );
			diagQuad.render( renderer );
			renderer.setRenderTarget( prev );
			const raw = await renderer.readRenderTargetPixelsAsync( diagRT, 0, 0, 64, 1 );
			const px = raw instanceof Float32Array ? raw : new Float32Array( raw.buffer ?? raw );
			let a = 0, b = 0;
			for ( let i = 0; i < 64; i ++ ) { a += px[ i * 4 ]; b += px[ i * 4 + 1 ]; }
			api.diag = { bandA: a / 64, bandB: b / 64 };

		} catch ( e ) {

			api.diag = { error: String( e?.message || e ).slice( 0, 80 ) };

		}
		diagBusy = false;

	};

	let hdr = null;
	const sizeTo = ( w, h ) => {

		renderer.setSize( w, h, false );
		post.resize( w, h );
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
		diagSrc.value = hdr.texture;
		cam3.aspect = w / h;
		cam3.updateProjectionMatrix();

	};

	const resize = () => {

		const dpr = Math.min( window.devicePixelRatio || 1, params.renderScale ?? 1 );
		const w = Math.max( 8, Math.round( canvas.clientWidth * dpr ) );
		const h = Math.max( 8, Math.round( canvas.clientHeight * dpr ) );
		if ( canvas.width !== w || canvas.height !== h || ! hdr ) sizeTo( w, h );

	};
	resize();
	window.addEventListener( 'resize', resize );

	post.seedAdapt();

	const api = {};

	let last = performance.now();
	let time = 0;
	let skyDirty = true;

	function frame( now ) {

		const dt = Math.min( ( now - last ) / 1000, 0.1 );
		last = now;
		time += dt * ( params.timeScale ?? 1 );

		resize();
		camera.update( dt, params );

		// THIS IS NOT OPTIONAL, and leaving it out is invisible until you look up.
		//
		// camera.update() advances the position and the fwd/right/up basis, but
		// viewProj and invViewProj are only built by matrices(). Without this call
		// they stay at the identity they were constructed with - and the SEA still
		// draws correctly, because it is rasterised through the three camera built
		// from pos and fwd below. Only the sky notices: its background pass takes a
		// ray from invViewProj, and through an identity matrix every ray points
		// somewhere near straight down, so the sky renders as though the camera were
		// buried. The frame looks like a sea with no sky above it.
		camera.matrices( canvas.width, canvas.height );

		derive( params, derived );

		// The rig, in the shape every driver takes.
		const ctx = {
			camPos: camera.pos,
			viewProj: camera.viewProj,
			invViewProj: camera.invViewProj,
			camRight: camera.right,
			camUp: camera.up,
			sunDir: derived.sunDir,
			moonDir: derived.moonDir,
			windVec3: derived.windVec3,
			time,
		};

		cam3.position.set( camera.pos[ 0 ], camera.pos[ 1 ], camera.pos[ 2 ] );
		cam3.lookAt(
			camera.pos[ 0 ] + camera.fwd[ 0 ],
			camera.pos[ 1 ] + camera.fwd[ 1 ],
			camera.pos[ 2 ] + camera.fwd[ 2 ],
		);
		cam3.fov = camera.fov;
		cam3.near = camera.near;
		cam3.far = camera.far;
		cam3.updateProjectionMatrix();
		cam3.updateMatrixWorld( true );

		sim.update( dt, params );
		spray.update( dt, params, ctx, sim );

		// The LUT is a function of sun/moon/eye height only, so it is re-baked when
		// one of those moves rather than every frame - it is 512x256 of scattering
		// integrals and by far the most expensive thing that does not have to be.
		if ( skyDirty ) {

			sky.updateLUT( params, derived.sunDir, Math.max( camera.pos[ 1 ], 1 ) );
			skyDirty = false;

		}

		// --- the frame -------------------------------------------------------
		renderer.setRenderTarget( hdr );
		renderer.setClearColor( 0x000000, 1 );
		renderer.clear( true, true, false );

		// Sea first; the sky is then depth-tested against it and its cloud march -
		// the most expensive thing per pixel - never runs on a pixel the sea covers.
		water.render( params, ctx, sim, cam3 );
		sky.drawBackground( params, ctx );
		spray.draw( params, ctx, sim, cam3 );

		renderer.setRenderTarget( null );

		// The post chain's last pass writes to opts.output ?? null - the canvas by
		// default, or a capture target when one was handed in.
		post.render( hdr.texture, params, dt, time, output ? { output } : {} );

		api.onFrame?.();

		// Once a second, and never overlapping itself.
		if ( now - diagAt > 1000 ) { diagAt = now; readDiag(); }

		requestAnimationFrame( frame );

	}

	requestAnimationFrame( frame );

	Object.assign( api, {
		renderer, backend, fellBack, params, derived, camera, sim, sky, water, spray, post,
		output,
		onFrame: null,
		markSkyDirty: () => { skyDirty = true; },
		presets: Object.keys( PRESETS ),
		applyPreset: ( name ) => { applyPreset( params, name ); skyDirty = true; },
	} );
	onReady?.( api );
	return api;

}
