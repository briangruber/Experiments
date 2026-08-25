// The wave runner, as three.js geometry and a TSL material.
//
// The model itself is demo/craftModel.js - a Meshy.ai GLB quantised by
// tools/glb.mjs (Int16 positions over a unit bounding box, Int8 normals,
// Uint16 UVs) with its base colour map re-encoded at 512px, ~310 kB all in.
// It is inlined rather than fetched because the artifact CSP forbids every
// external request; that constraint is why the data arrives as base64 rather
// than as a .glb on disk, and it applies here exactly as it did to the raw-GL
// craft.
//
// This module is the BACKEND-SPECIFIC half only. The mesh data, the scale
// convention (length on X in the source, rotated so the bow sits at -Z) and
// the texture's colour space are all properties of the asset and are shared
// with demo/craft.js.
//
// ---------------------------------------------------------------------------
// WHAT THE SHADING HAS TO GET RIGHT, because the raw-GL craft got it wrong
// first and demo/craft.js carries the post-mortem:
//
//   - the sun is attenuated by sunTransmittance, so at a low sun the craft is
//     lit by the same reddened light as everything around it, and goes out
//     after sunset instead of glowing;
//   - ambient is the LUT's horizon-ish row at a high mip - the hemispherical
//     average the water integrates - not a bright patch of zenith;
//   - aerial perspective is applied, so the craft sits IN the haze rather than
//     in front of it.
//
// All three come from modules already ported for the sky and the water, so
// this material is assembled from them rather than reimplementing any of it.

import * as THREE from 'three/webgpu';
import {
	Fn, float, vec3, uniform, texture, mix, smoothstep,
	attribute, cos, sin,
	positionLocal, normalLocal, uv, positionWorld,
} from 'three/tsl';

import { CRAFT_MESH } from '../../../demo/craftModel.js';

import {
	skyLitColor, createOceanLitMaterial,
	uCraftWetLine, uCraftWetDarken, uCraftSkyAmbient, uCraftAerial,
} from './ocean-lit.js';
export { uCraftWetLine, uCraftWetDarken, uCraftSkyAmbient, uCraftAerial };
export { createOceanLitMaterial };
import { MAX_BREACH_EMITTERS, breachRuns, placeBreachEmitters, meshSheathRadii } from '../../breach-emitters.js';
export { MAX_BREACH_EMITTERS, breachRuns, placeBreachEmitters, meshSheathRadii };

const unb64 = ( s, T ) => {

	const bin = atob( s );
	const u8 = new Uint8Array( bin.length );
	for ( let i = 0; i < bin.length; i ++ ) u8[ i ] = bin.charCodeAt( i );
	return new T( u8.buffer );

};

/**
 * Decode CRAFT_MESH into a THREE.BufferGeometry, in metres.
 *
 * The quantised attributes are expanded to Float32 rather than handed to three
 * as normalized integer attributes. At 7.5k vertices that is ~180 kB of extra
 * GPU memory - nothing - and it removes an entire class of question about how
 * each backend interprets a normalized SHORT, which is not a question worth
 * owning twice.
 *
 * @param {number} lengthM - craftLength: the model's bounding box is unit, so
 *   this is the scale that puts it in metres. demo/craft.js does the same with
 *   uMeshScale = craftLength / 32000.
 */
export function buildCraftGeometry( lengthM = 3.2, record = CRAFT_MESH ) {

	const pos = unb64( record.pos, Int16Array );
	const nrm = unb64( record.nrm, Int8Array );
	const uvq = unb64( record.uv, Uint16Array );
	const idx = unb64( record.idx, Uint16Array );

	const n = pos.length / 3;
	const P = new Float32Array( pos.length );
	const s = lengthM / 32000;
	for ( let i = 0; i < pos.length; i ++ ) P[ i ] = pos[ i ] * s;

	const N = new Float32Array( nrm.length );
	for ( let i = 0; i < nrm.length; i ++ ) N[ i ] = Math.max( nrm[ i ] / 127, - 1 );

	const U = new Float32Array( uvq.length );
	for ( let i = 0; i < uvq.length; i ++ ) U[ i ] = uvq[ i ] / 65535;

	// The propeller spin weight, baked by tools/glb.mjs (see its flood-fill note
	// for why the blades cannot be selected by a box). ALWAYS present, zero-filled
	// when the record has none: the wave runner and the seaplane share one
	// material, so the vertex stage reads this attribute for both, and a geometry
	// missing it would be an undefined attribute rather than a still propeller.
	const S = new Float32Array( n );
	if ( record.spin ) {

		const sp = unb64( record.spin, Uint8Array );
		for ( let i = 0; i < n; i ++ ) S[ i ] = ( sp[ i ] ?? 0 ) / 255;

	}

	const geo = new THREE.BufferGeometry();
	geo.setAttribute( 'position', new THREE.BufferAttribute( P, 3 ) );
	geo.setAttribute( 'normal', new THREE.BufferAttribute( N, 3 ) );
	geo.setAttribute( 'uv', new THREE.BufferAttribute( U, 2 ) );
	geo.setAttribute( 'spin', new THREE.BufferAttribute( S, 1 ) );
	geo.setIndex( new THREE.BufferAttribute( idx, 1 ) );
	geo.computeBoundingSphere();
	// The hub in METRES, so the caller can point the spin axis at it.
	const hub = record.spinHub
		? record.spinHub.map( ( v ) => v * lengthM )
		: [ 0, 0, 0 ];
	return { geometry: geo, vertexCount: n, triangleCount: idx.length / 3, hub };

}

/**
 * Decode the inlined base colour JPEG into a texture.
 *
 * createImageBitmap on a Blob decodes without ever fetching a URL, so it works
 * under a CSP that forbids external AND data: image sources.
 *
 * NO FLIP, and it is load-bearing: glTF puts the UV origin at the top left,
 * which is where an image's first row already is. three's default for a
 * texture is flipY = true, which is right for its own loaders and wrong for
 * this asset - demo/craft.js measured the cost of the extra flip as the mean
 * colour difference across shared edges doubling, 13.5 to 26.4 of 255, because
 * triangles sampled unrelated islands of the atlas.
 *
 * @returns {Promise<THREE.Texture|null>} null if the decode failed, in which
 *   case the material falls back to a flat colour rather than to nothing.
 */
export async function loadCraftTexture( renderer, record = CRAFT_MESH ) {

	try {

		const bin = atob( record.baseColorJpeg );
		const u8 = new Uint8Array( bin.length );
		for ( let i = 0; i < bin.length; i ++ ) u8[ i ] = bin.charCodeAt( i );
		const bmp = await createImageBitmap( new Blob( [ u8 ], { type: 'image/jpeg' } ) );

		const tex = new THREE.Texture( bmp );
		tex.flipY = false;                       // see above
		tex.colorSpace = THREE.SRGBColorSpace;   // the atlas is sRGB; reading it linear washes the livery out
		tex.minFilter = THREE.LinearMipmapLinearFilter;
		tex.magFilter = THREE.LinearFilter;
		tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
		tex.generateMipmaps = true;
		tex.anisotropy = 8;
		tex.needsUpdate = true;
		return tex;

	} catch ( e ) {

		console.warn( 'Abyssal: craft texture decode failed, falling back to flat colour', e );
		return null;

	}

}

// ---- the propeller ----------------------------------------------------------

export const uPropAngle = /*@__PURE__*/ uniform( 0.0 );
export const uPropHub = /*@__PURE__*/ uniform( /*@__PURE__*/ new THREE.Vector3() );

/**
 * Spin the blades about the hub axis, in the VERTEX stage.
 *
 * The rotation is applied to positionLocal AND normalLocal. Assigning
 * normalLocal is the same mechanism three's own skinning and instancing use
 * (three.webgpu.js:18517, :18805) and it is not optional here: craftFragment
 * shades from normalWorld, which is derived from normalLocal through the normal
 * matrix, so rotating positions alone would spin the blades while their
 * lighting stayed nailed to where the blades used to be.
 *
 * The axis is the craft's own Z - the model's forward - which is where
 * tools/glb.mjs put the disc. Weight 0 (every vertex of the wave runner, and
 * every vertex of the plane that is not blade or hub) leaves the vertex exactly
 * where it was, so this costs the other hull two multiplies and nothing else.
 */
export const craftVertex = /*@__PURE__*/ Fn( () => {

	const w = attribute( 'spin', 'float' );
	const a = uPropAngle.mul( w ).toVar();
	const c = cos( a ).toVar(), s = sin( a ).toVar();

	const p = positionLocal.toVar();
	const dx = p.x.sub( uPropHub.x ).toVar();
	const dy = p.y.sub( uPropHub.y ).toVar();
	p.x.assign( uPropHub.x.add( dx.mul( c ).sub( dy.mul( s ) ) ) );
	p.y.assign( uPropHub.y.add( dx.mul( s ).add( dy.mul( c ) ) ) );

	const nx = normalLocal.x.toVar(), ny = normalLocal.y.toVar();
	normalLocal.assign( vec3(
		nx.mul( c ).sub( ny.mul( s ) ),
		nx.mul( s ).add( ny.mul( c ) ),
		normalLocal.z,
	) );

	return p;

} );

// ---- material ---------------------------------------------------------------

export const uCraftGloss = /*@__PURE__*/ uniform( 0.8 );
export const uCraftHasTex = /*@__PURE__*/ uniform( 0.0 );
export const uCraftFallback = /*@__PURE__*/ uniform( /*@__PURE__*/ new THREE.Color( 0.47, 0.78, 0.75 ) );

const craftBaseColor = /*@__PURE__*/ texture( /*@__PURE__*/ ( () => {

	const t = new THREE.DataTexture( new Uint8Array( [ 120, 200, 190, 255 ] ), 1, 1 );
	t.needsUpdate = true;
	return t;

} )() );

/** Point the material at the decoded atlas (or leave the flat fallback). */
export function setCraftTexture( tex ) {

	if ( ! tex ) return false;
	craftBaseColor.value = tex;
	uCraftHasTex.value = 1;
	return true;

}

/**
 * The craft's fragment shading: GGX over a textured albedo, lit by the same
 * attenuated sun and LUT ambient the sea uses, then hazed.
 */
export const craftFragment = /*@__PURE__*/ Fn( () => {

	const albedo = mix( uCraftFallback, craftBaseColor.sample( uv() ).rgb, uCraftHasTex ).toVar();
	const wet = smoothstep( 0.06, - 0.06, positionWorld.y.sub( uCraftWetLine ) ).toVar();
	albedo.mulAssign( mix( float( 1.0 ), uCraftWetDarken, wet ) );
	const rough = mix( mix( float( 0.20 ), float( 0.48 ), uCraftGloss.oneMinus() ), float( 0.10 ), wet ).toVar();
	const f0 = mix( float( 0.04 ), float( 0.03 ), wet ).toVar();
	return skyLitColor( albedo, rough, f0 );

} );

/**
 * A mesh's own half-width profile against height, so a wake can be as wide as
 * the part of the body ACTUALLY cutting the surface instead of a number
 * somebody had to guess and re-guess per craft.
 *
 * Built once from the geometry (and rebuilt only when the geometry is), then
 * read O(1) per frame by waterlineHalfWidth(). Bucketed by LOCAL y: for each
 * slice of height, the widest |x| any vertex reaches there. Empty buckets are
 * filled from their neighbours so a sparse mesh cannot punch holes in the
 * profile.
 *
 * APPROXIMATION, stated plainly: local y is treated as world-vertical, so a
 * pitched or rolled body is measured as though it were level. Correcting it
 * would mean transforming every vertex every frame - the whole cost this
 * exists to avoid - and at the angles anything here actually swims or floats
 * at, the error is far smaller than the guessed constant it replaces.
 *
 * @param {THREE.BufferGeometry} geometry - as returned by buildCraftGeometry.
 * @param {number} [bins=64] - height slices.
 * @returns {{minY:number, maxY:number, half:Float32Array}}
 */
export function buildWaterlineProfile( geometry, bins = 64 ) {

	const pos = geometry.getAttribute( 'position' );
	const half = new Float32Array( bins );
	let minY = Infinity, maxY = - Infinity;
	for ( let i = 0; i < pos.count; i ++ ) {

		const y = pos.getY( i );
		if ( y < minY ) minY = y;
		if ( y > maxY ) maxY = y;

	}
	if ( ! ( maxY > minY ) ) return { minY: 0, maxY: 0, half };

	const span = maxY - minY;
	for ( let i = 0; i < pos.count; i ++ ) {

		let b = Math.floor( ( pos.getY( i ) - minY ) / span * bins );
		if ( b < 0 ) b = 0; else if ( b >= bins ) b = bins - 1;
		const ax = Math.abs( pos.getX( i ) );
		if ( ax > half[ b ] ) half[ b ] = ax;

	}
	// Fill gaps both ways so a bucket no vertex landed in inherits a real
	// measurement rather than reporting a body of zero width.
	for ( let b = 1; b < bins; b ++ ) if ( half[ b ] === 0 ) half[ b ] = half[ b - 1 ];
	for ( let b = bins - 2; b >= 0; b -- ) if ( half[ b ] === 0 ) half[ b ] = half[ b + 1 ];
	return { minY, maxY, half };

}

/**
 * The body's half-width where the waterline crosses it.
 *
 * @param {{minY:number,maxY:number,half:Float32Array}} profile
 * @param {number} localY - the waterline in the MESH's own frame, i.e.
 *   seaLevel - meshOriginWorldY. Clamped into the body: above the top means a
 *   fully submerged body (report its narrow back, and let the caller's own
 *   depth fade take it from there), below the keel means it is out of the
 *   water entirely.
 * @returns {number} half-width in metres.
 */
export function waterlineHalfWidth( profile, localY ) {

	const { minY, maxY, half } = profile;
	if ( ! ( maxY > minY ) || ! half.length ) return 0;
	const t = Math.min( Math.max( ( localY - minY ) / ( maxY - minY ), 0 ), 1 );
	let b = Math.floor( t * half.length );
	if ( b >= half.length ) b = half.length - 1;
	return half[ b ];

}

/**
 * Which STATIONS along a body are high enough to break the surface - the
 * lengthwise companion to buildWaterlineProfile's crosswise one.
 *
 * For each slice along local Z, the highest local Y any vertex reaches there.
 * A dorsal fin is a tall, short station; a flank is a low, long one. With
 * this, "where is this mesh piercing the water" is a lookup rather than a
 * guess, so spray can leave the fin that is actually out instead of a ring
 * around the body's centre.
 *
 * @param {THREE.BufferGeometry} geometry
 * @param {number} [bins=48] - slices along the body.
 * @param {number} [yBins=12] - height slices per station, so width can be
 *   read at the waterline instead of at the widest (usually deepest) point.
 * @returns {{minZ:number, maxZ:number, top:Float32Array, low:Float32Array, half:Float32Array, yBins:number, band:Float32Array}}
 */
export function buildBreachProfile( geometry, bins = 48, yBins = 12 ) {

	const pos = geometry.getAttribute( 'position' );
	const top = new Float32Array( bins ).fill( - Infinity );
	const low = new Float32Array( bins ).fill( Infinity );
	const half = new Float32Array( bins );
	const empty = () => ( {
		minZ: 0, maxZ: 0,
		top: new Float32Array( bins ),
		low: new Float32Array( bins ),
		half: new Float32Array( bins ),
		yBins, band: new Float32Array( bins * yBins ),
	} );
	let minZ = Infinity, maxZ = - Infinity;
	for ( let i = 0; i < pos.count; i ++ ) {

		const z = pos.getZ( i );
		if ( z < minZ ) minZ = z;
		if ( z > maxZ ) maxZ = z;

	}
	if ( ! ( maxZ > minZ ) ) return empty();

	const span = maxZ - minZ;
	for ( let i = 0; i < pos.count; i ++ ) {

		let b = Math.floor( ( pos.getZ( i ) - minZ ) / span * bins );
		if ( b < 0 ) b = 0; else if ( b >= bins ) b = bins - 1;
		const y = pos.getY( i );
		if ( y > top[ b ] ) top[ b ] = y;
		if ( y < low[ b ] ) low[ b ] = y;
		const ax = Math.abs( pos.getX( i ) );
		if ( ax > half[ b ] ) half[ b ] = ax;

	}
	for ( let b = 1; b < bins; b ++ ) if ( top[ b ] === - Infinity ) top[ b ] = top[ b - 1 ];
	for ( let b = bins - 2; b >= 0; b -- ) if ( top[ b ] === - Infinity ) top[ b ] = top[ b + 1 ];
	for ( let b = 0; b < bins; b ++ ) if ( ! Number.isFinite( top[ b ] ) ) top[ b ] = 0;
	for ( let b = 1; b < bins; b ++ ) if ( ! Number.isFinite( low[ b ] ) ) low[ b ] = low[ b - 1 ];
	for ( let b = bins - 2; b >= 0; b -- ) if ( ! Number.isFinite( low[ b ] ) ) low[ b ] = low[ b + 1 ];
	for ( let b = 0; b < bins; b ++ ) if ( ! Number.isFinite( low[ b ] ) ) low[ b ] = 0;
	for ( let b = 1; b < bins; b ++ ) if ( half[ b ] === 0 ) half[ b ] = half[ b - 1 ];
	for ( let b = bins - 2; b >= 0; b -- ) if ( half[ b ] === 0 ) half[ b ] = half[ b + 1 ];

	// Width at each height, per station. Not filled across empty Ys: a sparse
	// fin must not inherit the belly's beam. Lookup uses the nearest measured
	// band, so a waterline through the fin reads the fin, not the pectorals.
	const band = new Float32Array( bins * yBins );
	for ( let i = 0; i < pos.count; i ++ ) {

		let b = Math.floor( ( pos.getZ( i ) - minZ ) / span * bins );
		if ( b < 0 ) b = 0; else if ( b >= bins ) b = bins - 1;
		const lo = low[ b ], hi = top[ b ];
		if ( ! ( hi > lo ) ) continue;
		let yb = Math.floor( ( pos.getY( i ) - lo ) / ( hi - lo ) * yBins );
		if ( yb < 0 ) yb = 0; else if ( yb >= yBins ) yb = yBins - 1;
		const ax = Math.abs( pos.getX( i ) );
		const idx = b * yBins + yb;
		if ( ax > band[ idx ] ) band[ idx ] = ax;

	}
	return { minZ, maxZ, top, low, half, yBins, band };

}

/**
 * Breach profile from a posed Object3D, in that object's local frame.
 * Walks every mesh so a GLB hull (not a single BufferGeometry) can drive
 * foam / spray the same way buildBreachProfile() does for the ski.
 */
export function breachProfileFromObject( root, bins = 48, yBins = 12 ) {

	if ( ! root ) return null;
	root.updateMatrixWorld( true );
	const pos = [];
	const v = new THREE.Vector3();
	root.traverse( ( obj ) => {

		if ( ! obj.isMesh || ! obj.geometry?.getAttribute ) return;
		const att = obj.geometry.getAttribute( 'position' );
		if ( ! att ) return;
		for ( let i = 0; i < att.count; i ++ ) {

			v.fromBufferAttribute( att, i );
			obj.localToWorld( v );
			root.worldToLocal( v );
			pos.push( v.x, v.y, v.z );

		}

	} );
	if ( pos.length < 9 ) return null;
	const geom = new THREE.BufferGeometry();
	geom.setAttribute( 'position', new THREE.Float32BufferAttribute( pos, 3 ) );
	const profile = buildBreachProfile( geom, bins, yBins );
	geom.dispose();
	return profile;

}

/** Scale a breach profile when the parent group is stretched. */
export function scaleBreachProfile( raw, sx = 1, sy = 1, sz = 1 ) {

	if ( ! raw ) return raw;
	if ( sx === 1 && sy === 1 && sz === 1 ) return raw;
	const half = raw.half ? raw.half.slice() : new Float32Array();
	const top = raw.top ? raw.top.slice() : new Float32Array();
	const low = raw.low ? raw.low.slice() : new Float32Array();
	for ( let i = 0; i < half.length; i ++ ) half[ i ] *= sx;
	for ( let i = 0; i < top.length; i ++ ) {

		top[ i ] *= sy;
		if ( low.length ) low[ i ] *= sy;

	}
	let band = raw.band;
	if ( band ) {

		band = band.slice();
		for ( let i = 0; i < band.length; i ++ ) band[ i ] *= sx;

	}
	return {
		...raw,
		minZ: raw.minZ * sz,
		maxZ: raw.maxZ * sz,
		top, low, half, band,
	};

}
