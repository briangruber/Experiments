// Virtual seafloor seen THROUGH the surface from above.
//
// FFT `depth` is wave dispersion. This is a bed UNDER the interface —
// sand, reef, and sunlight focused by the real FFT surface. The bed is
// a heightfield between floorDepthMin and floorDepthMax (sandbars and
// channels), not a single shelf. 0 on either knob falls back to
// floorDepth, so a lone depth is still a flat bed. The sea's own
// specular and Fresnel stay on top; the bed is added through the
// column, never mixed over the water. The look-down ray refracts
// (Snell). Sunlight on the sand is focused through the water —
// two or three small, broken caustic layers that multiply the bed,
// not a white Voronoi stamp on the surface. Ridges pinch, flare,
// and vanish; a second dense octave was the dotted wireframe.
// Depth and view-distance fade the foci so the horizon stays
// quiet. Inverse-Jacobian filaments, dive `uwCaustic`, occupied
// (1−F1) discs, closed F2−F1 polygons, and sine lattices are
// rejected looks. Look-down refraction still skips the short
// cascade (13 cm grit). Sand / reef is metre-scale patches.
// Twin of the floor block in gpu/tsl/water-surface.js and WATER_FS.
// Authored rocks / coral sit on this heightfield — src/seafloor-props.js.
// A change here is not done until tools/check-seafloor.mjs passes.
//
// Rejected looks, already measured:
//   dive `uwCaustic` (tens of metres)     → green slabs from the air
//   intersecting sine ridges              → warped square lattice
//                                         (the cheap water-demo grid)
//   occupied (1−F1) cells                 → discs on the sand
//   inverse-Jacobian filaments            → sparse streaks, not the
//                                         lagoon network
//   closed F2−F1 polygons at ~1 m         → cracked-ice wireframe
//   a second dense Worley octave          → dotted inner lines
//   add(white * lace) on the bed          → a texture on the water
//   a random brightness envelope          → hot patches that ignore the sun

import { cellular3 } from './foam-lace.js';

function clamp( x, a, b ) {

	return Math.min( b, Math.max( a, x ) );

}

function smoothstep( e0, e1, x ) {

	const t = clamp( ( x - e0 ) / ( e1 - e0 ), 0, 1 );
	return t * t * ( 3 - 2 * t );

}

export const FLOOR_IOR = 1.333;
/** Default dune / channel length, metres. */
export const FLOOR_TERRAIN_SCALE = 36;
/**
 * Cascades shorter than this (metres of patch) are 13 cm chop. They
 * speckle at LOD 0 and vanish when mipped; they are not in the tap.
 */
export const FLOOR_CAUSTIC_MIN_PATCH = 40;
/**
 * View-distance fade of the sunlight foci. Full out to NEAR metres;
 * gone by FAR, before small cells alias into horizon speckle.
 */
export const FLOOR_LACE_NEAR = 16;
export const FLOOR_LACE_FAR = 55;
/** How hard the column kills the foci: `exp(-depth * this)`. */
export const FLOOR_LACE_DEPTH_K = 0.15;
/** Sand multiply: `bed * (1 + lace * this)`. Not an added white. */
export const FLOOR_LACE_MUL = 0.45;

/** 1 nearby, 0 past the alias band. Twin of the fade in both water shaders. */
export function floorLaceFade( dist ) {

	return smoothstep( FLOOR_LACE_FAR, FLOOR_LACE_NEAR, dist );

}

/**
 * World-XZ slide of the virtual bed. Same knob and gates as the mesh
 * refraction (`params.sdRefract` → `uRefractDistort`): lighting slope
 * (the rocks' wobble), thickened by the column, flattened with
 * distance. The Snell ray stays on the mipped N — that grit is a
 * different bug. Twin of the slide in both water shaders.
 */
export function floorLookSlide( sx, sz, distort, column, dist ) {

	const gate = clamp( column * 0.7, 0, 1 ) / ( 1 + Math.max( dist, 0 ) * 0.045 );
	const w = Math.max( distort, 0 ) * gate * Math.max( column, 0 );
	return [ sx * w, sz * w ];

}

/** Finite-difference span on the gravity-wave field, metres. */
export const FLOOR_CAUSTIC_SPAN = 2.0;
/**
 * Kept for the hull-probe lod formula and older checks. The live tap
 * skips the short cascade instead of averaging this many metres.
 */
export const FLOOR_CAUSTIC_FOOTPRINT = 2.4;

/**
 * Explicit slope mip whose texels span `footprint` metres on this
 * cascade. Same formula as the hull probe: `log2(fp * N / patch)`.
 * The swell cascade is already coarser than the footprint, so its lod
 * is 0; a 17 m cascade at 128² is read around mip 5.
 */
export function floorCausticLod( patch, fftSize, footprint = FLOOR_CAUSTIC_FOOTPRINT ) {

	if ( ! ( footprint > 0 ) || ! ( patch > 0 ) || ! ( fftSize > 0 ) ) return 0;
	return Math.max( 0, Math.log2( ( footprint * fftSize ) / patch ) );

}

/** Four-cascade lod vector for `uFloorCausticLod`. */
export function floorCausticLods( patches, fftSize, footprint = FLOOR_CAUSTIC_FOOTPRINT ) {

	const out = new Float32Array( 4 );
	for ( let i = 0; i < 4; i ++ ) out[ i ] = floorCausticLod( patches[ i ] ?? 1, fftSize, footprint );
	return out;

}

/**
 * Resolve the live depth range. A 0 min or max means "use `mid`"
 * (`floorDepth`), so a lone depth stays a flat shelf.
 */
export function floorDepthBounds( min, max, mid = 0 ) {

	const a = min > 0.1 ? min : ( mid > 0.1 ? mid : 0 );
	const b = max > 0.1 ? max : ( mid > 0.1 ? mid : a );
	const lo = Math.min( a, b );
	const hi = Math.max( a, b );
	return { min: lo, max: hi, live: hi > 0.1 };

}

/**
 * 0..1 bed height. 1 is a sandbar (shallow), 0 is a channel (deep).
 * Twin of floorTerrainCore in gpu/tsl/water-surface.js / WATER_FS.
 */
export function floorTerrainH( x, z, scale = FLOOR_TERRAIN_SCALE ) {

	const s = Math.max( scale, 4 );
	const u = x / s;
	const v = z / s;
	const bars = Math.sin( u * 1.7 + Math.sin( v * 0.9 ) * 0.65 );
	const channels = Math.sin( v * 1.15 - Math.sin( u * 0.55 ) * 0.8 );
	const dunes = Math.sin( u * 2.4 - v * 1.3 + Math.sin( u * 0.7 ) * 0.45 );
	return clamp( 0.5 + 0.5 * ( bars * 0.48 + channels * 0.34 + dunes * 0.18 ), 0, 1 );

}

/**
 * Metres of water to the bed at world XZ. Twin of floorTerrainCore.
 */
export function floorDepthAt( x, z, min, max, scale = FLOOR_TERRAIN_SCALE ) {

	const lo = Math.min( min, max );
	const hi = Math.max( min, max );
	if ( ! ( hi > 0.1 ) ) return 0;
	if ( hi - lo < 0.05 ) return hi;
	return lo + ( 1 - floorTerrainH( x, z, scale ) ) * ( hi - lo );

}

/**
 * Refine a downward ray against the heightfield. Three steps is enough
 * for the lagoon-scale dunes; a miss returns null.
 */
export function floorRayHit( px, pz, py, rd, min, max, scale = FLOOR_TERRAIN_SCALE, seaLevel = 0 ) {

	const hi = Math.max( min, max );
	if ( ! ( hi > 0.1 ) || ! ( rd?.[ 1 ] < - 0.02 ) ) return null;
	const lo = Math.min( min, max );
	let t = ( lo + hi ) * 0.5 / Math.max( - rd[ 1 ], 0.02 );
	let hx = px, hz = pz, depth = ( lo + hi ) * 0.5;
	for ( let i = 0; i < 3; i ++ ) {

		hx = px + rd[ 0 ] * t;
		hz = pz + rd[ 2 ] * t;
		depth = floorDepthAt( hx, hz, lo, hi, scale );
		t = ( py - ( seaLevel - depth ) ) / Math.max( - rd[ 1 ], 0.02 );

	}
	if ( ! ( t > 0.05 ) || t > 90 ) return null;
	hx = px + rd[ 0 ] * t;
	hz = pz + rd[ 2 ] * t;
	depth = floorDepthAt( hx, hz, lo, hi, scale );
	return { x: hx, z: hz, t, depth };

}

/**
 * GLSL `refract(I, N, eta)`. I points at the interface, N is outward.
 * TIR returns a zero vector.
 */
export function refract3( I, N, eta ) {

	const d = N[ 0 ] * I[ 0 ] + N[ 1 ] * I[ 1 ] + N[ 2 ] * I[ 2 ];
	const k = 1 - eta * eta * ( 1 - d * d );
	if ( k < 0 ) return [ 0, 0, 0 ];
	const s = eta * d + Math.sqrt( k );
	return [
		eta * I[ 0 ] - s * N[ 0 ],
		eta * I[ 1 ] - s * N[ 1 ],
		eta * I[ 2 ] - s * N[ 2 ],
	];

}

/**
 * World XZ where a ray from the facet hits the bed after Snell's law.
 * `I` is the incident (air → surface). A miss / TIR falls back to `I`.
 */
export function floorRefractHit( worldX, worldZ, I, N, floorDepth, ior = FLOOR_IOR ) {

	const eta = 1 / Math.max( ior, 1.01 );
	let rd = refract3( I, N, eta );
	if ( ! rd[ 1 ] || rd[ 1 ] >= - 0.02 ) rd = I;
	const t = floorDepth / Math.max( - rd[ 1 ], 0.02 );
	return [ worldX + rd[ 0 ] * t, worldZ + rd[ 2 ] * t ];

}

/** Where the refracted sun hits the bed through this facet. */
export function floorSunHit( worldX, worldZ, sun, N, floorDepth, ior = FLOOR_IOR ) {

	const sl = Math.hypot( sun[ 0 ], sun[ 1 ], sun[ 2 ] ) || 1;
	return floorRefractHit(
		worldX, worldZ,
		[ - sun[ 0 ] / sl, - sun[ 1 ] / sl, - sun[ 2 ] / sl ],
		N, floorDepth, ior,
	);

}

/**
 * Inverse Jacobian of the sun-ray mapping through a sloped facet.
 * `d = min(depth, 26) * FLOOR_CAUSTIC_LEVER` is the column the slopes
 * act through. 0.25 was a LOD-0 fudge — after the several-metre mip it
 * left a lagoon dark even with Floor caustics up.
 */
export const FLOOR_CAUSTIC_LEVER = 0.55;

export function floorCausticJ( axx, azz, axz, azx, depth ) {

	const d = Math.min( Math.max( depth, 0 ), 26 ) * FLOOR_CAUSTIC_LEVER;
	const J = ( 1 + d * axx ) * ( 1 + d * azz ) - d * d * axz * azx;
	return 1 / Math.max( Math.abs( J ), 0.05 );

}

/** Sparse filaments: only strong focusing lights up. */
export function floorCausticShape( j ) {

	return Math.pow( smoothstep( 0.85, 2.5, j ), 1.35 );

}

/**
 * World-space slope Jacobian from three samples `e` metres apart,
 * then the shaped caustic. Twin of the three-tap in water-surface.js.
 */
export function floorCausticFromSlopes( s0, sx, sz, e, depth ) {

	const inv = 1 / Math.max( e, 1e-4 );
	const axx = ( sx[ 0 ] - s0[ 0 ] ) * inv;
	const azz = ( sz[ 1 ] - s0[ 1 ] ) * inv;
	const axz = ( sz[ 0 ] - s0[ 0 ] ) * inv;
	const azx = ( sx[ 1 ] - s0[ 1 ] ) * inv;
	return floorCausticShape( floorCausticJ( axx, azz, axz, azx, depth ) );

}

/**
 * Surface XZ where the sun ray that hits this bed point entered the water.
 * Sun is a direction toward the sun (y > 0).
 */
export function floorSunEntry( bedX, bedZ, sun, depth ) {

	const sl = Math.hypot( sun[ 0 ], sun[ 1 ], sun[ 2 ] ) || 1;
	const sy = Math.max( sun[ 1 ] / sl, 0.18 );
	return [
		bedX + ( sun[ 0 ] / sl ) / sy * depth,
		bedZ + ( sun[ 2 ] / sl ) / sy * depth,
	];

}

/**
 * 1D focus from divergence. Prefer floorCausticFromSlopes on the live
 * path — this is the cheap check twin of a converging / spreading facet.
 */
export function floorFocus( div, depth ) {

	return clamp( 1 / Math.max( 1 + div * depth * 0.55, 0.22 ), 0.25, 2.8 );

}

/**
 * How hard this facet dumps sun onto the bed. Lighting slope (the
 * rocks' wobble), not capillaries in the lace UV and not Snell.
 * Sun-facing / converging faces punch; the lee goes quiet.
 * Elevation scales the whole thing. Twin of both water shaders.
 */
export function floorSunGain( sx, sz, sun, depth = 5.2 ) {

	const sl = Math.hypot( sun[ 0 ], sun[ 1 ], sun[ 2 ] ) || 1;
	const Lx = sun[ 0 ] / sl;
	const Ly = clamp( sun[ 1 ] / sl, 0, 1 );
	const Lz = sun[ 2 ] / sl;
	const nx = - sx, ny = 1, nz = - sz;
	const nl = Math.hypot( nx, ny, nz ) || 1;
	const NoL = Math.max( 0, ( nx * Lx + ny * Ly + nz * Lz ) / nl );
	const along = sx * Lx + sz * Lz;
	const focus = floorFocus( - along * 1.85, depth );
	const punch = 0.42 + 0.48 * focus;
	const face = 0.40 + 0.72 * NoL;
	const height = 0.16 + 0.84 * Ly;
	return clamp( face * punch * height, 0, 1.65 );

}

/** Metres along a downward ray from the surface to a bed `floorDepth` down. */
export function surfaceFloorT( rdY, floorDepth ) {

	if ( ! ( floorDepth > 0.1 ) || ! ( rdY < - 0.02 ) ) return Infinity;
	return floorDepth / - rdY;

}

/**
 * 0 = sand, 1 = dark reef. Twin of the water fragment.
 * Low-frequency sines — `fract(sin · large)` is white at a texel.
 */
export function floorReef( x, z ) {

	const u = x * 0.021;
	const v = z * 0.017;
	const n = 0.5 + 0.5 * Math.sin( u * 1.4 + Math.sin( v * 0.8 ) * 0.7 );
	const n2 = 0.5 + 0.5 * Math.sin( v * 1.1 - Math.sin( u * 0.6 ) * 0.55 );
	return smoothstep( 0.48, 0.72, n ) * ( 0.4 + 0.6 * n2 );

}

/**
 * One moving caustic sheet. Small Worley cells, UV-warped so they
 * stretch and pinch; site-hash breaks the closed polygons; a soft
 * glow sits under a sparse ridge and an intersection flare.
 */
function floorLaceLayer( x, z, t, scale, driftX, driftZ, phase ) {

	let u = x * scale + driftX * t;
	let v = z * scale + driftZ * t;
	u += Math.sin( v * 1.7 + t * 0.7 + phase ) * 0.06
		+ Math.sin( v * 0.55 + t * 0.21 + phase ) * 0.04;
	v += Math.cos( u * 1.4 + t * 0.55 + phase ) * 0.06
		+ Math.cos( u * 0.48 - t * 0.17 + phase ) * 0.04;
	const c = cellular3( u, v );
	const gap = c.F2 - c.F1;
	const glow = Math.pow( 1 - smoothstep( 0.02, 0.22, gap ), 1.15 );
	const ridge = Math.pow( 1 - smoothstep( 0, 0.07, gap ), 2.2 );
	const broken = smoothstep( 0.18, 0.58, c.occ );
	const flare = Math.pow( 1 - smoothstep( 0, 0.18, c.F2 ), 2.6 ) * ridge;
	return ( glow * 0.38 + ridge * 0.55 ) * broken + flare * 0.85;

}

/**
 * Focused sunlight on the bed. Twin of the lace in
 * gpu/tsl/water-surface.js and WATER_FS. Three small sheets (~0.3 m
 * cells), not a 1 m closed wireframe and not a dotted second octave.
 */
export function floorLace( x, z, t, size = 1 ) {

	const k = 1 / Math.max( size, 0.15 );
	const a = floorLaceLayer( x * k, z * k, t, 2.85, 0.11, - 0.07, 0.0 );
	const b = floorLaceLayer( x * k, z * k, t, 1.95, - 0.08, 0.10, 2.1 );
	const c = floorLaceLayer( x * k, z * k, t, 3.55, 0.04, 0.09, 4.4 );
	const raw = Math.min( 1.2, a * 0.52 + b * 0.34 + c * 0.22 );
	const field = smoothstep( 0.04, 0.28, raw );
	const hot = Math.pow( smoothstep( 0.22, 0.74, raw ), 1.7 );
	return Math.min( 1, field * 0.42 + hot * 0.72 );

}

/**
 * RGB of the bed (sand / reef / focused sunlight), unlit.
 * `web` is the already-shaped caustic (0..1) from floorLace.
 */
export function floorAlbedo( x, z, sunY = 0.7, caustic = 1, web = 0 ) {

	const reef = floorReef( x, z );
	const sand = [ 0.78, 0.68, 0.48 ];
	const rock = [ 0.16, 0.22, 0.18 ];
	const bed = [
		sand[ 0 ] + ( rock[ 0 ] - sand[ 0 ] ) * reef,
		sand[ 1 ] + ( rock[ 1 ] - sand[ 1 ] ) * reef,
		sand[ 2 ] + ( rock[ 2 ] - sand[ 2 ] ) * reef,
	];
	const sunH = clamp( sunY, 0, 1 );
	const sunX = Math.sqrt( Math.max( 0, 1 - sunH * sunH ) );
	const lace = clamp( web, 0, 1 )
		* floorSunGain( 0, 0, [ sunX, sunH, 0 ], 5.2 )
		* ( 1 - reef * 0.45 ) * caustic;
	const dim = 0.40 + 0.14 * sunH;
	const mul = 1 + lace * FLOOR_LACE_MUL;
	return [
		bed[ 0 ] * dim * mul,
		bed[ 1 ] * dim * mul,
		bed[ 2 ] * dim * mul,
	];

}

/**
 * Extra interface reflection when looking down at a bed. Nadir Fresnel
 * is ~0.02 — the bed then replaces the sea. Ripples get a sky film so
 * the surface stays on top of the caustics. Pass the *mipped* slope
 * length — LOD 0 + capillaries is the look-down grit. Twin of the
 * film in water-surface.js / WATER_FS.
 */
export function floorSurfaceFilm( slopeLen, noV ) {

	const rip = clamp( slopeLen * 3.5, 0, 1 );
	const nadir = smoothstep( 0.35, 0.95, noV );
	return rip * nadir * 0.16;

}

/**
 * Lambertian leaving radiance of the bed. Same units as the water body
 * (`albedo * E / π`). The old `bed * E * 0.30` was an HDR slab that
 * ate the surface.
 */
export function floorLeaving( bed, lace, Edown ) {

	const k = 1 / Math.PI;
	const L = clamp( lace, 0, 1 );
	const mul = 1 + L * FLOOR_LACE_MUL;
	const peak = Math.pow( L, 2.2 );
	return [
		( bed[ 0 ] * 0.46 * mul + bed[ 0 ] * peak * 0.20 * 1.06 ) * Edown * k,
		( bed[ 1 ] * 0.46 * mul + bed[ 1 ] * peak * 0.20 * 1.00 ) * Edown * k,
		( bed[ 2 ] * 0.46 * mul + bed[ 2 ] * peak * 0.20 * 0.88 ) * Edown * k,
	];

}

/**
 * 0..1 shadow of a hull on the bed. The blob is offset along the sun
 * so a high noon sun sits under the craft and a low sun throws it aside.
 */
export function floorShadow( x, z, hull, floorDepth, sun ) {

	if ( ! hull || ! ( hull.push > 0.0005 ) ) return 0;
	const sy = Math.max( sun?.[ 1 ] ?? 0.2, 0.08 );
	const sx = ( hull.x ?? 0 ) + ( sun?.[ 0 ] ?? 0 ) * floorDepth / sy;
	const sz = ( hull.z ?? 0 ) + ( sun?.[ 2 ] ?? 0 ) * floorDepth / sy;
	const R = Math.max( hull.radius ?? 2, 0.8 );
	const q = Math.hypot( x - sx, z - sz ) / R;
	return Math.exp( - q * q );

}
