import { program, setUniforms, texture2D, framebuffer, FS_VERT } from './gl.js';
import { SPRAY_SIM_FS, SPRAY_VS, SPRAY_FS } from './shaders/spray.js';

export class Spray {
  constructor(gl, blit, { size = 256 } = {}) {
    this.gl = gl;
    this.blit = blit;
    this.size = size;
    this.count = size * size;
    this.frame = 0;

    const opts = {
      width: size, height: size,
      internalFormat: gl.RGBA32F, format: gl.RGBA, type: gl.FLOAT,
      filter: gl.NEAREST, wrap: gl.CLAMP_TO_EDGE,
      data: new Float32Array(size * size * 4),
    };
    this.pos = [texture2D(gl, opts), texture2D(gl, opts)];
    this.vel = [texture2D(gl, opts), texture2D(gl, opts)];
    this.fbo = [
      framebuffer(gl, [this.pos[0], this.vel[0]]),
      framebuffer(gl, [this.pos[1], this.vel[1]]),
    ];
    this.idx = 0;

    this.pSim = program(gl, FS_VERT, SPRAY_SIM_FS, 'spray.sim');
    this.pDraw = program(gl, SPRAY_VS, SPRAY_FS, 'spray.draw');

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1,
    ]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  update(dt, p, ctx, ocean) {
    const gl = this.gl;
    const next = 1 - this.idx;
    this.frame++;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[next]);
    gl.viewport(0, 0, this.size, this.size);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.useProgram(this.pSim);
    setUniforms(gl, this.pSim, {
      uPos: this.pos[this.idx], uVel: this.vel[this.idx],
      uDisp: ocean.disp, uFoam: ocean.foamTex,
      uPatch: ocean.patchSizes,
      uCascadeCount: new Int32Array([ocean.cascadeCount]),
      uCamPos: ctx.camPos, uWind: ctx.windVec3,
      uDt: Math.min(dt, 0.05), uTime: ctx.time, uFrame: this.frame,
      uSpawnRadius: p.sprayRadius, uSpawnRate: p.sprayRate,
      uFoldThreshold: p.sprayThreshold, uLifetime: p.sprayLifetime,
      uGravity: p.sprayGravity, uDrag: p.sprayDrag,
      uLaunchSpeed: p.sprayLaunch, uSizeMin: p.spraySizeMin, uSizeMax: p.spraySizeMax,
      uHeightScale: p.heightScale,
    });
    this.blit.draw();
    this.idx = next;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  draw(p, ctx, skyLut, atmo) {
    const gl = this.gl;
    if (p.sprayOpacity <= 0.001) return;
    gl.useProgram(this.pDraw);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    setUniforms(gl, this.pDraw, {
      ...atmo,
      uPos: this.pos[this.idx], uVel: this.vel[this.idx],
      uViewProj: ctx.viewProj,
      uCamRight: ctx.camRight, uCamUp: ctx.camUp, uCamPos: ctx.camPos,
      uTexSize: this.size, uLifetime: p.sprayLifetime,
      uSizeScale: p.spraySize, uStretch: p.sprayStretch,
      uSkyLUT: skyLut, uSunDir: ctx.sunDir, uSunColor: p.sunIrradiance,
      uOpacity: p.sprayOpacity, uScatter: p.sprayScatter,
    });
    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.count);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
    gl.depthMask(true);
  }
}
