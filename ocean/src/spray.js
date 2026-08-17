import { program, setUniforms, texture2D, framebuffer, FS_VERT } from './gl.js';
import { SPRAY_SIM_FS, SPRAY_VS, SPRAY_FS, SPRAY_HAZE_FS } from './shaders/spray.js';
import { MAX_BREACH_EMITTERS } from './breach-emitters.js';
import { entryAmount } from './splash-field.js';

const smoothstep = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / Math.max(b - a, 1e-4)));
  return t * t * (3 - 2 * t);
};

const SITE_N = MAX_BREACH_EMITTERS;
const PARKED = [0, -1e4, 0];

function craftSiteUniforms(ctx) {
  const cp = ctx?.craftPos ?? PARKED;
  const handed = ctx?.craftSites;
  const n = Math.max(1, Math.min(SITE_N, Math.round(ctx?.craftSiteCount ?? (handed?.length || 1))));
  const sites = new Float32Array(SITE_N * 3);
  const sides = new Float32Array(SITE_N);
  for (let i = 0; i < SITE_N; i++) {
    const s = handed?.[i];
    if (s && i < n) {
      sites[i * 3] = s.x ?? s[0];
      sites[i * 3 + 1] = s.y ?? s[1];
      sites[i * 3 + 2] = s.z ?? s[2];
      sides[i] = s.side ?? 1;
    } else if (i === 0) {
      sites[0] = cp[0]; sites[1] = cp[1]; sites[2] = cp[2];
      sides[0] = 1;
    } else {
      sites[i * 3 + 1] = -1e4;
      sides[i] = 1;
    }
  }
  return {
    uCraftSites: sites,
    uCraftSiteSide: sides,
    uCraftSiteCount: n,
    uCraftPierce: ctx?.craftPierce ?? 0,
    uCraftSpout: ctx?.craftSpout ?? 0,
    uEntryRadius: ctx?.craftEntryRadius ?? 2.0,
  };
}

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
      ...craftSiteUniforms(ctx),
      uCraftSpeed: ctx.craftSpeed ?? 0,
      uCraftTurn: ctx.craftTurn ?? 0,
      uCraftAmount: ctx.craftAmount ?? 0,
      uCraftSpread: p.craftSpraySpread, uCraftUp: p.craftSprayUp,
      uCraftPlane: p.craftPlaneSpeed, uCraftPlaneFull: p.craftPlaneFull,
      uCraftLife: p.craftSprayLife * (ctx.entryLifeScale ?? 1), uCraftPulse: p.craftSprayPulse,
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
      // The fade has to END where spawning ends. At 1.6x the spawn radius its
      // window ran 134 m to 192 m while particles were only ever created out to
      // 120 m, so it never touched the boundary it existed to soften: spray drew
      // at full opacity right up to 120 m and then stopped. That is a hard step
      // in density on a disc centred on the camera, which is a full-width
      // horizontal line across the sea that travels with you.
      uFadeNear: p.sprayFadeNear, uFadeFar: p.sprayRadius,
      uViewportH: gl.drawingBufferHeight, uMinPixels: p.sprayMinPixels,
      uFarSoft: p.sprayFarSoft, uEntry: ctx?.entryDraw != null
        ? ctx.entryDraw
        : entryAmount(ctx) * (ctx.entrySizeScale ?? 1),
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
