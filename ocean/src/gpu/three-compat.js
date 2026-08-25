// Compatibility shims between three r185 and current browsers.
//
// Applied by the app at boot, before any renderer is created. Everything here is
// a no-op in value terms - each one works around a place where three and a
// browser disagree about a *type*, not about behaviour.

let swizzlePatched = false;

/**
 * three r185's GPUTextureViewDescriptor sets `swizzle = 'rgba'` - a STRING - and
 * hands the descriptor to GPUTexture.createView(). The WebGPU spec's
 * `GPUTextureViewDescriptor.swizzle` is a `GPUTextureComponentSwizzle`
 * DICTIONARY ({ r: 'r', g: 'g', b: 'b', a: 'a' }), gated behind the
 * 'texture-component-swizzle' feature. three's own comment says the member is
 * "ignored otherwise", but Chromium validates the member's TYPE whether or not
 * the feature is enabled, so every createView throws:
 *
 *   Failed to execute 'createView' on 'GPUTexture': Failed to read the
 *   'swizzle' property from 'GPUTextureViewDescriptor': The provided value is
 *   not of type 'GPUTextureComponentSwizzle'.
 *
 * Nothing renders on WebGPU at all. Measured on Chromium 141.
 *
 * WHY DROPPING IT IS SAFE: 'rgba' is the IDENTITY swizzle - r->r, g->g, b->b,
 * a->a - and omitting the member entirely is defined to be the identity too. So
 * this removes a no-op that happens to be spelled in a type the browser rejects.
 * It cannot change a sampled value.
 *
 * Only fires when the descriptor actually carries a string, so a future three
 * that passes the dictionary form, or a browser that accepts the string, is
 * left alone.
 *
 * @returns {boolean} whether the patch was installed.
 */
export function installWebGPUSwizzleShim() {

	if ( swizzlePatched ) return false;
	if ( typeof GPUTexture === 'undefined' ) return false;

	const original = GPUTexture.prototype.createView;

	GPUTexture.prototype.createView = function ( descriptor ) {

		// Several call sites pass nothing (the swapchain view), which is fine.
		if ( descriptor && typeof descriptor.swizzle === 'string' ) {

			// three reuses ONE descriptor instance and calls reset() after each use,
			// so copy its own enumerable properties rather than mutating it.
			const copy = {};
			for ( const k in descriptor ) {

				if ( k === 'swizzle' ) continue;
				const v = descriptor[ k ];
				if ( typeof v === 'function' ) continue;     // skip reset()
				if ( v !== undefined ) copy[ k ] = v;

			}

			return original.call( this, copy );

		}

		return original.call( this, descriptor );

	};

	swizzlePatched = true;
	return true;

}

/** Every shim, in one call. */
export function installThreeCompat() {

	return { swizzle: installWebGPUSwizzleShim() };

}
