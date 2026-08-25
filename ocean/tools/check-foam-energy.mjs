#!/usr/bin/env node
// Persistent foam energy. Coverage is leftover material. Lace only dissolves.
//
//   node tools/check-foam-energy.mjs

import {
	FoamEnergyField, foamEnergyDecay, foamEnergyHullInject, foamEnergyAcross,
	foamEnergyCrestInject, foamEnergyMotorInject,
	foamEnergyPlanformK, foamEnergyPlanformHalf, foamEnergyPlanformSamples,
	foamEnergyStep, foamEnergyMask, foamEnergyWaveFlow, foamEnergyWaveActivity,
	foamEnergyWaveGather, foamEnergyCrestGate, foamEnergyDivergeFlow, foamEnergyOpenTan,
	foamEnergyWaveRide, foamEnergyAlong, FOAM_ENERGY_ALONG_FLOOR,
	foamEnergyWakeOpen, foamEnergyLane, FOAM_ENERGY_WAKE_CHANNEL,
	foamEnergyTurnBias, foamEnergyWakeCarve, foamEnergyCarvePersist,
	FOAM_ENERGY_WAKE_CARVE_AFT,
	FOAM_ENERGY_WAKE_CARVE,
	foamEnergyArmWarp, foamEnergyPeelSide, foamEnergyPeelReach, foamEnergyHullOwn,
	wakeFoamDecayOf, foamEnergyBrush, foamEnergyPath,
	foamEnergySweep, foamEnergyLiveHull,
	FOAM_ENERGY_DECAY, FOAM_ENERGY_TELEPORT, FOAM_ENERGY_MAX,
	FOAM_ENERGY_CREST, FOAM_ENERGY_CREST_TEST, FOAM_ENERGY_RIBBON_W,
	FOAM_ENERGY_WAVE_CARRY, FOAM_ENERGY_ARM_JITTER,
	FOAM_ENERGY_CARRY_MAX, foamEnergyCarryBoost,
} from '../src/foam-energy.js';
import { leftoverBubbleRide } from '../src/leftover-bubbles.js';
import { KELVIN_TAN } from '../src/kelvin-wake.js';
import { sourceStir } from '../src/wake-interact.js';
import {
	wakeFoamAgePattern, wakeFoamFilm, wakeFoamRibbonVary, wakeFoamRibbonFilm,
	wakeFoamRibbonAmount, wakeFoamRibbonWarp, wakeFoamRibbonBreak, wakeFoamPackUv,
	WAKE_FOAM_RIBBON_VARY, wakeFoamEnergyLook,
} from '../src/foam-lace.js';
import { wakeWaveSlopeAt, wakeWaveSlopeFieldAt, wakeWaveWidth } from '../src/wake-wave.js';
import { defaults } from '../src/presets.js';
import { WATER_FS } from '../src/shaders/water.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join( dirname( fileURLToPath( import.meta.url ) ), '..' );
const TSL_WATER = readFileSync( join( ROOT, 'src/gpu/tsl/water-surface.js' ), 'utf8' );
const TSL_ENERGY = readFileSync( join( ROOT, 'src/gpu/tsl/foam-energy.js' ), 'utf8' );
const TSL_DRIVER = readFileSync( join( ROOT, 'src/gpu/tsl/foam-energy-driver.js' ), 'utf8' );
const TSL_COMMON = readFileSync( join( ROOT, 'src/gpu/tsl/water-common.js' ), 'utf8' );
const CPU_ENERGY = readFileSync( join( ROOT, 'src/foam-energy.js' ), 'utf8' );
const RIBBON_SIDE = 0.35; // safely inside the flat-topped half-beam ribbon
const TEST_DIVERGE = 1.35; // live runtime default is intentionally zero

const results = [];
const need = ( name, ok, detail = '' ) => results.push( { name, ok, detail } );

{
	const movingRight = {
		sampleSlopeAt: () => ( { x: - 0.4, z: 0 } ),
		sampleVelAt: () => 1.5,
	};
	const movingLeft = {
		sampleSlopeAt: () => ( { x: - 0.4, z: 0 } ),
		sampleVelAt: () => - 1.5,
	};
	const right = foamEnergyWaveFlow( movingRight, 0, 0 );
	const left = foamEnergyWaveFlow( movingLeft, 0, 0 );
	const capped = foamEnergyWaveFlow( movingRight, 0, 0, FOAM_ENERGY_WAVE_CARRY, 0.3 );
	// Carry has to be able to outrun the default cap or the slider is
	// decoration: the ride term used to be boosted and then scaled straight
	// back out by a cap that did not move. Ride at leftover c = 4 m/s.
	const rideBase = foamEnergyWaveFlow(
		movingRight, 0, 0, FOAM_ENERGY_WAVE_CARRY, 0.45, 4,
	);
	const rideHigh = foamEnergyWaveFlow( movingRight, 0, 0, 10, 0.45, 4 );
	const rideOver = foamEnergyWaveFlow( movingRight, 0, 0, 40, 0.45, 4 );
	const activity = foamEnergyWaveActivity( movingRight, 0, 0 );
	const crestGather = foamEnergyWaveGather( { ...movingRight, sampleAt: () => 0.3 }, 0, 0 );
	const troughGather = foamEnergyWaveGather( { ...movingRight, sampleAt: () => - 0.2 }, 0, 0 );
	need( 'wave flux carries foam in the travelling-wave direction',
		right.x > 0.4 && left.x < - 0.4 && right.z === 0 && left.z === 0,
		`right ${ right.x.toFixed( 3 ) } left ${ left.x.toFixed( 3 ) }` );
	need( 'wave-driven foam speed is capped at the stock carry',
		Math.abs( Math.hypot( capped.x, capped.z ) - 0.3 ) < 1e-9,
		`speed ${ Math.hypot( capped.x, capped.z ).toFixed( 3 ) }` );
	{

		const base = Math.hypot( rideBase.x, rideBase.z );
		const high = Math.hypot( rideHigh.x, rideHigh.z );
		const over = Math.hypot( rideOver.x, rideOver.z );
		need( 'turning carry up actually moves foam faster — the cap rises with it',
			high > base * 3,
			`stock ${ base.toFixed( 3 ) } high ${ high.toFixed( 3 ) }` );
		need( 'carry still saturates — the slider cannot teleport foam',
			Math.abs( over - high ) < 1e-9
				&& high <= 4 * FOAM_ENERGY_CARRY_MAX + 1e-9,
			`high ${ high.toFixed( 3 ) } over ${ over.toFixed( 3 ) }` );
		need( 'the carry boost is 1 at the stock carry — the default is unchanged',
			Math.abs( foamEnergyCarryBoost( FOAM_ENERGY_WAVE_CARRY ) - 1 ) < 1e-9 );

	}
	need( 'leftover waves carry foam by default, with a local drift cap and no live peel',
		defaults.wakeFoamWaveCarry === FOAM_ENERGY_WAVE_CARRY
			&& defaults.wakeFoamWaveMax <= 0.45
			&& defaults.wakeFoamDiverge === 0 );
	need( 'planing film rides leftover faces at leftover speed, same as specks',
		foamEnergyWaveRide( 40, 4.3 ) === 4.3
			&& foamEnergyWaveRide( 3, 4.3 ) === 0
			&& foamEnergyWaveRide( 4.3, 4.3 ) === 0,
		`ride ${ foamEnergyWaveRide( 40, 4.3 ) } crawl ${ foamEnergyWaveRide( 3, 4.3 ) }` );
	const rode = foamEnergyWaveFlow( movingRight, 0, 0, FOAM_ENERGY_WAVE_CARRY, 0.45, 4 );
	const speck = leftoverBubbleRide( - 0.4, 0, 1.5, 4 );
	need( 'leftover-face ride matches leftover specks and beats the 0.45 m/s flux cap',
		Math.abs( rode.x - speck.vx ) < 1e-9
			&& Math.abs( rode.z - speck.vz ) < 1e-9
			&& rode.x > 1,
		`film ${ rode.x.toFixed( 3 ) } speck ${ speck.vx.toFixed( 3 ) }` );
	need( 'wave activity combines vertical motion and surface slope',
		activity > 0.6 && foamEnergyWaveActivity( null, 0, 0 ) === 0,
		`activity ${ activity.toFixed( 3 ) }` );
	need( 'existing foam gathers on lifted active water and thins in troughs',
		crestGather > troughGather + 0.5 && foamEnergyWaveGather( null, 0, 0 ) === 1,
		`crest ${ crestGather.toFixed( 3 ) } trough ${ troughGather.toFixed( 3 ) }` );
	need( 'dense ribbon multiplies into leftover waves — troughs show water, crests stay white',
		foamEnergyCrestGate( 1.8, - 0.2 ) < 0.38
		&& foamEnergyCrestGate( 1.8, 0.25 ) > 0.70
		&& foamEnergyCrestGate( 1.8, 0.25 ) > foamEnergyCrestGate( 1.8, - 0.2 ) + 0.35,
		`crest ${ foamEnergyCrestGate( 1.8, 0.25 ).toFixed( 3 ) } trough ${ foamEnergyCrestGate( 1.8, - 0.2 ).toFixed( 3 ) }` );
	need( 'a still leftover field leaves the ribbon alone — no leftover, no multiply',
		foamEnergyCrestGate( 1.8, 0, 0 ) > 0.92,
		`still ${ foamEnergyCrestGate( 1.8, 0, 0 ).toFixed( 3 ) }` );
	need( 'leftover ripples wrinkle a mid-height ribbon instead of a flat stencil',
		foamEnergyCrestGate( 1.8, 0, 0.8 ) > foamEnergyCrestGate( 1.8, 0, 0 ) + 0.08
		|| foamEnergyCrestGate( 1.8, 0, 0.8 ) < foamEnergyCrestGate( 1.8, 0, 0 ) - 0.08,
		`rippled ${ foamEnergyCrestGate( 1.8, 0, 0.8 ).toFixed( 3 ) } still ${ foamEnergyCrestGate( 1.8, 0, 0 ).toFixed( 3 ) }` );
	need( 'a connected floor remains — a leftover trough does not erase the film',
		foamEnergyCrestGate( 1.8, - 0.2 ) > 0.12,
		`trough ${ foamEnergyCrestGate( 1.8, - 0.2 ).toFixed( 3 ) }` );
	need( 'hull-side film still reads on a leftover crest',
		foamEnergyCrestGate( 0.4, 0.2 ) > 0.55,
		`side ${ foamEnergyCrestGate( 0.4, 0.2 ).toFixed( 3 ) }` );
	need( 'sparse arm foam prefers peaks over troughs',
		foamEnergyCrestGate( 0.08, 0.25 ) > foamEnergyCrestGate( 0.08, - 0.15 ) + 0.05,
		`arm ${ foamEnergyCrestGate( 0.08, 0.25 ).toFixed( 3 ) }/` +
		`${ foamEnergyCrestGate( 0.08, - 0.15 ).toFixed( 3 ) }` );

	const divergeOut = foamEnergyDivergeFlow( 0.4, 4, {
		b: [ 0, 0 ], fwd: [ 0, - 1 ], right: [ 1, 0 ],
		beam: 3.4, openSpeed: 8, waveSpeed: 4,
		waveCarry: FOAM_ENERGY_WAVE_CARRY,
		diverge: TEST_DIVERGE,
	} );
	const divergeIn = foamEnergyDivergeFlow( 0.4, - 1, {
		b: [ 0, 0 ], fwd: [ 0, - 1 ], right: [ 1, 0 ],
		beam: 3.4, openSpeed: 8, waveSpeed: 4,
		diverge: TEST_DIVERGE,
	} );
	const defaultDiverge = foamEnergyDivergeFlow( 2, 4, {
		b: [ 0, 0 ], fwd: [ 0, - 1 ], right: [ 1, 0 ],
		beam: 3.4, openSpeed: 8, waveSpeed: 4,
	} );
	need( 'live-heading foam peel is opt-in so turns cannot steer material by default',
		Math.hypot( defaultDiverge.x, defaultDiverge.z ) === 0 );
	need( 'Kelvin diverge peels foam outward aft of the stern',
		divergeOut.x > 0.2 && Math.abs( divergeOut.z ) < 1e-9,
		`out ${ divergeOut.x.toFixed( 3 ) }` );
	need( 'Kelvin diverge does not open foam ahead of the stern',
		Math.hypot( divergeIn.x, divergeIn.z ) < 1e-9 );
	// A sign() flip reversed drift between neighbouring texels, tearing a
	// straight seam along the live heading. Straight ahead it hid inside
	// the ribbon; a turn swept it across the older trail as a drawn edge.
	{
		const peelAt = ( lat ) => foamEnergyDivergeFlow( lat, 4, {
			b: [ 0, 0 ], fwd: [ 0, - 1 ], right: [ 1, 0 ],
			beam: 3.4, openSpeed: 8, waveSpeed: 4,
			waveCarry: FOAM_ENERGY_WAVE_CARRY, diverge: TEST_DIVERGE,
		} ).x;
		const step = Math.abs( peelAt( 0.02 ) - peelAt( - 0.02 ) );
		need( 'the peel crosses the centreline smoothly — no ruled seam on the heading line',
			step < 0.35 && Math.abs( peelAt( 0 ) ) < 0.35,
			`jump ${ step.toFixed( 3 ) }  centre ${ peelAt( 0 ).toFixed( 3 ) }` );
		need( 'the peel still reverses across the beam — arms open both ways',
			peelAt( 2.5 ) > 0.2 && peelAt( - 2.5 ) < - 0.2,
			`stbd ${ peelAt( 2.5 ).toFixed( 3 )}  port ${ peelAt( - 2.5 ).toFixed( 3 )}` );
		need( 'peel side ramps rather than flips',
			foamEnergyPeelSide( 0, 3.4 ) === 0
				&& foamEnergyPeelSide( 3.4, 3.4 ) === 1
				&& foamEnergyPeelSide( - 3.4, 3.4 ) === - 1 );
	}
	// The arms belong to the frame the foam was born in. Steering old water
	// with the live wheel is what rotated a hard V edge through the trail.
	{
		const U = 20;
		const peel = ( lat, aft ) => foamEnergyDivergeFlow( lat, aft, {
			b: [ 0, 0 ], fwd: [ 0, - 1 ], right: [ 1, 0 ],
			beam: 3.4, openSpeed: U, waveSpeed: 4,
			waveCarry: FOAM_ENERGY_WAVE_CARRY, diverge: TEST_DIVERGE,
		} ).x;
		const far = foamEnergyPeelReach( U );
		const near = peel( 2.5, 2 );
		const aged = peel( 2.5, far + 4 );
		need( 'the live heading lets go of old water astern — a turn cannot rotate the whole trail',
			near > 0.2 && Math.abs( aged ) < 1e-9,
			`near ${ near.toFixed( 3 )}  aged ${ aged.toFixed( 3 )}  reach ${ far.toFixed( 1 )} m` );
		const farAbeam = peel( far * 2, 2 );
		need( 'the live heading owns a disc, not an infinite strip abeam',
			Math.abs( farAbeam ) < 1e-9,
			`far-abeam drift ${ farAbeam.toFixed( 3 ) }` );
		need( 'a faster hull owns more of its trail',
			foamEnergyPeelReach( 20 ) > foamEnergyPeelReach( 8 ) );
		// The live heading may only claim water it is still sitting in.
		// Three seconds of it owned sixty metres of trail, so the wheel
		// dragged the whole wake round with it.
		need( 'the peel is a near-field effect, not the length of the trail',
			far < 12, `reach ${ far.toFixed( 1 ) } m at ${ U } m/s` );
		// THE hard edge. Gating the peel on the arm locus
		// |lat| = beam*0.42 + aft*tanθ put a ridge in the advection
		// velocity along that ray; advection sharpens a ridge into a
		// drawn line, and the ray is straight in the live frame, so a
		// turn swept a painted V across the older curved trail.
		// Sampled clear of the centreline ramp (half a beam), so the only
		// thing that could vary across these three is the locus itself.
		const aft = 8;
		const tan = foamEnergyOpenTan( U, 4 );
		const arm = 3.4 * 0.42 + aft * tan;
		const inside = peel( arm - 0.05, aft );
		const onLocus = peel( arm, aft );
		const outside = peel( arm + 0.05, aft );
		const spread = Math.max( inside, onLocus, outside ) - Math.min( inside, onLocus, outside );
		need( 'the peel has no ridge at the Kelvin arm locus — nothing draws a V',
			inside > 0.2 && spread < 0.08,
			`in ${ inside.toFixed( 3 ) }  locus ${ onLocus.toFixed( 3 ) }` +
			`  out ${ outside.toFixed( 3 ) }  spread ${ spread.toExponential( 1 ) }` );
	}
	// The wave-spread gather leans along the heading and flips across it,
	// so it needs the same leash as the peel. It had none: `aft > 0.2` and
	// `aft > 0.5` are straight lines through the hull, square to the
	// heading and as long as the tile.
	{
		const reach = foamEnergyPeelReach( 20 );
		need( 'the hull frame fades in behind the beam — no step square to the heading',
			foamEnergyHullOwn( 0, 0, reach ) === 0
				&& foamEnergyHullOwn( 0, 0.2, reach ) < 0.1,
			`at 0 ${ foamEnergyHullOwn( 0, 0, reach ).toFixed( 3 ) }` +
			`  at 0.2 m ${ foamEnergyHullOwn( 0, 0.2, reach ).toFixed( 3 ) }` );
		need( 'the hull frame lets go of old water astern',
			foamEnergyHullOwn( 0, 3, reach ) > 0.9
				&& foamEnergyHullOwn( 0, reach + 1, reach ) === 0,
			`near ${ foamEnergyHullOwn( 0, 3, reach ).toFixed( 3 ) }` +
			`  aged ${ foamEnergyHullOwn( 0, reach + 1, reach ).toFixed( 3 ) }` );
		// The half that was missed first time round. Bounding `aft` alone
		// leaves the gate as long as the tile: water far abeam and a couple
		// of metres astern still answered to the wheel, so the swept line
		// only got narrower.
		need( 'the hull frame lets go of water abeam — the wedge is a disc, not a line',
			foamEnergyHullOwn( reach + 1, 2, reach ) === 0
				&& foamEnergyHullOwn( 120, 2, reach ) === 0,
			`abeam ${ foamEnergyHullOwn( reach + 1, 2, reach ).toFixed( 3 ) }` +
			`  far abeam ${ foamEnergyHullOwn( 120, 2, reach ).toFixed( 3 ) }` );
		// A hard gate steps a full 1.0 between neighbours; the ramps here
		// are 1.2 m in and 0.45*reach out, so an order of magnitude under.
		let jump = 0;
		for ( let lat = - reach - 4; lat < reach + 4; lat += 0.05 ) {

			for ( let aft = 0; aft < reach + 4; aft += 0.05 ) {

				jump = Math.max( jump, Math.abs(
					foamEnergyHullOwn( lat, aft + 0.05, reach )
						- foamEnergyHullOwn( lat, aft, reach ),
				), Math.abs(
					foamEnergyHullOwn( lat + 0.05, aft, reach )
						- foamEnergyHullOwn( lat, aft, reach ),
				) );

			}

		}
		need( 'hull ownership is continuous — nothing to draw a line along',
			jump < 0.1, `worst step ${ jump.toFixed( 4 ) } per 5 cm` );
	}
	// The user-visible bug: turning swept that line over the old trail and
	// every cell it crossed shed foam, so a bank of white appeared far
	// astern along a rotating edge, in water the hull never churned.
	{
		const turn = new FoamEnergyField( { size: 64, extent: 64 } );
		turn.origin = [ 0, 0 ];
		const lit = () => turn.data.reduce( ( n, v ) => n + ( v > 0.02 ? 1 : 0 ), 0 );
		for ( let j = 0; j < turn.size; j ++ ) {

			for ( let i = 0; i < turn.size; i ++ ) {

				const [ x, z ] = turn.worldOf( i, j );
				turn.data[ j * turn.size + i ] = Math.hypot( x - 12, z - 12 ) < 4 ? 1 : 0;

			}

		}
		const before = lit();
		const beforeData = turn.data.slice();
		let worst = before;
		let worstChange = 0;
		// Hull parked at the origin, no stir, wheel swept right round. The
		// patch is ~17 m off — well past the reach — so nothing the heading
		// does may touch it.
		for ( let k = 0; k < 64; k ++ ) {

			const a = k / 64 * Math.PI * 2;
			turn.step( 1 / 60, {
				a: [ 0, 0 ], b: [ 0, 0 ], fwd: [ Math.sin( a ), - Math.cos( a ) ],
				stir: 0, decay: 1e6, beam: 3.4, openSpeed: 12, waveSpeed: 4,
				// Carry and peel both stay on: neither may hand the live wheel
				// an old patch outside its radial neighbourhood.
				waveCarry: FOAM_ENERGY_WAVE_CARRY, waveMax: 1.1, waveSpread: 2.2,
				diverge: TEST_DIVERGE,
			} );
			worst = Math.max( worst, lit() );
			let change = 0;
			for ( let i = 0; i < turn.data.length; i ++ ) {

				change += Math.abs( turn.data[ i ] - beforeData[ i ] );

			}
			worstChange = Math.max( worstChange, change );

		}
		need( 'a turn neither paints nor moves old foam outside the hull neighbourhood',
			worst <= before && worstChange < 0.01,
			`lit ${ before } -> ${ worst } cells  field Δ ${ worstChange.toExponential( 2 ) }` );
	}
	const warpA = foamEnergyArmWarp( 0, 8, 8 );
	const warpB = foamEnergyArmWarp( 4.2, 8, 8 );
	need( 'divergent-arm radius wobbles in world XZ — not a ruled half-angle',
		Math.abs( warpA - warpB ) > 0.04
			&& warpA > 1 - FOAM_ENERGY_ARM_JITTER - 0.01
			&& warpA < 1 + FOAM_ENERGY_ARM_JITTER + 0.01,
		`a ${ warpA.toFixed( 3 ) } b ${ warpB.toFixed( 3 ) }` );
	need( 'above wave speed foam opens at the Mach half-angle',
		foamEnergyOpenTan( 20, 4 ) < KELVIN_TAN * 0.85
			&& foamEnergyOpenTan( 3, 4 ) === KELVIN_TAN,
		`mach ${ foamEnergyOpenTan( 20, 4 ).toFixed( 3 ) } kelvin ${ KELVIN_TAN.toFixed( 3 ) }` );

	const opened = new FoamEnergyField( { size: 64, extent: 24 } );
	opened.origin = [ 0, 0 ];
	for ( let j = 0; j < opened.size; j ++ ) {

		for ( let i = 0; i < opened.size; i ++ ) {

			const [ x, z ] = opened.worldOf( i, j );
			// Centreline ribbon behind a bow-heading (0, −1) stern at origin.
			opened.data[ j * opened.size + i ] = z > 0.3 && Math.abs( x ) < 0.35
				? Math.exp( - x * x / 0.08 )
				: 0;

		}

	}
	const massAt = ( x0, x1 ) => {

		let s = 0;
		for ( let j = 0; j < opened.size; j ++ ) {

			for ( let i = 0; i < opened.size; i ++ ) {

				const [ x ] = opened.worldOf( i, j );
				if ( x >= x0 && x < x1 ) s += opened.data[ j * opened.size + i ];

			}

		}
		return s;

	};
	const beforeArm = massAt( 1.2, 4.0 );
	for ( let n = 0; n < 18; n ++ ) {

		opened.step( 0.08, {
			stir: 0, decay: 1000,
			b: [ 0, 0 ], fwd: [ 0, - 1 ],
			beam: 3.4, openSpeed: 10, waveSpeed: 12,
			waveCarry: FOAM_ENERGY_WAVE_CARRY, waveMax: 1.4, waveSpread: 2.2,
			diverge: TEST_DIVERGE,
		} );

	}
	const afterArm = massAt( 1.2, 4.0 );
	need( 'a centreline ribbon opens onto the divergent arms',
		afterArm > beforeArm + 0.05,
		`arm mass ${ beforeArm.toFixed( 3 ) } -> ${ afterArm.toFixed( 3 ) }` );

	const leftoverOut = {
		sampleSlopeAt: () => ( { x: - 0.2, z: 0 } ),
		sampleVelAt: () => 0.4,
		speed: 4.3,
	};
	const fillRibbon = ( field ) => {

		for ( let j = 0; j < field.size; j ++ ) {

			for ( let i = 0; i < field.size; i ++ ) {

				const [ x, z ] = field.worldOf( i, j );
				field.data[ j * field.size + i ] = z > 0.3 && Math.abs( x ) < 0.35
					? Math.exp( - x * x / 0.08 )
					: 0;

			}

		}

	};
	const bandMass = ( field, x0, x1 ) => {

		let s = 0;
		for ( let j = 0; j < field.size; j ++ ) {

			for ( let i = 0; i < field.size; i ++ ) {

				const [ x ] = field.worldOf( i, j );
				if ( x >= x0 && x < x1 ) s += field.data[ j * field.size + i ];

			}

		}
		return s;

	};
	const planingFilm = new FoamEnergyField( { size: 64, extent: 24 } );
	planingFilm.origin = [ 0, 0 ];
	fillRibbon( planingFilm );
	const beforeRide = bandMass( planingFilm, 1.2, 4.0 );
	for ( let n = 0; n < 12; n ++ ) {

		planingFilm.step( 0.08, {
			stir: 0, decay: 1000,
			b: [ 0, 0 ], fwd: [ 0, - 1 ],
			beam: 3.4, openSpeed: 40, waveSpeed: 4.3,
			ripples: leftoverOut,
			waveCarry: FOAM_ENERGY_WAVE_CARRY, waveMax: 0.45, waveSpread: 0,
			diverge: 0,
		} );

	}
	const afterRide = bandMass( planingFilm, 1.2, 4.0 );
	need( 'above leftover speed the film rides leftover faces onto the arms — no live peel',
		afterRide > beforeRide + 0.05,
		`arm mass ${ beforeRide.toFixed( 3 ) } -> ${ afterRide.toFixed( 3 ) }` );
	const crawlFilm = new FoamEnergyField( { size: 64, extent: 24 } );
	crawlFilm.origin = [ 0, 0 ];
	fillRibbon( crawlFilm );
	for ( let n = 0; n < 12; n ++ ) {

		crawlFilm.step( 0.08, {
			stir: 0, decay: 1000,
			b: [ 0, 0 ], fwd: [ 0, - 1 ],
			beam: 3.4, openSpeed: 3, waveSpeed: 4.3,
			ripples: leftoverOut,
			waveCarry: FOAM_ENERGY_WAVE_CARRY, waveMax: 0.45, waveSpread: 0,
			diverge: 0,
		} );

	}
	need( 'below leftover speed the film stays on the sailed path',
		bandMass( crawlFilm, 1.2, 4.0 ) < 0.15
			&& afterRide > bandMass( crawlFilm, 1.2, 4.0 ) * 20,
		`crawl arm ${ bandMass( crawlFilm, 1.2, 4.0 ).toFixed( 3 ) }` +
		`  planing ${ afterRide.toFixed( 3 ) }` );
	const leftoverAft = {
		sampleSlopeAt: () => ( { x: 0, z: - 0.2 } ),
		sampleVelAt: () => 0.4,
		speed: 4.3,
	};
	const aftFilm = new FoamEnergyField( { size: 64, extent: 24 } );
	aftFilm.origin = [ 0, 0 ];
	fillRibbon( aftFilm );
	for ( let n = 0; n < 12; n ++ ) {

		aftFilm.step( 0.08, {
			stir: 0, decay: 1000,
			b: [ 0, 0 ], fwd: [ 0, - 1 ],
			beam: 3.4, openSpeed: 40, waveSpeed: 4.3,
			ripples: leftoverAft,
			waveCarry: FOAM_ENERGY_WAVE_CARRY, waveMax: 0.45, waveSpread: 0,
			diverge: 0,
		} );

	}
	need( 'leftover ride follows leftover faces, not the live beam',
		bandMass( aftFilm, 1.2, 4.0 ) < 0.15,
		`abeam ${ bandMass( aftFilm, 1.2, 4.0 ).toFixed( 3 ) }` );

	const carried = new FoamEnergyField( { size: 64, extent: 16 } );
	carried.origin = [ 0, 0 ];
	for ( let j = 0; j < carried.size; j ++ ) {

		for ( let i = 0; i < carried.size; i ++ ) {

			const [ x, z ] = carried.worldOf( i, j );
			carried.data[ j * carried.size + i ] = Math.exp( - ( x * x + z * z ) / 0.7 );

		}

	}
	const centroidX = () => {

		let sx = 0, sum = 0;
		for ( let j = 0; j < carried.size; j ++ ) {

			for ( let i = 0; i < carried.size; i ++ ) {

				const e = carried.data[ j * carried.size + i ];
				sx += carried.worldOf( i, j )[ 0 ] * e;
				sum += e;

			}

		}
		return sx / Math.max( sum, 1e-9 );

	};
	const varianceX = ( mean ) => {

		let ss = 0, sum = 0;
		for ( let j = 0; j < carried.size; j ++ ) {

			for ( let i = 0; i < carried.size; i ++ ) {

				const e = carried.data[ j * carried.size + i ];
				const dx = carried.worldOf( i, j )[ 0 ] - mean;
				ss += dx * dx * e;
				sum += e;

			}

		}
		return ss / Math.max( sum, 1e-9 );

	};
	const before = centroidX();
	const beforeVar = varianceX( before );
	carried.step( 0.1, {
		stir: 0, decay: 1000, ripples: movingRight, waveCarry: 1, waveMax: 1,
	} );
	const after = centroidX();
	const afterVar = varianceX( after );
	need( 'the persistent foam field backtraces through wave transport',
		after > before + 0.05,
		`centroid ${ before.toFixed( 3 ) } -> ${ after.toFixed( 3 ) }` );
	need( 'active waves broaden existing foam without crest injection',
		afterVar > beforeVar + 1e-4,
		`variance ${ beforeVar.toFixed( 4 ) } -> ${ afterVar.toFixed( 4 ) }` );
	need( 'one wave step cannot copy foam metres away into clear water',
		carried.sample( 2.4, 0 ) < 0.005,
		`shoulder ${ carried.sample( 2.4, 0 ).toFixed( 4 ) }` );
	const rodeOnce = new FoamEnergyField( { size: 64, extent: 16 } );
	rodeOnce.origin = [ 0, 0 ];
	for ( let j = 0; j < rodeOnce.size; j ++ ) {

		for ( let i = 0; i < rodeOnce.size; i ++ ) {

			const [ x, z ] = rodeOnce.worldOf( i, j );
			rodeOnce.data[ j * rodeOnce.size + i ] = Math.exp( - ( x * x + z * z ) / 0.7 );

		}

	}
	rodeOnce.step( 0.1, {
		stir: 0, decay: 1000, ripples: leftoverOut,
		waveCarry: FOAM_ENERGY_WAVE_CARRY, waveMax: 0.45, waveSpread: 0,
		openSpeed: 40, waveSpeed: 4.3, diverge: 0,
	} );
	need( 'leftover ride still cannot copy foam metres away in one step',
		rodeOnce.sample( 3.0, 0 ) < 0.005,
		`shoulder ${ rodeOnce.sample( 3.0, 0 ).toFixed( 4 ) }` );
	const empty = new FoamEnergyField( { size: 64, extent: 16 } );
	empty.step( 0.1, {
		stir: 0, decay: 1000, ripples: movingRight, waveCarry: 1, waveMax: 1,
	} );
	need( 'wave activity alone still cannot create foam',
		empty.sample( 2.4, 0 ) === 0 );

	const local = new FoamEnergyField( { size: 64, extent: 16 } );
	for ( let j = 0; j < local.size; j ++ ) {

		for ( let i = 0; i < local.size; i ++ ) {

			const [ x, z ] = local.worldOf( i, j );
			local.data[ j * local.size + i ] = Math.exp( - ( x * x + z * z ) / 0.7 );

		}

	}
	const peak0 = local.sample( 0, 0 );
	local.step( 0.1, {
		stir: 0, decay: 1000, ripples: movingRight, waveCarry: 0, waveSpread: 5,
	} );
	need( 'wave faces still exchange foam when extra flux carry is off',
		local.sample( 0, 0 ) < peak0 - 1e-4 && local.sample( 0.5, 0 ) > 0.02,
		`peak ${ peak0.toFixed( 4 ) } -> ${ local.sample( 0, 0 ).toFixed( 4 ) }` );

	// Regression for the storm screenshot: the former fourteen-texel gather
	// plus max(shed) leapfrogged a compact patch across most of the 320 m tile.
	const storm = new FoamEnergyField( { size: 128, extent: 64 } );
	const stormWave = {
		sampleSlopeAt: () => ( { x: 0.6, z: 0.45 } ),
		sampleVelAt: () => 0,
	};
	for ( let j = 0; j < storm.size; j ++ ) {

		for ( let i = 0; i < storm.size; i ++ ) {

			const [ x, z ] = storm.worldOf( i, j );
			storm.data[ j * storm.size + i ] = Math.hypot( x, z ) < 1 ? 1 : 0;

		}

	}
	const stormMass = () => storm.data.reduce( ( sum, e ) => sum + e, 0 );
	const stormRadius = () => {

		let radius = 0;
		for ( let j = 0; j < storm.size; j ++ ) {

			for ( let i = 0; i < storm.size; i ++ ) {

				if ( storm.data[ j * storm.size + i ] < 0.01 ) continue;
				const [ x, z ] = storm.worldOf( i, j );
				radius = Math.max( radius, Math.hypot( x, z ) );

			}

		}
		return radius;

	};
	const mass0 = stormMass();
	for ( let n = 0; n < 120; n ++ ) {

		storm.step( 1 / 60, {
			stir: 0, decay: 1e6, ripples: stormWave,
			waveCarry: 3, waveMax: 0.45, waveSpread: 5, diverge: 0,
		} );

	}
	const mass1 = stormMass();
	const radius1 = stormRadius();
	need( 'full storm spread remains local and cannot manufacture a white sheet',
		mass1 <= mass0 * 1.02 && radius1 < 4,
		`mass ${ mass0.toFixed( 2 ) } -> ${ mass1.toFixed( 2 ) }, radius ${ radius1.toFixed( 2 ) } m` );
}

{
	need( 'parked hull injects no foam energy',
		foamEnergyHullInject( 0, - 2, 0, 1.2 ) === 0 );
	const mid = foamEnergyHullInject( 0, - 0.3, 0.6, 1.4 );
	const side = foamEnergyHullInject( 1.4 * RIBBON_SIDE, - 0.3, 0.6, 1.4 );
	const port = foamEnergyHullInject( - 1.4 * RIBBON_SIDE, - 0.3, 0.6, 1.4 );
	const star = foamEnergyHullInject( 1.4 * RIBBON_SIDE, - 0.3, 0.6, 1.4 );
	const ahead = foamEnergyHullInject( 0, 0.5, 0.6, 1.4 );
	need( 'hull whitewater is one flat-topped band, not two bright chine rails',
		mid > 0.2 && side > mid * 0.75 && side <= mid,
		`side ${ side.toFixed( 3 ) } mid ${ mid.toFixed( 3 ) }` );
	need( 'port and starboard of equal offset deposit the same energy',
		Math.abs( port - star ) < 1e-9,
		`port ${ port.toFixed( 4 ) } star ${ star.toFixed( 4 ) }` );
	need( 'the across profile peaks on the sailing line, not two shoulders',
		foamEnergyAcross( 0, 1.4 ) > foamEnergyAcross( 1.4 * RIBBON_SIDE, 1.4 ) );
	{
		const centre = foamEnergyAcross( 0, 1.4 );
		let low = Infinity;
		let high = - Infinity;
		for ( let lat = - 1.4 * RIBBON_SIDE; lat <= 1.4 * RIBBON_SIDE; lat += 0.01 ) {

			const e = foamEnergyAcross( lat, 1.4 );
			low = Math.min( low, e );
			high = Math.max( high, e );

		}
		need( 'the bow band stays level across the cutwater and inner shoulders',
			centre > 0.9 && low > high * 0.75,
			`centre ${ centre.toFixed( 3 ) }  low/high ${ low.toFixed( 3 ) }/${ high.toFixed( 3 ) }` );
	}
	need( 'foam deposit stays inside the beam footprint, not on Kelvin arms',
		foamEnergyAcross( 1.4 * 0.55, 1.4 ) > 0.05
			&& foamEnergyAcross( 1.4 * 1.05, 1.4 ) < 0.02,
		`inside ${ foamEnergyAcross( 1.4 * 0.55, 1.4 ).toFixed( 3 ) } outside ${ foamEnergyAcross( 1.4 * 1.05, 1.4 ).toFixed( 3 ) }` );
	need( 'a motor jet is a narrow centreline stronger than bow foam on the sailing line',
		foamEnergyMotorInject( 0, - 0.8, 1, 1.4, 1.2 )
			> foamEnergyHullInject( 0, - 0.8, 1, 1.4, 1 ) * 0.9
			&& foamEnergyMotorInject( 0.9, - 0.8, 1, 1.4, 1.2 )
				< foamEnergyMotorInject( 0, - 0.8, 1, 1.4, 1.2 ) * 0.2,
		`motor ${ foamEnergyMotorInject( 0, - 0.8, 1, 1.4, 1.2 ).toFixed( 3 ) }` );
	need( 'motor wash is stern-local — ahead of the transom is quiet',
		foamEnergyMotorInject( 0, - 0.5, 1, 1.4, 1.2 )
			> foamEnergyMotorInject( 0, 2.5, 1, 1.4, 1.2 ) * 4,
		`stern ${ foamEnergyMotorInject( 0, - 0.5, 1, 1.4, 1.2 ).toFixed( 3 ) } ahead ${ foamEnergyMotorInject( 0, 2.5, 1, 1.4, 1.2 ).toFixed( 3 ) }` );
	need( 'motor wash is a short transom brush, not an infinite strip astern',
		foamEnergyMotorInject( 0, - 8, 1, 1.4, 1.2 ) === 0,
		`8 m aft ${ foamEnergyMotorInject( 0, - 8, 1, 1.4, 1.2 ).toFixed( 4 ) }` );
	need( 'motor 0 writes nothing',
		foamEnergyMotorInject( 0, - 0.8, 1, 1.4, 0 ) === 0 );
	need( 'a wider jet is still stern-local and dies with reach',
		foamEnergyMotorInject( 0.35, - 0.8, 1, 1.4, 1, 0.4 )
			> foamEnergyMotorInject( 0.35, - 0.8, 1, 1.4, 1, 0.12 )
			&& foamEnergyMotorInject( 0, - 5, 1, 1.4, 1, 0.16, 8 ) > 0
			&& foamEnergyMotorInject( 0, - 5, 1, 1.4, 1, 0.16, 4 ) === 0,
		`wide ${ foamEnergyMotorInject( 0.35, - 0.8, 1, 1.4, 1, 0.4 ).toFixed( 3 ) } far ${ foamEnergyMotorInject( 0, - 5, 1, 1.4, 1, 0.16, 8 ).toFixed( 3 ) }` );
	need( 'a displacement planform is pointed at the bow and full amidships',
		foamEnergyPlanformK( 0 ) < 0.18
			&& foamEnergyPlanformK( 0.45 ) > 0.95
			&& foamEnergyPlanformHalf( 0, 12, 3.4 )
				< foamEnergyPlanformHalf( - 6, 12, 3.4 ) * 0.25,
		`bow ${ foamEnergyPlanformHalf( 0, 12, 3.4 ).toFixed( 3 ) } mid ${ foamEnergyPlanformHalf( - 6, 12, 3.4 ).toFixed( 3 ) }` );
	need( 'without a LOA the across profile stays the old rectangle',
		Math.abs( foamEnergyAcross( 0, 1.4 ) - foamEnergyAcross( 0, 1.4, 0, 0 ) ) < 1e-9
			&& foamEnergyPlanformHalf( 0, 0, 1.4 ) > foamEnergyPlanformHalf( 0, 12, 1.4 ) );
	{
		const n = 8;
		const half = new Float32Array( n );
		for ( let i = 0; i < n; i ++ ) {

			half[ i ] = 0.16 + 1.35 * foamEnergyPlanformK( i / ( n - 1 ) );

		}
		const stations = {
			minZ: - 6, maxZ: 6, half,
			top: new Float32Array( n ).fill( 1 ),
			low: new Float32Array( n ).fill( - 1 ),
		};
		const samples = foamEnergyPlanformSamples(
			{ sprayStations: stations, pos: [ 0, 0, 0 ], surf: 0, pitch: 0 },
			3.4, 12,
		);
		need( 'a mesh planform is narrower at the bow than amidships',
			samples[ 0 ] < samples[ 8 ] * 0.45
				&& samples[ 0 ] < 0.55,
			`bow ${ samples[ 0 ].toFixed( 3 ) } mid ${ samples[ 8 ].toFixed( 3 ) }` );
	}
	need( 'nothing is projected even half a metre ahead of the cutwater',
		ahead < 0.02,
		`ahead ${ ahead.toFixed( 3 ) }` );
	need( 'a point past the sweep ends is not on the stroke',
		foamEnergySweep( - 8 / 0.35, 0.35 ) < 0.02
			&& foamEnergySweep( 0.5, 0.35 ) === 1,
		`aft ${ foamEnergySweep( - 8 / 0.35, 0.35 ).toFixed( 4 ) }` );
	const L = 12;
	const transomAlong = - L * 0.96;
	need( 'the live hull keeps the transom foamed without a motor jet',
		foamEnergyLiveHull( transomAlong, L ) > 0.95
			&& foamEnergyLiveHull( - 0.4, L ) > 0.95,
		`transom ${ foamEnergyLiveHull( transomAlong, L ).toFixed( 3 ) }` );
	need( 'along-hull film is bright at the cutwater and transom, quieter amidships',
		foamEnergyAlong( - 0.4, L ) > 0.9
			&& foamEnergyAlong( transomAlong, L ) > 0.9
			&& foamEnergyAlong( - L * 0.5, L ) < 0.08
			&& foamEnergyAlong( - L * 0.5, L ) >= FOAM_ENERGY_ALONG_FLOOR
			&& foamEnergyAlong( - 4, 0 ) === 1,
		`bow ${ foamEnergyAlong( - 0.4, L ).toFixed( 3 ) }` +
		`  mid ${ foamEnergyAlong( - L * 0.5, L ).toFixed( 3 ) }` +
		`  stern ${ foamEnergyAlong( transomAlong, L ).toFixed( 3 ) }` );
	need( 'hull inject follows that gap — mid-body is not a second bow',
		foamEnergyHullInject( 0, - 0.4, 1, 3.4, 1, L )
			> foamEnergyHullInject( 0, - L * 0.5, 1, 3.4, 1, L ) * 2.8,
		`bow ${ foamEnergyHullInject( 0, - 0.4, 1, 3.4, 1, L ).toFixed( 3 ) }` +
		`  mid ${ foamEnergyHullInject( 0, - L * 0.5, 1, 3.4, 1, L ).toFixed( 3 ) }` );
	need( 'bow across stays a slab — the channel is the transom wake',
		foamEnergyWakeOpen( - 0.4, L ) < 0.05
			&& foamEnergyAcross( 0, 3.4, - 0.4, L )
				> foamEnergyAcross( 3.4 * 0.35, 3.4, - 0.4, L ) * 0.75 );
	{
		const half = foamEnergyPlanformHalf( transomAlong, L, 3.4 );
		const centre = foamEnergyAcross( 0, 3.4, transomAlong, L );
		const rail = foamEnergyAcross( half * 0.42, 3.4, transomAlong, L );
		need( 'transom across is two rails with sea on the sailing line',
			foamEnergyWakeOpen( transomAlong, L ) > 0.85
				&& centre < 0.05
				&& rail > 0.35,
			`centre ${ centre.toFixed( 3 ) } rail ${ rail.toFixed( 3 ) }` );
	}
	need( 'path-only stamps do not grow a wake channel',
		foamEnergyWakeOpen( - 8, 0 ) === 0
			&& foamEnergyLane( 0, 1, 0 ) > 0.9
			&& foamEnergyLane( 0, 1, 1 ) < FOAM_ENERGY_WAKE_CHANNEL + 0.02 );
	need( 'the live hull does not project ahead of the cutwater or far astern',
		foamEnergyLiveHull( 0.5, L ) < 0.02
			&& foamEnergyLiveHull( transomAlong - 8, L ) < 0.02,
		`ahead ${ foamEnergyLiveHull( 0.5, L ).toFixed( 3 ) } wash ${ foamEnergyLiveHull( transomAlong - 8, L ).toFixed( 3 ) }` );
	need( 'path-only stamps stay sweep-gated — live hull needs a real LOA',
		foamEnergyLiveHull( - 4, 0 ) === 0
			&& foamEnergyLiveHull( - 4, 0.4 ) === 0 );
	{
		const field = new FoamEnergyField( { size: 96, extent: 40 } );
		field.origin = [ 0, 0 ];
		const fwd = [ 0, - 1 ];
		const b = [ 0, - 0.4 ];
		field.step( 1 / 60, {
			a: [ 0, 0 ], b, fwd, stir: 1, beam: 3.4, gain: 1, hullLen: L, motor: 0,
		} );
		const stern = [
			b[ 0 ] - fwd[ 0 ] * L * 0.96,
			b[ 1 ] - fwd[ 1 ] * L * 0.96,
		];
		const past = [
			b[ 0 ] - fwd[ 0 ] * ( L * 0.96 + 8 ),
			b[ 1 ] - fwd[ 1 ] * ( L * 0.96 + 8 ),
		];
		const transomHalf = foamEnergyPlanformHalf( transomAlong, L, 3.4 );
		const rail = [
			stern[ 0 ] + transomHalf * 0.42,
			stern[ 1 ],
		];
		need( 'a yawing hull still writes foam on the live transom at motor 0',
			field.sample( rail[ 0 ], rail[ 1 ] ) > 0.05,
			`transom rail ${ field.sample( rail[ 0 ], rail[ 1 ] ).toFixed( 3 ) }` );
		need( 'the live transom leaves a dark channel on the sailing line',
			field.sample( rail[ 0 ], rail[ 1 ] )
				> field.sample( stern[ 0 ], stern[ 1 ] ) + 0.04
				&& field.sample( stern[ 0 ], stern[ 1 ] ) < 0.04,
			`rail ${ field.sample( rail[ 0 ], rail[ 1 ] ).toFixed( 3 ) }` +
			`  centre ${ field.sample( stern[ 0 ], stern[ 1 ] ).toFixed( 3 ) }` );
		{
			const seeded = new FoamEnergyField( { size: 96, extent: 40 } );
			seeded.origin = [ 0, 0 ];
			seeded.data.fill( 1 );
			seeded.step( 0.1, {
				a: [ 0, 0 ], b, fwd, stir: 1, beam: 3.4, gain: 1, hullLen: L,
				motor: 0, decay: 4.8,
			} );
			need( 'persist carve eats the sailing-line slab, not the rails',
				seeded.sample( stern[ 0 ], stern[ 1 ] ) < 0.22
					&& seeded.sample( rail[ 0 ], rail[ 1 ] ) > 0.70,
				`centre ${ seeded.sample( stern[ 0 ], stern[ 1 ] ).toFixed( 3 ) }` +
				`  rail ${ seeded.sample( rail[ 0 ], rail[ 1 ] ).toFixed( 3 ) }` );
		}
		need( 'straight inject is symmetric across the sailing line',
			Math.abs(
				foamEnergyHullInject( 1.1, transomAlong, 1, 3.4, 1, L, null, 0 )
				- foamEnergyHullInject( - 1.1, transomAlong, 1, 3.4, 1, L, null, 0 ),
			) < 1e-9 );
		need( 'a right turn prefers the port (outer) rail',
			foamEnergyHullInject( - 1.1, transomAlong, 1, 3.4, 1, L, null, 0.6 )
				> foamEnergyHullInject( 1.1, transomAlong, 1, 3.4, 1, L, null, 0.6 ) * 1.8,
			`port ${ foamEnergyHullInject( - 1.1, transomAlong, 1, 3.4, 1, L, null, 0.6 ).toFixed( 3 ) }` +
			`  stbd ${ foamEnergyHullInject( 1.1, transomAlong, 1, 3.4, 1, L, null, 0.6 ).toFixed( 3 ) }` );
		need( 'a left turn prefers the starboard (outer) rail',
			foamEnergyHullInject( 1.1, transomAlong, 1, 3.4, 1, L, null, - 0.6 )
				> foamEnergyHullInject( - 1.1, transomAlong, 1, 3.4, 1, L, null, - 0.6 ) * 1.8 );
		{
			// The hull is still cutting water on the inside of a turn. A
			// lean is a lean; masking that rail out left a one-sided wake.
			const straight = foamEnergyHullInject( 1.1, transomAlong, 1, 3.4, 1, L, null, 0 );
			const inner = foamEnergyHullInject( 1.1, transomAlong, 1, 3.4, 1, L, null, 0.9 );
			need( 'the inner rail survives a hard turn — it leans, it does not vanish',
				inner > straight * 0.5 && inner > 0.15,
				`inner ${ inner.toFixed( 3 ) } straight ${ straight.toFixed( 3 ) }` );
		}
		need( 'the sailing-line carve does not lean with the turn — that erased a rail',
			foamEnergyWakeCarve( 1.1, transomAlong, L, 3.4 )
				=== foamEnergyWakeCarve( - 1.1, transomAlong, L, 3.4 ) );
		{
			// Carve is decay over a WORLD-anchored field addressed in LIVE
			// hull axes. Anything it reaches, it reaches as a stencil that
			// rotates with the wheel. An unbounded tail astern is therefore
			// a clock hand that wipes the old curved trail on every turn.
			const sternA = - L * 0.96;
			const far = FOAM_ENERGY_WAKE_CARVE_AFT + 1.5;
			need( 'the carve dies within CARVE_AFT of the transom — it is not a heading ray',
				foamEnergyWakeCarve( 0, sternA - far, L, 3.4 ) < 0.001
					&& foamEnergyWakeCarve( 0, sternA - 40, L, 3.4 ) < 0.001
					&& foamEnergyWakeCarve( 0, sternA - 300, L, 3.4 ) < 0.001,
				`at ${ far.toFixed( 1 ) } m ${ foamEnergyWakeCarve( 0, sternA - far, L, 3.4 ).toFixed( 4 ) }` );
			need( 'the carve still opens the channel just astern of the transom',
				foamEnergyWakeCarve( 0, sternA - 0.6, L, 3.4 ) > 0.85 );
			need( 'the TSL carve window is bounded by CARVE_AFT, not wakeOpen',
				TSL_ENERGY.includes( 'carveWin' )
					&& ! /carve\s*=\s*wakeOpen/.test( TSL_ENERGY ) );
		}
		need( 'turn bias is identity when the wheel is straight',
			foamEnergyTurnBias( 1.2, 0, 3.4 ) === 1
				&& foamEnergyWakeCarve( 0, transomAlong, L, 3.4 ) > 0.85
				&& foamEnergyWakeCarve( foamEnergyPlanformHalf( transomAlong, L, 3.4 ) * 0.7, transomAlong, L, 3.4 ) < 0.08
				&& foamEnergyCarvePersist( 4.8, 1 ) < 1 / FOAM_ENERGY_WAKE_CARVE
				&& Math.abs( foamEnergyCarvePersist( 4.8, 0 ) - 4.8 ) < 1e-9 );
		need( 'the sailing-line channel stays on the heading, even in a turn',
			foamEnergyHullInject( 0, transomAlong, 1, 3.4, 1, L, null, 0.6 ) < 0.05 );
		need( 'thin sailing-line energy stays sea — only dense rails read white',
			wakeFoamEnergyLook( 0.15 ) < 0.05
				&& wakeFoamEnergyLook( 0.28 ) < 0.12
				&& wakeFoamEnergyLook( 1.0 ) > 0.90 );
		need( 'that live stamp is the hull, not an infinite heading strip',
			field.sample( past[ 0 ], past[ 1 ] ) < 0.02,
			`8 m aft ${ field.sample( past[ 0 ], past[ 1 ] ).toFixed( 4 ) }` );
	}
}

{
	const left = foamEnergyDecay( 1, FOAM_ENERGY_DECAY );
	need( 'one e-folding time leaves 1/e of the film',
		Math.abs( left - Math.exp( - 1 ) ) < 1e-9,
		`left ${ left.toFixed( 4 ) }` );
	need( 'step accumulates then clamps',
		foamEnergyStep( 1.2, 0.05, 0.8 ) <= FOAM_ENERGY_MAX
			&& foamEnergyStep( 0, 0.05, 0.4 ) > 0.01 );
	need( 'a body persist wins over the sea decay',
		wakeFoamDecayOf( { persist: 3 }, { wakeFoamDecay: 1.4 } ) === 3
			&& wakeFoamDecayOf( { persist: 0 }, { wakeFoamDecay: 2 } ) === 2,
		`${ wakeFoamDecayOf( { persist: 3 }, { wakeFoamDecay: 1.4 } ) }` );
	need( 'a shared field uses the longest persist among stamps',
		wakeFoamDecayOf( {
			stamps: [ { persist: 0.5 }, { persist: 3 } ],
		}, { wakeFoamDecay: 1.4 } ) === 3 );
	need( 'stamps without persist fall back to the sea decay',
		wakeFoamDecayOf( { stamps: [ { persist: 0 } ] }, { wakeFoamDecay: 1.4 } ) === 1.4 );
}

{
	const ring = {
		x: 0, z: 0, radius: 6, amp: 1, age: 0.4, life: 5, width: 1.4,
	};
	const peak = wakeWaveSlopeAt( 0, 6, ring ).slope;
	const shoulder = wakeWaveSlopeAt( 0, 6 + wakeWaveWidth( ring ) / Math.SQRT2, ring ).slope;
	const far = wakeWaveSlopeAt( 0, 14, ring ).slope;
	need( 'ring slope is quiet on the exact crest',
		peak < 0.08,
		`peak ${ peak.toFixed( 3 ) }` );
	need( 'ring slope lives on the shoulder',
		shoulder > 0.08 && shoulder > peak * 2,
		`shoulder ${ shoulder.toFixed( 3 ) }` );
	need( 'far from the ring there is no crest inject',
		foamEnergyCrestInject( far ) < 0.02 && far < 0.02,
		`far ${ far.toFixed( 3 ) }` );
	need( 'overlapping ring slopes add',
		Math.abs(
			wakeWaveSlopeFieldAt( 0, 6.99, { stamps: [ ring, { ...ring, amp: 0.5 } ] } ).slope
			- ( wakeWaveSlopeAt( 0, 6.99, ring ).slope
				+ wakeWaveSlopeAt( 0, 6.99, { ...ring, amp: 0.5 } ).slope ),
		) < 1e-6 );
}

{
	const field = new FoamEnergyField( { size: 48, extent: 24 } );
	field.origin = [ 0, 0 ];
	for ( let i = 0; i < 18; i ++ ) {

		field.step( 1 / 30, {
			a: [ 0, i * 0.35 ], b: [ 0, ( i + 1 ) * 0.35 ],
			fwd: [ 0, 1 ], stir: 0.7, beam: 1.4,
			// Inject profile only — Kelvin peel is checked separately.
			diverge: 0, waveCarry: 0, openSpeed: 0,
		} );

	}
	const center = field.sample( 0, 3.2 );
	const port = field.sample( - 1.4 * RIBBON_SIDE, 3.2 );
	const star = field.sample( 1.4 * RIBBON_SIDE, 3.2 );
	need( 'a cruising hull leaves one mirrored band with a live sailing line',
		center > 0.04 && Math.abs( port - star ) < 0.03 && port > center * 0.55,
		`c ${ center.toFixed( 3 ) } p ${ port.toFixed( 3 ) } s ${ star.toFixed( 3 ) }` );

	const before = field.sample( 1.4 * RIBBON_SIDE, 3.2 );
	for ( let i = 0; i < 40; i ++ ) field.step( 1 / 30, { stir: 0 } );
	const after = field.sample( 1.4 * RIBBON_SIDE, 3.2 );
	need( 'the film stays after the hull stops, then fades',
		after > 0.015 && after < before * 0.55,
		`before ${ before.toFixed( 3 ) } after ${ after.toFixed( 3 ) }` );

	const shortF = new FoamEnergyField( { size: 48, extent: 24 } );
	const longF = new FoamEnergyField( { size: 48, extent: 24 } );
	shortF.origin = [ 0, 0 ];
	longF.origin = [ 0, 0 ];
	for ( let i = 0; i < 18; i ++ ) {

		const opts = {
			a: [ 0, i * 0.35 ], b: [ 0, ( i + 1 ) * 0.35 ],
			fwd: [ 0, 1 ], stir: 0.7, beam: 1.4,
		};
		shortF.step( 1 / 30, opts );
		longF.step( 1 / 30, opts );

	}
	for ( let i = 0; i < 40; i ++ ) {

		shortF.step( 1 / 30, { stir: 0, decay: 0.4 } );
		longF.step( 1 / 30, { stir: 0, decay: 4 } );

	}
	need( 'a longer decay leaves more leftover film after the same idle time',
		longF.sample( 0, 3.2 ) > shortF.sample( 0, 3.2 ) * 2.2,
		`short ${ shortF.sample( 0, 3.2 ).toFixed( 3 ) } long ${ longF.sample( 0, 3.2 ).toFixed( 3 ) }` );
}

{
	const field = new FoamEnergyField( { size: 40, extent: 20 } );
	field.step( 1 / 30, {
		a: [ 0, 0 ], b: [ FOAM_ENERGY_TELEPORT + 2, 0 ],
		fwd: [ 1, 0 ], stir: 1, beam: 1.4,
	} );
	need( 'a teleport injects nothing',
		field.sample( 2.5, 0 ) < 0.01,
		`e ${ field.sample( 2.5, 0 ).toFixed( 4 ) }` );
	need( 'a long first-frame leap is brushed, not dumped as a slab',
		foamEnergyBrush( 3.2 ) < 0.35 && foamEnergyBrush( 0.3 ) === 1,
		`brush 3.2 ${ foamEnergyBrush( 3.2 ).toFixed( 3 ) } 0.3 ${ foamEnergyBrush( 0.3 ) }` );
	need( 'hull leftover is deposited per metre of sweep, not per second',
		Math.abs( foamEnergyPath( 0.35 ) - 0.35 ) < 1e-9
			&& foamEnergyPath( 3.2 ) < 1.0
			&& foamEnergyPath( 0 ) === 0,
		`path 0.35 ${ foamEnergyPath( 0.35 ).toFixed( 3 ) } 3.2 ${ foamEnergyPath( 3.2 ).toFixed( 3 ) }` );
}

{
	const p = { wrWakeSpeed: 0.55, wrWakeTurn: 0.35, wrWakeSlip: 0.25 };
	const crawlStir = sourceStir( {
		speed: 1.4, airborne: false, hullLoad: 0, yawRate: 0, slip: 0, impact: 0,
	}, p );
	const ribbon = new FoamEnergyField( { size: 48, extent: 24 } );
	ribbon.origin = [ 0, 0 ];
	ribbon.step( 1 / 30, {
		a: [ 0, 0 ], b: [ 0, 0.35 ], fwd: [ 0, 1 ], stir: 0.7, beam: 1.4,
	} );
	const onStroke = ribbon.sample( 0, 0.18 );
	const coinAft = ribbon.sample( 0, - 1.6 );
	need( 'a short sweep is a ribbon, not a coin around the stern',
		onStroke > 0.03 && coinAft < onStroke * 0.12,
		`stroke ${ onStroke.toFixed( 3 ) } coin ${ coinAft.toFixed( 4 ) }` );

	need( 'a crawl still stirs leftover foam',
		crawlStir > 0.15,
		`stir ${ crawlStir.toFixed( 3 ) }` );
	const crawl = new FoamEnergyField( { size: 48, extent: 24 } );
	crawl.origin = [ 0, 0 ];
	for ( let i = 0; i < 24; i ++ ) {

		crawl.step( 1 / 30, {
			a: [ 0, i * 0.05 ], b: [ 0, ( i + 1 ) * 0.05 ],
			fwd: [ 0, 1 ], stir: crawlStir, beam: 1.4, gain: 0.36,
		} );

	}
	need( 'a slow hull paints a continuous film on the open surface',
		crawl.sample( 0, 0.6 ) > 0.008,
		`e ${ crawl.sample( 0, 0.6 ).toFixed( 4 ) }` );
}

{
	const field = new FoamEnergyField( { size: 48, extent: 24 } );
	const ring = {
		stamps: [ {
			x: 0, z: 0, radius: 4, amp: 2.2, age: 0, life: 5, width: 1.4,
		} ],
	};
	field.step( 0.12, { stir: 0, rings: ring, crest: FOAM_ENERGY_CREST_TEST } );
	const onShoulder = field.sample( 0, 4 + wakeWaveWidth( ring.stamps[ 0 ] ) / Math.SQRT2 );
	const inside = field.sample( 0, 0.2 );
	need( 'an opt-in crest gain deposits leftover foam on a steep ring shoulder',
		onShoulder > 0.04,
		`shoulder ${ onShoulder.toFixed( 3 ) }` );
	need( 'the quiet interior of the ring stays dry',
		inside < onShoulder * 0.35,
		`inside ${ inside.toFixed( 3 ) }` );

	ring.stamps[ 0 ].radius = 9;
	for ( let i = 0; i < 8; i ++ ) field.step( 1 / 30, { stir: 0 } );
	const leftover = field.sample( 0, 4 + wakeWaveWidth( { ...ring.stamps[ 0 ], radius: 4 } ) / Math.SQRT2 );
	need( 'foam stays where the crest was after the ring moves on',
		leftover > 0.015,
		`left ${ leftover.toFixed( 3 ) }` );

	const live = new FoamEnergyField( { size: 48, extent: 24 } );
	live.step( 0.12, { stir: 0, rings: ring } );
	need( 'live leftover ignores expanding rings',
		FOAM_ENERGY_CREST === 0
			&& live.sample( 0, 4 + wakeWaveWidth( ring.stamps[ 0 ] ) / Math.SQRT2 ) < 0.005,
		`crest ${ FOAM_ENERGY_CREST } e ${ live.sample( 0, 4 + wakeWaveWidth( ring.stamps[ 0 ] ) / Math.SQRT2 ).toFixed( 4 ) }` );
}

{
	const dark = foamEnergyMask( 0.45, 0.05 );
	const bright = foamEnergyMask( 0.45, 0.95 );
	need( 'leftover energy is extra wind-foam coverage — lace can open holes',
		bright > dark && dark < 0.35 && bright > 0.35,
		`dark ${ dark.toFixed( 3 ) } bright ${ bright.toFixed( 3 ) }` );
	need( 'zero energy stays empty regardless of lace',
		foamEnergyMask( 0, 1 ) === 0 );
	const imgLo = wakeFoamFilm( 0.5, 0.12, 1 );
	const imgHi = wakeFoamFilm( 0.5, 0.92, 1 );
	const smooth = wakeFoamFilm( 0.5, 0.12, 0 );
	need( 'leftover with Texture lace is the foam image, not swirls under a tint',
		imgLo < 0.12 && imgHi > 0.40 && smooth > 0.45
			&& wakeFoamFilm( 0, 1, 1 ) === 0,
		`img ${ imgLo.toFixed( 3 ) }/${ imgHi.toFixed( 3 ) } smooth ${ smooth.toFixed( 3 ) }` );
	const old = wakeFoamAgePattern( 0.04, 0.9, 0.7, 0.1 );
	const middle = wakeFoamAgePattern( 0.28, 0.9, 0.7, 0.1 );
	const fresh = wakeFoamAgePattern( 0.98, 0.9, 0.7, 0.1 );
	need( 'wake energy ages packed foam from dense to cellular to sparse',
		fresh > middle && middle > old && old < 0.2 && fresh > 0.9,
		`old/mid/fresh ${ old.toFixed( 3 )}/${ middle.toFixed( 3 )}/${ fresh.toFixed( 3 ) }` );
	need( 'breakup only controls the old tail, not fresh transom suds',
		wakeFoamAgePattern( 0.04, 0.9, 0.7, 0.9 ) > old * 3
			&& Math.abs(
				wakeFoamAgePattern( 0.98, 0.9, 0.7, 0.9 ) - fresh
			) < 1e-6 );
	// One fetch of a repeating image always shows its own period, and every
	// other UV break is multiplied by ribbonK — so turning the texture knob
	// down brought a marching lattice of diamonds back down the trail.
	{
		const twoTap = ( src, uvB ) => src.includes( uvB )
			&& /tileMix/.test( src );
		need( 'the wake pack is two decorrelated taps, not one tiling fetch',
			twoTap( TSL_WATER, 'wakePackUvB' ) && twoTap( WATER_FS, 'wakePackUvB' ),
			'TSL and GLSL both blend a second rotated tap' );
		need( 'the tile-break blend is slower than either repeat — no lattice in the blend',
			TSL_WATER.includes( '0.0135' ) && WATER_FS.includes( '0.0135' ) );
		// Only the warp's own expression, not the ribbonK stretch below it.
		const warpExpr = ( src ) => {

			const at = src.indexOf( 'detileWarp' );
			return at < 0 ? '' : src.slice( at, src.indexOf( ';', at ) );

		};
		const freeOfRibbonK = ( src ) => {

			const e = warpExpr( src );
			return e.includes( 'vnoise2' ) && ! e.includes( 'ribbonK' );

		};
		need( 'the detile warp is not gated on ribbonK — the texture knob cannot re-tile it',
			freeOfRibbonK( TSL_WATER ) && freeOfRibbonK( WATER_FS ) );
	}
	need( 'ribbon vary 0 matches the old leftover film and pack UV',
		Math.abs( wakeFoamRibbonFilm( 0.5, 0.12, 1, 4, - 3, 0 ) - imgLo ) < 1e-9
			&& Math.abs( wakeFoamRibbonFilm( 0.5, 0.92, 1, 4, - 3, 0 ) - imgHi ) < 1e-9
			&& wakeFoamRibbonFilm( 0, 1, 1, 8, 2, 1 ) === 0
			&& Math.abs( wakeFoamPackUv( 1.2, - 0.4, 8, 2, 0 )[ 0 ]
				- ( ( 1.2 * 0.754 - ( - 0.4 ) * 0.657 ) * 0.73 + 0.173 ) ) < 1e-9 );
	const a = wakeFoamRibbonVary( 2, 11, WAKE_FOAM_RIBBON_VARY );
	const b = wakeFoamRibbonVary( 28, - 9, WAKE_FOAM_RIBBON_VARY );
	need( 'ribbon vary changes fill, opacity, stretch and holes in world XZ',
		a.coverage !== b.coverage
			&& a.opacity !== b.opacity
			&& a.stretchU !== b.stretchU
			&& a.fill > 0.15 && a.fill < 1.1
			&& a.opacity > 0.25 && a.opacity <= 1
			&& wakeFoamRibbonFilm( 0.55, 0.7, 1, 2, 11 ) !==
				wakeFoamRibbonFilm( 0.55, 0.7, 1, 28, - 9 ),
		`a ${ a.coverage.toFixed( 3 ) }/${ a.opacity.toFixed( 3 ) }  b ${ b.coverage.toFixed( 3 ) }/${ b.opacity.toFixed( 3 ) }` );
	need( 'ribbon vary does not invent leftover when energy is empty',
		wakeFoamRibbonFilm( 0, 1, 1, 2, 11 ) === 0
			&& wakeFoamRibbonVary( 0, 0, 0 ).coverage === 1
			&& wakeFoamRibbonVary( 0, 0, 0 ).stretchU === 1 );
	const w0 = wakeFoamRibbonWarp( 4, - 3, 0 );
	const wa = wakeFoamRibbonWarp( 4, - 3, 1 );
	const wb = wakeFoamRibbonWarp( 22, 9, 1 );
	need( 'ribbon warp is off at 0 and slides leftover foam, not leftover height',
		w0[ 0 ] === 0 && w0[ 1 ] === 0
			&& ( wa[ 0 ] !== wb[ 0 ] || wa[ 1 ] !== wb[ 1 ] )
			&& Math.hypot( wa[ 0 ], wa[ 1 ] ) > 0.4
			&& Math.hypot( wa[ 0 ], wa[ 1 ] ) < 12,
		`a ${ wa.map( ( v ) => v.toFixed( 2 ) ) } b ${ wb.map( ( v ) => v.toFixed( 2 ) ) }` );
	need( 'ribbon break stays 1 at amount 0',
		wakeFoamRibbonBreak( 4, - 3, 0.2, 0 ) === 1 );
	let weakFirst = false;
	for ( let i = 0; i < 64; i ++ ) {
		const x = ( i * 11.7 ) % 80 - 40;
		const z = ( i * 8.3 ) % 80 - 40;
		const lo = wakeFoamRibbonBreak( x, z, 0.02, 1 );
		const hi = wakeFoamRibbonBreak( x, z, 0.22, 1 );
		if ( hi > 0.08 && lo < hi ) {
			weakFirst = true;
			break;
		}
	}
	need( 'ribbon break opens weak leftover first', weakFirst );
	let islandMin = 1;
	for ( let i = 0; i < 48; i ++ ) {
		islandMin = Math.min( islandMin, wakeFoamRibbonBreak( i * 7.3, i * - 5.1, 0.35, 1 ) );
	}
	need( 'ribbon break can zero leftover foam into look-down islands',
		islandMin < 0.08,
		`min ${ islandMin.toFixed( 3 ) }` );
}

{
	need( 'classic water composites leftover energy as a wake film',
		WATER_FS.includes( 'foamEnergyAt' )
			&& WATER_FS.includes( 'smoothstep(0.32, 0.88, e)' )
			&& WATER_FS.includes( 'if (uFoamEnergyOn > 0.5)' )
			&& ! WATER_FS.includes( 'wake * 0.22' )
			&& WATER_FS.includes( 'foamF += wake * WAKE_FOAM_FRESH' )
			&& WATER_FS.includes( 'foamR += wake * WAKE_FOAM_RESIDUE' )
			&& WATER_FS.includes( 'uWakeFoamPack' )
			&& WATER_FS.includes( 'wakePattern' )
			&& WATER_FS.includes( 'wakeWrinkle' )
			&& WATER_FS.includes( 'mix(1.0, wakePattern, texK)' )
			&& WATER_FS.includes( 'foamF - wake * WAKE_FOAM_FRESH' )
			&& ! WATER_FS.includes( 'WAKE_LACE_FLOOR' ) );
	need( 'TSL water composites leftover energy as a wake film',
		TSL_WATER.includes( 'foamEnergyAt( vFlat.xz )' )
			&& TSL_WATER.includes( 'uFoamEnergyOn.greaterThan( 0.5 )' )
			&& TSL_WATER.includes( 'WAKE_FOAM_ENERGY_LO' )
			&& TSL_WATER.includes( 'const look' )
			&& ! TSL_WATER.includes( 'wake.mul( 0.22 )' )
			&& TSL_WATER.includes( 'foamF.addAssign( wake.mul( WAKE_FOAM_FRESH ) )' )
			&& TSL_WATER.includes( 'foamR.addAssign( wake.mul( WAKE_FOAM_RESIDUE ) )' )
			&& TSL_WATER.includes( 'wakeFoamTexture.sample( wakePackUv )' )
			&& TSL_WATER.includes( 'wakePattern' )
			&& TSL_WATER.includes( 'wakeWrinkle' )
			&& TSL_WATER.includes( 'mix( float( 1.0 ), wakePattern, texK )' )
			&& TSL_WATER.includes( 'foamF.sub( wake.mul( WAKE_FOAM_FRESH ) )' )
			&& ! TSL_WATER.includes( 'WAKE_LACE_FLOOR' ) );
	need( 'live leftover does not mix the stamp window back in',
		WATER_FS.includes( 'printed the record window' )
			&& TSL_WATER.includes( 'printed the record window' ) );
	need( 'TSL water does not paint leftover foam on expanding ring crests',
		! TSL_WATER.includes( 'h0.max( 0.0 ).mul( uWakeArm )' )
			&& TSL_WATER.includes( 'Rings stay as water' ) );
	need( 'TSL leftover lace UVs ignore wake-ring slope',
		TSL_WATER.includes( 'const foamUvSlope' )
			&& TSL_WATER.includes( 'foamUvSlope.mul( foamStrain' )
			&& TSL_WATER.includes( 'wakeLook.mul( 0.78 )' ) );
	need( 'leftover ribbon vary is look noise, not a live-heading mask',
		TSL_WATER.includes( 'uWakeFoamRibbonVary' )
			&& TSL_WATER.includes( 'wakeFoamRibbonVary()' )
			&& TSL_WATER.includes( 'wakeFoamPackUv()' )
			&& TSL_WATER.includes( 'rippleAt( vFlat.xz.add( foamWarp ) )' )
			&& TSL_WATER.includes( 'Leftover height stays on vFlat.xz' )
			&& TSL_WATER.includes( 'nIsland.smoothstep( 0.36, 0.64 )' )
			&& TSL_WATER.includes( 'Peak-only' )
			&& TSL_WATER.includes( 'const foamGain' )
			&& TSL_WATER.includes( 'uRippleFoam.min( 0.78 )' )
			&& WATER_FS.includes( 'uWakeFoamRibbonVary' )
			&& WATER_FS.includes( 'wakeFoamRibbonVary()' )
			&& ! TSL_WATER.includes( 'wakeFoamDiverge' )
			&& defaults.wakeFoamRibbonVary === WAKE_FOAM_RIBBON_VARY );
	need( 'recipe foam scales film coverage after energy saturates',
		wakeFoamRibbonAmount( 1, 0 ) === 0
			&& Math.abs( wakeFoamRibbonAmount( 1, 0.1 ) - 0.1 ) < 1e-9
			&& wakeFoamRibbonAmount( 1, 0.6 ) > wakeFoamRibbonAmount( 1, 0.1 ) + 0.4
			&& wakeFoamRibbonAmount( 1, 1.5 ) === 1
			&& TSL_WATER.includes( 'wakeFoamRibbonAmount()' )
			&& TSL_WATER.includes( 'uFoamRibbon.max( 0.0 )' )
			&& WATER_FS.includes( 'wakeFoamRibbonAmount()' )
			&& WATER_FS.includes( 'max(uFoamRibbon, 0.0)' ) );
	need( 'hull film does not paint a fixed tea tint under leftover foam',
		! TSL_WATER.includes( 'vec3( 0.16, 0.40, 0.38 )' )
			&& ! TSL_WATER.includes( 'hullFilm' )
			&& TSL_WATER.includes( 'Hull film only feeds the foam mask' )
			&& TSL_WATER.includes( 'uFoamColor.mul( albedo ).mul( Efoam )' ) );
	need( 'procedural foamField is skipped when Texture lace is the image',
		TSL_WATER.includes( 'texK.lessThan( 0.995 )' )
			&& WATER_FS.includes( 'if (texK < 0.995)' ) );
	need( 'TSL energy pass decays and hull-injects, without ring-shoulder leftover',
		TSL_ENERGY.includes( 'uFeDecay' )
			&& TSL_ENERGY.includes( 'FOAM_ENERGY_HULL' )
			&& ! TSL_ENERGY.includes( 'wakeWaveSlopeAt' )
			&& ! TSL_DRIVER.includes( 'setWakeWaveUniforms' )
			&& ! CPU_ENERGY.includes( 'uRingCount' ) );
	need( 'TSL foam backtraces and spreads through live leftover-wave motion',
		TSL_ENERGY.includes( 'rippleVelAt( w )' )
			&& TSL_ENERGY.includes( 'waveActivity' )
			&& TSL_ENERGY.includes( 'uFeWaveSpread' )
			&& TSL_ENERGY.includes( 'center.assign( mix( center, nearby, spread ) )' )
			&& TSL_ENERGY.includes( 'const tangent = vec2' )
			&& TSL_ENERGY.includes( '.mul( 0.25 )' )
			&& TSL_ENERGY.includes( 'If( uFeAgeDt.greaterThan( 0.0 )' )
			&& ! TSL_ENERGY.includes( 'const carryK' )
			&& ! TSL_ENERGY.includes( 'center.assign( center.max( shed ) )' )
			&& ! TSL_ENERGY.includes( 'waveActivity.mul( 12.0 )' )
			&& TSL_ENERGY.includes( 'waveGather' )
			&& TSL_ENERGY.includes( 'KELVIN_TAN' )
			&& TSL_ENERGY.includes( 'uFeOpenSpeed' )
			&& TSL_ENERGY.includes( 'leftoverC' )
			&& TSL_ENERGY.includes( 'rideSpeed' )
			&& TSL_ENERGY.includes( 'leftoverBubbleRide' )
			&& TSL_ENERGY.includes( 'flowCap' )
			&& CPU_ENERGY.includes( 'foamEnergyWaveRide' )
			&& TSL_ENERGY.includes( 'divergeFlow' )
			&& TSL_ENERGY.includes( 'uFeMotor' )
			&& TSL_ENERGY.includes( 'FOAM_ENERGY_MOTOR' )
			&& TSL_ENERGY.includes( 'const mTail' )
			&& TSL_ENERGY.includes( 'mul( mBehind ).mul( mTail )' )
			&& ! TSL_ENERGY.includes( 'smoothstep( float( 0.55 ), float( - 1.4 )' )
			&& TSL_COMMON.includes( 'packed.g.max( 0.62 )' )
			&& TSL_DRIVER.includes( 'setRippleUniforms( opts.ripples, 1 )' )
			&& TSL_DRIVER.includes( 'uFeOpenSpeed.value' )
			&& TSL_DRIVER.includes( 'uFeMotor.value' )
			&& TSL_ENERGY.includes( 'uFeMotorW' )
			&& TSL_ENERGY.includes( 'uFeMotorReach' )
			&& TSL_DRIVER.includes( 'uFeMotorW.value' )
			&& TSL_DRIVER.includes( 'uFeMotorReach.value' )
			&& TSL_WATER.includes( 'ragged' )
			&& TSL_WATER.includes( 'Tear the Kelvin' ) );
	need( 'hull leftover is one flat-topped ribbon in CPU and TSL; motor stays stern',
		CPU_ENERGY.includes( 'FOAM_ENERGY_RIBBON_W' )
			&& CPU_ENERGY.includes( 'foamEnergyPlanformHalf' )
			&& CPU_ENERGY.includes( 'foamEnergyAlong' )
			&& CPU_ENERGY.includes( 'foamEnergyLane' )
			&& CPU_ENERGY.includes( 'FOAM_ENERGY_WAKE_CHANNEL' )
			&& TSL_ENERGY.includes( 'FOAM_ENERGY_RIBBON_W' )
			&& TSL_ENERGY.includes( 'FOAM_ENERGY_ALONG_FLOOR' )
			&& TSL_ENERGY.includes( 'FOAM_ENERGY_WAKE_CHANNEL' )
			&& TSL_ENERGY.includes( 'FOAM_ENERGY_WAKE_CARVE' )
			&& TSL_ENERGY.includes( 'uFeYawRate' )
			&& TSL_ENERGY.includes( 'turnBias' )
			&& TSL_DRIVER.includes( 'uFeYawRate.value' )
			&& TSL_ENERGY.includes( 'alongK' )
			&& TSL_ENERGY.includes( 'wakeOpen' )
			&& TSL_ENERGY.includes( 'uFePlanform' )
			&& TSL_ENERGY.includes( 'foamEnergyPlanformHalf()' )
			&& TSL_ENERGY.includes( 'uFeStern' )
			&& TSL_DRIVER.includes( 'uFeStern.value' )
			&& TSL_WATER.includes( 'troughFloor' )
			&& TSL_WATER.includes( 'crestGate' )
			// The trough wipe rides its own uniform now. Gating it on the
			// additive uRippleFoam meant enabling glassy wave faces also
			// enabled the paint that draws a detached white V.
			&& TSL_WATER.includes( 'uRippleCrestGate.greaterThan( 0.001 )' )
			&& TSL_WATER.includes( 'wave.mul( float( 1.0 ).sub( troughFloor ) )' )
			&& TSL_WATER.includes( 'rippleVelAt' )
			&& TSL_WATER.includes( 'live.mul( uRippleCrestGate.min( 1.0 ) )' ) );
{
	// The trough wipe is MULTIPLICATIVE. Riding on the additive uRippleFoam
	// meant you could not have glassy wave faces without also enabling the
	// paint that draws a detached white V and punches rings.
	const gateAt = ( h, gate ) => foamEnergyCrestGate( 0.6, h, 0, gate );
	need( 'the crest gate is off by default — opt in, like diverge',
		defaults.wakeFoamCrestGate === 0,
		`default ${ defaults.wakeFoamCrestGate }` );
	need( 'gate 0 is exactly identity — switching it off cannot alter the film',
		gateAt( - 0.20, 0 ) === 1 && gateAt( 0.30, 0 ) === 1 );
	need( 'the gate only ever REMOVES white — it can never paint a V or a ring',
		[ - 0.4, - 0.2, - 0.05, 0, 0.05, 0.2, 0.5 ]
			.every( ( h ) => gateAt( h, 1 ) <= 1 + 1e-9 ) );
	need( 'troughs lose the film while crests keep it — glassy shoulders, white peaks',
		gateAt( - 0.25, 1 ) < gateAt( 0.25, 1 ) * 0.6,
		`trough ${ gateAt( - 0.25, 1 ).toFixed( 3 ) } crest ${ gateAt( 0.25, 1 ).toFixed( 3 ) }` );
	need( 'the knob fades the wipe in rather than snapping to full',
		gateAt( - 0.25, 0.5 ) > gateAt( - 0.25, 1 )
			&& gateAt( - 0.25, 0.5 ) < gateAt( - 0.25, 0 ),
		`0 ${ gateAt( - 0.25, 0 ).toFixed( 2 ) } .5 ${ gateAt( - 0.25, 0.5 ).toFixed( 2 ) } 1 ${ gateAt( - 0.25, 1 ).toFixed( 2 ) }` );
}
	need( 'CPU and TSL keep the live waterline foamed so a yaw hugs the transom',
		CPU_ENERGY.includes( 'foamEnergyLiveHull' )
			&& TSL_ENERGY.includes( 'uFeHullLen' )
			&& TSL_ENERGY.includes( 'sweep.max( liveHull )' )
			&& TSL_DRIVER.includes( 'uFeHullLen.value' ) );
	need( 'classic and TSL decay from a live uniform, not a baked constant',
		CPU_ENERGY.includes( 'uniform float uAgeDt, uInjectDt, uDecay' )
			&& TSL_ENERGY.includes( 'uFeAgeDt.negate().div( uFeDecay' )
			&& TSL_DRIVER.includes( 'uFeDecay.value' )
			&& ! TSL_ENERGY.includes( 'float( FOAM_ENERGY_DECAY )' ) );
	need( 'gust mottling is two-scale in classic and TSL — slicks plus cat\'s paws',
		String( WATER_FS ).includes( 'gq * 3.1' )
			&& TSL_WATER.includes( 'gustQ.mul( 3.1 )' )
			&& TSL_WATER.includes( 'mix( large, small, 0.34 )' ) );
	need( 'gust scales short-cascade slope so look-down is not the same chop everywhere',
		String( WATER_FS ).includes( 'cascadeGustWeight' )
			&& String( WATER_FS ).includes( 'slope += sl.xy * w * gw' )
			&& TSL_COMMON.includes( 'cascadeGustWeight' )
			&& TSL_COMMON.includes( 'sl.xy.mul( w ).mul( gw )' )
			&& TSL_WATER.includes( 'sampleCascadeSurface( vFlat.xz, dist, gust )' ) );
	need( 'look-down does not paint a colour wash or a milky roughness sheet',
		! String( WATER_FS ).includes( 'pawLook' )
			&& ! TSL_WATER.includes( 'pawLook' )
			&& String( WATER_FS ).includes( 'float roughGust = mix(gust, 1.0, lookDown)' )
			&& TSL_WATER.includes( 'mix( gust, float( 1.0 ), lookDown )' )
			&& TSL_WATER.includes( 'mul( roughGust )' ) );
}

for ( const r of results ) {

	console.log( `${ r.ok ? 'ok ' : 'FAIL' } ${ r.name }${ r.detail ? ` — ${ r.detail }` : '' }` );

}
const failed = results.filter( ( r ) => ! r.ok );
console.log( `\n${ results.length - failed.length } ok${ failed.length ? `, ${ failed.length } failed` : '' }\n` );
if ( failed.length ) process.exit( 1 );
