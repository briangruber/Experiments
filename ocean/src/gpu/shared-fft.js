// Workgroup-memory FFT for TslOceanSim on WebGPU.
//
// TSL cannot express var<workgroup>, so the live fragment FFT is 2 * log2(N)
// renderer.render() calls per cascade (64 at N=256, C=4). This copies the
// evolved ping textures into storage buffers, runs FFT_SHARED_WGSL (two
// dispatches per cascade), and copies the result back into ping — the same
// pair assemble already reads. WebGL2 keeps the fragment path.

import { butterflyData } from '../ocean.js';
import { fftSharedWgsl } from './kernels/fft.js';

const VEC4 = 16;

function gpuTextureOf( renderer, texture ) {

	const data = renderer.backend?.get?.( texture );
	return data?.texture ?? data?.gpuTexture ?? null;

}

export function canSharedFft( renderer, N ) {

	const backend = renderer?.backend;
	const device = backend?.isWebGPUBackend ? backend.device : null;
	if ( ! device || N > 512 ) return false;
	const cap = device.limits?.maxComputeWorkgroupStorageSize ?? 16384;
	return cap >= N * 32;

}

export class SharedFftCompute {

	constructor( device, { size, cascades } ) {

		this.device = device;
		this.N = size;
		this.C = cascades;
		this.stages = butterflyData( size ).stages;
		this._ubo = [];
		this._build();

	}

	_buf( elements ) {

		return this.device.createBuffer( {
			size: elements * VEC4,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
		} );

	}

	_build() {

		const d = this.device, N = this.N, C = this.C;
		const per = N * N * C;
		this.pingA = this._buf( per );
		this.pingB = this._buf( per );
		this.pongA = this._buf( per );
		this.pongB = this._buf( per );

		const bf = butterflyData( N );
		this.butterfly = d.createBuffer( {
			size: bf.data.byteLength,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
		} );
		d.queue.writeBuffer( this.butterfly, 0, bf.data );

		const mod = d.createShaderModule( { code: fftSharedWgsl( N ) } );
		this.pipeline = d.createComputePipeline( {
			layout: 'auto',
			compute: { module: mod, entryPoint: 'main' },
		} );
		this.layout = this.pipeline.getBindGroupLayout( 0 );

		this.bytesPerRow = N * VEC4;
		this.copyExtent = { width: N, height: N, depthOrArrayLayers: C };

	}

	_uniform( axis, layer ) {

		const f = new Float32Array( 8 );
		const u = new Uint32Array( f.buffer );
		f[ 0 ] = this.N;
		u[ 1 ] = this.stages;
		u[ 2 ] = 0;
		u[ 3 ] = axis;
		u[ 4 ] = layer;
		const buf = this.device.createBuffer( {
			size: 32,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		} );
		this.device.queue.writeBuffer( buf, 0, f );
		this._ubo.push( buf );
		return buf;

	}

	_bind( ubo, srcA, srcB, dstA, dstB ) {

		return this.device.createBindGroup( {
			layout: this.layout,
			entries: [ ubo, this.butterfly, srcA, srcB, dstA, dstB ].map( ( buffer, binding ) => ( {
				binding, resource: { buffer },
			} ) ),
		} );

	}

	_copyTexToBuf( enc, texture, buffer ) {

		enc.copyTextureToBuffer(
			{ texture, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } },
			{ buffer, offset: 0, bytesPerRow: this.bytesPerRow, rowsPerImage: this.N },
			this.copyExtent,
		);

	}

	_copyBufToTex( enc, buffer, texture ) {

		enc.copyBufferToTexture(
			{ buffer, offset: 0, bytesPerRow: this.bytesPerRow, rowsPerImage: this.N },
			{ texture, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } },
			this.copyExtent,
		);

	}

	/**
	 * Transform pingRT in place (frequency → spatial). Returns false if Three
	 * has not allocated the GPU textures yet — caller should use the fragment
	 * butterflies that frame.
	 */
	run( renderer, pingRT ) {

		const t0 = gpuTextureOf( renderer, pingRT.textures[ 0 ] );
		const t1 = gpuTextureOf( renderer, pingRT.textures[ 1 ] );
		if ( ! t0 || ! t1 ) return false;

		const enc = this.device.createCommandEncoder();
		this._copyTexToBuf( enc, t0, this.pingA );
		this._copyTexToBuf( enc, t1, this.pingB );

		const pass = enc.beginComputePass();
		pass.setPipeline( this.pipeline );
		for ( let c = 0; c < this.C; c ++ ) {

			pass.setBindGroup( 0, this._bind(
				this._uniform( 0, c ), this.pingA, this.pingB, this.pongA, this.pongB,
			) );
			pass.dispatchWorkgroups( this.N, 1, 1 );
			pass.setBindGroup( 0, this._bind(
				this._uniform( 1, c ), this.pongA, this.pongB, this.pingA, this.pingB,
			) );
			pass.dispatchWorkgroups( this.N, 1, 1 );

		}

		pass.end();
		this._copyBufToTex( enc, this.pingA, t0 );
		this._copyBufToTex( enc, this.pingB, t1 );
		this.device.queue.submit( [ enc.finish() ] );
		for ( const b of this._ubo ) b.destroy();
		this._ubo.length = 0;
		return true;

	}

	dispose() {

		for ( const b of [
			this.pingA, this.pingB, this.pongA, this.pongB, this.butterfly, ...this._ubo,
		] ) b?.destroy();
		this._ubo.length = 0;

	}

}
