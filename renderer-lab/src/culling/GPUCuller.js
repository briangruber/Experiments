// GPU-driven frustum culling with indirect draw.
//
// The whole point of this file: the CPU never learns how many objects are
// visible. A compute pass tests every instance against the frustum, compacts
// the survivors into an index buffer, and writes the survivor count straight
// into the `instanceCount` field of a WebGPU indirect draw-argument buffer.
// The render pass then issues one `drawIndexedIndirect` that reads its own
// parameters from GPU memory. No readback, no stall, one draw call.
//
// This is the piece three.js does not ship. r185 has every primitive needed —
// `IndirectStorageBufferAttribute`, `geometry.setIndirect()`, and a backend
// that calls `drawIndexedIndirect` — but nothing that drives them, and
// `BatchedMesh` still culls in a JavaScript loop on the CPU.

import {
	IndirectStorageBufferAttribute,
	StorageBufferAttribute,
	Vector4,
	Matrix4,
} from 'three/webgpu';

import {
	Fn, If, storage, instanceIndex, atomicAdd, atomicStore, uniformArray, uint,
} from 'three/tsl';

// WebGPU indirect draw-argument layouts. Both put the instance count in slot 1,
// which is the only field the compute pass writes:
//
//   drawIndexedIndirect  [ indexCount,  instanceCount, firstIndex, baseVertex, firstInstance ]
//   drawIndirect         [ vertexCount, instanceCount, firstVertex, firstInstance ]
//
// Which one applies depends on whether the geometry has an index buffer —
// IcosahedronGeometry, for instance, does not.
const ARG_ELEMENT_COUNT = 0;
const ARG_INSTANCE_COUNT = 1;
const INDEXED_STRIDE = 5;
const NON_INDEXED_STRIDE = 4;

const _projScreen = /*@__PURE__*/ new Matrix4();

export class GPUCuller {

	/**
	 * @param {Renderer} renderer - A WebGPURenderer with a WebGPU backend.
	 * @param {Object} options
	 * @param {Float32Array} options.transforms - 4 floats per instance: xyz centre, w uniform scale.
	 * @param {Float32Array} options.colors - 3 floats per instance.
	 * @param {BufferGeometry} options.geometry - The geometry each instance draws.
	 */
	constructor( renderer, { transforms, colors, geometry } ) {

		this.renderer = renderer;
		this.count = transforms.length / 4;

		if ( geometry.boundingSphere === null ) geometry.computeBoundingSphere();
		this.boundingRadius = geometry.boundingSphere.radius;

		this.indexed = geometry.index !== null;

		const stride = this.indexed ? INDEXED_STRIDE : NON_INDEXED_STRIDE;
		const elementCount = this.indexed
			? geometry.index.count
			: geometry.attributes.position.count;

		// --- Buffers -------------------------------------------------------

		// Per-instance source data. Read by both the cull pass and the vertex
		// stage, never written, so a plain storage attribute is enough.
		this.transformAttr = new StorageBufferAttribute( transforms, 4 );
		this.colorAttr = new StorageBufferAttribute( colors, 3 );

		// Compaction target: visibleIndices[0..visibleCount) holds the source
		// indices of the instances that survived culling. Written by the cull
		// pass, read by the vertex stage.
		this.visibleAttr = new StorageBufferAttribute( new Uint32Array( this.count ), 1 );

		// The indirect draw arguments themselves. The element count is baked in
		// once; `instanceCount` is the only field the GPU rewrites per frame,
		// and the remaining offsets stay zero.
		const args = new Uint32Array( stride );
		args[ ARG_ELEMENT_COUNT ] = elementCount;
		args[ ARG_INSTANCE_COUNT ] = 0;
		this.drawArgsAttr = new IndirectStorageBufferAttribute( args, 1 );
		this.stride = stride;

		// --- Node handles --------------------------------------------------

		this.transformBuffer = storage( this.transformAttr, 'vec4', this.count ).toReadOnly();
		this.colorBuffer = storage( this.colorAttr, 'vec3', this.count ).toReadOnly();
		this.visibleBuffer = storage( this.visibleAttr, 'uint', this.count );
		this.visibleBufferRead = storage( this.visibleAttr, 'uint', this.count ).toReadOnly();

		// A binding is either atomic or it is not — WGSL types it as
		// `atomic<u32>` for the whole buffer. Both compute passes therefore
		// share this one atomic view; the render pass binds the same GPU
		// buffer through the INDIRECT usage flag instead of as a binding, so
		// there is no conflict.
		this.drawArgsBuffer = storage( this.drawArgsAttr, 'uint', stride ).toAtomic();

		// Six frustum planes in world space, as vec4(nx, ny, nz, d).
		this.planes = uniformArray( [
			new Vector4(), new Vector4(), new Vector4(),
			new Vector4(), new Vector4(), new Vector4(),
		], 'vec4' );

		this._buildPasses();

		this.lastVisibleCount = - 1;
		this._readbackPending = false;

	}

	_buildPasses() {

		// Pass 1 — clear the survivor count. One thread; `atomicStore` because
		// the binding is atomic-typed.
		this.resetPass = Fn( () => {

			atomicStore( this.drawArgsBuffer.element( ARG_INSTANCE_COUNT ), uint( 0 ) );

		} )().compute( 1 );

		// Pass 2 — cull and compact, one thread per instance.
		this.cullPass = Fn( () => {

			const transform = this.transformBuffer.element( instanceIndex );
			const centre = transform.xyz;
			const radius = transform.w.mul( this.boundingRadius );

			// Sphere-vs-frustum. Unrolled in JS: six inline plane tests beat a
			// dynamic loop over a uniform array, and the compiler sees them all.
			const visible = uint( 1 ).toVar();

			for ( let i = 0; i < 6; i ++ ) {

				const plane = this.planes.element( i );
				const distance = plane.xyz.dot( centre ).add( plane.w );

				If( distance.lessThan( radius.negate() ), () => {

					visible.assign( uint( 0 ) );

				} );

			}

			If( visible.equal( uint( 1 ) ), () => {

				// atomicAdd returns the pre-increment value, which is exactly
				// this instance's slot in the compacted array. This single
				// instruction is what replaces the CPU-side visibility loop.
				const slot = atomicAdd( this.drawArgsBuffer.element( ARG_INSTANCE_COUNT ), uint( 1 ) );
				this.visibleBuffer.element( slot ).assign( instanceIndex );

			} );

		} )().compute( this.count );

	}

	/**
	 * Extracts the six world-space frustum planes from the camera and uploads
	 * them. Normalised so plane distances are metric, which lets the shader
	 * compare against a real radius.
	 */
	updateFrustum( camera ) {

		camera.updateMatrixWorld();
		_projScreen.multiplyMatrices( camera.projectionMatrix, camera.matrixWorldInverse );

		const m = _projScreen.elements;

		// Gribb–Hartmann plane extraction. three.js stores matrices column-major,
		// so row i is elements[i], [i+4], [i+8], [i+12].
		//
		// The near plane is convention-dependent and this is easy to get wrong:
		// OpenGL clip space puts near at z = -w, giving `row3 + row2`, but WebGPU
		// (like D3D and Metal) puts near at z = 0, so the near plane is `row2`
		// alone. WebGPURenderer produces WebGPU-convention projection matrices,
		// so using the GL form here silently culls geometry near the camera.
		const rows = [
			[ m[ 3 ] + m[ 0 ], m[ 7 ] + m[ 4 ], m[ 11 ] + m[ 8 ], m[ 15 ] + m[ 12 ] ], // left
			[ m[ 3 ] - m[ 0 ], m[ 7 ] - m[ 4 ], m[ 11 ] - m[ 8 ], m[ 15 ] - m[ 12 ] ], // right
			[ m[ 3 ] + m[ 1 ], m[ 7 ] + m[ 5 ], m[ 11 ] + m[ 9 ], m[ 15 ] + m[ 13 ] ], // bottom
			[ m[ 3 ] - m[ 1 ], m[ 7 ] - m[ 5 ], m[ 11 ] - m[ 9 ], m[ 15 ] - m[ 13 ] ], // top
			[ m[ 2 ], m[ 6 ], m[ 10 ], m[ 14 ] ], // near (WebGPU zero-to-one depth)
			[ m[ 3 ] - m[ 2 ], m[ 7 ] - m[ 6 ], m[ 11 ] - m[ 10 ], m[ 15 ] - m[ 14 ] ], // far
		];

		for ( let i = 0; i < 6; i ++ ) {

			const [ x, y, z, w ] = rows[ i ];
			const length = Math.sqrt( x * x + y * y + z * z ) || 1;
			this.planes.array[ i ].set( x / length, y / length, z / length, w / length );

		}

		this.planes.needsUpdate = true;

	}

	/**
	 * Runs both compute passes. Must be called before the render pass that
	 * consumes the indirect buffer.
	 */
	async cull( camera ) {

		this.updateFrustum( camera );
		await this.renderer.computeAsync( [ this.resetPass, this.cullPass ] );

	}

	/**
	 * Reads the survivor count back for the HUD. Deliberately fire-and-forget
	 * and rate-limited: the render path never waits on this, because the whole
	 * point is that the CPU does not need to know the answer.
	 */
	pollVisibleCount() {

		if ( this._readbackPending ) return this.lastVisibleCount;

		this._readbackPending = true;

		this.renderer.getArrayBufferAsync( this.drawArgsAttr ).then( ( buffer ) => {

			this.lastVisibleCount = new Uint32Array( buffer )[ ARG_INSTANCE_COUNT ];
			this._readbackPending = false;

		} ).catch( () => {

			this._readbackPending = false;

		} );

		return this.lastVisibleCount;

	}

	/**
	 * Points a geometry at this culler's indirect buffer. After this the
	 * geometry's own draw range is ignored — the GPU supplies it.
	 */
	attachTo( geometry ) {

		geometry.setIndirect( this.drawArgsAttr );

	}

	dispose() {

		this.transformAttr.dispose?.();
		this.colorAttr.dispose?.();
		this.visibleAttr.dispose?.();
		this.drawArgsAttr.dispose?.();

	}

}
