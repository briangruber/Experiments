// Hull-wake whitewater: coverage from breaking waves, shape from lace.
//
// CPU twin of the TSL film in src/gpu/tsl/wake-suds.js. A changed digit here
// is a changed image there — tools/check-wake-suds.mjs is the contract.
//
// The existing foam-energy ribbon answers WHERE by painting the hull's swept
// path and then advecting it. This module answers the same question from the
// water instead: a wave carries foam when it is too steep to hold together,
// and steepness is amplitude times wavenumber. Past a critical value the
// crest spills.
//
// That single change is why the arms come out right. Coverage inherits the
// wave field's own geometry — it lands on the cusp line where the divergent
// and transverse systems merge and the amplitude piles up, and it follows
// speed, Froude number, hull length and turn without being told to, because
// all of those are already in the amplitude and the wavenumber. Nothing here
// knows the Kelvin angle. AGENTS.md records what the alternative cost: gating
// coverage on a heading-relative locus put a ridge in the field along that
// ray, and because the ray is straight in the LIVE frame, a turn swept a
// drawn V across trail laid under an older heading.
//
// Failure modes already rejected, in the prototype this came from:
//   threshold the ridge function directly  → nested outlines, a contour map
//   sample position scaled by coverage     → lace snaps to iso-contours of
//                                            foam (the same contour map, via
//                                            a warp along its gradient)
//   bare smoothstep on coverage            → hard cut-out edge, a white decal
//   lace drawn below a cell per pixel      → sparkle
//
// Return values are coverage and opacity in 0..1. Coverage is how much of the
// water here is aerated; opacity is how much of it you can see through.

const clamp = ( x, a, b ) => Math.min( b, Math.max( a, x ) );
const clamp01 = ( x ) => clamp( x, 0, 1 );
const mix = ( a, b, t ) => a + ( b - a ) * t;
const smoothstep = ( e0, e1, x ) => {

	const t = clamp01( ( x - e0 ) / ( e1 - e0 ) );
	return t * t * ( 3 - 2 * t );

};

/** Gravity, matching KELVIN_G in wake-physics.js. */
export const SUDS_G = 9.81;

/**
 * Critical steepness ak at which a crest spills.
 *
 * The Stokes limit is ak = 0.443, but that is the height at which an ideal
 * deep-water wave ceases to exist at all. Real crests in a wake shed white
 * water well before that — this is a look number, tuned on the prototype,
 * and it sits where a planing hull's divergent arms break and its transverse
 * system mostly does not.
 */
export const SUDS_BREAK_STEEP = 0.08;

/** Width of the break, as a multiple of the critical steepness. */
export const SUDS_BREAK_SPAN = 2.4;

/**
 * Speed below which a hull is not radiating a wave worth the name, m/s.
 * Both the bound on the wavelength and the ramp that fades it in — a hard
 * cutoff here pops the whole wake on at the moment of casting off.
 */
export const SUDS_CRAWL = 0.05;

/**
 * The transverse system breaks later and weaker than the divergent one: its
 * crests are longer, flatter and running with the hull rather than away from
 * it. Same criterion, less of the result.
 */
export const SUDS_TRANSVERSE = 0.55;

/**
 * Deep-water wavenumber of the wave a hull at `speed` radiates.
 *
 * k = g / c², and the wave that keeps station with the hull has c = U. So a
 * fast hull makes LONG waves, which need proportionally more amplitude to
 * reach the same steepness — the reason a planing wake's foam is confined to
 * the arms while a displacement wake at the hump froths across its whole
 * transverse system.
 */
export function sudsWavenumber( speed ) {

	const u = Math.abs( speed );
	const c = Math.max( u, SUDS_CRAWL );
	// A ramp, not a cutoff: coverage reaches zero at rest instead of the whole
	// wake popping on at the moment of casting off. Written branchlessly so
	// the shader twin is the same expression rather than a lookalike.
	return SUDS_G / ( c * c ) * smoothstep( 0, SUDS_CRAWL, u );

}

/**
 * Crest-face gate. Foam is shed off the front of a breaking crest, so it must
 * not fill the trough behind it — that reads as a white disk rather than as
 * water breaking. `cosPhase` is cos of the wave's own phase, 1 on the crest.
 */
export function sudsCrestGate( cosPhase ) {

	return smoothstep( - 0.15, 0.80, cosPhase );

}

/**
 * Coverage from a breaking wave. `amp` metres, `k` rad/m, `cosPhase` the
 * wave phase at this point.
 *
 * Below critical this returns exactly 0 — bare waves do not make foam, and
 * a wake that is merely present does not either. That zero is the whole
 * point of the module: it is what lets coverage be driven by the wave field
 * without the field painting white over every disturbed square metre.
 */
export function sudsBreak( amp, k, cosPhase = 1, opts = {} ) {

	const crit = Math.max( opts.critical ?? SUDS_BREAK_STEEP, 1e-4 );
	const steep = Math.max( amp, 0 ) * Math.max( k, 0 );
	return smoothstep( crit, crit * SUDS_BREAK_SPAN, steep )
		* sudsCrestGate( cosPhase );

}

/**
 * The two wave systems together, as the shader sums them.
 *
 * `div` / `trans` are the amplitudes of the divergent and transverse systems
 * at this point, already carrying whatever the wake model says about fetch,
 * age, hump and turn.
 */
export function sudsBreakField( div, trans, k, cosDiv = 1, cosTrans = 1, opts = {} ) {

	return clamp01(
		sudsBreak( div, k, cosDiv, opts )
		+ sudsBreak( trans, k, cosTrans, opts ) * SUDS_TRANSVERSE,
	);

}

// ---------------------------------------------------------------- the lace --
//
// Coverage says how much water is aerated. The lace says what that looks
// like, and it is shaded per-pixel rather than baked, because a bubble raft
// is finer than any texel a wake field can afford and because it costs
// nothing on the ~90% of a frame that is open water.

/** Lace softness floor. Below this the threshold is a cut-out, not a fringe. */
export const SUDS_SOFTNESS = 0.30;
/** Grain / cell weights of the detail field. See sudsDetail(). */
export const SUDS_GRAIN_WEIGHT = 0.68;
export const SUDS_CELL_WEIGHT = 0.46;
/** Cell-wall width, and how much thinning foam coarsens it. */
export const SUDS_WALL = 0.125;
export const SUDS_COARSEN = 0.085;

/**
 * Cell-wall width for foam of this coverage.
 *
 * A bubble raft coarsens as it ages and thins, so old foam wants wider, more
 * open cells. Widening the WALL is the safe way to say that. The tempting
 * alternative — scaling the sample position by coverage — warps the noise
 * along coverage's own gradient, and the lace then snaps onto iso-contours of
 * foam and reads as a contour map. Nothing in this module may move the
 * sampling point by a spatially varying quantity; sudsLacePoint() is the
 * proof, and the check asserts it ignores coverage.
 */
export function sudsWallWidth( coverage, coarsen = 1 ) {

	return SUDS_WALL + SUDS_COARSEN * Math.max( coarsen, 0 )
		* ( 1 - clamp01( coverage ) );

}

/**
 * Where to sample the lace, in world metres.
 *
 * Every term is a bounded local offset: orbital surge with the passing wave,
 * and an outward shove as each wavefront sweeps by. Both return to zero once
 * the wave has passed, so the pattern distorts without ever being
 * transported — the lace belongs to the water rather than sliding over it.
 *
 * Deliberately not a function of coverage. See sudsWallWidth().
 */
export function sudsLacePoint( world, slope = [ 0, 0 ], rings = [ 0, 0 ], opts = {} ) {

	const drift = opts.drift ?? 1;
	const ring = opts.ring ?? 0;
	const scale = Math.max( opts.scale ?? 1, 1e-3 );
	return [
		( world[ 0 ] + slope[ 0 ] * drift * 5.0 + rings[ 0 ] * ring ) * scale,
		( world[ 1 ] + slope[ 1 ] * drift * 5.0 + rings[ 1 ] * ring ) * scale,
	];

}

/**
 * Combine smooth grain with the cellular ridge into the field the threshold
 * slides through.
 *
 * Grain-dominant on purpose. The cell function is a RIDGE — bright on the
 * contour and dark either side — so thresholding it directly yields nested
 * outlines, which is a contour map and not a bubble raft. It belongs here as
 * an accent on smooth noise; cell SIZE comes from the sampling scale instead.
 */
export function sudsDetail( grain, cells ) {

	return clamp01( grain * SUDS_GRAIN_WEIGHT + cells * SUDS_CELL_WEIGHT );

}

/**
 * Fade the lace toward flat as a cell drops below a couple of pixels.
 * Sub-pixel lace aliases into sparkle. `px` is the screen-space footprint of
 * this pixel in metres; `scale` the lace frequency.
 */
export function sudsCrisp( px, scale ) {

	const cell = 1 / Math.max( scale, 1e-3 );
	return 1 - smoothstep( 0.22, 0.75, Math.max( px, 0 ) / cell );

}

/**
 * The lace itself: coverage slides a threshold down through the detail field.
 * Dense foam takes all of it, thin foam keeps only the cell walls, and the
 * transition between the two is the lacy fringe.
 */
export function sudsLace( detail, coverage, softness = SUDS_SOFTNESS ) {

	const b = Math.max( softness, 0.02 );
	const f = Math.max( coverage, 0 );
	return smoothstep( 1 - f - b, 1 - f + b, clamp01( detail ) );

}

/**
 * Beer–Lambert opacity: how much of the water below is still visible through
 * the bubbles above it.
 *
 * Opacity accumulates exponentially with how much foam is present, so it
 * approaches white asymptotically and never lands on the hard cut-out edge a
 * bare threshold produces. This is what makes the fringe mesh with the
 * surface instead of being pasted onto it — and it is why the value is
 * strictly below 1 for any finite amount of foam.
 */
export function sudsOpacity( lace, coverage, density = 1, laceAmount = 0 ) {

	const t = Math.max( lace, 0 ) * Math.max( coverage, 0 )
		* Math.max( density, 0 ) * mix( 1, 1.6, clamp01( laceAmount ) );
	return 1 - Math.exp( - t );

}

/**
 * Bubbles pool in the troughs and thin over the crests, so the lace drapes
 * over the swell rather than ignoring it. `height` is the local surface
 * height against `amp`, the swell it is riding.
 */
export function sudsTroughBias( coverage, height, amp, bias = 0 ) {

	const t = clamp( - height / Math.max( amp, 0.02 ), - 1, 1 );
	return Math.max( coverage, 0 ) * ( 1 + t * bias );

}

// ------------------------------------------------------------- prop wash --
//
// The white channels behind a transom are one per screw, not one per boat.
// They are born separate at the stern and merge some way aft, which is the
// read that tells you how many engines are on the bracket.

/** Lateral offsets of `n` wash lanes, in metres, symmetric about the keel. */
export function sudsWashLanes( engines, spacing ) {

	const n = Math.max( 1, Math.round( engines || 1 ) );
	const gap = Math.max( spacing || 0, 0 );
	const lanes = [];
	for ( let i = 0; i < n; i ++ ) lanes.push( ( i - ( n - 1 ) * 0.5 ) * gap );
	return lanes;

}

/**
 * Wash coverage at lateral offset `lat`, summed over the lanes. Each screw
 * throws a plume that widens with distance aft, so lanes that leave the
 * transom distinct merge downstream on their own.
 */
export function sudsWash( lat, aft, engines, spacing, opts = {} ) {

	const width = Math.max( opts.width ?? 0.5, 0.02 );
	const spread = opts.spread ?? 0.06;
	const w = width + Math.max( aft, 0 ) * spread;
	let sum = 0;
	for ( const off of sudsWashLanes( engines, spacing ) ) {

		const d = ( lat - off ) / w;
		sum += Math.exp( - d * d );

	}
	return clamp01( sum );

}
