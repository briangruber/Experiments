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
		// Roll has its own state: a hull has mass and the water damps it, so
		// the lean lags the wheel instead of tracking it. See rollTo().
		this.roll = 0;
		this.rollVel = 0;
		// What the sea is doing under the four corners, fed by the wave probe:
		// heave in metres, pitch and roll in radians. Zero until a probe reports.
		this.wave = { heave: 0, pitch: 0, roll: 0 };

	}

	// THE LENGTH THE HULL IS DRAWN AT, not the one the physics is tuned in.
	//
	// 'Model scale' multiplies the drawn hull and nothing else, so at 3.85 a
	// 9.9 m boat is drawn 38 m long while every geometric quantity here still
	// worked in 9.9. The pivot landed 3.2 m aft of the stem on a 38 m hull --
	// which is rotating about the bow, with thirty-five metres of stern swinging
	// round it -- and the spray cuts, the trim pivot and the wave pitch were all
	// scaled to a boat a quarter of the size of the one on screen.
	//
	// Everything on this class is geometry of the DRAWN hull, so it all follows
	// the drawn length. The hydrodynamics (planing speed, Froude number) stay on
	// boat.length, which is what they were tuned against.
	get length() { return get( 'boat.length' ) * Math.max( get( 'boat.modelScale' ), 0.05 ); }
	// The DRAWN beam, for the same reason as the drawn length above. Missing
	// this put the spray cuts at the unscaled half-beam while the hull was drawn
	// four times wider -- so on a big model the water left the boat from a line
	// down its centre instead of from its chines.
	get beam() { return get( 'boat.beam' ) * Math.max( get( 'boat.modelScale' ), 0.05 ); }

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

	/**
	 * How far the hull leans in a turn, in radians. Positive is into the turn.
	 *
	 * A planing hull banks INWARD, unlike a car and unlike a displacement boat
	 * heeling to wind. In a steady turn the water has to supply the centripetal
	 * force v*omega, and the hull leans until the normal from the deadrise
	 * points where that force is needed -- so the angle is atan(v*omega/g), the
	 * same coordinated-turn relation an aircraft flies.
	 *
	 * That makes it fall out of speed and rate together, which is what was
	 * asked for: a hard turn at a crawl barely leans, and the same wheel at
	 * planing speed lays it over.
	 */
	/**
	 * The lean the turn is ASKING for, before the hull's own inertia.
	 *
	 * This is a target, not the answer — see rollTo(), which is what the mesh
	 * actually uses.
	 */
	bank() {

		const s = this.state;
		const a = Math.abs( s.speed ) * s.turn;       // centripetal, signed by the turn
		const raw = Math.atan2( a, 9.81 );
		// A real hull runs out of lean: past a point the chine trips and it
		// slides instead. Capped, then scaled by the live knob.
		const cap = get( 'boat.bankMax' ) * Math.PI / 180;
		// Negated: the hull's forward axis is +Z, so a positive roll about it
		// lifts the side the turn is pulling TOWARD. A boat banks into the
		// turn, which is the other one -- the first version leaned outward,
		// like a car body rolling on its springs rather than a hull digging in.
		return - Math.max( - cap, Math.min( cap, raw ) ) * get( 'boat.bank' );

	}

	/**
	 * Where the hull actually turns about.
	 *
	 * The mesh's origin is at the STEM, so rotating it turns the whole boat
	 * about its bow and sweeps the stern through an arc -- which is why a
	 * stationary turn looked like the hull walking away from its own wake. A
	 * real hull making way turns about a point roughly a third of its length
	 * aft of the stem, and that point is what stays put.
	 *
	 * So the simulated position IS the pivot, and the bow is derived from it.
	 * boat.pivot at 0 restores the old stem-centred behaviour exactly.
	 */
	bowOffset() {

		return this.length * get( 'boat.pivot' );

	}

	/**
	 * The hull's four water-contact corners, world XZ, for the wave probe:
	 * [bow, stern, +lateral, -lateral]. Bow and stern set the pitch, the two
	 * beam points the roll, and all four average into the heave.
	 */
	corners() {

		const fwd = this.forward();
		const b = this.bow();
		const L = this.length;
		const half = this.beam * 0.5;
		const nx = - fwd.y, nz = fwd.x;
		const midX = b.x - fwd.x * L * 0.5, midZ = b.z - fwd.y * L * 0.5;
		return [
			[ b.x, b.z ],
			[ b.x - fwd.x * L, b.z - fwd.y * L ],
			[ midX + nx * half, midZ + nz * half ],
			[ midX - nx * half, midZ - nz * half ],
		];

	}

	/**
	 * Digest four probed heights into heave / pitch / roll.
	 *
	 * This is the bounding-box buoyancy: the hull is treated as a raft on the
	 * four corner heights. Pitch is the bow-stern difference over the length,
	 * roll the beam difference over the beam, heave the average — each an
	 * atan2, so a huge rogue reading tilts the hull to a sane angle instead of
	 * standing it on end. `amount` scales all three; the probe has already
	 * smoothed in time.
	 */
	applyWaves( h, amount = 1 ) {

		if ( ! h ) return;
		this.wave.heave = ( ( h[ 0 ] + h[ 1 ] + h[ 2 ] + h[ 3 ] ) / 4 ) * amount;
		this.wave.pitch = Math.atan2( h[ 0 ] - h[ 1 ], this.length ) * amount;
		this.wave.roll = Math.atan2( h[ 2 ] - h[ 3 ], this.beam ) * amount;

	}

	/**
	 * Where the stem actually is, in world XZ.
	 *
	 * Everything that means "the bow" has to agree on this. The wake field
	 * treats arc 0 as the stem and carves the hull's own footprint out of the
	 * foam from there, so anchoring the field at the pivot while DRAWING the
	 * hull ahead of it puts that carve astern of the real transom -- which
	 * shows as a hull-shaped hole in the foam just behind the boat.
	 */
	bow( out = { x: 0, z: 0 } ) {

		const fwd = this.forward();
		const ahead = this.bowOffset();
		out.x = this.state.x + fwd.x * ahead;
		out.z = this.state.z + fwd.y * ahead;
		return out;

	}

	/**
	 * Step the roll toward what the turn is asking for.
	 *
	 * The bank angle was being assigned straight from the instantaneous turn
	 * rate, so the hull snapped to full lean the frame the wheel moved and
	 * snapped flat again when it centred. A boat cannot do that: it has roll
	 * inertia and the water damps it, which together make a second-order
	 * system, not a value.
	 *
	 * So: a damped spring toward the target. omega is the natural frequency
	 * (a small planing hull rolls at somewhere around 1 Hz), zeta the damping
	 * ratio -- a little under 1, so it settles quickly with just a hint of
	 * overshoot as the hull rolls into the turn and catches itself. Critically
	 * damped exactly (zeta = 1) reads as smooth but lifeless; over 1 is mushy.
	 *
	 * Integrated semi-implicitly and with dt clamped, because a spring is the
	 * classic thing to explode on the first frame after a stall or a tab
	 * switch, and the boat rolling inside out is a memorable way to find out.
	 */
	rollTo( dt ) {

		const target = this.bank();
		const w = Math.max( get( 'boat.rollRate' ), 0.05 ) * Math.PI * 2;
		const zeta = Math.max( get( 'boat.rollDamp' ), 0.05 );
		const h = Math.min( dt, 1 / 30 );
		this.rollVel += ( - 2 * zeta * w * this.rollVel
			- w * w * ( this.roll - target ) ) * h;
		this.roll += this.rollVel * h;
		return this.roll;

	}

	/** Pose the mesh for this speed, heading and rate of turn. */
	/**
	 * How far the hull may climb out of the water on the plane.
	 *
	 * A planing hull DOES rise -- that is what planing is -- but it never
	 * leaves the water: the transom and the after third of the bottom stay
	 * wetted at any speed, which is where the thrust comes from. The raw
	 * riseMax took no account of how deep the boat sits, so on a shallow-draft
	 * model (an inflatable draws about a quarter of a metre) a 0.42 m lift
	 * carried the whole hull clear and it flew.
	 *
	 * So the lift is a fraction of the hull's OWN draft. Deep boats rise more
	 * in absolute terms, shallow ones less, and none of them take off.
	 */
	_lift( att ) {

		// Defensive about the mesh: OceanBody is driven by a bare stub in the
		// headless checks, which has no children -- and a physics class that
		// only works when a GLB happens to be loaded is a class that will fail
		// the first time a model is still in flight.
		const model = this.mesh?.children?.[ 0 ];
		const draft = model?.userData?.draft ?? 0.5;
		return Math.min( att.rise, draft * 0.55 );

	}


	pose() {

		const att = this.att;
		const trim = att.trim * Math.PI / 180;
		// The origin is at the stem, so trimming about it would swing the bow
		// instead of lifting it. Compensating holds a point near the aft
		// quarter at the waterline, which is roughly where a planing hull
		// actually pitches about.
		const TRIM_PIVOT = 0.72;
		const b = this.bow();
		// The sea's contribution rides on top of the speed trim and the turn
		// bank: a hull climbing a swell while leaning into a turn does both.
		this.mesh.rotation.set( - trim - this.wave.pitch, this.state.heading,
			this.roll + this.wave.roll, 'YXZ' );
		// A HULL DOES NOT LEAVE THE WATER, AND THE CAP HAS TO COVER BOTH TERMS.
		//
		// _lift() caps the planing rise against the boat's own draft and does
		// exactly what its comment promises. It is not the term that flies. The
		// trim compensation is: rotating bow-up about an origin at the stem
		// sinks the stern, so the hull is raised to hold the aft quarter at the
		// waterline -- legitimate geometry, but uncapped, and it scales with the
		// DRAWN length while the draft does not scale with model scale at all.
		//
		// Measured with the shipped tuning at model scale 2.4, 23.8 m drawn
		// against a 0.85 m draft: the rise is held to 0.468 m and the trim term
		// then adds 2.28 m straight past it, putting the keel 1.43 m clear of
		// the sea at eight metres a second. Airborne at every speed above about
		// four. That is why foam was being made from water the boat was not
		// touching -- the foam was right, the boat was in the wrong place.
		//
		// So the cap belongs on the SUM. A planing hull keeps its after bottom
		// wetted at any speed, which is where the thrust comes from, and
		// boat.wetKeep is the share of her draft that stays in the water.
		// Heave is added afterwards: the sea genuinely does lift her.
		const model = this.mesh?.children?.[ 0 ];
		const keelDraft = model?.userData?.draft ?? 0.5;
		const lift = this._lift( att ) + Math.sin( trim ) * this.length * TRIM_PIVOT;
		const maxLift = keelDraft * ( 1 - get( 'boat.wetKeep' ) );
		this.mesh.position.set( b.x,
			Math.min( lift, maxLift ) + this.wave.heave, b.z );

	}

	/**
	 * Advance one step. `dt` seconds. The caller owns the helm and writes
	 * state.speed / state.turn before calling.
	 */
	step( dt, seaHeight = null ) {

		const s = this.state;
		s.t += dt;
		this.att = attitude( s.speed );
		this.rollTo( dt );
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
