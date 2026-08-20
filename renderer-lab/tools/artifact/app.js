// Entry point for the single-file artifact build.
//
// This is a thin shell only: every piece of rendering logic is imported from
// src/, so the artifact and the served prototype exercise the same code. What
// lives here is DOM wiring, the demo's controls, and the graceful failure path
// for browsers without WebGPU.

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
import { traa } from '../../vendor/three/TRAANode.js';

import {
	generateInstances,
	createGeometry,
	buildMeshMode,
	buildInstancedMode,
	buildGPUMode,
} from '../../src/scene/stressScene.js';

import { createStaticVelocity } from '../../src/post/staticVelocity.js';

const canvas = document.getElementById( 'stage' );
const status = document.getElementById( 'stage-status' );
const unsupported = document.getElementById( 'unsupported' );
const demo = document.getElementById( 'demo' );

const readout = {
	fps: document.getElementById( 'r-fps' ),
	cpu: document.getElementById( 'r-cpu' ),
	draws: document.getElementById( 'r-draws' ),
	drawn: document.getElementById( 'r-drawn' ),
};

let running = true;

const fail = ( message ) => {

	status?.remove();
	unsupported.hidden = false;
	document.getElementById( 'unsupported-reason' ).textContent = message;
	demo.dataset.state = 'failed';

};

if ( navigator.gpu === undefined ) {

	fail( 'This browser does not expose WebGPU (navigator.gpu is undefined).' );

} else {

	try {

		await start();

	} catch ( error ) {

		fail( String( error && error.message || error ) );

	}

}

async function start() {

	const renderer = new WebGPURenderer( { canvas, antialias: false } );
	await renderer.init();

	if ( renderer.backend.isWebGPUBackend !== true ) {

		throw new Error(
			'The renderer fell back to WebGL. This demo needs a WebGPU backend: indirect ' +
			'draw calls and storage-buffer atomics have no WebGL equivalent.'
		);

	}

	renderer.setPixelRatio( Math.min( devicePixelRatio, 1.5 ) );

	// A device can die after a successful init — notably when canvas
	// presentation is unavailable, which is how software WebGPU stacks tend to
	// fail. Without this the page just goes black and says nothing.
	renderer.backend.device?.lost.then( ( info ) => {

		running = false;
		fail( `The WebGPU device was lost: ${ info.message || 'no reason given' }` );

	} );

	const scene = new Scene();
	scene.background = new Color( 0x0e1218 );
	scene.fog = new Fog( 0x0e1218, 180, 620 );

	const camera = new PerspectiveCamera( 60, 16 / 9, 0.5, 900 );

	scene.add( new DirectionalLight( 0xfff2e0, 2.4 ).translateX( 60 ).translateY( 90 ).translateZ( 40 ) );
	scene.add( new HemisphereLight( 0x8fb4ff, 0x1a1208, 1.1 ) );

	// --- geometry and instance data, rebuilt when the count changes ---------

	const geometry = createGeometry();

	let instances = null;
	let active = null;
	let staticVelocity = null;
	let mode = 'gpu';
	let count = 12000;

	function build() {

		if ( active ) {

			active.dispose();
			active = null;

		}

		staticVelocity = null;

		if ( mode === 'meshes' ) {

			active = buildMeshMode( scene, geometry, instances );

		} else if ( mode === 'instanced' ) {

			active = buildInstancedMode( scene, geometry, instances );

		} else {

			active = buildGPUMode( scene, geometry, instances, renderer );

			// three's built-in velocity node reads positionLocal and the model
			// matrix, so it is wrong for geometry positioned in the shader.
			staticVelocity = createStaticVelocity( active.root.material.positionNode );
			active.root.material.mrtNode = mrt( { output, velocity: staticVelocity.node } );

		}

	}

	function regenerate() {

		instances = generateInstances( count );
		build();

	}

	regenerate();

	// --- post processing ---------------------------------------------------

	const postProcessing = new PostProcessing( renderer );
	const scenePass = pass( scene, camera );
	scenePass.setMRT( mrt( { output, velocity } ) );

	const beautyNode = scenePass.getTextureNode( 'output' );
	const traaNode = traa(
		beautyNode,
		scenePass.getTextureNode( 'depth' ),
		scenePass.getTextureNode( 'velocity' ),
		camera
	);

	let traaEnabled = true;

	const applyChain = () => {

		postProcessing.outputNode = traaEnabled ? traaNode : beautyNode;
		postProcessing.needsUpdate = true;

	};

	applyChain();

	// --- sizing ------------------------------------------------------------

	const resize = () => {

		const width = Math.max( 1, canvas.clientWidth );
		const height = Math.max( 1, canvas.clientHeight );
		camera.aspect = width / height;
		camera.updateProjectionMatrix();
		renderer.setSize( width, height, false );

	};

	new ResizeObserver( resize ).observe( canvas );
	resize();

	// --- controls ----------------------------------------------------------

	for ( const button of document.querySelectorAll( '[data-mode]' ) ) {

		button.addEventListener( 'click', () => {

			for ( const other of document.querySelectorAll( '[data-mode]' ) ) {

				other.setAttribute( 'aria-pressed', String( other === button ) );

			}

			mode = button.dataset.mode;
			build();
			applyChain();

		} );

	}

	for ( const button of document.querySelectorAll( '[data-count]' ) ) {

		button.addEventListener( 'click', () => {

			for ( const other of document.querySelectorAll( '[data-count]' ) ) {

				other.setAttribute( 'aria-pressed', String( other === button ) );

			}

			count = Number( button.dataset.count );
			regenerate();
			applyChain();

		} );

	}

	const traaToggle = document.getElementById( 'traa' );
	traaToggle.addEventListener( 'change', () => {

		traaEnabled = traaToggle.checked;
		applyChain();

	} );

	let paused = false;
	const pauseToggle = document.getElementById( 'pause' );
	pauseToggle.addEventListener( 'change', () => {

		paused = pauseToggle.checked;

	} );

	// Stop rendering while the demo is off screen — this page is long and
	// there is no reason to hold a GPU at full tilt while someone reads.
	let onScreen = true;
	new IntersectionObserver( ( entries ) => {

		onScreen = entries[ 0 ].isIntersecting;

	}, { threshold: 0.05 } ).observe( canvas );

	// --- loop --------------------------------------------------------------

	const origin = new Vector3( 0, 0, 0 );

	let cameraTime = 0;
	let last = performance.now();
	let framesInWindow = 0;
	let elapsed = 0;
	let cpuAccumulator = 0;
	let started = false;

	async function frame() {

		if ( running === false ) return;

		requestAnimationFrame( frame );

		if ( onScreen === false ) {

			last = performance.now();
			return;

		}

		const now = performance.now();
		const delta = Math.min( ( now - last ) / 1000, 0.1 );
		last = now;

		if ( paused === false ) cameraTime += delta;

		// A slow orbit through the middle of the instance slab, so the visible
		// fraction swings widely and culling has something real to do.
		const t = cameraTime * 0.12;
		camera.position.set( Math.cos( t ) * 150, Math.sin( t * 0.7 ) * 40 + 20, Math.sin( t ) * 150 );
		camera.lookAt( origin );
		camera.updateMatrixWorld();

		const cpuStart = performance.now();

		if ( active.prepare ) await active.prepare( camera );
		if ( staticVelocity ) staticVelocity.update( camera );

		await postProcessing.renderAsync();

		cpuAccumulator += performance.now() - cpuStart;

		if ( started === false ) {

			started = true;
			status?.remove();
			demo.dataset.state = 'running';

		}

		framesInWindow ++;
		elapsed += delta;

		if ( elapsed >= 0.5 ) {

			readout.fps.textContent = ( framesInWindow / elapsed ).toFixed( 0 );
			readout.cpu.textContent = ( cpuAccumulator / framesInWindow ).toFixed( 2 );
			readout.draws.textContent = renderer.info.render.drawCalls.toLocaleString();

			if ( active.culler ) {

				const visible = active.culler.pollVisibleCount();
				readout.drawn.textContent = visible >= 0 ? visible.toLocaleString() : '—';

			} else if ( mode === 'instanced' ) {

				readout.drawn.textContent = count.toLocaleString();

			} else {

				// One draw call per surviving object, so draw calls *are* the
				// visible count.
				readout.drawn.textContent = renderer.info.render.drawCalls.toLocaleString();

			}

			framesInWindow = 0;
			elapsed = 0;
			cpuAccumulator = 0;

		}

	}

	requestAnimationFrame( frame );

}
