// CPU twin of the wind-foam field.
//
// Shader copies: src/gpu/tsl/water-detail.js `foamField` and
// src/shaders/water.js. A changed digit here is a changed image there —
// tools/check-foam-lace.mjs is the contract.
//
// Jacobian / fold (FFT foamF/foamR) answers WHERE. This field is only the
// brightness structure inside that footprint — not a stencil. Wake and
// wind coverage stay films; the lace wrinkles them. Grain is brightness
// only.
//
// Failure modes already rejected live:
//   occupied (1−F1) cell fills     → discs
//   thin F2−F1 as the only term    → glowing wireframe
//   domain-warped fbm patches      → unstructured cloud
//   unstretched regular F2−F1      → hexagonal tray
//   wake × a wall field            → honeycomb around the hull
//     (leftover × the procedural web: swirls under the foam image.
//     Live leftover is energy × the image, or a smooth film.)
//
// Return: { field, thick }. `field` is 0..1, high on the lace, collapsing
// to 0.5 once a pixel spans several cells. `thick` is optical thickness
// (junction cores brighter than mid-edge). Grain never writes coverage.

const fract = ( x ) => x - Math.floor( x );

function hash13( x, y, z ) {

	let px = fract( x * 0.1031 );
	let py = fract( y * 0.1031 );
	let pz = fract( z * 0.1031 );
	const d = px * ( pz + 31.32 ) + py * ( py + 31.32 ) + pz * ( px + 31.32 );
	px += d;
	py += d;
	pz += d;
	return fract( ( px + py ) * pz );

}

function hash12( x, y ) {

	let px = fract( x * 0.1031 );
	let py = fract( y * 0.1031 );
	let pz = fract( x * 0.1031 );
	const d = px * ( py + 33.33 ) + py * ( pz + 33.33 ) + pz * ( px + 33.33 );
	px += d;
	py += d;
	pz += d;
	return fract( ( px + py ) * pz );

}

function hash22( x, y ) {

	let px = fract( x * 0.1031 );
	let py = fract( y * 0.1030 );
	let pz = fract( x * 0.0973 );
	const d = px * ( py + 33.33 ) + py * ( pz + 33.33 ) + pz * ( px + 33.33 );
	px += d;
	py += d;
	pz += d;
	return [ fract( ( px + py ) * pz ), fract( ( px + pz ) * py ) ];

}

function vnoise( x, y, z ) {

	const ix = Math.floor( x ), iy = Math.floor( y ), iz = Math.floor( z );
	let fx = x - ix, fy = y - iy, fz = z - iz;
	fx = fx * fx * ( 3 - 2 * fx );
	fy = fy * fy * ( 3 - 2 * fy );
	fz = fz * fz * ( 3 - 2 * fz );
	const n000 = hash13( ix, iy, iz );
	const n100 = hash13( ix + 1, iy, iz );
	const n010 = hash13( ix, iy + 1, iz );
	const n110 = hash13( ix + 1, iy + 1, iz );
	const n001 = hash13( ix, iy, iz + 1 );
	const n101 = hash13( ix + 1, iy, iz + 1 );
	const n011 = hash13( ix, iy + 1, iz + 1 );
	const n111 = hash13( ix + 1, iy + 1, iz + 1 );
	const n00 = n000 + ( n100 - n000 ) * fx;
	const n10 = n010 + ( n110 - n010 ) * fx;
	const n01 = n001 + ( n101 - n001 ) * fx;
	const n11 = n011 + ( n111 - n011 ) * fx;
	const n0 = n00 + ( n10 - n00 ) * fy;
	const n1 = n01 + ( n11 - n01 ) * fy;
	return n0 + ( n1 - n0 ) * fz;

}

function fbm3( x, y, z, oct ) {

	let a = 0.5, s = 0, n = 0;
	for ( let i = 0; i < 8; i ++ ) {

		if ( i >= oct ) break;
		s += a * vnoise( x, y, z );
		n += a;
		a *= 0.5;
		x = x * 2.02 + 7.13;
		y = y * 2.02 + 7.13;
		z = z * 2.02;

	}
	return s / Math.max( n, 1e-4 );

}

function vnoise2( x, y ) {

	const ix = Math.floor( x ), iy = Math.floor( y );
	let fx = x - ix, fy = y - iy;
	fx = fx * fx * ( 3 - 2 * fx );
	fy = fy * fy * ( 3 - 2 * fy );
	const a = hash12( ix, iy );
	const b = hash12( ix + 1, iy );
	const c = hash12( ix, iy + 1 );
	const d = hash12( ix + 1, iy + 1 );
	return mix( mix( a, b, fx ), mix( c, d, fx ), fy );

}

const clamp01 = ( x ) => Math.min( 1, Math.max( 0, x ) );
const mix = ( a, b, t ) => a + ( b - a ) * t;
const smoothstep = ( e0, e1, x ) => {

	const t = clamp01( ( x - e0 ) / ( e1 - e0 ) );
	return t * t * ( 3 - 2 * t );

};

// The texture is already attached to the Lagrangian water coordinate, so this
// is deliberately a partial response rather than a second full advection. The
// horizontal FFT displacement makes neighbouring lace points separate/compress
// with the orbital motion; slope shear lets height-only wake rings gently pull
// the lace as their crests pass. Strain stretches cells on a steep face.
// Shader twins: water.js / water-surface.js.
export const FOAM_TEXTURE_CARRY = 0.55;
export const FOAM_TEXTURE_SHEAR = 0.30;
export const FOAM_TEXTURE_STRAIN = 0.38;
// Stretch the lace along the wave face. Offset-only strain just slides the
// stamp; this scales spatial frequency so cells elongate. The block is the
// local pivot so the pattern does not crawl toward world origin.
export const FOAM_LACE_STRETCH = 1.85;
export const FOAM_LACE_STRETCH_BLOCK = 28;
// Authored-lace breathe, in metres. 1.1 m / ~9 m tile is about a cell of
// motion — visible in a few seconds, not a 35 s crawl. Twin of the shaders.
export const FOAM_LACE_MORPH = 1.1;
export const FOAM_LACE_MORPH_RATE = 0.08;

/** Live warp knobs. Missing keys fall back to the authored constants. */
export function foamLaceWarpOf( params ) {

	return {
		carry: params?.foamTextureCarry ?? FOAM_TEXTURE_CARRY,
		shear: params?.foamTextureShear ?? FOAM_TEXTURE_SHEAR,
		strain: params?.foamTextureStrain ?? FOAM_TEXTURE_STRAIN,
		stretch: params?.foamLaceStretch ?? FOAM_LACE_STRETCH,
		block: params?.foamLaceStretchBlock ?? FOAM_LACE_STRETCH_BLOCK,
		morph: params?.foamLaceMorph ?? FOAM_LACE_MORPH,
		rate: params?.foamLaceMorphRate ?? FOAM_LACE_MORPH_RATE,
	};

}

export function foamTextureCoord( flat, world, slope = [ 0, 0 ], opts ) {

	const dx = ( world?.[ 0 ] ?? flat[ 0 ] ) - flat[ 0 ];
	const dz = ( world?.[ 1 ] ?? flat[ 1 ] ) - flat[ 1 ];
	const sx = slope?.[ 0 ] ?? 0;
	const sz = slope?.[ 1 ] ?? 0;
	const strain = Math.hypot( sx, sz );
	const carry = opts?.carry ?? FOAM_TEXTURE_CARRY;
	const pull = ( opts?.shear ?? FOAM_TEXTURE_SHEAR )
		+ strain * ( opts?.strain ?? FOAM_TEXTURE_STRAIN );
	return [
		flat[ 0 ] + dx * carry + sx * pull,
		flat[ 1 ] + dz * carry + sz * pull,
	];

}

/**
 * Elongate `point` along `slope`, pivoted on a stable block of `origin`
 * (the Lagrangian parcel). Slope 0 is identity.
 */
export function foamLaceStretchPoint( point, slope = [ 0, 0 ], origin = point, opts ) {

	const sx = slope?.[ 0 ] ?? 0;
	const sz = slope?.[ 1 ] ?? 0;
	const mag = Math.hypot( sx, sz );
	const stretch = opts?.stretch ?? FOAM_LACE_STRETCH;
	if ( mag < 0.02 || stretch <= 0 ) return [ point[ 0 ], point[ 1 ] ];
	const B = Math.max( opts?.block ?? FOAM_LACE_STRETCH_BLOCK, 1 );
	const ox = Math.floor( origin[ 0 ] / B ) * B + B * 0.5;
	const oz = Math.floor( origin[ 1 ] / B ) * B + B * 0.5;
	const rx = point[ 0 ] - ox;
	const rz = point[ 1 ] - oz;
	const tx = sx / mag;
	const tz = sz / mag;
	const k = 1 + mag * stretch;
	const along = ( rx * tx + rz * tz ) / k;
	const across = ( - rx * tz + rz * tx ) * Math.sqrt( 1 / k );
	return [
		ox + along * tx - across * tz,
		oz + along * tz + across * tx,
	];

}

/** Two-octave breathe of the lace, in world metres. */
export function foamLaceMorph( coord, time, opts ) {

	const morph = opts?.morph ?? FOAM_LACE_MORPH;
	if ( morph <= 0 ) return [ 0, 0 ];
	const x = coord?.[ 0 ] ?? 0;
	const z = coord?.[ 1 ] ?? 0;
	const mt = ( time ?? 0 ) * ( opts?.rate ?? FOAM_LACE_MORPH_RATE );
	const ax = ( vnoise( x * 0.031, z * 0.031, mt ) - 0.5 ) * morph;
	const az = ( vnoise( x * 0.027 + 19.1, z * 0.027 + 7.4, mt + 1.7 ) - 0.5 )
		* morph;
	const bx = ( vnoise( x * 0.013, z * 0.013, mt * 0.45 + 4.2 ) - 0.5 )
		* morph * 0.65;
	const bz = ( vnoise( x * 0.011 + 31.0, z * 0.011 + 13.0, mt * 0.45 + 6.8 ) - 0.5 )
		* morph * 0.65;
	return [ ax + bx, az + bz ];

}

// Twin of src/gpu/tsl/noise.js cellular3. Occupancy is a brightness
// wrinkle only — never coverage (that was the disc look).
export function cellular3( px, py ) {

	const ix = Math.floor( px ), iy = Math.floor( py );
	const fx = px - ix, fy = py - iy;
	let F1 = 8, F2 = 8, occ = 0;
	for ( let y = - 1; y <= 1; y ++ ) {

		for ( let x = - 1; x <= 1; x ++ ) {

			const [ ox, oy ] = hash22( ix + x, iy + y );
			const rx = x + ox - fx, ry = y + oy - fy;
			const d = rx * rx + ry * ry;
			const h = hash12( ix + x + 19.7, iy + y + 7.3 );
			if ( d < F1 ) occ = h;
			F2 = Math.min( F2, Math.max( F1, d ) );
			F1 = Math.min( F1, d );

		}

	}
	return { F1: Math.sqrt( F1 ), F2: Math.sqrt( F2 ), occ };

}

// Same numbers as the shader mask. Fold / coverage 0 → no foam.
export function jacobianGate( fold ) {

	return smoothstep( 0.02, 0.12, clamp01( fold ) );

}

// Hull leftover is a film the lace wrinkles, not wind fold. Putting a
// thin trail through the Jacobian / crisp hole-punch made it pulsate:
// nothing, then a patch. Twin of water.js / water-surface.js.
export const WAKE_FOAM_FRESH = 0.72;
export const WAKE_FOAM_RESIDUE = 0.48;
/**
 * Energy → visible foam. Thin sailing-line film stays sea; only the
 * dense rails read as whitewater. Linear `energy` was already opaque
 * at ~0.15 (the old 0.015…0.28 edge).
 */
export const WAKE_FOAM_ENERGY_LO = 0.32;
export const WAKE_FOAM_ENERGY_HI = 0.88;
export function wakeFoamEnergyLook( energy ) {

	return clamp01( smoothstep(
		WAKE_FOAM_ENERGY_LO, WAKE_FOAM_ENERGY_HI, Math.max( energy, 0 ),
	) );

}
// Kept for the port/centre/starboard lace-tap check. Shading no longer
// uses a high-floor milky film (that was the ski honeycomb).
export const WAKE_LACE_FLOOR = 0.66;
export const WAKE_LACE_LO = 0.00;
export const WAKE_LACE_HI = 1.00;
export const WAKE_LACE_SPAN = 0.45;
export function wakeLaceBlend( center, port, starboard ) {

	return clamp01( ( center + port + starboard ) / 3 );

}

export function wakeFoamCoverage( energy ) {

	const e = Math.max( energy, 0 );
	return {
		foamF: e * WAKE_FOAM_FRESH,
		foamR: e * WAKE_FOAM_RESIDUE,
	};

}

/** Same resolve as wind foam: coverage × lace shape, gated. Not a milky floor. */
export function wakeFoamMask( wake, fd ) {

	const cov = clamp01( wake );
	const gate = jacobianGate( cov );
	const shape = mix( 0.52, 1.12, smoothstep( 0.10, 0.82, clamp01( fd ) ) );
	return clamp01( cov * shape ) * gate;

}

/**
 * Freshness 0..1 for the wake film: 1 is new dense suds at the transom,
 * 0 is an old torn streak.
 *
 * `ageN` is the record's own age, normalised by its life — 0 the instant
 * the hull passed. Pass null where there is no record (an energy-only
 * film) and coverage stands in, which is what this used to do everywhere.
 *
 * The proxy was wrong in one specific way that shows: foam thin because it
 * is OLD and foam thin because it has only just started shaded identically.
 */
export function wakeFoamFreshness( energy, ageN = null ) {

	if ( ageN === null || ageN === undefined ) return clamp01( energy );
	return 1 - clamp01( ageN );

}

/**
 * Freshness above which the film is prop wash rather than broken foam.
 * Below it blue starts showing through; above it the water is aerated.
 */
export const WAKE_FOAM_WASH = 0.55;
/** Coverage the far wisps settle on — patchy filaments, not clean water. */
export const WAKE_FOAM_TAIL = 0.14;
/** Coverage of the patchy middle band, on top of the tail floor. */
export const WAKE_FOAM_BROKEN = 0.34;
/**
 * Energy + age → how much of this patch is actually white.
 *
 * The wake used to composite through `clamp(energy, 0, 1)`, and the field
 * saturates within a second of the hull passing — so every texel from the
 * transom to the end of the trail rendered at exactly the same coverage.
 * That flat sheet is what reads as a tiled stencil: with nothing else
 * varying, the foam image is the only thing left to look at, so its repeat
 * becomes the whole picture.
 *
 * A real wake is a gradient. Aerated prop wash right behind the transom,
 * then a band breaking up into patches with water showing through, then
 * filaments. This is ONE monotonic curve on age, deliberately not a stack
 * of multiplicative removers — that combination is what made the film
 * blink patchily last time.
 */
export function wakeFoamGrade( energy, ageN = null ) {

	const e = Math.max( energy ?? 0, 0 );
	if ( ! ( e > 0 ) ) return 0;
	const f = clamp01( wakeFoamFreshness( e, ageN ) );
	const wash = smoothstep( WAKE_FOAM_WASH, 0.97, f );
	const broken = smoothstep( 0.04, WAKE_FOAM_WASH, f );
	const cover = WAKE_FOAM_TAIL + broken * WAKE_FOAM_BROKEN
		+ wash * ( 1 - WAKE_FOAM_TAIL - WAKE_FOAM_BROKEN );
	// Never grade UP foam the sim never deposited. Thin energy stays thin.
	return clamp01( cover * smoothstep( 0, 0.35, e ) );

}

/** Coverage between the prop wash and the cusp arms — disturbed, not white. */
export const WAKE_ZONE_FLOOR = 0.05;
/** Extra coverage on the breaking crest of each arm. Thin, not a solid edge. */
export const WAKE_ZONE_CREST = 0.55;
/**
 * Across-track coverage: where the white actually sits at a given distance
 * astern.
 *
 * A wake is not one even band. Down the sailing line is aerated prop wash,
 * near opaque. Each cusp arm carries a thin breaking crest. Between them the
 * water is disturbed and textured but mostly still ocean coloured — that gap
 * is most of the wedge's area, and filling it is what makes a simulated wake
 * read as a painted white V.
 *
 * @param {number} lat signed metres from the sailing line
 * @param {number} arm metres to the cusp, i.e. width0 + rate * age
 * @param {number} coreW half-width of the prop wash
 * @param {number} crestW half-width of the arm crest
 */
export function wakeFoamZone( lat, arm, coreW, crestW ) {

	const a = Math.max( arm ?? 0, 0 );
	const cw = Math.max( crestW ?? 0.55, 0.05 );
	const cn = ( lat ?? 0 ) / Math.max( coreW ?? 0.5, 0.05 );
	const core = Math.exp( - cn * cn );
	const rn = ( Math.abs( lat ?? 0 ) - a ) / ( cw * 0.65 );
	const crest = Math.exp( - rn * rn );
	const outerCut = 1 - smoothstep( a + cw * 0.2, a + cw * 1.2, Math.abs( lat ?? 0 ) );
	const interior = smoothstep( ( coreW ?? 0.5 ) * 1.2, a * 0.85, Math.abs( lat ?? 0 ) );
	return clamp01(
		( core * 0.95 + crest * 0.85 + interior * WAKE_ZONE_FLOOR ) * outerCut,
	);

}

/**
 * Packed wake mask resolve — dense transom suds, cellular lace mid-trail,
 * torn breakup at the end. Driven by {@link wakeFoamFreshness}, so it
 * follows real record age when there is one and coverage when there is not.
 * Shader twins: water.js / water-surface.js.
 */
export function wakeFoamAgePattern( energy, coarse, fine, breakup, ageN = null ) {

	const cells = clamp01( Math.max( coarse * 0.90, fine * 0.72 ) );
	const old = clamp01( 0.06 + fine * breakup * 1.35 );
	const dense = clamp01( 0.68 + Math.max( coarse, fine ) * 0.42 );
	const f = wakeFoamFreshness( energy, ageN );
	const middle = mix( old, cells, smoothstep( 0.08, 0.34, f ) );
	return mix( middle, dense, smoothstep( 0.52, 0.95, f ) );

}

/**
 * Live leftover trail. `lace` may be the packed age pattern above.
 * Amount 0 is a smooth film. Never the procedural F2−F1 web.
 */
export function wakeFoamFilm( energy, lace, textureAmount = 1 ) {

	const e = clamp01( energy );
	const tex = clamp01( textureAmount );
	return e * mix( 1, clamp01( lace ), tex );

}

// How torn the leftover / energy film looks. 0 is the old solid stencil
// with a scrolling pack. The default wobbles the leftover *foam*
// sample (not leftover height), chews the crest into patches, and
// frays dying ends so a Mach V is not seven ruler-straight rays.
// Shader twins: water.js / water-surface.js.
export const WAKE_FOAM_RIBBON_VARY = 1.0;
export const WAKE_FOAM_RIBBON_VARY_MAX = 1.6;
export const WAKE_FOAM_RIBBON_WARP0 = 7.2;
export const WAKE_FOAM_RIBBON_WARP1 = 2.2;

/**
 * World-space ribbon look. Amount 0 is identity (fill/opacity 1, no
 * stretch, no holes). Does not steer leftover by live heading.
 */
export function wakeFoamRibbonVary( px, pz, amount = WAKE_FOAM_RIBBON_VARY ) {

	const k = Math.max( 0, Math.min( WAKE_FOAM_RIBBON_VARY_MAX, amount ?? 0 ) );
	const x = px ?? 0;
	const z = pz ?? 0;
	const nFill = vnoise2( x * 0.038, z * 0.038 );
	const nOpac = vnoise2( x * 0.027 + 13.7, z * 0.027 - 8.2 );
	const nFeat = vnoise2( x * 0.021 + 5.4, z * 0.021 + 19.1 );
	const nHole = vnoise2( x * 0.064 - 11.6, z * 0.064 + 4.8 );
	const nStr = vnoise2( x * 0.019 + 2.3, z * 0.019 - 15.6 );
	const nAni = vnoise2( x * 0.033 - 7.1, z * 0.033 + 9.4 );
	const fill = mix( 1, mix( 0.18, 1.04, nFill ), k );
	const opacity = mix( 1, mix( 0.28, 1, nOpac ), k );
	const hole = mix( 1, mix( 0.04, 1, smoothstep( 0.10, 0.66, nHole ) ), k );
	const stretch = mix( 1, mix( 0.48, 1.72, nStr ), k );
	const aniso = mix( 1, mix( 0.52, 1.62, nAni ), k );
	const [ warpX, warpZ ] = wakeFoamRibbonWarp( x, z, k );
	return {
		amount: k,
		nFill, nOpac, nFeat, nHole, nStr, nAni,
		fill, opacity, hole,
		coverage: clamp01( fill * hole ),
		stretchU: stretch,
		stretchV: stretch * aniso,
		warpU: ( nStr - 0.5 ) * 0.55 * k,
		warpV: ( nAni - 0.5 ) * 0.42 * k,
		warpX, warpZ,
	};

}

/**
 * Metres to slide the leftover *foam* sample. Leftover height and
 * vertex displacement stay on the real XZ — only the white film
 * follows this wobble. Amount 0 is [0, 0].
 */
export function wakeFoamRibbonWarp( px, pz, amount = WAKE_FOAM_RIBBON_VARY ) {

	const k = Math.max( 0, Math.min( WAKE_FOAM_RIBBON_VARY_MAX, amount ?? 0 ) );
	const x = px ?? 0;
	const z = pz ?? 0;
	const w0x = vnoise2( x * 0.042, z * 0.042 ) - 0.5;
	const w0z = vnoise2( x * 0.039 + 8.7, z * 0.039 - 3.1 ) - 0.5;
	const w1x = vnoise2( x * 0.11, z * 0.11 ) - 0.5;
	const w1z = vnoise2( x * 0.10 - 6.4, z * 0.10 + 12.2 ) - 0.5;
	return [
		( w0x * WAKE_FOAM_RIBBON_WARP0 + w1x * WAKE_FOAM_RIBBON_WARP1 ) * k,
		( w0z * WAKE_FOAM_RIBBON_WARP0 + w1z * WAKE_FOAM_RIBBON_WARP1 ) * k,
	];

}

/**
 * Patch / chew / dying-end fade on leftover crest foam. Amount 0 is 1.
 * Low leftover height (weak outer arms, dying ends) breaks up first.
 */
export function wakeFoamRibbonBreak( px, pz, leftoverH = 0.12, amount = WAKE_FOAM_RIBBON_VARY ) {

	const k = Math.max( 0, Math.min( WAKE_FOAM_RIBBON_VARY_MAX, amount ?? 0 ) );
	if ( k <= 0 ) return 1;
	const x = px ?? 0;
	const z = pz ?? 0;
	const nPatch = vnoise2( x * 0.028 + 21.4, z * 0.028 - 9.6 );
	const nChew = vnoise2( x * 0.09 - 4.2, z * 0.09 + 15.8 );
	const nFine = vnoise2( x * 0.21 + 6.6, z * 0.21 - 2.4 );
	const nBreak = vnoise2( x * 0.016 + 3.3, z * 0.016 + 7.7 );
	const nIsland = vnoise2( x * 0.042 + 17.2, z * 0.042 - 6.4 );
	const chew = nChew * 0.65 + nFine * 0.35;
	const h = Math.max( leftoverH ?? 0, 0 );
	const weak = 1 - smoothstep( 0.03, 0.18, h );
	const dying = 1 - smoothstep( 0.012, 0.08, h );
	// Hard islands: look-down arms are a pixel or two, so a 0.72
	// floor still reads as a continuous ruler. Amount 0 stays 1.
	// Thin leftover (outer arms) uses a lower island gate so it
	// vanishes first; dense crests can still go to zero.
	const islandK = mix( 1, smoothstep( mix( 0.36, 0.18, weak ), 0.64, nIsland ), k );
	const breakK = mix( 1, smoothstep( 0.34, 0.62, nBreak ), k );
	const chewK = mix( 1, smoothstep( 0.08, 0.58, chew ), k );
	const patchK = mix( 1, smoothstep( 0.08, 0.62, nPatch ), k );
	const frayK = mix( 1, smoothstep( 0.22, 0.78, chew ), k * dying );
	return clamp01( islandK * breakK * chewK * patchK * frayK );

}

/**
 * Same film as wakeFoamFilm(), then fill / holes / opacity / a softer
 * edge. Amount 0 matches wakeFoamFilm() exactly.
 */
export function wakeFoamRibbonFilm( energy, lace, textureAmount = 1, px = 0, pz = 0, amount = WAKE_FOAM_RIBBON_VARY ) {

	const v = wakeFoamRibbonVary( px, pz, amount );
	const sheet = clamp01( energy );
	const feathered = mix(
		sheet,
		smoothstep( mix( 0.004, 0.20, v.nFeat ), mix( 0.12, 0.70, v.nFeat ), sheet ),
		v.amount,
	);
	const brk = wakeFoamRibbonBreak( px, pz, energy, amount );
	const vary = v.fill * v.hole * v.opacity * brk;
	return clamp01( wakeFoamFilm( feathered, lace, textureAmount ) * vary );

}

/**
 * Recipe `wake.foam` (0–1.5) is the film look. The energy field hits
 * FOAM_ENERGY_MAX at planing for almost any foam above ~0.05, so
 * clamp(energy) is already 1. This is what the slider actually changes.
 */
export function wakeFoamRibbonAmount( sheet, foam = 1 ) {

	return Math.min( 1, Math.max( 0, sheet ) * Math.max( foam, 0 ) );

}

/** Packed-wake UV. Amount 0 is the authored rotate-and-scale frame. */
export function wakeFoamPackUv( laceU, laceV, px = 0, pz = 0, amount = WAKE_FOAM_RIBBON_VARY ) {

	const v = wakeFoamRibbonVary( px, pz, amount );
	const ux = laceU * v.stretchU + v.warpU;
	const uy = laceV * v.stretchV + v.warpV;
	return [
		( ux * 0.754 - uy * 0.657 ) * 0.73 + 0.173,
		( ux * 0.657 + uy * 0.754 ) * 0.73 + 0.419,
	];

}

export function wakeFoamThickness( wake, fd ) {

	return clamp01( wake * mix(
		0.42, 0.78,
		smoothstep( 0.14, 0.86, clamp01( fd ) ),
	) );

}

function laceAt( p, t, foot, detail, wind, streak, drift, fill, cell ) {

	const [ wx, wz ] = wind;
	const qx = - wz, qz = wx;
	const xAlong = p[ 0 ] * wx + p[ 1 ] * wz;
	const xCross = p[ 0 ] * qx + p[ 1 ] * qz;
	const sx = xAlong * ( 1 - 0.38 * streak );
	const sy = xCross * ( 1 + 0.70 * streak );
	// Slide with the surface current (same m/s as the sim's foamDrift).
	// 0.12 m/s was invisible — the web sat still and coverage just faded.
	const slide = Math.max( drift, 0 ) * t;
	// Slow, large warp so cells stretch and shear as they travel, not
	// translate as a rigid stamp.
	const flow = t * 0.08;
	const warpX = ( vnoise( sx * 0.04, sy * 0.04, flow ) - 0.5 ) * 3.1;
	const warpY = ( vnoise( sx * 0.04 + 17.3, sy * 0.04 + 17.3, flow + 3.1 ) - 0.5 ) * 2.7;
	const spx = sx + warpX - wx * slide;
	const spy = sy + warpY - wz * slide;

	// 1 = authored clump scale. Higher = bigger rafts. Warp stays in world
	// metres so large patches still shear instead of looking zoomed.
	const inv = 1 / Math.max( cell, 0.2 );
	const dens = vnoise( spx * 0.07 * inv, spy * 0.07 * inv, t * 0.03 );
	const localScale = mix( 0.68, 1.34, dens );
	const fillK = clamp01( fill );

	// Irregular leftover rafts. Occupied Voronoi cells were discs; F2−F1
	// walls were the glowing wireframe on the ski. fbm patches with a
	// second tear so edges unzip instead of closing into blobs.
	const raftN = fbm3( spx * 0.10 * inv * localScale, spy * 0.10 * inv * localScale, t * 0.05, 3 );
	const tearN = vnoise( spx * 0.22 * inv, spy * 0.22 * inv, t * 0.07 );
	const chewN = vnoise( spx * 0.40 * inv, spy * 0.40 * inv, t * 0.11 );
	const raftLo = mix( 0.50, 0.26, fillK );
	const raft = smoothstep( raftLo, 0.70, raftN )
		* mix( 0.48, 1.0, smoothstep( 0.12, 0.68, tearN ) )
		* mix( 0.58, 1.0, smoothstep( 0.10, 0.58, chewN ) );

	const grain = vnoise( spx * 9.2 * inv, spy * 9.2 * inv, t * 0.55 );
	const film = raft * ( 0.70 + 0.30 * grain );

	// Mild draining-strand accent. Never the coverage stencil.
	const width = mix( 0.20, 0.36, dens );
	const broken = smoothstep( 0.20, 0.52, vnoise( spx * 0.52 * inv, spy * 0.52 * inv, t * 0.08 ) );
	const c0 = cellular3( spx * 0.72 * inv * localScale, spy * 0.72 * inv * localScale );
	const gap0 = c0.F2 - c0.F1;
	const wallGate = mix( 0.06, 1.0, smoothstep( 0.18, 0.78, broken ) );
	const fil0 = smoothstep( width, 0.040, gap0 ) * wallGate;
	const core0 = smoothstep( width * 0.38, 0.016, gap0 ) * wallGate;

	const fillN = fillK / 0.55;
	const extra = clamp01( ( fillK - 0.55 ) / 0.45 );
	const fineScale = mix( 0.98, 1.52, 1 - dens );
	const c1 = cellular3( spx * fineScale * inv + 8.1, spy * fineScale * inv + 8.1 );
	const gap1 = c1.F2 - c1.F1;
	const chordGate = smoothstep( 0.46, 0.76, dens * 0.58 + ( 1 - broken ) * 0.42 );
	const fil1 = smoothstep( mix( 0.16, 0.28, dens ), 0.028, gap1 )
		* chordGate
		* Math.min( fillN, 1 )
		* mix( 1.0, 1.55, extra );

	const hazeLo = mix( 0.46, 0.68, extra );
	const haze = smoothstep( hazeLo, 0.10, gap0 )
		* ( 1 - fil0 )
		* mix( 0.05, 0.30, dens )
		* ( 0.45 + 0.55 * grain )
		* fillN;

	const accent = Math.max( fil0, fil1 ) * mix( 0.02, 0.10, fillK ) + haze * 0.28;
	const lace = clamp01( film * 0.90 + accent );

	const fineAmt = Math.min( Math.max( detail / 1.85, 0 ), 2.4 );
	const fineFade = ( 1 - smoothstep( 0.08, 0.55, foot ) ) * fineAmt;
	const bub = 0.42 + 0.58 * mix( 0.50, grain, Math.min( fineFade, 1 ) );
	const core = core0 * mix( 0.45, 1.0, dens );
	const grainAmt = 0.28 * Math.min( fineFade, 1 );
	const thick = clamp01(
		film * 0.78 * bub
			+ core * 0.35 * bub
			+ fil0 * 0.18 * bub
			+ fil1 * 0.12 * bub
			+ haze * 0.10 * bub
			+ grainAmt * grain * film,
	);

	const near = 1 - smoothstep( 0.12, 1.8, foot );
	return {
		field: mix( 0.5, clamp01( lace ), near ),
		thick,
		crest: fil0,
		veins: fil1,
		residual: haze + film,
		core,
	};

}

// p = [x, z] world metres, t = time (s), foot = pixel footprint (m),
// detail = foamDetail (default 1.85), wind = unit [wx, wz], streak = foamStreak,
// drift = foamDrift m/s (the lace slides at the same speed the sim advects coverage),
// fill = foamFill (0 = sparse torn clumps, 0.55 = authored, 1 = broader rafts),
// cell = foamCell (1 = authored clump size; higher = bigger rafts).
export function foamField( p, t, foot, detail = 1.85, wind = [ 1, 0 ], streak = 0.16, drift = 0.6, fill = 0.55, cell = 1 ) {

	const L = laceAt( p, t, foot, detail, wind, streak, drift, fill, cell );
	return { field: L.field, thick: L.thick };

}

export function foamLaceParts( p, t, foot, detail = 1.85, wind = [ 1, 0 ], streak = 0.16, drift = 0.6, fill = 0.55, cell = 1 ) {

	return laceAt( p, t, foot, detail, wind, streak, drift, fill, cell );

}
