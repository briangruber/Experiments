// Runtime decoding shared by the raw WebGL2 and Three/WebGPU paths.
//
// The PNG bytes are generated into a JS module so the self-contained bundle
// never fetches an external file. ImageBitmap performs the browser's native PNG
// decode and leaves each renderer free to choose its own texture object.

import {
	FOAM_LACE_PNG_BASE64,
	WAKE_FOAM_PACK_PNG_BASE64,
	SPLASH_ATLAS_PNG_BASE64,
} from './generated-water-assets.js';

function bytesFromBase64( base64 ) {

	const binary = atob( base64 );
	const bytes = new Uint8Array( binary.length );
	for ( let i = 0; i < binary.length; i ++ ) bytes[ i ] = binary.charCodeAt( i );
	return bytes;

}

export async function decodeWaterPng( base64 ) {

	const bytes = bytesFromBase64( base64 );
	return createImageBitmap(
		new Blob( [ bytes ], { type: 'image/png' } ),
		{ colorSpaceConversion: 'none', premultiplyAlpha: 'none' },
	);

}

export const decodeFoamLace = () => decodeWaterPng( FOAM_LACE_PNG_BASE64 );
export const decodeWakeFoamPack = () => decodeWaterPng( WAKE_FOAM_PACK_PNG_BASE64 );
export const decodeSplashAtlas = () => decodeWaterPng( SPLASH_ATLAS_PNG_BASE64 );

/**
 * Replace a raw WebGL texture wrapper (src/gl.js texture2D()) with a decoded
 * one-channel PNG while preserving the wrapper object already held by a pass.
 */
export async function uploadWebGLMask( gl, texture, decode ) {

	const oldFlip = gl.getParameter( gl.UNPACK_FLIP_Y_WEBGL );
	try {

		const bitmap = await decode();
		gl.pixelStorei( gl.UNPACK_FLIP_Y_WEBGL, false );
		gl.bindTexture( gl.TEXTURE_2D, texture.tex );
		gl.texImage2D(
			gl.TEXTURE_2D, 0, gl.R8,
			gl.RED, gl.UNSIGNED_BYTE, bitmap,
		);
		gl.generateMipmap( gl.TEXTURE_2D );
		texture.width = bitmap.width;
		texture.height = bitmap.height;
		bitmap.close?.();
		return texture;

	} catch ( error ) {

		console.warn( 'Abyssal: water detail texture failed to decode; using fallback', error );
		return texture;

	} finally {

		gl.pixelStorei( gl.UNPACK_FLIP_Y_WEBGL, oldFlip );

	}

}

/** Upload the packed coarse / fine / breakup wake masks as RGBA8. */
export async function uploadWebGLRgba( gl, texture, decode ) {

	const oldFlip = gl.getParameter( gl.UNPACK_FLIP_Y_WEBGL );
	try {

		const bitmap = await decode();
		gl.pixelStorei( gl.UNPACK_FLIP_Y_WEBGL, false );
		gl.bindTexture( gl.TEXTURE_2D, texture.tex );
		gl.texImage2D(
			gl.TEXTURE_2D, 0, gl.RGBA8,
			gl.RGBA, gl.UNSIGNED_BYTE, bitmap,
		);
		gl.generateMipmap( gl.TEXTURE_2D );
		texture.width = bitmap.width;
		texture.height = bitmap.height;
		bitmap.close?.();
		return texture;

	} catch ( error ) {

		console.warn( 'Abyssal: packed wake foam texture failed to decode; using fallback', error );
		return texture;

	} finally {

		gl.pixelStorei( gl.UNPACK_FLIP_Y_WEBGL, oldFlip );

	}

}
