// CPU twin of the composite-pass radial scale (COMPOSITE_FS / compositeFragment).
// Positive k pins the corners; negative k must not magnify or the mid-edges
// sample past the render target and clamp-to-edge smears the first/last row.

export function distortionScale( k, rn2 ) {

	const denom = k >= 0 ? 1 + k : 1;
	return ( 1 + k * rn2 ) / Math.max( denom, 1e-4 );

}

// Sample coordinate at a point in GLSL vUv space (y=0 bottom), after distortion
// and before chromatic / lens offsets. asp is (width/height, 1).
export function distortedUv( uv, k, aspect ) {

	const d = [ uv[ 0 ] - 0.5, uv[ 1 ] - 0.5 ];
	const asp = [ aspect, 1 ];
	const p = [ d[ 0 ] * asp[ 0 ], d[ 1 ] * asp[ 1 ] ];
	const r2max = ( 0.5 * asp[ 0 ] ) ** 2 + ( 0.5 * asp[ 1 ] ) ** 2;
	const rn2 = ( p[ 0 ] * p[ 0 ] + p[ 1 ] * p[ 1 ] ) / r2max;
	const kd = distortionScale( k, rn2 );
	return [ 0.5 + p[ 0 ] * kd / asp[ 0 ], 0.5 + p[ 1 ] * kd / asp[ 1 ] ];

}
