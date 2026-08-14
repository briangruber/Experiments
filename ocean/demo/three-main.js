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
import { texture, uv, vec4, float, shadow } from 'three/tsl';

import { TslOceanSim } from '../src/gpu/tsl/sim-driver.js';
import { TslSky } from '../src/gpu/tsl/sky-driver.js';
import { TslWater } from '../src/gpu/tsl/water-driver.js';
import { TslSpray } from '../src/gpu/tsl/spray-driver.js';
import { TslPost } from '../src/gpu/tsl/post-driver.js';

import { newParams, PRESETS, applyPreset } from '../src/presets.js';
import { CLOUD_TYPE_NAMES, applyCloudType } from '../src/cloud-types.js';
import { createDerived, derive } from '../src/derive.js';
import { Camera } from './camera.js';
import { installThreeCompat } from '../src/gpu/three-compat.js';
import { TslWake } from '../src/gpu/tsl/wake-driver.js';
import { TslCraftProbe } from '../src/gpu/tsl/craft-probe.js';
import {
	buildCraftGeometry, loadCraftTexture, setCraftTexture, craftFragment,
	craftVertex, uCraftWetLine, uPropAngle, uPropHub,
} from '../src/gpu/tsl/craft.js';
import {
	creatureVertex, creatureFragment, setCreatureTexture,
	uCreatureLen, uCreaturePhase, uCreatureWaves, uCreatureAmp,
	uCreatureSeaY, uCreatureFade, uCreatureOpacity,
} from '../src/gpu/tsl/creature.js';
import { WaveRunner } from './waverunner.js';
import { SeaPlane } from './seaplane.js';
import { SeaDragon } from './seadragon.js';
import { PLANE_MESH } from './planeModel.js';
import { DRAGON_MESH } from './dragonModel.js';
import {
	setCraftShadowNode, uSwellPos, uSwellDir, uSwellLen, uSwellRad, uSwellAmp,
} from '../src/gpu/tsl/water-surface.js';

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
const setA2 = ( a, x, y ) => { a[ 0 ] = x; a[ 1 ] = y; return a; };
const setA3 = ( a, x, y, z ) => { a[ 0 ] = x; a[ 1 ] = y; a[ 2 ] = z; return a; };

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

	// ---- THE CRAFT'S SHADOW, CAST BY THREE'S OWN SHADOW MAP -------------------
	//
	// What was here before was a proxy sphere tested along the sun: a soft round
	// blob whose only virtue was costing nothing. It read as a blob, because it
	// was one. This renders the hull's actual silhouette from the sun and lets the
	// sea sample it - three's standard mechanism, with three wrinkles the standard
	// mechanism does not cover, all worth spelling out.
	//
	// 1. receiveShadow ON THE WATER WOULD DO NOTHING. three's shadows arrive
	//    through setupLighting(), and setupLighting only runs for a material with
	//    no fragmentNode (three.webgpu.js:21294). The water HAS one - the entire
	//    ocean shader is a fragmentNode - so the light loop that would apply a
	//    shadow never runs on it. The shadow is therefore sampled by hand, which
	//    is exactly what shadow( light ) hands back: a node reading 1 in the light
	//    and 0 in shadow. ./gpu/tsl/water-surface.js multiplies the DIRECT-SUN
	//    term by it, so the sky ambient still reaches into the shadow, as it does
	//    in life.
	//
	// 2. THE SHADOW MAP RENDERS WHATEVER SCENE IT IS ASKED FROM, and the water is
	//    drawn from its own scene, which holds exactly one mesh: the sea. Left
	//    alone, the shadow pass would render the ocean casting on itself and the
	//    aircraft not at all. So the render is pointed at the craft's scene, where
	//    the casters live - patched on the instance, since three exports the
	//    shadow() factory but not the ShadowNode class.
	//
	// 3. IT HAS TO EXIST BEFORE THE WATER MATERIAL DOES. The node graph is built
	//    once; a shadow handed over afterwards would never appear in it (the same
	//    hazard as porting rule 11). Hence the light being created here, ahead of
	//    TslWater, and only wired into the craft's scene further down.
	renderer.shadowMap.enabled = true;
	renderer.shadowMap.type = THREE.PCFSoftShadowMap;
	const sunLight = new THREE.DirectionalLight( 0xffffff, 1 );
	sunLight.castShadow = true;
	sunLight.shadow.mapSize.set( 1024, 1024 );
	// Costs nothing when nobody is riding: the map is only re-rendered on frames
	// that actually have something in it (see aimSunLight).
	sunLight.shadow.autoUpdate = false;
	sunLight.shadow.bias = - 0.0006;
	sunLight.shadow.normalBias = 0.06;
	let shadowCasterScene = null;
	const craftShadow = shadow( sunLight );
	{

		const base = Object.getPrototypeOf( craftShadow ).renderShadow;
		craftShadow.renderShadow = function ( frame ) {

			const prev = frame.scene;
			if ( shadowCasterScene ) frame.scene = shadowCasterScene;
			try {

				base.call( this, frame );

			} finally {

				frame.scene = prev;

			}

		};

	}
	setCraftShadowNode( craftShadow );

	const water = new TslWater( renderer, params );
	water.setFields( { disp: sim.disp, slope: sim.slope, foam: sim.foamTex } );

	const spray = new TslSpray( renderer, { size: params.sprayTexSize } );

	// ---- the wave runner ----------------------------------------------------
	// Three pieces, each verified on its own: the wake field it leaves
	// (prototypes/wake-tsl.html), the hull mesh and its shading (craft-tsl.html)
	// and the buoyancy probe that tells it where the water is
	// (craft-probe-tsl.html). The rider physics is demo/waverunner.js, shared
	// verbatim with the WebGL2 demo - it takes gl = null here and is fed the
	// probe readings through acceptProbe() instead of running its own.
	const wake = new TslWake( renderer, { size: params.wakeTexSize } );
	const craftProbe = new TslCraftProbe( renderer );
	const rider = new WaveRunner( null, null, { canvas } );
	// The seaplane shares the rider's whole support system - probe, wake, spray,
	// camera locking - and can never be active at the same time.
	const plane = new SeaPlane( { canvas } );

	// Scratch, so the per-frame ctx does not allocate.
	//
	// Float32Array, NOT THREE.Vector3/Vector2. The drivers read these by INDEX -
	// ./gpu/tsl/spray.js does `cp[ 0 ], cp[ 1 ], cp[ 2 ]` - and a three vector
	// has .x/.y/.z with no numeric indices, so every craft uniform came out
	// undefined and then NaN. A NaN emitter emits nothing and reports nothing,
	// which is exactly what "it has no spray" looked like. The raw-GL demo uses
	// its set2/set3 helpers over Float32Arrays for the same reason.
	const vCraftPos = new Float32Array( 3 );
	const vCraftFwd = new Float32Array( 2 );
	const vCraftRight = new Float32Array( 2 );
	const vReflPos = new Float32Array( 3 );
	const hull = { pos: new Float32Array( 3 ), fwd: new Float32Array( 2 ), push: 0, plane: 0 };

	const craftMat = new THREE.NodeMaterial();
	craftMat.name = 'abyssal.craft';
	craftMat.fragmentNode = craftFragment();
	// The propeller lives in the vertex stage; craft.js explains why the normal
	// has to travel with it.
	craftMat.positionNode = craftVertex();
	craftMat.side = THREE.DoubleSide;      // the hull is not watertight everywhere
	const craftMesh = new THREE.Mesh( buildCraftGeometry( params.craftLength ).geometry, craftMat );
	craftMesh.frustumCulled = false;
	craftMesh.visible = false;
	const craftScene = new THREE.Scene();
	craftScene.add( craftMesh );
	// Two hulls, ONE material: the modes are mutually exclusive, so the shared
	// craft shader just gets the active hull's atlas pointed at it before its
	// draw. Both atlases are the same class of texture (sRGB, mipped, filtered),
	// so the swap never changes which sampling instruction the graph built
	// (porting rule 11).
	const planeBuild = buildCraftGeometry( params.spLength, PLANE_MESH );
	const planeMesh = new THREE.Mesh( planeBuild.geometry, craftMat );
	planeMesh.frustumCulled = false;
	planeMesh.visible = false;
	planeMesh.matrixAutoUpdate = false;
	craftScene.add( planeMesh );
	let skiTex = null, planeTex = null;
	loadCraftTexture( renderer ).then( ( t ) => { skiTex = t; setCraftTexture( t ); } );
	loadCraftTexture( renderer, PLANE_MESH ).then( ( t ) => { planeTex = t; } );

	// The casters, and the scene the shadow pass is redirected to (wrinkle 2).
	craftMesh.castShadow = true;
	planeMesh.castShadow = true;
	craftScene.add( sunLight );
	craftScene.add( sunLight.target );
	shadowCasterScene = craftScene;

	// ---- the sea dragon -------------------------------------------------------
	//
	// Its own scene and its own draw, between the sea and the craft. NO DEPTH
	// TEST and no depth write, because the sea is opaque and has already written
	// its own depth over every pixel the animal is behind - see the header of
	// ./gpu/tsl/creature.js for why this is a blend rather than a refraction, and
	// why front faces alone make an unsorted draw survivable.
	//
	// The order is what makes it read as UNDER the water: the sea is laid down
	// first, the dragon is blended into it by how deep it is, and the craft goes
	// over the top with a real depth test - so riding past it puts the hull in
	// front, as it should be.
	const dragon = new SeaDragon();
	let followDragon = false;
	let followYaw = 0;
	const dragonMat = new THREE.NodeMaterial();
	dragonMat.name = 'abyssal.dragon';
	dragonMat.fragmentNode = creatureFragment();
	dragonMat.positionNode = creatureVertex();
	dragonMat.side = THREE.FrontSide;
	dragonMat.transparent = true;
	dragonMat.depthTest = false;
	dragonMat.depthWrite = false;
	const dragonBuild = buildCraftGeometry( params.sdLength, DRAGON_MESH );
	const dragonMesh = new THREE.Mesh( dragonBuild.geometry, dragonMat );
	dragonMesh.frustumCulled = false;
	dragonMesh.matrixAutoUpdate = false;
	const dragonScene = new THREE.Scene();
	dragonScene.add( dragonMesh );
	loadCraftTexture( renderer, DRAGON_MESH ).then( ( t ) => setCreatureTexture( t ) );
	let dragonLen = params.sdLength;

	const drawDragon = () => {

		if ( params.sdEnabled < 0.5 ) return;
		// The mesh is built at a length; changing it is a rebuild, not a scale, so
		// that the swim's wavelength stays in the same units as the body.
		if ( Math.abs( params.sdLength - dragonLen ) > 0.01 ) {

			const b = buildCraftGeometry( params.sdLength, DRAGON_MESH );
			dragonMesh.geometry.dispose();
			dragonMesh.geometry = b.geometry;
			dragonLen = params.sdLength;

		}
		uCreatureLen.value = params.sdLength;
		uCreatureWaves.value = params.sdWaves;
		uCreatureAmp.value = params.sdAmp;
		uCreaturePhase.value = dragon.phase;
		uCreatureSeaY.value = params.sdSeaLevel;
		uCreatureFade.value = params.sdFade;
		uCreatureOpacity.value = params.sdOpacity;
		// modelYaw 0: tools/glb.mjs already put this asset's head on -Z.
		setCraftTransform(
			dragonMesh,
			[ dragon.pos[ 0 ], dragon.pos[ 1 ], dragon.pos[ 2 ] ],
			dragon.heading, dragon.pitch, dragon.roll, 1.0, 0,
		);
		renderer.render( dragonScene, cam3 );

	};

	// Aim the light down the sun at whatever is out there, and size its box to the
	// hull. A directional shadow is an ORTHOGRAPHIC box, and the box has to hold
	// both the caster and the patch of sea the shadow lands on - the same
	// silhouette twice, so it only needs the hull's width across the sun and
	// enough DEPTH to reach from the aircraft down to the water. Sea outside the
	// box reads as lit, which for an ocean is the right answer.
	const aimSunLight = () => {

		const veh = rider.active ? rider : ( plane.active ? plane : null );
		const on = veh !== null && drawCraftEnabled && params.craftShadow > 0.001;
		sunLight.shadow.needsUpdate = on;
		if ( ! on ) return;

		const s = derived.sunDir;
		const size = veh === plane
			? Math.max( params.spLength * params.spHalfSpan, 4 ) * 1.15
			: Math.max( params.craftLength, 2 ) * 0.9;
		// How far the light travels past the hull to reach the sea under it.
		// Clamped, because with the sun on the horizon that distance runs away and
		// an orthographic box that long has no depth precision left to give.
		const sea = veh.probeH?.[ 0 ] ?? 0;
		const drop = Math.min( Math.max( veh.pos[ 1 ] - sea, 0 ) / Math.max( s[ 1 ], 0.15 ), 400 );
		const back = 40;
		sunLight.position.set(
			veh.pos[ 0 ] + s[ 0 ] * back,
			veh.pos[ 1 ] + s[ 1 ] * back,
			veh.pos[ 2 ] + s[ 2 ] * back,
		);
		sunLight.target.position.set( veh.pos[ 0 ], veh.pos[ 1 ], veh.pos[ 2 ] );
		const c = sunLight.shadow.camera;
		c.left = - size; c.right = size; c.top = size; c.bottom = - size;
		c.near = 1; c.far = back + drop + size * 2;
		c.updateProjectionMatrix();
		sunLight.updateMatrixWorld( true );
		sunLight.target.updateMatrixWorld( true );

	};

	// Position the hull from the rider's state, by replicating demo/craft.js
	// setTransform() EXACTLY rather than by mapping it onto Euler angles.
	//
	// That mapping is what went wrong twice. The reference builds an orthonormal
	// basis into the matrix columns and applies the model's own yaw correction
	// INSIDE the craft frame, and its comment says why in as many words: folding
	// that correction into the craft's heading also rotates the roll axis, so a
	// 180-degree correction silently swaps port and starboard and the hull banks
	// the wrong way out of every turn. Euler angles cannot express "yaw the model
	// within its own frame, after the heading" without that hazard, so this does
	// not try - it computes the same sixteen floats.
	//
	// It also removes the convention guessing entirely: whether the bow is +Z or
	// -Z in the source asset stops being something to reason about, because the
	// arithmetic that has always aimed this model is the arithmetic being run.
	craftMesh.matrixAutoUpdate = false;
	const craftM = new THREE.Matrix4();
	const setCraftTransform = ( mesh, pos, yaw, pitch, roll, scale, modelYaw = 0 ) => {

		const cy = Math.cos( yaw ), sy = Math.sin( yaw );
		const cp = Math.cos( pitch ), sp = Math.sin( pitch );
		const cr = Math.cos( roll ), sr = Math.sin( roll );
		const f = [ cp * sy, sp, - cp * cy ];
		const r = [ cy, 0, sy ];
		let u = [ f[ 1 ] * r[ 2 ] - f[ 2 ] * r[ 1 ], f[ 2 ] * r[ 0 ] - f[ 0 ] * r[ 2 ], f[ 0 ] * r[ 1 ] - f[ 1 ] * r[ 0 ] ];
		u = [ - u[ 0 ], - u[ 1 ], - u[ 2 ] ];
		const r2 = r.map( ( v, i ) => v * cr + u[ i ] * sr );
		const u2 = u.map( ( v, i ) => v * cr - r[ i ] * sr );
		const b = [ - f[ 0 ], - f[ 1 ], - f[ 2 ] ];
		const cf = Math.cos( modelYaw ), sf = Math.sin( modelYaw );
		const rr = r2.map( ( v, i ) => v * cf - b[ i ] * sf );
		const bb = r2.map( ( v, i ) => v * sf + b[ i ] * cf );

		// THREE.Matrix4.set takes ROW-major arguments and stores column-major,
		// while the GLSL m[] above is written column-major - so the columns
		// (rr, u2, bb, pos) become the rows of this call.
		craftM.set(
			rr[ 0 ] * scale, u2[ 0 ] * scale, bb[ 0 ] * scale, pos[ 0 ],
			rr[ 1 ] * scale, u2[ 1 ] * scale, bb[ 1 ] * scale, pos[ 1 ],
			rr[ 2 ] * scale, u2[ 2 ] * scale, bb[ 2 ] * scale, pos[ 2 ],
			0, 0, 0, 1,
		);
		mesh.matrix.copy( craftM );
		mesh.matrixWorldNeedsUpdate = true;

	};

	// Flipped by api.profile()'s craft ablation; nothing else touches it.
	let drawCraftEnabled = true;

	// POSING IS SEPARATE FROM DRAWING, and the split is load-bearing. The craft is
	// drawn AFTER the water, but its shadow is cast DURING the water pass (the
	// shadow map renders when the water's node graph updates), so if the hull were
	// still posed inside the draw the sea would be shadowed by where the aircraft
	// was last frame. Pose early, draw late.
	const poseCraft = () => {

		if ( rider.active ) {

			// The waterline is the SEA, not the deck: using deckY put almost the
			// whole hull below it, which is what made the paint read as glass.
			uCraftWetLine.value = rider.probeH[ 0 ];
			if ( skiTex ) setCraftTexture( skiTex );
			setCraftTransform(
				craftMesh,
				[
					rider.pos[ 0 ],
					// The hull's designed waterline sits above its keel, so the origin
					// has to ride proud of the surface or the sea closes over the deck.
					( rider.deckY ?? 0 ) + params.craftLift,
					rider.pos[ 2 ],
				],
				rider.heading,
				rider.pitchTrim + params.craftPitchOffset,
				rider.bank + rider.rollTrim + params.craftRollOffset,
				params.craftScale,
				params.craftYawOffset,
			);
			craftMesh.visible = true;
			planeMesh.visible = false;

		} else if ( plane.active ) {

			// Airborne, the wet darkening must not climb the hull: pin the
			// waterline to the sea it left, and the paint dries as it climbs.
			uCraftWetLine.value = plane.airborne
				? plane.probeH[ 0 ] - 2.0
				: plane.probeH[ 0 ];
			if ( planeTex ) setCraftTexture( planeTex );
			uPropHub.value.set( planeBuild.hub[ 0 ], planeBuild.hub[ 1 ], planeBuild.hub[ 2 ] );
			// modelYaw 0: tools/glb.mjs already put this asset's nose on -Z.
			setCraftTransform(
				planeMesh,
				[ plane.pos[ 0 ], plane.pos[ 1 ], plane.pos[ 2 ] ],
				plane.heading,
				plane.pitch,
				plane.roll,
				params.spScale,
				0,
			);
			planeMesh.visible = true;
			craftMesh.visible = false;

		} else {

			craftMesh.visible = false;
			planeMesh.visible = false;

		}

		aimSunLight();

	};
	const drawCraft = () => {

		if ( ! drawCraftEnabled ) return;
		if ( ! craftMesh.visible && ! planeMesh.visible ) return;
		renderer.render( craftScene, cam3 );

	};
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
	let skyRecovered = false;
	let diagAt = 0;
	// Band-measure ANY texture through the diag quad: two 64-wide row averages
	// plus a non-finite count, read through the GPU path that has been reliable
	// on every platform. This is the instrument that lets a field note bisect
	// the post chain pass by pass - a NaN anywhere shows up here as nonfinite>0
	// where a black shows up as 0.000 bands.
	const measureTexture = async ( tex ) => {

		const prevTex = diagSrc.value;
		const prev = renderer.getRenderTarget();
		try {

			diagSrc.value = tex;
			renderer.setRenderTarget( diagRT );
			diagQuad.render( renderer );
			renderer.setRenderTarget( prev );
			const raw = await renderer.readRenderTargetPixelsAsync( diagRT, 0, 0, 64, 1 );
			const px = raw instanceof Float32Array ? raw : new Float32Array( raw.buffer ?? raw );
			let a = 0, b = 0, bad = 0;
			for ( let i = 0; i < 64; i ++ ) {

				const va = px[ i * 4 ], vb = px[ i * 4 + 1 ];
				if ( ! Number.isFinite( va ) || ! Number.isFinite( vb ) ) { bad ++; continue; }
				a += va; b += vb;

			}

			const n = 64 - bad;
			return { a: n ? a / n : 0, b: n ? b / n : 0, nonfinite: bad };

		} finally {

			diagSrc.value = prevTex;

		}

	};

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
			a /= 64; b /= 64;
			api.diag = { bandA: a, bandB: b, skyMode: sky.depthMode };

			// SELF-HEAL, AS A LADDER. One band with content and the other at EXACTLY
			// zero is not a dark sky - it is a pass that never rasterised. Measured on
			// an iPhone: 0.052 / 0.000, on Safari's WebGPU.
			//
			// Each rung gives up more to gain certainty, and each fires at most once -
			// flapping between draw orders would be worse than any of them:
			//
			//   behind -> first   maybe the far-plane depth test is what this
			//                     implementation refuses; drop it and draw the sky
			//                     before the sea.
			//   first  -> lut     the full background pass never rasterised in EITHER
			//                     order, which on Safari means its pipeline failed
			//                     validation silently. Swap in a pass built only from
			//                     parts this platform has proven: the sea visibly
			//                     reflects the baked LUT, so a fragment that only
			//                     fetches the LUT compiles where the cloud march may
			//                     not. Sky gradient and sun; no clouds, no stars.
			//
			// A rung is only climbed while the frame HAS content (a+b > 0.002): two
			// dark bands means nothing at all drew, and rearranging passes will not
			// fix a dead frame.
			if ( ( a === 0 || b === 0 ) && ( a + b ) > 0.002 ) {

				if ( sky.depthMode === 'behind' ) {

					sky.setDepthMode( 'first' );
					api.skyFallback = 'The depth-tested sky drew nothing here; drawing it first instead.';

				} else if ( sky.depthMode === 'first' && ! skyRecovered ) {

					skyRecovered = true;
					sky.setDepthMode( 'lut' );
					api.skyFallback = 'The full sky pass never rendered on this platform; '
						+ 'using the LUT-only sky (no clouds or stars).';

				}

			}

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

		// TWO KNOBS, AND THEY MULTIPLY - demo/main.js:43-45, which this had wrong.
		//
		// dprCap ceilings the device pixel ratio (a Retina panel at 2 is worth
		// paying for; a phone at 3 is not). renderScale then scales that, and is
		// what the quality controls actually move.
		//
		// The port collapsed the two into `min(devicePixelRatio, renderScale)`,
		// which is not a smaller version of the same thing - it is a different
		// formula that silently discards the cap and uses renderScale as the
		// ceiling. On a phone (dpr 3, mobile renderScale 0.65) it rendered at
		// 0.65x CSS pixels where the original renders at min(3, 1.75) * 0.65 =
		// 1.14x - barely a third of the pixels, upscaled to a 3x panel. Reported
		// from a phone as "grainy and not as high quality", which is exactly what
		// a 4.6x upscale looks like, film grain included: the grain is laid down
		// at render resolution, so every grain cell got magnified with it.
		const dpr = Math.min( window.devicePixelRatio || 1, Math.max( params.dprCap ?? 1.75, 0.5 ) );
		const scale = params.renderScale ?? 1;
		const w = Math.max( 8, Math.round( canvas.clientWidth * dpr * scale ) );
		const h = Math.max( 8, Math.round( canvas.clientHeight * dpr * scale ) );
		if ( canvas.width !== w || canvas.height !== h || ! hdr ) sizeTo( w, h );

	};
	resize();
	window.addEventListener( 'resize', resize );

	post.seedAdapt();

	const api = {};

	let last = performance.now();
	let time = 0;
	let propAngle = 0;
	let skyDirty = true;

	// ---- the frame-rate governor ---------------------------------------------
	//
	// PORTED FROM demo/main.js:378-425, WHICH THIS DEMO NEVER HAD.
	//
	// The raw-GL demo measures itself once a second and trims quality until it
	// reaches targetFps. The three port shipped without it, so a device sat at
	// whatever the fixed settings happened to cost with no way out but the
	// settings panel - reported as 19 fps on a phone. Every parameter it moves
	// already existed and was already tuned; only the loop was missing.
	//
	// Three levers, spent in the order a measured frame says they are worth.
	// PIXELS go first and furthest, because trimming them touches every stage at
	// once. The cloud march is next. The water grid is last, because it is the
	// only one that reallocates a buffer. Quality is given back in the reverse
	// order, cheapest first, so it returns without immediately spending the
	// headroom that allowed it.
	let qAccum = 0, qFrames = 0;

	// True when the frame rate is held down by the CAP rather than by the device.
	// Without this the controller reads "we have headroom" from a frame rate the
	// cap itself is setting, and climbs quality until it has spent exactly the
	// power the cap was meant to save.
	const cappedOut = ( fps ) => params.fpsCap > 0 && fps >= params.fpsCap * 0.92;

	function adaptQuality( dtRaw ) {

		if ( ! params.adaptiveQuality ) return;
		qAccum += dtRaw; qFrames ++;
		if ( qAccum < 1.0 ) return;
		const fps = qFrames / qAccum;
		qAccum = 0; qFrames = 0;
		api.adaptFps = fps;

		const lo = params.renderScaleMin, hi = params.renderScaleMax;
		if ( fps < params.targetFps * 0.9 ) {

			if ( params.renderScale > lo ) {

				params.renderScale = Math.max( lo, params.renderScale - 0.08 );

			} else if ( params.cloudStepScale > params.cloudStepMin ) {

				params.cloudStepScale = Math.max( params.cloudStepMin, params.cloudStepScale - 0.15 );

			} else if ( params.gridScale > params.gridScaleMin ) {

				params.gridScale = Math.max( params.gridScaleMin, params.gridScale - 0.12 );
				water.rebuildGrid( params );

			}

		} else if ( fps > params.targetFps * 1.25 && ! cappedOut( fps ) ) {

			if ( params.gridScale < 1 ) {

				params.gridScale = Math.min( 1, params.gridScale + 0.06 );
				water.rebuildGrid( params );

			} else if ( params.cloudStepScale < 1 ) {

				params.cloudStepScale = Math.min( 1, params.cloudStepScale + 0.08 );

			} else if ( params.renderScale < hi ) {

				params.renderScale = Math.min( hi, params.renderScale + 0.04 );

			}

		}

	}

	// The duty cycle. Uncapped, this runs at the display's refresh rate and the
	// governor above then raises quality until it is JUST missing the target, so
	// between them they consume every watt the device will give - right for a
	// benchmark, wrong for something you leave open on a phone. Capping has to
	// SKIP FRAMES rather than lower quality: quality knobs trade picture for
	// frame rate, and neither of those is what makes a device hot. Only doing
	// less work per second does.
	let lastPresent = 0;
	function shouldSkip( now ) {

		if ( params.fpsCap <= 0 ) return false;
		const cap = document.hasFocus() ? params.fpsCap : Math.min( params.fpsCap, params.fpsCapIdle );
		// A hair under the period: a cap equal to the refresh rate otherwise
		// lands just the wrong side of every other vsync and halves the rate.
		if ( now - lastPresent < 1000 / cap - 1.2 ) return true;
		lastPresent = now;
		return false;

	}

	function frame( now ) {

		if ( shouldSkip( now ) ) { requestAnimationFrame( frame ); return; }

		const dtRaw = ( now - last ) / 1000;
		const dt = Math.min( dtRaw, 0.1 );
		last = now;
		time += dt * ( params.timeScale ?? 1 );

		adaptQuality( dtRaw );
		resize();
		derive( params, derived );

		// The ocean first: the craft has to read the surface the sim just wrote.
		sim.update( dt, params );

		// THE RIDER RUNS BEFORE THE CAMERA, AND THE CAMERA IS LOCKED WHILE IT DOES.
		//
		// demo/main.js:440-450 is this order, and the port had inverted it. Two
		// separate faults came out of that, and both were reported as feel rather
		// than as bugs.
		//
		// camera.locked. rider.update() ends by DRIVING the camera - it writes pos,
		// yaw, pitch, roll and fov for the chase or deck rig. Camera.update() is the
		// free-flight controller, and it reads the same key set: while riding, W
		// also flew the camera forward, Space also lifted it, and Shift multiplied
		// the fly speed by SIX. Every frame the camera was thrown some metres off
		// the rig and the rider yanked it back, which is the "shaking violently,
		// sometimes above the water" - the altitude came from Space and from
		// camera.update()'s own `pos.y = max(pos.y, minAltitude)` clamp, which has
		// no business acting on a hull sitting at deck height. It also wrecked the
		// carve specifically, because Shift is the one key bound to both. locked is
		// exactly the flag camera.js provides for "something else is driving this";
		// it still builds the basis, it just stops fighting.
		//
		// The order. camera.update() derives fwd/right/up from yaw/pitch/roll, and
		// matrices() builds viewProj from those. Running both BEFORE the rider set
		// this frame's rig meant the whole frame - sea, sky, spray billboards - was
		// rasterised through last frame's camera while the craft was drawn at this
		// frame's position. At 15 m/s that is a hull sliding around inside its own
		// frame every time the rig moved.
		if ( rider.active ) rider.update( dt, params, camera.keys, camera );
		else if ( plane.active ) plane.update( dt, params, camera.keys, camera );

		// The propeller. Idle is a real idle - a running engine never stops the
		// disc - and the rate climbs with the lever, not with airspeed, because
		// that is what a throttle does. Wrapped so the angle never grows into the
		// range where a float's spacing exceeds a pixel of blade.
		if ( plane.active ) {

			propAngle = ( propAngle + ( params.spPropIdle
				+ ( params.spPropRpm - params.spPropIdle ) * plane.throttle ) * dt ) % ( Math.PI * 2 );
			uPropAngle.value = propAngle;

		}
		// The wake field is stamped before anything reads it, from the hull state
		// the update just produced. The plane hands over floatRig, whose `active`
		// means "the floats are working the water" - a flying hull must not go
		// on digging a hollow into the sea under its shadow.
		wake.update( dt, params, plane.active ? plane.floatRig : rider );

		camera.locked = rider.active || plane.active || followDragon;
		camera.update( dt, params );

		// Follow mode drives the camera the way the vehicles do, and for the same
		// reason: the rig has to be written AFTER camera.update() or it spends the
		// frame fighting the free-look controls.
		if ( followDragon && params.sdEnabled >= 0.5 ) {

			// Behind, above, and a little to the side - a quarter view, so the
			// mound over its back and its silhouette are both in the picture. The
			// camera lags the animal's heading rather than snapping to it, which
			// keeps a turn readable instead of whipping the frame round.
			const d = dragon;
			followYaw += Math.atan2(
				Math.sin( d.heading - followYaw ), Math.cos( d.heading - followYaw ),
			) * Math.min( 1, dt * 1.6 );
			const bx = Math.sin( followYaw ), bz = - Math.cos( followYaw );
			const rx = Math.cos( followYaw ), rz = Math.sin( followYaw );
			const back = Math.max( params.sdLength, 8 ) * 1.15;
			const side = Math.max( params.sdLength, 8 ) * 0.35;
			const tx = d.pos[ 0 ], tz = d.pos[ 2 ];
			camera.pos[ 0 ] = tx - bx * back + rx * side;
			camera.pos[ 1 ] = ( params.sdSeaLevel ?? 0 ) + params.sdFollowRise;
			camera.pos[ 2 ] = tz - bz * back + rz * side;
			const ax = tx - camera.pos[ 0 ];
			const ay = d.pos[ 1 ] * 0.5 - camera.pos[ 1 ];
			const az = tz - camera.pos[ 2 ];
			camera.yaw = Math.atan2( ax, - az );
			camera.pitch = Math.asin( ay / Math.max( Math.hypot( ax, ay, az ), 1e-3 ) );
			camera.roll = 0;

		}

		// The dragon swims after the vehicle has moved and after the camera has,
		// so it is chasing THIS frame's station rather than last frame's - a lag
		// that on a hard carve reads as the animal being yanked along behind you.
		if ( params.sdEnabled >= 0.5 ) {

			dragon.update( dt, params, rider.active ? rider : ( plane.active ? plane : null ), camera );

		}

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

		// Forward in the convention the whole renderer uses: heading 0 looks down
		// -Z, so forward is (sin, -cos). Whichever hull is out, the spray and the
		// water read it through the same ctx fields - the emitter does not care
		// whether the thing shedding water has a handlebar or a yoke.
		const veh = rider.active ? rider : ( plane.active ? plane : null );
		const cf = veh
			? [ Math.sin( veh.heading ), - Math.cos( veh.heading ) ]
			: [ 0, 1 ];
		// A flying plane sheds no spray; a taxiing one sheds it exactly like a
		// hull, because it is one.
		// HOW MUCH WATER IS BEING WORKED, not whether any is.
		//
		// This used to be a boolean - `airborne` inverted - so the hollow in the
		// sea and the whole plume switched on and off in a single frame at every
		// takeoff and touchdown, and the sea snapped with them. The seaplane now
		// reports a continuous `wetness` (see WHAT IS ACTUALLY TOUCHING THE WATER
		// in demo/seaplane.js), which also rises on its own when a wingtip cuts
		// in during a low bank - a case the boolean could not express at all,
		// because the aircraft is airborne the whole time.
		const wet = veh ? ( veh === plane ? plane.wetness : 1 ) : 0;
		// And WHERE it is being worked: the floats' waterline, or the wingtip
		// that is cutting - not the CG two metres above the sea, which is where
		// the plume used to start.
		const wetPos = veh === plane ? plane.contactPos : null;

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
			// THE CRAFT'S STATE. The spray emitter reads all of this - without it
			// the rooster tail, the wall of water off a carve and the impact burst
			// simply never emit, which is what "it lost the spray it used to have"
			// looks like from outside. Mirrors demo/main.js exactly.
			craftPos: setA3( vCraftPos,
				wet > 0.001 ? ( wetPos ? wetPos[ 0 ] : veh.pos[ 0 ] ) : 0,
				wet > 0.001 ? ( wetPos ? wetPos[ 1 ] : ( veh.deckY ?? 0 ) ) : - 1e4,
				wet > 0.001 ? ( wetPos ? wetPos[ 2 ] : veh.pos[ 2 ] ) : 0 ),
			craftFwd: setA2( vCraftFwd, cf[ 0 ], cf[ 1 ] ),
			craftRight: setA2( vCraftRight, - cf[ 1 ], cf[ 0 ] ),
			craftSpeed: wet > 0.001 ? Math.abs( veh.speed ) : 0,
			craftTurn: wet > 0.001 ? veh.yawRate : 0,
			// Scaled BY the wetness, not gated by it: the plume grows as the
			// floats settle in and thins as they leave, and a wingtip that is
			// barely touching throws barely any water.
			craftAmount: wet > 0.001 ? params.craftSprayAmount * wet : 0,
			craftLoad: wet > 0.001 ? ( veh.hullLoad ?? 0 ) * wet : 0,
			// The vehicle's inputs and attitude, which is what the spray emitter
			// needs to point the water anywhere sensible.
			craftSteer: wet > 0.001 ? veh.steerIn : 0,
			craftThrottle: wet > 0.001 ? ( veh.throttle ?? 0 ) : 0,
			craftSlip: wet > 0.001 ? ( veh.slipSigned ?? 0 ) : 0,
			// A cutting wingtip is a hull in the water even though the aircraft
			// is flying, so the emitter must not be told it is airborne.
			craftAir: veh && veh.airborne && wet <= 0.001 ? 1 : 0,
			craftImpact: veh ? veh.impact : 0,
			// THE CRAFT'S IMAGE IN THE SEA (src/shaders/water.js). Separate from
			// craftPos, which is parked at -1e4 whenever the hull is not working
			// the water - a flying seaplane still has a reflection, and parking
			// its reflection under the sea bed is not it.
			craftReflPos: veh
				? setA3( vReflPos, veh.pos[ 0 ], veh === plane ? veh.pos[ 1 ] : ( veh.deckY ?? 0 ), veh.pos[ 2 ] )
				: setA3( vReflPos, 0, - 1e4, 0 ),
			// Sized to the WINGSPAN, not the length: the wings are most of what a
			// sea looking up at an aircraft can see, and a proxy scaled to the
			// fuselage put a reflection in the water about a third the area of
			// the thing casting it.
			craftReflSize: veh === plane
				? params.spLength * params.spHalfSpan * 0.9
				: params.craftLength * 0.55,
			// Fades out as the craft climbs away: the proxy's angular size already
			// shrinks with distance, but a hull is also a poorer mirror subject the
			// further it is from the water it is reflecting in.
			// The shadow does NOT take the reflection's height fade: its penumbra
			// already widens with altitude, and fading it twice is exactly how the
			// reflection ended up invisible.
			craftShadow: veh ? params.craftShadow : 0,
			craftReflAmount: veh
				? params.craftReflect * ( 1 - Math.min( 1, Math.max( 0, ( veh.pos[ 1 ] - ( veh.probeH?.[ 0 ] ?? 0 ) ) / params.craftReflectFade ) ) )
				: 0,
		};

		// The hull's own hollow and bow wave, which the water VERTEX stage reads.
		// Stamped at surfXZ(), not pos: the water shaders index by the undisplaced
		// grid point, so a hollow written at the world position slides off the
		// craft as the waves pass under it.
		if ( wet > 0.001 ) {

			const s = veh.surfXZ();
			hull.pos[ 0 ] = s[ 0 ]; hull.pos[ 1 ] = veh.deckY ?? 0; hull.pos[ 2 ] = s[ 1 ];
			// The seaplane presses a SHALLOWER hollow than the ski, faded by how
			// deep its floats actually are. It ran at 1.6x the ski's and switched
			// on and off in a single frame; between them that is the sea heaving
			// under the aircraft. A wingtip cutting gets no hollow at all - it
			// throws spray, it does not displace the ocean.
			hull.push = veh === plane
				? params.hullPush * params.spHullPush * plane.contact
				: params.hullPush;
			// The hollow only exists once the hull is actually loading the water.
			hull.plane = Math.min( 1, 0.35 + 0.65 * Math.abs( veh.speed ) / Math.max( params.craftPlaneFull, 1 ) );

		} else {

			hull.pos[ 0 ] = 0; hull.pos[ 1 ] = - 1e4; hull.pos[ 2 ] = 0;
			hull.push = 0;
			hull.plane = 0;

		}
		hull.fwd[ 0 ] = cf[ 0 ]; hull.fwd[ 1 ] = cf[ 1 ];

		api.ctx = ctx;      // the rig the drivers got this frame; verification reads it
		cam3.position.set( camera.pos[ 0 ], camera.pos[ 1 ], camera.pos[ 2 ] );
		// THE ROLL, AND THE TEAR AT THE HORIZON.
		//
		// Object3D.lookAt() orients through the object's OWN `up`, and a fresh
		// camera's is (0,1,0) forever. So cam3 - which rasterises the sea, the hull
		// and the spray - had no roll, while the sky is drawn from ctx.invViewProj,
		// which camera.matrices() builds from camera.up AFTER camera.js has rolled
		// the basis. Level, the two agree and nothing shows. Bank into a turn and
		// the sky's horizon tilts while the sea's stays level, and the wedge
		// between them fills with the LUT's below-horizon hemisphere: a dark
		// triangle opening along the horizon on the inside of every turn, widest
		// where the bank is hardest. Reported as a tear between the sky and the
		// water when turning, which is exactly what it is - two cameras disagreeing
		// about which way is up.
		//
		// The spray had the same split: its billboards are built from ctx.camRight
		// and ctx.camUp, which are rolled, and then projected through cam3, which
		// was not.
		cam3.up.set( camera.up[ 0 ], camera.up[ 1 ], camera.up[ 2 ] );
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

		// The rider, the wake and the sim have already run this frame, above the
		// camera - see the note there. Only the particles are left, and they need
		// the ctx that the camera produced.
		spray.update( dt, params, ctx, sim );

		// The LUT is a function of sun/moon/eye height only, so it is re-baked when
		// one of those moves rather than every frame - it is 512x256 of scattering
		// integrals and by far the most expensive thing that does not have to be.
		if ( skyDirty ) {

			sky.updateLUT( params, derived.sunDir, Math.max( camera.pos[ 1 ], 1 ) );
			skyDirty = false;

		}

		// --- the frame -------------------------------------------------------
		// Pose before anything renders: the shadow map is rendered from inside the
		// WATER pass (that is when the water's node graph updates), so a hull posed
		// in drawCraft would shadow the sea from where it was last frame.
		poseCraft();

		// THE SEA OVER ITS BACK. A body this size shoulders the water aside, and
		// the lift dies off as it sounds - which is what turns "a picture under
		// the surface" into "something big is under there". Zeroed when there is
		// nothing to lift, so the sea's vertex stage skips the branch entirely.
		if ( params.sdEnabled >= 0.5 ) {

			const depth = Math.max( 0, params.sdSeaLevel - dragon.pos[ 1 ] );
			const shallow = Math.max( 0, Math.min( 1, 1 - depth / Math.max( params.sdSwellFade, 0.5 ) ) );
			uSwellPos.value.set( dragon.pos[ 0 ], dragon.pos[ 1 ], dragon.pos[ 2 ] );
			uSwellDir.value.set( Math.sin( dragon.heading ), - Math.cos( dragon.heading ) );
			uSwellLen.value = params.sdLength;
			uSwellRad.value = params.sdSwellRadius;
			uSwellAmp.value = params.sdSwell * shallow;

		} else {

			uSwellAmp.value = 0;

		}

		renderer.setRenderTarget( hdr );
		renderer.setClearColor( 0x000000, 1 );
		renderer.clear( true, true, false );

		// Sea first; the sky is then depth-tested against it and its cloud march -
		// the most expensive thing per pixel - never runs on a pixel the sea covers.
		// Unless the fast path produced no sky on this platform, in which case the
		// sky - full or LUT-only, whichever rung the ladder reached - goes first
		// with no depth test at all. This branch MUST cover every non-'behind'
		// mode: the first ladder build special-cased 'first' alone, so the 'lut'
		// rung drew its fullscreen quad AFTER the sea with the depth test off and
		// painted the LUT's dark below-horizon hemisphere over the ocean. Measured
		// on the reporting phone as "a sky comes in and the ocean becomes black".
		if ( sky.depthMode !== 'behind' ) {

			sky.drawBackground( params, ctx );
			water.render( params, ctx, sim, cam3, { wake: wake.uniforms( params, rider.active ), hull } );
			drawDragon();
			drawCraft();

		} else {

			water.render( params, ctx, sim, cam3, { wake: wake.uniforms( params, rider.active ), hull } );
			drawDragon();
			drawCraft();
			sky.drawBackground( params, ctx );

		}
		spray.draw( params, ctx, sim, cam3 );

		// THE PROBE RUNS AFTER THE WATER, and that is not an ordering nicety.
		// It samples the cascade displacement through the same uniforms the water
		// binds in its own render() - dispTexture, uPatch, uCascadeCount. Fired
		// before the water, it reads the placeholders and returns a dead flat sea:
		// measured as every probe height exactly 0 while the craft accelerated
		// normally, so the hull simply flew along at sea level. The reading is
		// consumed on the NEXT frame anyway (the readback is async), so there is
		// nothing to gain by asking earlier.
		//
		// Deliberately not awaited: the frame must never wait on a readback.
		if ( rider.active ) {

			craftProbe.update( rider.probePoints( params ), {
				seaLevel: params.seaLevel,
				// THE HULL MUST NOT READ BACK THE HOLE IT IS CURRENTLY DIGGING.
				//
				// surfaceAt() gates the wake it adds by distance from uCraftXZ, and
				// the port had both halves of that gate wrong: it centred it on the
				// world position instead of surfXZ() - the Lagrangian coordinate the
				// wake field is actually indexed by, one to two metres away and
				// swinging with the wave phase - and it shrank the exclusion radius
				// from 2.5 hull lengths to 1.5. Between them the craft was reading a
				// large part of its own live stamp: a hull that sinks into a trough
				// it deepens by sinking, then springs out of it. craft-probe.js says
				// in as many words why that must not happen. Reported as "WAY too
				// bouncy on the water". demo/waverunner.js:205-207 is the reference.
				craftXZ: rider.surfXZ(),
				wakeProbe: params.wakeProbe,
				wakeNear: Math.max( params.wrLength, 0.5 ) * 2.5,
				// The hull's waterline length - the scale the probe averages the
				// sea over. craft-probe.js: THE HULL READS A MIPPED SEA.
				footprint: veh === plane
					? Math.max( params.spLength * 0.5, 2 )
					: Math.max( params.wrLength, 0.5 ),
				// Buoyancy against the LOCAL water, fading out as the hull gets on
				// the plane. craft-probe.js: THE SEA IS TALLER THAN ITS AVERAGE.
				// At rest the craft floats on the crest that is actually under it;
				// at planing speed it skims the averaged sea. craftPlaneFull is the
				// speed the hull is considered fully planing at, the same knob the
				// water's hollow uses.
				chop: veh === plane
					? 1 - Math.min( 0.95, plane.va / Math.max( params.spTakeoff * 0.7, 1 ) )
					: 1 - Math.min( 0.9, Math.abs( rider.speed ) / Math.max( params.craftPlaneFull, 1 ) ),
			} ).then( ( rows ) => veh.acceptProbe( rows ) ).catch( () => {} );

		}

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
		// The camera the frame was actually rasterised through, which is not the
		// same object as `camera` and need not agree with it. Exposed because that
		// disagreement was the bug: verification that samples `camera` after the
		// frame sees the rig the rider left behind and reports everything fine.
		cam3,
		output,
		onFrame: null,
		rider, plane, dragon, wake, craftProbe, craftMesh, planeMesh, hull,
		// A FUNCTION, not a getter: the app object gets spread on its way to
		// window.abyssal, and a spread evaluates a getter ONCE - so the button
		// read "Follow" forever while the camera was demonstrably following.
		isFollowing: () => followDragon,
		// FOLLOW THE MONSTER. Not a vehicle - a camera mode. It exists so the
		// animal can be TUNED: every slider that shapes it (the mound over its
		// back, its depth, how it rises at speed) is meaningless to adjust while
		// it swims out of frame, and chasing a twenty-metre body on the free
		// camera by hand is most of a minute per change. Toggling it off hands
		// the camera straight back rather than snapping anywhere.
		toggleFollow: () => {

			followDragon = ! followDragon;
			document.body.classList.toggle( 'following', followDragon );
			return followDragon;

		},
		toggleRide: () => {

			rider.active = ! rider.active;
			if ( rider.active ) {

				// One hull at a time; stepping onto the ski steps out of the plane.
				plane.active = false;
				planeMesh.visible = false;
				rider.reset( camera );

			} else {

				craftMesh.visible = false;

			}

			document.body.classList.toggle( 'riding', rider.active );
			document.body.classList.toggle( 'flying', false );
			return rider.active;

		},
		toggleFly: () => {

			plane.active = ! plane.active;
			if ( plane.active ) {

				rider.active = false;
				craftMesh.visible = false;
				plane.reset( camera );
				wake.clear?.();

			} else {

				planeMesh.visible = false;

			}

			document.body.classList.toggle( 'flying', plane.active );
			document.body.classList.toggle( 'riding', false );
			return plane.active;

		},
		markSkyDirty: () => { skyDirty = true; },

		// ---- what does a frame actually cost, HERE? ---------------------------
		//
		// Ported from demo/main.js's profileSim(). Measured by ABLATION: run
		// normally, then no-op one stage and run again. Everything else still
		// runs against the last fields that stage wrote, so the difference is
		// that stage and nothing else.
		//
		// This exists because the developer's rasteriser is not the reader's GPU,
		// and the two disagree about WHICH stages are expensive: a software
		// rasteriser is dominated by pass count and CPU work, a phone by fill
		// rate and blended overdraw. Ablating on the machine that is actually
		// slow is the only way to know - and a phone has no console, so the
		// result comes back as a value and the caller puts it on the screen.
		//
		// Only stages that can be removed WITHOUT changing what the others cost
		// belong here. The SEA is deliberately absent: it draws first and writes
		// depth, so removing it hands every one of its pixels to the cloud march
		// and the frame can get SLOWER.
		profile: async ( onProgress ) => {

			const saved = { cap: params.fpsCap, idle: params.fpsCapIdle, adapt: params.adaptiveQuality };
			// The cap cannot show a saving, and the governor would spend any
			// saving on quality instead of reporting it. Both off for the run.
			params.fpsCap = 0; params.fpsCapIdle = 0; params.adaptiveQuality = 0;

			const settle = ( ms ) => new Promise( ( r ) => setTimeout( r, ms ) );
			const measure = ( secs ) => new Promise( ( resolve ) => {

				let n = 0;
				const prev = api.onFrame;
				const t0 = performance.now();
				api.onFrame = () => { n ++; prev?.(); };
				setTimeout( () => {

					api.onFrame = prev;
					resolve( n / ( ( performance.now() - t0 ) / 1000 ) );

				}, secs * 1000 );

			} );

			const stages = [
				{ name: 'sim', detail: 'FFT cascades + foam',
					off: () => { const f = sim.update; sim.update = () => {}; return () => { sim.update = f; }; } },
				{ name: 'clouds', detail: `${ Math.round( params.cloudSteps ) } steps to 8`,
					off: () => { const v = params.cloudSteps; params.cloudSteps = 8; return () => { params.cloudSteps = v; }; } },
				{ name: 'spray', detail: 'GPU particles',
					off: () => { const f = spray.draw; spray.draw = () => {}; return () => { spray.draw = f; }; } },
				{ name: 'dragon', detail: 'the animal under the sea',
					off: () => { const v = params.sdEnabled; params.sdEnabled = 0; return () => { params.sdEnabled = v; }; } },
				{ name: 'post', detail: 'bloom + grain',
					off: () => {

						const f = post.render;
						post.render = ( tex, p, d, t, o ) => f.call( post, tex,
							{ ...p, bloomIntensity: 0, grain: 0, chromatic: 0, halation: 0 }, d, t, o );
						return () => { post.render = f; };

					} },
				{ name: 'craft', detail: 'hull + wake + probe',
					off: () => {

						const a = wake.update, b = craftProbe.update;
						wake.update = () => {};
						craftProbe.update = () => Promise.resolve( craftProbe.result );
						drawCraftEnabled = false;
						return () => { wake.update = a; craftProbe.update = b; drawCraftEnabled = true; };

					} },
			];

			// WARM UP FIRST, and bracket the run with a second baseline. Measured
			// while building this: a baseline taken six seconds after boot ran at
			// 0.37 fps against 2.5 fps warm, because ~90 pipelines were still
			// compiling - which made every single stage look like 84% of the
			// frame. If the two baselines disagree, the report says so rather
			// than quietly presenting warm-up as stage cost.
			onProgress?.( 'warming up…' );
			await settle( 2500 );
			const fpsFull = await measure( 4 );
			const msFull = 1000 / fpsFull;

			const rows = [];
			for ( const st of stages ) {

				onProgress?.( `measuring ${ st.name }…` );
				const undo = st.off();
				await settle( 700 );
				const ms = 1000 / await measure( 3 );
				undo();
				rows.push( { stage: st.name, detail: st.detail,
					ms: + ( msFull - ms ).toFixed( 2 ),
					share: + ( 100 * ( msFull - ms ) / msFull ).toFixed( 1 ) } );

			}

			onProgress?.( 'confirming…' );
			await settle( 700 );
			const fpsEnd = await measure( 3 );
			const drift = Math.abs( fpsEnd - fpsFull ) / Math.max( fpsFull, 1e-6 );

			params.fpsCap = saved.cap; params.fpsCapIdle = saved.idle;
			params.adaptiveQuality = saved.adapt;

			const c = renderer.domElement;
			const report = {
				fps: + fpsFull.toFixed( 1 ), frameMs: + msFull.toFixed( 1 ),
				resolution: `${ c.width }x${ c.height }`,
				backend, riding: rider.active, flying: plane.active,
				fft: params.fftSize, cloudSteps: Math.round( params.cloudSteps * ( params.cloudStepScale ?? 1 ) ),
				renderScale: + params.renderScale.toFixed( 2 ),
				stages: rows.slice().sort( ( a, b ) => b.ms - a.ms ),
				unaccounted: + ( msFull - rows.reduce( ( a, r ) => a + Math.max( 0, r.ms ), 0 ) ).toFixed( 2 ),
				driftPct: + ( drift * 100 ).toFixed( 0 ),
				trustworthy: drift < 0.15,
			};
			api.lastProfile = report;
			return report;

		},
		// The tonemapped frame, measured at the source. drawImage readback of a
		// presented canvas is a proven liar on macOS Chrome (the canvas-doctor
		// page showed every canvas cycling colors while every readback said
		// black, WebGL2 included), so the watchdog's real evidence comes from
		// here: render the post chain into a target and read THAT - the same
		// readRenderTargetPixelsAsync that reliably measures the HDR bands.
		// 64 texels x 16 bytes clears WebGPU's 256-byte row-pitch rule.
		measureTexture,
		measurePostOutput: async () => {

			const rt = new THREE.RenderTarget( 64, 32, {
				type: THREE.FloatType, format: THREE.RGBAFormat,
				minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false,
			} );
			try {

				post.render( hdr.texture, params, 0, time, { output: rt } );
				const raw = await renderer.readRenderTargetPixelsAsync( rt, 0, 0, 64, 32 );
				const px = raw instanceof Float32Array ? raw : new Float32Array( raw.buffer ?? raw );
				let a = 0, b = 0;
				for ( let x = 0; x < 64; x ++ ) {

					const top = ( 27 * 64 + x ) * 4, bot = ( 4 * 64 + x ) * 4;
					a += 0.2126 * px[ top ] + 0.7152 * px[ top + 1 ] + 0.0722 * px[ top + 2 ];
					b += 0.2126 * px[ bot ] + 0.7152 * px[ bot + 1 ] + 0.0722 * px[ bot + 2 ];

				}

				return { a: a / 64, b: b / 64 };

			} finally {

				rt.dispose();

			}

		},
		presets: Object.keys( PRESETS ),
		cloudTypes: CLOUD_TYPE_NAMES,
		applyPreset: ( name ) => {

			applyPreset( params, name );
			api.presetName = name;
			// The wave spectrum is preset-shaped too; without this the sea keeps the
			// old preset's waves under the new preset's light. (The raw-GL demo sets
			// ocean.dirty on every preset change; this port had lost that.)
			sim.dirty = true;
			skyDirty = true;
			// A preset carries its own sky, so switching presets ends a cloud
			// override - the dropdowns agree with what is on screen.
			api.cloudType = 'preset';

		},
		// A real cloud genus over the active preset (src/cloud-types.js), or
		// 'preset' to give the preset its sky back - which is a re-apply of the
		// preset's own cloud keys, not a no-op, so it really does undo.
		applyClouds: ( name ) => {

			if ( name === 'preset' ) {

				const base = newParams( api.presetName );
				for ( const k of Object.keys( base ) ) {

					if ( /^(cloud|cirrus)/.test( k ) ) params[ k ] = base[ k ];

				}

			} else {

				applyCloudType( params, name );

			}

			api.cloudType = name;
			skyDirty = true;

		},
		presetName: preset,
		cloudType: 'preset',
	} );
	onReady?.( api );
	return api;

}
