// GPU ocean spectrum + IFFT passes.
//
// Pipeline per cascade, per frame:
//   h0 (static, rebuilt on parameter change)
//     -> timeEvolve  : 4 packed complex fields across 2 MRT targets
//     -> fft x 2logN : horizontal then vertical radix-2 butterflies
//     -> assemble    : displacement + slope + Jacobian
//     -> foam        : temporal accumulation of wave folding
//
// Field packing through the IFFT (two real signals ride one complex transform,
// which is valid because each transform output is real):
//   c0 = D_x  + i D_z          c1 = D_y      + i dD_y/dx
//   c2 = dD_y/dz + i dD_x/dx   c3 = dD_z/dz  + i dD_x/dz

export const COMMON = /* glsl */`
const float PI  = 3.14159265358979;
const float TAU = 6.28318530717959;
const float G   = 9.80665;

vec2 cmul(vec2 a, vec2 b){ return vec2(a.x*b.x - a.y*b.y, a.x*b.y + a.y*b.x); }
vec2 cconj(vec2 a){ return vec2(a.x, -a.y); }
vec2 cexp(float t){ return vec2(cos(t), sin(t)); }
float sqr(float x){ return x*x; }
`;

// ---------------------------------------------------------------- h0 spectrum

export const INIT_SPECTRUM_FS = /* glsl */`
${COMMON}
uniform sampler2D uNoise;      // 4 unit gaussians per texel
uniform float uN;              // resolution
uniform float uL;              // patch size (m) of this cascade
uniform float uKLow, uKHigh;   // cascade band limits (rad/m)

uniform float uWindSpeed;      // U10 (m/s)
uniform float uFetch;          // km
uniform float uWindDir;        // radians
uniform float uDepth;          // m
uniform float uSpread;         // directional spread multiplier (1 = Donelan)
uniform float uAlignment;      // 0 = fully isotropic, 1 = fully wind aligned
uniform float uSwellAmount;    // 0..1
uniform float uSwellPeriod;    // s
uniform float uSwellDir;       // radians
uniform float uSwellSpread;    // narrowness, larger = tighter
uniform float uAmplitude;      // global gain
uniform float uShortWaveFade;  // suppresses capillary end (0..1)

out vec4 fragColor;

// Kitaigorodskii depth attenuation (TMA).
float tmaDepth(float w){
  float wh = w * sqrt(uDepth / G);
  if (wh <= 1.0) return 0.5 * wh * wh;
  if (wh <  2.0) return 1.0 - 0.5 * sqr(2.0 - wh);
  return 1.0;
}

// JONSWAP frequency spectrum (m^2 s / rad).
float jonswap(float w, float wp){
  float U = max(uWindSpeed, 0.05);
  float F = max(uFetch, 0.1) * 1000.0;
  float alpha = 0.076 * pow(clamp(U*U/(F*G), 1e-8, 1.0), 0.22);
  float sigma = w <= wp ? 0.07 : 0.09;
  float r = exp(-sqr(w - wp) / (2.0 * sqr(sigma * wp)));
  return alpha * G*G / pow(w, 5.0) * exp(-1.25 * pow(wp/w, 4.0)) * pow(3.3, r);
}

// Donelan-Banner directional spreading: 0.5*b*sech^2(b*theta), integrates to 1.
float sech2(float x){ float c = 2.0/(exp(x)+exp(-x)); return c*c; }
float spreading(float w, float wp, float theta){
  float r = w / wp;
  float b;
  if      (r < 0.95) b = 2.61 * pow(max(r, 0.56), 1.3);
  else if (r < 1.6)  b = 2.28 * pow(r, -1.3);
  else {
    float eps = -0.4 + 0.8393 * exp(-0.567 * log(r*r));
    b = pow(10.0, eps);
  }
  b = max(b * uSpread, 0.05);
  float t = theta;
  t = atan(sin(t), cos(t));            // wrap to (-pi, pi]
  float d = 0.5 * b * sech2(b * t);
  // Blend toward isotropic so the sea can be made confused / cross-swell.
  return mix(1.0/TAU, d, clamp(uAlignment, 0.0, 1.0));
}

// Narrow-band swell riding on top of the wind sea.
float swell(float w, float theta){
  if (uSwellAmount <= 1e-4) return 0.0;
  float ws = TAU / max(uSwellPeriod, 1.0);
  float band = exp(-sqr(w - ws) / (2.0 * sqr(0.035 * ws)));
  float dt = atan(sin(theta - uSwellDir), cos(theta - uSwellDir));
  float dir = exp(-sqr(dt) * uSwellSpread);
  // Amplitude scaled so the knob reads as "swell height in metres".
  return uSwellAmount * uSwellAmount * 0.22 * band * dir / max(w, 1e-3);
}

void main(){
  vec2 id = floor(gl_FragCoord.xy);
  vec2 nm = id - uN * 0.5;
  vec2 k  = TAU * nm / uL;
  float kk = length(k);

  if (kk < 1e-6 || kk < uKLow || kk >= uKHigh){ fragColor = vec4(0.0); return; }

  // Dispersion with capillary term and finite depth.
  float km  = 370.0;                                  // capillary wavenumber
  float cap = 1.0 + sqr(kk / km);
  float w   = sqrt(G * kk * cap * tanh(min(kk * uDepth, 20.0)));
  float dwdk = G * (cap + 2.0*sqr(kk/km)) * 0.5 / max(w, 1e-4);

  float U  = max(uWindSpeed, 0.05);
  float F  = max(uFetch, 0.1) * 1000.0;
  float wp = 22.0 * pow(G*G / (U*F), 1.0/3.0);

  float theta = atan(k.y, k.x) - uWindDir;
  float S = jonswap(w, wp) * tmaDepth(w);
  float D = spreading(w, wp, theta);

  // Directional wavenumber spectrum: Psi(kx,kz) = S(w) D(th) (dw/dk) / k
  float psi = (S * D + swell(w, atan(k.y, k.x))) * dwdk / kk;

  // Roll off the very shortest waves so capillary ripple does not alias.
  psi *= exp(-sqr(kk / (km * mix(2.0, 0.02, uShortWaveFade))));

  float dk = TAU / uL;
  float amp = uAmplitude * sqrt(max(2.0 * psi, 0.0) * dk * dk);

  vec4 g = texture(uNoise, (id + 0.5) / uN);
  vec2 h0  = amp * g.xy * 0.70710678;

  // Conjugate partner at -k, evaluated with the same spectrum (isotropic in |k|
  // but the directional term differs, so it must be recomputed).
  float theta2 = atan(-k.y, -k.x) - uWindDir;
  float psi2 = (S * spreading(w, wp, theta2) + swell(w, atan(-k.y, -k.x))) * dwdk / kk;
  psi2 *= exp(-sqr(kk / (km * mix(2.0, 0.02, uShortWaveFade))));
  float amp2 = uAmplitude * sqrt(max(2.0 * psi2, 0.0) * dk * dk);
  vec2 h0c = amp2 * g.zw * 0.70710678;

  fragColor = vec4(h0, h0c);
}
`;

// -------------------------------------------------------------- time evolution

export const TIME_EVOLVE_FS = /* glsl */`
${COMMON}
uniform sampler2DArray uH0;
uniform float uN, uL, uTime, uDepth, uChoppy, uLoopPeriod;
uniform int   uLayer;
layout(location=0) out vec4 o0;   // c0 = Dx + i Dz , c1 = Dy + i dDy/dx
layout(location=1) out vec4 o1;   // c2 = dDy/dz + i dDx/dx , c3 = dDz/dz + i dDx/dz

void main(){
  ivec2 id = ivec2(gl_FragCoord.xy);
  vec2 nm = vec2(id) - uN * 0.5;
  vec2 k  = TAU * nm / uL;
  float kk = length(k);
  if (kk < 1e-6){ o0 = vec4(0.0); o1 = vec4(0.0); return; }
  vec2 kn = k / kk;

  float cap = 1.0 + sqr(kk / 370.0);
  float w = sqrt(G * kk * cap * tanh(min(kk * uDepth, 20.0)));
  // Optional quantisation to make the whole sea loop seamlessly.
  if (uLoopPeriod > 0.5){ float w0 = TAU / uLoopPeriod; w = floor(w / w0 + 0.5) * w0; }

  vec4 h0 = texelFetch(uH0, ivec3(id, uLayer), 0);
  vec2 e = cexp(w * uTime);
  vec2 h = cmul(h0.xy, e) + cmul(cconj(h0.zw), cconj(e));

  vec2 ih = vec2(-h.y, h.x);      // i*h

  vec2 hDy   = h;
  vec2 hDx   = -ih * kn.x * uChoppy;
  vec2 hDz   = -ih * kn.y * uChoppy;
  vec2 hYx   = ih * k.x;
  vec2 hYz   = ih * k.y;
  vec2 hXx   = h * (k.x * k.x / kk) * uChoppy;
  vec2 hZz   = h * (k.y * k.y / kk) * uChoppy;
  vec2 hXz   = h * (k.x * k.y / kk) * uChoppy;

  o0 = vec4(hDx + vec2(-hDz.y, hDz.x), hDy + vec2(-hYx.y, hYx.x));
  o1 = vec4(hYz + vec2(-hXx.y, hXx.x), hZz + vec2(-hXz.y, hXz.x));
}
`;

// ------------------------------------------------------------------------ FFT

export const FFT_FS = /* glsl */`
${COMMON}
uniform sampler2D uButterfly;
uniform sampler2DArray uSrc0, uSrc1;
uniform int uStage, uVertical, uLayer;
layout(location=0) out vec4 o0;
layout(location=1) out vec4 o1;

void main(){
  ivec2 id = ivec2(gl_FragCoord.xy);
  int axis = uVertical == 0 ? id.x : id.y;
  vec4 bf = texelFetch(uButterfly, ivec2(uStage, axis), 0);
  ivec2 topC, botC;
  if (uVertical == 0){ topC = ivec2(int(bf.z), id.y); botC = ivec2(int(bf.w), id.y); }
  else               { topC = ivec2(id.x, int(bf.z)); botC = ivec2(id.x, int(bf.w)); }

  vec4 t0 = texelFetch(uSrc0, ivec3(topC, uLayer), 0);
  vec4 b0 = texelFetch(uSrc0, ivec3(botC, uLayer), 0);
  vec4 t1 = texelFetch(uSrc1, ivec3(topC, uLayer), 0);
  vec4 b1 = texelFetch(uSrc1, ivec3(botC, uLayer), 0);
  vec2 w = bf.xy;

  o0 = vec4(t0.xy + cmul(w, b0.xy), t0.zw + cmul(w, b0.zw));
  o1 = vec4(t1.xy + cmul(w, b1.xy), t1.zw + cmul(w, b1.zw));
}
`;

// ------------------------------------------------------------------- assemble

export const ASSEMBLE_FS = /* glsl */`
${COMMON}
uniform sampler2DArray uS0, uS1;
uniform int uLayer;
uniform float uChoppy;
layout(location=0) out vec4 oDisp;    // xyz displacement, w Jacobian
layout(location=1) out vec4 oSlope;   // xy slope, z Jacobian, w |slope|^2

void main(){
  ivec2 id = ivec2(gl_FragCoord.xy);
  // Undo the DC-at-centre convention of the spectrum layout.
  float s = ((id.x + id.y) & 1) == 0 ? 1.0 : -1.0;

  vec4 a = texelFetch(uS0, ivec3(id, uLayer), 0) * s;
  vec4 b = texelFetch(uS1, ivec3(id, uLayer), 0) * s;

  float Dx = a.x, Dz = a.y, Dy = a.z, dYx = a.w;
  float dYz = b.x, dXx = b.y, dZz = b.z, dXz = b.w;

  float Jxx = 1.0 + dXx;
  float Jzz = 1.0 + dZz;
  float J   = Jxx * Jzz - dXz * dXz;

  oDisp  = vec4(Dx, Dy, Dz, J);
  // The fourth channel carries the second moment of the slope. Mip filtering it
  // gives <|grad h|^2> over a footprint, which the surface shader turns into
  // filtered microfacet roughness instead of aliasing sparkle.
  oSlope = vec4(dYx, dYz, J, dYx*dYx + dYz*dYz);
}
`;

// ----------------------------------------------------------------------- foam

export const FOAM_FS = /* glsl */`
${COMMON}
uniform sampler2DArray uSlope, uPrevFoam, uDisp;
uniform int uLayer;
uniform float uDt, uThreshold, uDecay, uInject, uSpreadRate, uN, uL;
out vec4 fragColor;

// Cheap 4-tap blur that lets foam bleed outward from breaking crests.
float neighbourFoam(ivec2 id){
  float o = 0.0;
  o += texelFetch(uPrevFoam, ivec3((id + ivec2( 1, 0)) & (int(uN)-1), uLayer), 0).r;
  o += texelFetch(uPrevFoam, ivec3((id + ivec2(-1, 0)) & (int(uN)-1), uLayer), 0).r;
  o += texelFetch(uPrevFoam, ivec3((id + ivec2( 0, 1)) & (int(uN)-1), uLayer), 0).r;
  o += texelFetch(uPrevFoam, ivec3((id + ivec2( 0,-1)) & (int(uN)-1), uLayer), 0).r;
  return o * 0.25;
}

void main(){
  ivec2 id = ivec2(gl_FragCoord.xy);
  vec4 sl = texelFetch(uSlope, ivec3(id, uLayer), 0);
  float J = sl.z;

  float prev = texelFetch(uPrevFoam, ivec3(id, uLayer), 0).r;
  float blur = neighbourFoam(id);
  prev = mix(prev, blur, clamp(uSpreadRate * uDt, 0.0, 1.0));

  // Folding (J below threshold) injects whitewater; steep faces inject a little.
  float fold = clamp((uThreshold - J) / max(uThreshold, 1e-3), 0.0, 1.0);
  float inject = uInject * pow(fold, 1.35);

  float foam = max(prev - uDecay * uDt, 0.0);
  foam = max(foam, inject);
  foam = min(foam, 1.6);

  fragColor = vec4(foam, fold, 0.0, 1.0);
}
`;
