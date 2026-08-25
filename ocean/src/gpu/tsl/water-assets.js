// Original texture detail shared by the TSL water and spray materials.
//
// Coverage and emission remain simulation-driven. These monochrome textures
// only shape that coverage: foam lace thresholds the FFT/terrain masks and the
// splash atlas breaks large hull-impact parcels into photographic silhouettes.

import * as THREE from 'three/webgpu';
import { texture } from 'three/tsl';

import {
	decodeFoamLace, decodeWakeFoamPack, decodeSplashAtlas,
} from '../../water-assets.js';

function maskPlaceholder( value ) {

	const t = new THREE.DataTexture(
		new Uint8Array( [ value ] ), 1, 1,
		THREE.RedFormat, THREE.UnsignedByteType,
	);
	t.minFilter = THREE.LinearMipmapLinearFilter;
	t.magFilter = THREE.LinearFilter;
	t.wrapS = t.wrapT = THREE.RepeatWrapping;
	t.generateMipmaps = false;
	t.colorSpace = THREE.NoColorSpace;
	t.needsUpdate = true;
	return t;

}

export const foamLaceTexture = /*@__PURE__*/ texture( /*@__PURE__*/ maskPlaceholder( 128 ) );
export const wakeFoamTexture = /*@__PURE__*/ texture( /*@__PURE__*/ ( () => {

	const t = new THREE.DataTexture(
		new Uint8Array( [ 128, 128, 128, 255 ] ), 1, 1,
		THREE.RGBAFormat, THREE.UnsignedByteType,
	);
	t.minFilter = THREE.LinearMipmapLinearFilter;
	t.magFilter = THREE.LinearFilter;
	t.wrapS = t.wrapT = THREE.RepeatWrapping;
	t.generateMipmaps = false;
	t.colorSpace = THREE.NoColorSpace;
	t.needsUpdate = true;
	return t;

} )() );
export const splashAtlasTexture = /*@__PURE__*/ texture( /*@__PURE__*/ maskPlaceholder( 255 ) );

function maskTexture( bitmap, wrap, format = THREE.RedFormat ) {

	const t = new THREE.Texture( bitmap );
	t.format = format;
	t.type = THREE.UnsignedByteType;
	t.minFilter = THREE.LinearMipmapLinearFilter;
	t.magFilter = THREE.LinearFilter;
	t.wrapS = t.wrapT = wrap;
	t.generateMipmaps = true;
	t.colorSpace = THREE.NoColorSpace;
	t.anisotropy = 8;
	t.needsUpdate = true;
	return t;

}

let loading = null;

/**
 * Decode and bind the project-owned detail textures. Safe to call repeatedly.
 * Placeholders carry the final sampler state, so late binding is valid on both
 * WebGPU and WebGL2 even when a material graph already exists.
 */
export function loadWaterAssetTextures() {

	if ( loading ) return loading;
	loading = Promise.all( [ decodeFoamLace(), decodeWakeFoamPack(), decodeSplashAtlas() ] )
		.then( ( [ foam, wakeFoam, splash ] ) => {

			const oldFoam = foamLaceTexture.value;
			const oldWakeFoam = wakeFoamTexture.value;
			const oldSplash = splashAtlasTexture.value;
			foamLaceTexture.value = maskTexture( foam, THREE.RepeatWrapping );
			wakeFoamTexture.value = maskTexture(
				wakeFoam, THREE.RepeatWrapping, THREE.RGBAFormat,
			);
			splashAtlasTexture.value = maskTexture( splash, THREE.ClampToEdgeWrapping );
			oldFoam.dispose();
			oldWakeFoam.dispose();
			oldSplash.dispose();
			return {
				foam: foamLaceTexture.value,
				wakeFoam: wakeFoamTexture.value,
				splash: splashAtlasTexture.value,
			};

		} )
		.catch( ( error ) => {

			console.warn( 'Abyssal: water detail textures failed to decode; using procedural fallbacks', error );
			return null;

		} );
	return loading;

}
