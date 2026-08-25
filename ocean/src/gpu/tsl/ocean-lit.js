// Atmosphere-lit materials for user meshes.
//
// MeshStandardMaterial + a white DirectionalLight is a studio lamp. The sea
// and the ride-demo hull are lit by sunTransmittance, the sky LUT, and
// aerial perspective. A box on the first of those looks pasted onto the
// second. This module is the shared lighting the hull already uses, as a
// material any mesh can wear.

import * as THREE from 'three/webgpu';
import {
	Fn, float, vec2, vec3, vec4, uniform, mix, smoothstep, texture,
	positionWorld, normalWorld, cameraPosition,
	normalize, pow, faceDirection,
} from 'three/tsl';

import {
	uSunIrradiance, uAtmoExposure, R_PLANET,
	sunTransmittance, aerialPerspective,
} from './atmosphere.js';
import { uSunDir } from './sky-lut.js';
import { skyLutTexture } from './sky-background.js';
import { sampleSky } from './water-brdf.js';
import { waterClipDiscard } from './water-clip.js';

export const uCraftWetLine = /*@__PURE__*/ uniform( 0.0 );
export const uCraftWetDarken = /*@__PURE__*/ uniform( 0.55 );
export const uCraftSkyAmbient = /*@__PURE__*/ uniform( 1.0 );
export const uCraftAerial = /*@__PURE__*/ uniform( 1.0 );

/**
 * GGX + LUT ambient + blurred sky reflection + aerial perspective.
 * Same path as the WaveRunner hull. `albedo` / `rough` / `f0` are already
 * wet-adjusted by the caller.
 */
export const skyLitColor = /*@__PURE__*/ Fn( ( [ albedo, rough, f0 ] ) => {

	const N = normalize( normalWorld ).mul( faceDirection ).toVar();
	const V = normalize( cameraPosition.sub( positionWorld ) ).toVar();
	const a = rough.mul( rough ).max( 1e-3 ).toVar();

	const ro = vec3( 0.0, positionWorld.y.max( 1.0 ).add( R_PLANET ), 0.0 ).toVar();
	const sunRad = uSunIrradiance
		.mul( sunTransmittance( ro, uSunDir ) )
		.mul( uAtmoExposure )
		.mul( smoothstep( - 0.09, 0.02, uSunDir.y ) ).toVar();

	const NoL = N.dot( uSunDir ).max( 0.0 ).toVar();
	const NoV = N.dot( V ).clamp( 1e-4, 1.0 ).toVar();

	const H = normalize( uSunDir.add( V ) ).toVar();
	const NoH = N.dot( H ).clamp( 0.0, 1.0 ).toVar();
	const a2 = a.mul( a ).toVar();
	const dd = NoH.mul( NoH ).mul( a2.sub( 1.0 ) ).add( 1.0 ).toVar();
	const D = a2.div( dd.mul( dd ).mul( 3.14159265 ).max( 1e-9 ) ).toVar();
	const k = a.mul( 0.5 ).toVar();
	const Vis = float( 0.5 ).div(
		NoL.mul( NoV.mul( k.oneMinus() ).add( k ) )
			.add( NoV.mul( NoL.mul( k.oneMinus() ).add( k ) ) ).max( 1e-6 ) ).toVar();
	const VoH = V.dot( H ).clamp( 0.0, 1.0 ).toVar();
	const F = f0.add( float( 1.0 ).sub( f0 ).mul( pow( float( 1.0 ).sub( VoH ), 5.0 ) ) ).toVar();

	const direct = sunRad.mul( NoL ).mul(
		albedo.mul( F.oneMinus() ).div( 3.14159265 ).add( vec3( D.mul( Vis ).mul( F ).min( 40.0 ) ) ) ).toVar();

	const skyIrr = skyLutTexture.sample( vec2( 0.5, 0.78 ) ).level( 9.0 ).rgb
		.mul( 3.14159265 ).mul( uCraftSkyAmbient ).toVar();
	const domeVis = float( 0.5 ).add( N.y.mul( 0.5 ) ).toVar();
	const ambient = albedo.mul( skyIrr ).mul( domeVis ).div( 3.14159265 ).toVar();

	const R = N.mul( N.dot( V ).mul( 2.0 ) ).sub( V ).toVar();
	const envF = f0.add( float( 1.0 ).sub( f0 ).mul( pow( float( 1.0 ).sub( NoV ), 5.0 ) ) ).toVar();
	const envSpec = sampleSky( normalize( R ), a ).mul( envF ).toVar();

	const col = direct.add( ambient ).add( envSpec ).toVar();
	const eyeDist = cameraPosition.sub( positionWorld ).length().toVar();
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

function wetAlbedo( albedo, gloss ) {

	const wet = smoothstep( 0.06, - 0.06, positionWorld.y.sub( uCraftWetLine ) ).toVar();
	albedo.mulAssign( mix( float( 1.0 ), uCraftWetDarken, wet ) );
	const rough = mix( mix( float( 0.20 ), float( 0.48 ), gloss.oneMinus() ), float( 0.10 ), wet ).toVar();
	const f0 = mix( float( 0.04 ), float( 0.03 ), wet ).toVar();
	return { albedo, rough, f0 };

}

/**
 * A NodeMaterial lit like the sea: reddened sun, sky-LUT ambient, haze.
 * Not MeshStandardMaterial — Three's lights do not share that atmosphere.
 *
 * @param {object} [opts]
 * @param {number|string|THREE.Color} [opts.color=0xc45a2a]
 * @param {number} [opts.gloss=0.55]
 * @param {THREE.Texture|null} [opts.map] — glTF base color; tinted by `color`
 * @returns {THREE.NodeMaterial}
 */
export function createOceanLitMaterial( opts = {} ) {

	const uColor = uniform( new THREE.Color( opts.color ?? 0xc45a2a ) );
	const uGloss = uniform( opts.gloss ?? 0.55 );
	const map = opts.map ?? null;
	if ( map ) {

		map.colorSpace = THREE.SRGBColorSpace;
		map.flipY = false;

	}

	const mat = new THREE.NodeMaterial();
	mat.name = 'abyssal.oceanLit';
	mat.fragmentNode = Fn( () => {

		waterClipDiscard();
		const albedo = map
			? texture( map ).rgb.mul( uColor ).toVar()
			: uColor.toVar();
		const lit = wetAlbedo( albedo, uGloss );
		return skyLitColor( lit.albedo, lit.rough, lit.f0 );

	} )();
	mat.side = THREE.DoubleSide;
	mat.userData.color = uColor;
	mat.userData.gloss = uGloss;
	mat.userData.map = map;
	return mat;

}
