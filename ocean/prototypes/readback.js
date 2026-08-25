// Read a render target back with ONE row order, whichever backend drew it.
//
// readRenderTargetPixelsAsync does not normalise this, and the two backends
// disagree:
//
//   WebGL2   row 0 of the returned buffer is the BOTTOM of the image
//            (it is readPixels underneath, which is bottom-up)
//   WebGPU   row 0 is the TOP
//
// Measured, not assumed: rendering the TSL sky on both backends and diffing
// against the shipping WebGL2 reference gave a distribution that matched to
// 4e-6 with 98% of individual pixels wrong — the signature of the same image
// with its rows rearranged. Flipping the WebGPU readback dropped the mean
// absolute error to 0.00000.
//
// Everything in test/golden/ was captured with gl.readPixels, so BOTTOM-UP is
// this project's convention and this returns that on both backends.
//
// Getting it wrong does not error, and it does not even move the statistics —
// a comparison that only checked mean and rms would have called a vertically
// mirrored sky a perfect match.

/**
 * @param {THREE.WebGPURenderer} renderer - already init()ed.
 * @param {THREE.RenderTarget} target
 * @param {number} w
 * @param {number} h
 * @returns {Promise<Float32Array>} RGBA, row 0 = bottom, as gl.readPixels gives.
 */
export async function readPixelsBottomUp( renderer, target, w, h ) {

	// WebGPU requires a 256-byte row pitch on buffer copies, and the readback
	// does not compensate: for a target whose row is not a multiple of 256 bytes
	// the returned data is the padded buffer read at the unpadded stride, so rows
	// interleave with padding. It does not throw and it does not look like
	// garbage - measured on an 8x8 RGBA32F target (128-byte rows), the row
	// indices came back [0,0,1,0,2,0,3,0] instead of a permutation, which reads
	// as a plausible-but-wrong field rather than as an error.
	//
	// Every real target here clears the bar (the sky/water references are 160
	// wide = 2560 bytes; the FFT is 128 or 256), so this is a guard against a
	// probe author picking a small size and chasing a phantom for an hour.
	//
	// The per-channel size has to cover THREE types, not two. The `? 4 : 2` this
	// used to be reported an 8-bit target's row as twice its real width, so a
	// 160-wide RGBA8 target - a 640-byte row, and 640 % 256 = 128 - was computed as
	// 1280 and sailed through the guard, which is exactly the case the guard exists
	// for. (An 8-bit target also comes back as a Uint8Array, which the Float32Array
	// view below would reinterpret rather than convert; blit through a float
	// staging target rather than reading RGBA8 back directly.)
	const BYTES_PER_CHANNEL = {
		1015: 4,   // FloatType
		1016: 2,   // HalfFloatType
		1009: 1,   // UnsignedByteType
	};
	const bytesPerRow = w * 4 * ( BYTES_PER_CHANNEL[ target.texture?.type ] ?? 2 );
	if ( renderer.backend?.isWebGPUBackend && bytesPerRow % 256 !== 0 ) {

		throw new Error(
			`readPixelsBottomUp: width ${w} gives a ${bytesPerRow}-byte row, which is not a ` +
			'multiple of 256. WebGPU readback silently returns interleaved padding at this ' +
			'size - pick a width whose row is 256-byte aligned.',
		);

	}

	const raw = await renderer.readRenderTargetPixelsAsync( target, 0, 0, w, h );
	const px = raw instanceof Float32Array ? raw : new Float32Array( raw.buffer ?? raw );

	if ( ! renderer.backend?.isWebGPUBackend ) return px;

	const out = new Float32Array( px.length );
	const stride = w * 4;
	for ( let y = 0; y < h; y ++ ) {

		out.set( px.subarray( ( h - 1 - y ) * stride, ( h - y ) * stride ), y * stride );

	}

	return out;

}
