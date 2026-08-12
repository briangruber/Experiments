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
