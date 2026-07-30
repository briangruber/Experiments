// Frame graph for the harbour.
//
//   shadow      one directional map over the boat and the village
//   refraction  everything below the waterline, into its own buffer
//   main        sky, everything above the waterline, then the sea on top
//   bloom       a small bright-pass blur so the glitter and the lanterns burn
//   present     tonemap + vignette
//
// The refraction buffer is what sells the water: the sea shader reads the bed
// through it and knows how deep the water is at every pixel because each pass
// writes view distance into alpha.

import { program, setUniforms, texture2D, framebuffer, depthBuffer, Blitter, FS_VERT } from '../src/gl.js';
import { mat4, mul, invert, lookAt, perspective, v3, vNorm, vAdd, vScale } from '../src/math.js';
import {
  SOLID_VS, SOLID_FS, SHADOW_VS, SHADOW_FS, SKY_FS, WATER_VS, WATER_FS,
  SPRITE_VS, SPRITE_FS, POST_FS, BRIGHT_FS, BLUR_FS,
  FOAM_STAMP_VS, FOAM_STAMP_FS, FOAM_FADE_FS,
} from './shaders.js';

const SHADOW_SIZE = 1536;
const FOAM_SIZE = 512;
// Stand-in for "nothing here" in the view-distance channel. Half-float tops
// out at 65504, so this has to stay comfortably under it.
export const FAR_DIST = 40000;
export const FOAM_EXTENT = 220;      // world metres covered by the foam field

function ortho(l, r, b, t, n, f, o = mat4()) {
  o.fill(0);
  o[0] = 2 / (r - l); o[5] = 2 / (t - b); o[10] = -2 / (f - n);
  o[12] = -(r + l) / (r - l); o[13] = -(t + b) / (t - b); o[14] = -(f + n) / (f - n); o[15] = 1;
  return o;
}

function normalMat3(m, o = new Float32Array(9)) {
  // Rigid transforms only (rotation + uniform scale), which is all the scene
  // uses, so the upper 3x3 is its own inverse-transpose up to scale.
  o[0] = m[0]; o[1] = m[1]; o[2] = m[2];
  o[3] = m[4]; o[4] = m[5]; o[5] = m[6];
  o[6] = m[8]; o[7] = m[9]; o[8] = m[10];
  return o;
}

export class Renderer {
  constructor(gl, canvas) {
    this.gl = gl;
    this.canvas = canvas;
    this.blit = new Blitter(gl);
    this.quality = 1;
    this.waterY = 0;
    this.time = 0;
    this.sunDir = vNorm(v3(0.52, 0.72, 0.42));
    this.sunColor = v3(1.14, 1.02, 0.86);
    this.fogDensity = 0.0015;

    this.pSolid = program(gl, SOLID_VS, SOLID_FS, 'solid');
    this.pShadow = program(gl, SHADOW_VS, SHADOW_FS, 'shadow');
    this.pSky = program(gl, FS_VERT, SKY_FS, 'sky');
    this.pWater = program(gl, WATER_VS, WATER_FS, 'water');
    this.pSprite = program(gl, SPRITE_VS, SPRITE_FS, 'sprite');
    this.pPost = program(gl, FS_VERT, POST_FS, 'post');
    this.pBright = program(gl, FS_VERT, BRIGHT_FS, 'bright');
    this.pBlur = program(gl, FS_VERT, BLUR_FS, 'blur');
    this.pFoamStamp = program(gl, FOAM_STAMP_VS, FOAM_STAMP_FS, 'foamStamp');
    this.pFoamFade = program(gl, FS_VERT, FOAM_FADE_FS, 'foamFade');

    this.viewProj = mat4();
    this.invViewProj = mat4();
    this.lightViewProj = mat4();
    this.proj = mat4();
    this.view = mat4();
    this.camPos = v3();

    this.buildShadow();
    this.buildWaterGrid();
    this.buildSprites();
    this.buildFoam();
    this.resize(true);
  }

  // ------------------------------------------------------------ resources
  buildShadow() {
    const gl = this.gl;
    this.shadowTex = texture2D(gl, {
      width: SHADOW_SIZE, height: SHADOW_SIZE,
      internalFormat: gl.R16F, format: gl.RED, type: gl.HALF_FLOAT,
      filter: gl.LINEAR, wrap: gl.CLAMP_TO_EDGE,
    });
    this.shadowDepth = depthBuffer(gl, SHADOW_SIZE, SHADOW_SIZE);
    this.shadowFbo = framebuffer(gl, [this.shadowTex], { depth: this.shadowDepth });
  }

  buildWaterGrid() {
    const gl = this.gl;
    const R = 132, A = 168;
    const verts = new Float32Array((R + 1) * A * 2);
    let o = 0;
    for (let i = 0; i <= R; i++) {
      for (let j = 0; j < A; j++) { verts[o++] = i / R; verts[o++] = j / A; }
    }
    const idx = new Uint32Array(R * A * 6);
    let k = 0;
    for (let i = 0; i < R; i++) {
      for (let j = 0; j < A; j++) {
        const j1 = (j + 1) % A;
        const a = i * A + j, b = i * A + j1, c = (i + 1) * A + j, d = (i + 1) * A + j1;
        idx[k++] = a; idx[k++] = c; idx[k++] = b;
        idx[k++] = b; idx[k++] = c; idx[k++] = d;
      }
    }
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    this.water = { vao, count: idx.length };
  }

  buildSprites() {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const corners = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, corners);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const inst = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, inst);
    gl.bufferData(gl.ARRAY_BUFFER, 8 * 4 * 4096, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 32, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 32, 16);
    gl.vertexAttribDivisor(2, 1);
    gl.bindVertexArray(null);
    this.sprites = { vao, inst, data: new Float32Array(8 * 4096), n: 0 };
  }

  buildFoam() {
    const gl = this.gl;
    const mk = () => texture2D(gl, {
      width: FOAM_SIZE, height: FOAM_SIZE,
      internalFormat: gl.R16F, format: gl.RED, type: gl.HALF_FLOAT,
      filter: gl.LINEAR, wrap: gl.CLAMP_TO_EDGE,
    });
    this.foamTex = [mk(), mk()];
    this.foamFbo = [framebuffer(gl, [this.foamTex[0]]), framebuffer(gl, [this.foamTex[1]])];
    this.foamIdx = 0;
    this.foamCenter = [0, 0];
    this.foamPrevCenter = [0, 0];

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const corners = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, corners);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const inst = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, inst);
    gl.bufferData(gl.ARRAY_BUFFER, 4 * 4 * 2048, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 16, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.bindVertexArray(null);
    this.foamStamps = { vao, inst, data: new Float32Array(4 * 2048), n: 0 };

    // clear both
    for (let i = 0; i < 2; i++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.foamFbo[i]);
      gl.viewport(0, 0, FOAM_SIZE, FOAM_SIZE);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  resize(force = false) {
    const gl = this.gl, canvas = this.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(2, Math.round(canvas.clientWidth * dpr * this.quality));
    const h = Math.max(2, Math.round(canvas.clientHeight * dpr * this.quality));
    if (!force && w === this.W && h === this.H) return;
    this.W = w; this.H = h;
    canvas.width = w; canvas.height = h;

    const kill = (t) => { if (t) gl.deleteTexture(t.tex); };
    kill(this.hdr); kill(this.refract); kill(this.bloomA); kill(this.bloomB);
    if (this.hdrFbo) {
      gl.deleteFramebuffer(this.hdrFbo); gl.deleteFramebuffer(this.refractFbo);
      gl.deleteFramebuffer(this.bloomAFbo); gl.deleteFramebuffer(this.bloomBFbo);
      gl.deleteRenderbuffer(this.hdrDepth); gl.deleteRenderbuffer(this.refractDepth);
    }

    const hdrOpts = {
      internalFormat: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT,
      filter: gl.LINEAR, wrap: gl.CLAMP_TO_EDGE,
    };
    this.hdr = texture2D(gl, { width: w, height: h, ...hdrOpts });
    this.hdrDepth = depthBuffer(gl, w, h);
    this.hdrFbo = framebuffer(gl, [this.hdr], { depth: this.hdrDepth });

    const rw = Math.max(2, Math.round(w * 0.62)), rh = Math.max(2, Math.round(h * 0.62));
    this.RW = rw; this.RH = rh;
    this.refract = texture2D(gl, { width: rw, height: rh, ...hdrOpts });
    this.refractDepth = depthBuffer(gl, rw, rh);
    this.refractFbo = framebuffer(gl, [this.refract], { depth: this.refractDepth });

    const bw = Math.max(2, w >> 2), bh = Math.max(2, h >> 2);
    this.BW = bw; this.BH = bh;
    this.bloomA = texture2D(gl, { width: bw, height: bh, ...hdrOpts });
    this.bloomB = texture2D(gl, { width: bw, height: bh, ...hdrOpts });
    this.bloomAFbo = framebuffer(gl, [this.bloomA]);
    this.bloomBFbo = framebuffer(gl, [this.bloomB]);
  }

  // ------------------------------------------------------------ per-frame api
  begin(dt, time) {
    this.time = time;
    this.dt = dt;
    this.meshes = [];
    this.sprites.n = 0;
    this.foamStamps.n = 0;
  }

  // flags: above (drawn in the main pass), below (drawn into refraction),
  // shadow (casts). Most props are above+shadow; the bed is below only.
  add(mesh, model, { above = true, below = false, shadow = true } = {}) {
    if (!mesh || !mesh.count) return;
    this.meshes.push({ mesh, model, above, below, shadow });
  }

  sprite(x, y, z, size, r, g, b, a) {
    const s = this.sprites;
    if (s.n >= 4096) return;
    const o = s.n * 8;
    s.data[o] = x; s.data[o + 1] = y; s.data[o + 2] = z; s.data[o + 3] = size;
    s.data[o + 4] = r; s.data[o + 5] = g; s.data[o + 6] = b; s.data[o + 7] = a;
    s.n++;
  }

  // world-space foam blob: radius in metres, strength 0..1
  foam(x, z, radius, strength) {
    const f = this.foamStamps;
    if (f.n >= 2048) return;
    const o = f.n * 4;
    f.data[o] = (x - this.foamCenter[0]) / FOAM_EXTENT + 0.5;
    f.data[o + 1] = (z - this.foamCenter[1]) / FOAM_EXTENT + 0.5;
    f.data[o + 2] = radius / FOAM_EXTENT;
    f.data[o + 3] = strength;
    f.n++;
  }

  setCamera(eye, target, up, fovDeg, aspect) {
    this.camPos.set(eye);
    perspective(fovDeg * Math.PI / 180, aspect, 0.12, 4200, this.proj);
    lookAt(eye, target, up, this.view);
    mul(this.proj, this.view, this.viewProj);
    invert(this.viewProj, this.invViewProj);
  }

  // ------------------------------------------------------------ passes
  drawMeshes(prog, filter, extra = {}) {
    const gl = this.gl;
    for (const it of this.meshes) {
      if (!filter(it)) continue;
      setUniforms(gl, prog, { u_model: it.model, u_normalMat: normalMat3(it.model), ...extra });
      gl.bindVertexArray(it.mesh.vao);
      gl.drawArrays(gl.TRIANGLES, 0, it.mesh.count);
    }
    gl.bindVertexArray(null);
  }

  shadowPass(focus) {
    const gl = this.gl;
    const ext = 78, near = 1, far = 420;
    const eye = vAdd(focus, vScale(this.sunDir, 220));
    const lv = lookAt(eye, focus, v3(0, 1, 0));
    const lp = ortho(-ext, ext, -ext, ext, near, far);
    mul(lp, lv, this.lightViewProj);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFbo);
    gl.viewport(0, 0, SHADOW_SIZE, SHADOW_SIZE);
    gl.clearColor(1, 1, 1, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.FRONT);
    gl.useProgram(this.pShadow);
    setUniforms(gl, this.pShadow, { u_lightViewProj: this.lightViewProj });
    this.drawMeshes(this.pShadow, (it) => it.shadow);
    gl.cullFace(gl.BACK);
  }

  solidUniforms() {
    return {
      u_viewProj: this.viewProj,
      u_camPos: this.camPos,
      u_sunDir: this.sunDir,
      u_sunColor: this.sunColor,
      u_lightViewProj: this.lightViewProj,
      u_shadowMap: this.shadowTex,
      u_shadowTexel: 1 / SHADOW_SIZE,
      u_time: this.time,
      u_waterY: this.waterY,
      u_fogDensity: this.fogDensity,
    };
  }

  refractionPass() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.refractFbo);
    gl.viewport(0, 0, this.RW, this.RH);
    // Deep-water fill with a far - but finite - view distance: anywhere the
    // bed is missing reads as "very deep" and the sea shader paints it its
    // deepest blue. It must stay inside half-float range; 1e6 stores as Inf,
    // and a linear tap that mixes Inf with a zero weight yields NaN.
    gl.clearColor(0.012, 0.16, 0.30, FAR_DIST);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.disable(gl.BLEND);
    gl.useProgram(this.pSolid);
    setUniforms(gl, this.pSolid, { ...this.solidUniforms(), u_clipBelow: 1, u_shadowStrength: 0.35 });
    this.drawMeshes(this.pSolid, (it) => it.below);
  }

  foamPass() {
    const gl = this.gl;
    const src = this.foamIdx, dst = 1 - this.foamIdx;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.foamFbo[dst]);
    gl.viewport(0, 0, FOAM_SIZE, FOAM_SIZE);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.useProgram(this.pFoamFade);
    const shift = [
      (this.foamCenter[0] - this.foamPrevCenter[0]) / FOAM_EXTENT,
      (this.foamCenter[1] - this.foamPrevCenter[1]) / FOAM_EXTENT,
    ];
    setUniforms(gl, this.pFoamFade, {
      u_src: this.foamTex[src],
      u_decay: Math.exp(-this.dt * 0.62),
      u_shift: new Float32Array(shift),
    });
    this.blit.draw();

    if (this.foamStamps.n) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.useProgram(this.pFoamStamp);
      gl.bindVertexArray(this.foamStamps.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.foamStamps.inst);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.foamStamps.data, 0, this.foamStamps.n * 4);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.foamStamps.n);
      gl.bindVertexArray(null);
      gl.disable(gl.BLEND);
    }
    this.foamIdx = dst;
  }

  mainPass() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.hdrFbo);
    gl.viewport(0, 0, this.W, this.H);
    gl.clearColor(0, 0, 0, FAR_DIST);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.BLEND);
    gl.useProgram(this.pSky);
    setUniforms(gl, this.pSky, {
      u_invViewProj: this.invViewProj, u_camPos: this.camPos,
      u_sunDir: this.sunDir, u_time: this.time,
    });
    this.blit.draw();

    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.depthFunc(gl.LESS);
    gl.useProgram(this.pSolid);
    setUniforms(gl, this.pSolid, { ...this.solidUniforms(), u_clipBelow: 0, u_shadowStrength: 1 });
    this.drawMeshes(this.pSolid, (it) => it.above);

    // Sea last, so it composites over the submerged parts already in the
    // buffer. Two-sided: the radial grid winds the "wrong" way by construction
    // and you can legitimately end up looking at it from underneath.
    gl.disable(gl.CULL_FACE);
    gl.useProgram(this.pWater);
    setUniforms(gl, this.pWater, {
      u_viewProj: this.viewProj, u_camPos: this.camPos, u_sunDir: this.sunDir,
      u_sunColor: this.sunColor, u_time: this.time, u_waterY: this.waterY,
      u_chop: 1.0, u_texel: new Float32Array([1 / this.W, 1 / this.H]),
      u_refract: this.refract, u_foam: this.foamTex[this.foamIdx],
      u_foamRect: new Float32Array([
        this.foamCenter[0] - FOAM_EXTENT / 2, this.foamCenter[1] - FOAM_EXTENT / 2,
        FOAM_EXTENT, FOAM_EXTENT,
      ]),
      u_fogDensity: this.fogDensity,
      u_shadowMap: this.shadowTex,
      u_lightViewProj: this.lightViewProj,
      u_shadowTexel: 1 / SHADOW_SIZE,
    });
    gl.bindVertexArray(this.water.vao);
    gl.drawElements(gl.TRIANGLES, this.water.count, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
    gl.enable(gl.CULL_FACE);

    if (this.sprites.n) {
      const v = this.view;
      const right = v3(v[0], v[4], v[8]), up = v3(v[1], v[5], v[9]);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      gl.useProgram(this.pSprite);
      setUniforms(gl, this.pSprite, { u_viewProj: this.viewProj, u_right: right, u_up: up });
      gl.bindVertexArray(this.sprites.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.sprites.inst);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.sprites.data, 0, this.sprites.n * 8);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.sprites.n);
      gl.bindVertexArray(null);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }
  }

  presentPass() {
    const gl = this.gl;
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomAFbo);
    gl.viewport(0, 0, this.BW, this.BH);
    gl.useProgram(this.pBright);
    setUniforms(gl, this.pBright, { u_src: this.hdr, u_threshold: 1.45 });
    this.blit.draw();

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomBFbo);
    gl.useProgram(this.pBlur);
    setUniforms(gl, this.pBlur, { u_src: this.bloomA, u_dir: new Float32Array([1 / this.BW, 0]) });
    this.blit.draw();

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomAFbo);
    setUniforms(gl, this.pBlur, { u_src: this.bloomB, u_dir: new Float32Array([0, 1 / this.BH]) });
    this.blit.draw();

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.W, this.H);
    gl.useProgram(this.pPost);
    setUniforms(gl, this.pPost, {
      u_src: this.hdr, u_bloom: this.bloomA,
      u_exposure: 0.88, u_bloomAmount: 0.32, u_vignette: 0.38,
    });
    this.blit.draw();
    gl.depthMask(true);
  }

  render(focus) {
    const gl = this.gl;
    gl.enable(gl.CULL_FACE);
    this.shadowPass(focus);
    this.foamPass();
    this.refractionPass();
    this.mainPass();
    this.presentPass();
  }

  // The foam field follows the boat; snapping to whole texels stops the world
  // sliding under the wake when it moves.
  setFoamCenter(x, z) {
    const step = FOAM_EXTENT / FOAM_SIZE;
    this.foamPrevCenter = this.foamCenter;
    this.foamCenter = [Math.round(x / step) * step, Math.round(z / step) * step];
  }
}
