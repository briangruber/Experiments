// Where is the water, right here? - the buoyancy probe, in TSL.
//
// Port of PROBE_FS in demo/waverunner.js. The craft needs the surface height at
// four points around its hull every frame, and the wave field lives in GPU
// textures, so the only honest answer involves a readback. A synchronous
// readPixels would stall the pipeline behind the whole ocean sim, so this
// renders the four answers into a tiny target and reads it back ASYNC: the
// rider gets last frame's answer, which at 60 Hz is 16 ms of lag on a hull that
// is already critically damped, and nobody can feel it.
//
// ---------------------------------------------------------------------------
// THE INVERSION IS THE WHOLE TRICK
//
// Displacement is Lagrangian: the texture says where the water at reference
// point x ended up, NOT what is above world point p. Asking "how high is the
// sea at p" therefore means inverting x -> x + D_xz(x), which is the fixed
// point x <- p - D_xz(x). Three passes is well inside a centimetre at any
// choppiness the sim allows. Skipping the inversion looks almost right in calm
// water and puts the craft through the face of every steep wave.
//
// The width is 64, not 4: a WebGPU buffer copy needs a 256-byte row pitch and
// four RGBA32F texels is 64 bytes (porting rule 10). Only the first four are
// read; the rest cost one wasted quad of fragments, once a frame.

import * as THREE from 'three/webgpu';
import {
	Fn, If, Loop, float, int, vec2, vec3, vec4, uniform, uniformArray,
	smoothstep, distance, uv,
} from 'three/tsl';

import {
	dispTexture, foamTexture, uPatch, uCascadeCount, uHeightScale, uHorizScale,
	wakeAt,
} from './water-common.js';
import { uSeaLevel } from './water-surface.js';


export const NPROBE = 4;

export const uProbePts = /*@__PURE__*/ uniformArray( [ 0, 0, 0, 0 ].map( () => new THREE.Vector2() ), 'vec2' );
export const uCraftXZ = /*@__PURE__*/ uniform( 'vec2' );
export const uWakeProbe = /*@__PURE__*/ uniform( 0.0 );
export const uWakeNear = /*@__PURE__*/ uniform( 6.0 );
export const uProbeWidth = /*@__PURE__*/ uniform( 64.0 );

/** vec4(height + seaLevel, foam, xShift, 1) at one probe point. */
export const surfaceAt = /*@__PURE__*/ Fn( ( [ p ] ) => {

	const x = vec2( p ).toVar();

	// x <- p - D_xz(x), three times. See the header: this is the Lagrangian
	// inversion, and it is not optional.
	Loop( { start: 0, end: 3, type: 'int', condition: '<' }, () => {

		const d = vec2( 0.0 ).toVar();
		Loop( { start: 0, end: uCascadeCount, type: 'int', condition: '<' }, ( { i } ) => {

			const s = dispTexture.sample( vec3( x.div( uPatch.element( i ) ), float( i ) ) ).level( 0 );
			d.addAssign( s.xz.mul( uHorizScale ) );

		} );
		x.assign( p.sub( d ) );

	} );

	const h = float( 0.0 ).toVar();
	const foam = float( 0.0 ).toVar();
	Loop( { start: 0, end: uCascadeCount, type: 'int', condition: '<' }, ( { i } ) => {

		const uvc = vec3( x.div( uPatch.element( i ) ), float( i ) );
		h.addAssign( dispTexture.sample( uvc ).level( 0 ).y.mul( uHeightScale ) );
		foam.addAssign( foamTexture.sample( uvc ).level( 0 ).x );

	} );

	// Everything the hull has already done to the sea - but only beyond a few
	// hull lengths. The stamp directly under the craft is the hollow it is
	// making right now, and reading that back would be a hull sinking into a
	// trough it deepens by sinking.
	If( uWakeProbe.greaterThan( 0.001 ), () => {

		const gate = smoothstep( uWakeNear, uWakeNear.mul( 2.4 ), distance( x, uCraftXZ ) ).toVar();
		If( gate.greaterThan( 0.001 ), () => {

			h.addAssign( wakeAt( x ).y.mul( gate ).mul( uWakeProbe ) );

		} );

	} );

	// GLSL: vec4(h + uSeaLevel, foam, x - p) - and `x - p` is a VEC2, so the
	// last TWO channels are the Lagrangian offset, not one of them and a pad.
	// Returning only dx and a 1.0 loses dz, which is half of the correction the
	// craft needs to write into fields the water indexes by x rather than p.
	return vec4( h.add( uSeaLevel ), foam, x.x.sub( p.x ), x.y.sub( p.y ) );

} );

export const probeFragment = /*@__PURE__*/ Fn( () => {

	// Which probe this fragment answers.
	//
	// uv(), NOT a screen-space coordinate. screenUV is derived from the VIEWPORT
	// resolution, and this pass renders a 64x1 target while the renderer's
	// viewport belongs to the canvas - so in the app (though not in an isolated
	// probe, where the two happen to match) the column index came out wrong and
	// every branch below fell through, leaving the whole reading at zero. The
	// craft then flew along at exactly sea level with no error anywhere.
	// uv() spans 0..1 across the quad whatever the target is. Same lesson as
	// ./wake.js note 1, arrived at the same way: by measuring.
	const col = uv().x.mul( uProbeWidth ).floor().toVar();
	const out = vec4( 0.0 ).toVar();
	// A switch over four constants rather than a dynamic index: uniformArray
	// indexing by a computed value is the kind of thing that differs between
	// backends, and four branches costs nothing in a 64x1 pass.
	for ( let i = 0; i < NPROBE; i ++ ) {

		If( col.equal( float( i ) ), () => {

			out.assign( surfaceAt( uProbePts.element( int( i ) ) ) );

		} );

	}

	return out;

} );

/**
 * Runs the probe and hands back the four surface samples.
 *
 * Async by design - see the header. The caller uses the last completed reading
 * and never awaits inside its frame.
 */
export class TslCraftProbe {

	constructor( renderer ) {

		this.renderer = renderer;
		this.width = 64;
		uProbeWidth.value = this.width;

		this.rt = new THREE.RenderTarget( this.width, 1, {
			type: THREE.FloatType, format: THREE.RGBAFormat,
			minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
			depthBuffer: false, generateMipmaps: false,
		} );

		this.material = new THREE.NodeMaterial();
		this.material.name = 'abyssal.craft.probe';
		this.material.fragmentNode = probeFragment();
		this.material.depthTest = false;
		this.material.depthWrite = false;
		this.quad = new THREE.QuadMesh( this.material );

		this.busy = false;
		// height, foam and the Lagrangian offset per probe - seeded flat so
		// frame 1 has an answer.
		this.result = Array.from( { length: NPROBE }, () => ( { h: 0, foam: 0, dx: 0, dz: 0 } ) );

	}

	/**
	 * @param {Array<[number,number]>} points - NPROBE world xz pairs.
	 * @param {object} o - { seaLevel, craftXZ:[x,z], wakeProbe, wakeNear }.
	 *
	 * seaLevel is passed rather than inherited. uSeaLevel belongs to
	 * ./water-surface.js and the water driver writes it every frame, so in the
	 * app it would already be right - but only if the water has run FIRST, and
	 * a probe that silently returns heights relative to zero when the call
	 * order changes is exactly the kind of bug that reads as a craft floating
	 * at the wrong altitude. Measured: on a flat sea at seaLevel 3.75 the probe
	 * returned 0.00000. Writing the same value from the same params costs
	 * nothing and removes the ordering dependency.
	 */
	async update( points, o = {} ) {

		if ( this.busy ) return this.result;
		this.busy = true;

		try {

			// _probePoints() hands back a FLAT Float32Array of xz pairs, which is
			// the contract the GL path has always used - not an array of [x, z].
			// Reading it as pairs-of-pairs silently indexes numbers, and
			// Vector2.set(undefined, undefined) is a NaN sample rather than an
			// error: measured as the four probes reporting duplicated heights,
			// which reads as a hull that pitches but will not roll. Both shapes
			// accepted, since a caller with real pairs is the obvious thing to
			// write.
			const flat = points && points.length === NPROBE * 2 && typeof points[ 0 ] === 'number';
			for ( let i = 0; i < NPROBE; i ++ ) {

				const x = flat ? points[ i * 2 ] : ( points?.[ i ]?.[ 0 ] ?? 0 );
				const z = flat ? points[ i * 2 + 1 ] : ( points?.[ i ]?.[ 1 ] ?? 0 );
				uProbePts.array[ i ].set( x, z );

			}
			if ( o.seaLevel !== undefined ) uSeaLevel.value = o.seaLevel;
			if ( o.craftXZ ) uCraftXZ.value.set( o.craftXZ[ 0 ], o.craftXZ[ 1 ] );
			uWakeProbe.value = o.wakeProbe ?? 0;
			uWakeNear.value = o.wakeNear ?? 6;

			const r = this.renderer;
			const prev = r.getRenderTarget();
			const prevAuto = r.autoClear;
			r.autoClear = false;
			r.setRenderTarget( this.rt );
			this.quad.render( r );
			r.setRenderTarget( prev );
			r.autoClear = prevAuto;

			const raw = await r.readRenderTargetPixelsAsync( this.rt, 0, 0, this.width, 1 );
			const px = raw instanceof Float32Array ? raw : new Float32Array( raw.buffer ?? raw );
			for ( let i = 0; i < NPROBE; i ++ ) {

				this.result[ i ] = {
					h: px[ i * 4 ], foam: px[ i * 4 + 1 ],
					dx: px[ i * 4 + 2 ], dz: px[ i * 4 + 3 ],
				};

			}

		} finally {

			this.busy = false;

		}

		return this.result;

	}

	dispose() {

		this.rt.dispose();
		this.material.dispose?.();

	}

}
