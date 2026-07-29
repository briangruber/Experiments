import { program, setUniforms, texture2D, framebuffer, FS_VERT } from './gl.js';
import { SPRAY_SIM_FS, SPRAY_VS, SPRAY_FS, SPRAY_HAZE_FS } from './shaders/spray.js';

const smoothstep = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / Math.max(b - a, 1e-4)));
  return t * t * (3 - 2 * t);
};

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
    this.pHaze = program(gl, FS_VERT, SPRAY_HAZE_FS, 'spray.haze');

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

  // Class, lifetime and size are index-derived in the shaders, so the two
  // stages have to be handed exactly the same constants.
  particleUniforms(p) {
    return {
      uMistFrac: p.sprayMist, uLifetime: p.sprayLifetime, uMistLifetime: p.sprayMistLife,
      uSizeMin: p.spraySizeMin, uSizeMax: p.spraySizeMax, uMistSize: p.sprayMistSize,
      uSheetSize: p.spraySheet, uMistRadius: p.sprayMistRadius, uTexSize: this.size,
    };
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
      ...this.particleUniforms(p),
      uPos: this.pos[this.idx], uVel: this.vel[this.idx],
      uDisp: ocean.disp, uFoam: ocean.foamTex,
      uPatch: ocean.patchSizes,
      uCascadeCount: new Int32Array([ocean.cascadeCount]),
      uCamPos: ctx.camPos, uWind: ctx.windVec3,
      uDt: Math.min(dt, 0.05), uTime: ctx.time, uFrame: this.frame,
      uSpawnRadius: p.sprayRadius, uSpawnRate: p.sprayRate, uSpawnFocus: p.sprayFocus,
      uFoldThreshold: p.sprayThreshold, uFoldSoft: p.sprayFoldSoft,
      uFoamBias: p.sprayFoamBias,
      uWindMin: p.sprayWindMin, uWindFull: p.sprayWindFull, uMistWind: p.sprayMistWind,
      uSheetRate: p.spraySheetRate, uSheetSpread: p.spraySheetSpread, uShred: p.sprayShred,
      uGravity: p.sprayGravity, uDrag: p.sprayDrag,
      uMistDrag: p.sprayMistDrag, uMistFall: p.sprayMistFall, uMistRise: p.sprayMistRise,
      uLaunchSpeed: p.sprayLaunch, uLaunchUp: p.sprayLaunchUp, uLaunchWind: p.sprayLaunchWind,
      uTurbulence: p.sprayTurbulence, uShear: p.sprayShear,
      uHeightScale: p.heightScale, uSeaLevel: p.seaLevel,
      // Parked far below the sea with zero amount when nobody is riding, so the
      // emitter costs a branch and nothing else.
      uCraftPos: ctx.craftPos ?? new Float32Array([0, -1e4, 0]),
      uCraftFwd: ctx.craftFwd ?? new Float32Array([0, 1]),
      uCraftRight: ctx.craftRight ?? new Float32Array([1, 0]),
      uCraftSpeed: ctx.craftSpeed ?? 0,
      uCraftTurn: ctx.craftTurn ?? 0,
      uCraftAmount: ctx.craftAmount ?? 0,
      uCraftSpread: p.craftSpraySpread, uCraftUp: p.craftSprayUp,
      uCraftPlane: p.craftPlaneSpeed, uCraftPlaneFull: p.craftPlaneFull,
      uCraftLife: p.craftSprayLife, uCraftPulse: p.craftSprayPulse,
      uCraftLoad: ctx.craftLoad ?? 0, uCraftLoadFull: p.craftLoadFull,
      uCraftBeam: p.wrBeam, uCraftLen: p.wrLength,
      // What the rider is doing, which is what decides where the water goes.
      uCraftSteer: ctx.craftSteer ?? 0,
      uCraftThrottle: ctx.craftThrottle ?? 0,
      uCraftSlip: ctx.craftSlip ?? 0,
      uCraftAir: ctx.craftAir ?? 0,
      uCraftImpact: ctx.craftImpact ?? 0,
      uCraftJet: p.craftJet, uCraftJetSpeed: p.craftJetSpeed,
      uCraftJetAngle: p.craftJetAngle, uCraftJetRise: p.craftJetRise,
      uCraftSheet: p.craftSheet, uCraftSheetSpeed: p.craftSheetSpeed,
      uCraftCurtain: p.craftCurtain, uCraftCurtainSpeed: p.craftCurtainSpeed,
      uCraftBurst: p.craftBurst,
    });
    this.blit.draw();
    this.idx = next;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // Suspended mist layer. Drawn before the particles so droplets sit in front of
  // the haze they are feeding, and gated on wind so calm seas pay nothing.
  drawHaze(p, ctx, skyLut, atmo) {
    const gl = this.gl;
    const gate = smoothstep(p.sprayHazeWind, p.sprayHazeWind + 16.0, p.windSpeed);
    const density = p.sprayHaze * gate;
    if (density <= 1e-7) return;
    gl.useProgram(this.pHaze);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    setUniforms(gl, this.pHaze, {
      ...atmo,
      uSkyLUT: skyLut, uInvViewProj: ctx.invViewProj, uCamPos: ctx.camPos,
      uSunDir: ctx.sunDir, uSunColor: p.sunIrradiance, uWind: ctx.windVec3,
      uHazeDensity: density, uHazeHeight: p.sprayHazeHeight,
      uHazeScatter: p.sprayHazeScatter, uHazeAmbient: p.sprayHazeAmbient,
      uHazeG: p.sprayHazeG, uSeaLevel: p.seaLevel, uTime: ctx.time,
      uHazeSheets: p.sprayHazeSheets, uHazeSheetScale: 1.0 / Math.max(p.sprayHazeSheetSize, 1),
      uHazeSteps: new Int32Array([Math.round(p.sprayHazeSteps)]),
    });
    this.blit.draw();
    gl.disable(gl.BLEND);
  }

  draw(p, ctx, skyLut, atmo, ocean) {
    const gl = this.gl;
    this.drawHaze(p, ctx, skyLut, atmo);
    if (p.sprayOpacity <= 0.001 && p.sprayMistOpacity <= 0.001) return;
    gl.useProgram(this.pDraw);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    setUniforms(gl, this.pDraw, {
      ...atmo,
      ...this.particleUniforms(p),
      uPos: this.pos[this.idx], uVel: this.vel[this.idx],
      uDisp: ocean.disp, uFoam: ocean.foamTex, uPatch: ocean.patchSizes,
      uCascadeCount: new Int32Array([ocean.cascadeCount]),
      uViewProj: ctx.viewProj,
      uCamRight: ctx.camRight, uCamUp: ctx.camUp, uCamPos: ctx.camPos,
      uWind: ctx.windVec3,
      uSizeScale: p.spraySize, uStretch: p.sprayStretch, uMistStretch: p.sprayMistStretch,
      uMistGrow: p.sprayMistGrow,
      uFadeNear: p.sprayFadeNear, uFadeFar: p.sprayRadius * 1.6,
      uViewportH: gl.drawingBufferHeight, uMinPixels: p.sprayMinPixels,
      uFarSoft: p.sprayFarSoft,
      uSkyLUT: skyLut, uSunDir: ctx.sunDir, uSunColor: p.sunIrradiance,
      uOpacity: p.sprayOpacity, uMistOpacity: p.sprayMistOpacity,
      uScatter: p.sprayScatter, uAmbient: p.sprayAmbient, uMulti: p.sprayMulti,
      uForwardG: p.sprayForwardG, uBackG: p.sprayBackG,
      uGrain: p.sprayGrain, uMistGrain: p.sprayMistGrain,
      uHullOpacity: p.craftSprayOpacity, uHullMulti: p.craftSprayMulti,
      uGrainScale: p.sprayGrainScale, uGrainAniso: p.sprayGrainAniso,
      uSurfFade: p.spraySurfFade, uAerial: p.sprayAerial,
      uHeightScale: p.heightScale, uSeaLevel: p.seaLevel,
    });
    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.count);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
    gl.depthMask(true);
  }
}
