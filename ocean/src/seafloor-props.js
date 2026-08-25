// Rocks and coral sitting ON the virtual bed.
//
// The seafloor itself is a heightfield (src/seafloor.js). These are the
// authored GLBs from models/ — three rock piles, three corals — scattered
// on that bed with a deterministic seed. Coral prefers reef patches;
// rocks prefer sand. A change here is not done until
// tools/check-seafloor-props.mjs passes.
//
// The meshes are scene decoration (refraction sees them through the
// water). They are not OceanBodies: they do not float, wake, or splash.

import {
	floorDepthAt, floorDepthBounds, floorReef, FLOOR_TERRAIN_SCALE,
} from './seafloor.js';

const TAU = Math.PI * 2;

/**
 * Authored assets. `height` is the GLB's native Y extent (metres) —
 * origin sits on the base, so a uniform scale of S is S metres tall.
 */
export const FLOOR_PROP_KINDS = [
	{ id: 'rocks1', role: 'rock', file: 'rocks1.glb', height: 0.497 },
	{ id: 'rocks2', role: 'rock', file: 'rocks2.glb', height: 0.384 },
	{ id: 'rocks3', role: 'rock', file: 'rocks3.glb', height: 0.861 },
	{ id: 'coral1', role: 'coral', file: 'coral1.glb', height: 0.622 },
	{ id: 'coral2', role: 'coral', file: 'coral2.glb', height: 0.793 },
	{ id: 'coral3', role: 'coral', file: 'coral3.glb', height: 1.000 },
];

/** Warm / cool / olive / dark / rust. Multipliers on the GLB albedo. */
export const ROCK_TINTS = [
	[ 1.04, 0.96, 0.84 ],
	[ 0.78, 0.82, 0.88 ],
	[ 0.86, 0.90, 0.74 ],
	[ 0.62, 0.60, 0.56 ],
	[ 1.08, 0.82, 0.64 ],
];

/** Peach / pink / cream / teal / gold / lavender. */
export const CORAL_TINTS = [
	[ 1.16, 0.70, 0.58 ],
	[ 1.22, 0.52, 0.68 ],
	[ 1.06, 0.96, 0.80 ],
	[ 0.42, 0.88, 0.82 ],
	[ 1.14, 0.84, 0.42 ],
	[ 0.82, 0.52, 0.92 ],
];

export const FLOOR_PROP_DEFAULTS = {
	seed: 17,
	count: 80,
	radius: 110,
	clear: 12,
	/** How far a tip may break the surface, metres. */
	emerge: 0.22,
	/** Bury the base so the contact is sand, not a hover. */
	sink: 0.05,
	rockScale: [ 1.35, 4.4 ],
	coralScale: [ 1.15, 3.4 ],
	rockTilt: 0.16,
	coralTilt: 0.08,
};

function mulberry32( seed ) {

	let s = ( seed >>> 0 ) || 1;
	return () => {

		s += 0x6D2B79F5;
		let t = Math.imul( s ^ ( s >>> 15 ), 1 | s );
		t ^= t + Math.imul( t ^ ( t >>> 7 ), 61 | t );
		return ( ( t ^ ( t >>> 14 ) ) >>> 0 ) / 4294967296;

	};

}

function pick( rnd, list ) {

	return list[ Math.min( list.length - 1, Math.floor( rnd() * list.length ) ) ];

}

/**
 * Scatter rocks / coral on the live bed. `opts` may be `abyssal.params`
 * plus the knobs in FLOOR_PROP_DEFAULTS. Empty when there is no bed.
 *
 * @returns {Array<{
 *   kind: string, role: string, file: string,
 *   x: number, y: number, z: number,
 *   yaw: number, tiltX: number, tiltZ: number, scale: number,
 *   tint: number[], tintI: number,
 *   depth: number, reef: number,
 * }>}
 */
export function placeFloorProps( opts = {} ) {

	const d = FLOOR_PROP_DEFAULTS;
	const sea = opts.seaLevel ?? 0;
	const bed = floorDepthBounds(
		opts.floorDepthMin ?? 0,
		opts.floorDepthMax ?? 0,
		opts.floorDepth ?? 0,
	);
	if ( ! bed.live ) return [];

	const terrain = opts.floorTerrainScale ?? FLOOR_TERRAIN_SCALE;
	const count = Math.max( 0, opts.count ?? d.count );
	const radius = Math.max( 8, opts.radius ?? d.radius );
	const clear = Math.max( 0, opts.clear ?? d.clear );
	const emerge = opts.emerge ?? d.emerge;
	const sink = opts.sink ?? d.sink;
	const kinds = opts.kinds ?? FLOOR_PROP_KINDS;
	const rocks = kinds.filter( ( k ) => k.role === 'rock' );
	const corals = kinds.filter( ( k ) => k.role === 'coral' );
	if ( ! rocks.length && ! corals.length ) return [];

	const rnd = mulberry32( opts.seed ?? d.seed );
	const out = [];
	const tries = Math.max( count * 16, 64 );

	for ( let n = 0; n < tries && out.length < count; n ++ ) {

		// Uniform-in-area alone piles everything on the far ring.
		// Keep a dense inner garden around the ski, then a thinner outer.
		const innerR = Math.min( radius, 56 );
		const inner = rnd() < 0.50;
		const rLo = inner ? clear : innerR;
		const rHi = inner ? innerR : radius;
		const r = rLo + Math.max( rHi - rLo, 0 ) * Math.sqrt( rnd() );
		const a = rnd() * TAU;
		const x = Math.cos( a ) * r;
		const z = Math.sin( a ) * r;
		if ( Math.hypot( x, z ) < clear ) continue;

		const depth = floorDepthAt( x, z, bed.min, bed.max, terrain );
		if ( ! ( depth > 0.15 ) ) continue;

		const reef = floorReef( x, z );
		const wantCoral = rnd() < ( 0.16 + reef * 0.74 );
		const pool = wantCoral
			? ( corals.length ? corals : rocks )
			: ( rocks.length ? rocks : corals );
		const kind = pick( rnd, pool );
		const role = kind.role;
		const [ lo, hi ] = role === 'coral' ? ( opts.coralScale ?? d.coralScale )
			: ( opts.rockScale ?? d.rockScale );
		const t = rnd();
		let scale = lo * Math.pow( hi / Math.max( lo, 1e-4 ), t * t );
		const maxS = ( depth + emerge ) / Math.max( kind.height, 0.08 );
		scale = Math.min( scale, maxS );
		if ( scale < lo * 0.55 ) continue;

		const minDist = 2.2 + 0.55 * scale;
		let clash = false;
		for ( let i = 0; i < out.length; i ++ ) {

			const p = out[ i ];
			if ( Math.hypot( x - p.x, z - p.z ) < minDist ) {

				clash = true;
				break;

			}

		}
		if ( clash ) continue;

		const tilt = role === 'coral' ? ( opts.coralTilt ?? d.coralTilt )
			: ( opts.rockTilt ?? d.rockTilt );
		const tints = role === 'coral' ? CORAL_TINTS : ROCK_TINTS;
		const tintI = Math.min( tints.length - 1, Math.floor( rnd() * tints.length ) );
		out.push( {
			kind: kind.id,
			role,
			file: kind.file,
			x, z,
			y: sea - depth - sink * scale,
			yaw: rnd() * TAU,
			tiltX: ( rnd() * 2 - 1 ) * tilt,
			tiltZ: ( rnd() * 2 - 1 ) * tilt,
			scale,
			tint: tints[ tintI ],
			tintI,
			depth,
			reef,
		} );

	}

	return out;

}
