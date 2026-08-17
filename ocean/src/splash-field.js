// Water-entry field for a large ANIMAL landing on the sea.
//
// Reference: humpback breach footage (youtu.be/5hBfdI_2MO8) and stills off it.
// This started as the textbook rigid-body water entry — cavity, symmetric
// crown, tall Worthington jet — and that is NOT what a breaching whale does,
// because a whale is not a sphere dropped down a tube. It comes down along its
// length, on its side or back, and the frames show:
//
//   * a broad white CURTAIN thrown BROADSIDE, port and starboard, in two
//     diverging wings roughly as long as the animal - wide and comparatively
//     low, with a feathered ragged top, not a ring of equal-height fingers
//   * only a modest central surge where the water closes over the body. There
//     is no needle spout: the body is still filling the hole. A tall thin jet
//     was the single most artificial thing in the first version
//   * DENSE white water. The curtain and the patch it collapses into are
//     nearly opaque - foam is the picture here, geometry is the frame for it
//   * an aftermath that is a long white MOUND elongated along the body, soft
//     edged, sitting there while it spreads - not a concentric ring
//
// Sequence, then (t = seconds since the hit):
//
//   0.00  the body slaps in and throws the curtain sideways; the hole opens
//   0.15  the curtain is at full height, feathering apart at the top
//   0.30  the cavity closes and a low central surge comes up through it
//   1.5   a smaller second surge
//   0-6   gravity waves run outward and the white mound spreads and thins
//
// EVERYTHING SCALES WITH THE HIT. A fixed-radius crater is the tell that
// makes a leviathan's landing read the same size as a thrown rock: the
// radius grows with sqrt(energy) and with the body's own length, so a
// 120 m animal opens twice the hole a 30 m one does.
//
// THE CROWN IS PARTICLES SCATTERED ONTO THE SURFACE, not a painted gaussian
// ridge. matsuoka-601/Splash is a full MLS-MPM fluid (P2G / grid pressure /
// G2P, screen-space surface). We cannot drop that solver onto an FFT ocean,
// but the picture it buys is the two-way coupling: water leaves as discrete
// parcels, those parcels ARE the crown (a broken wall of sheets), the hole
// they leave is the cavity (volume conservation), droplets break from the
// lip, and when a parcel falls back it stamps foam and a small height. The
// implicit P2G below is that idea without a 3D grid — same azimuths the
// spray emitter uses, so the mesh and the particles describe one splash.
//
// The TSL in water-surface.js is a transcription of these functions. Keep
// the constants identical — tools/check-splash-field.mjs is the CPU twin
// and it is what proves the shape, since the shader cannot be unit-tested.

const smoothstep = ( e0, e1, x ) => {

	const t = Math.min( 1, Math.max( 0, ( x - e0 ) / ( e1 - e0 ) ) );
	return t * t * ( 3 - 2 * t );

};

const gauss = ( x, w ) => Math.exp( - ( x * x ) / ( w * w ) );

/**
 * How much of a water entry is happening right now, 0..1, from the spray context.
 *
 * Lives here rather than in either renderer because both need it and a second copy
 * would drift: the particle sim gates the entry burst on it, and the DRAW pass
 * needs it to size the sprites. Sprite size is the difference between a mass of
 * water and a field of dots - what a breaching body throws is parcels metres
 * across, while the spray radius is tuned for wind-torn droplets - and only the
 * draw pass can set size, since size is a pure function of the particle index.
 */
export function entryAmount( ctx ) {

	return ( ctx?.craftPierce ?? 0 ) * smoothstep( 0.15, 0.8, ctx?.craftImpact ?? 0 );

}

/** Body-length gain on every length in the field. 60 m is the reference. */
export function splashLengthScale( len ) {

	return Math.pow( Math.min( Math.max( ( len || 60 ) / 60, 0.3 ), 3 ), 0.6 );

}

/** Radius the crown starts at: the hole the body itself made. */
export function splashBaseRadius( energy, len ) {

	return ( 3.4 + 3.6 * Math.sqrt( Math.max( energy, 0 ) ) ) * splashLengthScale( len );

}

export function splashCoords( x, z, px, pz, dirx, dirz, len ) {

	const along = ( x - px ) * dirx + ( z - pz ) * dirz;
	const across = ( x - px ) * ( - dirz ) + ( z - pz ) * dirx;
	// A body enters at an angle, so the hole is a slot, not a disc — but a
	// hard ellipse reads as a stretched cigar, so this stays mild.
	const aspect = Math.min( Math.max( 1 + ( len || 60 ) * 0.012, 1.2 ), 2.2 );
	const r = Math.hypot( along / aspect, across );
	const ang = Math.atan2( across, along );
	return { r, ang, along, across };

}

/**
 * Crown radius. Expands fast and decelerates — the rim is throwing water
 * outward against gravity, not travelling at a constant speed.
 */
export function splashCrownRadius( t, energy, len ) {

	const r0 = splashBaseRadius( energy, len );
	const spread = 26 * splashLengthScale( len );
	return r0 + spread * t / ( 1 + 0.62 * t );

}

/**
 * The crown's azimuthal break-up. Three harmonics at ratios that do not
 * share a period, with FIXED phases: real fingers stand where they formed
 * and grow, they do not rotate around the rim. This is what stops the
 * crown reading as a torus — one sine leaves a visibly periodic scallop.
 */
export function splashFingers( ang, sharp = 0.42 ) {

	const f = 0.55 * Math.sin( ang * 7 + 1.3 )
		+ 0.30 * Math.sin( ang * 13 + 4.7 )
		+ 0.15 * Math.sin( ang * 23 + 2.1 );
	return 1 - sharp + sharp * f;

}

/**
 * BROADSIDE, NOT ALL ROUND. ang is measured from the body's own heading, so
 * |sin| is how far off the bow a point is: an animal coming down along its
 * length throws its water to port and starboard, and comparatively little
 * ahead of the nose or behind the tail. This one factor is most of what
 * separates the reference frames from the ring the first version drew.
 */
export function splashWing( ang ) {

	return 0.06 + 0.94 * Math.pow( Math.abs( Math.sin( ang ) ), 2.2 );

}

// Implicit P2G: a small, fixed set of water parcels. 16 is enough to read as
// a broken wall and few enough that the TSL twin can evaluate the 3 nearest
// without a Loop (WebKit's 8 KB private-space budget, porting rule 17).
export const SPLASH_PARCELS = 16;
export const SPLASH_DROPS = 12;

/** Deterministic 0..1. Same formula the TSL twin uses — do not "improve". */
export function splashHash( i ) {

	const x = Math.sin( i * 127.1 + 311.7 ) * 43758.5453;
	return x - Math.floor( x );

}

export function splashAngWrap( a ) {

	return Math.atan2( Math.sin( a ), Math.cos( a ) );

}

/**
 * One crown sheet. Azimuth is a jittered slot so the wall has holes; mass
 * carries the broadside wing so bow/stern parcels stay small. `speed` is
 * how far past the mean rim this sheet travels — they do not sit on a torus.
 */
export function splashParcel( i, n = SPLASH_PARCELS ) {

	const u = splashHash( i + 0.31 );
	const v = splashHash( i + 8.17 );
	const w = splashHash( i + 19.4 );
	const slot = ( ( i + 0.5 ) / n ) * Math.PI * 2;
	const ang = slot + ( u - 0.5 ) * ( Math.PI * 2 / n ) * 0.50;
	const wing = splashWing( ang );
	const mass = ( 0.28 + 0.72 * wing ) * ( 0.70 + 0.50 * v );
	const speed = 0.80 + 0.40 * w;
	return { ang, mass, speed, wing };

}

/** Smaller, faster lip-break droplet. Sits just off a crown sheet. */
export function splashDroplet( i ) {

	const p = splashParcel( i % SPLASH_PARCELS );
	const u = splashHash( i + 41.2 );
	const ang = p.ang + ( u - 0.5 ) * 0.28;
	const mass = p.mass * ( 0.18 + 0.16 * splashHash( i + 3.9 ) );
	const speed = p.speed * ( 1.15 + 0.35 * splashHash( i + 7.2 ) );
	return { ang, mass, speed, wing: splashWing( ang ) };

}

/** The three slots that can touch `ang`. Shader evaluates only these. */
export function splashNearSlots( ang, n ) {

	const tau = Math.PI * 2;
	const u = ( ( ang / tau ) % 1 + 1 ) % 1;
	const slot = Math.round( u * n ) % n;
	return [ ( slot + n - 1 ) % n, slot, ( slot + 1 ) % n ];

}

function parcelKernel( r, ang, rP, pAng, wr, wa ) {

	const dA = splashAngWrap( ang - pAng );
	return gauss( r - rP, wr ) * gauss( dA * rP, wa );

}

/** Where a sheet sits on the expanding rim. Tight on rCrown so a sample
 *  at the crown radius hits the wall, not the crater tail. */
export function splashParcelRadius( rCrown, speed ) {

	return rCrown * ( 0.94 + 0.10 * speed );

}

export function splashHeight( r, ang, t, energy, len = 60 ) {

	const E = Math.max( energy, 0 );
	const Lk = splashLengthScale( len );
	const r0 = splashBaseRadius( E, len );
	const rCrown = splashCrownRadius( t, E, len );
	const crownEnv = smoothstep( 0, 0.12, t ) * Math.exp( - 1.30 * t );
	const craterEnv = smoothstep( 0, 0.05, t ) * Math.exp( - 1.15 * t );

	// THE CURTAIN, as discrete sheets. A smooth gaussian ridge around rCrown
	// is a dune / torus no matter how hard splashFingers notches it; each
	// parcel is a narrow kernel in r and θ, so the gaps are real holes.
	// Envelope is the throw: rises over ~120 ms, stands, falls back.
	const wr = ( 0.16 + 0.18 * t ) * r0;
	const wa0 = 0.34 * ( Math.PI * 2 / SPLASH_PARCELS );
	let crown = 0;
	let returned = 0;
	for ( const i of splashNearSlots( ang, SPLASH_PARCELS ) ) {

		const p = splashParcel( i );
		const rP = splashParcelRadius( rCrown, p.speed );
		const wa = wa0 * Math.max( rP, r0 * 0.5 );
		const kern = parcelKernel( r, ang, rP, p.ang, wr, wa );
		crown += E * 2.05 * Lk * crownEnv * p.mass * kern;

		// TWO-WAY: this sheet's water falling back stamps a small mound
		// where it lands. tLand is per-parcel so the wall does not collapse
		// as one ring.
		const tLand = 0.36 + 0.22 * splashHash( i + 11.0 );
		const landEnv = smoothstep( tLand, tLand + 0.10, t )
			* Math.exp( - 1.55 * Math.max( 0, t - tLand ) );
		const rLand = splashParcelRadius( splashCrownRadius( tLand, E, len ), p.speed );
		const wLand = ( 0.22 + 0.28 * Math.max( 0, t - tLand ) ) * r0;
		returned += E * 0.42 * Lk * landEnv * p.mass
			* parcelKernel( r, ang, rLand, p.ang, wLand, wa * 1.15 );

	}

	// SECONDARY DROPLETS breaking from the crown lip, ahead of the rim.
	const dropEnv = smoothstep( 0.10, 0.22, t ) * Math.exp( - 2.0 * Math.max( 0, t - 0.10 ) );
	const wrD = ( 0.07 + 0.10 * t ) * r0;
	const waD0 = 0.32 * ( Math.PI * 2 / SPLASH_DROPS );
	let drops = 0;
	for ( const i of splashNearSlots( ang, SPLASH_DROPS ) ) {

		const d = splashDroplet( i );
		const rD = rCrown * ( 1.06 + 0.38 * d.speed );
		const waD = waD0 * Math.max( rD, r0 * 0.5 );
		drops += E * 0.55 * Lk * dropEnv * d.mass * d.wing
			* parcelKernel( r, ang, rD, d.ang, wrD, waD );

	}

	// CAVITY from volume conservation: the hole is the body's own slot plus
	// the water still airborne. As crownEnv dies the thrown volume comes
	// back (returned, above) and this term shallows with it.
	const crater = - E * Lk * ( 0.58 * craterEnv + 0.40 * crownEnv )
		* gauss( r, r0 * 0.70 );

	// THE CENTRAL SURGE, where the water closes over the body. A textbook
	// Worthington jet - one narrow column taller than the crown - is what a
	// sphere fired into still water does, and rendered on an animal it looked
	// like a sand castle with a spike on top. In the footage the middle is a
	// low broad heave with at most a short stub standing out of it, because the
	// body is still down there filling the cavity. So: mostly collar, a little
	// column, and it does NOT out-throw the curtain.
	const jetEnv = smoothstep( 0.20, 0.42, t ) * ( 1 - smoothstep( 0.95, 1.75, t ) );
	const jet = E * Lk * jetEnv
		* ( 0.62 * gauss( r, r0 * 0.20 ) + 0.55 * gauss( r, r0 * 0.62 ) );

	// It settles and heaves once more, smaller. Cheap, and it is the difference
	// between one event and something still happening.
	const jet2Env = smoothstep( 1.5, 1.9, t ) * ( 1 - smoothstep( 2.3, 3.2, t ) );
	const jet2 = E * 0.45 * Lk * jet2Env * gauss( r, r0 * 0.30 );

	// GRAVITY WAVE TRAIN, running outward for seconds after the impact is
	// over. The crown rim IS the leading crest — the sheet collapses into the
	// first wave rather than the two racing each other — so the train hangs
	// off rCrown and its phase is zero there. Amplitude falls as 1/sqrt(r)
	// (the same energy spread around a growing circle) and the outer gate
	// keeps anything from appearing ahead of the front.
	const k = 0.62 / Lk;
	const train = E * 0.34 * Lk * Math.exp( - 0.30 * t )
		/ Math.sqrt( 1 + r / r0 )
		* smoothstep( 0.10, 0.35, t )
		* ( 1 - smoothstep( rCrown * 0.80, rCrown * 1.10, r ) )
		* smoothstep( r0 * 0.6, r0 * 1.3, r )
		* Math.sin( k * ( rCrown - r ) );

	return crown + drops + returned + crater + jet + jet2 + train;

}

export function splashFoam( r, ang, t, energy, len = 60 ) {

	const E = Math.max( energy, 0 );
	const r0 = splashBaseRadius( E, len );
	const rCrown = splashCrownRadius( t, E, len );

	// FOAM IS THE PICTURE. In the reference frames the curtain and the patch it
	// falls into are nearly opaque white, and the sea only shows through at the
	// feathered edges - so coverage here is high on purpose.
	//
	// It did not start that way: high coverage first came out looking like a
	// SAND DUNE, and the culprit was measured (prototypes/splash-look.html
	// ?foam=0 / ?detail=0) to be the near-field bubble relief in
	// water-detail.js - 25 cm clumps and 6 cm caps, alive at any footprint a
	// splash sits inside - being worn by a 40 m crater. That is now flattened
	// where the splash is churning (water-surface.js's `churn`), which is what
	// makes dense coverage read as whitewater instead of sand. Coverage was the
	// symptom; the relief was the cause.
	//
	// Rim foam follows the same parcels as the height, so the white sits on
	// the broken wall rather than painting a smooth ring the mesh then
	// contradicts. Return stamps are the P2G write-back: fallen water leaves
	// foam where it landed.
	const wr = ( 0.18 + 0.22 * t ) * r0;
	const wa0 = 0.55 * ( Math.PI * 2 / SPLASH_PARCELS );
	let rim = 0;
	let landed = 0;
	for ( const i of splashNearSlots( ang, SPLASH_PARCELS ) ) {

		const p = splashParcel( i );
		const rP = splashParcelRadius( rCrown, p.speed );
		const wa = wa0 * Math.max( rP, r0 * 0.5 );
		rim += 1.25 * Math.exp( - 0.80 * t ) * p.mass
			* parcelKernel( r, ang, rP, p.ang, wr, wa );

		const tLand = 0.36 + 0.22 * splashHash( i + 11.0 );
		const landEnv = smoothstep( tLand, tLand + 0.10, t )
			* Math.exp( - 0.85 * Math.max( 0, t - tLand ) );
		const rLand = splashParcelRadius( splashCrownRadius( tLand, E, len ), p.speed );
		const wLand = ( 0.28 + 0.40 * Math.max( 0, t - tLand ) ) * r0;
		landed += 0.72 * landEnv * p.mass
			* parcelKernel( r, ang, rLand, p.ang, wLand, wa * 1.20 );

	}

	const dropEnv = smoothstep( 0.10, 0.22, t ) * Math.exp( - 1.6 * Math.max( 0, t - 0.10 ) );
	const wrD = ( 0.10 + 0.14 * t ) * r0;
	const waD0 = 0.36 * ( Math.PI * 2 / SPLASH_DROPS );
	let dropFoam = 0;
	for ( const i of splashNearSlots( ang, SPLASH_DROPS ) ) {

		const d = splashDroplet( i );
		const rD = rCrown * ( 1.06 + 0.38 * d.speed );
		const waD = waD0 * Math.max( rD, r0 * 0.5 );
		dropFoam += 0.55 * dropEnv * d.mass * d.wing
			* parcelKernel( r, ang, rD, d.ang, wrD, waD );

	}

	// The churned patch. Elongated along the body for free, because r is
	// measured in splash space (splashCoords stretches it along the heading) -
	// which is what makes the aftermath a long white mound rather than a disc.
	// Streaked, because water draining off a curtain runs outward in spokes and
	// because a perfectly even fill is the one thing that always reads as paint.
	const streaks = ( 0.68 + 0.32 * ( 0.5 + 0.5 * Math.sin( ang * 17 + 1.1 ) ) )
		* ( 0.82 + 0.18 * Math.sin( r * 2.6 / r0 ) );
	const disk = 0.80 * Math.exp( - 0.70 * t )
		* gauss( r, r0 * ( 0.80 + 0.45 * t ) ) * streaks;

	// What is still on the water after it has stopped moving: keeps spreading,
	// keeps thinning, gone by about six seconds.
	const raft = 0.32 * Math.exp( - 0.38 * t )
		* gauss( r, r0 * ( 1.0 + 0.85 * t ) )
		* ( 0.55 + 0.45 * Math.sin( ang * 9 + 0.7 ) );

	const total = ( rim + landed + dropFoam + disk + raft ) * Math.min( E, 2.2 ) / 2.2;
	return Math.min( 0.96, Math.max( 0, total ) );

}
