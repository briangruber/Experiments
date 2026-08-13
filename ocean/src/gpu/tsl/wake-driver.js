// TslWake - the persistent wake field, driven the way src/wake.js drives it.
//
// Same shape as that class on purpose: `field`, `origin`, `extent`, `clear()`,
// `update(dt, p, wr)`, `uniforms(p, active)`. demo/waverunner.js and the water
// drivers both talk to it through that surface, so the two backends are
// interchangeable behind it.
//
// ---------------------------------------------------------------------------
// WHY A FRAGMENT PING-PONG AND NOT A COMPUTE PASS
//
// The same reason the ocean sim is one (./sim-driver.js note 2): TSL compute is
// not available on the WebGL2 backend, and this port's whole contract is that
// one source runs on both. Two RGBA-float targets, swapped each frame.
//
// The record must not be filtered across texels when it is REPROJECTED (a live
// record interpolated against a stale one is a wake that was never laid down),
// but wakeAt() DOES want smooth interpolation when it reads the field. Those
// are the same texture, so it is built LinearFilter to match src/wake.js, and
// the reprojection tap is kept exact by snapping the origin to the texel grid
// on the CPU - which is what `update` does below, exactly as the GL driver does.

import * as THREE from 'three/webgpu';

import {
	wakeUpdateFragment, wakePrevTexture,
	uWkOrigin, uWkPrevOrigin, uWkExtent, uWkPrevExtent, uWkDt, uWkLife,
	uWkA, uWkB, uWkFwd, uWkRight, uWkStir, uWkRate, uWkReach, uWkActive, uWkSize,
} from './wake.js';

export class TslWake {

	/**
	 * @param {THREE.WebGPURenderer} renderer - already init()ed.
	 * @param {object} [opts]
	 * @param {number} [opts.size] - field resolution (src/presets.js wakeTexSize).
	 */
	constructor( renderer, { size = 512 } = {} ) {

		this.renderer = renderer;
		this.size = size;

		const mk = () => {

			const t = new THREE.RenderTarget( size, size, {
				type: THREE.FloatType,
				format: THREE.RGBAFormat,
				// LinearFilter because wakeAt() interpolates when it reads; the
				// reprojection stays exact via the texel-snapped origin.
				minFilter: THREE.LinearFilter,
				magFilter: THREE.LinearFilter,
				wrapS: THREE.ClampToEdgeWrapping,
				wrapT: THREE.ClampToEdgeWrapping,
				depthBuffer: false,
				generateMipmaps: false,
			} );
			t.texture.name = 'abyssal.wake';
			return t;

		};

		this.rt = [ mk(), mk() ];
		this.src = 0;

		this.material = new THREE.NodeMaterial();
		this.material.name = 'abyssal.wake.update';
		this.material.fragmentNode = wakeUpdateFragment();
		this.material.depthTest = false;
		this.material.depthWrite = false;
		this.material.transparent = false;
		this.quad = new THREE.QuadMesh( this.material );

		this.origin = new Float32Array( [ 0, 0 ] );
		this.prevOrigin = new Float32Array( [ 0, 0 ] );
		this.extent = 320;
		this.prevExtent = 320;
		this.prevPos = null;
		this.rate = 0;

		this.clear();

	}

	/** The texture the water shaders sample. */
	get field() { return this.rt[ this.src ].texture; }

	clear() {

		const r = this.renderer;
		const prev = r.getRenderTarget();
		const prevAuto = r.autoClear;
		const prevColor = new THREE.Color();
		r.getClearColor( prevColor );
		const prevAlpha = r.getClearAlpha();

		r.setClearColor( 0x000000, 0 );
		for ( const t of this.rt ) {

			r.setRenderTarget( t );
			r.clear( true, false, false );

		}

		r.setRenderTarget( prev );
		r.setClearColor( prevColor, prevAlpha );
		r.autoClear = prevAuto;
		this.prevPos = null;

	}

	/**
	 * One frame of the record. Mirrors src/wake.js update() line for line,
	 * including the arithmetic that turns the rider's state into `stir`.
	 *
	 * @param {number} dt
	 * @param {object} p - the parameter set.
	 * @param {object} wr - the rider: { surfXZ(), speed, yawRate, slip, hullLoad,
	 *   impact, airborne, heading, active }.
	 */
	update( dt, p, wr ) {

		if ( dt <= 0 ) return;

		const r = this.renderer;
		this.extent = Math.max( p.wakeExtent, 40 );

		// Snapping the centre to the texel grid is what keeps the reprojection an
		// exact copy: an unsnapped buffer resamples itself every frame and the
		// whole record dissolves into mush in a couple of seconds.
		const texel = this.extent / this.size;

		// In the frame the ocean's displacement fields are indexed by, NOT world
		// space - a record stamped at the craft's world position lands a metre or
		// two off and slides as the waves pass, and a wake belongs to the water
		// rather than to the sea floor.
		const cxz = wr.surfXZ();
		this.prevOrigin[ 0 ] = this.origin[ 0 ];
		this.prevOrigin[ 1 ] = this.origin[ 1 ];
		this.origin[ 0 ] = Math.round( cxz[ 0 ] / texel ) * texel;
		this.origin[ 1 ] = Math.round( cxz[ 1 ] / texel ) * texel;

		const a = this.prevPos || [ cxz[ 0 ], cxz[ 1 ] ];
		const b = [ cxz[ 0 ], cxz[ 1 ] ];
		this.prevPos = b;

		const speedT = Math.min( Math.abs( wr.speed ) / Math.max( p.wrTopSpeed * 0.45, 1 ), 1 );
		// A hard carve is a large load that SHEDS speed, so anything driven off
		// speed alone gets a turn backwards. A hull in the air leaves nothing
		// behind it, which is what makes the gap in the wake read as a jump.
		const stir = wr.airborne ? 0 : Math.min(
			speedT * p.wrWakeSpeed
			+ Math.abs( wr.yawRate ) * p.wrWakeTurn
			+ wr.slip * p.wrWakeSlip
			+ ( wr.hullLoad ?? 0 ) * 0.035
			+ wr.impact * 1.2,
			1.4,
		);
		// A Kelvin wedge holds a fixed half-angle, so the arms leave the track at
		// a rate proportional to how fast the hull is laying it down. tan(19.47
		// degrees) is 0.3536.
		this.rate = 0.3536 * Math.abs( wr.speed ) * p.wakeArmRate;

		const fwd = [ Math.sin( wr.heading ), - Math.cos( wr.heading ) ];

		uWkOrigin.value.set( this.origin[ 0 ], this.origin[ 1 ] );
		uWkPrevOrigin.value.set( this.prevOrigin[ 0 ], this.prevOrigin[ 1 ] );
		uWkExtent.value = this.extent;
		uWkPrevExtent.value = this.prevExtent;
		uWkDt.value = Math.min( dt, 1 / 15 );
		uWkLife.value = p.wakeLife;
		uWkA.value.set( a[ 0 ], a[ 1 ] );
		uWkB.value.set( b[ 0 ], b[ 1 ] );
		uWkFwd.value.set( fwd[ 0 ], fwd[ 1 ] );
		uWkRight.value.set( - fwd[ 1 ], fwd[ 0 ] );
		uWkStir.value = stir;
		uWkRate.value = this.rate;
		// Reach far enough for the arms to have somewhere to go, and no further:
		// every extra metre is a wider swath of records a later lap can overwrite.
		uWkReach.value = Math.min( this.rate * p.wakeLife * 1.15 + 4, this.extent * 0.45 );
		uWkActive.value = wr.active ? 1 : 0;
		uWkSize.value = this.size;

		const dst = 1 - this.src;
		wakePrevTexture.value = this.rt[ this.src ].texture;

		const prev = r.getRenderTarget();
		const prevAuto = r.autoClear;
		r.autoClear = false;               // porting rule 15
		r.setRenderTarget( this.rt[ dst ] );
		this.quad.render( r );
		r.setRenderTarget( prev );
		r.autoClear = prevAuto;

		this.src = dst;
		this.prevExtent = this.extent;

	}

	/**
	 * Everything the water shaders need to reconstruct the pattern. Same keys
	 * src/wake.js returns, because ./water-common.js setWakeUniforms() reads
	 * them by name.
	 */
	uniforms( p, active ) {

		return {
			uWakeTex: this.field,
			uWakeOrigin: this.origin,
			uWakeExtent: this.extent,
			uWakeOn: active ? 1 : 0,
			uWakeLife: p.wakeLife,
			uWakeArmW: p.wakeWidth,
			uWakeArm: p.wakeArm,
			uWakeChurn: p.wakeCentre,
			uWakeSpread: p.wakeSpread,
			uWakeBeam: Math.max( p.wrBeam, 0.3 ) * 1.6,
			uWakeDepth: p.wakeDepth,
			uWakeStrength: p.wakeStrength,
		};

	}

	dispose() {

		this.rt.forEach( ( t ) => t.dispose() );
		this.material.dispose?.();

	}

}
