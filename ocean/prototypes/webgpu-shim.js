// A test-harness shim that makes three r185 render on Chromium 141's WebGPU.
//
// WHAT IS BROKEN
//
// three's GPUTextureViewDescriptor sets `this.swizzle = 'rgba'` — a STRING — and
// passes the descriptor straight to GPUTexture.createView(). The WebGPU spec's
// `GPUTextureViewDescriptor.swizzle` is a `GPUTextureComponentSwizzle`
// DICTIONARY ({ r: 'r', g: 'g', b: 'b', a: 'a' }), gated behind the
// 'texture-component-swizzle' feature. three's own comment says "ignored
// otherwise", but Chromium validates the member's TYPE whether or not the
// feature is enabled, so every createView call throws:
//
//   Failed to execute 'createView' on 'GPUTexture': Failed to read the
//   'swizzle' property from 'GPUTextureViewDescriptor': The provided value is
//   not of type 'GPUTextureComponentSwizzle'.
//
// Nothing renders on the WebGPU backend, which is how the whole port came to be
// verified only on WebGL2 — the backend the port is FOR was the untested one.
//
// WHY DELETING IT IS SAFE
//
// 'rgba' is the IDENTITY swizzle: r->r, g->g, b->b, a->a. Omitting the member
// entirely is defined to be the identity too. So the shim removes a no-op that
// happens to be spelled in a type Chromium rejects. It cannot change any sampled
// value; if it could, this would be worthless as a verification aid.
//
// WHAT THIS IS NOT
//
// Not a fix, and not something the library ships. It exists so the probes can
// exercise the real WebGPU backend in this sandbox. The shipping code imports
// nothing from here — grep prototypes/ for it. When three or Chromium moves and
// the two agree again, delete this file and the imports.

let patched = false;

export function installWebGPUSwizzleShim() {

	if ( patched || typeof GPUTexture === 'undefined' ) return false;

	const original = GPUTexture.prototype.createView;

	GPUTexture.prototype.createView = function ( descriptor ) {

		// Some call sites pass nothing at all (the swapchain view), which is fine.
		if ( descriptor && typeof descriptor.swizzle === 'string' ) {

			// three reuses ONE descriptor instance and calls reset() after each use,
			// so copy the own enumerable properties rather than mutating its object.
			const copy = {};
			for ( const k in descriptor ) {

				if ( k === 'swizzle' ) continue;
				const v = descriptor[ k ];
				if ( typeof v === 'function' ) continue;   // skip reset()
				if ( v !== undefined ) copy[ k ] = v;

			}

			return original.call( this, copy );

		}

		return original.call( this, descriptor );

	};

	patched = true;
	return true;

}
