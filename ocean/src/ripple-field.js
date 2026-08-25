// A height field that carries its own waves, so a moving object only has
// to displace water and the physics does the rest.
//
// The idea is Evan Wallace's WebGL Water (2011), by way of its WebGPU
// port: store height and vertical velocity per cell, push the velocity
// toward the neighbourhood average, and integrate. What makes it worth
// having over the analytic near field in src/pierce.js is the object
// term — add back the volume the body VACATED, subtract the volume it
// occupies NOW. That travelling dipole is the single cause of the collar,
// the heap ahead, the hollow astern, and the rings that leave the scene;
// the analytic model has to paint those four separately and then be
// tuned so they do not cancel each other.
//
// Three things are ours rather than his:
//
//   Time.  His `height += velocity` bakes the timestep into the
//          constants, so waves travel twice as fast at 120 Hz. Here the
//          wave speed is a number in m/s and the step substeps itself to
//          stay inside the CFL limit.
//   Edges. His pool has walls. A fin in open water must not hear its own
//          ripples come back off one, so the outer cells are a sponge.
//   Place. His grid is the world. Ours follows the body, shifting by
//          WHOLE cells so the stored field is never resampled.
//
// This field runs on the CPU on purpose: buoyancy has to be able to ask
// how high the water is without a GPU readback, and a check has to be
// able to run in a fifth of a second. src/gpu/tsl/ripple-field.js only
// uploads it, so there is no second implementation to drift.
//
// One honest lie: a single wave speed means no dispersion, so every
// wavelength travels together. Real deep water sorts them — long waves
// outrun short ones, which is where the Kelvin V's 19.47° comes from.
// At fin scale you cannot see it; for a big fast body the far wake still
// belongs to src/v-wake.js and the FFT sea.

import { pierceOutlineDist, pierceScale } from './pierce.js';

export const RIPPLE_DEFAULTS = {
	/** Cells across. 128² is 16k cells — nothing per frame. */
	size: 128,
	/** Metres per cell. Waves shorter than ~3 cells cannot exist. */
	cell: 0.22,
	/**
	 * Wave speed (m/s). Deep-water waves go sqrt(g·λ/2π), so 2 m/s is
	 * about right for the 2–3 m ripples a fin makes. Raise it and the
	 * whole pattern outruns the body.
	 */
	speed: 2,
	/** Velocity lost per second, e^-damping. Stops a perpetual pond. */
	damping: 0.55,
	/** Fraction of the CFL limit each substep is allowed. */
	cfl: 0.7,
	/** Cells of absorbing border. Too few and ripples bounce back. */
	sponge: 14,
	/** Metres of column a body may displace, however deep it is. */
	displaceCap: 1.2,
	/**
	 * Master gain on the object term, and the one number here that is a
	 * fudge. Taken literally, a fin 1.4 m into the water removes a 1.4 m
	 * column and leaves a crater, because a height field has no way for
	 * water to flow AROUND a body — only up and down. Real water mostly
	 * goes round, so only a fraction of the column shows as surface.
	 * 0.35 is where a fin at 4–5 m/s looked right in the lab; the wake's
	 * amplitude climbs with speed on its own from there, because a faster
	 * body sweeps more volume per second.
	 */
	displace: 0.35,
	/**
	 * Soft |h| / |v| ceiling. 0 leaves the field uncapped (lab / tests).
	 * Physics leftover sets this so a bow/motor fountain cannot stand
	 * the sea mesh up as a vertex tower.
	 */
	heightCap: 0,
};

/** Clamped bilinear read helper shared by sampleAt(). */
function lerp( a, b, t ) {

	return a + ( b - a ) * t;

}

export class RippleField {

	constructor( opts = {} ) {

		const k = { ...RIPPLE_DEFAULTS, ...opts };
		this.size = Math.max( 16, Math.round( k.size ) );
		this.cell = Math.max( k.cell, 0.01 );
		this.speed = Math.max( k.speed, 0.05 );
		this.damping = Math.max( k.damping, 0 );
		this.cfl = Math.min( Math.max( k.cfl, 0.05 ), 0.9 );
		this.displaceCap = k.displaceCap;
		this.displace = k.displace;
		this.heightCap = Math.max( k.heightCap ?? 0, 0 );
		/** World XZ of the grid's centre, which is a cell, not a corner. */
		this.ox = 0;
		this.oz = 0;
		this.mid = this.size >> 1;
		const n = this.size * this.size;
		this.h = new Float32Array( n );
		this.v = new Float32Array( n );
		// Current object occupancy, tracked separately from radiated height.
		// Rendering adds this back so the pressure source makes waves without
		// opening a vertex moat around the body.
		this.source = new Float32Array( n );
		this._recordSource = false;
		this.absorb = new Float32Array( n );
		this.revision = 0;
		this.substeps = 0;
		this.setSponge( k.sponge );

	}

	/** Half-width of the tile in metres. */
	get extent() {

		return this.size * this.cell * 0.5;

	}

	/**
	 * Rebuild the absorbing border. Inside it the factor is exactly 1, so
	 * the interior costs one multiply and nothing else.
	 */
	setSponge( cells ) {

		const N = this.size;
		const w = Math.min( Math.max( Math.round( cells ), 0 ), ( N >> 1 ) - 2 );
		this.sponge = w;
		for ( let z = 0; z < N; z ++ ) {

			for ( let x = 0; x < N; x ++ ) {

				const d = Math.min( x, z, N - 1 - x, N - 1 - z );
				let f = 1;
				if ( w > 0 && d < w ) {

					const t = 1 - d / w;
					f = 1 - 0.24 * t * t;

				}
				this.absorb[ z * N + x ] = f;

			}

		}
		return this;

	}

	reset() {

		this.h.fill( 0 );
		this.v.fill( 0 );
		this.source.fill( 0 );
		this.revision ++;
		return this;

	}

	/** Start one object-displacement frame and clear its visible source cancel. */
	beginDisplacementFrame() {

		this.source.fill( 0 );
		this._recordSource = true;
		return this;

	}

	/** Largest stable substep (s) for the current speed and cell size. */
	get maxStep() {

		return this.cfl * this.cell / ( this.speed * Math.SQRT2 );

	}

	/**
	 * Advance the field. Substeps as many times as the CFL limit demands,
	 * so the waves travel at `speed` whatever the frame rate did.
	 */
	step( dt ) {

		let left = Math.min( Math.max( dt, 0 ), 0.25 );
		const sub = this.maxStep;
		let guard = 64;
		this.substeps = 0;
		while ( left > 1e-6 && guard -- > 0 ) {

			const s = Math.min( left, sub );
			this._advance( s );
			left -= s;
			this.substeps ++;

		}
		if ( this.substeps > 0 ) this.revision ++;
		this._clampHeight();
		return this;

	}

	/**
	 * Keep leftover on the water. Uncapped bow/motor boil plus an idle
	 * frame was enough to stand the vertex mesh up as a sky pillar.
	 */
	_clampHeight() {

		const cap = this.heightCap;
		if ( ! ( cap > 0 ) ) return;
		const { h, v } = this;
		const vmax = cap * 6;
		for ( let i = 0; i < h.length; i ++ ) {

			const y = h[ i ];
			if ( y > cap ) h[ i ] = cap;
			else if ( y < - cap ) h[ i ] = - cap;
			const w = v[ i ];
			if ( w > vmax ) v[ i ] = vmax;
			else if ( w < - vmax ) v[ i ] = - vmax;

		}

	}

	_advance( dt ) {

		const N = this.size;
		const { h, v, absorb } = this;
		// v' = c²∇²h, h' = v. The Laplacian is the five-point stencil over
		// the cell size, which is what turns `speed` into real m/s.
		const c2 = ( this.speed * this.speed ) / ( this.cell * this.cell ) * dt;
		const decay = Math.exp( - this.damping * dt );
		for ( let z = 1; z < N - 1; z ++ ) {

			let i = z * N + 1;
			for ( let x = 1; x < N - 1; x ++, i ++ ) {

				const lap = h[ i - 1 ] + h[ i + 1 ] + h[ i - N ] + h[ i + N ] - 4 * h[ i ];
				v[ i ] = ( v[ i ] + lap * c2 ) * decay;

			}

		}
		for ( let z = 1; z < N - 1; z ++ ) {

			let i = z * N + 1;
			for ( let x = 1; x < N - 1; x ++, i ++ ) {

				const a = absorb[ i ];
				v[ i ] *= a;
				h[ i ] = ( h[ i ] + v[ i ] * dt ) * a;

			}

		}
		// The outermost ring is held flat: whatever the sponge did not
		// absorb dies here instead of turning round.
		for ( let x = 0; x < N; x ++ ) {

			const b = ( N - 1 ) * N + x;
			h[ x ] = v[ x ] = h[ b ] = v[ b ] = 0;

		}
		for ( let z = 0; z < N; z ++ ) {

			const l = z * N, r = l + N - 1;
			h[ l ] = v[ l ] = h[ r ] = v[ r ] = 0;

		}

	}

	/**
	 * The object term. `prev` and `now` are the same pierce site one frame
	 * apart (x, z, ax, az, half, r, submerged). Water rises where the body
	 * was and drops where it is, so volume is conserved and the surface
	 * closing astern is the water shouldered aside ahead.
	 *
	 * A body that has not moved writes nothing — which is right for a fin,
	 * and is why a floating hull still needs its own buoyant hollow from
	 * src/body-swell.js rather than this.
	 */
	displaceMove( prev, now, gain = this.displace ) {

		if ( ! prev || ! now || ! ( gain > 0 ) ) return 0;
		const amtPrev = this._amount( prev, gain );
		const amtNow = this._amount( now, gain );
		if ( amtPrev <= 1e-6 && amtNow <= 1e-6 ) return 0;

		const N = this.size;
		const wPrev = this._footprint( prev );
		const wNow = this._footprint( now );
		const reachPrev = ( prev.half ?? 0 ) + ( prev.r ?? 0 ) + wPrev * 2;
		const reachNow = ( now.half ?? 0 ) + ( now.r ?? 0 ) + wNow * 2;
		const minX = Math.min( prev.x - reachPrev, now.x - reachNow );
		const maxX = Math.max( prev.x + reachPrev, now.x + reachNow );
		const minZ = Math.min( prev.z - reachPrev, now.z - reachNow );
		const maxZ = Math.max( prev.z + reachPrev, now.z + reachNow );

		const x0 = Math.max( 1, this._col( minX ) ), x1 = Math.min( N - 2, this._col( maxX ) + 1 );
		const z0 = Math.max( 1, this._row( minZ ) ), z1 = Math.min( N - 2, this._row( maxZ ) + 1 );
		let written = 0;
		for ( let z = z0; z <= z1; z ++ ) {

			const wz = this.oz + ( z - this.mid ) * this.cell;
			for ( let x = x0; x <= x1; x ++ ) {

				const wx = this.ox + ( x - this.mid ) * this.cell;
				const add = amtPrev > 0 ? amtPrev * mask( wx, wz, prev, wPrev ) : 0;
				const sub = amtNow > 0 ? amtNow * mask( wx, wz, now, wNow ) : 0;
				if ( this._recordSource && sub > 0 ) this.source[ z * N + x ] += sub;
				const d = add - sub;
				if ( d !== 0 ) {

					this.h[ z * N + x ] += d;
					written ++;

				}

			}

		}
		if ( written > 0 ) this.revision ++;
		return written;

	}

	_amount( site, gain ) {

		const draft = Math.max( site.submerged ?? 0, 0 );
		return gain * Math.min( draft, this.displaceCap );

	}

	/**
	 * Softness of the stamp's edge. A hull site carries its own `soft`
	 * so the leftover cradle sits on the mesh — pierceScale(half) would
	 * bleed several metres past the beam.
	 */
	_footprint( site ) {

		if ( site?.soft != null ) return Math.max( site.soft, this.cell );
		return Math.max( pierceScale( site ) * 0.9, this.cell );

	}

	/** How much this frame's occupancy subtracts at a world point (m). */
	occupancyAt( x, z, site, gain = this.displace ) {

		if ( ! site || ! ( gain > 0 ) ) return 0;
		const amt = this._amount( site, gain );
		if ( amt <= 1e-8 ) return 0;
		return amt * mask( x, z, site, this._footprint( site ) );

	}

	_col( x ) {

		return Math.round( ( x - this.ox ) / this.cell + this.mid );

	}

	_row( z ) {

		return Math.round( ( z - this.oz ) / this.cell + this.mid );

	}

	_sampleField( field, x, z ) {

		const N = this.size;
		const gx = ( x - this.ox ) / this.cell + this.mid;
		const gz = ( z - this.oz ) / this.cell + this.mid;
		if ( gx < 0 || gz < 0 || gx > N - 1 || gz > N - 1 ) return 0;
		const x0 = Math.floor( gx ), z0 = Math.floor( gz );
		const x1 = Math.min( x0 + 1, N - 1 ), z1 = Math.min( z0 + 1, N - 1 );
		const tx = gx - x0, tz = gz - z0;
		return lerp(
			lerp( field[ z0 * N + x0 ], field[ z0 * N + x1 ], tx ),
			lerp( field[ z1 * N + x0 ], field[ z1 * N + x1 ], tx ),
			tz,
		);

	}

	/** Height (m) at a world point, bilinear, 0 outside the tile. */
	sampleAt( x, z ) {

		return this._sampleField( this.h, x, z );

	}

	/** Vertical velocity (m/s) at a world point. */
	sampleVelAt( x, z ) {

		return this._sampleField( this.v, x, z );

	}

	/** Current object occupancy used only to cancel the visible source hole. */
	sampleSourceAt( x, z ) {

		return this._sampleField( this.source, x, z );

	}

	/** Height shown by the renderer: travelling wave without the live source cut. */
	sampleSurfaceAt( x, z ) {

		return this.sampleAt( x, z ) + this.sampleSourceAt( x, z );

	}

	/** Height slope (dh/dx, dh/dz). Leftover bubbles ride this. */
	sampleSlopeAt( x, z ) {

		const e = this.cell;
		return {
			x: ( this.sampleAt( x + e, z ) - this.sampleAt( x - e, z ) ) / ( 2 * e ),
			z: ( this.sampleAt( x, z + e ) - this.sampleAt( x, z - e ) ) / ( 2 * e ),
		};

	}

	/**
	 * Slide the tile so `x, z` is near its centre again. Shifts by whole
	 * cells only — a fractional shift would resample the field every frame
	 * and smear every ripple into nothing.
	 *
	 * @returns {boolean} whether anything moved
	 */
	recentreOn( x, z ) {

		const dx = Math.round( ( x - this.ox ) / this.cell );
		const dz = Math.round( ( z - this.oz ) / this.cell );
		if ( dx === 0 && dz === 0 ) return false;
		const N = this.size;
		if ( Math.abs( dx ) >= N || Math.abs( dz ) >= N ) {

			this.reset();

		} else {

			shift( this.h, N, dx, dz );
			shift( this.v, N, dx, dz );
			shift( this.source, N, dx, dz );

		}
		this.ox += dx * this.cell;
		this.oz += dz * this.cell;
		this.revision ++;
		return true;

	}

	/** Σh · cell² (m³). A dipole should keep this near zero. */
	volume() {

		let s = 0;
		for ( let i = 0; i < this.h.length; i ++ ) s += this.h[ i ];
		return s * this.cell * this.cell;

	}

	/**
	 * Discrete energy of the wave equation: kinetic Σv² plus potential
	 * c²Σ|∇h|². Damping can only take from this, so it must never climb.
	 * (Σh² alone climbs on its own as a standing hump converts to motion,
	 * which is why that is not the quantity to watch.)
	 */
	energy() {

		const N = this.size;
		const { h, v } = this;
		const c2 = ( this.speed * this.speed ) / ( this.cell * this.cell );
		let kin = 0, pot = 0;
		for ( let z = 0; z < N - 1; z ++ ) {

			let i = z * N;
			for ( let x = 0; x < N - 1; x ++, i ++ ) {

				kin += v[ i ] * v[ i ];
				const gx = h[ i + 1 ] - h[ i ];
				const gz = h[ i + N ] - h[ i ];
				pot += gx * gx + gz * gz;

			}

		}
		return kin + c2 * pot;

	}

	/** Tallest |h| and where it is, in metres from the tile centre. */
	peak() {

		const N = this.size;
		let best = 0, bx = 0, bz = 0;
		for ( let z = 0; z < N; z ++ ) {

			for ( let x = 0; x < N; x ++ ) {

				const a = Math.abs( this.h[ z * N + x ] );
				if ( a > best ) {

					best = a; bx = x; bz = z;

				}

			}

		}
		return {
			height: best,
			x: ( bx - this.mid ) * this.cell,
			z: ( bz - this.mid ) * this.cell,
			radius: Math.hypot( bx - this.mid, bz - this.mid ) * this.cell,
		};

	}

	/**
	 * Elongated leftover stamp aligned to `heading` (0 is −Z).
	 * Use this for a transom jet — {@link splash} is a raindrop and
	 * radiates circular rings into the foam ribbon.
	 */
	splashAlong( x, z, heading = 0, halfAcross = 0.4, halfAlong = 1.4, height = 0.1 ) {

		const N = this.size;
		const fx = Math.sin( heading );
		const fz = - Math.cos( heading );
		const rx = Math.cos( heading );
		const rz = Math.sin( heading );
		const a = Math.max( halfAlong, this.cell );
		const b = Math.max( halfAcross, this.cell );
		const reach = Math.hypot( a, b );
		const cx = this._col( x ), cz = this._row( z );
		const span = Math.ceil( reach / this.cell ) + 1;
		for ( let z2 = Math.max( 1, cz - span ); z2 <= Math.min( N - 2, cz + span ); z2 ++ ) {

			for ( let x2 = Math.max( 1, cx - span ); x2 <= Math.min( N - 2, cx + span ); x2 ++ ) {

				const dx = ( x2 - cx ) * this.cell;
				const dz = ( z2 - cz ) * this.cell;
				const along = dx * fx + dz * fz;
				const lat = dx * rx + dz * rz;
				const q = ( along / a ) * ( along / a ) + ( lat / b ) * ( lat / b );
				if ( q > 1 ) continue;
				this.h[ z2 * N + x2 ] += height * 0.5 * ( 1 + Math.cos( Math.PI * Math.sqrt( q ) ) );

			}

		}
		this.revision ++;
		this._clampHeight();
		return this;

	}

	/** A single ring, for tests and for a raindrop. */
	splash( x, z, radius = 0.5, height = 0.1 ) {

		const N = this.size;
		const r = Math.max( radius, this.cell );
		const cx = this._col( x ), cz = this._row( z );
		const span = Math.ceil( r / this.cell ) + 1;
		for ( let z2 = Math.max( 1, cz - span ); z2 <= Math.min( N - 2, cz + span ); z2 ++ ) {

			for ( let x2 = Math.max( 1, cx - span ); x2 <= Math.min( N - 2, cx + span ); x2 ++ ) {

				const d = Math.hypot( ( x2 - cx ) * this.cell, ( z2 - cz ) * this.cell );
				if ( d > r ) continue;
				// Raised cosine: no corner for the stencil to ring on.
				this.h[ z2 * N + x2 ] += height * 0.5 * ( 1 + Math.cos( Math.PI * d / r ) );

			}

		}
		this.revision ++;
		this._clampHeight();
		return this;

	}

}

/** Super-Gaussian: flat over the body, then off a cliff. */
function mask( px, pz, site, w ) {

	const s = pierceOutlineDist( px, pz, site ) / w;
	const cut = site?.tight ? 1.15 : 2.2;
	if ( s > cut ) return 0;
	const s2 = s * s;
	return Math.exp( - s2 * s2 * s2 );

}

/** Move the grid's contents by whole cells; vacated cells come back flat. */
function shift( a, N, dx, dz ) {

	const stepX = dx > 0 ? 1 : - 1;
	const stepZ = dz > 0 ? 1 : - 1;
	const zStart = dz > 0 ? 0 : N - 1;
	const xStart = dx > 0 ? 0 : N - 1;
	for ( let n = 0; n < N; n ++ ) {

		const z = zStart + n * stepZ;
		const sz = z + dz;
		for ( let m = 0; m < N; m ++ ) {

			const x = xStart + m * stepX;
			const sx = x + dx;
			a[ z * N + x ] = ( sx >= 0 && sx < N && sz >= 0 && sz < N )
				? a[ sz * N + sx ]
				: 0;

		}

	}

}
