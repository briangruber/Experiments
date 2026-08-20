// A scene deliberately built to make submission cost visible.
//
// The same N objects, the same transforms, the same shading — drawn three
// different ways so the cost of each submission strategy can be read straight
// off the HUD:
//
//   meshes    one Mesh per object. three.js frustum-culls each on the CPU and
//             issues one draw call per survivor. This is what a three.js scene
//             normally does, and it is the thing GPU-driven rendering replaces.
//   instanced one InstancedMesh, one draw call, no culling at all. Cheap on the
//             CPU, but every instance is vertex-shaded whether on screen or not.
//   gpu       one indirect draw call whose instance count is computed on the
//             GPU. One draw call *and* only the visible instances shaded.

import {
	Mesh,
	InstancedMesh,
	IcosahedronGeometry,
	MeshStandardNodeMaterial,
	Object3D,
	Color,
	DynamicDrawUsage,
} from 'three/webgpu';

import { Fn, positionLocal, instanceIndex } from 'three/tsl';

import { GPUCuller } from '../culling/GPUCuller.js';

const _dummy = /*@__PURE__*/ new Object3D();
const _colour = /*@__PURE__*/ new Color();

/**
 * Deterministic PRNG so every mode and every run sees an identical scene.
 * Without this the three modes are not comparable.
 */
function makeRandom( seed = 1337 ) {

	let state = seed >>> 0;

	return () => {

		state = ( state * 1664525 + 1013904223 ) >>> 0;
		return state / 4294967296;

	};

}

/**
 * Generates the instance data shared by all three modes.
 */
export function generateInstances( count, extent = 260, scale = 1 ) {

	const random = makeRandom();
	const transforms = new Float32Array( count * 4 );
	const colors = new Float32Array( count * 3 );

	for ( let i = 0; i < count; i ++ ) {

		// Distributed through a slab rather than a cube: the camera orbits
		// inside it, so a large and constantly changing fraction of the scene
		// is off-screen. A uniform cube viewed from outside would cull almost
		// nothing and hide the effect.
		transforms[ i * 4 + 0 ] = ( random() - 0.5 ) * extent * 2;
		transforms[ i * 4 + 1 ] = ( random() - 0.5 ) * extent * 0.35;
		transforms[ i * 4 + 2 ] = ( random() - 0.5 ) * extent * 2;
		transforms[ i * 4 + 3 ] = ( 0.5 + random() * 1.6 ) * scale;

		_colour.setHSL( 0.55 + random() * 0.22, 0.45 + random() * 0.3, 0.45 + random() * 0.2 );
		colors[ i * 3 + 0 ] = _colour.r;
		colors[ i * 3 + 1 ] = _colour.g;
		colors[ i * 3 + 2 ] = _colour.b;

	}

	return { transforms, colors, count };

}

export function createGeometry() {

	// Detail 2 gives ~320 triangles per object: heavy enough that culled
	// vertex work is measurable, light enough that fill rate is not the
	// bottleneck being measured.
	const geometry = new IcosahedronGeometry( 1, 2 );
	geometry.computeBoundingSphere();
	return geometry;

}

/**
 * Mode 1 — one Mesh per object, three.js CPU frustum culling, one draw call each.
 */
export function buildMeshMode( scene, geometry, instances ) {

	const { transforms, colors, count } = instances;
	const group = new Object3D();
	const meshes = [];

	for ( let i = 0; i < count; i ++ ) {

		const material = new MeshStandardNodeMaterial( { roughness: 0.55, metalness: 0.1 } );
		material.color.setRGB( colors[ i * 3 ], colors[ i * 3 + 1 ], colors[ i * 3 + 2 ] );

		const mesh = new Mesh( geometry, material );
		mesh.position.set( transforms[ i * 4 ], transforms[ i * 4 + 1 ], transforms[ i * 4 + 2 ] );
		mesh.scale.setScalar( transforms[ i * 4 + 3 ] );
		mesh.updateMatrix();
		mesh.matrixAutoUpdate = false;

		group.add( mesh );
		meshes.push( mesh );

	}

	scene.add( group );

	return {
		name: 'meshes',
		root: group,
		dispose() {

			for ( const mesh of meshes ) mesh.material.dispose();
			scene.remove( group );

		},
	};

}

/**
 * Mode 2 — a single InstancedMesh. One draw call, but no visibility test at all.
 */
export function buildInstancedMode( scene, geometry, instances ) {

	const { transforms, colors, count } = instances;

	const material = new MeshStandardNodeMaterial( { roughness: 0.55, metalness: 0.1 } );
	const mesh = new InstancedMesh( geometry, material, count );
	mesh.instanceMatrix.setUsage( DynamicDrawUsage );
	mesh.frustumCulled = false;

	for ( let i = 0; i < count; i ++ ) {

		_dummy.position.set( transforms[ i * 4 ], transforms[ i * 4 + 1 ], transforms[ i * 4 + 2 ] );
		_dummy.scale.setScalar( transforms[ i * 4 + 3 ] );
		_dummy.updateMatrix();
		mesh.setMatrixAt( i, _dummy.matrix );
		mesh.setColorAt( i, _colour.setRGB( colors[ i * 3 ], colors[ i * 3 + 1 ], colors[ i * 3 + 2 ] ) );

	}

	mesh.instanceMatrix.needsUpdate = true;
	if ( mesh.instanceColor ) mesh.instanceColor.needsUpdate = true;

	scene.add( mesh );

	return {
		name: 'instanced',
		root: mesh,
		dispose() {

			scene.remove( mesh );
			material.dispose();
			mesh.dispose();

		},
	};

}

/**
 * Mode 3 — GPU-driven. One indirect draw call, instance count written by a
 * compute shader, vertex stage reading the compacted survivor list.
 */
export function buildGPUMode( scene, geometry, instances, renderer ) {

	const { transforms, colors, count } = instances;

	const culler = new GPUCuller( renderer, {
		transforms,
		colors,
		geometry,
	} );

	// The geometry is shared with the other modes, so give the indirect path
	// its own clone — `setIndirect` is a property of the geometry, and we do
	// not want mode 1 and 2 drawing indirectly by accident.
	const indirectGeometry = geometry.clone();
	culler.attachTo( indirectGeometry );

	const material = new MeshStandardNodeMaterial( { roughness: 0.55, metalness: 0.1 } );

	// `instanceIndex` here runs 0..instanceCount-1 where instanceCount came out
	// of the compute pass. Indirecting through the survivor list turns that
	// dense range back into the original sparse instance ids.
	material.positionNode = Fn( () => {

		const source = culler.visibleBufferRead.element( instanceIndex );
		const transform = culler.transformBuffer.element( source );
		return positionLocal.mul( transform.w ).add( transform.xyz );

	} )();

	material.colorNode = Fn( () => {

		const source = culler.visibleBufferRead.element( instanceIndex );
		return culler.colorBuffer.element( source );

	} )();

	const mesh = new Mesh( indirectGeometry, material );

	// Non-negotiable: the mesh's own transform must stay identity because
	// positionNode already produced world-space coordinates, and three must not
	// cull the object itself — its bounds no longer describe what it draws.
	mesh.frustumCulled = false;
	mesh.matrixAutoUpdate = false;

	scene.add( mesh );

	return {
		name: 'gpu',
		root: mesh,
		culler,
		async prepare( camera ) {

			await culler.cull( camera );

		},
		dispose() {

			scene.remove( mesh );
			material.dispose();
			indirectGeometry.dispose();
			culler.dispose();

		},
	};

}
