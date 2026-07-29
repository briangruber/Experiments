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

const CRAFT_FS = /* glsl */`
in vec3 vN, vW;
in vec2 vUv;
uniform sampler2D uSkyLUT, uBaseColor;
uniform vec3 uCamPos, uSunDir, uSunColor;
uniform float uGloss, uWetLine, uAtmoExp, uHasTex, uWetDarken;
out vec4 fragColor;

vec2 dirToSkyUv(vec3 d){
  float az = atan(d.z, d.x) / 6.28318530718 + 0.5;
  float l = clamp(d.y, -1.0, 1.0);
  return vec2(az, 0.5 + 0.5*sign(l)*sqrt(abs(l)));
}

void main(){
  vec3 N = normalize(vN);
  vec3 V = normalize(uCamPos - vW);
  // The mesh is authored double sided; flipping toward the eye keeps the
  // lighting sane on whichever side we happen to be looking at.
  if (dot(N, V) < 0.0) N = -N;
  vec3 L = uSunDir;

  vec3 albedo = mix(vec3(0.55, 0.06, 0.05), texture(uBaseColor, vUv).rgb, uHasTex);
  // Everything below the waterline is permanently wet: darker and glossier.
  float wet = smoothstep(0.06, -0.06, vW.y - uWetLine);
  albedo *= mix(1.0, uWetDarken, wet);
  float rough = mix(mix(0.16, 0.44, 1.0 - uGloss), 0.09, wet);

  vec3 sky = textureLod(uSkyLUT, dirToSkyUv(reflect(-V, N)), rough*6.0).rgb;
  vec3 amb = textureLod(uSkyLUT, dirToSkyUv(vec3(0.0,1.0,0.0)), 5.0).rgb * 3.14159;

  float NoL = max(dot(N, L), 0.0);
  float NoV = max(dot(N, V), 1e-3);
  vec3 H = normalize(L + V);
  float a = rough*rough;
  float dd = (dot(N,H)*a - dot(N,H))*dot(N,H) + 1.0;
  float D = a*a / max(3.14159*dd*dd, 1e-6);
  // Capped rim term: a full grazing sky reflection turns a curved hull into dark
  // glass with the sea showing through it.
  float F = 0.04 + 0.36*pow(1.0 - NoV, 5.0);

  vec3 col = albedo * (uSunColor*NoL + amb*0.85) * (1.0/3.14159);
  col += uSunColor * D * F * NoL * 0.35;
  col += sky * F * 0.6;
  fragColor = vec4(col * uAtmoExp, 1.0);
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
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
                  new Uint8Array([140, 16, 14, 255]));
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
      const bmp = await createImageBitmap(new Blob([u8], { type: 'image/jpeg' }), {
        imageOrientation: 'flipY',
      });
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
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

  draw(p, ctx, skyLut) {
    const gl = this.gl;
    gl.useProgram(this.prog);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    // The source material is double sided and the hull is a closed shell, so
    // culling would drop faces wherever the exporter wound them the other way.
    gl.disable(gl.CULL_FACE);
    setUniforms(gl, this.prog, {
      uViewProj: ctx.viewProj, uModel: this.model,
      uSkyLUT: skyLut,
      uBaseColor: { __tex: true, tex: this.tex, target: gl.TEXTURE_2D },
      uCamPos: ctx.camPos, uSunDir: ctx.sunDir, uSunColor: p.sunIrradiance,
      // Positions are Int16 over a bounding box whose longest axis is 1.
      uMeshScale: p.craftLength / 32000,
      uGloss: p.craftGloss, uWetLine: this.wetLine ?? 0,
      uWetDarken: p.craftWetDarken, uAtmoExp: p.atmoExposure,
      uHasTex: this.hasTex,
    });
    gl.bindVertexArray(this.vao);
    gl.drawElements(gl.TRIANGLES, this.count, gl.UNSIGNED_SHORT, 0);
    gl.bindVertexArray(null);
  }
}
