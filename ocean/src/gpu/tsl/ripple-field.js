// Puts src/ripple-field.js on the surface. Uniforms live here (rule 7).
//
// There is no TSL twin of the simulation, on purpose. The field runs on
// the CPU because buoyancy has to sample it without a readback, so this
// file only ships the result: one rg16float tile (visible height, vertical
// velocity), uploaded per frame. Visible height is raw simulation height plus
// the current occupancy source, so the source radiates waves without becoming
// a geometric hole. CPU and GPU therefore cannot disagree about the
// water — they are the same numbers — and the check for all of it is
// `node tools/check-ripple-field.mjs`, no GPU required.
//
// 128² × 2 half-floats is 64 KB a frame. If a scene ever needs a tile big
// enough for that to matter, the step belongs in a compute kernel beside
// src/gpu/kernels/ and this file becomes the sampler for it.

import { Fn, float, uniform, texture, vec2, If, smoothstep, clamp } from 'three/tsl';
import * as THREE from 'three/webgpu';

export const uRippleOn = /*@__PURE__*/ uniform( 0.0 );
/** ox, oz, 1 / (cell · size), (mid + 0.5) / size — everything uv needs. */
export const uRippleFrame = /*@__PURE__*/ uniform( new THREE.Vector4( 0, 0, 1, 0.5 ) );
/** 1 = paint leftover height (crest / trough). Does not change the field. */
export const uRippleDebug = /*@__PURE__*/ uniform( 0.0 );
/** Display scale on leftover height / slope. 1 is honest. */
export const uRippleVis = /*@__PURE__*/ uniform( 1.0 );
/**
 * ADDITIVE. Wave-influence gain: leftover crests WRITE new wake foam.
 * 0 = hull ribbon only. This is the path that can draw a detached white V
 * and, with ring waves on, punch doughnuts through the ribbon.
 */
export const uRippleFoam = /*@__PURE__*/ uniform( 0.0 );
/**
 * MULTIPLICATIVE. How hard leftover troughs are wiped out of the EXISTING
 * film. Adds no foam anywhere, so it cannot draw a V or punch a ring — it
 * can only take white off water that is not cresting.
 *
 * Split out of uRippleFoam because a real wake is mostly smooth water: the
 * big quarter-wave shoulders are glassy, and white sits only where a crest
 * is actually breaking. Sharing one uniform meant you could not have that
 * without also enabling the additive paint.
 */
export const uRippleCrestGate = /*@__PURE__*/ uniform( 0.0 );
/**
 * Inscribed-circle soft edge. Square min(u,v,1-u,1-v) fade drew a
 * straight ruler along each tile side — the hard line on a turning V.
 * 0 = hard disk; ~0.45 starts feathering about halfway to the rim.
 */
export const uRippleEdge = /*@__PURE__*/ uniform( 0.42 );
/** Soft leftover |h| ceiling so a bad CPU frame cannot stand the mesh up. */
export const uRippleHeightCap = /*@__PURE__*/ uniform( 8.0 );

function makeTile( size ) {

	const tex = new THREE.DataTexture(
		new Uint16Array( size * size * 2 ), size, size,
		THREE.RGFormat, THREE.HalfFloatType,
	);
	tex.minFilter = tex.magFilter = THREE.LinearFilter;
	tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
	tex.needsUpdate = true;
	return tex;

}

export const uRippleTile = /*@__PURE__*/ texture( makeTile( 4 ) );

/** Circular window fade shared by height and velocity. */
const rippleFadeAt = /*@__PURE__*/ Fn( ( [ uv ] ) => {

	const fromC = uv.sub( vec2( 0.5 ) ).toVar();
	const radial = fromC.dot( fromC ).sqrt().mul( 2.0 ).toVar();
	const edgeLo = float( 1.0 ).sub( uRippleEdge.max( 0.18 ).mul( 1.8 ) );
	return float( 1.0 ).sub( smoothstep( edgeLo, float( 1.0 ), radial ) );

} );

/** Visible height (m) at world XZ `p`; the live source hole is cancelled. */
export const rippleAt = /*@__PURE__*/ Fn( ( [ p ] ) => {

	const out = float( 0.0 ).toVar();
	If( uRippleOn.greaterThan( 0.001 ), () => {

		const uv = vec2(
			p.x.sub( uRippleFrame.x ).mul( uRippleFrame.z ).add( uRippleFrame.w ),
			p.y.sub( uRippleFrame.y ).mul( uRippleFrame.z ).add( uRippleFrame.w ),
		).toVar();
		const fade = rippleFadeAt( uv ).toVar();
		If( fade.greaterThan( 0.001 ), () => {

			out.assign( clamp(
				uRippleTile.sample( uv ).level( 0 ).r.mul( fade ).mul( uRippleOn ),
				uRippleHeightCap.negate(),
				uRippleHeightCap,
			) );

		} );

	} );
	return out;

} );

/** Vertical velocity (m/s) paired with rippleAt() in the G channel. */
export const rippleVelAt = /*@__PURE__*/ Fn( ( [ p ] ) => {

	const out = float( 0.0 ).toVar();
	If( uRippleOn.greaterThan( 0.001 ), () => {

		const uv = vec2(
			p.x.sub( uRippleFrame.x ).mul( uRippleFrame.z ).add( uRippleFrame.w ),
			p.y.sub( uRippleFrame.y ).mul( uRippleFrame.z ).add( uRippleFrame.w ),
		).toVar();
		const fade = rippleFadeAt( uv ).toVar();
		If( fade.greaterThan( 0.001 ), () => {

			out.assign( uRippleTile.sample( uv ).level( 0 ).g.mul( fade ).mul( uRippleOn ) );

		} );

	} );
	return out;

} );

let uploadedField = null;
let uploadedRevision = - 1;

/**
 * @param {import('../../ripple-field.js').RippleField | null} field
 * @param {number} [gain] fade the whole field in or out without stopping it
 */
export function setRippleUniforms( field, gain = 1 ) {

	if ( ! field || ! ( gain > 0 ) ) {

		uRippleOn.value = 0;
		return;

	}
	const size = field.size;
	if ( uRippleTile.value.image.width !== size ) {

		uRippleTile.value.dispose();
		uRippleTile.value = makeTile( size );
		uploadedField = null;

	}
	const revision = field.revision;
	if ( uploadedField !== field || revision == null || revision !== uploadedRevision ) {

		const data = uRippleTile.value.image.data;
		const h = field.h;
		const v = field.v;
		const source = field.source;
		const half = THREE.DataUtils.toHalfFloat;
		const cap = field.heightCap > 0 ? field.heightCap : 64;
		for ( let i = 0; i < h.length; i ++ ) {

			const y = h[ i ] + ( source?.[ i ] ?? 0 );
			data[ i * 2 ] = half( Math.max( - cap, Math.min( cap, y ) ) );
			data[ i * 2 + 1 ] = half( Math.max( - 64, Math.min( 64, v?.[ i ] ?? 0 ) ) );

		}
		uRippleTile.value.needsUpdate = true;
		uploadedField = field;
		uploadedRevision = revision ?? uploadedRevision + 1;

	}

	uRippleFrame.value.set(
		field.ox, field.oz,
		1 / ( field.cell * size ),
		( field.mid + 0.5 ) / size,
	);
	uRippleOn.value = gain;
	uRippleHeightCap.value = field.heightCap > 0 ? field.heightCap : 8;

}

/** Visual leftover look. The tile itself is unchanged. */
export function setRippleLook( debug = 0, vis = 1, foam = 0, crestGate = 0 ) {

	uRippleDebug.value = debug ? 1 : 0;
	uRippleVis.value = debug ? Math.max( vis, 1 ) : 1;
	uRippleFoam.value = Math.max( foam, 0 );
	uRippleCrestGate.value = clampGate( crestGate );

}

function clampGate( v ) {

	return Math.min( Math.max( Number( v ) || 0, 0 ), 1 );

}
