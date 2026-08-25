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
// frame() skips to fpsCap (60 plugged in, 30 on battery) so a 120 Hz
// panel does not draw twice. The loop can still fire every vsync.
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
import { TslWake } from './tsl/wake-driver.js';
import { TslCraftProbe } from './tsl/craft-probe.js';
import { TslRefraction } from './tsl/refraction-driver.js';
import { loadWaterAssetTextures } from './tsl/water-assets.js';
import { CLIP, setWaterClip, applyWaterClip } from './tsl/water-clip.js';
import {
	setRefractionTextures, uRefractAmount, uRefractDistort, uRefractFade, uRefractThrough,
	applySwellUniforms, waterDisplaceScale,
} from './tsl/water-surface.js';
import { setVWakeUniforms } from './tsl/v-wake.js';
import { setPierceUniforms } from './tsl/pierce.js';
import { setPierceCarveUniforms } from './tsl/pierce-carve.js';
import { setUnderwaterUniforms } from './tsl/underwater.js';
import { installThreeCompat } from './three-compat.js';
import { cameraUnderwater } from '../underwater.js';
import { liveFpsCap, fpsCappedOut, shouldSkipFrame } from '../fps-cap.js';
import { BodyList, OceanBody, SKI, craftBasis, parseSwell, parseWake, parseWakeJet, parseSpray, parsePierce, applySprayContext } from '../ocean-body.js';
import { createOceanLitMaterial, uCraftWetLine, uCraftAerial } from './tsl/ocean-lit.js';
import {
	createCreatureMaterial, setCreatureTexture, uCreatureAerial,
} from './tsl/creature.js';
import { createBodyDebug } from './body-debug.js';
import { createLeftoverBubbles } from './leftover-bubbles.js';

export { OceanBody, BodyList, SKI, craftBasis, parseSwell, parseWake, parseWakeJet, parseSpray, parsePierce, createOceanLitMaterial };
export {
	buildCraftGeometry, buildBreachProfile, breachProfileFromObject,
	scaleBreachProfile, loadCraftTexture,
} from './tsl/craft.js';
export {
	createCreatureMaterial, setCreatureTexture,
	uCreatureLen, uCreaturePhase, uCreatureWaves, uCreatureAmp,
	uCreatureSide, uCreatureLift, uCreatureTurn, uCreatureGape,
	uCreatureJawHY, uCreatureJawHZ, uCreatureSeaY, uCreatureTint, uCreaturePaint,
} from './tsl/creature.js';
export { loadFloorPropAssets, plantSeafloorProps, FLOOR_PROP_URLS } from './seafloor-props.js';
export { placeFloorProps, FLOOR_PROP_KINDS } from '../seafloor-props.js';

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
 *   HDR frame, depth-shared with the sea. The ocean photographs the scene
 *   into its refraction target (under the waterline) and the beauty pass
 *   (above it) so every mesh is seen through the water the same way. Call
 *   `bodies.add(mesh, { mass, float, wake, swell, spray, pierce, debug })` — or spread `SKI` — to
 *   make a mesh drop, plane, splash, leave a wake (origin / start / end /
 *   length / count / turbulence), lift a just-under dome / bow heap /
 *   laminar loaf, shed spray from waterline contacts, or cut a pole
 *   through the sea at one mesh point (`pierce`). `debug: true`
 *   draws magenta spray cuts and cyan buoyancy probes. A live `pierce`
 *   also draws an amber ball at the contact.
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

	// Decode the project-owned monochrome masks before the node graphs are
	// assembled. Their placeholders have matching sampler state, so direct
	// driver users may also bind late; the facade waits to avoid a placeholder
	// first frame and to keep the self-contained bundle fetch-free.
	if ( wantWater ) await loadWaterAssetTextures();

	// TslSky FIRST: its constructor binds the real, mipped LUT before any other
	// material is built, and on WGSL the sampling instruction is chosen from
	// whatever is bound at build time (porting rule 11 - this line's position is
	// load-bearing).
	const sky = new TslSky( renderer );

	let sim = null, water = null, spray = null, wake = null, probe = null, refraction = null;
	const bodies = new BodyList();
	const bodyDebug = createBodyDebug();
	const leftoverBubbles = createLeftoverBubbles();
	const hull = { pos: new Float32Array( 3 ), fwd: new Float32Array( 2 ), push: 0, plane: 0 };
	let wakeHold = 0;
	let lastWakeDims = { kelvinOn: 0 };
	if ( wantWater ) {

		sim = new TslOceanSim( renderer, { size: params.fftSize } );
		sim.setSeed( params.seed );
		sim.buildSpectrum( params );
		water = new TslWater( renderer, params );
		water.setFields( { disp: sim.disp, slope: sim.slope, foam: sim.foamTex } );
		wake = new TslWake( renderer, { size: params.wakeTexSize } );
		probe = new TslCraftProbe( renderer );
		if ( scene ) refraction = new TslRefraction( renderer, { scale: 0.5 } );
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
		if ( refraction ) {

			const t = refraction.resize( w, h );
			setRefractionTextures( { color: t.texture, depth: t.depthTexture } );

		}

	};

	let time = 0;
	let skyDirty = true;

	// Same stage ids as demo/perf-debug.js so the ride overlay mounts on a
	// facade app. `dragon` here is the ocean's refraction pass (every mesh
	// under the waterline), not the animal.
	const perf = {
		sim: true, sea: true, sky: true, spray: true,
		dragon: true, craft: true, floor: true, post: true,
	};
	const perfTimes = { cpu: 0, stages: {}, ran: {} };
	let onFrame = null;
	let lastProfile = null;
	let qAccum = 0, qFrames = 0;
	let battCharging = true;
	navigator.getBattery?.().then( ( b ) => {

		battCharging = !! b.charging;
		b.addEventListener?.( 'chargingchange', () => { battCharging = !! b.charging; } );

	} ).catch( () => {} );

	const liveCap = () => liveFpsCap( params, {
		focused: typeof document === 'undefined' || document.hasFocus(),
		charging: battCharging,
	} );

	// Same GPU timestamp pump the ride demo uses. Heat is GPU ms ÷ frame ms;
	// without this, box-ski's Perf overlay stays on "—" forever because
	// createAbyssal never set perfTimes.gpuOk. Off until the overlay is
	// open — the queries cost a little. Resolve is async; keep the last
	// good sample. Twin: demo/three-main.js enableGpuTimers / pumpGpuTimers.
	let api;
	let gpuResolveBusy = false;
	function enableGpuTimers() {

		const b = renderer.backend;
		if ( ! b ) return false;
		try {

			if ( renderer.hasFeature?.( 'timestamp-query' ) ) {

				b.trackTimestamp = true;
				return true;

			}

		} catch { /* hasFeature throws before init on some builds */ }
		if ( b.gl ) {

			b.trackTimestamp = true;
			return true;

		}
		perfTimes.gpuTried = true;
		return false;

	}
	async function sampleGpu() {

		if ( ! enableGpuTimers() ) return null;
		try {

			const render = await renderer.resolveTimestampsAsync( 'render' );
			const compute = await renderer.resolveTimestampsAsync( 'compute' );
			const r = Number( render ) || 0;
			const c = Number( compute ) || 0;
			return { render: r, compute: c, total: r + c };

		} catch {

			perfTimes.gpuTried = true;
			return null;

		}

	}
	function armGpuTimers() {

		const b = renderer.backend;
		if ( ! b ) return;
		// Resolve is async. Timestamping every present while a readback is
		// in flight piles 2–3 frames into one Heat reading (48 ms GPU at
		// 58 fps). Only the frame we are about to resolve gets queries.
		if ( api?._perfDebug?.isOpen() && ! gpuResolveBusy ) enableGpuTimers();
		else b.trackTimestamp = false;

	}
	function pumpGpuTimers() {

		if ( ! api?._perfDebug?.isOpen() ) {

			if ( renderer.backend ) renderer.backend.trackTimestamp = false;
			return;

		}
		if ( gpuResolveBusy ) return;
		if ( ! enableGpuTimers() ) return;
		gpuResolveBusy = true;
		sampleGpu().then( ( g ) => {

			if ( ! g ) return;
			perfTimes.gpuRender = g.render;
			perfTimes.gpuCompute = g.compute;
			perfTimes.gpu = g.total;
			perfTimes.gpuOk = g.total > 0.01;
			perfTimes.gpuAt = performance.now();

		} ).finally( () => { gpuResolveBusy = false; } );

	}

	function applyOutputSize() {

		const canvas = renderer.domElement;
		const dpr = Math.min( window.devicePixelRatio || 1, Math.max( params.dprCap ?? 2, 0.5 ) );
		const scale = params.renderScale ?? 1;
		const cssW = Math.max( 1, canvas.clientWidth || 1 );
		const cssH = Math.max( 1, canvas.clientHeight || 1 );
		renderer.setPixelRatio( dpr * scale );
		renderer.setSize( cssW, cssH, false );
		renderer.getDrawingBufferSize( _size );
		const w = Math.max( 8, _size.x ), h = Math.max( 8, _size.y );
		if ( ! hdr || hdr.width !== w || hdr.height !== h ) sizeTo( w, h );

	}

	function adaptQuality( dtRaw ) {

		if ( ! params.adaptiveQuality ) return;
		qAccum += dtRaw;
		qFrames ++;
		if ( qAccum < 1.0 ) return;
		const fps = qFrames / qAccum;
		qAccum = 0;
		qFrames = 0;
		const cap = liveCap();
		const lo = params.renderScaleMin ?? 0.4, hi = params.renderScaleMax ?? 1;
		if ( fps < ( params.targetFps ?? 60 ) * 0.9 && ! fpsCappedOut( fps, cap ) ) {

			if ( params.renderScale > lo ) {

				params.renderScale = Math.max( lo, params.renderScale - 0.08 );

			} else if ( ( params.cloudStepScale ?? 1 ) > ( params.cloudStepMin ?? 0.4 ) ) {

				params.cloudStepScale = Math.max( params.cloudStepMin ?? 0.4, params.cloudStepScale - 0.15 );

			} else if ( water && ( params.gridScale ?? 1 ) > ( params.gridScaleMin ?? 0.45 ) ) {

				params.gridScale = Math.max( params.gridScaleMin ?? 0.45, params.gridScale - 0.12 );
				water.rebuildGrid( params );

			}

		} else if ( fps > ( params.targetFps ?? 60 ) * 1.25 && ! fpsCappedOut( fps, cap ) ) {

			if ( water && ( params.gridScale ?? 1 ) < 1 ) {

				params.gridScale = Math.min( 1, params.gridScale + 0.06 );
				water.rebuildGrid( params );

			} else if ( ( params.cloudStepScale ?? 1 ) < 1 ) {

				params.cloudStepScale = Math.min( 1, params.cloudStepScale + 0.08 );

			} else if ( params.renderScale < hi ) {

				params.renderScale = Math.min( hi, params.renderScale + 0.04 );

			}

		}

	}

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
	 * @param {{ onBodies?: () => void }} [opts] - `onBodies` runs after the
	 *   bodies have stepped and their meshes are posed, before anything is
	 *   drawn. A camera that chases a hull MUST aim from there: frame() steps
	 *   the body itself, so a camera placed beforehand is aimed a whole
	 *   `velocity × dt` behind the mesh that is about to be drawn. Frame times
	 *   are not a metronome, so that lag changes every frame and the hull
	 *   slides fore and aft in view — imperceptible at a crawl, over a metre
	 *   of judder at planing speed.
	 */
	let lastNow = null;
	let lastPresent = 0;
	function frame( camera, dt = null, opts = {} ) {

		const wall = performance.now();
		// Same duty cycle as the ride demo. setAnimationLoop fires at the
		// display refresh; without this skip a ProMotion panel presents
		// twice and Heat / laptop energy go right back up.
		if ( shouldSkipFrame( wall, lastPresent, liveCap() ) ) return;
		lastPresent = wall;

		armGpuTimers();
		if ( api?._perfDebug?.isOpen() ) {

			// setAnimationLoop already ticks info.frame; a caller who owns
			// rAF does not. Reset + increment when the overlay is open so
			// timestamp queries are not all tagged :f0 (that summed several
			// frames into one Heat reading). Twin: demo/three-main.js.
			renderer.info.reset();
			renderer.info.frame ++;

		}

		const cpu0 = performance.now();
		for ( const k of Object.keys( perfTimes.stages ) ) perfTimes.stages[ k ] = 0;
		for ( const k of Object.keys( perfTimes.ran ) ) perfTimes.ran[ k ] = 0;
		const mark = ( id, fn ) => {

			if ( ! perf[ id ] ) return;
			const t0 = performance.now();
			fn();
			perfTimes.stages[ id ] = ( perfTimes.stages[ id ] || 0 ) + ( performance.now() - t0 );
			perfTimes.ran[ id ] = 1;

		};

		// Instanced rocks / coral live on the caller's scene. The overlay
		// can hide them; they are otherwise drawn in refraction and beauty.
		const floorGroup = scene?.getObjectByName?.( 'seafloor-props' );
		if ( floorGroup ) {

			floorGroup.visible = !! perf.floor;
			perfTimes.ran.floor = perf.floor ? 1 : 0;

		}

		const now = performance.now();
		if ( dt == null ) dt = lastNow == null ? 0 : Math.min( ( now - lastNow ) / 1000, 0.1 );
		lastNow = now;
		time += dt * ( params.timeScale ?? 1 );

		adaptQuality( dt );
		applyOutputSize();

		derive( params, derived );

		// The drivers take the rig as flat arrays; three's Matrix4.elements is
		// already the column-major layout they expect. _vp / _ivp are written
		// in place, so ctx keeps pointing at them across a re-read.
		const readCamera = () => {

			camera.updateMatrixWorld( true );
			_vp.multiplyMatrices( camera.projectionMatrix, camera.matrixWorldInverse );
			_ivp.copy( _vp ).invert();
			const e = camera.matrixWorld.elements;
			ctx.camPos[ 0 ] = e[ 12 ]; ctx.camPos[ 1 ] = e[ 13 ]; ctx.camPos[ 2 ] = e[ 14 ];
			// Three cameras look down local -Z; that column is the view forward.
			ctx.camFwd[ 0 ] = - e[ 8 ]; ctx.camFwd[ 1 ] = - e[ 9 ]; ctx.camFwd[ 2 ] = - e[ 10 ];
			ctx.camRight[ 0 ] = e[ 0 ]; ctx.camRight[ 1 ] = e[ 1 ]; ctx.camRight[ 2 ] = e[ 2 ];
			ctx.camUp[ 0 ] = e[ 4 ]; ctx.camUp[ 1 ] = e[ 5 ]; ctx.camUp[ 2 ] = e[ 6 ];

		};
		readCamera();
		ctx.fov = camera.fov ?? params.fov;
		ctx.aspect = camera.aspect ?? ( w / Math.max( h, 1 ) );
		ctx.viewProj = _vp.elements;
		ctx.invViewProj = _ivp.elements;
		ctx.sunDir = derived.sunDir;
		ctx.moonDir = derived.moonDir;
		ctx.windVec3 = derived.windVec3;
		ctx.time = time;

		if ( sim ) mark( 'sim', () => sim.update( dt, params ) );

		// Bodies ride last frame's probe (the readback is async) and write the
		// shared wake field before the sea draws, so the water sees this frame's
		// stamps. The probe itself runs AFTER the water — it samples the same
		// cascade uniforms the surface just bound.
		if ( bodies.length && perf.craft ) {

			mark( 'craft', () => {

				bodies.step( dt, { seaLevel: params.seaLevel } );
				bodies.syncMeshes();
				// The hull has moved. A chase camera aimed before this call is
				// a whole velocity × dt behind it, and dt is never the same two
				// frames running, so re-aim now or the hull judders in view.
				if ( opts.onBodies ) {

					opts.onBodies();
					readCamera();

				}

				bodies.stepRipples( dt, params );
				bodies.stepVWake( dt, params );
				setVWakeUniforms( bodies.vWakeUniforms() );
				if ( wake ) {

					const sources = bodies.stampWake( wake, dt, params, camera );
					const stamping = sources.length > 0;
					wakeHold = stamping ? Math.max( params.wakeLife, 0.5 ) : Math.max( 0, wakeHold - dt );
					const primary = bodies.primaryHull( [ ctx.camPos[ 0 ], ctx.camPos[ 2 ] ] );
					const phys = bodies.physicsWakeDims( params );
					if ( phys ) lastWakeDims = phys;
					else if ( primary ) lastWakeDims = primary.wakeRenderDims( params );
					if ( primary ) uCraftWetLine.value = primary.surf;
					const h = primary?.hullState();
					if ( h ) {

						hull.pos[ 0 ] = h.pos[ 0 ]; hull.pos[ 1 ] = h.pos[ 1 ]; hull.pos[ 2 ] = h.pos[ 2 ];
						hull.fwd[ 0 ] = h.fwd[ 0 ]; hull.fwd[ 1 ] = h.fwd[ 1 ];
						hull.push = h.push; hull.plane = h.plane;
						hull.radius = h.radius; hull.bow = h.bow;

					} else {

						hull.pos[ 0 ] = 0; hull.pos[ 1 ] = - 1e4; hull.pos[ 2 ] = 0;
						hull.push = 0; hull.plane = 0;
						hull.radius = undefined; hull.bow = undefined;

					}

				}

				applySwellUniforms( bodies.swellState( dt, {
					seaLevel: params.seaLevel,
					scale: waterDisplaceScale( params ),
					params,
				}, [ ctx.camPos[ 0 ], ctx.camPos[ 2 ] ] ) );
				applySprayContext( ctx, bodies.sprayState( dt, {
					seaLevel: params.seaLevel,
					params,
				}, [ ctx.camPos[ 0 ], ctx.camPos[ 2 ] ] ) );
				setPierceUniforms( bodies.pierceState( {
					seaLevel: params.seaLevel,
				}, [ ctx.camPos[ 0 ], ctx.camPos[ 2 ] ] ) );
				bodies.stepPierceCarve( dt, {
					seaLevel: params.seaLevel,
				}, [ ctx.camPos[ 0 ], ctx.camPos[ 2 ] ] );
				setPierceCarveUniforms( bodies.carve );

			} );

		} else {

			if ( ! perf.craft ) {

				hull.pos[ 0 ] = 0; hull.pos[ 1 ] = - 1e4; hull.pos[ 2 ] = 0;
				hull.push = 0; hull.plane = 0;

			}

			applySwellUniforms( null );
			applySprayContext( ctx, null );
			setPierceUniforms( null );
			bodies.carve.step( dt, null );
			setPierceCarveUniforms( null );
			bodies.vWake.step( dt, null );
			setVWakeUniforms( { stamps: [] } );

		}

		if ( spray ) mark( 'spray', () => spray.update( dt, params, ctx, sim ) );

		// The LUT is a function of sun/moon/eye height only - 512x256 of
		// scattering integrals, far too much to redo per frame. It re-bakes when
		// a preset or cloud type lands, or when you call markSkyDirty() after
		// moving the sun yourself.
		if ( skyDirty ) {

			sky.updateLUT( params, derived.sunDir, Math.max( ctx.camPos[ 1 ], 1 ) );
			skyDirty = false;

		}

		const seam = Math.max( 0.8, ( params.swellAmount ?? 0.5 ) * 2 );
		const camUnder = cameraUnderwater( params, ctx.camPos[ 1 ] );
		if ( scene ) applyWaterClip( scene );

		// The ocean photographs the scene, not each body. Under the waterline
		// goes into the refraction target; the sea looks through itself at it.
		// Gated as `dragon` so the shared Perf overlay can turn the pass off.
		if ( refraction && scene && perf.dragon ) {

			mark( 'dragon', () => {

				// The sea hazes the finished lookup. A body that arrived
				// already hazed would be hazed twice.
				uCreatureAerial.value = 0;
				uCraftAerial.value = 0;
				refraction.render( scene, camera, params.seaLevel, seam );
				uRefractAmount.value = 1;
				uRefractDistort.value = params.sdRefract ?? 0.43;
				uRefractFade.value = params.sdFade ?? 23;
				uRefractThrough.value = params.sdThrough ?? 0.07;

			} );

		} else {

			if ( refraction && ! perf.dragon ) refraction.clear();
			uRefractAmount.value = 0;

		}

		renderer.setRenderTarget( hdr );
		renderer.setClearColor( 0x000000, 1 );
		renderer.clear( true, true, false );

		// Beauty: only what is above the waterline (the sea owns the rest).
		// Under the camera the whole mesh is in front of you, so the clip
		// turns off the same way the ride demo does for the animal.
		if ( scene && perf.craft ) {

			mark( 'craft', () => {

				uCreatureAerial.value = camUnder ? 0 : 1;
				uCraftAerial.value = camUnder ? 0 : 1;
				setWaterClip( camUnder ? CLIP.OFF : CLIP.ABOVE, params.seaLevel, seam );
				renderer.render( scene, camera );
				setWaterClip( CLIP.OFF, params.seaLevel, seam );

			} );

		}
		if ( water ) {

			const waterOpts = wake
				? { wake: wake.uniforms( params, wakeHold > 0, lastWakeDims ), hull, wakeWaves: bodies.waves }
				: {};
			if ( bodies.hasPhysicsWake() ) {

				waterOpts.ripples = bodies.ripples;
				waterOpts.rippleDebug = bodies.rippleDebug;
				waterOpts.rippleVis = bodies.rippleVis;
				// Leftover crest *look* is optional. Wave carry advects the
				// existing film along leftover faces; crest look paints those
				// crests white. They used to share one slider, so turning
				// carry on punched rings through the ribbon.
				const phys = bodies.physicsWakeBody();
				const foamAmt = phys?.wakeConfig?.()?.foam
					?? ( typeof phys?.wake === 'object' ? phys.wake.foam : 0 )
					?? 0;
				const crestLook = params.wakeFoamCrestLook;
				waterOpts.rippleFoam = ( crestLook === undefined
					? ( params.wakeFoamWaveCarry ?? 0 )
					: crestLook )
					* Math.max( Number( foamAmt ) || 0, 0 );
				// Separate knob: wipe the film out of leftover TROUGHS without
				// painting anything onto crests. A real wake's quarter-wave
				// shoulders are glassy; only breaking crests go white.
				waterOpts.rippleCrestGate = params.wakeFoamCrestGate ?? 0;
				// Energy saturates at planing; this is the film look.
				waterOpts.foamRibbon = Math.max( Number( foamAmt ) || 0, 0 );

			}
			mark( 'sea', () => water.render( params, ctx, sim, camera, waterOpts ) );

		}
		if ( perf.sky ) {

			mark( 'sky', () => {

				if ( camUnder ) underwater.render( params, ctx );
				else {

					setUnderwaterUniforms( params, ctx );
					sky.drawBackground( params, ctx );

				}

			} );

		}
		if ( spray ) mark( 'spray', () => spray.draw( params, ctx, sim, camera ) );

		if ( leftoverBubbles && bodies.length && perf.craft && hdr ) {

			if ( leftoverBubbles.sync( bodies.bubbles, camera ) ) {

				renderer.setRenderTarget( hdr );
				renderer.render( leftoverBubbles.scene, camera );

			}

		}

		if ( bodyDebug && bodies.length && perf.craft && hdr ) {

			if ( bodyDebug.sync( bodies, {
				seaLevel: params.seaLevel,
				emit: bodies.rippleEmitDebug,
				buoyancy: bodies.buoyDebug,
			} ) ) {

				renderer.setRenderTarget( hdr );
				renderer.render( bodyDebug.scene, camera );

			}

		}

		if ( probe && bodies.length && perf.craft ) {

			mark( 'craft', () => bodies.issueProbe( probe, params ) );

		}

		renderer.setRenderTarget( null );

		if ( post ) {

			const t0 = performance.now();
			const p = perf.post ? params
				: { ...params, bloomIntensity: 0, grain: 0, chromatic: 0, halation: 0 };
			post.render( hdr.texture, p, dt, time, output ? { output } : {} );
			perfTimes.stages.post = performance.now() - t0;
			perfTimes.ran.post = perf.post ? 1 : 0;

		}

		perfTimes.cpu = performance.now() - cpu0;
		const info = renderer.info?.render;
		// WebGPU's info.reset() clears drawCalls / frameCalls / triangles.
		// render.calls is lifetime and would climb into the hundreds of thousands.
		perfTimes.draws = info?.drawCalls ?? 0;
		perfTimes.passes = info?.frameCalls ?? 0;
		perfTimes.tris = info?.triangles ?? 0;
		let billed = 0;
		for ( const k of Object.keys( perfTimes.stages ) ) billed += perfTimes.stages[ k ] || 0;
		perfTimes.unaccounted = Math.max( 0, perfTimes.cpu - billed );
		pumpGpuTimers();
		onFrame?.();

	}

	const settle = ( ms ) => new Promise( ( r ) => setTimeout( r, ms ) );
	const measureFps = ( secs ) => new Promise( ( resolve ) => {

		let n = 0;
		const prev = onFrame;
		const t0 = performance.now();
		onFrame = () => { n ++; prev?.(); };
		setTimeout( () => {

			onFrame = prev;
			resolve( n / Math.max( ( performance.now() - t0 ) / 1000, 1e-3 ) );

		}, secs * 1000 );

	} );

	async function profile( onProgress ) {

		const stages = [
			{ name: 'sim', detail: 'FFT cascades + foam' },
			{ name: 'sea', detail: 'water mesh + shading' },
			{ name: 'sky', detail: 'dome + cloud march' },
			{ name: 'spray', detail: 'GPU particles' },
			{ name: 'dragon', detail: 'refraction of every under-water mesh' },
			{ name: 'craft', detail: 'scene beauty + wake + probe' },
			{ name: 'floor', detail: 'instanced rocks / coral' },
			{ name: 'post', detail: 'bloom + grain' },
		];
		const savedFlags = { ...perf };
		const savedAdapt = params.adaptiveQuality;
		const savedCap = params.fpsCap;
		const savedIdle = params.fpsCapIdle;
		params.adaptiveQuality = 0;
		params.fpsCap = 0;
		params.fpsCapIdle = 0;
		for ( const k of Object.keys( perf ) ) perf[ k ] = true;
		enableGpuTimers();

		const averageGpu = async ( samples = 6 ) => {

			const vals = [];
			for ( let i = 0; i < samples; i ++ ) {

				await settle( 50 );
				const g = await sampleGpu();
				if ( g && g.total > 0.01 ) vals.push( g.total );

			}
			if ( ! vals.length ) return null;
			return vals.reduce( ( a, b ) => a + b, 0 ) / vals.length;

		};

		onProgress?.( 'warming up…' );
		await settle( 900 );
		const gpuProbe = await averageGpu( 6 );
		const useGpu = gpuProbe != null;
		onProgress?.( useGpu ? 'ranking GPU…' : 'ranking by frame time…' );
		const fpsFull = await measureFps( useGpu ? 1.2 : 2 );
		const msFull = useGpu ? gpuProbe : 1000 / Math.max( fpsFull, 1e-6 );
		const rows = [];
		for ( const st of stages ) {

			onProgress?.( `measuring ${ st.name }…` );
			perf[ st.name ] = false;
			await settle( useGpu ? 350 : 400 );
			const ms = useGpu
				? await averageGpu( 6 )
				: 1000 / Math.max( await measureFps( 1.5 ), 1e-6 );
			perf[ st.name ] = true;
			const cost = ms == null ? 0 : msFull - ms;
			rows.push( {
				stage: st.name, detail: st.detail,
				ms: + Math.max( 0, cost ).toFixed( 2 ),
				share: + ( 100 * Math.max( 0, cost ) / Math.max( msFull, 1e-6 ) ).toFixed( 1 ),
			} );

		}

		onProgress?.( 'confirming…' );
		await settle( useGpu ? 350 : 400 );
		const fpsEnd = await measureFps( useGpu ? 1 : 1.2 );
		const drift = Math.abs( fpsEnd - fpsFull ) / Math.max( fpsFull, 1e-6 );
		Object.assign( perf, savedFlags );
		params.adaptiveQuality = savedAdapt;
		params.fpsCap = savedCap;
		params.fpsCapIdle = savedIdle;
		rows.sort( ( a, b ) => b.ms - a.ms );
		lastProfile = {
			fps: + fpsFull.toFixed( 1 ),
			frameMs: + ( useGpu ? gpuProbe : msFull ).toFixed( 1 ),
			backend: isWebGPU ? 'webgpu' : 'webgl',
			byGpu: useGpu,
			trustworthy: drift < 0.25,
			driftPct: + ( drift * 100 ).toFixed( 0 ),
			at: performance.now(),
			unaccounted: + ( msFull - rows.reduce( ( a, r ) => a + Math.max( 0, r.ms ), 0 ) ).toFixed( 2 ),
			stages: rows,
		};
		return lastProfile;

	}

	api = {
		renderer,
		backend: isWebGPU ? 'webgpu' : 'webgl',
		fellBack: backend === 'auto' && ! isWebGPU,
		params, derived,
		sky, sim, water, spray, post, wake, probe, refraction, bodies,
		frame, profile,
		perf, perfTimes,
		enableGpuTimers,
		liveFpsCap: liveCap,
		get lastProfile() { return lastProfile; },
		get onFrame() { return onFrame; },
		set onFrame( fn ) { onFrame = fn; },
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
			wake?.dispose?.();
			probe?.dispose?.();
			refraction?.dispose?.();
			post?.dispose?.();
			sky?.dispose?.();
			bodyDebug?.dispose?.();
			leftoverBubbles?.dispose?.();

		},
	};

	return api;

}
