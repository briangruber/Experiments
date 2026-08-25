// The water COLUMN, when the camera is under the mean surface.
//
// The sea mesh is a sheet at sea level. Looking up hits that sheet (the
// underside branch in ./water-surface.js). Looking anywhere else misses
// it and would show the sky's tan nadir — the "flat seafloor" in a dive.
// This pass fills those pixels with Beer-Lambert water, a virtual shelf
// with a lace caustic web, and sun shafts. Twin of src/underwater.js.
//
// Far-plane quad, depth-tested, no depth write: same slot as the sky
// background. Drawn instead of the sky while the eye is wet. Porting
// rules 1 (standalone mix), 3 (glScreenUV), 7 (import shared uniforms),
// 18 (layouted cores are scalars only).

import { Fn, If, float, vec3, vec4, uniform, smoothstep, mix } from 'three/tsl';
import * as THREE from 'three/webgpu';

import { uTime } from './cloud-field.js';
import { glScreenUV, uInvViewProj } from './sky-background.js';
import { UNDER_VIS, UNDER_ABSORB_SCALE, UNDER_FLOOR } from '../../underwater.js';
import { floorDepthAt, floorDepthBounds } from '../../seafloor.js';

export const uUwOn = /*@__PURE__*/ uniform( 0.0 );
export const uUwDepth = /*@__PURE__*/ uniform( 0.0 );
export const uUwFloor = /*@__PURE__*/ uniform( UNDER_FLOOR );
export const uUwAbsorb = /*@__PURE__*/ uniform( new THREE.Vector3( 0.3, 0.045, 0.03 ) );
export const uUwScatter = /*@__PURE__*/ uniform( new THREE.Vector3( 0.09, 0.52, 0.57 ) );
export const uUwScatterAmt = /*@__PURE__*/ uniform( 0.16 );
export const uUwSun = /*@__PURE__*/ uniform( new THREE.Vector3( 0.3, 0.8, 0.2 ) );
export const uUwCam = /*@__PURE__*/ uniform( new THREE.Vector3( 0, - 8, 0 ) );

// Animated caustic web. Scalars only (rule 18). Twin: src/underwater.js.
export const uwCaustic = /*@__PURE__*/ Fn( ( [ px, pz, t ] ) => {

	const w1 = pz.mul( 0.11 ).add( t.mul( 0.40 ) ).sin().mul( 7.5 )
		.add( px.mul( 0.05 ).add( t.mul( 0.18 ) ).sin().mul( 3.2 ) );
	const w2 = px.mul( 0.09 ).sub( t.mul( 0.35 ) ).cos().mul( 7.5 )
		.add( pz.mul( 0.06 ).add( t.mul( 0.12 ) ).cos().mul( 3.2 ) );
	const qx = px.add( w1 );
	const qz = pz.add( w2 );
	const a = qx.mul( 0.19 ).add( qz.mul( 0.07 ) ).add( t.mul( 0.28 ) ).sin().abs();
	const b = qz.mul( 0.17 ).sub( qx.mul( 0.08 ) ).sub( t.mul( 0.22 ) ).sin().abs();
	const c = qx.mul( 0.11 ).add( qz.mul( 0.14 ) ).add( t.mul( 0.16 ) ).sin().abs();
	const l1 = smoothstep( float( 0.90 ), float( 0.995 ), a ).pow( 2.1 );
	const l2 = smoothstep( float( 0.90 ), float( 0.995 ), b ).pow( 2.1 );
	const l3 = smoothstep( float( 0.93 ), float( 0.998 ), c ).pow( 2.6 );
	return l1.max( l2 ).mul( 2.5 ).add( l3.mul( 0.40 ) ).min( 3.2 );

} );

uwCaustic.setLayout( {
	name: 'abyssal_uwCaustic',
	type: 'float',
	inputs: [
		{ name: 'px', type: 'float' },
		{ name: 'pz', type: 'float' },
		{ name: 't', type: 'float' },
	],
} );

export const underwaterFragment = /*@__PURE__*/ Fn( () => {

	const ndc = vec4( glScreenUV().mul( 2.0 ).sub( 1.0 ), 1.0, 1.0 ).toVar();
	const wp = uInvViewProj.mul( ndc ).toVar();
	const rd = wp.xyz.div( wp.w ).sub( uUwCam ).normalize().toVar();

	const vis = float( UNDER_VIS );
	const path = vis.toVar();
	If( rd.y.greaterThan( 0.02 ), () => {

		path.assign( uUwDepth.div( rd.y.max( 0.02 ) ).min( vis ) );

	} );
	const hitFloor = float( 0.0 ).toVar();
	If( rd.y.lessThan( - 0.02 ).and( uUwDepth.lessThan( uUwFloor.sub( 0.4 ) ) ), () => {

		const tFloor = uUwFloor.sub( uUwDepth ).div( rd.y.negate().max( 0.02 ) );
		If( tFloor.lessThan( vis ), () => {

			path.assign( tFloor );
			hitFloor.assign( 1.0 );

		} );

	} );

	const k = uUwAbsorb.mul( float( UNDER_ABSORB_SCALE ) ).toVar();
	const trans = k.mul( path ).negate().exp().toVar();
	const sunH = smoothstep( float( - 0.05 ), float( 0.18 ), uUwSun.y ).toVar();
	const inscatter = uUwScatter
		.mul( uUwScatterAmt.mul( 2.8 ).add( 0.16 ) )
		.mul( sunH )
		.mul( float( 1.0 ).sub( path.mul( - 0.048 ).exp() ) )
		.mul( float( 1.0 ).add( smoothstep( float( - 0.05 ), float( 0.35 ), rd.y ).mul( 0.55 ) ) )
		.toVar();

	const deep = uUwScatter.mul( 0.035 ).toVar();
	const col = deep.mul( trans ).add( inscatter ).toVar();

	// Virtual shelf: sand + a bright lace of wave-focused light.
	If( hitFloor.greaterThan( 0.5 ), () => {

		const hx = uUwCam.x.add( rd.x.mul( path ) );
		const hz = uUwCam.z.add( rd.z.mul( path ) );
		const caus = uwCaustic( hx, hz, uTime ).toVar();
		const grain = uwCaustic( hx.mul( 0.37 ).add( 19.0 ), hz.mul( 0.37 ).add( 7.0 ), uTime.mul( 0.15 ) );
		const sand = vec3( 0.70, 0.60, 0.40 )
			.mul( sunH.mul( 0.45 ).add( 0.38 ) )
			.mul( grain.mul( 0.07 ).add( 0.93 ) );
		const lace = vec3( 1.0, 0.98, 0.90 ).mul( caus ).mul( sunH.mul( 0.70 ).add( 0.18 ) );
		const floorCol = sand.mul( 0.72 ).add( lace.mul( 0.90 ) );
		col.assign( floorCol.mul( trans ).add( inscatter ) );

	} );

	// God rays and in-water lace. Soft lobe + a tight core, both gated
	// by the same web so the shafts break up instead of painting a cone.
	const up = smoothstep( float( - 0.08 ), float( 0.22 ), rd.y ).toVar();
	const align = rd.dot( uUwSun ).max( 0.0 ).toVar();
	If( hitFloor.lessThan( 0.5 ).and( align.greaterThan( 0.10 ).or( up.greaterThan( 0.02 ) ) ), () => {

		const c0 = uwCaustic(
			uUwCam.x.add( rd.x.mul( path.mul( 0.22 ) ) ),
			uUwCam.z.add( rd.z.mul( path.mul( 0.22 ) ) ),
			uTime,
		);
		const c1 = uwCaustic(
			uUwCam.x.add( rd.x.mul( path.mul( 0.48 ) ) ),
			uUwCam.z.add( rd.z.mul( path.mul( 0.48 ) ) ),
			uTime.add( 1.7 ),
		);
		const c2 = uwCaustic(
			uUwCam.x.add( rd.x.mul( path.mul( 0.74 ) ) ),
			uUwCam.z.add( rd.z.mul( path.mul( 0.74 ) ) ),
			uTime.add( 3.1 ),
		);
		const lace = c0.add( c1 ).add( c2 ).mul( 0.33 ).toVar();
		const shafts = align.pow( 7.0 ).mul( 0.32 )
			.add( align.pow( 22.0 ).mul( 0.95 ) )
			.add( up.mul( 0.14 ) )
			.mul( lace.mul( 0.55 ).add( 0.45 ) )
			.mul( sunH )
			.mul( 1.25 )
			.toVar();
		const veil = uUwScatter.mul( 1.35 ).add( vec3( 0.50, 0.80, 1.0 ) )
			.mul( lace.mul( 0.055 ).mul( up.add( align.mul( 0.40 ) ) ).mul( sunH ) )
			.toVar();
		col.addAssign( veil.add( vec3( shafts ) ) );

	} );

	// First metre under the interface: leak a little sky-cyan so the
	// waterline does not pop from dry air to navy in one frame.
	const airLeak = smoothstep( float( 1.15 ), float( 0.04 ), uUwDepth );
	col.assign( mix( col, vec3( 0.32, 0.58, 0.74 ).mul( sunH.add( 0.22 ) ), airLeak.mul( 0.32 ) ) );

	return col;

} );

export function setUnderwaterUniforms( p, ctx ) {

	const sea = p?.seaLevel ?? 0;
	const y = ctx?.camPos?.[ 1 ] ?? 0;
	const depth = sea - y;
	const on = ( p?.underwater ?? 1 ) >= 0.5 && depth > 0;
	uUwOn.value = on ? 1 : 0;
	uUwDepth.value = Math.max( depth, 0 );
	const simDepth = p?.depth ?? UNDER_FLOOR;
	const bed = floorDepthBounds( p?.floorDepthMin, p?.floorDepthMax, p?.floorDepth );
	const camX = ctx?.camPos?.[ 0 ] ?? 0;
	const camZ = ctx?.camPos?.[ 2 ] ?? 0;
	uUwFloor.value = bed.live
		? floorDepthAt( camX, camZ, bed.min, bed.max, p?.floorTerrainScale )
		: Math.min( Math.max( simDepth, 12 ), UNDER_FLOOR );
	const a = p?.absorption ?? [ 0.3, 0.045, 0.03 ];
	const s = p?.scatterColor ?? [ 0.09, 0.52, 0.57 ];
	uUwAbsorb.value.set( a[ 0 ], a[ 1 ], a[ 2 ] );
	uUwScatter.value.set( s[ 0 ], s[ 1 ], s[ 2 ] );
	uUwScatterAmt.value = p?.scatterAmount ?? 0.16;
	if ( ctx?.sunDir ) uUwSun.value.set( ctx.sunDir[ 0 ], ctx.sunDir[ 1 ], ctx.sunDir[ 2 ] );
	if ( ctx?.camPos ) uUwCam.value.set( ctx.camPos[ 0 ], ctx.camPos[ 1 ], ctx.camPos[ 2 ] );
	if ( ctx?.time != null ) uTime.value = ctx.time;
	if ( ctx?.invViewProj ) uInvViewProj.value.fromArray( ctx.invViewProj );
	return on;

}
