// TSL twin of src/pierce.js. Same numbers, same signs, same early-out.
// Uniforms live here (rule 7); the layouted core is scalars only
// (rule 18). The four amplitudes are computed on the CPU by pierceAmps()
// and handed over as metres, so speed, draft and gain cannot drift
// between the twins — only the geometry lives in this file. `well` is
// the interior drop (metres); 0 keeps the old near-field-only look.

import { Fn, float, uniform, If, smoothstep, mix } from 'three/tsl';
import * as THREE from 'three/webgpu';
import {
	pierceAmps, pierceScale, pierceTrenchLen, pierceTrenchOpen, pierceWellAmp,
	PIERCE_DEFAULTS,
} from '../../pierce.js';

export const uPierceOn = /*@__PURE__*/ uniform( 0.0 );
/** x, z of the site and the unit axis of its waterline outline. */
export const uPierceSite = /*@__PURE__*/ uniform( new THREE.Vector4( 0, 0, 0, - 1 ) );
/** half-length, thickness, then the unit direction of travel. */
export const uPierceForm = /*@__PURE__*/ uniform( new THREE.Vector4( 0, 0.15, 0, 0 ) );
/** rim, bow, side, trench — metres, already carrying speed and draft. */
export const uPierceAmp = /*@__PURE__*/ uniform( new THREE.Vector4( 0, 0, 0, 0 ) );
/** rimW, bowLen, sideLen, trenchW — metres of reach. */
export const uPierceLen = /*@__PURE__*/ uniform( new THREE.Vector4( 0.42, 1.5, 1.1, 0.85 ) );
/** Length the astern hollow takes to close, already scaled by head. */
export const uPierceTrenchLen = /*@__PURE__*/ uniform( 1.04 );
/** How far behind the trailing edge that hollow opens. */
export const uPierceTrenchOpen = /*@__PURE__*/ uniform( 0.35 );
/** Metres the surface drops inside the outline. 0 is near-field only. */
export const uPierceWell = /*@__PURE__*/ uniform( 0.0 );
/** World Y of the rod base. Well walls pose from here; the sea mesh does not. */
export const uPierceBaseY = /*@__PURE__*/ uniform( 0.0 );

const pierceCore = /*@__PURE__*/ Fn( ( [
	// `half` is a reserved word in GLSL ES — a layout input by that name
	// makes the whole water shader fail to compile on the WebGL2 backend.
	px, pz, sx, sz, ax, az, halfLen, r, vhx, vhz,
	rimA, bowA, sideA, trenchA, rimW, bowL, sideL, trenchW, trenchL, trenchOpen,
	wellA,
] ) => {

	const dx = px.sub( sx );
	const dz = pz.sub( sz );
	const dist = dx.mul( dx ).add( dz.mul( dz ) ).sqrt();

	// Distance outside the waterline outline (a segment of half-length
	// `halfLen`, thickness `r`). halfLen 0 is a plain circle.
	const t = dx.mul( ax ).add( dz.mul( az ) ).clamp( halfLen.negate(), halfLen );
	const qx = dx.sub( ax.mul( t ) );
	const qz = dz.sub( az.mul( t ) );
	const radial = qx.mul( qx ).add( qz.mul( qz ) ).sqrt();
	const s = radial.sub( r.max( 0.02 ) ).max( 0.0 );

	const fore = dx.mul( vhx ).add( dz.mul( vhz ) );
	const lateral = dx.mul( vhz ).negate().add( dz.mul( vhx ) ).abs();
	const aft = fore.negate().max( 0.0 );
	const cosT = fore.div( dist.max( 1e-4 ) );

	const g = ( x, w ) => x.div( w.max( 1e-3 ) ).mul( x.div( w.max( 1e-3 ) ) ).negate().exp();

	const rim = rimA.mul( g( s, rimW ) );
	const bow = bowA.mul( g( s, bowL ) ).mul( cosT.max( 0.0 ) );
	const side = sideA.mul( g( s, sideL ) ).mul( float( 1.0 ).sub( cosT.mul( cosT ) ) );
	const trench = trenchA
		.mul( g( lateral, trenchW ) )
		.mul( smoothstep( float( 0.0 ), trenchOpen.max( 1e-3 ), aft ) )
		.mul( aft.div( trenchL.max( 0.05 ) ).negate().exp() );

	const field = rim.add( bow ).sub( side ).sub( trench );
	const h = field.toVar();
	If( wellA.greaterThan( 1e-4 ), () => {

		const wall = r.max( float( 0.15 ) ).mul( 0.28 ).max( float( 0.08 ) );
		const occ = float( 1.0 ).sub( smoothstep( r, r.add( wall ), radial ) );
		h.assign( mix( field, wellA.negate(), occ ) );

	} );
	return h;

} );

pierceCore.setLayout( {
	name: 'abyssal_pierceCore',
	type: 'float',
	inputs: [
		{ name: 'px', type: 'float' },
		{ name: 'pz', type: 'float' },
		{ name: 'sx', type: 'float' },
		{ name: 'sz', type: 'float' },
		{ name: 'ax', type: 'float' },
		{ name: 'az', type: 'float' },
		{ name: 'halfLen', type: 'float' },
		{ name: 'r', type: 'float' },
		{ name: 'vhx', type: 'float' },
		{ name: 'vhz', type: 'float' },
		{ name: 'rimA', type: 'float' },
		{ name: 'bowA', type: 'float' },
		{ name: 'sideA', type: 'float' },
		{ name: 'trenchA', type: 'float' },
		{ name: 'rimW', type: 'float' },
		{ name: 'bowL', type: 'float' },
		{ name: 'sideL', type: 'float' },
		{ name: 'trenchW', type: 'float' },
		{ name: 'trenchL', type: 'float' },
		{ name: 'trenchOpen', type: 'float' },
		{ name: 'wellA', type: 'float' },
	],
} );

/** Collar / heap / draw-down / hollow only — no interior well. */
export const pierceFieldAt = /*@__PURE__*/ Fn( ( [ p ] ) => {

	const out = float( 0.0 ).toVar();
	If( uPierceOn.greaterThan( 0.5 ), () => {

		out.assign( pierceCore(
			p.x, p.y,
			uPierceSite.x, uPierceSite.y, uPierceSite.z, uPierceSite.w,
			uPierceForm.x, uPierceForm.y, uPierceForm.z, uPierceForm.w,
			uPierceAmp.x, uPierceAmp.y, uPierceAmp.z, uPierceAmp.w,
			uPierceLen.x, uPierceLen.y, uPierceLen.z, uPierceLen.w,
			uPierceTrenchLen, uPierceTrenchOpen,
			float( 0.0 ),
		) );

	} );
	return out;

} );

/** 1 inside the rod, 0 outside. Twin of pierceOccupancy() on the CPU. */
export const pierceOccupancyAt = /*@__PURE__*/ Fn( ( [ p ] ) => {

	const out = float( 0.0 ).toVar();
	If( uPierceOn.greaterThan( 0.5 ), () => {

		const dx = p.x.sub( uPierceSite.x );
		const dz = p.y.sub( uPierceSite.y );
		const ax = uPierceSite.z;
		const az = uPierceSite.w;
		const halfLen = uPierceForm.x;
		const r = uPierceForm.y;
		const t = dx.mul( ax ).add( dz.mul( az ) ).clamp( halfLen.negate(), halfLen );
		const qx = dx.sub( ax.mul( t ) );
		const qz = dz.sub( az.mul( t ) );
		const radial = qx.mul( qx ).add( qz.mul( qz ) ).sqrt();
		const wall = r.max( float( 0.15 ) ).mul( 0.28 ).max( float( 0.08 ) );
		out.assign( float( 1.0 ).sub( smoothstep( r, r.add( wall ), radial ) ) );

	} );
	return out;

} );

/** Height (m) of the near field at world XZ `p`, well included.
 *  The GPU sea no longer extrudes this — occupancy punches a hole and
 *  `src/gpu/pierce-well.js` draws the walls. CPU / pierce-lab still
 *  read the drop. */
export const pierceAt = /*@__PURE__*/ Fn( ( [ p ] ) => {

	const out = float( 0.0 ).toVar();
	If( uPierceOn.greaterThan( 0.5 ), () => {

		out.assign( pierceCore(
			p.x, p.y,
			uPierceSite.x, uPierceSite.y, uPierceSite.z, uPierceSite.w,
			uPierceForm.x, uPierceForm.y, uPierceForm.z, uPierceForm.w,
			uPierceAmp.x, uPierceAmp.y, uPierceAmp.z, uPierceAmp.w,
			uPierceLen.x, uPierceLen.y, uPierceLen.z, uPierceLen.w,
			uPierceTrenchLen, uPierceTrenchOpen,
			uPierceWell,
		) );

	} );
	return out;

} );

/**
 * @param {object|null} u one pierce site with knobs, as src/pierce.js
 *   documents it. Null (or a site out of the water) switches it off.
 */
export function setPierceUniforms( u ) {

	if ( ! u ) {

		uPierceOn.value = 0;
		uPierceAmp.value.set( 0, 0, 0, 0 );
		uPierceWell.value = 0;
		uPierceBaseY.value = 0;
		return;

	}
	const k = { ...PIERCE_DEFAULTS, ...u };
	const a = pierceAmps( u );
	const well = pierceWellAmp( u );
	const live = well > 1e-4 || a.rim > 1e-4 || a.bow > 1e-4 || a.side > 1e-4 || a.trench > 1e-4;
	uPierceOn.value = live ? 1 : 0;
	uPierceWell.value = well;
	uPierceBaseY.value = u.y ?? 0;
	if ( ! live ) return;

	const al = Math.hypot( u.ax ?? 0, u.az ?? - 1 ) || 1;
	const vl = Math.hypot( u.vx ?? 0, u.vz ?? 0 );
	uPierceSite.value.set(
		u.x ?? 0, u.z ?? 0,
		( u.ax ?? 0 ) / al, ( u.az ?? - 1 ) / al,
	);
	uPierceForm.value.set(
		Math.max( u.half ?? 0, 0 ),
		Math.max( u.r ?? 0.15, 0.02 ),
		vl > 1e-4 ? ( u.vx ?? 0 ) / vl : 0,
		vl > 1e-4 ? ( u.vz ?? 0 ) / vl : 0,
	);
	uPierceAmp.value.set( a.rim, a.bow, a.side, a.trench );
	// The shader is handed metres; the recipe holds multiples of the
	// site's own size, so one setting fits a fin and a hull cut.
	const sc = pierceScale( u );
	uPierceLen.value.set(
		k.rimReach * sc, k.bowReach * sc, k.sideReach * sc, k.trenchWide * sc,
	);
	uPierceTrenchLen.value = pierceTrenchLen( k, a.eta, sc );
	uPierceTrenchOpen.value = pierceTrenchOpen( sc );

}
