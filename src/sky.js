import { program, setUniforms, texture2D, framebuffer, FS_VERT } from './gl.js';
import { SKY_LUT_FS, SKY_BG_FS } from './shaders/sky.js';

const LUT_W = 512, LUT_H = 256;
const D2R = Math.PI / 180;

function moonDirOf(p) {
  const el = p.moonElevation * D2R, az = p.moonAzimuth * D2R;
  return new Float32Array([Math.cos(el) * Math.sin(az), Math.sin(el), -Math.cos(el) * Math.cos(az)]);
}

export class Sky {
  constructor(gl, blit) {
    this.gl = gl;
    this.blit = blit;
    this.lut = texture2D(gl, {
      width: LUT_W, height: LUT_H,
      internalFormat: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT,
      filter: gl.LINEAR, wrap: gl.REPEAT, mips: true,
    });
    // Wrap horizontally (azimuth is periodic), clamp vertically.
    gl.bindTexture(gl.TEXTURE_2D, this.lut.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.fbo = framebuffer(gl, [this.lut]);
    this.pLut = program(gl, FS_VERT, SKY_LUT_FS, 'sky.lut');
    this.pBg = program(gl, FS_VERT, SKY_BG_FS, 'sky.bg');
  }

  // Uniform block shared by every shader that evaluates the atmosphere.
  atmosphereUniforms(p) {
    return {
      uTurbidity: p.turbidity,
      uOzone: p.ozone,
      uSunIrradiance: p.sunIrradiance,
      uMieG: p.mieG,
      uAtmoExposure: p.atmoExposure,
      uMultiScatter: p.skyMultiScatter,
      uMSFloor: p.skyMSFloor,
      uMSHeight: p.skyMSHeight,
    };
  }

  updateLUT(p, sunDir, eyeHeight) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, LUT_W, LUT_H);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.useProgram(this.pLut);
    setUniforms(gl, this.pLut, {
      ...this.atmosphereUniforms(p),
      uSunDir: sunDir,
      uEyeHeight: eyeHeight,
      // Moonlight scatters through the same atmosphere; baking it into the LUT
      // is what keeps a night sky blue-dark and gives the water something to
      // reflect after sunset.
      uMoonDir: moonDirOf(p),
      uMoonColor: p.moonColor,
    });
    this.blit.draw();
    gl.bindTexture(gl.TEXTURE_2D, this.lut.tex);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  drawBackground(p, ctx) {
    const gl = this.gl;
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.BLEND);
    gl.useProgram(this.pBg);
    setUniforms(gl, this.pBg, {
      ...this.atmosphereUniforms(p),
      uSkyLUT: this.lut,
      uInvViewProj: ctx.invViewProj,
      uCamPos: ctx.camPos,
      uSunDir: ctx.sunDir,
      uMoonDir: ctx.moonDir,
      uTime: ctx.time,
      uSunAngularRadius: p.sunAngularRadius,
      uSunDiscIntensity: p.sunDiscIntensity,
      uCloudCoverage: p.cloudCoverage,
      uCloudDensity: p.cloudDensity,
      uCloudAltitude: p.cloudAltitude,
      uCloudThickness: p.cloudThickness,
      uCloudSpeed: p.cloudSpeed,
      uCloudDetail: p.cloudDetail,
      uCirrus: p.cirrus,
      uStars: p.stars,
      uCloudSteps: p.cloudSteps,
      uCloudScale: p.cloudScale,
      uCloudShape: p.cloudShape,
      uCloudExtinction: p.cloudExtinction,
      uCloudAnvil: p.cloudAnvil,
      uCloudMS: p.cloudMultiScatter,
      uCloudPowder: p.cloudPowder,
      uCloudAmbient: p.cloudAmbient,
      uCloudSilver: p.cloudSilver,
      uCloudAmbFloor: p.cloudAmbientFloor,
      uCloudMaxDist: p.cloudDistance,
      uStarSize: p.starSize,
      // The knob reads as "how much of the field shows"; the shader wants the
      // hash cutoff, which runs the other way.
      uStarCutoff: 1.0 - 0.05 * p.starDensity,
      uStarColorTemp: p.starColorTemp,
      uSunLimb: p.sunLimbDarkening,
      uDiscFlatten: p.sunRefractFlatten,
      uDiscCap: p.sunDiscCap,
      uCloudHaze: p.cloudHaze,
      uCloudFade: p.cloudFade,
      uCirrusAlt: p.cirrusAltitude,
      uCirrusCurl: p.cirrusCurl,
      uCirrusMask: p.cirrusMask,
      uSkyDither: p.skyDither,
      uMoonColor: p.moonColor,
      uWindDirV: ctx.windVec3,
    });
    this.blit.draw();
    gl.depthMask(true);
  }
}
