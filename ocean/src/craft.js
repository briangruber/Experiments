// The wave runner: a real mesh, inlined.
//
// The GLB the user authored is 7.5 MB, almost all of it four 2048px JPEGs, and
// the artifact CSP forbids fetching anything at runtime - so the model has to
// live inside the page. tools/glb.mjs quantises the geometry (Int16 positions
// over a unit bounding box, Int8 normals, Uint16 UVs) and re-encodes the base
// colour map at 512px, which lands the whole craft at ~310 kB.

import { program, setUniforms } from './gl.js';
import { mat4 } from './math.js';
import { CRAFT_MESH } from './craftModel.js';
import { ATMOSPHERE_GLSL, SKY_LUT_MAP_GLSL } from './shaders/sky.js';

const unb64 = (s, T) => {
  const bin = atob(s);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new T(u8.buffer);
};

const CRAFT_VS = /* glsl */`
layout(location=0) in vec3 aPos;     // Int16, unit bbox * 32000
layout(location=1) in vec3 aNrm;     // Int8, normalised
layout(location=2) in vec2 aUv;
uniform mat4 uViewProj, uModel;
uniform float uMeshScale;
out vec3 vN, vW;
out vec2 vUv;
void main(){
  vec4 w = uModel * vec4(aPos * uMeshScale, 1.0);
  vW = w.xyz;
  vN = mat3(uModel) * aNrm;
  vUv = aUv;
  gl_Position = uViewProj * w;
}
`;

// The craft has to be lit by the same sun and the same sky as the sea it is
// sitting on, and it was not. It read raw uSunColor - the sun's irradiance at the
// top of the atmosphere, with no transmittance - so at the low sun most of these
// presets use it received several times too much light, in white rather than in
// the reddened light everything around it was getting, and it stayed lit after
// sunset. Its ambient came from mip 5 of the sky LUT looking straight up, which
// is a small bright patch of zenith rather than the hemispherical average the
// water integrates, multiplied by pi again on top. And it had no aerial
// perspective, so it sat in front of the haze instead of in it. The result was a
// glowing cyan object with its albedo detail blown out - which is what made the
// paint read as glass.
const CRAFT_FS = /* glsl */`
${ATMOSPHERE_GLSL}
${SKY_LUT_MAP_GLSL}
in vec3 vN, vW;
in vec2 vUv;
uniform sampler2D uSkyLUT, uBaseColor;
uniform vec3 uCamPos, uSunDir, uMoonDir, uSunColor, uMoonColor, uFallbackColor;
uniform float uGloss, uWetLine, uHasTex, uWetDarken;
uniform float uSkyAmbient, uSkyBlur, uSpecClamp, uAerial, uSunAngularRadius;
out vec4 fragColor;

const float PI = 3.14159265;

vec3 sampleSky(vec3 rd, float alpha){
  float lod = clamp(log2(1.0 + alpha * 81.0 * uSkyBlur), 0.0, 7.0);
  return textureLod(uSkyLUT, dirToSkyUv(rd), lod).rgb;
}

float D_GGX(float NoH, float a){
  float a2 = a*a;
  float d  = NoH*NoH*(a2 - 1.0) + 1.0;
  return a2 / max(PI * d * d, 1e-9);
}
float V_SmithGGX(float NoV, float NoL, float a){
  float a2 = a*a;
  float lv = NoL * sqrt(NoV*NoV*(1.0 - a2) + a2);
  float ll = NoV * sqrt(NoL*NoL*(1.0 - a2) + a2);
  return 0.5 / max(lv + ll, 1e-6);
}

// One direct light, evaluated the same way for the sun and the moon.
vec3 directLight(vec3 N, vec3 V, vec3 L, vec3 rad, vec3 albedo, float a, float f0){
  float NoL = max(dot(N, L), 0.0);
  if (NoL <= 0.0) return vec3(0.0);
  float NoV = clamp(dot(N, V), 1e-3, 1.0);
  vec3  H   = normalize(L + V);
  float VoH = clamp(dot(V, H), 0.0, 1.0);
  float F   = f0 + (1.0 - f0) * pow(1.0 - VoH, 5.0);
  // A polished hull cannot return more than the sun's own radiance, so the same
  // mirror ceiling the water uses bounds the highlight here too.
  float ceilv = max(min(uSpecClamp, 1.0/(PI*max(uSunAngularRadius,1e-4)*max(uSunAngularRadius,1e-4))), 1.0);
  float spec = min(D_GGX(clamp(dot(N,H),0.0,1.0), a) * V_SmithGGX(NoV, NoL, a), ceilv);
  return rad * NoL * (albedo * (1.0 - F) * (1.0/PI) + vec3(spec * F));
}

void main(){
  vec3 N = normalize(vN);
  vec3 V = normalize(uCamPos - vW);
  // A double-sided glTF material flips its normal on back faces - which is what
  // the rasteriser knows and the shading has to follow. The old rule flipped the
  // normal toward the eye instead, which lights every fragment as if it were
  // facing you: the far side of the shell, the inside of the footwells and the
  // underside of the deck all came out at full brightness, and that is the
  // faceted patchwork of white triangles.
  if (!gl_FrontFacing) N = -N;

  // The atlas is an sRGB image and was being uploaded as plain RGBA8 and read as
  // if it were linear, so every mid-tone came out about twice as bright as it was
  // painted and the livery lost most of its contrast. It is an SRGB8_ALPHA8
  // texture now, so the hardware decodes (and filters) it correctly.
  vec3 albedo = mix(uFallbackColor, texture(uBaseColor, vUv).rgb, uHasTex);
  // Everything below the waterline is permanently wet: darker and glossier.
  float wet = smoothstep(0.06, -0.06, vW.y - uWetLine);
  albedo *= mix(1.0, uWetDarken, wet);
  float rough = mix(mix(0.20, 0.48, 1.0 - uGloss), 0.10, wet);
  float a = max(rough*rough, 1e-3);
  float f0 = mix(0.04, 0.03, wet);

  // Exactly the sun the sea sees: attenuated through the atmosphere, exposed the
  // same way, and gone once it is below the horizon.
  vec3 sunRad = uSunColor
              * sunTransmittance(vec3(0.0, R_PLANET + max(uCamPos.y, 1.0), 0.0), uSunDir)
              * uAtmoExposure
              * smoothstep(-0.09, 0.02, uSunDir.y);

  // Hemispherical sky irradiance, from the top of the LUT's mip chain, which is
  // where the average sky radiance actually lives.
  vec3 skyIrr = textureLod(uSkyLUT, vec2(0.5, 0.78), 9.0).rgb * PI * uSkyAmbient;
  // An unoccluded surface sees (1 + N.y)/2 of the dome, so a deck is bright and
  // the underside of a sponson is not. Without this the whole hull takes the full
  // sky from every direction and flattens out.
  float domeVis = 0.5 + 0.5*N.y;
  // ...and the sea throws a little back up at whatever is facing down.
  vec3 bounce = textureLod(uSkyLUT, dirToSkyUv(vec3(0.0,-1.0,0.0)), 6.0).rgb * PI * 0.25;

  vec3 col = albedo * (skyIrr*domeVis + bounce*(1.0 - domeVis)) * (1.0/PI);
  col += directLight(N, V, uSunDir, sunRad, albedo, a, f0);
  col += directLight(N, V, uMoonDir, uMoonColor * smoothstep(-0.05, 0.10, uMoonDir.y),
                     albedo, a, f0);

  // Specular reflection of the sky, at the mip that matches the lobe width.
  float NoV = clamp(dot(N, V), 1e-3, 1.0);
  float Fenv = f0 + (1.0 - f0) * pow(1.0 - NoV, 5.0);
  col += sampleSky(reflect(-V, N), a) * Fenv * domeVis;

  // And it sits in the air like everything else does.
  if (uAerial > 0.0){
    vec3 ins, tr;
    vec3 ro = vec3(0.0, R_PLANET + max(uCamPos.y, 1.0), 0.0);
    float d = length(vW - uCamPos);
    aerialPerspective(ro, normalize(vW - uCamPos), min(d, 60000.0), uSunDir, ins, tr);
    col = col * mix(vec3(1.0), tr, uAerial) + ins * uAerial;
  }

  fragColor = vec4(col, 1.0);
}
`;

export class Craft {
  constructor(gl) {
    this.gl = gl;
    this.model = mat4();
    this.prog = program(gl, CRAFT_VS, CRAFT_FS, 'craft');
    this.hasTex = 0;

    const pos = unb64(CRAFT_MESH.pos, Int16Array);
    const nrm = unb64(CRAFT_MESH.nrm, Int8Array);
    const uv = unb64(CRAFT_MESH.uv, Uint16Array);
    const idx = unb64(CRAFT_MESH.idx, Uint16Array);
    this.count = idx.length;

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const attr = (data, loc, size, type, norm) => {
      const b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, type, norm, 0, 0);
    };
    attr(pos, 0, 3, gl.SHORT, false);
    attr(nrm, 1, 3, gl.BYTE, true);
    attr(uv, 2, 2, gl.UNSIGNED_SHORT, true);
    const ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);

    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
                  new Uint8Array([120, 200, 190, 255]));
    this._loadTexture();
  }

  // createImageBitmap on a Blob decodes the JPEG without ever fetching a URL,
  // so it works under a CSP that forbids external and data: image sources.
  async _loadTexture() {
    const gl = this.gl;
    try {
      const bin = atob(CRAFT_MESH.baseColorJpeg);
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      // No flip. glTF puts the UV origin at the *top* left, which is where an
      // image's first row already is, so uploading it unflipped makes v index
      // rows from the top - exactly the convention the exporter wrote the UVs
      // in. Flipping it here as well was one flip too many: the mapping was
      // upside down, so triangles sampled unrelated islands of the atlas and the
      // livery came out as a patchwork of the right colours in the wrong places.
      // Measured on the mesh itself: mean colour difference across shared edges
      // halves, 26.4 to 13.5 of 255, when the flip is removed.
      const bmp = await createImageBitmap(new Blob([u8], { type: 'image/jpeg' }));
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      // SRGB8_ALPHA8, not RGBA8: the atlas is an sRGB image, and reading it as
      // linear radiance is what washed the livery out. The hardware decode also
      // means mip filtering happens in linear space, where it belongs.
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.generateMipmap(gl.TEXTURE_2D);
      if (gl.ext.aniso) {
        gl.texParameterf(gl.TEXTURE_2D, gl.ext.aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.maxAniso));
      }
      this.hasTex = 1;
      bmp.close?.();
    } catch (e) {
      console.warn('craft texture decode failed, falling back to flat colour', e);
    }
  }

  // Orthonormal basis straight into the matrix columns: local +X starboard,
  // +Y up, +Z aft, so the bow sits at -Z and world forward is -Z local.
  setTransform(pos, yaw, pitch, roll, scale, modelYaw = 0) {
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const cr = Math.cos(roll), sr = Math.sin(roll);
    const f = [cp * sy, sp, -cp * cy];
    const r = [cy, 0, sy];
    let u = [f[1] * r[2] - f[2] * r[1], f[2] * r[0] - f[0] * r[2], f[0] * r[1] - f[1] * r[0]];
    u = [-u[0], -u[1], -u[2]];
    const r2 = r.map((v, i) => v * cr + u[i] * sr);
    const u2 = u.map((v, i) => v * cr - r[i] * sr);
    // The model's own yaw correction has to be applied INSIDE the craft frame.
    // Folding it into the craft's heading instead also rotates the roll axis, so
    // a 180-degree correction silently swaps port and starboard and the hull
    // banks the wrong way out of every turn.
    const b = [-f[0], -f[1], -f[2]];
    const cf = Math.cos(modelYaw), sf = Math.sin(modelYaw);
    const rr = r2.map((v, i) => v * cf - b[i] * sf);
    const bb = r2.map((v, i) => v * sf + b[i] * cf);

    const m = this.model;
    m[0] = rr[0] * scale; m[1] = rr[1] * scale; m[2] = rr[2] * scale; m[3] = 0;
    m[4] = u2[0] * scale; m[5] = u2[1] * scale; m[6] = u2[2] * scale; m[7] = 0;
    m[8] = bb[0] * scale; m[9] = bb[1] * scale; m[10] = bb[2] * scale; m[11] = 0;
    m[12] = pos[0]; m[13] = pos[1]; m[14] = pos[2]; m[15] = 1;
  }

  draw(p, ctx, skyLut, atmo) {
    const gl = this.gl;
    gl.useProgram(this.prog);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    // The source material is double sided and the hull is a closed shell, so
    // culling would drop faces wherever the exporter wound them the other way.
    // The shader flips the normal on back faces, as a double-sided material does.
    gl.disable(gl.CULL_FACE);
    setUniforms(gl, this.prog, {
      ...atmo,
      uViewProj: ctx.viewProj, uModel: this.model,
      uSkyLUT: skyLut,
      uBaseColor: { __tex: true, tex: this.tex, target: gl.TEXTURE_2D },
      uCamPos: ctx.camPos, uSunDir: ctx.sunDir, uMoonDir: ctx.moonDir,
      uSunColor: p.sunIrradiance, uMoonColor: p.moonColor,
      uFallbackColor: p.craftHullColor,
      // Positions are Int16 over a bounding box whose longest axis is 1.
      uMeshScale: p.craftLength / 32000,
      uGloss: p.craftGloss, uWetLine: this.wetLine ?? 0,
      uWetDarken: p.craftWetDarken,
      uSkyAmbient: p.skyAmbient, uSkyBlur: p.skyBlur,
      uSpecClamp: p.specClamp, uAerial: p.aerial,
      uSunAngularRadius: p.sunAngularRadius,
      uHasTex: this.hasTex,
    });
    gl.bindVertexArray(this.vao);
    gl.drawElements(gl.TRIANGLES, this.count, gl.UNSIGNED_SHORT, 0);
    gl.bindVertexArray(null);
  }
}
