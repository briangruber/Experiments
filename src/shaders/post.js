// HDR post chain: prefilter -> progressive bloom -> composite/tonemap -> FXAA.

export const PREFILTER_FS = /* glsl */`
in vec2 vUv;
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uThreshold, uKnee, uClamp;
out vec4 fragColor;

vec3 tap(vec2 uv){ return min(texture(uSrc, uv).rgb, vec3(uClamp)); }

void main(){
  // 13-tap Jimenez downsample avoids the fireflies a naive box filter keeps.
  vec2 t = uTexel;
  vec3 a = tap(vUv + t*vec2(-2,-2)), b = tap(vUv + t*vec2(0,-2)), c = tap(vUv + t*vec2(2,-2));
  vec3 d = tap(vUv + t*vec2(-2, 0)), e = tap(vUv),                 f = tap(vUv + t*vec2(2, 0));
  vec3 g = tap(vUv + t*vec2(-2, 2)), h = tap(vUv + t*vec2(0, 2)), i = tap(vUv + t*vec2(2, 2));
  vec3 j = tap(vUv + t*vec2(-1,-1)), k = tap(vUv + t*vec2(1,-1));
  vec3 l = tap(vUv + t*vec2(-1, 1)), m = tap(vUv + t*vec2(1, 1));
  vec3 col = (j+k+l+m)*0.5*0.25 + (a+c+g+i)*0.125*0.25 + (b+d+f+h)*0.25*0.25 + e*0.125;

  float lum = dot(col, vec3(0.2126,0.7152,0.0722));
  float soft = clamp(lum - uThreshold + uKnee, 0.0, 2.0*uKnee);
  soft = soft*soft / (4.0*uKnee + 1e-5);
  float w = max(soft, lum - uThreshold) / max(lum, 1e-5);
  fragColor = vec4(col * w, 1.0);
}
`;

export const DOWN_FS = /* glsl */`
in vec2 vUv;
uniform sampler2D uSrc;
uniform vec2 uTexel;
out vec4 fragColor;
void main(){
  vec2 t = uTexel;
  vec3 a = texture(uSrc, vUv + t*vec2(-2,-2)).rgb, b = texture(uSrc, vUv + t*vec2(0,-2)).rgb, c = texture(uSrc, vUv + t*vec2(2,-2)).rgb;
  vec3 d = texture(uSrc, vUv + t*vec2(-2, 0)).rgb, e = texture(uSrc, vUv).rgb,                 f = texture(uSrc, vUv + t*vec2(2, 0)).rgb;
  vec3 g = texture(uSrc, vUv + t*vec2(-2, 2)).rgb, h = texture(uSrc, vUv + t*vec2(0, 2)).rgb, i = texture(uSrc, vUv + t*vec2(2, 2)).rgb;
  vec3 j = texture(uSrc, vUv + t*vec2(-1,-1)).rgb, k = texture(uSrc, vUv + t*vec2(1,-1)).rgb;
  vec3 l = texture(uSrc, vUv + t*vec2(-1, 1)).rgb, m = texture(uSrc, vUv + t*vec2(1, 1)).rgb;
  fragColor = vec4((j+k+l+m)*0.5*0.25 + (a+c+g+i)*0.125*0.25 + (b+d+f+h)*0.25*0.25 + e*0.125, 1.0);
}
`;

export const UP_FS = /* glsl */`
in vec2 vUv;
uniform sampler2D uSrc, uPrev;
uniform vec2 uTexel;
uniform float uRadius, uAnamorphic;
out vec4 fragColor;
void main(){
  vec2 t = uTexel * uRadius * vec2(1.0 + uAnamorphic*3.0, 1.0);
  vec3 s =
    texture(uSrc, vUv + t*vec2(-1,-1)).rgb*1.0 + texture(uSrc, vUv + t*vec2(0,-1)).rgb*2.0 + texture(uSrc, vUv + t*vec2(1,-1)).rgb*1.0 +
    texture(uSrc, vUv + t*vec2(-1, 0)).rgb*2.0 + texture(uSrc, vUv                 ).rgb*4.0 + texture(uSrc, vUv + t*vec2(1, 0)).rgb*2.0 +
    texture(uSrc, vUv + t*vec2(-1, 1)).rgb*1.0 + texture(uSrc, vUv + t*vec2(0, 1)).rgb*2.0 + texture(uSrc, vUv + t*vec2(1, 1)).rgb*1.0;
  fragColor = vec4(texture(uPrev, vUv).rgb + s/16.0, 1.0);
}
`;

export const LUM_FS = /* glsl */`
in vec2 vUv;
uniform sampler2D uSrc;
out vec4 fragColor;
void main(){
  vec3 c = texture(uSrc, vUv).rgb;
  float l = dot(c, vec3(0.2126,0.7152,0.0722));
  fragColor = vec4(log(max(l, 1e-4)), 0.0, 0.0, 1.0);
}
`;

export const ADAPT_FS = /* glsl */`
uniform sampler2D uLum, uPrev;
uniform float uDt, uSpeed, uMinLog, uMaxLog;
out vec4 fragColor;
void main(){
  float cur = exp(clamp(textureLod(uLum, vec2(0.5), 20.0).r, uMinLog, uMaxLog));
  float prev = texelFetch(uPrev, ivec2(0), 0).r;
  if (prev <= 0.0) prev = cur;
  float t = 1.0 - exp(-uDt * uSpeed);
  fragColor = vec4(mix(prev, cur, t), 0.0, 0.0, 1.0);
}
`;

export const ACCUM_FS = /* glsl */`
in vec2 vUv;
uniform sampler2D uSrc, uHistory;
uniform float uBlend;
out vec4 fragColor;
void main(){
  vec3 c = texture(uSrc, vUv).rgb;
  vec3 h = texture(uHistory, vUv).rgb;
  fragColor = vec4(mix(h, c, uBlend), 1.0);
}
`;

export const COMPOSITE_FS = /* glsl */`
in vec2 vUv;
uniform sampler2D uSrc, uBloom, uAdapt;
uniform vec2 uRes;
uniform float uExposure, uAutoExposure, uExposureBias, uExposureTarget;
uniform float uBloomIntensity, uBloomTintAmount;
uniform vec3  uBloomTint;
uniform float uVignette, uVignetteRound;
uniform float uGrain, uTime;
uniform float uChromatic;
uniform float uContrast, uSaturation;
uniform vec3  uLift, uGammaCC, uGain;
uniform int   uTonemap;
uniform float uHighlightRoll;
uniform float uHalation;
out vec4 fragColor;

// ------------------------------------------------------------------ tonemaps
const mat3 AGX_IN = mat3(
  0.842479062253094, 0.0423282422610123, 0.0423756549057051,
  0.0784335999999992, 0.878468636469772,  0.0784336,
  0.0792237451477643, 0.0791661274605434, 0.879142973793104);
const mat3 AGX_OUT = mat3(
   1.19687900512017,  -0.0528968517574562, -0.0529716355144438,
  -0.0980208811401368, 1.15190312990417,   -0.0980434501171241,
  -0.0990297440797205,-0.0989611768448433,  1.15107367264116);

vec3 agxContrast(vec3 x){
  vec3 x2 = x*x, x4 = x2*x2;
  return 15.5*x4*x2 - 40.14*x4*x + 31.96*x4 - 6.868*x2*x + 0.4298*x2 + 0.1191*x - 0.00232;
}
vec3 agx(vec3 c){
  const float minEv = -12.47393, maxEv = 4.026069;
  c = AGX_IN * max(c, vec3(0.0));
  c = clamp(log2(max(c, 1e-10)), minEv, maxEv);
  c = (c - minEv)/(maxEv - minEv);
  c = agxContrast(c);
  // Gentle look: keep some saturation in the highlights.
  vec3 lw = vec3(0.2126,0.7152,0.0722);
  float l = dot(c, lw);
  c = l + (c - l) * (1.0 + 0.18*uHighlightRoll);
  return clamp(AGX_OUT * c, 0.0, 1.0);
}

const mat3 ACES_IN = mat3(0.59719,0.07600,0.02840, 0.35458,0.90834,0.13383, 0.04823,0.01566,0.83777);
const mat3 ACES_OUT = mat3(1.60475,-0.10208,-0.00327, -0.53108,1.10813,-0.07276, -0.07367,-0.00605,1.07602);
vec3 aces(vec3 c){
  c = ACES_IN * c;
  vec3 a = c*(c+0.0245786) - 0.000090537;
  vec3 b = c*(0.983729*c + 0.4329510) + 0.238081;
  return clamp(ACES_OUT * (a/b), 0.0, 1.0);
}
vec3 reinhardJodie(vec3 c){
  float l = dot(c, vec3(0.2126,0.7152,0.0722));
  vec3 tc = c/(c+1.0);
  return clamp(mix(c/(l+1.0), tc, tc), 0.0, 1.0);
}

float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*0.1031); p3 += dot(p3, p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }

void main(){
  vec2 uv = vUv;
  vec2 d = uv - 0.5;
  float r2 = dot(d,d);

  // Chromatic aberration grows toward the frame edge like a real lens.
  vec3 col;
  if (uChromatic > 0.0001){
    vec2 off = d * uChromatic * r2 * 0.006;
    col.r = texture(uSrc, uv + off).r;
    col.g = texture(uSrc, uv).g;
    col.b = texture(uSrc, uv - off).b;
  } else {
    col = texture(uSrc, uv).rgb;
  }

  vec3 bloom = texture(uBloom, uv).rgb;
  bloom = mix(bloom, bloom * uBloomTint, uBloomTintAmount);
  col += bloom * uBloomIntensity;
  // Halation: red-weighted glow bleeding out of the hottest highlights.
  col += bloom * vec3(1.0, 0.32, 0.12) * uHalation;

  float ev = uExposure;
  if (uAutoExposure > 0.0){
    float avg = max(texelFetch(uAdapt, ivec2(0), 0).r, 1e-5);
    float autoEv = uExposureTarget / avg;
    ev = mix(ev, ev * autoEv, uAutoExposure);
  }
  col *= ev * exp2(uExposureBias);

  // Colour grade in linear before the transform.
  col = col * uGain + uLift * (1.0 - col);
  col = pow(max(col, vec3(0.0)), 1.0/max(uGammaCC, vec3(0.05)));
  float l0 = dot(col, vec3(0.2126,0.7152,0.0722));
  col = mix(vec3(l0), col, uSaturation);
  col = max((col - 0.18)*uContrast + 0.18, vec3(0.0));

  if      (uTonemap == 0) col = agx(col);
  else if (uTonemap == 1) col = aces(col);
  else                    col = reinhardJodie(col);

  // Vignette (anamorphic-ish oval).
  float vr = mix(1.0, uRes.x/uRes.y, uVignetteRound);
  float vd = length(vec2(d.x*vr, d.y));
  col *= mix(1.0, smoothstep(0.95, 0.28, vd), uVignette);

  // Film grain, luminance weighted so shadows stay clean-ish.
  float g = hash12(gl_FragCoord.xy + fract(uTime)*941.0) - 0.5;
  float lum = dot(col, vec3(0.2126,0.7152,0.0722));
  col += g * uGrain * (0.35 + 0.65*sqrt(max(lum,0.0)));

  // Ordered dither to kill 8-bit banding in the sky gradient.
  float dth = hash12(gl_FragCoord.xy*1.7 + 13.0) - 0.5;
  col += dth / 255.0;

  fragColor = vec4(pow(clamp(col, 0.0, 1.0), vec3(1.0/2.2)), 1.0);
}
`;

export const FXAA_FS = /* glsl */`
in vec2 vUv;
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uAmount;
out vec4 fragColor;
float lum(vec3 c){ return dot(c, vec3(0.299,0.587,0.114)); }
void main(){
  vec3 rgbM = texture(uSrc, vUv).rgb;
  if (uAmount <= 0.0){ fragColor = vec4(rgbM,1.0); return; }
  vec3 rgbNW = texture(uSrc, vUv + uTexel*vec2(-1,-1)).rgb;
  vec3 rgbNE = texture(uSrc, vUv + uTexel*vec2( 1,-1)).rgb;
  vec3 rgbSW = texture(uSrc, vUv + uTexel*vec2(-1, 1)).rgb;
  vec3 rgbSE = texture(uSrc, vUv + uTexel*vec2( 1, 1)).rgb;
  float lNW=lum(rgbNW), lNE=lum(rgbNE), lSW=lum(rgbSW), lSE=lum(rgbSE), lM=lum(rgbM);
  float lMin = min(lM, min(min(lNW,lNE), min(lSW,lSE)));
  float lMax = max(lM, max(max(lNW,lNE), max(lSW,lSE)));
  vec2 dir = vec2(-((lNW+lNE)-(lSW+lSE)), ((lNW+lSW)-(lNE+lSE)));
  float reduce = max((lNW+lNE+lSW+lSE)*0.03125, 0.0078125);
  float rcpDir = 1.0/(min(abs(dir.x),abs(dir.y)) + reduce);
  dir = clamp(dir*rcpDir, -8.0, 8.0) * uTexel;
  vec3 rgbA = 0.5*(texture(uSrc, vUv + dir*(1.0/3.0-0.5)).rgb + texture(uSrc, vUv + dir*(2.0/3.0-0.5)).rgb);
  vec3 rgbB = rgbA*0.5 + 0.25*(texture(uSrc, vUv + dir*-0.5).rgb + texture(uSrc, vUv + dir*0.5).rgb);
  vec3 res = (lum(rgbB) < lMin || lum(rgbB) > lMax) ? rgbA : rgbB;
  fragColor = vec4(mix(rgbM, res, uAmount), 1.0);
}
`;
