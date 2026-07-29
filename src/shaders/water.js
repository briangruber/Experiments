// Ocean surface: displaced radial grid + physically-motivated water BRDF.

import { NOISE_GLSL, ATMOSPHERE_GLSL, SKY_LUT_MAP_GLSL } from './sky.js';

const CASCADE_COMMON = /* glsl */`
uniform sampler2DArray uDisp, uSlope, uFoam;
uniform float uPatch[4];
uniform float uFade[4];
uniform int   uCascadeCount;
uniform float uDetailScale;

float cascadeWeight(int c, float dist){
  float f = uFade[c] * uDetailScale;
  return 1.0 - smoothstep(f*0.5, f, dist);
}
`;

export const WATER_VS = /* glsl */`
${CASCADE_COMMON}
layout(location=0) in vec2 aRT;      // x: radial parameter 0..1, y: angle 0..1

uniform mat4  uViewProj;
uniform vec3  uCamPos;
uniform vec2  uGridCenter;
uniform float uRMin, uRMax;
uniform float uHeightScale, uHorizScale;
uniform float uEarthCurve;
uniform float uSeaLevel;

out vec3  vWorld;
out vec3  vFlat;
out float vDist;
out float vHeight;

const float R_EARTH = 6371000.0;

void main(){
  float r = uRMin * pow(uRMax/uRMin, aRT.x);
  float a = aRT.y * 6.28318530718;
  vec2 xz = uGridCenter + vec2(cos(a), sin(a)) * r;

  vec3 pos = vec3(xz.x, uSeaLevel, xz.y);
  vFlat = pos;

  float h = 0.0;
  vec3 disp = vec3(0.0);
  for (int c=0;c<4;c++){
    if (c >= uCascadeCount) break;
    float w = cascadeWeight(c, r);
    if (w <= 0.001) continue;
    vec4 d = texture(uDisp, vec3(xz / uPatch[c], float(c)));
    disp += vec3(d.x*uHorizScale, d.y*uHeightScale, d.z*uHorizScale) * w;
  }
  pos += disp;
  h = disp.y;

  // Planet curvature drops the far surface away, which is what actually puts
  // the horizon at the right place and hides the end of the grid.
  pos.y -= uEarthCurve * (r*r) / (2.0 * R_EARTH);

  vWorld  = pos;
  vDist   = r;
  vHeight = h;
  gl_Position = uViewProj * vec4(pos, 1.0);
}
`;

export const WATER_FS = /* glsl */`
${CASCADE_COMMON}
${NOISE_GLSL}
${ATMOSPHERE_GLSL}
${SKY_LUT_MAP_GLSL}

in vec3  vWorld;
in vec3  vFlat;
in float vDist;
in float vHeight;

uniform sampler2D uSkyLUT;
uniform vec3  uCamPos, uSunDir, uMoonDir;
uniform vec3  uSunColor, uMoonColor;
uniform float uTime;
uniform float uHeightScale;

uniform vec3  uScatterColor;      // volumetric scattering albedo
uniform vec3  uAbsorption;        // 1/m per channel
uniform float uScatterAmount;
uniform float uSSSStrength, uSSSPower, uSSSHeight;
uniform float uBaseRoughness, uRoughnessGain;
uniform float uFoamAmount, uFoamRoughness, uFoamTint, uFoamDetail, uFoamLift;
uniform vec3  uFoamColor;
uniform float uSunAngularRadius, uSpecIntensity;
uniform float uSkyAmbient;
uniform float uGlitter;
uniform float uWaterIOR;
uniform float uAerial;
uniform vec2  uWindDirV;
uniform float uSpecClamp;
uniform float uHorizonBend;

out vec4 fragColor;

vec3 sampleSky(vec3 rd, float rough){
  vec2 uv = dirToSkyUv(rd);
  // Roughness picks a blur level; the LUT mip chain is the prefiltered probe.
  float lod = clamp(rough * 6.0, 0.0, 6.0);
  return textureLod(uSkyLUT, uv, lod).rgb;
}

float D_GGX(float NoH, float a){
  float a2 = a*a;
  float d = (NoH*a2 - NoH)*NoH + 1.0;
  return a2 / max(3.14159265*d*d, 1e-8);
}
float V_SmithGGX(float NoV, float NoL, float a){
  float a2 = a*a;
  float gv = NoL * sqrt(NoV*NoV*(1.0-a2)+a2);
  float gl = NoV * sqrt(NoL*NoL*(1.0-a2)+a2);
  return 0.5 / max(gv+gl, 1e-6);
}
vec3 fresnelSchlick(float u, vec3 f0, float rough){
  float f = pow(1.0-u, 5.0);
  return f0 + (max(vec3(1.0-rough), f0) - f0) * f;
}

// Cheap bubble field used to break up foam into believable clumps and streaks.
float foamDetail(vec2 p, float t){
  vec2 drift = uWindDirV * t * 0.35;
  float a = fbm3(vec3((p + drift)*0.55, t*0.06), 4);
  float b = billow(vec3((p - drift*0.4)*2.7, t*0.15), 3);
  float c = fbm3(vec3(p*9.0 + drift*2.0, t*0.4), 3);
  return clamp(a*0.55 + b*0.3 + c*0.25, 0.0, 1.5);
}

void main(){
  vec3 V = normalize(uCamPos - vWorld);
  float dist = vDist;

  // ---- surface normal + microfacet statistics from the cascades -------------
  vec2  slope = vec2(0.0);
  float msq   = 0.0;     // mean square slope inside the pixel footprint
  float lost  = 0.0;     // variance removed by cascade fade-out
  float foam  = 0.0;
  float fold  = 0.0;

  for (int c=0;c<4;c++){
    if (c >= uCascadeCount) break;
    float w = cascadeWeight(c, dist);
    vec3 uvc = vec3(vFlat.xz / uPatch[c], float(c));
    vec4 sl = texture(uSlope, uvc);
    vec4 fo = texture(uFoam, uvc);
    slope += sl.xy * w;
    msq   += sl.w * w * w;
    // What the fade threw away still roughens the surface statistically.
    float full = textureLod(uSlope, uvc, 8.0).w;
    lost += max(full * (1.0 - w*w), 0.0);
    foam += fo.x * w;
    fold += fo.y * w;
  }

  vec3 N = normalize(vec3(-slope.x, 1.0, -slope.y));
  float var = max(msq - dot(slope, slope), 0.0) + lost;

  float NoV = clamp(dot(N, V), 1e-4, 1.0);

  // Slope variance -> GGX alpha (LEADR-style filtering). This is what keeps the
  // distance falloff and the sun glitter path physically coherent.
  float alpha = clamp(uBaseRoughness*uBaseRoughness + 2.0*var*uRoughnessGain, 1e-4, 1.0);
  float rough = sqrt(alpha);

  // ---- foam ---------------------------------------------------------------
  float fd = foamDetail(vFlat.xz, uTime);
  float foamMask = clamp(foam * uFoamAmount, 0.0, 1.0);
  foamMask = smoothstep(0.0, 1.0, foamMask * (0.45 + 0.85*fd));
  foamMask = clamp(foamMask * mix(1.0, 1.0 - smoothstep(2000.0, 12000.0, dist)*0.45, 1.0), 0.0, 1.0);

  // Bubble relief perturbs the normal only where foam actually is.
  if (foamMask > 0.003){
    vec2 e = vec2(0.06, 0.0);
    float f0 = foamDetail(vFlat.xz, uTime);
    float fx = foamDetail(vFlat.xz + e.xy, uTime);
    float fz = foamDetail(vFlat.xz + e.yx, uTime);
    vec3 fn = normalize(vec3(-(fx-f0)/e.x, 1.0, -(fz-f0)/e.x) * vec3(uFoamDetail, 1.0, uFoamDetail));
    N = normalize(mix(N, normalize(N + fn - vec3(0.0,1.0,0.0)), foamMask*0.85));
    NoV = clamp(dot(N, V), 1e-4, 1.0);
  }

  // ---- lights --------------------------------------------------------------
  vec3 sunTr = sunTransmittance(vec3(0.0, R_PLANET + max(uCamPos.y, 1.0), 0.0), uSunDir);
  vec3 sunRad = uSunColor * sunTr * uAtmoExposure;
  float sunUp = smoothstep(-0.09, 0.02, uSunDir.y);
  sunRad *= sunUp;

  vec3 L = uSunDir;
  float NoL = max(dot(N, L), 0.0);

  // The top of the LUT's mip chain is the average sky radiance; multiplying by
  // pi turns it into the diffuse irradiance arriving at the surface.
  vec3 skyAvg = textureLod(uSkyLUT, vec2(0.5, 0.78), 9.0).rgb;
  vec3 skyIrr = skyAvg * 3.14159265 * uSkyAmbient;

  // ---- reflection ----------------------------------------------------------
  vec3 R = reflect(-V, N);
  // Wave troughs push the reflection vector under the horizon; bend it back so
  // we never sample the (meaningless) lower hemisphere of the sky probe.
  if (R.y < 0.0) R = normalize(mix(R, vec3(R.x, -R.y, R.z), uHorizonBend));
  R.y = max(R.y, 0.0005);
  vec3 skyRefl = sampleSky(R, rough);

  vec3 F0 = vec3(pow((1.0-uWaterIOR)/(1.0+uWaterIOR), 2.0));
  vec3 F = fresnelSchlick(NoV, F0, rough);
  // Foam is a bright rough dielectric: kill the mirror term over it.
  F = mix(F, vec3(0.03), foamMask);

  // ---- sun specular (treated as a disc light) -------------------------------
  float aSun = clamp(alpha + uSunAngularRadius*0.5, 1e-4, 1.0);
  float energy = (alpha/aSun)*(alpha/aSun);
  vec3 H = normalize(L + V);
  float NoH = max(dot(N,H), 0.0);
  float spec = D_GGX(NoH, aSun) * V_SmithGGX(NoV, NoL, aSun) * energy;
  spec = min(spec, uSpecClamp);
  vec3 sunSpec = sunRad * spec * NoL * uSpecIntensity * mix(1.0, 0.35, foamMask);

  // Micro-glitter: sparkle from sub-pixel facets the mips have averaged away.
  float glit = 0.0;
  if (uGlitter > 0.0){
    float g = fbm3(vec3(vFlat.xz*3.2, uTime*0.9), 3);
    g = pow(clamp(g*1.7-0.55, 0.0, 1.0), 4.0);
    glit = g * uGlitter * smoothstep(0.02, 0.4, var) * pow(max(dot(reflect(-V,N), L),0.0), 24.0);
  }

  // Moon acts as a dim second sun so night presets keep a specular path.
  vec3 moonSpec = vec3(0.0);
  {
    vec3 Hm = normalize(uMoonDir + V);
    float NoHm = max(dot(N,Hm), 0.0);
    float NoLm = max(dot(N,uMoonDir), 0.0);
    float sm = D_GGX(NoHm, aSun) * V_SmithGGX(NoV, NoLm, aSun) * energy;
    moonSpec = uMoonColor * min(sm, uSpecClamp) * NoLm * smoothstep(-0.05,0.1,uMoonDir.y);
  }

  // ---- subsurface / body colour --------------------------------------------
  // Downwelling irradiance on a horizontal surface: direct sun plus diffuse sky.
  vec3 Edown = sunRad * max(uSunDir.y, 0.0) + skyIrr;

  // Water-leaving radiance is a small fraction of what goes in - a couple of
  // percent - which is exactly why the sea reads as a mirror at grazing angles.
  float pathLen = mix(3.5, 0.6, NoV);
  vec3 absorbed = exp(-uAbsorption * pathLen);

  // Troughs see less of the sky than crests.
  float ao = mix(0.55, 1.0, clamp(vHeight/max(uHeightScale,0.001)*0.5 + 0.5, 0.0, 1.0));
  vec3 body = uScatterColor * Edown * (uScatterAmount / 3.14159265) * absorbed * ao;

  // Light that entered a wave face, scattered inside it and came out toward the
  // eye. Strongest on steep backlit crests - the classic translucent green.
  float heightTerm = clamp((vHeight/max(uHeightScale,0.001)) * uSSSHeight + 0.4, 0.0, 1.4);
  vec3 Hs = normalize(L + N * 0.55);
  float back = pow(clamp(dot(V, -Hs), 0.0, 1.0), uSSSPower);
  float steep = clamp(1.0 - N.y, 0.0, 1.0);
  vec3 sss = uScatterColor * sunRad * back * uSSSStrength * 0.02 * heightTerm * (0.35 + 1.35*steep);

  vec3 diffuse = body + sss;

  // ---- foam shading --------------------------------------------------------
  vec3 foamAlbedo = uFoamColor;
  float foamNoL = max(dot(N, L), 0.0);
  // Lambertian whitewater: albedo/pi times the irradiance reaching it.
  vec3 foamLit = foamAlbedo * (sunRad*foamNoL + skyIrr*ao) * (0.85/3.14159265);
  // Whitewater is a translucent bubble raft: it glows when backlit.
  foamLit += foamAlbedo * sunRad * pow(clamp(dot(V,-L),0.0,1.0), 3.0) * (0.30/3.14159265);
  float fr = uFoamRoughness;
  vec3 foamSpec = sunRad * D_GGX(NoH, fr*fr) * V_SmithGGX(NoV, foamNoL, fr*fr) * foamNoL * 0.25;
  foamLit += foamSpec;
  foamLit = mix(foamLit, foamLit * mix(vec3(1.0), uScatterColor*2.0, 0.35), uFoamTint);
  // Freshly folded crests get a lift so breaking waves read as bright.
  foamLit *= 1.0 + uFoamLift * clamp(fold, 0.0, 1.0);

  // ---- composite -----------------------------------------------------------
  vec3 col = diffuse * (1.0 - F) + (skyRefl * F * mix(1.0, 0.25, foamMask)) + sunSpec + moonSpec;
  col += sunRad * glit;
  col = mix(col, foamLit, foamMask);

  // ---- aerial perspective ---------------------------------------------------
  if (uAerial > 0.0){
    vec3 ins, tr;
    vec3 ro = vec3(0.0, R_PLANET + max(uCamPos.y, 1.0), 0.0);
    aerialPerspective(ro, normalize(vWorld - uCamPos), min(dist, 60000.0), uSunDir, ins, tr);
    col = col * mix(vec3(1.0), tr, uAerial) + ins * uAerial;
  }

  fragColor = vec4(col, 1.0);
}
`;
