// Where a posed mesh actually cuts the sea, as a list of spray sites.
//
// No GPU, no three: the profile is a handful of typed arrays built once from
// the geometry (buildBreachProfile in src/gpu/tsl/craft.js), and this file
// only walks that profile against a pose. The spray sim then parks one
// emitter at each site the same frame.
//
// A station counts only when it PIERCES - highest point above the sea AND
// lowest point still below. "Top is above water" used to mark a whole dry
// back as a run, then park sites at that station's MAX half-width (the
// underwater belly / pectorals). Fins that actually cut the water got
// nothing; six wide flank stamps drew wakes from parts that never broke.
//
// Every pierce run gets a site before any run gets a second one. Taking
// crossings in nose-to-tail order spent the whole cap on the shoulders,
// so the dorsal spikes further back - each their own short run - never
// received an emitter. A short or thin run is a spike: one site on the
// spine at its highest station. A long awash flank still gets both sides.
//
// `band` (the spray-band slider) lowers the sea used for the pierce test
// so a spike that is visibly cutting a trough or sitting just under mean
// level still counts. Placement itself stays on the mean waterline.
//
// ANY mesh with a breach profile can drive this.

export const MAX_BREACH_EMITTERS = 50;

const TAU = Math.PI * 2;

function smoothstep( lo, hi, x ) {

	const t = Math.min( Math.max( ( x - lo ) / ( hi - lo ), 0 ), 1 );
	return t * t * ( 3 - 2 * t );

}

// CPU twin of creature.js's vertex wave. Keep the numeric and panel-label axis
// forms because the preset stores 0/1/2 while touching the enum stores text.
function swimOffsetAt( swim, z ) {

	if ( ! swim || ! ( swim.length > 0 ) ) return { x: 0, y: 0 };
	const axis = swim.axis;
	const upDown = axis === 1 || axis === 'Up and down';
	const sideways = axis === 0 || axis === 'Sideways' || axis == null;
	const sideOn = upDown ? 0 : 1;
	const liftOn = sideways ? 0 : 1;
	const s = Math.min( Math.max( ( z + swim.length * 0.5 ) / swim.length, 0 ), 1 );
	const ramp = smoothstep( 0.06, 0.85, s );
	const sweep = ( swim.amp ?? 0 ) * swim.length * ramp;
	const ph = s * ( swim.waves ?? 0 ) * TAU - ( swim.phase ?? 0 );
	const quarter = sideOn && liftOn ? Math.PI * 0.5 : 0;
	return {
		x: Math.sin( ph ) * sweep * sideOn,
		y: Math.sin( ph + quarter ) * sweep * liftOn,
	};

}

/**
 * Contiguous stretches of a posed body that sit above the sea, plus the
 * highest station. Pitch is applied the same way demo/seadragon.js pitches
 * the animal (nose at local -Z rises as pitch goes positive).
 *
 * Averaging two distant fins into one span is how this used to put spray on
 * the neck BETWEEN them, which is underwater. Runs stay separate on purpose.
 *
 * @param {{minZ:number, maxZ:number, top:Float32Array, low?:Float32Array, half?:Float32Array}} stations
 * @param {{originY?:number, pitch?:number, seaLevel?:number, band?:number, swim?:object}} [pose]
 * @returns {{top:number, bottom:number, bestZ:number, bottomZ:number, runs:Array<{lo:number, hi:number}>}}
 */
export function breachRuns( stations, pose = {} ) {

	const { minZ, maxZ, top, low } = stations;
	const n = top?.length ?? 0;
	const originY = pose.originY ?? 0;
	const pitch = pose.pitch ?? 0;
	const seaLevel = pose.seaLevel ?? 0;
	const band = Math.max( pose.band ?? 0, 0 );
	if ( ! n || ! ( maxZ > minZ ) ) {

		return { top: originY, bottom: originY, bestZ: 0, bottomZ: 0, runs: [] };

	}
	const cp = Math.cos( pitch ), sp = Math.sin( pitch );
	const step = ( maxZ - minZ ) / n;
	let best = - Infinity, bestZ = 0;
	let bottom = Infinity, bottomZ = 0;
	const runs = [];
	let start = null;
	for ( let b = 0; b < n; b ++ ) {

		const z = minZ + step * ( b + 0.5 );
		// The up/down wave moves the whole cross-section before the mesh pose,
		// exactly as creature.js does. A sideways wave has no world-Y component
		// here (roll is deliberately outside this profile approximation).
		const lift = swimOffsetAt( pose.swim, z ).y;
		const yTop = originY + ( top[ b ] + lift ) * cp - z * sp;
		if ( yTop > best ) { best = yTop; bestZ = z; }
		// Missing low (older synthetic profiles) → treat as always under, so
		// pierce ≡ top above water. With low, a fully emerged back is NOT a
		// run: the waterline is only the belt where the mesh actually cuts.
		const yLow = low && Number.isFinite( low[ b ] )
			? originY + ( low[ b ] + lift ) * cp - z * sp
			: - Infinity;
		if ( Number.isFinite( yLow ) && yLow < bottom ) {

			bottom = yLow;
			bottomZ = z;

		}
		const pierce = yTop > seaLevel - band && yLow < seaLevel + band;
		if ( pierce && start === null ) start = z;
		if ( ( ! pierce || b === n - 1 ) && start !== null ) {

			runs.push( { lo: start, hi: z } );
			start = null;

		}

	}
	return {
		top: best,
		bottom: Number.isFinite( bottom ) ? bottom : originY,
		bestZ,
		bottomZ,
		runs,
	};

}

/**
 * Occupancy-station radii from the mesh waterline, not the implicit eel.
 *
 * Each breach-profile bin that actually pierces (same test as breachRuns)
 * donates its waterline half-width to the nearest occupancy station. A
 * thin fin between two stations still lifts; a dry neck between two
 * humps stays 0, so the swell cannot draw a tube through empty water.
 *
 * No usable profile → every entry -1, the sentinel that keeps the
 * analytic capsule (rigid bodies, checks without a mesh).
 *
 * @param {{minZ:number, maxZ:number, top:Float32Array, low?:Float32Array, half?:Float32Array, band?:Float32Array, yBins?:number}} stations
 * @param {{originY?:number, origin?:number[], pitch?:number, seaLevel?:number, band?:number, swim?:object, minHalf?:number}} [pose]
 * @param {number} [n=9] - occupancy station count (BODY_STATIONS).
 * @returns {Float32Array}
 */
export function meshSheathRadii( stations, pose = {}, n = 9 ) {

	const out = new Float32Array( n );
	const { minZ, maxZ, top, low, half } = stations ?? {};
	const bins = top?.length ?? 0;
	if ( ! n || ! bins || ! ( maxZ > minZ ) ) {

		out.fill( - 1 );
		return out;

	}
	const originY = pose.originY ?? pose.origin?.[ 1 ] ?? 0;
	const pitch = pose.pitch ?? 0;
	const seaLevel = pose.seaLevel ?? 0;
	const band = Math.max( pose.band ?? 0, 0 );
	const swim = pose.swim;
	const minHalf = pose.minHalf ?? 0.25;
	const span = maxZ - minZ;
	const step = span / bins;
	const cp = Math.cos( pitch ), sp = Math.sin( pitch );

	const halfAt = ( z, b ) => {

		const fallback = ( half && Number.isFinite( half[ b ] ) && half[ b ] > 0 )
			? Math.max( half[ b ], minHalf )
			: minHalf;
		const yBand = stations.band;
		const yBins = stations.yBins ?? 0;
		const lo = low?.[ b ], hi = top[ b ];
		if ( ! yBand || ! yBins || ! ( hi > lo ) ) return fallback;
		const yW = ( seaLevel - originY + z * sp ) / Math.max( cp, 1e-4 )
			- swimOffsetAt( swim, z ).y;
		const ybWant = ( yW - lo ) / ( hi - lo ) * ( yBins - 1 );
		let best = 0, bestD = Infinity;
		for ( let yb = 0; yb < yBins; yb ++ ) {

			const v = yBand[ b * yBins + yb ];
			if ( ! ( v > 0 ) ) continue;
			const d = Math.abs( yb - ybWant );
			if ( d < bestD ) { bestD = d; best = v; }

		}
		return best > 0 ? Math.max( best, minHalf ) : fallback;

	};

	for ( let b = 0; b < bins; b ++ ) {

		const z = minZ + step * ( b + 0.5 );
		const lift = swimOffsetAt( swim, z ).y;
		const yTop = originY + ( ( top[ b ] ?? 0 ) + lift ) * cp - z * sp;
		const yLow = low && Number.isFinite( low[ b ] )
			? originY + ( low[ b ] + lift ) * cp - z * sp
			: - Infinity;
		if ( ! ( yTop > seaLevel - band && yLow < seaLevel + band ) ) continue;
		const s = ( z - minZ ) / span;
		const i = Math.min( n - 1, Math.max( 0, Math.round( s * ( n - 1 ) ) ) );
		const r = halfAt( z, b );
		if ( r > out[ i ] ) out[ i ] = r;

	}
	return out;

}

/**
 * Place up to `count` spray emitters on the waterline where a posed mesh
 * pierces the sea. Crossings first (both flanks); extra samples only on a
 * long awash stretch. Width is the body's beam AT the waterline, not the
 * max half-width of that station (which is usually an underwater pectoral).
 *
 * @param {{minZ:number, maxZ:number, top:Float32Array, half?:Float32Array}} stations
 * @param {object} opts
 * @param {number[]|{0:number,1:number,2:number}} opts.origin
 * @param {number} opts.heading
 * @param {number} [opts.pitch=0]
 * @param {number} [opts.seaLevel=0]
 * @param {number} [opts.count=4]
 * @param {number} [opts.minHalf=0.25]
 * @param {number} [opts.band=0] - metres below mean sea that still count as a pierce
 * @param {{length:number, waves:number, amp:number, phase:number, axis:number|string}} [opts.swim]
 * @returns {{top:number, bottom:number, bestZ:number, bottomZ:number, runs:Array, sites:Array, halfLen:number, wake:object|null, fore:object|null}}
 */
export function placeBreachEmitters( stations, opts ) {

	const origin = opts.origin;
	const heading = opts.heading ?? 0;
	const pitch = opts.pitch ?? 0;
	const seaLevel = opts.seaLevel ?? 0;
	const minHalf = opts.minHalf ?? 0.25;
	const nWant = Math.max( 1, Math.min( MAX_BREACH_EMITTERS, Math.round( opts.count ?? 4 ) ) );
	const band = Math.max( opts.band ?? 0, 0 );
	const swim = opts.swim;
	const info = breachRuns( stations, {
		originY: origin[ 1 ], pitch, seaLevel, band, swim,
	} );
	const { minZ, maxZ, half } = stations;
	const bins = stations.top?.length ?? 0;
	const span = maxZ - minZ;
	const bodyLen = span > 0 ? span : 1;

	const binAt = ( z ) => {

		if ( ! bins || ! ( span > 0 ) ) return 0;
		let b = Math.floor( ( z - minZ ) / span * bins );
		if ( b < 0 ) b = 0; else if ( b >= bins ) b = bins - 1;
		return b;

	};

	// World-horizontal sea, in the mesh frame. Pitch tilts local Y against Z.
	const localWaterY = ( z ) => {

		const cp = Math.cos( pitch ), sp = Math.sin( pitch );
		return ( seaLevel - origin[ 1 ] + z * sp ) / Math.max( cp, 1e-4 )
			- swimOffsetAt( swim, z ).y;

	};

	const halfAt = ( z ) => {

		const b = binAt( z );
		const fallback = ( half && Number.isFinite( half[ b ] ) && half[ b ] > 0 )
			? Math.max( half[ b ], minHalf )
			: minHalf;
		const band = stations.band;
		const yBins = stations.yBins ?? 0;
		const lo = stations.low?.[ b ], hi = stations.top?.[ b ];
		if ( ! band || ! yBins || ! ( hi > lo ) ) return fallback;
		const yW = localWaterY( z );
		const ybWant = ( yW - lo ) / ( hi - lo ) * ( yBins - 1 );
		let best = 0, bestD = Infinity;
		for ( let yb = 0; yb < yBins; yb ++ ) {

			const v = band[ b * yBins + yb ];
			if ( ! ( v > 0 ) ) continue;
			const d = Math.abs( yb - ybWant );
			if ( d < bestD ) { bestD = d; best = v; }

		}
		return best > 0 ? Math.max( best, minHalf ) : fallback;

	};

	// Same travelling-sine and AXIS the mesh swims (creature.js), so an
	// up/down swimmer changes which cross-section cuts the water instead of
	// dragging every source sideways as though it were still an eel.
	const lateralAt = ( z ) => {

		return swimOffsetAt( swim, z ).x;

	};

	const sx = Math.sin( heading ), cx = Math.cos( heading );
	const siteAt = ( z, side, kind ) => {

		const hw = halfAt( z );
		const lat = lateralAt( z );
		const xOff = cx * ( side * hw + lat );
		const zOff = sx * ( side * hw + lat );
		return {
			x: origin[ 0 ] - sx * z + xOff,
			y: seaLevel,
			z: origin[ 2 ] + cx * z + zOff,
			side,
			half: hw,
			kind,
			along: z,
		};

	};

	const runs = info.runs;
	const nose = siteAt( minZ, 0, 'nose' );
	const headSpan = Math.max( span * 0.20, 4 );
	if ( ! runs.length ) {

		const fallback = siteAt( info.bestZ ?? 0, 1, 'fallback' );
		return {
			...info,
			sites: [ fallback ],
			halfLen: Math.max( bodyLen * 0.03, minHalf ),
			wake: null,
			fore: null,
			nose,
			headWet: false,
		};

	}

	const step = bins && span > 0 ? span / bins : 0;
	const cp = Math.cos( pitch ), sp = Math.sin( pitch );
	const peakOf = ( r ) => {

		let bestZ = ( r.lo + r.hi ) * 0.5, best = - Infinity;
		for ( let b = 0; b < bins; b ++ ) {

			const z = minZ + step * ( b + 0.5 );
			if ( z < r.lo - step || z > r.hi + step ) continue;
			const lift = swimOffsetAt( swim, z ).y;
			const yTop = origin[ 1 ] + ( ( stations.top[ b ] ?? 0 ) + lift ) * cp - z * sp;
			if ( yTop > best ) { best = yTop; bestZ = z; }

		}
		return bestZ;

	};

	// Four waves so a tail spike is not starved by the head's crossings:
	//  0 every run, once (spike peak, or the front of a long flank)
	//  1 the rest of that run's first pair
	//  2 the far crossing of a long run
	//  3 extras along a long awash stretch
	const waves = [ [], [], [], [] ];
	for ( const r of runs ) {

		const len = r.hi - r.lo;
		const peak = peakOf( r );
		// A short run is a fin or dorsal spike. Thin-but-long is a ridge:
		// still a run with two ends, not a single peak.
		const spike = len <= bodyLen * 0.06;
		if ( spike ) {

			waves[ 0 ].push( { z: peak, side: 0, kind: 'spike' } );
			continue;

		}
		waves[ 0 ].push( { z: r.lo, side: 1, kind: 'cross' } );
		waves[ 1 ].push( { z: r.lo, side: - 1, kind: 'cross' } );
		waves[ 1 ].push( { z: r.hi, side: 1, kind: 'cross' } );
		waves[ 2 ].push( { z: r.hi, side: - 1, kind: 'cross' } );
		if ( len > bodyLen * 0.06 ) {

			const extra = Math.max( 0, Math.floor( len / ( bodyLen * 0.08 ) ) );
			for ( let i = 1; i <= extra; i ++ ) {

				waves[ 3 ].push( {
					z: r.lo + len * ( i / ( extra + 1 ) ),
					side: i % 2 === 0 ? 1 : - 1,
					kind: 'flank',
				} );

			}

		}

	}

	const sites = [];
	for ( const wave of waves ) {

		for ( const p of wave ) {

			if ( sites.length >= nWant ) break;
			sites.push( siteAt( p.z, p.side, p.kind ) );

		}

	}

	// Wake span is the FULL emerged runs, on the spine - not the handful of
	// spray sites. Those prefer crossings and can all sit on one fin, which
	// is how foam started halfway down a body that was piercing from the
	// nose. Side 0 so the stamp is along the animal, not a port-to-starboard
	// diagonal that misses a flank.
	const fx = sx, fz = - cx;
	const ends = [];
	for ( const r of runs ) {

		ends.push( siteAt( r.lo, 0, 'run' ), siteAt( r.hi, 0, 'run' ) );

	}
	let wake = ends[ 0 ], wakeDot = Infinity;
	let fore = ends[ 0 ], foreDot = - Infinity;
	for ( const s of ends ) {

		const d = s.x * fx + s.z * fz;
		if ( d < wakeDot ) { wakeDot = d; wake = s; }
		if ( d > foreDot ) { foreDot = d; fore = s; }

	}

	const headWet = runs.some( ( r ) => r.lo <= minZ + headSpan );
	return {
		...info,
		sites,
		halfLen: Math.max( bodyLen / ( 2 * Math.max( sites.length, 1 ) ), minHalf ),
		wake,
		fore,
		nose,
		headWet,
	};

}
