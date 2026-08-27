// Borrowing a Three.js renderer's WebGL2 context.
//
// The renderer here is not a Three.js renderer - it draws the sea and the sky
// with its own programs, its own vertex buffers and its own float render targets.
// What it does NOT do is create a second WebGL context: two contexts cannot share
// a depth buffer, so the sea could never occlude anything in your scene and
// nothing in your scene could ever float on it. Sharing the one context is what
// makes the two halves of the frame able to see each other.
//
// Sharing a context with another library means agreeing about state. The rule in
// both directions is "leave it as you found it", and Three.js provides
// renderer.resetState() for its half. See restoreThreeState below.

export function adoptContext(renderer) {
  const gl = renderer.getContext();
  if (typeof WebGL2RenderingContext !== 'undefined' && !(gl instanceof WebGL2RenderingContext)) {
    throw new Error(
      'Abyssal needs WebGL2. Construct THREE.WebGLRenderer normally (it picks WebGL2 by ' +
      'default) rather than forcing a WebGL1 context.',
    );
  }
  // Idempotent: asking twice returns the same object, so it is safe to adopt the
  // same renderer from both the water and the sky.
  if (!gl.ext) {
    gl.ext = {
      colorFloat: gl.getExtension('EXT_color_buffer_float'),
      floatLinear: gl.getExtension('OES_texture_float_linear'),
      aniso: gl.getExtension('EXT_texture_filter_anisotropic'),
    };
    gl.maxAniso = gl.ext.aniso
      ? gl.getParameter(gl.ext.aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)
      : 1;
  }
  if (!gl.ext.colorFloat) {
    throw new Error('Abyssal needs EXT_color_buffer_float; this device does not have it.');
  }
  return gl;
}

// Hand the context back to Three.js.
//
// resetState() clears Three's cached idea of the GL state, which is what stops it
// skipping a bind because it thinks the right thing is already bound. It also
// unbinds the framebuffer, so anything rendering to a target has to be told about
// it again - going back through setRenderTarget rather than binding the FBO
// ourselves keeps that correct across Three versions.
export function restoreThreeState(renderer) {
  const target = renderer.getRenderTarget();
  renderer.resetState();
  renderer.setRenderTarget(target);
}

// A known-good baseline before we draw. Three leaves whatever the last material
// wanted, and a stray scissor rectangle or a closed colour mask is invisible
// until it silently eats half the sea.
export function resetDrawState(gl) {
  gl.disable(gl.SCISSOR_TEST);
  gl.disable(gl.STENCIL_TEST);
  gl.disable(gl.BLEND);
  gl.colorMask(true, true, true, true);
  gl.frontFace(gl.CCW);
}
