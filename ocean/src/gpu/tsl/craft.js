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
	Fn, If, float, vec2, vec3, vec4, uniform, texture, mix, clamp, smoothstep,
	positionLocal, normalLocal, uv, positionWorld, normalWorld, cameraPosition,
	modelWorldMatrix, transformNormalToView, varyingProperty, max, dot, normalize,
	pow, exp, faceDirection,
} from 'three/tsl';

import { CRAFT_MESH } from '../../../demo/craftModel.js';

import {
	uSunIrradiance, uAtmoExposure, R_PLANET,
	sunTransmittance, aerialPerspective,
} from './atmosphere.js';
import { uSunDir } from './sky-lut.js';
import { skyLutTexture } from './sky-background.js';
import { sampleSky, uSkyBlur } from './water-brdf.js';

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
export function buildCraftGeometry( lengthM = 3.2 ) {

	const pos = unb64( CRAFT_MESH.pos, Int16Array );
	const nrm = unb64( CRAFT_MESH.nrm, Int8Array );
	const uvq = unb64( CRAFT_MESH.uv, Uint16Array );
	const idx = unb64( CRAFT_MESH.idx, Uint16Array );

	const n = pos.length / 3;
	const P = new Float32Array( pos.length );
	const s = lengthM / 32000;
	for ( let i = 0; i < pos.length; i ++ ) P[ i ] = pos[ i ] * s;

	const N = new Float32Array( nrm.length );
	for ( let i = 0; i < nrm.length; i ++ ) N[ i ] = Math.max( nrm[ i ] / 127, - 1 );

	const U = new Float32Array( uvq.length );
	for ( let i = 0; i < uvq.length; i ++ ) U[ i ] = uvq[ i ] / 65535;

	const geo = new THREE.BufferGeometry();
	geo.setAttribute( 'position', new THREE.BufferAttribute( P, 3 ) );
	geo.setAttribute( 'normal', new THREE.BufferAttribute( N, 3 ) );
	geo.setAttribute( 'uv', new THREE.BufferAttribute( U, 2 ) );
	geo.setIndex( new THREE.BufferAttribute( idx, 1 ) );
	geo.computeBoundingSphere();
	return { geometry: geo, vertexCount: n, triangleCount: idx.length / 3 };

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
export async function loadCraftTexture( renderer ) {

	try {

		const bin = atob( CRAFT_MESH.baseColorJpeg );
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

// ---- material ---------------------------------------------------------------

export const uCraftGloss = /*@__PURE__*/ uniform( 0.8 );
export const uCraftWetLine = /*@__PURE__*/ uniform( 0.0 );      // world y of the waterline
export const uCraftWetDarken = /*@__PURE__*/ uniform( 0.55 );
export const uCraftHasTex = /*@__PURE__*/ uniform( 0.0 );
export const uCraftFallback = /*@__PURE__*/ uniform( /*@__PURE__*/ new THREE.Color( 0.47, 0.78, 0.75 ) );
export const uCraftSkyAmbient = /*@__PURE__*/ uniform( 1.0 );
export const uCraftAerial = /*@__PURE__*/ uniform( 1.0 );

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

	// faceDirection is -1 on a back face; the hull is not watertight everywhere
	// and demo/craft.js draws it double-sided for the same reason.
	const N = normalize( normalWorld ).mul( faceDirection ).toVar();
	const V = normalize( cameraPosition.sub( positionWorld ) ).toVar();

	const albedo = mix( uCraftFallback, craftBaseColor.sample( uv() ).rgb, uCraftHasTex ).toVar();

	// Below the waterline the paint is wet: darker and much glossier.
	const wet = smoothstep( 0.06, - 0.06, positionWorld.y.sub( uCraftWetLine ) ).toVar();
	albedo.mulAssign( mix( float( 1.0 ), uCraftWetDarken, wet ) );

	const rough = mix( mix( float( 0.20 ), float( 0.48 ), uCraftGloss.oneMinus() ), float( 0.10 ), wet ).toVar();
	const a = rough.mul( rough ).max( 1e-3 ).toVar();

	// The sun as the sea sees it: through the atmosphere, and switched off below
	// the horizon rather than lighting the craft after sunset.
	const ro = vec3( 0.0, positionWorld.y.max( 1.0 ).add( R_PLANET ), 0.0 ).toVar();
	const sunRad = uSunIrradiance
		.mul( sunTransmittance( ro, uSunDir ) )
		.mul( uAtmoExposure )
		.mul( smoothstep( - 0.09, 0.02, uSunDir.y ) ).toVar();

	const NoL = N.dot( uSunDir ).max( 0.0 ).toVar();
	const NoV = N.dot( V ).clamp( 1e-4, 1.0 ).toVar();

	// GGX, the same D and V the water uses, with a dielectric F0.
	const H = normalize( uSunDir.add( V ) ).toVar();
	const NoH = N.dot( H ).clamp( 0.0, 1.0 ).toVar();
	const a2 = a.mul( a ).toVar();
	const dd = NoH.mul( NoH ).mul( a2.sub( 1.0 ) ).add( 1.0 ).toVar();
	const D = a2.div( dd.mul( dd ).mul( 3.14159265 ).max( 1e-9 ) ).toVar();
	const k = a.mul( 0.5 ).toVar();
	const Vis = float( 0.5 ).div(
		NoL.mul( NoV.mul( k.oneMinus() ).add( k ) )
			.add( NoV.mul( NoL.mul( k.oneMinus() ).add( k ) ) ).max( 1e-6 ) ).toVar();
	const f0 = mix( float( 0.04 ), float( 0.03 ), wet ).toVar();
	const VoH = V.dot( H ).clamp( 0.0, 1.0 ).toVar();
	const F = f0.add( float( 1.0 ).sub( f0 ).mul( pow( float( 1.0 ).sub( VoH ), 5.0 ) ) ).toVar();

	const direct = sunRad.mul( NoL ).mul(
		albedo.mul( F.oneMinus() ).div( 3.14159265 ).add( vec3( D.mul( Vis ).mul( F ).min( 40.0 ) ) ) ).toVar();

	// Ambient: the LUT's own hemisphere, weighted by how much sky this normal
	// can see. mip 9 at the horizon row is the wide average, NOT a zenith patch.
	const skyIrr = skyLutTexture.sample( vec2( 0.5, 0.78 ) ).level( 9.0 ).rgb
		.mul( 3.14159265 ).mul( uCraftSkyAmbient ).toVar();
	const domeVis = float( 0.5 ).add( N.y.mul( 0.5 ) ).toVar();
	const ambient = albedo.mul( skyIrr ).mul( domeVis ).div( 3.14159265 ).toVar();

	// A blurred environment reflection, so the topsides pick up the sky rather
	// than reading as matte plastic.
	const R = N.mul( N.dot( V ).mul( 2.0 ) ).sub( V ).toVar();
	const envF = f0.add( float( 1.0 ).sub( f0 ).mul( pow( float( 1.0 ).sub( NoV ), 5.0 ) ) ).toVar();
	const envSpec = sampleSky( normalize( R ), a ).mul( envF ).toVar();

	const col = direct.add( ambient ).add( envSpec ).toVar();

	// ...and put it in the haze rather than in front of it.
	const eyeDist = cameraPosition.sub( positionWorld ).length().toVar();
	// aerialPerspective returns { inscatter, transmit } - two vec3s, not a
	// packed vector. Reading it as `.xyz` compiles perfectly and multiplies the
	// hull by nothing: measured as 63% of the craft's pixels at exactly zero
	// while the rest stayed bright. Applied the way the water applies it
	// (src/shaders/water.js): scale by transmittance, then add the inscatter.
	const { inscatter, transmit } = aerialPerspective(
		vec3( 0.0, cameraPosition.y.max( 1.0 ).add( R_PLANET ), 0.0 ),
		normalize( positionWorld.sub( cameraPosition ) ),
		eyeDist.min( 60000.0 ),
		uSunDir,
	);

	return vec4(
		col.mul( mix( vec3( 1.0 ), transmit, uCraftAerial ) ).add( inscatter.mul( uCraftAerial ) ),
		1.0,
	);

} );
