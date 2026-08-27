// Hull-wake whitewater, as node graphs. TSL twin of src/wake-suds.js.
//
// One source, both backends: Three compiles these to WGSL on WebGPU and to
// GLSL on WebGL2, so this file is the whole implementation and there is no
// second copy to drift (docs/webgpu-port.md). No wgslFn / glslFn — a raw
// source node compiles for exactly one backend and would put the fallback
// back where it started.
//
// Every threshold and weight is imported from the CPU twin rather than
// restated, so tools/check-wake-suds.mjs measures the numbers this shader
// actually runs. The prose for WHY each one is shaped this way lives there;
// what follows is only what the port itself has to get right.
//
// Porting rules that bite in this file:
//  · `mix` in FUNCTION form, always. The method form's receiver is the
//    interpolant (`a.mix(b, t)` is mix(b, t, a)) — rule 1 in tsl/noise.js.
//  · The engine loop is unrolled in JS against a fixed cap with an `If`
//    guard, not a `Loop` with a runtime bound — rule 2, same file.
//  · No GLSL keywords as variable names. `toVar()` carries the JS name
//    straight into the generated source, so a `const filter = ...toVar()`
//    would kill the whole water shader on the WebGL2 backend.

import { Fn, If, float, int, mix, smoothstep, uniform } from 'three/tsl';
import { fbm2 } from './noise.js';
import {
	SUDS_G, SUDS_CRAWL, SUDS_BREAK_STEEP, SUDS_BREAK_SPAN, SUDS_TRANSVERSE,
	SUDS_SOFTNESS, SUDS_GRAIN_WEIGHT, SUDS_CELL_WEIGHT,
	SUDS_WALL, SUDS_COARSEN,
} from '../../wake-suds.js';

/** Most screws anyone fits to one transom; the JS-unrolled loop bound. */
export const SUDS_ENGINE_CAP = 8;

// Rule 7: this module owns its uniforms and exports one setter. Nothing else
// may redeclare them. They are read at the CALL SITE and passed into the
// layouted helpers as parameters — a layouted Fn that reads a uniform bakes
// the first program's binding into three's per-Fn code cache (rule 18).

/**
 * Master crossfade between the two answers to "where is the foam".
 *
 * 0 is entirely the old one: the energy ribbon stamped along the hull's swept
 * path, the physics whitewater ribbon, and a painted leftover-crest churn.
 * 1 is entirely this one: coverage derived from where the water is actually
 * breaking, with both ribbons suppressed. Intermediate values dissolve
 * between them, which is what makes the comparison a live A/B rather than a
 * reload.
 *
 * It has to drive BOTH — the ribbons are additive contributions to the same
 * accumulator, so swapping only the churn term leaves the stamped path fully
 * present underneath and changes very little of what you actually see.
 */
export const uSuds = /*@__PURE__*/ uniform( 1.0 );
/** Critical steepness ak. Live knob over SUDS_BREAK_STEEP. */
export const uSudsSteep = /*@__PURE__*/ uniform( SUDS_BREAK_STEEP );
/**
 * Height, in metres, that counts as a full crest for the crest-face gate.
 * The leftover field carries height and slope but no phase, so this is what
 * stands in for cos(phase): a wave this tall is all crest, its mirror all
 * trough. Leftover crests are wide plateaus, so it is deliberately small.
 */
export const uSudsCrest = /*@__PURE__*/ uniform( 0.06 );

/** Live knobs. Missing keys keep the authored defaults. */
export function setWakeSudsUniforms( p = {} ) {

	const m = Number( p.wakeSuds );
	uSuds.value = Math.min( Math.max( Number.isFinite( m ) ? m : 1, 0 ), 1 );
	const steep = Number( p.wakeSudsSteep );
	uSudsSteep.value = Number.isFinite( steep ) && steep > 0 ? steep : SUDS_BREAK_STEEP;
	const crest = Number( p.wakeSudsCrest );
	uSudsCrest.value = Number.isFinite( crest ) && crest > 0 ? crest : 0.06;

}

/**
 * k = g/U² — the deep-water wave that keeps station with the hull.
 *
 * Branchless, and a ramp rather than a cutoff: the denominator is bounded at
 * a crawl, where the wavelength would otherwise run away to infinity, and the
 * smoothstep takes coverage to zero at rest so the wake fades in instead of
 * popping on whole at the moment of casting off. `select` would express a
 * hard cutoff more directly, but a hard cutoff is the thing being avoided.
 */
export const sudsWavenumber = /*@__PURE__*/ Fn( ( [ speed ] ) => {

	const u = speed.abs().toVar();
	const c = u.max( SUDS_CRAWL ).toVar();
	return float( SUDS_G ).div( c.mul( c ) ).mul( smoothstep( 0.0, SUDS_CRAWL, u ) );

} );

/** Foam sheds off the crest face; the trough behind it stays water. */
export const sudsCrestGate = /*@__PURE__*/ Fn( ( [ cosPhase ] ) => (

	smoothstep( - 0.15, 0.80, cosPhase )

) );

/**
 * Coverage from one breaking wave system. Below critical steepness this is
 * exactly zero — the property the whole approach rests on, since it is what
 * lets the wave field drive coverage without painting white over every
 * disturbed square metre.
 */
export const sudsBreak = /*@__PURE__*/ Fn( ( [ amp, k, cosPhase, critical ] ) => {

	const crit = critical.max( 1e-4 ).toVar();
	const steep = amp.max( 0.0 ).mul( k.max( 0.0 ) ).toVar();
	return smoothstep( crit, crit.mul( SUDS_BREAK_SPAN ), steep )
		.mul( sudsCrestGate( cosPhase ) );

} );

/** Divergent plus transverse, the latter breaking later and weaker. */
export const sudsBreakField = /*@__PURE__*/ Fn(
	( [ div, trans, k, cosDiv, cosTrans, critical ] ) => (

		sudsBreak( div, k, cosDiv, critical )
			.add( sudsBreak( trans, k, cosTrans, critical ).mul( SUDS_TRANSVERSE ) )
			.clamp( 0.0, 1.0 )

	) );

// ---------------------------------------------------------------- the lace --

/**
 * Cell walls: an iso-contour of the noise at its own mean. This is a RIDGE
 * function — bright on the contour, dark either side — which is why
 * sudsDetail() may never let it dominate.
 */
export const sudsLattice = /*@__PURE__*/ Fn( ( [ p, w ] ) => (

	float( 1.0 ).sub( smoothstep( 0.0, w, fbm2( p, int( 3 ) ).sub( 0.50 ).abs() ) )

) );

/** Thinning foam coarsens: widen the wall, never scale the sample point. */
export const sudsWallWidth = /*@__PURE__*/ Fn( ( [ cover, coarsen ] ) => (

	float( SUDS_WALL ).add(
		coarsen.max( 0.0 ).mul( SUDS_COARSEN ).mul( float( 1.0 ).sub( cover.clamp( 0.0, 1.0 ) ) ),
	)

) );

/**
 * Where to sample the lace. Bounded local offsets only — orbital surge with
 * the passing wave and an outward shove as each front sweeps by — so the
 * pattern distorts without being transported.
 *
 * Takes no coverage argument, and must not acquire one: scaling the sample
 * point by a spatially varying quantity warps the noise along that quantity's
 * gradient, and the lace snaps onto iso-contours of foam.
 */
export const sudsLacePoint = /*@__PURE__*/ Fn(
	( [ world, slope, rings, drift, ring, scale ] ) => (

		world.add( slope.mul( drift ).mul( 5.0 ) ).add( rings.mul( ring ) )
			.mul( scale.max( 1e-3 ) )

	) );

/** Grain-dominant, so the threshold yields cells rather than nested outlines. */
export const sudsDetail = /*@__PURE__*/ Fn( ( [ grain, cells ] ) => (

	grain.mul( SUDS_GRAIN_WEIGHT ).add( cells.mul( SUDS_CELL_WEIGHT ) ).clamp( 0.0, 1.0 )

) );

/** Sub-pixel lace aliases into sparkle, so fade it toward flat. */
export const sudsCrisp = /*@__PURE__*/ Fn( ( [ px, scale ] ) => {

	const cellSize = float( 1.0 ).div( scale.max( 1e-3 ) ).toVar();
	return float( 1.0 ).sub( smoothstep( 0.22, 0.75, px.max( 0.0 ).div( cellSize ) ) );

} );

/** Coverage slides a threshold down through the detail field. */
export const sudsLace = /*@__PURE__*/ Fn( ( [ detail, cover, softness ] ) => {

	const b = softness.max( 0.02 ).toVar();
	const f = cover.max( 0.0 ).toVar();
	return smoothstep( float( 1.0 ).sub( f ).sub( b ), float( 1.0 ).sub( f ).add( b ),
		detail.clamp( 0.0, 1.0 ) );

} );

/**
 * Beer–Lambert opacity. Approaches white asymptotically and never lands on
 * the hard cut-out edge a bare threshold produces — the reason the fringe
 * meshes with the surface instead of sitting on it as a decal.
 */
export const sudsOpacity = /*@__PURE__*/ Fn(
	( [ lace, cover, density, laceAmount ] ) => {

		const t = lace.max( 0.0 ).mul( cover.max( 0.0 ) ).mul( density.max( 0.0 ) )
			.mul( mix( float( 1.0 ), float( 1.6 ), laceAmount.clamp( 0.0, 1.0 ) ) ).toVar();
		return float( 1.0 ).sub( t.negate().exp() );

	} );

/** Bubbles pool in the troughs and thin over the crests. */
export const sudsTroughBias = /*@__PURE__*/ Fn( ( [ cover, height, amp, bias ] ) => {

	const t = height.negate().div( amp.max( 0.02 ) ).clamp( - 1.0, 1.0 ).toVar();
	return cover.max( 0.0 ).mul( float( 1.0 ).add( t.mul( bias ) ) );

} );

// -------------------------------------------------------------- prop wash --

/**
 * Wash coverage at lateral offset `lat`, one plume per screw. Each widens
 * with distance aft, so lanes born distinct at the transom merge downstream
 * on their own — which is the read that says how many are fitted.
 *
 * The loop is unrolled in JS to SUDS_ENGINE_CAP with the body under an `If`,
 * per the porting rule: a TSL `Loop` with a runtime bound is not verified on
 * the WebGL2 backend here, and `Break()` is not verified anywhere in this repo.
 */
export const sudsWash = /*@__PURE__*/ Fn(
	( [ lat, aft, engines, spacing, width, spread ] ) => {

		const n = engines.max( 1.0 ).toVar();
		const gap = spacing.max( 0.0 ).toVar();
		const w = width.max( 0.02 ).add( aft.max( 0.0 ).mul( spread ) ).toVar();
		const sum = float( 0.0 ).toVar();

		for ( let i = 0; i < SUDS_ENGINE_CAP; i ++ ) {

			If( float( i ).lessThan( n ), () => {

				const off = float( i ).sub( n.sub( 1.0 ).mul( 0.5 ) ).mul( gap ).toVar();
				const d = lat.sub( off ).div( w ).toVar();
				sum.addAssign( d.mul( d ).negate().exp() );

			} );

		}

		return sum.clamp( 0.0, 1.0 );

	} );

// Rule 17 / 18: every Fn above is PURE — parameters and literals only, no
// uniform or texture reads — so each may carry a layout. That matters on
// WebKit, which budgets 8 KB of private address space and counts every
// inlined node variable against it; the water fragment is the largest shader
// in the package and this film is sampled from several places inside it.
const F = ( name ) => ( { name, type: 'float' } );

sudsWavenumber.setLayout( { name: 'abyssal_sudsWavenumber', type: 'float',
	inputs: [ F( 'speed' ) ] } );
sudsCrestGate.setLayout( { name: 'abyssal_sudsCrestGate', type: 'float',
	inputs: [ F( 'cosPhase' ) ] } );
sudsBreak.setLayout( { name: 'abyssal_sudsBreak', type: 'float',
	inputs: [ F( 'amp' ), F( 'k' ), F( 'cosPhase' ), F( 'critical' ) ] } );
sudsBreakField.setLayout( { name: 'abyssal_sudsBreakField', type: 'float',
	inputs: [ F( 'div' ), F( 'trans' ), F( 'k' ), F( 'cosDiv' ), F( 'cosTrans' ),
		F( 'critical' ) ] } );
sudsLattice.setLayout( { name: 'abyssal_sudsLattice', type: 'float',
	inputs: [ { name: 'p', type: 'vec2' }, F( 'w' ) ] } );
sudsWallWidth.setLayout( { name: 'abyssal_sudsWallWidth', type: 'float',
	inputs: [ F( 'cover' ), F( 'coarsen' ) ] } );
sudsLacePoint.setLayout( { name: 'abyssal_sudsLacePoint', type: 'vec2',
	inputs: [ { name: 'world', type: 'vec2' }, { name: 'slope', type: 'vec2' },
		{ name: 'rings', type: 'vec2' }, F( 'drift' ), F( 'ring' ), F( 'scale' ) ] } );
sudsDetail.setLayout( { name: 'abyssal_sudsDetail', type: 'float',
	inputs: [ F( 'grain' ), F( 'cells' ) ] } );
sudsCrisp.setLayout( { name: 'abyssal_sudsCrisp', type: 'float',
	inputs: [ F( 'px' ), F( 'scale' ) ] } );
sudsLace.setLayout( { name: 'abyssal_sudsLace', type: 'float',
	inputs: [ F( 'detail' ), F( 'cover' ), F( 'softness' ) ] } );
sudsOpacity.setLayout( { name: 'abyssal_sudsOpacity', type: 'float',
	inputs: [ F( 'lace' ), F( 'cover' ), F( 'density' ), F( 'laceAmount' ) ] } );
sudsTroughBias.setLayout( { name: 'abyssal_sudsTroughBias', type: 'float',
	inputs: [ F( 'cover' ), F( 'height' ), F( 'amp' ), F( 'bias' ) ] } );
sudsWash.setLayout( { name: 'abyssal_sudsWash', type: 'float',
	inputs: [ F( 'lat' ), F( 'aft' ), F( 'engines' ), F( 'spacing' ),
		F( 'width' ), F( 'spread' ) ] } );

/** Default lace softness, re-exported so a caller need not reach past this. */
export { SUDS_SOFTNESS, SUDS_BREAK_STEEP };
