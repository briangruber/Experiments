// Thin WebGL2 layer: program cache, texture/FBO builders, fullscreen blitter.

export function getContext(canvas, opts = {}) {
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: true,
    stencil: false,
    premultipliedAlpha: false,
    // Both of these were costing power on every frame to serve something that
    // happens rarely or not at all.
    //
    // preserveDrawingBuffer keeps a copy of the backbuffer after every swap and
    // disables some compositor fast paths, and it existed solely so canvas.toBlob
    // would work for the Save PNG button. main.js now reads the buffer inside the
    // frame that drew it instead, which needs no copy at all.
    //
    // The headless harness is the exception: it screenshots the page from
    // outside the frame callback, so without the copy it reads a cleared
    // buffer and every capture comes back black. ?keepbuffer=1 turns it on
    // for that one caller.
    preserveDrawingBuffer: !!opts.keepBuffer,
    // 'high-performance' is an explicit request for the DISCRETE GPU on any
    // laptop with switchable graphics - asked for unconditionally, including
    // while sitting still on a calm preset. 'default' lets the machine decide;
    // set powerPref to 'high-performance' in the Quality section to force it back
    // when it is plugged in.
    powerPreference: opts.powerPref || 'default',
    desynchronized: false,
  });
  if (!gl) throw new Error('WebGL2 is required.');
  const ext = {
    colorFloat: gl.getExtension('EXT_color_buffer_float'),
    floatLinear: gl.getExtension('OES_texture_float_linear'),
    aniso: gl.getExtension('EXT_texture_filter_anisotropic'),
  };
  if (!ext.colorFloat) throw new Error('EXT_color_buffer_float is required.');
  gl.ext = ext;
  gl.maxAniso = ext.aniso ? gl.getParameter(ext.aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) : 1;
  return gl;
}

const VERSION = '#version 300 es\n';

function shader(gl, type, src, label) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    const numbered = src.split('\n').map((l, i) => `${String(i + 1).padStart(4)} | ${l}`).join('\n');
    console.error(`[${label}] shader compile failed:\n${log}\n${numbered}`);
    throw new Error(`${label}: ${log}`);
  }
  return s;
}

export function program(gl, vsSrc, fsSrc, label = 'prog', defines = '') {
  const pre = VERSION + 'precision highp float;\nprecision highp int;\nprecision highp sampler2D;\nprecision highp sampler2DArray;\n' + defines;
  // Both stages share `pre`, so a chunk included in both -- and several are --
  // has no way to tell which one it is being compiled into. That matters for
  // the stage-only builtins: fwidth/dFdx exist in the fragment stage and
  // nowhere else, so a fragment-only helper sitting in a shared chunk breaks
  // the VERTEX compile even when nothing there ever calls it.
  const vs = shader(gl, gl.VERTEX_SHADER, pre + '#define ABYSSAL_VERTEX 1\n' + vsSrc, label + '.vs');
  const fs = shader(gl, gl.FRAGMENT_SHADER, pre + '#define ABYSSAL_FRAGMENT 1\n' + fsSrc, label + '.fs');
  const p = gl.createProgram();
  gl.attachShader(p, vs); gl.attachShader(p, fs);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(`${label} link failed: ${gl.getProgramInfoLog(p)}`);
  }
  gl.deleteShader(vs); gl.deleteShader(fs);

  const uniforms = new Map();
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    const name = info.name.replace(/\[0\]$/, '');
    uniforms.set(name, { loc: gl.getUniformLocation(p, name), type: info.type, size: info.size });
  }
  p.u = (name) => uniforms.get(name)?.loc ?? null;
  p.uinfo = (name) => uniforms.get(name) ?? null;
  p.label = label;
  return p;
}

// Dispatches on the *declared* uniform type rather than guessing from the JS
// value, so `float[4]` and `vec4` can never be confused.
export function setUniforms(gl, prog, values) {
  let unit = 0;
  for (const key in values) {
    const info = prog.uinfo(key);
    if (!info) continue;             // optimised away; harmless
    const { loc, type } = info;
    const v = values[key];
    switch (type) {
      case gl.SAMPLER_2D:
      case gl.SAMPLER_2D_ARRAY:
      case gl.SAMPLER_CUBE:
      case gl.SAMPLER_3D:
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(v.target, v.tex);
        gl.uniform1i(loc, unit);
        unit++;
        break;
      case gl.FLOAT:
        if (typeof v === 'number') gl.uniform1f(loc, v); else gl.uniform1fv(loc, v);
        break;
      case gl.FLOAT_VEC2: gl.uniform2fv(loc, v); break;
      case gl.FLOAT_VEC3: gl.uniform3fv(loc, v); break;
      case gl.FLOAT_VEC4: gl.uniform4fv(loc, v); break;
      case gl.INT:
      case gl.BOOL:
        if (typeof v === 'number') gl.uniform1i(loc, v | 0);
        else if (typeof v === 'boolean') gl.uniform1i(loc, v ? 1 : 0);
        else gl.uniform1iv(loc, v);
        break;
      case gl.INT_VEC2: gl.uniform2iv(loc, v); break;
      case gl.INT_VEC3: gl.uniform3iv(loc, v); break;
      case gl.INT_VEC4: gl.uniform4iv(loc, v); break;
      case gl.FLOAT_MAT3: gl.uniformMatrix3fv(loc, false, v); break;
      case gl.FLOAT_MAT4: gl.uniformMatrix4fv(loc, false, v); break;
      default: break;
    }
  }
  return unit;
}

export function texture2D(gl, opts) {
  const {
    width, height,
    internalFormat = gl.RGBA16F, format = gl.RGBA, type = gl.HALF_FLOAT,
    filter = gl.LINEAR, wrap = gl.CLAMP_TO_EDGE, data = null, mips = false, aniso = 0,
  } = opts;
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, width, height, 0, format, type, data);
  const minF = mips ? (filter === gl.NEAREST ? gl.NEAREST_MIPMAP_NEAREST : gl.LINEAR_MIPMAP_LINEAR) : filter;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, minF);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  if (aniso && gl.ext.aniso) gl.texParameterf(gl.TEXTURE_2D, gl.ext.aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(aniso, gl.maxAniso));
  if (mips) gl.generateMipmap(gl.TEXTURE_2D);
  return { __tex: true, tex, target: gl.TEXTURE_2D, width, height, mips, internalFormat, format, type };
}

export function textureArray(gl, opts) {
  const {
    width, height, layers,
    internalFormat = gl.RGBA16F, format = gl.RGBA, type = gl.HALF_FLOAT,
    filter = gl.LINEAR, wrap = gl.REPEAT, mips = false, aniso = 0,
  } = opts;
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
  const levels = mips ? Math.floor(Math.log2(Math.max(width, height))) + 1 : 1;
  gl.texStorage3D(gl.TEXTURE_2D_ARRAY, levels, internalFormat, width, height, layers);
  const minF = mips ? (filter === gl.NEAREST ? gl.NEAREST_MIPMAP_NEAREST : gl.LINEAR_MIPMAP_LINEAR) : filter;
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, minF);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, wrap);
  if (aniso && gl.ext.aniso) gl.texParameterf(gl.TEXTURE_2D_ARRAY, gl.ext.aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(aniso, gl.maxAniso));
  return { __tex: true, tex, target: gl.TEXTURE_2D_ARRAY, width, height, layers, mips, internalFormat, format, type };
}

export function framebuffer(gl, attachments, { depth = null } = {}) {
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  const bufs = [];
  attachments.forEach((a, i) => {
    const point = gl.COLOR_ATTACHMENT0 + i;
    bufs.push(point);
    if (a.target === gl.TEXTURE_2D_ARRAY) {
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, point, a.tex, 0, a.layer || 0);
    } else {
      gl.framebufferTexture2D(gl.FRAMEBUFFER, point, gl.TEXTURE_2D, a.tex, 0);
    }
  });
  gl.drawBuffers(bufs);
  if (depth) gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Incomplete FBO: 0x' + status.toString(16));
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return fbo;
}

export function depthBuffer(gl, w, h) {
  const rb = gl.createRenderbuffer();
  gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
  gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
  return rb;
}

export class Blitter {
  constructor(gl) {
    this.gl = gl;
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }
  draw() {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }
}

// Same triangle, pinned to the far plane. Drawn after the ocean with a LEQUAL
// depth test, a sky pass using this shades only the pixels the sea did not
// already cover - which on a typical seascape is most of the frame saved, and
// the cloud raymarch is by far the most expensive thing per pixel.
export const FS_VERT_FAR = /* glsl */`
layout(location=0) in vec2 a_pos;
out vec2 vUv;
void main(){ vUv = a_pos*0.5+0.5; gl_Position = vec4(a_pos, 1.0, 1.0); }
`;

export const FS_VERT = /* glsl */`
layout(location=0) in vec2 a_pos;
out vec2 vUv;
void main(){ vUv = a_pos*0.5+0.5; gl_Position = vec4(a_pos,0.0,1.0); }
`;
