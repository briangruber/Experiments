// GPU ocean spectrum + IFFT passes.
//
// Pipeline per cascade, per frame:
//   h0 (static, rebuilt on parameter change)
//     -> timeEvolve  : 4 packed complex fields across 2 MRT targets
//     -> fft x 2logN : horizontal then vertical radix-2 butterflies
//     -> assemble    : displacement + slope + Jacobian
//     -> foam        : temporal accumulation of wave folding
//
// Field packing through the IFFT (two real signals ride one complex transform):
//   c0 = D_x  + i D_z          c1 = D_y      + i dD_y/dx
//   c2 = dD_y/dz + i dD_x/dx   c3 = dD_z/dz  + i dD_x/dz
// That packing is only valid if every transform output is exactly real, which in
// turn requires h(-k) = conj(h(k)) at *every* mode. h0 therefore has to draw its
// negative-frequency partner from the mirrored texel of the same noise field --
// two independent draws leave an imaginary residue that leaks D_z into D_x and
// dD_y/dx into the height itself.

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
uniform float uSpreadTail;     // extra narrowing of the equilibrium range
uniform float uAlignment;      // 0 = fully isotropic, 1 = fully wind aligned
uniform float uGamma;          // JONSWAP peak enhancement
uniform float uTailSat;        // saturation floor of the equilibrium range
uniform float uSwellAmount;    // significant swell height (m)
uniform float uSwellPeriod;    // s
uniform float uSwellDir;       // radians
uniform float uSwellSpread;    // narrowness, larger = tighter
uniform float uSwellWidth;     // relative bandwidth of the swell peak
uniform float uAmplitude;      // global gain
uniform float uShortWaveFade;  // rolls the band off below this cascade's Nyquist

out vec4 fragColor;

// Fetch stops growing the sea once it is fully developed; past that point the
// JONSWAP alpha/omega_p laws drift away from the measured energy, so the
// non-dimensional fetch is clamped and everything else derived from the clamp.
const float CHI_FULL = 2.2e4;

// Kitaigorodskii depth attenuation (TMA).
float tmaDepth(float w){
  float wh = w * sqrt(uDepth / G);
  if (wh <= 1.0) return 0.5 * wh * wh;
  if (wh <  2.0) return 1.0 - 0.5 * sqr(2.0 - wh);
  return 1.0;
}

// JONSWAP frequency spectrum (m^2 s / rad), energy-normalised. eScale reconciles
// the shape with the fetch law (see below); it multiplies the peak but not the
// saturated tail, which is set by Phillips' constant and not by the fetch.
float jonswap(float w, float wp, float alpha, float eScale, float satLevel){
  float gam   = max(uGamma, 1.0);
  // Goda's normaliser: keeps m0 fixed as the peak is sharpened, so gamma is a
  // pure shape control and does not secretly double the wave height.
  float norm  = 1.0 - 0.287 * log(gam);
  float sigma = w <= wp ? 0.07 : 0.09;
  float r     = exp(-sqr(w - wp) / (2.0 * sqr(sigma * wp)));
  // The short-gravity range is where every bit of the mean square slope lives,
  // and it is NOT the same population as the peak: its level is set by the wind
  // forcing it, not by the fetch that grew the swell. It therefore gets its own
  // floor. The knee is placed well above the peak (2.2-3.2 wp, i.e. five to ten
  // times the peak wavenumber) for a hard energetic reason: only three percent of
  // m0 lives above 2.5 wp, so the floor can lift that band by whatever the slope
  // statistics demand while the significant wave height stays on the fetch law.
  // Putting the knee at the peak instead - which is what "the tail is saturated
  // above wp" naively gives you - lifts the band that carries m0 and silently
  // inflates the sea by twenty percent.
  float shape = norm * pow(gam, r) * eScale;
  float floorLvl = satLevel * smoothstep(2.2, 3.2, w / wp);
  float a = alpha * max(shape, floorLvl);
  return a * G*G / pow(w, 5.0) * exp(-1.25 * pow(wp/w, 4.0));
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
  // Donelan's tail measurements come from a wave staff, which sees the short
  // waves averaged over every long wave they ride. In a photograph they are not
  // that isotropic: the wind-driven chop lies in visible rows across the swell,
  // and letting b fall to ~0.4 above 1.6 wp is what makes the sea read as
  // tinfoil crinkle rather than a wind sea with a direction.
  b *= mix(1.0, max(uSpreadTail, 0.1), smoothstep(1.4, 5.0, r));
  b = max(b * uSpread, 0.05);
  float t = atan(sin(theta), cos(theta));   // wrap to (-pi, pi]
  float d = 0.5 * b * sech2(b * t);
  // Blend toward isotropic so the sea can be made confused / cross-swell.
  return mix(1.0/TAU, d, clamp(uAlignment, 0.0, 1.0));
}

// Narrow-band swell riding on top of the wind sea. Both the frequency band and
// the directional lobe are normalised to unit integral, so uSwellAmount is
// literally the significant height of the swell train in metres.
float swell(float w, float theta){
  if (uSwellAmount <= 1e-4) return 0.0;
  float ws = TAU / max(uSwellPeriod, 1.0);
  // A 14 s swell in the 1789 m patch sits near mode 6, where one cell of the
  // wavenumber grid is ~0.04 rad/s wide - broader than the swell band itself.
  // Left alone the Gaussian falls between samples, so the train is carried by
  // one or two modes: no groups, and a variance that depends on where the peak
  // happens to land. Widening it to the cell keeps the integral (the band is
  // normalised) while giving the swell enough modes to beat against itself.
  // The cap matters: in the short cascades one cell is wider than the swell
  // frequency itself, and widening to it would spray swell energy across the
  // whole equilibrium range instead of leaving those cascades alone.
  float dwCell = min((TAU / uL) * G / (2.0 * max(ws, 0.05)), 0.25 * ws);
  float sw = max(max(uSwellWidth, 0.005) * ws, 0.8 * dwCell);
  float band = exp(-sqr(w - ws) / (2.0 * sqr(sw))) / (sw * sqrt(TAU));
  float dt = atan(sin(theta - uSwellDir), cos(theta - uSwellDir));
  float s  = max(uSwellSpread, 0.25);
  float dir = exp(-s * dt * dt) * sqrt(s / PI);
  return sqr(uSwellAmount * 0.25) * band * dir;   // m0 = (Hs/4)^2
}

void main(){
  ivec2 id = ivec2(gl_FragCoord.xy);
  int   Ni = int(uN);
  // Column/row 0 is the unpaired Nyquist line: it has no partner at -k, so
  // leaving it populated would inject a non-real mode.
  if (id.x == 0 || id.y == 0){ fragColor = vec4(0.0); return; }

  vec2 nm = vec2(id) - uN * 0.5;
  vec2 k  = TAU * nm / uL;
  float kk = length(k);

  if (kk < 1e-6 || kk < uKLow || kk >= uKHigh){ fragColor = vec4(0.0); return; }

  // Dispersion with capillary term and finite depth.
  float km  = 370.0;                                  // capillary wavenumber
  float cap = 1.0 + sqr(kk / km);
  float w   = sqrt(G * kk * cap * tanh(min(kk * uDepth, 20.0)));
  float dwdk = G * (cap + 2.0*sqr(kk/km)) * 0.5 / max(w, 1e-4);

  float U   = max(uWindSpeed, 0.05);
  float chi = min(G * max(uFetch, 0.1) * 1000.0 / (U*U), CHI_FULL);
  float Fe  = chi * U * U / G;                        // fetch after the clamp
  float alpha = 0.076 * pow(chi, -0.22);
  float wp    = 22.0 * pow(G*G / (U * Fe), 1.0/3.0);

  // Hasselmann's alpha(chi) and wp(chi) fits and the Hs(chi) fit are three
  // independent regressions through the same JONSWAP data and they do not close:
  // integrating alpha g^2 w^-5 exp(-1.25 (wp/w)^4) analytically gives
  // m0 = alpha g^2 / (5 wp^4), which at full development sits about 26% above
  // (0.0016 sqrt(chi) U^2/g / 4)^2. Left alone the sea comes out systematically
  // steeper than the wind that is supposed to have raised it. Scaling the peak
  // to close the gap is the honest fix: the wave height then obeys the fetch law
  // at every fetch, and the equilibrium tail - which is a property of Phillips'
  // constant, not of the fetch - keeps its own level via the floor above.
  float m0pm  = alpha * G*G / (5.0 * sqr(sqr(wp)));
  float hsFit = 0.0016 * sqrt(chi) * U * U / G;
  float eScale = sqr(hsFit * 0.25) / max(m0pm, 1e-12);

  // Cox-Munk's mean square slope grows linearly with wind speed; Phillips'
  // constant does not grow at all. Both cannot be right, and the slope
  // measurements are the ones with a sun glitter photograph behind them: the
  // short-gravity range is not truly saturated, its level rises with the wind.
  // Pinning it to a constant alpha leaves the sea roughly half as rough as any
  // slick-free measurement of the real thing, which is exactly what a rendered
  // ocean that looks like poured resin is missing. The floor is set so that a
  // Phillips-shaped range running from the spectral peak out to the 8 mm
  // capillary cutoff carries the Cox-Munk variance; each cascade then resolves
  // whatever share of that range it owns.
  float kPeak = wp * wp / G;
  float octaves = log(max(800.0 / max(kPeak, 1e-4), 2.0));
  float satLevel = uTailSat * (0.003 + 5.12e-3 * U) / max(0.5 * alpha * octaves, 1e-6);

  float S = jonswap(w, wp, alpha, eScale, satLevel) * tmaDepth(w);
  float th = atan(k.y, k.x);

  // Directional wavenumber spectrum: Psi(kx,kz) = S(w) D(th) (dw/dk) / k
  float psi  = (S * spreading(w, wp, th - uWindDir) + swell(w, th)) * dwdk / kk;
  // The same mode seen from -k: the magnitude is shared but the direction is not.
  float psiM = (S * spreading(w, wp, th + PI - uWindDir) + swell(w, th + PI)) * dwdk / kk;

  // Roll the band off before this cascade's own Nyquist. A mode two texels per
  // wavelength cannot be shaded: it aliases in the displacement map, in the
  // slope map and again in the grid it is sampled onto, and that is what turns
  // the sea into crumpled foil. The knee is placed a little over half of Nyquist
  // (four texels per wave) and the fourth power keeps the octave below it intact
  // instead of thinning the whole band.
  float nyq = PI * uN / uL;
  float kc = nyq * (0.92 - 0.52 * clamp(uShortWaveFade, 0.0, 1.0));
  float roll = exp(-sqr(sqr(kk / kc)));
  psi *= roll; psiM *= roll;

  float dk = TAU / uL;
  // Each Hermitian partner carries half the variance of the mode:
  // <|h0|^2> = Psi dk^2 / 2, so that sum_k <|h~|^2> = integral Psi d2k = m0.
  float amp  = uAmplitude * dk * sqrt(max(psi,  0.0) * 0.5);
  float ampM = uAmplitude * dk * sqrt(max(psiM, 0.0) * 0.5);

  ivec2 idm = (ivec2(Ni) - id) & (Ni - 1);            // the texel holding -k
  vec4 g  = texelFetch(uNoise, id,  0);
  vec4 gm = texelFetch(uNoise, idm, 0);

  vec2 h0  = amp  * g.xy  * 0.70710678;
  vec2 h0m = ampM * gm.xy * 0.70710678;               // = h0 evaluated at -k

  fragColor = vec4(h0, h0m);
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
uniform float uKChar;     // energy-centre wavenumber of this cascade's band
uniform float uStokes;    // gain on the bound second harmonic
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

  // Bound second harmonic. A linear spectrum is symmetric about the mean plane -
  // the crest and the trough have the same curvature - and that symmetry is the
  // single loudest tell that a rendered sea is a sum of sinusoids. To second
  // order a Stokes wave carries eta2 = k(eta1^2 - <eta1^2>), which peaks the
  // crest and broadens the trough while adding almost nothing to the variance.
  // The correction is a pointwise function of the height, so its own derivative
  // is exact: d/dx (k eta^2) = 2 k eta eta_x, and the slope map stays consistent
  // with the geometry the vertex shader builds. Clamped because the expansion is
  // only valid while ka stays small and a steep cascade would otherwise fold.
  float corr = clamp(uStokes * uKChar * Dy, -0.45, 0.45);
  Dy  += corr * Dy;
  dYx *= 1.0 + 2.0 * corr;
  dYz *= 1.0 + 2.0 * corr;

  float Jxx = 1.0 + dXx;
  float Jzz = 1.0 + dZz;
  float J   = Jxx * Jzz - dXz * dXz;

  oDisp  = vec4(Dx, Dy, Dz, J);
  // The fourth channel carries the second moment of the slope. Mip filtering it
  // gives <|grad h|^2> over a footprint, which the surface shader turns into
  // filtered microfacet roughness instead of aliasing sparkle, and whose top mip
  // is the cascade's contribution to the total mean square slope.
  oSlope = vec4(dYx, dYz, J, dYx*dYx + dYz*dYz);
}
`;

// ----------------------------------------------------------------------- foam

export const FOAM_FS = /* glsl */`
${COMMON}
uniform sampler2DArray uPrevFoam, uDisp, uSlope;
uniform float uPatch[4];
uniform float uCompLod[4];
uniform int   uLayer, uCascadeCount;
uniform float uDt, uCutoff, uSoft, uDecay, uFreshDecay, uInject, uThin;
uniform float uSpreadRate, uWeight, uDrift, uWindDir, uN, uL, uFaceBias, uBreakScale;
uniform float uCrestAniso, uRidge, uBreakup;
out vec4 fragColor;

// (J - 1) for THIS cascade at one world point, at the mip whose footprint is a
// breaker: a single folding texel is a wrinkle, not whitewater, and
// thresholding one texel at a time produces confetti that never aggregates.
//
// It has to be this cascade alone. Summing the fold of every cascade is better
// physics - the Jacobian of the summed displacement really is 1 + sum(J_c - 1) -
// but the result is written into a texture the surface shader tiles with period
// uPatch[uLayer], and a field built from four non-commensurate cascades has no
// such period. Stamping it out on that grid printed a visible 17 m lattice of
// whitecaps across the whole sea. Only a function of this cascade shares this
// cascade's period, so only that can live in this buffer. The cross-scale
// modulation - short waves breaking on the back of a swell - belongs in the
// surface shader, where the combined field is available per pixel and unbounded.
float foldAt(vec2 wpos){
  return textureLod(uDisp, vec3(wpos / uPatch[uLayer], float(uLayer)),
                    max(uCompLod[uLayer] - 1.0, 0.0)).w - 1.0;
}

// Offsets of the breaking kernel along the crest line, in units of the breaker
// scale times the crest anisotropy.
const float CT[5] = float[5](-1.0, -0.5, 0.0, 0.5, 1.0);

void main(){
  ivec2 id = ivec2(gl_FragCoord.xy);
  vec2 uv  = (vec2(id) + 0.5) / uN;
  vec2 world = uv * uL;
  vec2 wd = vec2(cos(uWindDir), sin(uWindDir));
  vec2 wn = vec2(-wd.y, wd.x);
  float bs = max(uBreakScale, 0.2);

  // A breaker is a LINE event, not a disc: the tumbling region runs tens of
  // metres along the crest and only a fraction of a wavelength across it. An
  // isotropic low-pass of the fold field therefore answers the wrong question,
  // and thresholding its broad round maxima is exactly why the whitecaps came
  // out as identical circular rafts with no crest alignment. Averaging along the
  // crest and testing across it turns the same statistics into crest-aligned
  // strips. The offsets are taken perpendicular to the wind because that is the
  // direction the dominant crests run.
  float comp = 0.0;
  for (int t = 0; t < 5; t++)
    comp += foldAt(world + wn * (CT[t] * bs * uCrestAniso));
  comp *= 0.2;
  float x = -comp;                            // positive where the surface folds

  // Ridge test across the crest. Water only tumbles where the fold is at its
  // maximum in the direction the wave is travelling; a metre either side of that
  // the same surface is merely steep. Without it the strip above is as wide as
  // the kernel and the raft still reads as a slab.
  float xf = -foldAt(world + wd * bs);
  float xb = -foldAt(world - wd * bs);
  float crestOff = x - max(xf, xb);

  // Own cascade only, for the same periodicity reason as foldAt.
  vec2 grad = textureLod(uSlope, vec3(world / uPatch[uLayer], float(uLayer)),
                         max(uCompLod[uLayer] - 1.0, 0.0)).xy;

  // Scale-free threshold. The previous frame wrote x*x into channel w, so the
  // top mip of the foam texture is <x^2> over the whole patch and the cutoff can
  // be expressed in units of the sea's own RMS compression. An absolute
  // Jacobian threshold cannot work: a steeper sea trivially exceeds it
  // everywhere, which is how force 10 became a hundred percent white-out.
  // Each cascade now folds on its own account, so each normalises by its own
  // variance: the top mip of this layer's w channel is <x^2> over this tile.
  float cvar = textureLod(uPrevFoam, vec3(uv, float(uLayer)), 32.0).w;
  float inv  = cvar > 1e-9 ? inversesqrt(cvar) : 0.0;
  float xn   = x * inv;
  // In the same sigma units, so the ridge gate keeps its meaning as the sea
  // state changes.
  float ridge = mix(1.0, smoothstep(-0.25, 0.30, crestOff * inv), clamp(uRidge, 0.0, 1.0));

  // Spilling breakers live on the forward face, where the surface falls away
  // along the direction of travel. The compression on the back of a wave is the
  // horizontal displacement piling water up against the next crest and it makes
  // no foam, so without this half the whitecaps sit in the wrong place.
  float face = -dot(grad, wd) * inversesqrt(dot(grad, grad) + 1e-8);
  float gate = mix(1.0, smoothstep(-0.4, 0.5, face), clamp(uFaceBias, 0.0, 1.0));

  // What actually trips a crest into breaking is the metre-scale roughness
  // riding on it, so the threshold is modulated by the wind-projected slope of
  // the two shortest cascades, normalised by their own RMS (the top mip of the
  // slope map is <|grad h|^2>, which is exactly that). This is what gives a raft
  // internal structure and a ragged edge instead of the smooth convex outline a
  // thresholded low-pass always has - and unlike a procedural noise it is
  // periodic in each cascade's own tile, so it cannot introduce a seam.
  // Taken from this cascade's own slope at a finer mip than the breaking kernel:
  // the roughness that trips a crest is the detail riding on it. Reading the
  // shorter cascades here would reintroduce the lattice.
  vec3 uvr = vec3(world / uPatch[uLayer], float(uLayer));
  float rms = sqrt(max(textureLod(uSlope, uvr, 32.0).w, 1e-9));
  float rough = dot(textureLod(uSlope, uvr, max(uCompLod[uLayer] - 2.5, 0.0)).xy, wd) / rms;
  float cut = uCutoff - uBreakup * rough;

  float fold  = smoothstep(cut - uSoft, cut + uSoft, xn) * gate * ridge;
  float birth = clamp(uInject * fold, 0.0, 1.0);

  // Foam lives in undisplaced (Lagrangian) coordinates, so it already rides the
  // water particle it was born on. What still has to be advected is the surface
  // drift - Stokes plus wind shear - and that is what draws foam into windrows.
  vec2 duv = wd * (uDrift * uDt / uL);
  // Diffusion lengths are metres of sea, not texels. Expressed in texels the
  // same code smeared a raft over eight metres in the 397 m cascade and over
  // thirty centimetres in the 17 m one, so each cascade grew a differently
  // shaped foam and the sum was a soft halo around a hard core.
  float alongUV  = 0.45 * bs / uL;
  float acrossUV = 0.28 * bs / uL;

  vec4 prev = textureLod(uPrevFoam, vec3(uv - duv, float(uLayer)), 0.0);
  // Mild along-wind bias (~1.6:1), not the old 5.6:1 smear. That ratio turned
  // every breaker into a filament; real foam keeps clumps and holes while it
  // drifts.
  vec4 blur = 0.25 * (
      textureLod(uPrevFoam, vec3(uv - duv + wd*alongUV,  float(uLayer)), 0.0)
    + textureLod(uPrevFoam, vec3(uv - duv - wd*alongUV,  float(uLayer)), 0.0)
    + textureLod(uPrevFoam, vec3(uv - duv + wn*acrossUV, float(uLayer)), 0.0)
    + textureLod(uPrevFoam, vec3(uv - duv - wn*acrossUV, float(uLayer)), 0.0));
  // Frame-rate independent: a linear rate*dt blend has to be clamped, and the
  // clamp is a cliff - at the top of the old 0..8 range one frame replaced the
  // foam field wholesale with its own blur, so whitecaps stopped being streaks
  // and became a smooth grey crust. 1 - exp(-rate*dt) approaches total diffusion
  // asymptotically instead, and at the default 0.4 it differs from the old form
  // by 0.4%, so the sea it was tuned against is unchanged.
  prev = mix(prev, blur, 1.0 - exp(-max(uSpreadRate, 0.0) * uDt));

  // The buffer is stored pre-multiplied by this cascade's share of the foam
  // budget, but the physics below is a fraction of the texel's own area and has
  // to saturate at one. Left in the weighted frame the raft saturated at one per
  // cascade instead of one in total, and four cascades summing to two is how
  // twenty percent whitecap coverage became a white-out.
  float iw = 1.0 / max(uWeight, 1e-3);
  float pFresh = prev.y * iw, pRes = prev.z * iw;

  // Two-stage life. Stage one is the dense, bright crest foam that appears the
  // instant the crest folds and is gone within a couple of seconds.
  float fresh = min(max(pFresh * exp(-uFreshDecay * uDt), birth), 1.0);
  // Stage two is the thin dissipated raft it decays into, which lingers, spreads
  // and streaks long after the wave that made it has passed. In steady state it
  // covers freshDecay/decay times the area of the crest foam feeding it, which
  // is why the raft and not the breaker sets the coverage a photograph shows.
  // Exponential decay alone never reaches zero, so the raft leaves a film of a
  // few percent over most of the sea. That film is invisible in a photograph but
  // it is not invisible to a shader that multiplies it by a foam radiance, and
  // it is what turns a two percent whitecap coverage into a white sheet. Bubbles
  // burst at a rate per unit area, not per unit foam, so the sink is linear and
  // the raft clears in finite time.
  float residue = pRes * exp(-uDecay * uDt) + fresh * uFreshDecay * uDt;
  residue = clamp(residue - uThin * uDt, 0.0, 1.0);

  // These are area fractions of the same texel, so they composite. Taking the
  // max threw the raft away wherever a crest was breaking, which pinned the
  // fresh/aged ratio the shading pass reads at exactly one.
  float total = clamp(fresh + residue * (1.0 - fresh), 0.0, 1.0);
  fragColor = vec4(vec3(total, fresh, residue) * uWeight, x * x);
}
`;
