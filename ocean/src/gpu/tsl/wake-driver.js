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

// A new waterline crossing shifts the site list. Joining by index would
// draw a foam slash between unrelated fins; joining by proximity keeps
// each emitter's own trail, and a brand-new site stamps as a point.
function nearestStamp( pnt, prevs, max = 4 ) {

	let best = pnt, bestD = max;
	for ( const p of prevs ) {

		const d = Math.hypot( p[ 0 ] - pnt[ 0 ], p[ 1 ] - pnt[ 1 ] );
		if ( d < bestD ) { bestD = d; best = p; }

	}
	return best;

}

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
		this.prevStamps = [];
		this.rate = 0;
		this.head = [ 0, 0 ];
		this.fwd = [ 0, 1 ];
		this.speed = 0;

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
		this.prevStamps = [];

	}

	/**
	 * One frame of the record. Mirrors src/wake.js update() line for line,
	 * including the arithmetic that turns the rider's state into `stir`.
	 *
	 * @param {number} dt
	 * @param {object} p - the parameter set.
	 * @param {object} wr - the rider: { surfXZ(), speed, yawRate, slip, hullLoad,
	 *   impact, airborne, heading, active, stampA?, stampB?, stampPoints? }.
	 */
	update( dt, p, wr ) {

		if ( dt <= 0 ) return;

		this.extent = Math.max( p.wakeExtent, 40 );

		// Snapping the centre to the texel grid is what keeps the reprojection an
		// exact copy: an unsnapped buffer resamples itself every frame and the
		// whole record dissolves into mush in a couple of seconds.
		const texel = this.extent / this.size;

		// In the frame the ocean's displacement fields are indexed by, NOT world
		// space - a record stamped at the craft's world position lands a metre or
		// two off and slides as the waves pass, and a wake belongs to the water
		// rather than to the sea floor.
		this.prevOrigin[ 0 ] = this.origin[ 0 ];
		this.prevOrigin[ 1 ] = this.origin[ 1 ];
		// A dead source must not RECENTRE the window or rewrite prevPos. The
		// dragon used to hand the ski's surfXZ the moment it dipped, the
		// origin jumped, and every surviving record fell off the buffer -
		// reported as the trail vanishing instead of fading. Age in place
		// until something live starts laying a new track.
		const points = wr.active && wr.stampPoints?.length ? wr.stampPoints : null;
		let a = this.prevPos || [ this.origin[ 0 ], this.origin[ 1 ] ];
		let b = a;
		if ( wr.active ) {

			const cxz = wr.surfXZ();
			this.origin[ 0 ] = Math.round( cxz[ 0 ] / texel ) * texel;
			this.origin[ 1 ] = Math.round( cxz[ 1 ] / texel ) * texel;
			if ( ! points ) {

				b = wr.stampB || [ cxz[ 0 ], cxz[ 1 ] ];
				a = wr.stampA || this.prevPos || b;
				this.prevPos = b;
				this.prevStamps = [];

			}

		} else {

			this.prevStamps = [];

		}

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
		const reach = Math.min( this.rate * p.wakeLife * 1.15 + 4, this.extent * 0.45 );
		const stepDt = Math.min( dt, 1 / 15 );

		if ( points ) {

			// Age once, then stamp every spray site. Extra passes use dt=0 and
			// an identity reproject so the field is not aged N times or thrown
			// by a moving origin. Match last frame by proximity, not index:
			// a new fin crossing shifts the list and an index join would
			// slash foam across the body.
			const first = points[ 0 ];
			this._flush( {
				a: nearestStamp( first, this.prevStamps ), b: first, fwd, stir, reach,
				dt: stepDt, life: p.wakeLife, active: true,
			} );
			for ( let i = 1; i < points.length; i ++ ) {

				this.prevOrigin[ 0 ] = this.origin[ 0 ];
				this.prevOrigin[ 1 ] = this.origin[ 1 ];
				const pnt = points[ i ];
				this._flush( {
					a: nearestStamp( pnt, this.prevStamps ), b: pnt, fwd, stir, reach,
					dt: 0, life: p.wakeLife, active: true,
				} );

			}
			this.prevStamps = points.map( ( pnt ) => [ pnt[ 0 ], pnt[ 1 ] ] );
			this.prevPos = first;

		} else {

			this._flush( {
				a, b, fwd, stir, reach,
				dt: stepDt, life: p.wakeLife, active: !! wr.active,
			} );

		}

		this.prevExtent = this.extent;
		this.fwd = fwd;
		this.head = points && points[ 0 ]
			? [ points[ 0 ][ 0 ], points[ 0 ][ 1 ] ]
			: [ b[ 0 ], b[ 1 ] ];
		this.speed = wr.active && ! wr.airborne ? Math.abs( wr.speed ) : 0;

	}

	_flush( { a, b, fwd, stir, reach, dt, life, active } ) {

		const r = this.renderer;
		uWkOrigin.value.set( this.origin[ 0 ], this.origin[ 1 ] );
		uWkPrevOrigin.value.set( this.prevOrigin[ 0 ], this.prevOrigin[ 1 ] );
		uWkExtent.value = this.extent;
		uWkPrevExtent.value = this.prevExtent;
		uWkDt.value = dt;
		uWkLife.value = life;
		uWkA.value.set( a[ 0 ], a[ 1 ] );
		uWkB.value.set( b[ 0 ], b[ 1 ] );
		uWkFwd.value.set( fwd[ 0 ], fwd[ 1 ] );
		uWkRight.value.set( - fwd[ 1 ], fwd[ 0 ] );
		uWkStir.value = stir;
		uWkRate.value = this.rate;
		uWkReach.value = reach;
		uWkActive.value = active ? 1 : 0;
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

	}

	/**
	 * Everything the water shaders need to reconstruct the pattern. Same keys
	 * src/wake.js returns, because ./water-common.js setWakeUniforms() reads
	 * them by name.
	 */
	/**
	 * @param {object} p - parameter set. Pass the ACTIVE hull's remapped set
	 *   (demo/three-main.js's activeParams) so p.wrBeam resolves to the hull
	 *   actually laying the track - handed plain `params` while the boat was
	 *   out, the boat's wake rendered at the SKI's beam.
	 * @param {boolean} active - whether the water samples the field at all.
	 * @param {object} [dims] - per-source render overrides for a track laid by
	 *   something that is not the active wr-hull at all (the sea dragon):
	 *   { beam, armW, arm, depth, strength, churn, spread }. The FIELD is shared and so are these uniforms -
	 *   one track exists at a time, so whoever stamped it describes it.
	 */
	uniforms( p, active, dims ) {

		return {
			uWakeTex: this.field,
			uWakeOrigin: this.origin,
			uWakeHead: dims?.kelvinHead ?? this.head,
			uWakeFwd: dims?.kelvinFwd ?? this.fwd,
			uWakeSpeed: dims?.kelvinSpeed ?? this.speed,
			uWakeExtent: this.extent,
			uWakeOn: active ? 1 : 0,
			uWakeLife: p.wakeLife,
			uWakeArmW: dims?.armW ?? p.wakeWidth,
			uWakeEdge: dims?.edge ?? p.wakeEdgeFade ?? 0.12,
			uWakeArm: dims?.arm ?? p.wakeArm,
			uWakeChurn: dims?.churn ?? p.wakeCentre,
			uWakeSpread: dims?.spread ?? p.wakeSpread,
			uWakeBeam: dims?.beam ?? Math.max( p.wrBeam, 0.3 ) * 1.6,
			uWakeDepth: dims?.depth ?? p.wakeDepth,
			uWakeStrength: dims?.strength ?? p.wakeStrength,
			uKelvinOn: dims?.kelvinOn ?? 0,
			uKelvinAmp: dims?.kelvinAmp ?? 0,
			uKelvinWidth: dims?.kelvinWidth ?? 0,
			uKelvinDecay: dims?.kelvinDecay ?? 140,
			uKelvinFoam: dims?.kelvinFoam ?? 0,
			uKelvinLen: dims?.kelvinLen ?? p.sdLength ?? 60,
		};

	}

	dispose() {

		this.rt.forEach( ( t ) => t.dispose() );
		this.material.dispose?.();

	}

}
