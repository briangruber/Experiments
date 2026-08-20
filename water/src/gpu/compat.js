// WebGPU compatibility shims for older Dawn builds (e.g. the SwiftShader
// adapter in CI Chromium). All three are no-ops or spec-default behaviour on
// current browsers, so they are applied unconditionally. Import this module
// before creating the renderer.

export function applyWebGPUCompat() {
  if (!globalThis.GPUTexture || GPUTexture.prototype.__churnCompat) return;
  GPUTexture.prototype.__churnCompat = true;

  const origCreateView = GPUTexture.prototype.createView;
  GPUTexture.prototype.createView = function (desc) {
    let d = desc ? { ...desc } : {};
    // newer-spec member some Dawn builds reject; three only uses identity
    if (d.swizzle !== undefined) delete d.swizzle;
    // older Dawn defaults an unspecified view dimension to 2d, which is
    // invalid for 3d textures (the spec derives 3d)
    if (this.dimension === '3d') d.dimension = '3d';
    return origCreateView.call(this, d);
  };

  const origCreateTexture = GPUDevice.prototype.createTexture;
  GPUDevice.prototype.createTexture = function (desc) {
    // older Dawn zero-initializes RENDER_ATTACHMENT textures through render
    // passes and its 3d path builds illegal per-slice 2d views, poisoning
    // the texture. Volumes are never render targets here, so drop the bit.
    if (desc && desc.dimension === '3d' && (desc.usage & GPUTextureUsage.RENDER_ATTACHMENT)) {
      desc = { ...desc, usage: desc.usage & ~GPUTextureUsage.RENDER_ATTACHMENT };
    }
    return origCreateTexture.call(this, desc);
  };
}
