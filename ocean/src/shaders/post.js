// HDR post chain: prefilter -> progressive bloom -> composite/tonemap -> FXAA.
//
// Convention for this file: every tonemap returns DISPLAY-LINEAR values and the
// composite applies the OETF exactly once, at the very end. AgX's sigmoid is
// already display-encoded, so agx() undoes that encoding before returning --
// without it the frame gets gamma applied twice and washes out to milk.

const LUMA = 'const vec3 LW = vec3(0.2126, 0.7152, 0.0722);\n';

// Shared exposure resolution: the bloom prefilter has to agree with the
// composite about the working stop, or a threshold in scene units becomes
// meaningless the moment auto exposure moves.
const EXPOSURE_FN = /* glsl */`
uniform sampler2D uAdapt;
uniform float uExposure, uAutoExposure, uExposureBias, uExposureTarget;
float resolveExposure(){
  float ev = uExposure;
  if (uAutoExposure > 0.0){
    float avg = max(texelFetch(uAdapt, ivec2(0), 0).r, 1e-5);
    ev = mix(ev, ev * (uExposureTarget / avg), uAutoExposure);
  }
  return ev * exp2(uExposureBias);
}
`;

export const PREFILTER_FS = /* glsl */`
in vec2 vUv;
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uThreshold, uKnee, uClamp, uVeil;
out vec4 fragColor;
` + LUMA + EXPOSURE_FN + /* glsl */`

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

  // Threshold in *exposed* units so the bloom looks the same at dawn and noon.
  float lum = dot(col, LW) * resolveExposure();
  float soft = clamp(lum - uThreshold + uKnee, 0.0, 2.0*uKnee);
  soft = soft*soft / (4.0*uKnee + 1e-5);
  float w = max(soft, lum - uThreshold) / max(lum, 1e-5);

  // Veiling glare is not a threshold effect: glass and the sensor stack scatter
  // a little of *all* the light in the frame, which is what fills shadows next
  // to a bright sky and keeps the image from looking synthetically clean.
  fragColor = vec4(col * (w + uVeil), 1.0);
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

// Each octave is added with weight uWeight^level. Equal weight per octave (1.0)
// spreads equal energy over 4x the area each step, i.e. an intensity falloff of
// 1/r^2 -- the actual point spread function of a lens. Below 1 tightens it.
export const UP_FS = /* glsl */`
in vec2 vUv;
uniform sampler2D uSrc, uPrev;
uniform vec2 uTexel;
uniform float uRadius, uAnamorphic, uWeight;
out vec4 fragColor;
void main(){
  vec2 t = uTexel * uRadius * vec2(1.0 + uAnamorphic*3.0, 1.0);
  vec3 s =
    texture(uSrc, vUv + t*vec2(-1,-1)).rgb*1.0 + texture(uSrc, vUv + t*vec2(0,-1)).rgb*2.0 + texture(uSrc, vUv + t*vec2(1,-1)).rgb*1.0 +
    texture(uSrc, vUv + t*vec2(-1, 0)).rgb*2.0 + texture(uSrc, vUv                 ).rgb*4.0 + texture(uSrc, vUv + t*vec2(1, 0)).rgb*2.0 +
    texture(uSrc, vUv + t*vec2(-1, 1)).rgb*1.0 + texture(uSrc, vUv + t*vec2(0, 1)).rgb*2.0 + texture(uSrc, vUv + t*vec2(1, 1)).rgb*1.0;
  fragColor = vec4(texture(uPrev, vUv).rgb + (s/16.0) * uWeight, 1.0);
}
`;

// Metering pass. Two populations are measured at once, both area weighted:
//   rg -- a robust key (outliers discounted), i.e. "what is the midtone?"
//   ba -- the first two central moments of the *undiscounted* distribution,
//         from which the adaptation pass recovers a percentile. A percentile is
//         what a highlight-weighted meter actually protects; a "count the
//         bright pixels" mass term cannot tell a frame that is 3 stops over
//         from one that is 9 stops over, so it under-protects exactly the
//         bimodal frames (storm sea, sun glitter) that need it most.
// Everything is in log2, so the units of every meter knob are stops.
export const LUM_FS = /* glsl */`
in vec2 vUv;
uniform sampler2D uSrc, uPrev;
uniform float uMeterCenter, uMeterHi, uMeterLo;
out vec4 fragColor;
` + LUMA + /* glsl */`
void main(){
  vec3 c = texture(uSrc, vUv).rgb;
  float lg = log2(max(dot(c, LW), 1e-4));
  float key = texelFetch(uPrev, ivec2(0), 0).b;   // last frame's robust key, log2
  float rel = lg - key;                           // stops away from it

  // Centre weighting: the sea occupies the middle of frame and is what has to
  // be correctly exposed; the sky is allowed to go where it goes.
  vec2 d = vUv - 0.5;
  float cw = mix(1.0, exp(-4.0*dot(d,d)), uMeterCenter);

  // Soft histogram weighting around the running key. Specular glitter and a
  // blown sky are outliers by definition, so they get discounted instead of
  // dragging the whole frame down; deep troughs are discounted more gently.
  float w = cw / ((1.0 + uMeterHi*max(rel, 0.0)) * (1.0 + uMeterLo*max(-rel, 0.0)));

  // Moments are taken about the running key rather than about zero: the mip
  // reduction happens in half float, and E[x^2] - E[x]^2 with x ~ -8 would lose
  // the entire variance to cancellation.
  fragColor = vec4(w*lg, w, cw*rel, cw*rel*rel);
}
`;

// Adaptation. rgb = (linear effective key, log2 of it, log2 robust key); the
// robust key is fed back to the metering pass, the effective one drives exposure.
export const ADAPT_FS = /* glsl */`
uniform sampler2D uLum, uPrev;
uniform float uDt, uSpeed, uSpeedUp, uMinLog, uMaxLog, uHiHeadroom, uSigma, uCwMean;
out vec4 fragColor;
void main(){
  vec4 s = textureLod(uLum, vec2(0.5), 8.0);
  float key = s.x / max(s.y, 1e-4);
  float prevKey = texelFetch(uPrev, ivec2(0), 0).b;

  // Percentile from moments. Log luminance of a lit scene is close to normal,
  // so key + sigma*sd tracks a high percentile without a histogram: sigma 1.65
  // is the 95th, 2.05 the 98th. Unlike a mean it scales with how blown the
  // frame is, so a flat scene is left alone and a bimodal one is stopped down.
  float m1 = s.z / max(uCwMean, 1e-4);
  float sd = sqrt(max(s.w / max(uCwMean, 1e-4) - m1*m1, 0.0));
  float hi = prevKey + m1 + uSigma*sd;

  // Highlight priority. Raising the key by whatever the bright percentile
  // overshoots is what a camera's highlight-weighted mode does, and it is the
  // only honest fix for a bimodal frame: the midtone target is a preference,
  // clipping is not.
  float eff = max(key, hi - uHiHeadroom);
  eff = clamp(eff, uMinLog, uMaxLog);
  key = clamp(key, uMinLog, uMaxLog);

  vec3 prev = texelFetch(uPrev, ivec2(0), 0).rgb;
  if (prev.r <= 0.0) prev = vec3(exp2(eff), eff, key);
  // An iris (and an eye) stops down faster than it opens up; matching that
  // asymmetry is what stops the image pumping when a wave throws a highlight.
  float t = 1.0 - exp(-uDt * uSpeed * (eff > prev.y ? uSpeedUp : 1.0));
  float e = mix(prev.y, eff, t);
  float k = mix(prev.z, key, 1.0 - exp(-uDt * uSpeed));
  fragColor = vec4(exp2(e), e, k, 1.0);
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
uniform sampler2D uSrc, uBloom, uGlare;
uniform vec2 uRes;
uniform float uBloomIntensity, uBloomTintAmount, uGlareIntensity;
uniform vec3  uBloomTint;
uniform float uVignette, uVignetteRound;
uniform float uTime;
uniform float uChromatic, uDistortion;
uniform float uLensWet, uLensDrops, uLensSize, uLensRefract, uLensStreak;
uniform float uLensRim, uLensFilm;
uniform vec2  uLensFlow;
uniform float uLensBody;
uniform float uContrast, uSaturation, uPostSaturation, uSplit;
uniform float uBlackPoint, uToe, uToeRange, uChromaRestore;
uniform vec3  uLift, uGammaCC, uGain, uWhiteBalance, uSplitShadow, uSplitHigh;
uniform int   uTonemap;
uniform float uHighlightRoll;
uniform float uHalation;
uniform vec3  uHalationTint;
out vec4 fragColor;
` + LUMA + EXPOSURE_FN + /* glsl */`

// ------------------------------------------------------------------ tonemaps
// AGX_IN folds sRGB->Rec.2020 into the AgX inset; AGX_OUT is its inverse.
const mat3 AGX_IN = mat3(
  0.842479062253094, 0.0423282422610123, 0.0423756549057051,
  0.0784335999999992, 0.878468636469772,  0.0784336,
  0.0792237451477643, 0.0791661274605434, 0.879142973793104);
const mat3 AGX_OUT = mat3(
   1.19687900512017,  -0.0528968517574562, -0.0529716355144438,
  -0.0980208811401368, 1.15190312990417,   -0.0980434501171241,
  -0.0990297440797205,-0.0989611768448433,  1.15107367264116);

// 6th-order fit to the AgX sigmoid; f(0.5) = 0.5 and f(log2(0.18) mapped) sits
// at 0.4967, i.e. middle grey lands on middle grey in display code values.
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
  // The "look" belongs here, on the sigmoid output and before the outset -- a
  // touch of saturation back into highlights that the per-channel curve ate.
  float l = dot(c, LW);
  c = l + (c - l) * (1.0 + 0.18*uHighlightRoll);
  c = clamp(AGX_OUT * c, 0.0, 1.0);
  // Undo AgX's built-in display encoding: this function owes its caller LINEAR.
  return pow(c, vec3(2.2));
}

const mat3 ACES_IN = mat3(0.59719,0.07600,0.02840, 0.35458,0.90834,0.13383, 0.04823,0.01566,0.83777);
const mat3 ACES_OUT = mat3(1.60475,-0.10208,-0.00327, -0.53108,1.10813,-0.07276, -0.07367,-0.00605,1.07602);
vec3 aces(vec3 c){
  // The fitted RRT clips hot colours to hard primaries; bleeding the brightest
  // values toward their own luminance first is the cheap stand-in for the glow
  // module and keeps the sun path from turning into a magenta hole.
  float l = dot(c, LW);
  float hot = 1.0 - 1.0/(1.0 + 0.06*max(l - 2.0, 0.0));
  c = mix(c, vec3(l), hot * clamp(uHighlightRoll, 0.0, 1.5) * 0.8);
  c = ACES_IN * c;
  vec3 a = c*(c+0.0245786) - 0.000090537;
  vec3 b = c*(0.983729*c + 0.4329510) + 0.238081;
  return clamp(ACES_OUT * (a/b), 0.0, 1.0);
}
vec3 reinhardJodie(vec3 c){
  float l = dot(c, LW);
  vec3 tc = c/(c+1.0);
  return clamp(mix(c/(l+1.0), tc, tc), 0.0, 1.0);
}

float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*0.1031); p3 += dot(p3, p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }

vec4 hash14(vec2 p){
  vec4 p4 = fract(vec4(p.xyxy) * vec4(0.1031, 0.1030, 0.0973, 0.1099));
  p4 += dot(p4, p4.wzxy + 33.33);
  return fract((p4.xxyz + p4.yzzw) * p4.zywx);
}

// ---------------------------------------------------------- water on the lens
//
// A droplet sitting on the front element is nowhere near the focal plane, so it
// does not behave like a little magnifier with a sharp picture inside it: it
// smears whatever is behind it and picks up a bright rim off the grazing light.
// That, plus the fact that they arrive in bursts and then creep outward under the
// airflow before drying, is the whole of the effect.
//
// A droplet and the streak it has been drawn into together make an ellipse
// elongated along the airflow, so cellularising in a frame stretched along that
// direction lets one cell hold one whole droplet - which is one hash per layer
// instead of a nine-cell neighbourhood search, and this runs on every pixel of
// the composite.
//
// The flow direction has to be constant across the frame. Deriving it per pixel
// from the radial direction seemed more physical - water is dragged outward from
// wherever the camera is pointed - but normalize(p) is perpendicular to its own
// perpendicular by construction, so the lattice's second coordinate came out
// identically zero and the whole field collapsed into concentric rings with no
// droplets in them at all. The radial character is put back below as a streak
// length that grows toward the edges, where the airflow is faster.
void lensLayer(vec2 p, float rn, float scale, float stretch, float sizeK,
               float seed, float wet,
               inout vec2 off, inout float blur, inout float rim, inout float cover){
  vec2 fl = uLensFlow;
  vec2 perp = vec2(-fl.y, fl.x);
  vec2 q = vec2(dot(p, fl) / max(stretch, 0.2), dot(p, perp)) * scale + seed;
  vec2 cell = floor(q);
  vec4 h = hash14(cell);
  // Only some cells ever hold a droplet, and the fraction rises with how wet the
  // lens is - so drying off thins the field rather than just fading it out.
  if (h.x > wet) return;

  // Its own clock: lands fast, sits, creeps, dries slowly.
  float life = 1.6 + 3.4 * h.y;
  float age  = fract(uTime / life + h.z);
  float amp  = smoothstep(0.0, 0.05, age) * (1.0 - smoothstep(0.5, 1.0, age));
  if (amp < 0.01) return;

  vec2 local = fract(q) - 0.5;
  vec2 c = (vec2(h.w, fract(h.x * 71.3)) - 0.5) * 0.44;
  // It creeps a little, and draws out into a tail as it goes. Expressing the
  // streak as elongation rather than as bodily translation is what keeps the
  // droplet inside the cell that owns it - sliding it out culls most of them
  // against the cell test before they are ever drawn.
  // Streaking grows toward the frame edge, where the airflow is faster - but only
  // mildly. At 0.9 the edge droplets were drawn out nearly twice as far as the
  // central ones, which thinned them and made the middle of the frame look like
  // where the water was landing.
  float tail = 1.0 + age * uLensStreak * 3.0 * (1.0 + 0.45 * rn);
  c.x += (age - 0.5) * uLensStreak * 0.30;
  float rad = (0.17 + 0.20 * h.y) * sizeK;
  vec2 dv = (local - c) / vec2(tail, 1.0);
  float dd = length(dv) / max(rad, 1e-3);
  if (dd > 1.06) return;

  // A spherical cap's slope grows toward its edge, which is why a droplet bends
  // the picture hardest around its rim and barely at all through its middle.
  float prof = max(1.0 - dd * dd, 0.0);
  vec2 dir = dv / max(length(dv), 1e-4);
  // Back into lens space: the offset has to point where the geometry does, not
  // where the stretched cell frame does.
  vec2 dirL = normalize(fl * dir.x * max(stretch, 0.2) + perp * dir.y + vec2(1e-6));
  off  -= dirL * dd * prof * uLensRefract * rad * amp;
  blur  = max(blur, amp * prof);
  rim  += amp * smoothstep(0.55, 0.97, dd) * (1.0 - smoothstep(1.0, 1.06, dd));
  cover = max(cover, amp * (1.0 - smoothstep(0.92, 1.04, dd)));
}

void main(){
  vec2 d = vUv - 0.5;
  vec2 asp = vec2(uRes.x/uRes.y, 1.0);
  // Aspect-corrected image-circle coordinates: one unit of p.y is one unit of
  // p.x is one unit of picture height, so "pixels" means the same thing in both.
  vec2 p = d * asp;
  float r2max = dot(0.5*asp, 0.5*asp);
  float rn2 = dot(p, p) / r2max;              // 0 at centre, 1 at the corner

  // Radial distortion, normalised so the corners stay pinned to the corners --
  // otherwise the frame samples outside the render target and smears.
  float kd = (1.0 + uDistortion * rn2) / (1.0 + uDistortion);
  vec2 pd = p * kd;
  vec2 base = pd / asp;

  // Lateral chromatic aberration: a pure radial scale difference between the
  // channels. uChromatic is the red-to-blue separation AT THE CORNER, in
  // pixels, so it stays a ~1px optical detail instead of tracking feature size
  // and painting rainbows onto every sub-pixel glint.
  // Water on the front element, in lens space - it belongs to the glass, so it
  // must not move with the radial distortion applied to the scene below.
  vec2  lensOff = vec2(0.0);
  float lensBlur = 0.0, lensRim = 0.0, lensCover = 0.0;
  if (uLensWet > 0.003){
    // The airflow over a housing at speed carries water up and off the glass.
    // Cell counts matter more than they look. At scale 5 with stretch 2.4 the
    // coarse layer had 2.1 rows across the whole frame height, so a big droplet
    // could only ever land in one of two vertical bands - and since the expected
    // count at riding wetness was 0.4, the one droplet you did get was almost
    // always the middle one. That is the "they mostly hit the centre". Finer
    // lattice, lower occupancy per cell: same number of droplets, spread over
    // ten times as many possible positions, and half the size.
    lensLayer(p, rn2, 10.0, 2.0, 1.00 * uLensSize,  0.0, uLensWet * uLensDrops,
              lensOff, lensBlur, lensRim, lensCover);
    lensLayer(p, rn2, 21.0, 1.6, 0.50 * uLensSize, 41.7, uLensWet * uLensDrops * 0.6,
              lensOff, lensBlur, lensRim, lensCover);
    // Before it beads up it is an unbroken film, which does not draw shapes - it
    // just softens and slightly swims.
    float fw = uLensWet * uLensFilm;
    if (fw > 0.002){
      lensOff += vec2(sin(p.y*8.5 + uTime*1.7), cos(p.x*10.5 - uTime*2.1)) * 0.004 * fw;
      lensBlur = max(lensBlur, fw * 0.40);
    }
  }
  vec2 lensUv = lensOff / asp;

  vec3 col;
  float caPx = uChromatic * rn2;
  if (caPx > 0.02){
    float len = max(length(pd), 1e-6);
    vec2 caStep = (pd/len) * (0.5 * caPx / uRes.y) / asp;
    col.r = texture(uSrc, 0.5 + base + lensUv + caStep).r;
    col.g = texture(uSrc, 0.5 + base + lensUv).g;
    col.b = texture(uSrc, 0.5 + base + lensUv - caStep).b;
  } else {
    col = texture(uSrc, 0.5 + base + lensUv).rgb;
  }

  // Whatever is behind a droplet is thrown far out of focus, so it has to be
  // sampled wide rather than sharp - a sharp image inside a droplet is the single
  // thing that makes this read as a decal stuck on the picture.
  if (lensBlur > 0.02){
    vec2 e = vec2(lensBlur * 0.012, 0.0) / asp;
    vec3 sm = texture(uSrc, 0.5 + base + lensUv + e).rgb
            + texture(uSrc, 0.5 + base + lensUv - e).rgb
            + texture(uSrc, 0.5 + base + lensUv + e.yx).rgb
            + texture(uSrc, 0.5 + base + lensUv - e.yx).rgb;
    col = mix(col, sm * 0.25, clamp(lensBlur, 0.0, 1.0) * 0.85);
  }

  vec2 buv = 0.5 + base + lensUv;
  vec3 bloom = texture(uBloom, buv).rgb;
  vec3 glare = texture(uGlare, buv).rgb;
  bloom = mix(bloom, bloom * uBloomTint, uBloomTintAmount);
  col += bloom * uBloomIntensity;
  // The wide tail, kept separate: a low, broad lift around every bright area
  // rather than a ring hugging the highlight.
  col += glare * uGlareIntensity;
  // The bright edge of each droplet: grazing light caught by the meniscus. Scaled
  // by what is actually behind it, so a droplet against a dark sea stays dark
  // instead of glowing on its own.
  if (lensRim > 0.001){
    vec3 around = texture(uBloom, buv).rgb + col;
    col += around * lensRim * uLensRim;
  }
  // A droplet has a body, not just an outline. Without this the rim was the only
  // thing marking it and the middle stayed as clear as the air around it, so they
  // read as soft rings drawn on the picture rather than as beads of water sitting
  // on the glass. Water absorbs a little and scatters the rest, so the body is a
  // slight darkening and a slight loss of saturation - both small, because the
  // thing is a millimetre of water and not a filter.
  if (lensCover > 0.002){
    float k = lensCover * uLensBody;
    float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = mix(col, mix(col, vec3(lum), 0.35) * 0.88, k);
  }
  // Halation is the red-weighted back-scatter off the film base / sensor stack.
  col += glare * uHalationTint * uHalation;

  col *= resolveExposure();

  // Natural (optical) vignetting belongs in scene-linear, ahead of the curve:
  // corners then lose exposure and roll off, instead of being painted grey.
  // Normalised so vd2 == 1 exactly at the corner, whatever the aspect ratio.
  float vr = mix(1.0, uRes.x/uRes.y, uVignetteRound);
  vec2 vv = vec2(d.x*vr, d.y);
  float vd2 = dot(vv, vv) / dot(vec2(0.5*vr, 0.5), vec2(0.5*vr, 0.5));
  float fall = 1.0 / ((1.0 + 0.55*vd2) * (1.0 + 0.55*vd2));   // ~ -1.3 stops at full
  col *= max(mix(1.0, fall, uVignette), 0.0);

  // Black point, subtracted in scene-linear the way a densitometer defines it.
  // Doing this before the curve means the shadows lose *exposure* and fall down
  // the toe; doing it after the curve would only paint the low end darker and
  // flatten it. Negative is the useful other direction -- flare on the print.
  col = max(col - uBlackPoint*0.02, vec3(0.0));

  // ---- grade, scene-referred, ahead of the tone curve ----
  col *= uWhiteBalance;
  col = col * uGain + uLift * max(1.0 - col, vec3(0.0));
  col = pow(max(col, vec3(0.0)), 1.0/max(uGammaCC, vec3(0.05)));
  float l0 = dot(col, LW);
  col = max(mix(vec3(l0), col, uSaturation), vec3(0.0));
  // Contrast about middle grey in log2 -- the axis a film curve works on. Doing
  // it linearly (as this used to) shears the highlights and fights the tonemap,
  // which is the other half of why the frame read flat.
  vec3 t = log2(max(col, vec3(1e-6))/0.18) * uContrast;

  // Film toe. Extra density that is zero at middle grey, ramps in over the
  // shadows and then saturates, so the wave backs gain weight without the
  // midtones moving. A Gaussian ramp keeps dD/dlogE positive everywhere, i.e.
  // the curve stays monotone and never inverts however hard it is driven --
  // which a plain shadow gamma does not.
  vec3 sh = max(-t, vec3(0.0)) / max(uToeRange, 0.25);
  t -= uToe * (1.0 - exp(-sh*sh));
  col = 0.18 * exp2(t);

  vec3 pre = col;
  if      (uTonemap == 0) col = agx(col);
  else if (uTonemap == 1) col = aces(col);
  else                    col = reinhardJodie(col);

  // Per-channel tone curves are what give film its highlight rolloff, but they
  // also drag every hot colour toward white -- the reason a lit sea can come out
  // of the shoulder as monochrome sepia. Steering part of the way back to the
  // scene chromaticity at the *displayed* luminance restores the hue without
  // undoing the rolloff. This is the same idea as AgX's outset, applied as a
  // continuously dialable amount.
  if (uChromaRestore > 0.0){
    float lp = dot(pre, LW), lt = dot(col, LW);
    col = clamp(mix(col, pre * (lt / max(lp, 1e-5)), uChromaRestore), 0.0, 1.0);
  }

  // Split toning. Every film stock and every graded photograph carries a
  // different hue in the toe than in the shoulder; a perfectly neutral ramp is
  // one of the tells that an image was rendered rather than shot.
  if (uSplit > 0.0){
    // The selector has to be perceptual, not linear: 0.5 in linear is 73% of
    // the way up the display ramp, so a linear crossover calls almost the whole
    // picture "shadow" and the highlight tint never arrives.
    float ls = pow(clamp(dot(col, LW), 0.0, 1.0), 1.0/2.2);
    col *= mix(vec3(1.0), uSplitShadow, (1.0 - smoothstep(0.0, 0.55, ls)) * uSplit);
    col *= mix(vec3(1.0), uSplitHigh,   smoothstep(0.45, 1.0, ls) * uSplit);
  }

  // Print saturation, after the curve, where it behaves like a film stock.
  float l1 = dot(col, LW);
  col = max(mix(vec3(l1), col, uPostSaturation), vec3(0.0));

  vec3 disp = pow(clamp(col, 0.0, 1.0), vec3(1.0/2.2));

  // Dither in display space, where the 8-bit quantisation actually happens.
  // (Grain is deliberately NOT here -- see FXAA_FS.)
  disp += (hash12(gl_FragCoord.xy*1.7 + fract(uTime)*13.0) - 0.5) / 255.0;

  fragColor = vec4(clamp(disp, 0.0, 1.0), 1.0);
}
`;

// Grain is added here, after the edge filter, not in the composite: an
// antialiaser cannot tell grain from aliasing and will happily average away
// most of it, which is why the frame ends up looking like clean video with a
// faint dirty overlay instead of like film.
export const FXAA_FS = /* glsl */`
in vec2 vUv;
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uAmount;
uniform float uGrain, uGrainSize, uGrainChroma, uGrainShadow, uTime;
out vec4 fragColor;
` + LUMA + /* glsl */`
float lum(vec3 c){ return dot(c, vec3(0.299,0.587,0.114)); }
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*0.1031); p3 += dot(p3, p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f*f*(3.0-2.0*f);
  float a = hash12(i), b = hash12(i+vec2(1,0)), c = hash12(i+vec2(0,1)), d = hash12(i+vec2(1,1));
  return mix(mix(a,b,f.x), mix(c,d,f.x), f.y);
}

// Grain lives in density space, so it goes on after the OETF. It peaks in the
// midtones: film has almost no visible grain in the toe or a blown highlight.
vec3 filmGrain(vec3 disp){
  if (uGrain <= 0.0) return disp;
  // Resample the grain field once per 24fps frame, at a decorrelated offset,
  // so it flickers like film rather than crawling along a diagonal.
  float fr = floor(uTime*24.0);
  vec2 gp = gl_FragCoord.xy / max(uGrainSize, 0.35)
          + vec2(hash12(vec2(fr, 1.7)), hash12(vec2(fr, 9.3))) * 512.0;
  float mono = vnoise(gp) - 0.5;
  vec3 chroma = vec3(vnoise(gp + 31.7), vnoise(gp + 71.3), vnoise(gp + 117.1)) - 0.5;
  vec3 g = mix(vec3(mono), chroma, uGrainChroma);
  float ld = dot(disp, LW);
  // Two different noises share this knob because both are real and they live in
  // opposite places: silver-halide granularity peaks in the midtones, while
  // sensor read noise is loudest where there is least signal. uGrainShadow
  // slides between "shot on film" and "shot at high ISO".
  float shape = mix(sqrt(clamp(4.0*ld*(1.0 - ld), 0.0, 1.0)),
                    1.0/(1.0 + 7.0*ld), uGrainShadow);
  return disp + g * (uGrain * 1.7) * (0.12 + 0.88*shape);
}

void main(){
  vec3 rgbM = texture(uSrc, vUv).rgb;
  if (uAmount <= 0.0){ fragColor = vec4(clamp(filmGrain(rgbM), 0.0, 1.0), 1.0); return; }
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
  fragColor = vec4(clamp(filmGrain(mix(rgbM, res, uAmount)), 0.0, 1.0), 1.0);
}
`;
