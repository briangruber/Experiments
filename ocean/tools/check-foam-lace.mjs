#!/usr/bin/env node
// CPU twin of the wind-foam field (src/foam-lace.js).
// The look is an irregular leftover raft (torn emulsion), not a Voronoi web.
// Rejects the looks the live demo already refused:
//   (a) filled circular discs       — occupied Voronoi interiors
//   (b) thin closed polygonal wires — 1-pixel F2−F1
//   (c) a flat unstructured wash    — no torn edges
//   (d) a regular hex tray          — unstretched F2−F1, low area-CV
//   (e) a picket fence of sine lines
//   (f) wake × a wall field         — honeycomb around the hull
// Wake leftover is a milky aerated film (high floor). fd mottles it.
// Asserts Jacobian gating, clump area, cores brighter than mid-edge.

import {
	foamField, foamLaceParts, jacobianGate, wakeFoamMask, cellular3,
} from '../src/foam-lace.js';

let failed = 0;
const check = ( name, cond, detail = '' ) => {

	if ( ! cond ) {

		console.error( 'FAIL', name, detail );
		failed ++;

	}

};

const wind = [ 1, 0 ];
const streak = 0.16;
const detail = 1.85;
const t = 12;

const compactCells = ( sample, darkT = 0.28 ) => {

	const N = sample.length;
	const seen = Array.from( { length: N }, () => Array( N ).fill( false ) );
	let compact = 0;
	for ( let i = 0; i < N; i ++ ) {

		for ( let j = 0; j < N; j ++ ) {

			if ( sample[ i ][ j ] >= darkT || seen[ i ][ j ] ) continue;
			const stack = [ [ i, j ] ];
			seen[ i ][ j ] = true;
			let area = 0, perim = 0;
			let minI = i, maxI = i, minJ = j, maxJ = j;
			while ( stack.length ) {

				const [ x, y ] = stack.pop();
				area ++;
				minI = Math.min( minI, x ); maxI = Math.max( maxI, x );
				minJ = Math.min( minJ, y ); maxJ = Math.max( maxJ, y );
				for ( const [ di, dj ] of [ [ 1, 0 ], [ - 1, 0 ], [ 0, 1 ], [ 0, - 1 ] ] ) {

					const ii = x + di, jj = y + dj;
					if ( ii < 0 || jj < 0 || ii >= N || jj >= N || sample[ ii ][ jj ] >= darkT ) {

						perim ++;
						continue;

					}
					if ( ! seen[ ii ][ jj ] ) {

						seen[ ii ][ jj ] = true;
						stack.push( [ ii, jj ] );

					}

				}

			}
			const w = maxI - minI + 1, h = maxJ - minJ + 1;
			const circ = ( 4 * Math.PI * area ) / ( perim * perim );
			const aspect = Math.max( w, h ) / Math.max( Math.min( w, h ), 1 );
			// Voronoi cells: compact, similar-sized dark pockets. Streaks
			// leave one large sea, not a tray of bowls.
			if ( area >= 8 && area <= 80 && circ > 0.35 && aspect < 2.4 ) compact ++;

		}

	}
	return compact;

};

const darkPocketStats = ( sample, darkT = 0.28 ) => {

	const N = sample.length;
	const seen = Array.from( { length: N }, () => Array( N ).fill( false ) );
	const areas = [];
	let compact = 0;
	for ( let i = 0; i < N; i ++ ) {

		for ( let j = 0; j < N; j ++ ) {

			if ( sample[ i ][ j ] >= darkT || seen[ i ][ j ] ) continue;
			const stack = [ [ i, j ] ];
			seen[ i ][ j ] = true;
			let area = 0, perim = 0;
			let minI = i, maxI = i, minJ = j, maxJ = j;
			while ( stack.length ) {

				const [ x, y ] = stack.pop();
				area ++;
				minI = Math.min( minI, x ); maxI = Math.max( maxI, x );
				minJ = Math.min( minJ, y ); maxJ = Math.max( maxJ, y );
				for ( const [ di, dj ] of [ [ 1, 0 ], [ - 1, 0 ], [ 0, 1 ], [ 0, - 1 ] ] ) {

					const ii = x + di, jj = y + dj;
					if ( ii < 0 || jj < 0 || ii >= N || jj >= N || sample[ ii ][ jj ] >= darkT ) {

						perim ++;
						continue;

					}
					if ( ! seen[ ii ][ jj ] ) {

						seen[ ii ][ jj ] = true;
						stack.push( [ ii, jj ] );

					}

				}

			}
			if ( area < 8 ) continue;
			areas.push( area );
			const w = maxI - minI + 1, h = maxJ - minJ + 1;
			const circ = ( 4 * Math.PI * area ) / ( perim * perim );
			const aspect = Math.max( w, h ) / Math.max( Math.min( w, h ), 1 );
			if ( area <= 80 && circ > 0.35 && aspect < 2.4 ) compact ++;

		}

	}
	const mean = areas.length ? areas.reduce( ( a, b ) => a + b, 0 ) / areas.length : 0;
	const cv = areas.length > 1
		? Math.sqrt( areas.reduce( ( s, a ) => s + ( a - mean ) ** 2, 0 ) / areas.length ) / mean
		: 0;
	return { compact, count: areas.length, areaCV: cv };

};

const ridgeEntropy = ( sample, brightT = 0.45 ) => {

	const N = sample.length;
	const bins = [ 0, 0, 0, 0, 0, 0 ];
	for ( let i = 1; i < N - 1; i ++ ) {

		for ( let j = 1; j < N - 1; j ++ ) {

			if ( sample[ i ][ j ] < brightT ) continue;
			const gx = sample[ i + 1 ][ j ] - sample[ i - 1 ][ j ];
			const gy = sample[ i ][ j + 1 ] - sample[ i ][ j - 1 ];
			const ang = ( Math.atan2( gy, gx ) + Math.PI ) % Math.PI;
			bins[ Math.min( 5, Math.floor( ang / ( Math.PI / 6 ) ) ) ] ++;

		}

	}
	const tot = bins.reduce( ( a, b ) => a + b, 0 ) || 1;
	const p = bins.map( ( b ) => b / tot );
	return - p.reduce( ( s, x ) => s + ( x > 0 ? x * Math.log( x ) : 0 ), 0 ) / Math.log( 6 );

};

{
	let sum = 0, n = 0;
	for ( let i = 0; i < 40; i ++ ) {

		for ( let j = 0; j < 40; j ++ ) {

			sum += foamField( [ i * 3.7 + 11, j * 4.1 + 7 ], t, 8.0, detail, wind, streak ).field;
			n ++;

		}

	}
	check( 'far field mean is ~0.5', Math.abs( sum / n - 0.5 ) < 0.02, `mean ${ ( sum / n ).toFixed( 4 ) }` );

}

{
	const p = [ 40, 25 ];
	const L = foamField( p, t, 0.04, detail, wind, streak );
	check( 'fold=0 yields no foam', jacobianGate( 0 ) * L.field === 0,
		`gate ${ jacobianGate( 0 ) }` );
	check( 'tiny fold almost empty', jacobianGate( 0.01 ) * L.field < 0.02,
		`gated ${ ( jacobianGate( 0.01 ) * L.field ).toFixed( 4 )}` );
	check( 'breaking fold passes the field', Math.abs( jacobianGate( 0.4 ) * L.field - L.field ) < 1e-6,
		`gate ${ jacobianGate( 0.4 )}` );

}

{
	const N = 80;
	const g = [];
	const parts = [];
	const field = [];
	for ( let i = 0; i < N; i ++ ) {

		g[ i ] = [];
		parts[ i ] = [];
		field[ i ] = [];
		for ( let j = 0; j < N; j ++ ) {

			const p = [ i * 0.12 + 4, j * 0.12 + 6 ];
			g[ i ][ j ] = foamField( p, t, 0.04, detail, wind, streak );
			parts[ i ][ j ] = foamLaceParts( p, t, 0.04, detail, wind, streak );
			field[ i ][ j ] = g[ i ][ j ].field;

		}

	}
	let holes = 0, web = 0, mid = 0, n = N * N;
	const seen = Array.from( { length: N }, () => Array( N ).fill( false ) );
	let areas = 0, circSum = 0, comps = 0, tiny = 0;
	const flood = ( si, sj ) => {

		const stack = [ [ si, sj ] ];
		let area = 0, perim = 0;
		seen[ si ][ sj ] = true;
		while ( stack.length ) {

			const [ i, j ] = stack.pop();
			area ++;
			for ( const [ di, dj ] of [ [ 1, 0 ], [ - 1, 0 ], [ 0, 1 ], [ 0, - 1 ] ] ) {

				const ii = i + di, jj = j + dj;
				if ( ii < 0 || jj < 0 || ii >= N || jj >= N || g[ ii ][ jj ].field <= 0.42 ) {

					perim ++;
					continue;

				}
				if ( ! seen[ ii ][ jj ] ) {

					seen[ ii ][ jj ] = true;
					stack.push( [ ii, jj ] );

				}

			}

		}
		return { area, perim };

	};
	let bright = 0, skeleton = 0, interiors = 0;
	let grad = 0, gradN = 0;
	let runSum = 0, runN = 0;
	const nbr4 = [ [ 1, 0 ], [ - 1, 0 ], [ 0, 1 ], [ 0, - 1 ] ];
	for ( let i = 0; i < N; i ++ ) {

		let run = 0;
		for ( let j = 0; j < N; j ++ ) {

			const f = g[ i ][ j ].field;
			if ( f < 0.18 ) holes ++;
			else if ( f > 0.50 ) web ++;
			else mid ++;
			if ( f > 0.42 && ! seen[ i ][ j ] ) {

				const { area, perim } = flood( i, j );
				if ( area < 6 ) tiny ++;
				if ( area >= 8 ) {

					circSum += ( 4 * Math.PI * area ) / ( perim * perim );
					areas += area;
					comps ++;

				}

			}
			if ( i > 0 && j > 0 && i < N - 1 && j < N - 1 && f > 0.45 ) {

				bright ++;
				let nb = 0;
				for ( const [ di, dj ] of nbr4 ) {

					if ( g[ i + di ][ j + dj ].field > 0.42 ) nb ++;

				}
				if ( nb <= 2 ) skeleton ++;
				if ( nb === 4 ) interiors ++;

			}
			if ( j + 1 < N ) {

				grad += Math.abs( f - g[ i ][ j + 1 ].field );
				gradN ++;

			}
			if ( f > 0.45 ) run ++;
			else if ( run ) {

				runSum += run;
				runN ++;
				run = 0;

			}

		}
		if ( run ) {

			runSum += run;
			runN ++;

		}

	}
	const meanArea = comps ? areas / comps : 0;
	const meanCirc = comps ? circSum / comps : 0;
	const skelFrac = bright ? skeleton / bright : 1;
	const interiorFrac = bright ? interiors / bright : 0;
	const meanRun = runN ? runSum / runN : 0;
	const meanGrad = gradN ? grad / gradN : 0;
	const pockets = darkPocketStats( field );

	let cvSum = 0, cvN = 0;
	for ( let i = 4; i < N - 4; i += 4 ) {

		const peaks = [];
		for ( let j = 1; j < N - 1; j ++ ) {

			if ( field[ i ][ j ] > 0.50
				&& field[ i ][ j ] >= field[ i ][ j - 1 ]
				&& field[ i ][ j ] >= field[ i ][ j + 1 ] ) peaks.push( j );

		}
		if ( peaks.length < 4 ) continue;
		const sp = [];
		for ( let k = 1; k < peaks.length; k ++ ) sp.push( peaks[ k ] - peaks[ k - 1 ] );
		const m = sp.reduce( ( a, b ) => a + b, 0 ) / sp.length;
		const sd = Math.sqrt( sp.reduce( ( a, b ) => a + ( b - m ) ** 2, 0 ) / sp.length );
		cvSum += sd / Math.max( m, 1e-4 );
		cvN ++;

	}
	const picketCV = cvN ? cvSum / cvN : 1;

	let coreThick = 0, coreN = 0, edgeThick = 0, edgeN = 0;
	for ( let i = 0; i < N; i ++ ) {

		for ( let j = 0; j < N; j ++ ) {

			const P = parts[ i ][ j ];
			if ( P.core > 0.45 ) {

				coreThick += P.thick;
				coreN ++;

			} else if ( P.crest > 0.30 && P.crest < 0.70 ) {

				edgeThick += P.thick;
				edgeN ++;

			}

		}

	}
	const coreMean = coreN ? coreThick / coreN : 0;
	const edgeMean = edgeN ? edgeThick / edgeN : 0;

	const wake = field.map( ( row ) => row.map( ( f ) => wakeFoamMask( 1, f ) ) );
	const wakePockets = darkPocketStats( wake, 0.28 );
	let wakeSum = 0, wakeHoles = 0;
	for ( let i = 0; i < N; i ++ ) {

		for ( let j = 0; j < N; j ++ ) {

			wakeSum += wake[ i ][ j ];
			if ( wake[ i ][ j ] < 0.18 ) wakeHoles ++;

		}

	}
	const wakeMean = wakeSum / n;

	check( 'rafts have water holes, not a solid sheet', holes > n * 0.02 && web < n * 0.70,
		`holes ${ holes } web ${ web } mid ${ mid } / ${ n }` );
	check( 'has bright clumps', web > n * 0.08,
		`web ${ web } / ${ n }` );
	check( 'mostly a soft raft, not a wire web', mid > n * 0.25,
		`mid ${ mid } / ${ n }` );
	check( 'structure: mean |∇| is torn edges, not a wash', meanGrad > 0.022,
		`mean |∇| ${ meanGrad.toFixed( 4 )}` );
	check( 'filaments have area (not dust)', comps >= 1 && meanArea >= 8,
		`mean area ${ meanArea.toFixed( 1 )} over ${ comps }` );
	check( 'not filled discs (circularity not blob-like)', comps === 0 || meanCirc < 0.62,
		`mean circ ${ meanCirc.toFixed( 3 )}` );
	check( 'almost no dust specks', tiny < n * 0.06, `tiny ${ tiny } / ${ n }` );
	check( 'filaments have width (not a 1-pixel skeleton)', meanRun >= 1.4 && meanRun < 14 && interiorFrac > 0.06 && skelFrac < 0.72,
		`mean run ${ meanRun.toFixed( 2 )} interior ${ interiorFrac.toFixed( 3 )} skeleton ${ skelFrac.toFixed( 3 )}` );
	check( 'lace has navy cell interiors', pockets.count >= 6,
		`dark pockets ${ pockets.count } compact ${ pockets.compact }` );
	check( 'cell sizes vary (not a regular hex tray)', pockets.areaCV > 0.28,
		`area CV ${ pockets.areaCV.toFixed( 3 )}` );
	check( 'not a picket fence of regular lines', picketCV > 0.22,
		`cross-wind peak-spacing CV ${ picketCV.toFixed( 3 )}` );
	check( 'streak cores brighter than mid-edge', coreN >= 8 && edgeN >= 8 && coreMean > edgeMean + 0.04,
		`core ${ coreMean.toFixed( 3 )} edge ${ edgeMean.toFixed( 3 )} (n ${ coreN }/${ edgeN })` );
	check( 'wake leftover is a milky aerated film, not a honeycomb',
		wakeHoles < n * 0.08 && wakeMean > 0.70 && wakeMean < 0.98,
		`holes ${ wakeHoles } / ${ n } mean ${ wakeMean.toFixed( 3 ) }` );
	check( 'wake leftover has no navy honeycomb pockets',
		wakePockets.count < 4,
		`wake pockets ${ wakePockets.count } area CV ${ wakePockets.areaCV.toFixed( 3 ) }` );

}

{
	// Negative control: the refused F2−F1 wall field MUST trip the lattice
	// metric. If this passes, the check is vacuous.
	const N = 80;
	const walls = [];
	for ( let i = 0; i < N; i ++ ) {

		walls[ i ] = [];
		for ( let j = 0; j < N; j ++ ) {

			const c = cellular3( ( i * 0.12 + 4 ) * 0.72, ( j * 0.12 + 6 ) * 0.72 );
			const gap = c.F2 - c.F1;
			const t0 = ( 0.26 - gap ) / ( 0.26 - 0.03 );
			const u = Math.min( 1, Math.max( 0, t0 ) );
			walls[ i ][ j ] = u * u * ( 3 - 2 * u );

		}

	}
	const raw = darkPocketStats( walls );
	check( 'regular F2−F1 tray is more uniform than the lace (negative control)',
		raw.areaCV < 0.28 || raw.compact >= 8,
		`raw area CV ${ raw.areaCV.toFixed( 3 )} compact ${ raw.compact }` );

}

{
	let fine = 0, coarse = 0, n = 0;
	for ( let i = 0; i < 32; i ++ ) {

		for ( let j = 0; j < 32; j ++ ) {

			const p = [ i * 0.7 + 20, j * 0.8 + 9 ];
			fine += foamField( p, t, 0.04, 1.85, wind, streak ).thick;
			coarse += foamField( p, t, 0.04, 0.0, wind, streak ).thick;
			n ++;

		}

	}
	check( 'foamDetail varies streak brightness', Math.abs( fine - coarse ) / n > 0.008,
		`|Δ thick| ${ ( Math.abs( fine - coarse ) / n ).toFixed( 4 )}` );

}

{
	const along = 0.35, streakHi = 0.85;
	let dAlong = 0, dCross = 0, n = 0;
	for ( let i = 0; i < 24; i ++ ) {

		for ( let j = 0; j < 24; j ++ ) {

			const p0 = [ i * 2.3 + 8, j * 2.1 + 5 ];
			const a = foamField( p0, t, 0.04, detail, wind, streakHi ).field;
			const aAlong = foamField( [ p0[ 0 ] + along, p0[ 1 ] ], t, 0.04, detail, wind, streakHi ).field;
			const aCross = foamField( [ p0[ 0 ], p0[ 1 ] + along ], t, 0.04, detail, wind, streakHi ).field;
			dAlong += Math.abs( aAlong - a );
			dCross += Math.abs( aCross - a );
			n ++;

		}

	}
	check( 'wind stretch elongates the streaks', dAlong < dCross,
		`mean Δalong ${ ( dAlong / n ).toFixed( 3 )} Δcross ${ ( dCross / n ).toFixed( 3 )}` );

}

{
	let empty = 0, authored = 0, full = 0, n = 0;
	for ( let i = 0; i < 28; i ++ ) {

		for ( let j = 0; j < 28; j ++ ) {

			const p = [ i * 0.9 + 14, j * 1.1 + 8 ];
			const lo = foamLaceParts( p, t, 0.04, detail, wind, streak, 0.6, 0 );
			const mid = foamLaceParts( p, t, 0.04, detail, wind, streak, 0.6, 0.55 );
			const hi = foamLaceParts( p, t, 0.04, detail, wind, streak, 0.6, 1 );
			empty += lo.residual + lo.veins;
			authored += mid.residual + mid.veins;
			full += hi.residual + hi.veins;
			n ++;

		}

	}
	check( 'foamFill=0 is thinner torn clumps, not a filled sheet', empty / n < authored / n * 0.55,
		`empty ${( empty / n ).toFixed( 3 )} authored ${( authored / n ).toFixed( 3 )}` );
	check( 'foamFill=1 fills the cells more than the authored look', full > authored * 1.15,
		`full ${( full / n ).toFixed( 3 )} authored ${( authored / n ).toFixed( 3 )}` );

}

{
	const countCross = ( cell ) => {

		let crosses = 0, prev = false;
		for ( let i = 0; i < 180; i ++ ) {

			const f = foamField( [ 18 + i * 0.14, 11 ], t, 0.04, detail, wind, streak, 0.6, 0.55, cell ).field;
			const hi = f > 0.45;
			if ( i && hi !== prev ) crosses ++;
			prev = hi;

		}
		return crosses;

	};
	const fine = countCross( 0.4 );
	const coarse = countCross( 2.2 );
	check( 'foamCell enlarges the rafts', coarse < fine,
		`crossings @0.4 ${ fine } @2.2 ${ coarse }` );

}

if ( failed ) {

	console.error( failed + ' foam-lace checks failed' );
	process.exit( 1 );

}

console.log( 'foam-lace: ok' );
