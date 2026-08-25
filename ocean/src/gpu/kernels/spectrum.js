// h0 spectrum kernel - WGSL translation of INIT_SPECTRUM_FS (src/shaders/oceanSim.js).
//
// This is a translation, not a redesign: every constant, sign, clamp and guard is
// the one the GLSL has, and the comments that explain *why* a number is what it is
// have been carried across with it. If you are changing physics here, you are in
// the wrong file - change the GLSL and re-translate, or the two backends drift.
//
// What it computes, per texel of one cascade: the static Hermitian amplitude field
// h0(k) that the time-evolution pass rotates. Output is vec4(h0.xy, h0(-k).xy) -
// the mode and its negative-frequency partner, drawn from the *mirrored texel of
// the same noise field* so that h(-k) = conj(h(k)) exactly and every IFFT output
// comes out real. Two independent draws leak D_z into D_x and dD_y/dx into height.
//
// BUFFER LAYOUT (this is the whole storage contract):
//   every buffer is array<vec4<f32>>, indexed linearly as
//       layer * N * N + y * N + x
//   with N = uN (the FFT size) and layer = the cascade index. One buffer per
//   original render-target attachment; this pass had a single attachment, so one
//   output buffer (h0). The gaussian noise texture - which in the GL path is one
//   independent 2D texture per cascade - becomes one layered buffer under the same
//   rule, so the per-cascade noise must be indexed with uLayer or every cascade
//   ends up correlated.
//
// DISPATCH: one dispatch of N*N invocations per cascade, exactly like the GL driver
// loops the pass once per cascade with per-cascade uL / uKLow / uKHigh. `index` is
// the linear invocation id within the layer (x = index % N, y = index / N, matching
// the (y * N + x) layout); `uLayer` selects the cascade. A single dispatch over all
// cascades is NOT equivalent without turning uL and the band limits into arrays.
//
// Unlike a fragment pass there is no implicit clear, so every early-out writes an
// explicit vec4(0) rather than just returning.
//
// wgslFn NOTES - two hard constraints imposed by THREE's WGSLNodeFunction parser,
// both of which fail confusingly rather than loudly if broken:
//
//  1. The declaration is matched by a regexp anchored at the start of the (trimmed)
//     string, so the string MUST begin with "fn initSpectrum(" and MUST declare
//     "-> void". Nothing - not a comment, not a const - may precede it. The shared
//     COMMON helpers and the module constants therefore live *after* the main
//     function body; WGSL module-scope declarations are order independent. Do not
//     "tidy" them to the top: the parser then throws "Function is not a WGSL code".
//  2. The parameter list is captured non-greedily up to the FIRST ")" in the source,
//     so the parameter list must contain no parentheses - which in practice means no
//     comments inside it. A stray "(m/s)" truncates the parameter list silently and
//     half the uniforms arrive unbound. The uniform documentation is therefore in the
//     block below, in declaration order, rather than beside each parameter.
//
// Bind the noise buffer read-only (e.g. storage(...).toReadOnly()) and h0 as
// read_write, to match the pointer access modes in the signature.

export const INIT_SPECTRUM_WGSL = /* wgsl */`
fn initSpectrum(
  h0             : ptr<storage, array<vec4<f32>>, read_write>,
  uNoise         : ptr<storage, array<vec4<f32>>, read>,
  index          : u32,
  uLayer         : u32,
  uN             : f32,
  uL             : f32,
  uKLow          : f32,
  uKHigh         : f32,
  uWindSpeed     : f32,
  uFetch         : f32,
  uWindDir       : f32,
  uDepth         : f32,
  uSpread        : f32,
  uSpreadTail    : f32,
  uAlignment     : f32,
  uGamma         : f32,
  uTailSat       : f32,
  uSwellAmount   : f32,
  uSwellPeriod   : f32,
  uSwellDir      : f32,
  uSwellSpread   : f32,
  uSwellWidth    : f32,
  uAmplitude     : f32,
  uShortWaveFade : f32
) -> void {
  // Parameters, in declaration order - the uniform comments from the GLSL pass:
  //   h0             out, one vec4 per texel: xy = h0(k), zw = h0(-k)
  //   uNoise         4 unit gaussians per texel, one layer per cascade
  //   index          linear invocation id within this cascade, = y * N + x
  //   uLayer         cascade index
  //   uN             resolution
  //   uL             patch size, metres, of this cascade
  //   uKLow, uKHigh  cascade band limits, rad/m
  //   uWindSpeed     U10, m/s
  //   uFetch         km
  //   uWindDir       radians
  //   uDepth         m
  //   uSpread        directional spread multiplier, 1 = Donelan
  //   uSpreadTail    extra narrowing of the equilibrium range
  //   uAlignment     0 = fully isotropic, 1 = fully wind aligned
  //   uGamma         JONSWAP peak enhancement
  //   uTailSat       saturation floor of the equilibrium range
  //   uSwellAmount   significant swell height, m
  //   uSwellPeriod   s
  //   uSwellDir      radians
  //   uSwellSpread   narrowness, larger = tighter
  //   uSwellWidth    relative bandwidth of the swell peak
  //   uAmplitude     global gain
  //   uShortWaveFade rolls the band off below this cascade's Nyquist
  //
  // Linear index -> texel, and texel -> buffer offset:
  //   offset = layer * N * N + y * N + x
  // uN is a float uniform in the GL path and stays one here; N is a power of two
  // well inside exact f32 range, so i32(uN) / u32(uN) are exact.
  let Nu   = u32(uN);
  let Ni   = i32(uN);
  let area = Nu * Nu;
  // Compute-only guard: a dispatch rounded up to the workgroup size can run past
  // the grid, and an out-of-bounds store would be clamped onto a real texel.
  if (index >= area) { return; }

  let xu = index % Nu;
  let yu = index / Nu;
  let idx = i32(xu);
  let idy = i32(yu);
  let o   = uLayer * area + yu * Nu + xu;

  // Column/row 0 is the unpaired Nyquist line: it has no partner at -k, so
  // leaving it populated would inject a non-real mode.
  if (idx == 0 || idy == 0) { (*h0)[o] = vec4<f32>(0.0); return; }

  let nm = vec2<f32>(f32(idx), f32(idy)) - uN * 0.5;
  let k  = TAU * nm / uL;
  let kk = length(k);

  if (kk < 1e-6 || kk < uKLow || kk >= uKHigh) { (*h0)[o] = vec4<f32>(0.0); return; }

  // Dispersion with capillary term and finite depth.
  let km   = 370.0;                                   // capillary wavenumber
  let cap  = 1.0 + sqr(kk / km);
  let w    = sqrt(G * kk * cap * tanh(min(kk * uDepth, 20.0)));
  let dwdk = G * (cap + 2.0 * sqr(kk / km)) * 0.5 / max(w, 1e-4);

  let U     = max(uWindSpeed, 0.05);
  let chi   = min(G * max(uFetch, 0.1) * 1000.0 / (U * U), CHI_FULL);
  let Fe    = chi * U * U / G;                        // fetch after the clamp
  let alpha = 0.076 * pow(chi, -0.22);
  let wp    = 22.0 * pow(G * G / (U * Fe), 1.0 / 3.0);

  // Hasselmann's alpha(chi) and wp(chi) fits and the Hs(chi) fit are three
  // independent regressions through the same JONSWAP data and they do not close:
  // integrating alpha g^2 w^-5 exp(-1.25 (wp/w)^4) analytically gives
  // m0 = alpha g^2 / (5 wp^4), which at full development sits about 26% above
  // (0.0016 sqrt(chi) U^2/g / 4)^2. Left alone the sea comes out systematically
  // steeper than the wind that is supposed to have raised it. Scaling the peak
  // to close the gap is the honest fix: the wave height then obeys the fetch law
  // at every fetch, and the equilibrium tail - which is a property of Phillips'
  // constant, not of the fetch - keeps its own level via the floor in jonswap().
  let m0pm   = alpha * G * G / (5.0 * sqr(sqr(wp)));
  let hsFit  = 0.0016 * sqrt(chi) * U * U / G;
  let eScale = sqr(hsFit * 0.25) / max(m0pm, 1e-12);

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
  let kPeak    = wp * wp / G;
  let octaves  = log(max(800.0 / max(kPeak, 1e-4), 2.0));
  let satLevel = uTailSat * (0.003 + 5.12e-3 * U) / max(0.5 * alpha * octaves, 1e-6);

  let S  = jonswap(w, wp, alpha, eScale, satLevel, uGamma) * tmaDepth(w, uDepth);
  let th = atan2(k.y, k.x);

  // Directional wavenumber spectrum: Psi(kx,kz) = S(w) D(th) (dw/dk) / k
  var psi  = (S * spreading(w, wp, th - uWindDir, uSpread, uSpreadTail, uAlignment)
              + swell(w, th, uL, uSwellAmount, uSwellPeriod, uSwellDir, uSwellSpread, uSwellWidth))
             * dwdk / kk;
  // The same mode seen from -k: the magnitude is shared but the direction is not.
  var psiM = (S * spreading(w, wp, th + PI - uWindDir, uSpread, uSpreadTail, uAlignment)
              + swell(w, th + PI, uL, uSwellAmount, uSwellPeriod, uSwellDir, uSwellSpread, uSwellWidth))
             * dwdk / kk;

  // Roll the band off before this cascade's own Nyquist. A mode two texels per
  // wavelength cannot be shaded: it aliases in the displacement map, in the
  // slope map and again in the grid it is sampled onto, and that is what turns
  // the sea into crumpled foil. The knee is placed a little over half of Nyquist
  // (four texels per wave) and the fourth power keeps the octave below it intact
  // instead of thinning the whole band.
  let nyq  = PI * uN / uL;
  let kc   = nyq * (0.92 - 0.52 * clamp(uShortWaveFade, 0.0, 1.0));
  let roll = exp(-sqr(sqr(kk / kc)));
  psi  = psi  * roll;
  psiM = psiM * roll;

  let dk = TAU / uL;
  // Each Hermitian partner carries half the variance of the mode:
  // <|h0|^2> = Psi dk^2 / 2, so that sum_k <|h~|^2> = integral Psi d2k = m0.
  let amp  = uAmplitude * dk * sqrt(max(psi,  0.0) * 0.5);
  let ampM = uAmplitude * dk * sqrt(max(psiM, 0.0) * 0.5);

  // The texel holding -k. The mask is the GLSL's & (Ni - 1) verbatim (N is a
  // power of two); it only ever bites on index 0, which returned above, but it is
  // what makes the wrap explicit rather than accidental.
  let mx = (Ni - idx) & (Ni - 1);
  let my = (Ni - idy) & (Ni - 1);

  let layerBase = uLayer * area;
  let g  = (*uNoise)[layerBase + yu * Nu + xu];
  let gm = (*uNoise)[layerBase + u32(my) * Nu + u32(mx)];

  let h0k  = amp  * g.xy  * 0.70710678;
  let h0mk = ampM * gm.xy * 0.70710678;               // = h0 evaluated at -k

  (*h0)[o] = vec4<f32>(h0k, h0mk);
}

// --------------------------------------------------------------------- COMMON
// Ported from the GLSL COMMON block. cmul / cconj / cexp are not used by this
// pass and are left to the kernels that need them.

const PI  : f32 = 3.14159265358979;
const TAU : f32 = 6.28318530717959;
const G   : f32 = 9.80665;

fn sqr(x: f32) -> f32 { return x * x; }

// Fetch stops growing the sea once it is fully developed; past that point the
// JONSWAP alpha/omega_p laws drift away from the measured energy, so the
// non-dimensional fetch is clamped and everything else derived from the clamp.
const CHI_FULL : f32 = 2.2e4;

// Kitaigorodskii depth attenuation (TMA).
fn tmaDepth(w: f32, uDepth: f32) -> f32 {
  let wh = w * sqrt(uDepth / G);
  if (wh <= 1.0) { return 0.5 * wh * wh; }
  if (wh <  2.0) { return 1.0 - 0.5 * sqr(2.0 - wh); }
  return 1.0;
}

// JONSWAP frequency spectrum (m^2 s / rad), energy-normalised. eScale reconciles
// the shape with the fetch law (see the renormalisation in initSpectrum); it
// multiplies the peak but not the saturated tail, which is set by Phillips'
// constant and not by the fetch.
fn jonswap(w: f32, wp: f32, alpha: f32, eScale: f32, satLevel: f32, uGamma: f32) -> f32 {
  let gam   = max(uGamma, 1.0);
  // Goda's normaliser: keeps m0 fixed as the peak is sharpened, so gamma is a
  // pure shape control and does not secretly double the wave height.
  let norm  = 1.0 - 0.287 * log(gam);
  let sigma = select(0.09, 0.07, w <= wp);
  let r     = exp(-sqr(w - wp) / (2.0 * sqr(sigma * wp)));
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
  let shape    = norm * pow(gam, r) * eScale;
  let floorLvl = satLevel * smoothstep(2.2, 3.2, w / wp);
  let a        = alpha * max(shape, floorLvl);
  return a * G * G / pow(w, 5.0) * exp(-1.25 * pow(wp / w, 4.0));
}

// Donelan-Banner directional spreading: 0.5*b*sech^2(b*theta), integrates to 1.
fn sech2(x: f32) -> f32 { let c = 2.0 / (exp(x) + exp(-x)); return c * c; }

fn spreading(w: f32, wp: f32, theta: f32, uSpread: f32, uSpreadTail: f32, uAlignment: f32) -> f32 {
  let r = w / wp;
  var b : f32;
  if      (r < 0.95) { b = 2.61 * pow(max(r, 0.56), 1.3); }
  else if (r < 1.6)  { b = 2.28 * pow(r, -1.3); }
  else {
    let eps = -0.4 + 0.8393 * exp(-0.567 * log(r * r));
    b = pow(10.0, eps);
  }
  // Donelan's tail measurements come from a wave staff, which sees the short
  // waves averaged over every long wave they ride. In a photograph they are not
  // that isotropic: the wind-driven chop lies in visible rows across the swell,
  // and letting b fall to ~0.4 above 1.6 wp is what makes the sea read as
  // tinfoil crinkle rather than a wind sea with a direction.
  b = b * mix(1.0, max(uSpreadTail, 0.1), smoothstep(1.4, 5.0, r));
  b = max(b * uSpread, 0.05);
  let t = atan2(sin(theta), cos(theta));   // wrap to (-pi, pi]
  let d = 0.5 * b * sech2(b * t);
  // Blend toward isotropic so the sea can be made confused / cross-swell.
  return mix(1.0 / TAU, d, clamp(uAlignment, 0.0, 1.0));
}

// Narrow-band swell riding on top of the wind sea. Both the frequency band and
// the directional lobe are normalised to unit integral, so uSwellAmount is
// literally the significant height of the swell train in metres.
fn swell(w: f32, theta: f32, uL: f32, uSwellAmount: f32, uSwellPeriod: f32,
         uSwellDir: f32, uSwellSpread: f32, uSwellWidth: f32) -> f32 {
  if (uSwellAmount <= 1e-4) { return 0.0; }
  let ws = TAU / max(uSwellPeriod, 1.0);
  // A 14 s swell in the 1789 m patch sits near mode 6, where one cell of the
  // wavenumber grid is ~0.04 rad/s wide - broader than the swell band itself.
  // Left alone the Gaussian falls between samples, so the train is carried by
  // one or two modes: no groups, and a variance that depends on where the peak
  // happens to land. Widening it to the cell keeps the integral (the band is
  // normalised) while giving the swell enough modes to beat against itself.
  // The cap matters: in the short cascades one cell is wider than the swell
  // frequency itself, and widening to it would spray swell energy across the
  // whole equilibrium range instead of leaving those cascades alone.
  let dwCell = min((TAU / uL) * G / (2.0 * max(ws, 0.05)), 0.25 * ws);
  let sw     = max(max(uSwellWidth, 0.005) * ws, 0.8 * dwCell);
  let band   = exp(-sqr(w - ws) / (2.0 * sqr(sw))) / (sw * sqrt(TAU));
  let dt     = atan2(sin(theta - uSwellDir), cos(theta - uSwellDir));
  let s      = max(uSwellSpread, 0.25);
  let dir    = exp(-s * dt * dt) * sqrt(s / PI);
  return sqr(uSwellAmount * 0.25) * band * dir;   // m0 = (Hs/4)^2
}
`;
