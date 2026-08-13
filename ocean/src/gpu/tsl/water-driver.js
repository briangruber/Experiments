// The TSL water surface, driven. The node-graph counterpart of src/water.js: it
// owns the radial grid, the material, and the mesh, and exposes the same
// render(p, ctx, ocean, ...) shape so a caller can hold either behind one
// interface.
//
// Runs on WebGPU and on WebGL2 from one source. See docs/tsl-porting-rules.md.
//
// ---------------------------------------------------------------------------
// THREE THINGS THE GRID AND THE MESH HAVE TO GET RIGHT
//
// 1. THE GEOMETRY CARRIES A `position` ATTRIBUTE IT NEVER READS.
//
//    waterPosition() builds the world position from `aRT` alone and returns it
//    as positionNode, so `position` is genuinely unused. Three does not know
//    that: NodeMaterial initialises positionLocal from the `position` attribute
//    before positionNode overwrites it, and the reference is unconditional. On
//    WebGPU the pipeline's vertex buffer layout is assembled from the referenced
//    attributes, so a geometry carrying only `aRT` cannot be bound at all; on
//    WebGL2 location 0 would be an unbound attribute. Either way it is a hard
//    failure at first draw, not a wrong image - so the grid ships a zero-filled
//    `position` of the same vertex count.
//
// 2. matrixWorld STAYS AT IDENTITY AND THE MESH IS NEVER FRUSTUM CULLED.
//
//    positionNode returns a WORLD-space position, and Three then builds
//    modelViewProjection from it. That reproduces the GLSL's
//    `gl_Position = uViewProj * vec4(pos,1)` exactly only while modelMatrix is
//    identity, so matrixAutoUpdate is off and the matrix is left alone. The
//    grid's bounding box is meaningless (every vertex moves in the vertex
//    stage), so frustumCulled is off too or the sea disappears at some angles.
//
// 3. THE CASCADE FIELDS ARE DataArrayTextures WITH THE SIMULATION'S FILTERING.
//
//    Not cosmetic: WGSLNodeBuilder.isUnfilterable (three.webgpu.js:79067) picks
//    textureLoad() over textureSampleLevel() when min and mag are both
//    NearestFilter, and it decides at graph BUILD time from whatever is bound.
//    The slope field additionally MUST be mipped - sampleCascadeSurface reads
//    level 8 out of it for the variance the cascade fade discarded.

import * as THREE from 'three/webgpu';
import { vec4 } from 'three/tsl';

import {
	setCascadeTextures, setWakeTexture, setWaterCommonUniforms,
} from './water-common.js';
import { waterPosition, waterFragment, setWaterSurfaceUniforms } from './water-surface.js';
import { setWaterDetailUniforms } from './water-detail.js';
import { setWaterBrdfUniforms } from './water-brdf.js';
import { setAtmosphereUniforms } from './atmosphere.js';
import { setSkyLutUniforms, moonDirOf } from './sky-lut.js';
import { setCloudUniforms } from './cloud-field.js';

const NO_HULL = {
	pos: [ 0, 0, 0 ], fwd: [ 1, 0 ], push: 0, plane: 0,
};

/**
 * Build the radial fan grid as a BufferGeometry.
 *
 * Mirrors WaterSurface.buildGrid (src/water.js): R rings by A spokes, with the
 * ring index carried as aRT.x in 0..1 and the angle as aRT.y in 0..1. The vertex
 * stage maps aRT.x through an exponential so rings crowd near the eye.
 */
export function buildWaterGrid( p ) {

	const g = Math.min( Math.max( p.gridScale ?? 1, 0.25 ), 1 );
	const R = Math.max( 24, Math.round( p.gridRadial * g ) );
	const A = Math.max( 24, Math.round( p.gridAngular * g ) );

	const count = ( R + 1 ) * A;
	const rt = new Float32Array( count * 2 );
	let o = 0;
	for ( let i = 0; i <= R; i ++ ) {

		for ( let j = 0; j < A; j ++ ) {

			rt[ o ++ ] = i / R;
			rt[ o ++ ] = j / A;

		}

	}

	const idx = new Uint32Array( R * A * 6 );
	let k = 0;
	for ( let i = 0; i < R; i ++ ) {

		for ( let j = 0; j < A; j ++ ) {

			const j2 = ( j + 1 ) % A;
			const a = i * A + j, b = i * A + j2;
			const c = ( i + 1 ) * A + j, d = ( i + 1 ) * A + j2;
			idx[ k ++ ] = a; idx[ k ++ ] = c; idx[ k ++ ] = b;
			idx[ k ++ ] = b; idx[ k ++ ] = c; idx[ k ++ ] = d;

		}

	}

	const geo = new THREE.BufferGeometry();
	geo.setAttribute( 'aRT', new THREE.BufferAttribute( rt, 2 ) );
	// See note 1: unused by the shader, required by Three.
	geo.setAttribute( 'position', new THREE.BufferAttribute( new Float32Array( count * 3 ), 3 ) );
	geo.setIndex( new THREE.BufferAttribute( idx, 1 ) );
	// The bounding sphere would be computed from the flat `position` attribute,
	// which is all zeros. frustumCulled is off on the mesh, but set this anyway so
	// nothing else in three tries to reason about it.
	geo.boundingSphere = new THREE.Sphere( new THREE.Vector3(), Infinity );
	return { geo, R, A, count };

}

/**
 * Make a DataArrayTexture carrying one Float32Array per cascade layer, with the
 * simulation's filtering. See note 3.
 *
 * @param {Float32Array[]} layers - one N*N*4 array per cascade, layer 0 first.
 * @param {number} n - edge length.
 * @param {boolean} mips
 */
export function cascadeArrayTexture( layers, n, mips = true, aniso = 8 ) {

	const C = layers.length;
	const data = new Float32Array( n * n * 4 * C );
	for ( let c = 0; c < C; c ++ ) data.set( layers[ c ], c * n * n * 4 );

	const t = new THREE.DataArrayTexture( data, n, n, C );
	t.format = THREE.RGBAFormat;
	t.type = THREE.FloatType;
	t.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
	t.magFilter = THREE.LinearFilter;
	t.wrapS = t.wrapT = THREE.RepeatWrapping;
	t.generateMipmaps = mips;
	// src/ocean.js builds slope and foam with aniso 8. At grazing incidence - which
	// is most of a seascape - an isotropic mip fetch averages across the wrong
	// footprint and the filtered slope comes out different, so this is not a
	// quality knob here, it is part of matching the reference.
	t.anisotropy = aniso;
	t.needsUpdate = true;
	return t;

}

export class TslWater {

	/**
	 * @param {THREE.WebGPURenderer} renderer - already init()ed.
	 * @param {object} p - the params object (the grid size is read from it).
	 */
	constructor( renderer, p ) {

		this.renderer = renderer;

		const { geo, count } = buildWaterGrid( p );
		this.geometry = geo;
		this.vertexCount = count;

		this.material = new THREE.NodeMaterial();
		this.material.name = 'abyssal.water';
		this.material.positionNode = waterPosition();
		this.material.fragmentNode = vec4( waterFragment().xyz, 1.0 );
		this.material.depthTest = true;
		this.material.depthWrite = true;
		this.material.side = THREE.DoubleSide;   // src/water.js disables CULL_FACE
		this.material.transparent = false;

		this.mesh = new THREE.Mesh( this.geometry, this.material );
		// See note 2.
		this.mesh.matrixAutoUpdate = false;
		this.mesh.matrixWorld.identity();
		this.mesh.frustumCulled = false;

		this.scene = new THREE.Scene();
		this.scene.add( this.mesh );
		this._gridScale = Math.min( Math.max( p.gridScale ?? 1, 0.25 ), 1 );

	}

	/**
	 * Point the cascade samplers at fields already uploaded as DataArrayTextures.
	 * Separate from render() because a driver whose simulation is not three's owns
	 * the upload.
	 */
	setFields( { disp, slope, foam, wake } = {} ) {

		setCascadeTextures( { disp, slope, foam } );
		if ( wake !== undefined ) setWakeTexture( wake );

	}

	/**
	 * Draw the sea into whatever target is bound. Mirrors
	 * WaterSurface.render(p, ctx, ocean, sky, opts).
	 *
	 * @param {object} p
	 * @param {object} ctx - { camPos, viewProj, sunDir, moonDir, windVec3, time }
	 * @param {object} ocean - for patch sizes, fade distances and cascade count.
	 * @param {THREE.Camera} camera - must already carry ctx's view/projection.
	 * @param {object} [opts] - { hull, wake }
	 */
	render( p, ctx, ocean, camera, opts = {} ) {

		setAtmosphereUniforms( p );
		setSkyLutUniforms( p, ctx.sunDir, Math.max( ctx.camPos[ 1 ], 1 ),
			ctx.moonDir ?? moonDirOf( p ) );

		// THE SHARED PER-FRAME UNIFORMS. These live in ./cloud-field.js because the
		// cloud field was the first module to need them, but they are not the cloud's
		// - uCamPos is the eye, uTime is the clock and uWindDirV is the wind, and the
		// water stages read all three (the view vector for Fresnel and the BRDF, the
		// clock for capillaries and scintillation, the wind for the slope anisotropy).
		//
		// Setting them here is what makes TslWater.render self-sufficient. It was not,
		// and the failure was instructive: with the sky drawn first, setCloudUniforms
		// had already written them and the sea came out pixel-exact; drawing the sea
		// FIRST left uCamPos at its (0,0,0) default, so every view vector was computed
		// from the origin and the near sea came back 4.5x too bright. Correct in one
		// draw order and wrong in the other, with nothing raising a word.
		setCloudUniforms( p, ctx );

		setWaterCommonUniforms( p, ctx, ocean, opts.wake );
		setWaterBrdfUniforms( p );
		setWaterDetailUniforms( p );
		setWaterSurfaceUniforms( p, ctx, opts.hull || NO_HULL );

		this.renderer.render( this.scene, camera );

	}

	/**
	 * Rebuild the radial grid at the params' current gridScale.
	 *
	 * The frame-rate governor's third and last lever (demo/three-main.js). It is
	 * last because it is the only one that reallocates a buffer, so it is also
	 * the only one that must not be called for a change too small to matter -
	 * hence the epsilon. Returns true when it actually rebuilt.
	 */
	rebuildGrid( p ) {

		const g = Math.min( Math.max( p.gridScale ?? 1, 0.25 ), 1 );
		if ( Math.abs( g - this._gridScale ) < 0.02 ) return false;
		this._gridScale = g;

		const old = this.geometry;
		const { geo, count } = buildWaterGrid( p );
		this.geometry = geo;
		this.vertexCount = count;
		this.mesh.geometry = geo;
		old.dispose();
		return true;

	}

	dispose() {

		this.geometry.dispose();
		this.material.dispose();

	}

}
