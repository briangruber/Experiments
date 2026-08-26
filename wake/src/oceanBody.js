// A thing in the water, and everything that follows from it being there.
//
// Until now the prototype had one boat, and its state, its attitude, its wake
// and its spray were spread across main.js as loose variables. That was fine
// while there was exactly one of it. This gathers them into an object that
// owns the whole chain — hull dimensions, how it sits, where it cuts, what it
// throws, what it leaves behind — so a second hull is another `new OceanBody`
// rather than a second copy of the render loop.
//
// The name is borrowed from the Abyssal package deliberately, and so is the
// shape of the idea: a mesh plus a recipe. What is NOT borrowed is the
// implementation. Abyssal's OceanBody carries its own trim curve, wake recipe
// and spray system, and adopting them would mean giving up the three-regime
// attitude model and the breaking-foam controls this prototype exists to
// explore. So: their name and their sea, our body.
//
// The physics lives in attitude.js and the wake in wakeField.js; this is the
// object that knows a hull has both, and the one place that knows WHERE on a
// hull the water is actually being cut.

import { get } from './params.js';
import { attitude } from './attitude.js';

/** Deterministic per-body noise. A shared Math.random makes captures unrepeatable. */
function rng( seed ) {

	let s = seed >>> 0 || 1;
	return () => {
		s ^= s << 13; s >>>= 0;
		s ^= s >> 17;
		s ^= s << 5; s >>>= 0;
		return s / 4294967296;
	};

}

export class OceanBody {

	/**
	 * @param {THREE.Object3D} mesh  drawn, and posed by this body each step
	 * @param {object} recipe        { spray } — sub-systems this hull owns
	 */
	constructor( mesh, { spray = null, seed = 1 } = {} ) {

		this.mesh = mesh;
		this.spray = spray;
		this.rand = rng( seed );

		// Position is the BOW. The spray arms are born there, so that is the
		// anchor everything else is measured from.
		this.state = { x: 0, z: 0, heading: 0, speed: 0, turn: 0, t: 0 };
		this.att = attitude( 0 );
		this._emitDebt = 0;

	}

	get length() { return get( 'boat.length' ); }
	get beam() { return get( 'boat.beam' ); }

	/** Unit vector along the heading, in world XZ. */
	forward( out = { x: 0, y: 0 } ) {

		out.x = Math.sin( this.state.heading );
		out.y = Math.cos( this.state.heading );
		return out;

	}

	/**
	 * Where the hull is actually cutting the water, as offsets from the bow.
	 *
	 * This is the bit worth getting right, because it is what makes spray look
	 * like it belongs to the boat. A hull does not throw water evenly along its
	 * length: it throws where the water is being turned aside, which is the
	 * forward chines, and as it climbs onto the plane the wetted length shortens
	 * so that release point walks AFT. That is the same shortening the trim
	 * model already computes — `att.wetStart` — so the two cannot disagree.
	 *
	 * Returns [{ along, lat, side }] in metres: `along` aft of the bow, `lat`
	 * outboard (signed), `side` the outward normal's sign.
	 */
	cuts( count = 4 ) {

		const L = this.length;
		const halfBeam = this.beam * 0.5;
		const start = Math.min( this.att.wetStart, L * 0.8 );
		const out = [];
		for ( let i = 0; i < count; i ++ ) {

			const t = count === 1 ? 0.35 : i / ( count - 1 );
			const along = start + ( L - start ) * t * 0.75;
			// Waterline half-width: fine at the entry, full amidships. Same
			// curve the wake field's hullHalf() uses, so spray leaves the hull
			// where the foam does rather than standing off it.
			const f = Math.pow( Math.min( along / Math.max( L, 0.1 ) / 0.55, 1 ), 0.62 );
			const lat = halfBeam * Math.max( f, 0.12 );
			out.push( { along, lat, side: 1 }, { along, lat: - lat, side: - 1 } );

		}
		return out;

	}

	/** Pose the mesh for this speed. Trim pivots near the aft quarter. */
	pose() {

		const att = this.att;
		const trim = att.trim * Math.PI / 180;
		// The model's origin is at the stem, so trimming about it would swing
		// the bow instead of lifting it. Compensating holds a pivot near the
		// aft quarter at the waterline, which is roughly where a planing hull
		// actually pivots.
		const PIVOT = 0.72;
		this.mesh.rotation.set( - trim, this.state.heading, 0, 'YXZ' );
		this.mesh.position.set( this.state.x,
			att.rise + Math.sin( trim ) * this.length * PIVOT, this.state.z );

	}

	/**
	 * Advance one step. `dt` seconds. The caller owns the helm and writes
	 * state.speed / state.turn before calling.
	 */
	step( dt, seaHeight = null ) {

		const s = this.state;
		s.t += dt;
		this.att = attitude( s.speed );
		this.pose();

		if ( this.spray ) this._throw( dt, seaHeight );

	}

	/** Emit spray along the waterline cuts, at a rate set by how hard we are cutting. */
	_throw( dt, seaHeight ) {

		const s = this.state;
		const on = get( 'spray.amount' );
		if ( on <= 0.001 ) return;

		// Below a walking pace a hull parts water rather than throwing it: there
		// is no sheet to break up, so there is nothing to emit. Ramped, because
		// a threshold makes the whole curtain switch on at one speed.
		const drive = Math.max( s.speed - get( 'spray.minSpeed' ), 0 );
		if ( drive <= 0.001 ) return;

		const cuts = this.cuts( Math.round( get( 'spray.sites' ) ) );
		// Rate is per second and dt-accumulated, so it does not become a
		// per-frame fountain that doubles on a 120 Hz display.
		this._emitDebt += get( 'spray.rate' ) * on * drive * dt;
		let budget = Math.min( Math.floor( this._emitDebt ), 240 );
		this._emitDebt -= budget;
		if ( budget <= 0 ) return;

		const fwd = this.forward();
		const nx = - fwd.y, nz = fwd.x;         // port-positive normal
		const outV = { x: 0, z: 0 };
		const trimY = this.att.rise;

		while ( budget -- > 0 ) {

			const c = cuts[ ( this.rand() * cuts.length ) | 0 ];
			const x = s.x - fwd.x * c.along + nx * c.lat;
			const z = s.z - fwd.y * c.along + nz * c.lat;
			const y = seaHeight ? seaHeight( x, z ) : 0;
			// Outward normal at this cut, tilted forward a little: water leaves
			// a chine mostly sideways, but it is also still going where the boat
			// was going.
			outV.x = nx * c.side; outV.z = nz * c.side;
			this.spray.emit( x, y + trimY * 0.35, z, outV,
				{ x: fwd.x, z: fwd.y }, s.speed, this.rand );

		}

	}

}
