// WebGPU/Dawn compatibility shims.
//
// The interesting one is applyVolumeCompat below: without it the solver's
// compute submits are rejected outright and the tank renders as clear water at
// a healthy frame rate, which looks like a shading bug and is not one. See the
// comment there.

// Harmless everywhere: both are the spec-derived defaults, so they only make
// explicit what a current browser already does. Call before creating the
// renderer.
export function applyWebGPUCompat() {
  if (!globalThis.GPUTexture || GPUTexture.prototype.__churnCompat) return;
  GPUTexture.prototype.__churnCompat = true;

  const origCreateView = GPUTexture.prototype.createView;
  GPUTexture.prototype.createView = function (desc) {
    const d = desc ? { ...desc } : {};
    // newer-spec member some Dawn builds reject; three only uses identity
    if (d.swizzle !== undefined) delete d.swizzle;
    // older Dawn defaults an unspecified view dimension to 2d, which is
    // invalid for 3d textures (the spec derives 3d)
    if (this.dimension === '3d') d.dimension = '3d';
    return origCreateView.call(this, d);
  };
}

// Volume shim. Call after renderer.init() and before any volume is created.
//
// Dawn zero-initialises a texture lazily, at the submit that first reads it,
// and for a 3d RENDER_ATTACHMENT texture it does so through per-slice 2d views
// — which are illegal against a 3d texture. The submit is then rejected:
//
//   The dimension (TextureViewDimension::e2D) of the texture view is not
//   compatible with the dimension (TextureDimension::e3D) of [Texture 64x64x64]
//
// and because the rejected command buffer is the one carrying the solver's
// compute passes, the entire simulation silently never runs. The tank still
// renders — clear water, no foam, no bubbles, at a high frame rate, because
// nothing is being simulated. Volumes are never render targets here, so the
// fix is to drop the bit three.js adds unconditionally.
//
// `?compat=0` turns this off, which is how to check whether it is implicated
// in a failure on a machine we can't reproduce on; `?compat=1` forces it on.
export async function applyVolumeCompat(force) {
  const on = force === undefined ? true : force;
  if (on && globalThis.GPUDevice && !GPUDevice.prototype.__churnVolumeCompat) {
    GPUDevice.prototype.__churnVolumeCompat = true;
    const origCreateTexture = GPUDevice.prototype.createTexture;
    GPUDevice.prototype.createTexture = function (desc) {
      if (desc && desc.dimension === '3d' && (desc.usage & GPUTextureUsage.RENDER_ATTACHMENT)) {
        desc = { ...desc, usage: desc.usage & ~GPUTextureUsage.RENDER_ATTACHMENT };
      }
      return origCreateTexture.call(this, desc);
    };
  }
  // reported in the HUD so a screenshot says which adapter and which path
  let adapter = 'unknown';
  try {
    const a = await navigator.gpu.requestAdapter();
    const i = a && (a.info || (a.requestAdapterInfo ? await a.requestAdapterInfo() : null)) || {};
    adapter = `${i.vendor || ''} ${i.architecture || ''} ${i.device || ''} ${i.description || ''}`
      .replace(/\s+/g, ' ').trim() || 'unknown';
  } catch { /* adapter info is advisory only */ }
  return { on, adapter };
}
