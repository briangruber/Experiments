// Mandible hinge for the sea-dragon meshes. CPU twin of the vertex-stage
// rotate in src/gpu/tsl/creature.js — same numbers, so a slider or a live
// gape that moves the chin here moves it on the GPU.
//
// Both baked meshes ship jaw-dropped, with no animation channels. The
// mandible ends at the mouth corner, so this is a geometric hinge rather
// than a bone: rotate verts below and forward of that corner up around +X.
// Measured on the Current mesh at sdLength=60: corner at y=0.85, z=-22.4
// (fractions 0.0142 / -0.373 of length); a 0.30 rad shut lifts the chin
// ~2 m and a full 1.0 rad meets the upper teeth. The Sea serpent's reared
// head has its own corner (0.260 / -0.400).

export function smoothstep( lo, hi, x ) {

	const t = Math.min( Math.max( ( x - lo ) / ( hi - lo ), 0 ), 1 );
	return t * t * ( 3 - 2 * t );

}

/** Weight in 0..1: 1 on the dropped mandible, 0 on the skull and everything aft. */
export function jawWeight( y, z, length, hyFrac, hzFrac ) {

	const L = Math.max( length, 1e-3 );
	const hy = hyFrac * L;
	const hz = hzFrac * L;
	const along = z - hz;
	const below = hy - y;
	const wZ = 1 - smoothstep( - 0.02 * L, 0.015 * L, along );
	const wY = smoothstep( 0, 0.02 * L, below );
	return wZ * wY;

}

/**
 * Rotate a bind-pose point (and optional normal) by `gape` radians of shut.
 * `gape` 0 leaves the modelled-open rest; positive swings the mandible up.
 */
export function jawRotate( p, n, gape, length, hyFrac, hzFrac ) {

	const w = jawWeight( p.y, p.z, length, hyFrac, hzFrac );
	const ang = gape * w;
	const L = Math.max( length, 1e-3 );
	const hy = hyFrac * L;
	const hz = hzFrac * L;
	const c = Math.cos( ang ), s = Math.sin( ang );
	const dy = p.y - hy, dz = p.z - hz;
	const out = {
		x: p.x,
		y: hy + dy * c - dz * s,
		z: hz + dy * s + dz * c,
	};
	if ( ! n ) return { p: out, n: null, w };
	return {
		p: out,
		n: {
			x: n.x,
			y: n.y * c - n.z * s,
			z: n.y * s + n.z * c,
		},
		w,
	};

}

/** Radians actually applied this frame: slider rest, opened by the live gape. */
export function jawShutAngle( sdGape, liveGape ) {

	const rest = Math.max( 0, sdGape ?? 0 );
	const open = Math.min( 1, Math.max( 0, liveGape ?? 0 ) );
	return rest * ( 1 - open );

}
