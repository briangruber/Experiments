#!/usr/bin/env node
// The simulated height field: does it actually behave like water?
// No GPU, no browser — the field runs on the CPU, so this is the whole
// physics under test, not a proxy for it.
//
//   node tools/check-ripple-field.mjs

import { RippleField, RIPPLE_DEFAULTS } from '../src/ripple-field.js';

const results = [];
const need = ( name, ok, detail = '' ) => results.push( { name, ok, detail } );

/** Run `secs` at a given frame rate, so substepping is exercised. */
const run = ( f, secs, fps = 60 ) => {

	const dt = 1 / fps;
	for ( let t = 0; t < secs; t += dt ) f.step( dt );
	return f;

};

const fin = ( x, z, extra = {} ) => ( {
	x, z, ax: 0, az: - 1, half: 0.6, r: 0.12, submerged: 1.4, ...extra,
} );

{
	const f = new RippleField();
	need( 'a fresh field is flat and still',
		f.energy() === 0 && f.volume() === 0 );
	need( 'the tile is size × cell across',
		Math.abs( f.extent - 128 * 0.22 * 0.5 ) < 1e-9,
		`${ ( f.extent * 2 ).toFixed( 1 ) } m` );
	need( 'the stable substep comes from the cell size and the wave speed',
		Math.abs( f.maxStep - 0.7 * 0.22 / ( 2 * Math.SQRT2 ) ) < 1e-9,
		`${ ( f.maxStep * 1000 ).toFixed( 1 ) } ms` );
}

{
	// A ring must travel at the speed we asked for, not at whatever the
	// frame rate happens to be. This is the bug in the demo this came
	// from: `height += velocity` bakes the timestep into the constants.
	const ring = ( fps ) => {

		const f = new RippleField( { damping: 0.05, sponge: 8 } );
		f.splash( 0, 0, 0.6, 0.2 );
		run( f, 2, fps );
		return f.peak().radius;

	};
	const at60 = ring( 60 );
	const at30 = ring( 30 );
	const at144 = ring( 144 );
	need( 'a ring travels at about the wave speed',
		Math.abs( at60 - 2 * 2 ) < 0.9,
		`${ at60.toFixed( 2 ) } m in 2 s at 2 m/s` );
	need( 'and the frame rate does not change how fast it goes',
		Math.abs( at30 - at60 ) < 0.35 && Math.abs( at144 - at60 ) < 0.35,
		`30fps ${ at30.toFixed( 2 ) } · 60 ${ at60.toFixed( 2 ) } · 144 ${ at144.toFixed( 2 ) }` );
	need( 'a slower sea carries the same ring a shorter way',
		( () => {

			const f = new RippleField( { speed: 1, damping: 0.05, sponge: 8 } );
			f.splash( 0, 0, 0.6, 0.2 );
			run( f, 2 );
			return f.peak().radius < at60 * 0.75;

		} )(),
		'speed 1 vs 2' );
}

{
	// A big timestep must be substepped, not taken. Taking it blows the
	// CFL limit and the field explodes into NaN within a few frames.
	const f = new RippleField();
	f.splash( 0, 0, 0.8, 0.3 );
	for ( let i = 0; i < 40; i ++ ) f.step( 0.25 );
	const finite = f.h.every( Number.isFinite ) && f.v.every( Number.isFinite );
	need( 'a quarter-second stall is substepped, not exploded',
		finite && f.energy() < 1e4,
		`${ f.substeps } substeps, energy ${ f.energy().toExponential( 1 ) }` );
	need( 'and energy only ever falls',
		( () => {

			const g = new RippleField();
			g.splash( 0, 0, 0.8, 0.3 );
			let prev = Infinity, ok = true;
			for ( let i = 0; i < 200; i ++ ) {

				g.step( 1 / 60 );
				const e = g.energy();
				if ( e > prev * 1.02 ) ok = false;
				prev = e;

			}
			return ok;

		} )() );
}

{
	const f = new RippleField( { damping: 0, sponge: 0 } );
	f.splash( 0, 0, 0.7, 0.25 );
	const v0 = f.volume();
	run( f, 1.5 );
	need( 'with no damping and no sponge, water is neither made nor lost',
		Math.abs( f.volume() - v0 ) < Math.abs( v0 ) * 0.02,
		`${ v0.toFixed( 4 ) } → ${ f.volume().toFixed( 4 ) } m³` );
}

{
	// The edge has to eat what reaches it. A wall would send the fin's
	// own ripples back at it from 14 m away, which is the tell-tale of
	// a pool simulation dropped into open water.
	const walled = new RippleField( { damping: 0, sponge: 0 } );
	const sponged = new RippleField( { damping: 0, sponge: 14 } );
	for ( const f of [ walled, sponged ] ) f.splash( 0, 0, 0.7, 0.25 );
	run( walled, 20 );
	run( sponged, 20 );
	need( 'an absorbing border swallows the ripples instead of returning them',
		sponged.energy() < walled.energy() * 0.2,
		`sponge ${ sponged.energy().toExponential( 1 ) } vs wall ${ walled.energy().toExponential( 1 ) }` );
}

{
	// The object term: add where it was, subtract where it is. Sample well
	// clear of both footprints — where they OVERLAP the two cancel exactly,
	// which is the dipole working, not failing.
	const f = new RippleField( { damping: 0.05 } );
	f.beginDisplacementFrame();
	const wrote = f.displaceMove( fin( 0, 4 ), fin( 0, 0 ) );
	need( 'a moving site writes into the field',
		wrote > 4,
		`${ wrote } cells` );
	need( 'displacement conserves water — it is pushed, not created',
		Math.abs( f.volume() ) < 0.02 * Math.abs( f.sampleAt( 0, 0 ) ) * 128 * 0.22 * 0.22,
		`${ f.volume().toExponential( 1 ) } m³` );
	need( 'the water is DOWN where the body now is',
		f.sampleAt( 0, 0 ) < - 0.01,
		`h ${ f.sampleAt( 0, 0 ).toFixed( 3 ) }` );
	need( 'the live occupancy source is tracked separately from wave height',
		f.sampleSourceAt( 0, 0 ) > 0.01,
		`source ${ f.sampleSourceAt( 0, 0 ).toFixed( 3 ) }` );
	need( 'visible water cancels the temporary source hole without erasing waves',
		Math.abs( f.sampleSurfaceAt( 0, 0 ) ) < 1e-6
			&& f.sampleSurfaceAt( 0, 4 ) > 0.01,
		`raw ${ f.sampleAt( 0, 0 ).toFixed( 3 ) } surface ${ f.sampleSurfaceAt( 0, 0 ).toFixed( 3 ) }` );
	need( 'and UP where it just left',
		f.sampleAt( 0, 4 ) > 0.01,
		`h ${ f.sampleAt( 0, 4 ).toFixed( 3 ) }` );
	need( 'while the ground it stayed on is untouched — add and subtract cancel',
		( () => {

			const g = new RippleField();
			g.displaceMove( fin( 0, 0.3 ), fin( 0, 0 ) );
			return Math.abs( g.sampleAt( 0, 0.15 ) ) < 1e-6;

		} )() );
	need( 'a body that has not moved writes nothing at all',
		( () => {

			const g = new RippleField();
			g.displaceMove( fin( 0, 0 ), fin( 0, 0 ) );
			return g.energy() === 0;

		} )() );
	need( 'nor does one held clear of the water',
		( () => {

			const g = new RippleField();
			g.displaceMove( fin( 0, 0.4, { submerged: 0 } ), fin( 0, 0, { submerged: 0 } ) );
			return g.energy() === 0;

		} )() );
	need( 'a deeper body displaces more, up to the cap',
		( () => {

			const dip = ( d ) => {

				const g = new RippleField();
				g.displaceMove( fin( 0, 4, { submerged: d } ), fin( 0, 0, { submerged: d } ) );
				return g.sampleAt( 0, 0 );

			};
			return dip( 1.2 ) < dip( 0.3 ) * 2
				&& Math.abs( dip( 40 ) - dip( RIPPLE_DEFAULTS.displaceCap ) ) < 1e-9;

		} )(),
		`cap ${ RIPPLE_DEFAULTS.displaceCap } m` );
}

{
	// Drive one across the tile and the pattern must trail it, which is
	// the whole reason for preferring this to four painted Gaussians.
	const f = new RippleField( { damping: 0.3 } );
	let prev = fin( 0, 6 );
	const dt = 1 / 60;
	for ( let i = 0; i < 120; i ++ ) {

		const now = fin( 0, 6 - 4 * dt * ( i + 1 ) );
		f.displaceMove( prev, now );
		f.step( dt );
		prev = now;

	}
	const head = prev.z;
	need( 'a driven site leaves a disturbance behind it, not ahead',
		Math.abs( f.sampleAt( 0, head + 3 ) ) > Math.abs( f.sampleAt( 0, head - 3 ) ) * 1.5,
		`astern ${ f.sampleAt( 0, head + 3 ).toFixed( 3 ) } ahead ${ f.sampleAt( 0, head - 3 ).toFixed( 3 ) }` );
	need( 'that disturbance reaches out to the side as well — it spreads',
		Math.abs( f.sampleAt( 1.6, head + 2 ) ) > 0.002,
		`h ${ f.sampleAt( 1.6, head + 2 ).toFixed( 4 ) }` );
	need( 'nothing has gone to NaN after two seconds of driving',
		f.h.every( Number.isFinite ) );
}

{
	// Following the body: whole cells only. A fractional shift resamples
	// the field every frame and smears every ripple flat.
	const f = new RippleField();
	f.splash( 0, 0, 0.7, 0.3 );
	const before = f.sampleAt( 0, 0 );
	const moved = f.recentreOn( 3.3, - 2.1 );
	need( 'recentring moves the tile in whole cells',
		moved
			&& Math.abs( f.ox / f.cell - Math.round( f.ox / f.cell ) ) < 1e-9
			&& Math.abs( f.oz / f.cell - Math.round( f.oz / f.cell ) ) < 1e-9,
		`origin ${ f.ox.toFixed( 2 ) }, ${ f.oz.toFixed( 2 ) }` );
	need( 'and the water stays where it was in the world, undimmed',
		Math.abs( f.sampleAt( 0, 0 ) - before ) < 1e-6,
		`${ before.toFixed( 4 ) } → ${ f.sampleAt( 0, 0 ).toFixed( 4 ) }` );
	need( 'a shift smaller than a cell is not a shift',
		f.recentreOn( f.ox + f.cell * 0.3, f.oz ) === false );
	need( 'water outside the tile reads as flat, not as an edge',
		f.sampleAt( f.ox + f.extent + 5, f.oz ) === 0 );
	need( 'a jump bigger than the tile starts clean instead of tearing',
		( () => {

			const g = new RippleField();
			g.splash( 0, 0, 0.7, 0.3 );
			g.recentreOn( 400, 400 );
			return g.energy() === 0
				&& Math.abs( g.ox - 400 ) <= g.cell * 0.5
				&& Math.abs( g.ox / g.cell - Math.round( g.ox / g.cell ) ) < 1e-6;

		} )() );
}

{
	// A known ramp, so this measures the read and not the stamp.
	const f = new RippleField();
	const N = f.size;
	for ( let i = 0; i < f.h.length; i ++ ) f.h[ i ] = ( i % N ) * 0.01;
	const a = f.sampleAt( 0, 0 );
	const b = f.sampleAt( f.cell, 0 );
	const mid = f.sampleAt( f.cell * 0.5, 0 );
	need( 'sampling is bilinear, so physics gets a smooth read',
		Math.abs( b - a - 0.01 ) < 1e-6 && Math.abs( mid - ( a + b ) * 0.5 ) < 1e-6,
		`${ a.toFixed( 3 ) } · ${ mid.toFixed( 3 ) } · ${ b.toFixed( 3 ) }` );
	need( 'the tile centre is a cell, so a splash there peaks on it exactly',
		( () => {

			const g = new RippleField();
			g.splash( 0, 0, 1, 0.4 );
			return Math.abs( g.sampleAt( 0, 0 ) - g.peak().height ) < 1e-9
				&& g.peak().radius === 0;

		} )() );
}

{
	const f = new RippleField( { size: 32, cell: 1 } );
	const N = f.size;
	for ( let z = 0; z < N; z ++ ) {

		for ( let x = 0; x < N; x ++ ) {

			const wx = ( x - f.mid ) * f.cell + f.ox;
			f.h[ z * N + x ] = 0.2 * wx;
			f.v[ z * N + x ] = 0.5;

		}

	}
	const sl = f.sampleSlopeAt( 0, 0 );
	need( 'a linear leftover face reports its slope',
		Math.abs( sl.x - 0.2 ) < 0.02 && Math.abs( sl.z ) < 0.02,
		`sl ${ sl.x.toFixed( 3 ) },${ sl.z.toFixed( 3 ) }` );
	need( 'vertical leftover velocity is readable at a world point',
		Math.abs( f.sampleVelAt( 0, 0 ) - 0.5 ) < 1e-6,
		`v ${ f.sampleVelAt( 0, 0 ) }` );
}

{
	// The GPU soft edge must be a circle. Square min(u,v,1-u,1-v) fade
	// was constant along each tile side — the hard ruler on a turning V.
	const src = await import( 'node:fs' ).then( ( fs ) =>
		fs.readFileSync( new URL( '../src/gpu/tsl/ripple-field.js', import.meta.url ), 'utf8' ) );
	need( 'leftover GPU fade is circular, not a square ruler',
		src.includes( 'rippleFadeAt' )
			&& src.includes( 'fromC.dot( fromC ).sqrt().mul( 2.0 )' )
			&& ! /uv\.x\.min\(\s*uv\.y\s*\)/.test( src ) );
	need( 'leftover GPU samples clamp height so a bad tile cannot stand the mesh up',
		src.includes( 'uRippleHeightCap' ) && src.includes( 'clamp(' ) );
}

{
	const f = new RippleField( { size: 96, cell: 0.25, damping: 0.4, sponge: 6 } );
	f.splashAlong( 0, 0, 0, 0.4, 2.2, 1 );
	const aft = f.sampleAt( 0, - 1.4 );
	const abeam = f.sampleAt( 1.4, 0 );
	need( 'a jet leftover stamp is a streak along heading, not a raindrop',
		aft > 0.2 && aft > abeam * 4,
		`aft ${ aft.toFixed( 3 ) } abeam ${ abeam.toFixed( 3 ) }` );
}

{
	const f = new RippleField( { heightCap: 0.4, damping: 0.05, sponge: 8 } );
	f.splash( 0, 0, 1.2, 2.5 );
	need( 'a height cap stops leftover splash becoming a vertex tower',
		f.peak().height <= 0.4 + 1e-6,
		`peak ${ f.peak().height.toFixed( 3 ) }` );
}

const failed = results.filter( ( r ) => ! r.ok );
for ( const r of results ) {

	console.log( `${ r.ok ? 'ok' : 'FAIL' }  ${ r.name }${ r.detail ? ` — ${ r.detail }` : '' }` );

}
console.log( `${ results.length - failed.length }/${ results.length } ok` );
process.exit( failed.length ? 1 : 0 );
