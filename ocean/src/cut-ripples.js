// Disturbances at a waterline cut.
//
// Two different things, because they are physically different:
//
//   • A co-moving bow heap ahead of the foremost cut. A swimming body
//     pushes water out of the way; expanding rings cannot do that — the
//     animal outruns them. The heap lives entirely in front of the cut.
//   • Traveling packets from flank / tail cuts, thrown aft-outward so
//     they are left behind as wake arms. Head sites do not throw these.
//
// Held cuts are emitters only — they do not draw a meniscus. A dive
// inverts a packet and fades the bow. tools/check-swell-curve.mjs is
// the CPU twin of the height formula the TSL evaluates.

export const CRATER_AMP = - 0.08;
export const CRATER_RIM_R = 1.28;
export const CRATER_RIM_W = 0.72;
export const CRATER_RIM_GAIN = 0.42;
// Traveling packet: one wide cycle. A short λ plus a trailing train
// read as a crown of spikes on the radial water grid. Same numbers
// as swellSiteCore.
export const RIPPLE_LAMBDA = 3.2;
export const RIPPLE_LAMBDA_MIN = 8;
export const RIPPLE_TRAIN = 0.0;
export const RIPPLE_NEAR = 2.4;
// Barely not a compass. Lobe-break at 0.35 turned each ring into
// two or three sharp teeth.
export const RIPPLE_WOBBLE_A = 0.05;
export const RIPPLE_WOBBLE_B = 0.02;
export const RIPPLE_WOBBLE_C = 0.0;
export const RIPPLE_BREAK_LOBE = 2.0;
export const RIPPLE_BREAK_FINE = 2.0;
export const RIPPLE_BREAK_FLOOR = 0.88;
// Ellipse along the heading at emit. Capped so a fast swim cannot
// collapse the ring into a pair of rails.
export const RIPPLE_STRETCH_MAX = 0.12;
// Soft-limit when many rings overlap. A raw sum of 20 packets at
// sdSwell≈4 is a 10 m sawtooth.
export const RIPPLE_STACK = 0.65;
// New packets grow in. A dive used to throw a full-amp ring the
// frame the body went under, which read as a pop.
export const RIPPLE_ATTACK = 0.35;
// Wake arm: a long cosine fade, then squared, so the crest dissolves
// instead of ending on a cut. Tight 40°–70° windows read as compass
// segments. Port+starboard throw aft-outward, so the long tails meet
// behind as a wake and do not close a ring in front.
export const RIPPLE_ARC_COS0 = - 0.28;
export const RIPPLE_ARC_COS1 = 0.82;
// Heading leftover (tests / unknown side). Wider than a spike, still
// dead astern.
export const RIPPLE_ARC_BOW_COS0 = - 0.42;
export const RIPPLE_ARC_BOW_COS1 = 0.72;
// Mix of beam-outward and −heading. 0 is a side crescent; 1 is straight
// aft. ~0.7 is a Kelvin-ish arm the body can swim out of.
export const RIPPLE_AFT = 0.7;
// Co-moving bow heap. Expanding packets cannot sit in front of a 50 m/s
// swim — the animal outruns them. The pile sits ON the foremost cut
// (Jaws: whitewater starts at the snout, not metres ahead) and spills
// forward and to the sides. A little onto the shoulders; not down the back.
// Round mound on the snout, same family as the pressure dome.
// A wide-across Gaussian plus a heading-perpendicular fade was the
// bright ruler in front of the nose.
export const BOW_AFT = - 0.85;
export const BOW_AFT_SOFT = 0.0;
export const BOW_STANDOFF = 0.22;
export const BOW_ALONG = 0.72;
export const BOW_ACROSS = 0.72;
export const BOW_AMP_ALONG = 1.15;
export const BOW_AMP_ACROSS = 1.05;
export const BOW_FOAM_SCALE = 1.15;
export const BOW_RH_MAX = 4.2;

/**
 * Bow heap footprint. rh is the snout scale (capped at BOW_RH_MAX);
 * amplitude used to sit on that same 4 m ellipse, so a 16 m slider
 * was a tent and the radial water grid lit a ruled line through it.
 */
export function bowFootprint( rh, amp, soft = 1 ) {

	const r = Math.max( rh ?? 0, 0.5 );
	const A = Math.abs( amp ?? 0 );
	const s = Math.max( soft ?? 1, 0.2 );
	return {
		standoff: r * BOW_STANDOFF,
		along: Math.max( r * BOW_ALONG, A * BOW_AMP_ALONG, 1e-3 ) * s,
		across: Math.max( r * BOW_ACROSS, A * BOW_AMP_ACROSS, 1e-3 ) * s,
	};

}

const FORCE_VY = 3.2;
const FORCE_DEAD = 0.10;

export const G_WATER = 9.81;

/**
 * How close a station is to the sea, 0..1. Same curve the pressure
 * dome uses: grows as the body approaches from below, peaks at the
 * waterline, and eases out once the station is well emerged. A binary
 * pierce gate (headWet) is what made the bow heap sit at one height
 * while the dome breathed with the swim.
 */
export function swellProximity( clear, fade = 9, emerge = 2.4 ) {

	const approach = Math.max( fade, 0.5 );
	if ( ! Number.isFinite( clear ) ) return 0;
	if ( clear >= approach * 0.7 || clear <= - emerge ) return 0;
	if ( clear <= 0 ) return Math.max( 0, 1 + clear / emerge );
	return Math.exp( - clear / ( approach * 0.38 ) );

}

export function rippleLambda( width, speed ) {

	const w = Math.max( width, 0.2 );
	const u = Math.min( Math.max( speed ?? 0, 0 ), 24 );
	return w * 7 * ( 1 + 0.45 * u / 8 );

}

export function rippleSpeed( lambda ) {

	return Math.sqrt( G_WATER * Math.max( lambda, 0.5 ) / ( 2 * Math.PI ) );

}

/**
 * Signed force at a cut, roughly −1..+1. Magnitude follows how hard the
 * mesh is driving the surface (vertical speed, a little horizontal
 * shouldering, contact width). A level cruise keeps a small rest
 * throw; a twitch under FORCE_DEAD does not invert.
 */
export function rippleForce( climb, speed, width ) {

	const v = climb ?? 0;
	const u = Math.min( Math.abs( speed ?? 0 ) / 12, 1 );
	const size = Math.min( Math.max( width ?? 1.6, 0.2 ) / 1.6, 1.4 );
	const rest = ( 0.32 + 0.12 * u ) * ( 0.75 + 0.25 * Math.min( size, 1 ) );
	const mag = Math.max( 0, Math.abs( v ) - FORCE_DEAD ) / ( FORCE_VY - FORCE_DEAD );
	const dyn = Math.sign( v ) * Math.min( 1.15, mag );
	if ( dyn < - 0.04 ) return Math.max( - 1, dyn * ( 0.7 + 0.3 * Math.min( size, 1 ) ) );
	return Math.min( 1, rest + Math.max( 0, dyn ) * 0.72 );

}

/** +1 rise / rest packet, −1 inverted (dive) packet. */
export function ripplePush( climb, speed, width ) {

	return rippleForce( climb, speed, width ) < CRATER_AMP ? - 1 : 1;

}

/** How hard this break should throw, 0..1, from size / swim / climb. */
export function rippleEnergy( width, speed, climb ) {

	const size = Math.min( Math.max( width, 0.2 ) / 1.6, 1.6 );
	const u = Math.min( Math.abs( speed ?? 0 ) / 12, 1 );
	const v = Math.min( Math.abs( climb ?? 0 ) / 4, 1 );
	return Math.min( 1, ( 0.35 + 0.40 * u + 0.40 * v ) * ( 0.55 + 0.45 * size ) );

}

function gauss( d, ring, width ) {

	const dist = Math.abs( d - ring );
	if ( dist > width * RIPPLE_NEAR ) return 0;
	return Math.exp( - ( dist * dist ) / ( width * width ) );

}

function rippleLambdaW( width ) {

	return Math.max( width * RIPPLE_LAMBDA, RIPPLE_LAMBDA_MIN );

}

function packet( d, center, width, amp ) {

	const env = gauss( d, center, width );
	if ( env === 0 ) return 0;
	const k = ( 2 * Math.PI ) / rippleLambdaW( width );
	return env * amp * Math.cos( k * ( d - center ) );

}

/** Nose half, a spike, or an unknown side: bow along the heading. */
export function isBowCut( cut ) {

	if ( ! cut ) return true;
	if ( cut.kind === 'spike' ) return true;
	if ( cut.side !== 1 && cut.side !== - 1 ) return true;
	return ( cut.along ?? 0 ) < 0;

}

/** Head sites drive the co-moving bow; they do not throw expanding rings. */
export function isBowEmitter( cut ) {

	if ( ! cut ) return false;
	if ( cut.kind === 'spike' ) return true;
	return cut.kind === 'cross' && ( cut.along ?? 0 ) < 0;

}

export function arcRangeFor( cut ) {

	if ( isBowCut( cut ) ) {

		return { arc0: RIPPLE_ARC_BOW_COS0, arc1: RIPPLE_ARC_BOW_COS1 };

	}
	return { arc0: RIPPLE_ARC_COS0, arc1: RIPPLE_ARC_COS1 };

}

/** Outward on the water for a pierce. A bow cut faces along the
 *  heading (the co-moving heap uses that). A mid-body / tail cut
 *  throws aft-outward so the packet is left behind as a wake arm. */
export function outwardDir( side, dirX, dirZ, cut ) {

	const hx = dirX ?? 0;
	const hz = dirZ ?? 1;
	const bow = cut ? isBowCut( { ...cut, side } ) : ( side !== 1 && side !== - 1 );
	if ( ! bow && ( side === 1 || side === - 1 ) ) {

		const ox = - hz * side - hx * RIPPLE_AFT;
		const oz = hx * side - hz * RIPPLE_AFT;
		const len = Math.hypot( ox, oz ) || 1;
		return { dirX: ox / len, dirZ: oz / len };

	}
	const len = Math.hypot( hx, hz ) || 1;
	return { dirX: hx / len, dirZ: hz / len };

}

/** Unit bow heap ahead of a cut. CPU twin of swellBowCore. */
export function bowHeight( px, pz, bow ) {

	if ( ! bow || ! ( Math.abs( bow.amp ) > 0.02 ) || ! ( bow.rh > 0.5 ) ) return 0;
	const dx = px - bow.x;
	const dz = pz - bow.z;
	const len = Math.hypot( bow.dirX, bow.dirZ ) || 1;
	const fx = bow.dirX / len;
	const fz = bow.dirZ / len;
	const along = dx * fx + dz * fz;
	const across = - dx * fz + dz * fx;
	const fp = bowFootprint( bow.rh, bow.amp, bow.soft );
	const standoff = fp.standoff;
	const L = fp.along;
	const W = fp.across;
	const ga = Math.exp( - ( ( along - standoff ) / L ) * ( ( along - standoff ) / L ) );
	const gb = Math.exp( - ( across / W ) * ( across / W ) );
	return bow.amp * ga * gb;

}

export function rippleSeed( x, z ) {

	const s = Math.sin( x * 127.1 + z * 311.7 ) * 43758.5453;
	return s - Math.floor( s );

}

function shapedDistance( dx, dz, dirX, dirZ, stretch ) {

	const len = Math.hypot( dirX, dirZ );
	const fx = len > 1e-5 ? dirX / len : 0;
	const fz = len > 1e-5 ? dirZ / len : 1;
	const along = dx * fx + dz * fz;
	const across = - dx * fz + dz * fx;
	const sa = 1 + stretch;
	const sc = 1 + stretch * 0.35;
	return Math.hypot( along / sa, across * sc );

}

function organicAmp( ang, seed ) {

	const lobe = 0.5 + 0.5 * Math.sin( ang * RIPPLE_BREAK_LOBE + seed * 5.2 );
	const fine = 0.55 + 0.45 * Math.sin( ang * RIPPLE_BREAK_FINE + seed * 2.7 );
	return RIPPLE_BREAK_FLOOR + ( 1 - RIPPLE_BREAK_FLOOR ) * lobe * lobe * fine;

}

function arcMask( along, raw, arc0, arc1 ) {

	if ( raw < 0.15 ) return 1;
	const lo = arc0 ?? RIPPLE_ARC_COS0;
	const hi = arc1 ?? RIPPLE_ARC_COS1;
	const c = along / raw;
	const span = hi - lo;
	const t = ( c - lo ) / span;
	if ( t <= 0 ) return 0;
	if ( t >= 1 ) return 1;
	const s = t * t * ( 3 - 2 * t );
	// Square so the last third of the fade is a whisper, not a cliff.
	return s * s;

}

function organicRing( d, ang, width, ring, amp, seed ) {

	const wobble = Math.sin( ang * 3 + seed * ( 2 * Math.PI ) ) * RIPPLE_WOBBLE_A
		+ Math.sin( ang * 5 + seed * 4.1 ) * RIPPLE_WOBBLE_B
		+ Math.sin( ang * 2 + seed * 1.7 ) * RIPPLE_WOBBLE_C;
	const ringEff = ring + wobble * width;
	const a = amp * organicAmp( ang, seed );
	let h = packet( d, ringEff, width, a );
	const lambda = rippleLambdaW( width );
	if ( ring > lambda * 0.8 ) {

		h += packet( d, Math.max( 0, ringEff - lambda ), width, a * RIPPLE_TRAIN );

	}
	return h;

}

function siteHeight( px, pz, s, shape ) {

	const w = s.width ?? s.r ?? 0;
	if ( ! ( w > 0.05 ) ) return 0;
	const dx = px - s.x;
	const dz = pz - s.z;
	const dirX = s.dirX ?? shape?.dirX ?? 0;
	const dirZ = s.dirZ ?? shape?.dirZ ?? 1;
	const stretch = s.stretch ?? shape?.stretch ?? 0;
	const d = shapedDistance( dx, dz, dirX, dirZ, stretch );
	const len = Math.hypot( dirX, dirZ );
	const fx = len > 1e-5 ? dirX / len : 0;
	const fz = len > 1e-5 ? dirZ / len : 1;
	const along = dx * fx + dz * fz;
	const raw = Math.hypot( dx, dz );
	const ang = Math.atan2( dz, dx );
	const seed = rippleSeed( s.x, s.z );
	return organicRing( d, ang, w, s.ring ?? 0, s.amp ?? 1, seed )
		* arcMask( along, raw, s.arc0 ?? shape?.arc0, s.arc1 ?? shape?.arc1 );

}

/** Unit height of the traveling packets. Same formula the TSL adds. */
export function cutRippleHeight( px, pz, field ) {

	let h = 0;
	if ( ! field ) return 0;
	const shape = {
		dirX: field.dirX ?? 0,
		dirZ: field.dirZ ?? 1,
		stretch: field.stretch ?? 0,
		time: field.time ?? 0,
	};
	const rings = field.rings ?? [];
	for ( let i = 0; i < rings.length; i ++ ) h += siteHeight( px, pz, rings[ i ], shape );
	h += bowHeight( px, pz, field.bow );
	return h / ( 1 + RIPPLE_STACK * Math.abs( h ) );

}

// Held emitters used to match anything within ~15 m, so a mid-body
// flank absorbed the nose sites. The pink balls still drew on every
// pierce; only the flanks kept a packet. Side mismatch adds 4 m.
const MATCH_MIN = 2.2;

export class CutRippleField {

	constructor() {

		this.held = [];
		this.rings = [];
		this.force = 0;
		this.dirX = 0;
		this.dirZ = 1;
		this.stretch = 0;
		this.time = 0;
		this._cMin = 0;
		this._cMax = Infinity;
		this.bow = { x: 0, z: 0, dirX: 0, dirZ: 1, amp: 0, rh: 8 };
		this._headWetT = 0;
		this._bowWasLive = false;

	}

	reset() {

		this.held.length = 0;
		this.rings.length = 0;
		this.force = 0;
		this.time = 0;
		this.bow.amp = 0;
		this._headWetT = 0;
		this._bowWasLive = false;

	}

	/**
	 * @param {number} dt
	 * @param {Array<{x:number,z:number,half?:number}>} cuts
	 * @param {{width:number, life:number, wave:number, speed:number, climb:number, deep?:boolean, maxHeld?:number, maxRings?:number}} opts
	 */
	step( dt, cuts, opts ) {

		const width = Math.max( opts.width ?? 1.2, 0.2 );
		const life = Math.max( opts.life ?? 1.6, 0.05 );
		const wave = Math.min( Math.max( opts.wave ?? 0.7, 0 ), 1 );
		const speed = opts.speed ?? 0;
		const climb = opts.climb ?? 0;
		const want = rippleForce( climb, speed, width );
		const maxHeld = opts.maxHeld ?? 16;
		const maxRings = opts.maxRings ?? 16;
		const d = Math.min( Math.max( dt, 0 ), 0.1 );
		this.dirX = opts.dirX ?? this.dirX;
		this.dirZ = opts.dirZ ?? this.dirZ;
		this.stretch = Math.min( RIPPLE_STRETCH_MAX, Math.max( 0, opts.stretch ?? this.stretch ) );
		this._cMin = Math.max( 0, opts.speedMin ?? 0 );
		this._cMax = Math.max( this._cMin, opts.speedMax ?? Infinity );
		this.time += d;
		const attack = Math.max( 0.12, life * 0.1 );
		this.force += ( want - this.force ) * ( 1 - Math.exp( - d / attack ) );
		const force = this.force;
		const sign = force < CRATER_AMP ? - 1 : 1;
		const matchR = Math.max( MATCH_MIN, width * 1.1 );
		const live = ( cuts ?? [] ).slice( 0, maxHeld ).map( ( c ) => {

			const o = outwardDir( c.side, this.dirX, this.dirZ, c );
			const arc = arcRangeFor( c );
			return {
				x: c.x, z: c.z, width, amp: 0, side: c.side,
				kind: c.kind, along: c.along, half: c.half,
				dirX: o.dirX, dirZ: o.dirZ, arc0: arc.arc0, arc1: arc.arc1,
			};

		} );

		const used = new Uint8Array( live.length );
		const next = [];
		let pulses = 0;
		const coolFor = Math.max( 0.55, life * 0.14 );
		const throwOne = ( x, z, gain, s, startRing, dirX, dirZ, arc0, arc1, cut ) => {

			if ( isBowEmitter( cut ) ) return;
			// Mid-body flanks slip; they do not paddle. Only the tail
			// half may still throw a leftover packet.
			if ( cut && cut.kind === 'flank' && ( cut.along ?? 0 ) < 3 ) return;
			if ( pulses >= maxRings || wave <= 0.04 || opts.deep ) return;
			if ( this.rings.length >= maxRings
				&& ! this._yieldFaded( maxRings )
				&& ! this._yieldLeft( x, z ) ) return;
			this._emit( x, z, width, speed, climb, life, wave, gain, s, startRing, dirX, dirZ, arc0, arc1 );
			pulses ++;

		};

		for ( let i = 0; i < this.held.length; i ++ ) {

			const h = this.held[ i ];
			let best = - 1, bestD = matchR;
			for ( let j = 0; j < live.length; j ++ ) {

				if ( used[ j ] ) continue;
				let dist = Math.hypot( live[ j ].x - h.x, live[ j ].z - h.z );
				if ( h.side != null && live[ j ].side != null && h.side !== live[ j ].side ) dist += 4;
				if ( dist < bestD ) { bestD = dist; best = j; }

			}
			if ( best >= 0 ) {

				used[ best ] = 1;
				h.released = false;
				const t = 1 - Math.exp( - d / 0.09 );
				h.x += ( live[ best ].x - h.x ) * t;
				h.z += ( live[ best ].z - h.z ) * t;
				h.width += ( width - h.width ) * t;
				h.amp += ( force - h.amp ) * ( 1 - Math.exp( - d / attack ) );
				h.dirX = live[ best ].dirX;
				h.dirZ = live[ best ].dirZ;
				h.side = live[ best ].side;
				h.kind = live[ best ].kind;
				h.along = live[ best ].along;
				h.arc0 = live[ best ].arc0;
				h.arc1 = live[ best ].arc1;
				h.cool = ( h.cool ?? 0 ) - d;
				const ready = ! h.pulsed;
				const again = h.pulsed && h.cool <= 0;
				if ( ready || again ) {

					h.pulsed = true;
					h.cool = coolFor;
					const throwG = Math.max( Math.abs( h.amp ), Math.abs( force ), 0.28 );
					throwOne( h.x, h.z, throwG * ( again ? 0.7 : 1 ), sign, 0, h.dirX, h.dirZ, h.arc0, h.arc1, h );

				}
				next.push( h );

			} else if ( ! h.released ) {

				// Leave: the live packet keeps running. Do not spawn a
				// second ring — that filled the slot list and killed
				// waves that were still decaying.
				h.released = true;

			}

		}
		for ( let j = 0; j < live.length; j ++ ) {

			if ( used[ j ] ) continue;
			const born = {
				x: live[ j ].x, z: live[ j ].z, width, amp: force,
				released: false, pulsed: true, cool: coolFor,
				dirX: live[ j ].dirX, dirZ: live[ j ].dirZ,
				side: live[ j ].side, kind: live[ j ].kind, along: live[ j ].along,
				arc0: live[ j ].arc0, arc1: live[ j ].arc1,
			};
			next.push( born );
			const wantSign = want < CRATER_AMP ? - 1 : 1;
			throwOne( born.x, born.z, Math.max( Math.abs( want ), Math.abs( force ), 0.28 ), wantSign, 0, born.dirX, born.dirZ, born.arc0, born.arc1, born );

		}
		this.held = next;
		this._stepBow( d, cuts, opts, width, force, attack, speed );

		const keep = [];
		for ( let i = 0; i < this.rings.length; i ++ ) {

			const r = this.rings[ i ];
			r.age += d;
			if ( r.age >= r.life ) continue;
			const u = 1 - r.age / r.life;
			const attack = Math.min( 1, r.age / RIPPLE_ATTACK );
			// Linear fade — u² went invisible by ~70% of life, which
			// read as the ring vanishing. Drop only when it has actually
			// died down (life elapsed, or the leftover is a whisper).
			r.amp = r.amp0 * u * attack;
			if ( Math.abs( r.amp ) < 0.015 ) continue;
			r.ring = r.c * r.age * r.wave;
			r.width = r.width0 * ( 1 + 0.35 * r.age / r.life );
			keep.push( r );

		}
		this.rings = keep;

	}

	_stepBow( d, cuts, opts, width, force, attack, speed ) {

		const hx = this.dirX;
		const hz = this.dirZ;
		const list = cuts ?? [];
		// Anatomical nose, not the foremost waterline cut. A body-wave
		// that ducks the head used to hand the heap to a mid-body spike;
		// the pile slid aft and then snapped back to the snout.
		let src = opts.nose && Number.isFinite( opts.nose.x ) ? opts.nose : null;
		if ( ! src && opts.fore && Number.isFinite( opts.fore.x ) ) src = opts.fore;
		if ( ! src ) {

			let bestD = - Infinity;
			for ( let i = 0; i < list.length; i ++ ) {

				const c = list[ i ];
				const dot = ( c.x ?? 0 ) * hx + ( c.z ?? 0 ) * hz;
				if ( dot > bestD ) { bestD = dot; src = c; }

			}

		}
		if ( opts.headWet === true ) this._headWetT = 0.28;
		else if ( opts.headWet === false ) this._headWetT = Math.max( 0, ( this._headWetT ?? 0 ) - d );
		const headOk = opts.headWet == null || ( this._headWetT ?? 0 ) > 0;
		const live = ! ! ( src && ! opts.deep && headOk && ( list.length || opts.nose ) );
		const b = this.bow;
		// Glue XZ to the snout EVERY frame, including while fading. Leaving
		// the heap in world space while the body swam on is what made it
		// slide aft and then jump back to the jaws.
		if ( src ) {

			b.x = src.x;
			b.z = src.z;
			b.dirX = hx;
			b.dirZ = hz;

		}
		if ( live ) {

			const t = 1 - Math.exp( - d / 0.09 );
			const half = src.half ?? width;
			const rhWant = Math.min(
				Math.max( half * 1.15, width * 1.1, 2.6 ),
				BOW_RH_MAX,
			);
			b.rh += ( rhWant - b.rh ) * t;
			const u = Math.min( Math.abs( speed ?? 0 ) / 12, 1 );
			const want = force < CRATER_AMP ? 0 : Math.max( 0.35, force ) * ( 1.05 + 0.70 * u );

			b.amp += ( want - b.amp ) * ( 1 - Math.exp( - d / attack ) );

		} else {

			b.amp += ( 0 - b.amp ) * ( 1 - Math.exp( - d / Math.max( attack, 0.18 ) ) );
			if ( Math.abs( b.amp ) < 0.02 ) b.amp = 0;

		}
		this._bowWasLive = live;

	}

	/** Drop the most faded ring if it has already died down. Healthy
	 *  rings are never evicted — that was the mid-travel pop. */
	_yieldFaded( maxRings ) {

		if ( this.rings.length < maxRings ) return true;
		let worst = - 1, worstU = 1;
		for ( let i = 0; i < this.rings.length; i ++ ) {

			const r = this.rings[ i ];
			const u = Math.max( 0, 1 - r.age / r.life );
			if ( u < worstU ) { worstU = u; worst = i; }

		}
		if ( worst < 0 || worstU >= 0.22 ) return false;
		this.rings.splice( worst, 1 );
		return true;

	}

	/** Free a slot by dropping THIS origin's packet only after it has
	 *  already left the cut. Evicting a neighbour's healthy ring was
	 *  the mid-travel pop; leaving the slot full meant a live point
	 *  threw once and then went quiet. */
	_yieldLeft( x, z ) {

		let best = - 1, bestAge = - 1;
		for ( let i = 0; i < this.rings.length; i ++ ) {

			const r = this.rings[ i ];
			if ( Math.hypot( r.x - x, r.z - z ) > 3.5 ) continue;
			if ( r.ring < Math.max( r.width * 2.2, 6 ) ) continue;
			if ( r.age > bestAge ) { bestAge = r.age; best = i; }

		}
		if ( best < 0 ) return false;
		this.rings.splice( best, 1 );
		return true;

	}

	/** One leftover packet at a world XZ — a tail slap that never
	 *  held a waterline cut still has to throw if Thrown ripples is on. */
	throwAt( x, z, opts = {} ) {

		const width = opts.width ?? 2.9;
		const wave = opts.wave ?? 0.82;
		if ( wave <= 0.04 ) return false;
		const cap = opts.maxRings ?? 16;
		if ( this.rings.length >= cap
			&& ! this._yieldFaded( cap )
			&& ! this._yieldLeft( x, z ) ) return false;
		this._emit(
			x, z, width, opts.speed ?? 8, opts.climb ?? 1,
			opts.life ?? 7, wave, opts.gain ?? 1, 1, 0,
			opts.dirX ?? this.dirX, opts.dirZ ?? this.dirZ,
			RIPPLE_ARC_COS0, RIPPLE_ARC_COS1,
		);
		return true;

	}

	_emit( x, z, width, speed, climb, life, wave, gain, sign, startRing, dirX, dirZ, arc0, arc1 ) {

		const e = rippleEnergy( width, speed, climb );
		const lambda = rippleLambda( width, speed );
		// Artist-scaled so a ring actually leaves the body on a 60 m
		// animal. Raw deep-water c for λ≈6 m is ~3 m/s — a few metres
		// in a second, lost under the mesh.
		let c = rippleSpeed( lambda ) * ( 1.35 + 0.95 * wave );
		c = Math.min( this._cMax, Math.max( this._cMin, c ) );
		const s = sign < 0 ? - 1 : 1;
		const lifeR = life * ( 1.15 + 0.55 * e );
		const packL = Math.max( width * RIPPLE_LAMBDA, RIPPLE_LAMBDA_MIN );
		const width0 = Math.max( width * 1.15, packL * 0.38, 3.2 );
		const launch = Math.max( startRing ?? 0, 0 );
		let age = 0;
		let ring = 0;
		if ( launch > 0 && c * Math.max( wave, 0.15 ) > 0.01 ) {

			const travel = c * Math.max( wave, 0.15 );
			age = launch / travel;
			if ( age >= lifeR ) return;
			ring = launch;

		}
		const u = 1 - age / lifeR;
		const a0 = Math.max( Math.abs( gain ), 0.28 ) * ( 0.55 + 0.35 * e ) * s;
		this.rings.push( {
			x, z,
			age,
			life: lifeR,
			c,
			wave: Math.max( wave, 0.15 ),
			width0,
			width: width0,
			ring,
			amp0: a0,
			amp: a0 * u,
			// Frozen at emit. Live heading used to reshape every ring
			// when the body turned, which sheared waves that had already
			// left and read as a sharp, rotating grid.
			dirX: dirX ?? this.dirX,
			dirZ: dirZ ?? this.dirZ,
			stretch: this.stretch,
			arc0: arc0 ?? RIPPLE_ARC_COS0,
			arc1: arc1 ?? RIPPLE_ARC_COS1,
		} );

	}

	/** Shader-ready sites. Packets only — a held cut is not a mound. */
	sites( cap ) {

		const out = [];
		for ( let i = 0; i < this.rings.length && out.length < cap; i ++ ) {

			const r = this.rings[ i ];
			if ( Math.abs( r.amp ) < 0.02 ) continue;
			out.push( {
				x: r.x, z: r.z, ring: r.ring, width: r.width, amp: r.amp,
				dirX: r.dirX ?? 0, dirZ: r.dirZ ?? 1, stretch: r.stretch ?? 0,
				arc0: r.arc0 ?? RIPPLE_ARC_COS0, arc1: r.arc1 ?? RIPPLE_ARC_COS1,
			} );

		}
		return out;

	}

}
