// Spray ballistics, with no renderer in sight.
//
// Split from spray.js for the same reason attitude.js and lakeHeight.js are
// three-free: this is the part with physics in it, and a check that needs a
// GPU is a check that does not get run. spray.js owns the geometry and the
// material; everything that decides where a droplet goes lives here.
//
// The pool is fixed and recycled oldest-first. A particle system that grows
// under load stalls the frame exactly when the boat is most worth looking at.

import { get } from './params.js';

const GRAVITY = 9.81;

/**
 * Ballistic step. Drag is linear — at droplet scale that is close enough — but
 * it is NOT the same for every droplet, and that is the whole difference
 * between spray and confetti.
 *
 * Drag force goes as the frontal area (r^2) and inertia as the volume (r^3),
 * so the deceleration a droplet feels goes as 1/r. A half-millimetre droplet
 * is slowed an order of magnitude harder than a five-millimetre one thrown at
 * the same speed. That is why real spray separates in flight: the big drops
 * carry on in clean arcs and land ahead of the boat, while the fine stuff
 * stops almost where it was thrown and hangs there as a haze that the wind
 * takes. Give every droplet the same drag and the whole curtain moves as one
 * sheet, which is the tell.
 *
 * `km` is that 1/r factor, carried per droplet from the size it was born with;
 * `drag` is still the live slider, so dragging it moves the whole population.
 */
function integrate( p, i, dt, drag ) {

	const k = Math.max( 1 - drag * p.km[ i ] * dt, 0 );
	p.vx[ i ] *= k;
	p.vz[ i ] *= k;
	p.vy[ i ] = p.vy[ i ] * k - GRAVITY * dt;
	p.x[ i ] += p.vx[ i ] * dt;
	p.y[ i ] += p.vy[ i ] * dt;
	p.z[ i ] += p.vz[ i ] * dt;

}

export class SprayCore {

	constructor( max = 3000 ) {

		this.max = max;
		this.n = 0;                       // live count, packed at the front
		this.cursor = 0;

		const f = () => new Float32Array( max );
		this.p = { x: f(), y: f(), z: f(), vx: f(), vy: f(), vz: f(),
			age: f(), life: f(), size: f(), km: f() };

		// Landing events for this frame: where a droplet met the surface, so the
		// wake field can turn it into foam instead of letting it wink out.
		this.landings = [];

	}

	/** Oldest-first recycling: the pool never grows and never stalls. */
	_slot() {

		if ( this.n < this.max ) return this.n ++;
		this.cursor = ( this.cursor + 1 ) % this.max;
		return this.cursor;

	}

	/**
	 * Throw one droplet.
	 *
	 * `out` is the outward normal of the cut (the direction the hull is pushing
	 * water), `fwd` the direction of travel. Water leaves a chine mostly
	 * sideways and a little forward, which is why the two are separate.
	 */
	emit( x, y, z, out, fwd, speed, rand, opt = null ) {

		// NO DROPLET INSIDE THE HULL.
		//
		// Droplets are billboards drawn AFTER the boat with depthWrite off, and
		// the hull's own spray is emitted at the chines -- on the hull's edge,
		// at the waterline. A droplet sized in metres, spawned on that line and
		// spreading inboard, paints over the deck it came off, which reads as
		// foam showing through the boat.
		//
		// It is the same rule the water itself obeys: the sea is cut out inside
		// the hull because there is no sea inside a boat. There is no spray in
		// there either, whatever emitted it. Slightly inside the water's own cut
		// so the chines themselves still throw.
		const h = this.hullCut;
		if ( h ) {
			const rx = x - h.x, rz = z - h.z;
			const along = ( rx * h.fx + rz * h.fz ) / h.len;
			const lat = ( - rx * h.fz + rz * h.fx ) / h.beam;
			if ( along * along + lat * lat < 1 ) return;
		}

		const i = this._slot();
		const p = this.p;
		// A caller with its own physics can override the hull-derived settings.
		// Water bursting off a rock is not water peeling off a chine: it goes up
		// far harder and scatters wider, and yoking it to the boat's controls
		// would mean tuning one wrecks the other.
		const spread = opt?.spread ?? get( 'spray.spread' );
		const up = opt?.rise ?? get( 'spray.rise' );

		p.x[ i ] = x; p.y[ i ] = y; p.z[ i ] = z;

		// Sheet velocity scales with hull speed: that is why a wake at 4 m/s
		// weeps and at 20 m/s throws a curtain, with no separate "amount" knob
		// doing the work.
		const v = speed * ( opt?.throw ?? get( 'spray.throw' ) );
		const j = () => ( rand() - 0.5 ) * spread;
		p.vx[ i ] = out.x * v * ( 0.6 + rand() * 0.7 ) + fwd.x * v * 0.25 + j() * v;
		p.vz[ i ] = out.z * v * ( 0.6 + rand() * 0.7 ) + fwd.z * v * 0.25 + j() * v;
		p.vy[ i ] = v * up * ( 0.5 + rand() * 0.9 );

		p.age[ i ] = 0;
		p.life[ i ] = ( opt?.life ?? get( 'spray.life' ) ) * ( 0.6 + rand() * 0.8 );

		// SIZE IS NOT UNIFORM. Atomisation does not produce one droplet size
		// with a bit of jitter round it; it produces a heavy-tailed spectrum --
		// a great many fine droplets and a few big ones. Drawn uniform, every
		// droplet is the same droplet and the curtain reads as a texture.
		//
		// `fine` mixes from the old uniform spread toward u^3, which puts the
		// median well down and leaves a long tail. Paired with the 1/r drag
		// above it is what makes one emitter throw both mist and drops.
		const u = rand();
		const fine = get( 'spray.fine' );
		const shape = ( 0.5 + u * 1.1 ) * ( 1 - fine ) + ( 0.12 + 1.9 * u * u * u ) * fine;
		// DROPLETS FOLLOW THE DRAWN HULL, like the camera distances do.
		//
		// Droplet size is in metres and the model scale was not in it, so at
		// scale 2.4 the boat became a 24 m yacht and its spray stayed sized for
		// a 10 m runabout: measured, a mean droplet of 7.4 cm against a 23.8 m
		// hull, which is about one pixel on screen. No amount of shading or
		// shaping rescues something drawn a pixel wide -- it was the largest
		// single reason the spray read as a faint dusting rather than as water,
		// and it is the same class of fault as the hull that stopped sitting in
		// the sea when the scale changed.
		const scale = get( 'boat.modelScale' );
		p.size[ i ] = ( opt?.size ?? get( 'spray.size' ) ) * shape * scale;
		// Drag multiplier, 1/r, normalised so shape 1 is the slider's value.
		// Clamped: the tail of u^3 would otherwise hand a droplet an eight-fold
		// drag that stops it dead inside a frame, which reads as a glitch.
		p.km[ i ] = Math.min( Math.max( 1 / Math.max( shape, 0.08 ), 0.45 ), 6 );

	}

	/**
	 * Advance every droplet and pack the survivors to the front.
	 *
	 * `seaHeight(x, z)` is optional: with it, droplets land on the real surface
	 * rather than on y = 0, which matters as soon as the sea has any swell —
	 * otherwise spray sinks into crests and hovers over troughs.
	 */
	step( dt, seaHeight = null ) {

		const p = this.p;
		const drag = get( 'spray.drag' );
		this.landings.length = 0;

		let w = 0;
		for ( let i = 0; i < this.n; i ++ ) {

			p.age[ i ] += dt;
			integrate( p, i, dt, drag );

			const surface = seaHeight ? seaHeight( p.x[ i ], p.z[ i ] ) : 0;
			const landed = p.y[ i ] <= surface && p.vy[ i ] < 0;
			if ( landed ) {
				// Not deleted: reported. A droplet that hits the water becomes
				// aerated surface, and the caller owns that field.
				this.landings.push( p.x[ i ], p.z[ i ],
					Math.min( - p.vy[ i ] / 6, 1 ) );
			}
			if ( landed || p.age[ i ] >= p.life[ i ] ) continue;

			if ( w !== i ) {
				for ( const k of [ 'x', 'y', 'z', 'vx', 'vy', 'vz', 'age', 'life', 'size', 'km' ] ) {
					p[ k ][ w ] = p[ k ][ i ];
				}
			}
			w ++;

		}
		this.n = w;
		this.cursor = Math.min( this.cursor, Math.max( w - 1, 0 ) );
		return w;

	}

}
