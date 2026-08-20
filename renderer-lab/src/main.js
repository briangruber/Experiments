import {
	Scene,
	PerspectiveCamera,
	WebGPURenderer,
	DirectionalLight,
	HemisphereLight,
	Color,
	Fog,
	PostProcessing,
	Vector3,
} from 'three/webgpu';

import { pass, mrt, output, velocity } from 'three/tsl';
import { traa } from './../vendor/three/TRAANode.js';

import {
	generateInstances,
	createGeometry,
	buildMeshMode,
	buildInstancedMode,
	buildGPUMode,
} from './scene/stressScene.js';

import { createStaticVelocity } from './post/staticVelocity.js';
import { createHUD } from './ui/hud.js';

const canvas = document.getElementById( 'gl' );
const boot = document.getElementById( 'boot' );

const params = new URLSearchParams( location.search );
const INSTANCE_COUNT = Math.max( 1, + ( params.get( 'count' ) || 24000 ) );
const START_MODE = params.get( 'mode' ) || 'gpu';
const START_TRAA = params.get( 'traa' ) !== '0';

// --- Renderer ----------------------------------------------------------------

const renderer = new WebGPURenderer( { canvas, antialias: false, forceWebGL: false } );
renderer.setPixelRatio( Math.min( devicePixelRatio, 2 ) );
renderer.setSize( innerWidth, innerHeight );

const scene = new Scene();
scene.background = new Color( 0x0a0d14 );
scene.fog = new Fog( 0x0a0d14, 180, 620 );

const camera = new PerspectiveCamera( 60, innerWidth / innerHeight, 0.5, 900 );

const key = new DirectionalLight( 0xfff2e0, 2.4 );
key.position.set( 60, 90, 40 );
scene.add( key );
scene.add( new HemisphereLight( 0x8fb4ff, 0x1a1208, 1.1 ) );

// --- Scene modes -------------------------------------------------------------

const instances = generateInstances( INSTANCE_COUNT );
const geometry = createGeometry();

let active = null;
let activeMode = null;
let staticVelocity = null;

function buildMode( mode ) {

	if ( active ) {

		active.dispose();
		active = null;

	}

	if ( mode === 'meshes' ) {

		active = buildMeshMode( scene, geometry, instances );

	} else if ( mode === 'instanced' ) {

		active = buildInstancedMode( scene, geometry, instances );

	} else {

		active = buildGPUMode( scene, geometry, instances, renderer );

		// The GPU path needs motion vectors that match its shader-computed
		// world positions; see src/post/staticVelocity.js for why the built-in
		// velocity node cannot supply them.
		const worldPosition = active.root.material.positionNode;
		staticVelocity = createStaticVelocity( worldPosition );
		active.root.material.mrtNode = mrt( {
			output,
			velocity: staticVelocity.node,
		} );

	}

	if ( mode !== 'gpu' ) staticVelocity = null;

	activeMode = mode;

}

// --- Post processing ---------------------------------------------------------

const postProcessing = new PostProcessing( renderer );

const scenePass = pass( scene, camera );
scenePass.setMRT( mrt( { output, velocity } ) );

const beautyNode = scenePass.getTextureNode( 'output' );
const depthNode = scenePass.getTextureNode( 'depth' );
const velocityNode = scenePass.getTextureNode( 'velocity' );

const traaNode = traa( beautyNode, depthNode, velocityNode, camera );

let traaEnabled = START_TRAA;

function applyPostChain() {

	postProcessing.outputNode = traaEnabled ? traaNode : beautyNode;
	postProcessing.needsUpdate = true;

}

// --- Camera motion -----------------------------------------------------------

const _target = new Vector3( 0, 0, 0 );
let cameraTime = 0;
let cameraPaused = false;

function updateCamera( delta ) {

	if ( cameraPaused === false ) cameraTime += delta;

	// A slow orbit through the middle of the slab. The camera sits inside the
	// instance cloud, so the visible fraction swings widely and culling has
	// something real to do.
	const t = cameraTime * 0.12;
	camera.position.set(
		Math.cos( t ) * 150,
		Math.sin( t * 0.7 ) * 40 + 20,
		Math.sin( t ) * 150,
	);
	camera.lookAt( _target );
	camera.updateMatrixWorld();

}

// --- HUD ---------------------------------------------------------------------

const hud = createHUD( {
	initialMode: START_MODE,
	initialTRAA: START_TRAA,
	instanceCount: INSTANCE_COUNT,
	onMode: ( mode ) => {

		buildMode( mode );
		applyPostChain();

	},
	onTRAA: ( enabled ) => {

		traaEnabled = enabled;
		applyPostChain();

	},
	onPause: ( paused ) => {

		cameraPaused = paused;

	},
} );

// --- Loop --------------------------------------------------------------------

let lastTime = performance.now();
let frames = 0;
let framesInWindow = 0;
let fpsAccumulator = 0;
let fps = 0;
let cpuAccumulator = 0;
let cpuTime = 0;

// Exposed for the headless harness in tools/shot.mjs.
const report = {
	ready: false,
	errors: [],
	frames: 0,
	fps: 0,
	cpuMs: 0,
	drawCalls: 0,
	visible: - 1,
	mode: START_MODE,
	backend: 'unknown',
};
globalThis.__lab = report;

async function frame() {

	const now = performance.now();
	const delta = Math.min( ( now - lastTime ) / 1000, 0.1 );
	lastTime = now;

	updateCamera( delta );

	const cpuStart = performance.now();

	// The cull pass must run before the render pass that consumes its
	// indirect buffer.
	if ( active && active.prepare ) await active.prepare( camera );
	if ( staticVelocity ) staticVelocity.update( camera );

	await postProcessing.renderAsync();

	const cpuEnd = performance.now();

	// --- stats, averaged over a half-second window
	frames ++;
	framesInWindow ++;
	report.frames = frames;
	fpsAccumulator += delta;
	cpuAccumulator += cpuEnd - cpuStart;

	if ( fpsAccumulator >= 0.5 ) {

		fps = framesInWindow / fpsAccumulator;
		cpuTime = cpuAccumulator / framesInWindow;
		framesInWindow = 0;
		fpsAccumulator = 0;
		cpuAccumulator = 0;

	}

	report.fps = fps;
	report.cpuMs = cpuTime;
	report.drawCalls = renderer.info.render.drawCalls;
	report.mode = activeMode;
	report.visible = active && active.culler ? active.culler.pollVisibleCount() : - 1;

	hud.update( report );

	requestAnimationFrame( frame );

}

// --- Boot --------------------------------------------------------------------

addEventListener( 'resize', () => {

	camera.aspect = innerWidth / innerHeight;
	camera.updateProjectionMatrix();
	renderer.setSize( innerWidth, innerHeight );

} );

addEventListener( 'error', ( event ) => {

	report.errors.push( String( event.message || event.error ) );

} );

addEventListener( 'unhandledrejection', ( event ) => {

	report.errors.push( String( event.reason ) );

} );

try {

	await renderer.init();

	report.backend = renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl';

	if ( report.backend !== 'webgpu' ) {

		throw new Error(
			'This lab requires a WebGPU backend: indirect draw calls and storage-buffer ' +
			'atomics have no WebGL fallback.'
		);

	}

	buildMode( START_MODE );
	applyPostChain();

	boot.remove();
	report.ready = true;

	requestAnimationFrame( frame );

} catch ( error ) {

	report.errors.push( String( error && error.message || error ) );
	boot.textContent = String( error && error.message || error );
	boot.classList.add( 'boot-error' );
	throw error;

}
