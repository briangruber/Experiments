// Atmosphere, clouds and celestial bodies.
//
// The expensive scattering integral is evaluated into a small lat-long LUT with
// a horizon-weighted latitude mapping (most of the interesting gradient lives in
// the few degrees either side of the horizon). Everything that needs sky
// radiance - the background pass, water reflections, spray lighting - samples
// that LUT, so the march runs once per frame instead of once per pixel.

export const NOISE_GLSL = /* glsl */`
float hash11(float p){ p = fract(p*0.1031); p *= p+33.33; p *= p+p; return fract(p); }
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*0.1031); p3 += dot(p3, p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
vec2  hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*vec3(0.1031,0.1030,0.0973)); p3 += dot(p3, p3.yzx+33.33); return fract((p3.xx+p3.yz)*p3.zy); }
float hash13(vec3 p){ p = fract(p*0.1031); p += dot(p, p.zyx+31.32); return fract((p.x+p.y)*p.z); }

float vnoise(vec3 p){
  vec3 i = floor(p), f = fract(p);
  f = f*f*(3.0-2.0*f);
  float n000=hash13(i+vec3(0,0,0)), n100=hash13(i+vec3(1,0,0));
  float n010=hash13(i+vec3(0,1,0)), n110=hash13(i+vec3(1,1,0));
  float n001=hash13(i+vec3(0,0,1)), n101=hash13(i+vec3(1,0,1));
  float n011=hash13(i+vec3(0,1,1)), n111=hash13(i+vec3(1,1,1));
  return mix(mix(mix(n000,n100,f.x), mix(n010,n110,f.x), f.y),
             mix(mix(n001,n101,f.x), mix(n011,n111,f.x), f.y), f.z);
}

float vnoise2(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f*f*(3.0-2.0*f);
  float a = hash12(i), b = hash12(i+vec2(1,0));
  float c = hash12(i+vec2(0,1)), d = hash12(i+vec2(1,1));
  return mix(mix(a,b,f.x), mix(c,d,f.x), f.y);
}

float fbm3(vec3 p, int oct){
  float a = 0.5, s = 0.0, n = 0.0;
  for (int i=0;i<8;i++){
    if (i>=oct) break;
    s += a * vnoise(p); n += a; a *= 0.5; p *= 2.02; p.xy += 7.13;
  }
  return s / max(n, 1e-4);
}

float fbm2(vec2 p, int oct){
  float a = 0.5, s = 0.0, n = 0.0;
  for (int i=0;i<6;i++){
    if (i>=oct) break;
    s += a * vnoise2(p); n += a; a *= 0.5; p = p*2.03 + vec2(5.1,-3.7);
  }
  return s / max(n, 1e-4);
}

// Worley-ish billow used for cloud erosion.
float billow(vec3 p, int oct){
  float a = 0.5, s = 0.0, n = 0.0;
  for (int i=0;i<6;i++){
    if (i>=oct) break;
    s += a * abs(vnoise(p)*2.0-1.0); n += a; a *= 0.5; p *= 2.11;
  }
  return 1.0 - s/max(n,1e-4);
}
`;

export const ATMOSPHERE_GLSL = /* glsl */`
const float R_PLANET = 6371000.0;
const float R_ATMOS  = 6471000.0;
const float TAU_A    = 6.28318530718;
const float PI_A     = 3.14159265359;
const vec3  BETA_R   = vec3(5.802e-6, 13.558e-6, 33.100e-6);
const float BETA_MS  = 3.996e-6;
const float BETA_MA  = 4.400e-6;
const vec3  BETA_O   = vec3(0.650e-6, 1.881e-6, 0.085e-6);
const float H_RAY    = 8000.0;
const float H_MIE    = 1200.0;

uniform float uTurbidity;
uniform float uOzone;
uniform vec3  uSunIrradiance;
uniform float uMieG;
uniform float uAtmoExposure;
uniform float uMultiScatter;
uniform float uMSFloor;
uniform float uMSHeight;

float rayleighPhase(float c){ return 3.0/(16.0*PI_A) * (1.0 + c*c); }
float miePhase(float c, float g){
  float g2 = g*g;
  return 3.0/(8.0*PI_A) * ((1.0-g2)*(1.0+c*c)) / ((2.0+g2)*pow(max(1.0+g2-2.0*g*c, 1e-4), 1.5));
}

// Distance to the outer atmosphere shell (assumes the origin is inside it).
float atmosDist(vec3 ro, vec3 rd){
  float b = dot(ro, rd);
  float c = dot(ro, ro) - R_ATMOS*R_ATMOS;
  float d = b*b - c;
  if (d < 0.0) return 0.0;
  return -b + sqrt(d);
}

float planetDist(vec3 ro, vec3 rd){
  float b = dot(ro, rd);
  float c = dot(ro, ro) - R_PLANET*R_PLANET;
  float d = b*b - c;
  if (d < 0.0 || (-b - sqrt(d)) < 0.0) return -1.0;
  return -b - sqrt(d);
}

void densities(vec3 p, out float dR, out float dM, out float dO){
  float h = max(length(p) - R_PLANET, 0.0);
  dR = exp(-h / H_RAY);
  dM = exp(-h / H_MIE) * uTurbidity;
  dO = max(0.0, 1.0 - abs(h - 25000.0) / 15000.0) * uOzone;
}

vec3 extinctionAt(vec3 p){
  float dR, dM, dO; densities(p, dR, dM, dO);
  return BETA_R*dR + vec3(BETA_MS+BETA_MA)*dM + BETA_O*dO;
}

// Air density falls off exponentially, so a uniform march over a path that can
// be a thousand kilometres long puts its very first sample above the bulk of
// the atmosphere. Cubing the parameter clusters samples where the mass is and
// makes the grazing-ray integral converge with a handful of steps - without it
// the horizon is quantised into a hard band and sunsets never redden.
float pathT(float tMax, float u){ return tMax * u*u*u; }

vec3 sunTransmittanceN(vec3 p, vec3 sunDir, int N){
  if (planetDist(p, sunDir) > 0.0) return vec3(0.0);
  float d = atmosDist(p, sunDir);
  vec3 od = vec3(0.0);
  float tPrev = 0.0;
  for (int i=0;i<8;i++){
    if (i>=N) break;
    float tNext = pathT(d, float(i+1)/float(N));
    float dt = tNext - tPrev;
    od += extinctionAt(p + sunDir*(tPrev + dt*0.5)) * dt;
    tPrev = tNext;
  }
  return exp(-od);
}
vec3 sunTransmittance(vec3 p, vec3 sunDir){ return sunTransmittanceN(p, sunDir, 8); }

// Source term for the >=2nd scattering orders. Those photons did not travel
// along this point's own sun ray: they arrive from the whole neighbourhood, and
// near the ground most of that neighbourhood is the thinner, brighter air
// *above*. One extra transmittance tap a couple of scale heights up stands in
// for that. It matters twice over: a constant floor is achromatic, which is
// precisely what paints a milky grey band across a golden-hour horizon, and it
// never switches off, which leaves a daylight-blue glow on the horizon hours
// after sunset. Lifting the sample makes both behave - the hue follows the
// transmitted sunlight, and the term dies as the terminator climbs past uMSHeight.
vec3 msSource(vec3 p, vec3 lightDir, vec3 tr){
  vec3 trHi = sunTransmittanceN(p + normalize(p)*uMSHeight, lightDir, 4);
  return tr*0.275 + trHi*(0.275 + uMSFloor);
}

// Fraction of light that gets re-scattered on a typical low path, per channel.
// Used to size the multiple-scattering series: blue is scattered ~5x more than
// red, so a grey multi-scatter constant is exactly what makes a sky look milky.
vec3 msGain(){
  vec3 tau = (BETA_R + vec3(BETA_MS)*uTurbidity*0.6) * H_RAY * 2.2;
  vec3 k = 1.0 - exp(-tau);
  return uMultiScatter * k / (1.0 - 0.82*k);
}

// Single scattering plus an energy-series multiple-scatter term.
vec3 skyScatter(vec3 ro, vec3 rd, vec3 lightDir, vec3 irradiance, int steps){
  float tMax = atmosDist(ro, rd);
  float tGround = planetDist(ro, rd);
  bool hitGround = tGround > 0.0;
  if (hitGround) tMax = tGround;
  if (tMax <= 0.0) return vec3(0.0);

  float cosT = dot(rd, lightDir);
  float pR = rayleighPhase(cosT);
  float pM = miePhase(cosT, uMieG);

  vec3 sumR = vec3(0.0), sumM = vec3(0.0), sumMS = vec3(0.0);
  vec3 od = vec3(0.0);
  float tPrev = 0.0;
  for (int i=0;i<64;i++){
    if (i>=steps) break;
    float tNext = pathT(tMax, float(i+1)/float(steps));
    float dt = tNext - tPrev;
    vec3 p = ro + rd*(tPrev + dt*0.5);
    tPrev = tNext;
    float dR, dM, dO; densities(p, dR, dM, dO);
    vec3 ext = BETA_R*dR + vec3(BETA_MS+BETA_MA)*dM + BETA_O*dO;
    // Midpoint transmittance: the steps are long, so evaluating at the segment
    // start over-counts the near end badly.
    vec3 trans = exp(-(od + ext*dt*0.5));
    od += ext*dt;
    vec3 tr = sunTransmittance(p, lightDir);
    vec3 sca = BETA_R*dR;
    vec3 scaM = vec3(BETA_MS)*dM;
    sumR += trans * tr * sca * dt;
    sumM += trans * tr * scaM * dt;
    // Higher orders lose the phase function but keep the colour of the light
    // that fed them, which is the whole point of msSource().
    sumMS += trans * (sca + scaM) * dt * msSource(p, lightDir, tr);
  }

  vec3 col = (sumR*pR + sumM*pM) * irradiance;
  col += sumMS * irradiance * msGain() / (4.0*PI_A);
  if (hitGround){
    // Sea reading below the horizon comes from the water pass, but the LUT still
    // needs something sane for downward reflection lookups: the ocean is a dark
    // Lambertian sheet lit by whatever made it down here.
    vec3 gTr = sunTransmittance(ro + rd*tGround, lightDir);
    col += gTr * irradiance * max(lightDir.y, 0.0) * 0.055 * exp(-od) / PI_A;
  }
  return col * uAtmoExposure;
}

vec3 skyRadianceRaw(vec3 ro, vec3 rd, vec3 sunDir, int steps){
  return skyScatter(ro, rd, sunDir, uSunIrradiance, steps);
}

// Analytic aerial perspective for surface shading at distance d.
void aerialPerspective(vec3 ro, vec3 rd, float d, vec3 sunDir, out vec3 inscatter, out vec3 transmit){
  const int N = 6;
  vec3 od = vec3(0.0), sum = vec3(0.0), sumMS = vec3(0.0);
  float cosT = dot(rd, sunDir);
  float pR = rayleighPhase(cosT), pM = miePhase(cosT, uMieG);
  float tPrev = 0.0;
  for (int i=0;i<N;i++){
    // Same cube-law spacing: near the camera the haze builds fastest.
    float tNext = d * pow(float(i+1)/float(N), 1.6);
    float dt = tNext - tPrev;
    vec3 p = ro + rd*(tPrev + dt*0.5);
    tPrev = tNext;
    float dR, dM, dO; densities(p, dR, dM, dO);
    vec3 ext = BETA_R*dR + vec3(BETA_MS+BETA_MA)*dM + BETA_O*dO;
    vec3 tr = exp(-(od + ext*dt*0.5));
    od += ext*dt;
    vec3 st = sunTransmittance(p, sunDir);
    vec3 sca = BETA_R*dR, scaM = vec3(BETA_MS)*dM;
    sum += tr * st * (sca*pR + scaM*pM) * dt;
    sumMS += tr * (sca + scaM) * dt * msSource(p, sunDir, st);
  }
  inscatter = (sum + sumMS * msGain() / (4.0*PI_A)) * uSunIrradiance * uAtmoExposure;
  transmit = exp(-od);
}
`;

// Maps a direction to LUT uv with extra resolution packed around the horizon.
export const SKY_LUT_MAP_GLSL = /* glsl */`
vec2 dirToSkyUv(vec3 d){
  float az = atan(d.z, d.x) / 6.28318530718 + 0.5;
  float l = clamp(d.y, -1.0, 1.0);
  float v = 0.5 + 0.5*sign(l)*sqrt(abs(l));
  return vec2(az, v);
}
vec3 skyUvToDir(vec2 uv){
  float az = (uv.x - 0.5) * 6.28318530718;
  float t = uv.y*2.0 - 1.0;
  float l = sign(t)*t*t;
  float r = sqrt(max(0.0, 1.0 - l*l));
  return vec3(cos(az)*r, l, sin(az)*r);
}
`;

export const SKY_LUT_FS = /* glsl */`
${ATMOSPHERE_GLSL}
${SKY_LUT_MAP_GLSL}
in vec2 vUv;
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform vec3 uMoonColor;
uniform float uEyeHeight;
out vec4 fragColor;
void main(){
  vec3 rd = skyUvToDir(vUv);
  vec3 ro = vec3(0.0, R_PLANET + max(uEyeHeight, 1.0), 0.0);
  vec3 col = skyScatter(ro, rd, uSunDir, uSunIrradiance, 24);
  // Moonlight is the same integral with a much dimmer, cooler source. It is
  // what keeps a night sky deep blue instead of pure black, and it is what the
  // water reflects, so it belongs in the LUT rather than the background pass.
  if (dot(uMoonColor, uMoonColor) > 1e-8 && uMoonDir.y > -0.25){
    col += skyScatter(ro, rd, uMoonDir, uMoonColor, 12);
  }
  fragColor = vec4(col, 1.0);
}
`;

// Full-quality background: LUT gradient + sun/moon discs + volumetric clouds.
export const SKY_BG_FS = /* glsl */`
${ATMOSPHERE_GLSL}
${SKY_LUT_MAP_GLSL}
${NOISE_GLSL}
in vec2 vUv;
uniform sampler2D uSkyLUT;
uniform mat4 uInvViewProj;
uniform vec3 uCamPos, uSunDir, uMoonDir, uMoonColor;
uniform float uTime;
uniform float uSunAngularRadius, uSunDiscIntensity;
uniform float uCloudCoverage, uCloudDensity, uCloudAltitude, uCloudThickness;
uniform float uCloudSpeed, uCloudDetail, uCirrus, uStars, uCloudSteps;
uniform float uCloudScale, uCloudShape, uCloudExtinction, uCloudAnvil;
uniform float uCloudMS, uCloudPowder, uCloudAmbient, uCloudSilver, uCloudMaxDist;
uniform float uCloudAmbFloor, uStarSize, uSkyDither;
uniform float uSunLimb, uDiscFlatten, uDiscCap, uStarColorTemp, uStarCutoff;
uniform float uCloudHaze, uCloudFade, uCirrusCurl, uCirrusMask, uCirrusAlt;
uniform vec3  uWindDirV;
out vec4 fragColor;

// Angular radius from a body's centre, with the vertical axis compressed.
// Differential refraction lifts the lower limb of a low sun more than the upper
// one; at true sunset the disc is visibly wider than it is tall, and that
// squash is one of the strongest "this is a photograph" cues there is.
float discAngle(vec3 rd, vec3 dir, float flatten){
  vec3 up = normalize(vec3(0.0,1.0,0.0) - dir*dir.y + vec3(1e-6,0.0,0.0));
  vec3 rt = normalize(cross(dir, up));
  float dz = dot(rd, dir);
  vec2 off = vec2(dot(rd, rt), dot(rd, up) * flatten);
  return atan(length(off), max(dz, 1e-4));
}

// Refraction only bites in the last couple of degrees, and it is a *ratio* of
// vertical to horizontal extent, so it scales the vertical offset.
float refractFlatten(float elevSin){
  float e = asin(clamp(elevSin, -1.0, 1.0));
  return 1.0 + uDiscFlatten * exp(-max(e, -0.02) / 0.035);
}

// RGBA16F tops out at 65504, and the raw solar disc radiance is ~3e5, so it has
// to be capped or the tonemap turns +Inf into NaN and the sun renders black.
// Scale the whole triple by its brightest channel, never clamp per channel: a
// per-channel min flattens R, G and B onto the same ceiling and deletes exactly
// the reddening sunTransmittance just computed - a white sun in an orange sky.
vec3 capRadiance(vec3 c, float maxV){
  float m = max(max(c.r, c.g), c.b);
  return c * (maxV / (maxV + m));   // soft, hue-preserving, asymptotic to maxV
}

// Explicit LOD 0, always. The LUT is mipped (the water pass needs its top mips
// for diffuse irradiance) and the implicit derivative of the lat-long mapping
// grows with elevation, so an implicit fetch crosses mip levels partway up the
// sky and lays down horizontal seams right across the frame.
vec3 sampleSky(vec3 rd){ return textureLod(uSkyLUT, dirToSkyUv(rd), 0.0).rgb; }

// Same fetch, with the sample point jittered inside its texel. Bilinear
// reconstruction of a smooth gradient is only C0, so every texel row shows up
// as a Mach band; trading that quantisation for sub-texel noise is invisible
// once the film grain in post lands on top of it.
vec3 sampleSkyDither(vec3 rd, vec2 fc){
  vec2 uv = dirToSkyUv(rd);
  vec2 texel = 1.0 / vec2(textureSize(uSkyLUT, 0));
  vec2 j = (vec2(hash12(fc), hash12(fc + 37.7)) - 0.5) * uSkyDither * texel;
  return textureLod(uSkyLUT, uv + j, 0.0).rgb;
}

// ---- clouds -----------------------------------------------------------------
// Density is three separable pieces so that even a coarse march sees the right
// silhouette: a 2D weather field decides *where* there is cloud at all, a
// vertical profile gives it a base and a top, and a detail band is folded in
// only when the step length can actually resolve it. The old version subtracted
// 150 m erosion noise while stepping 3 km, which is exactly how you get
// salt-and-pepper instead of cloud.

float remap01(float x, float lo, float hi){ return clamp((x - lo) / max(hi - lo, 1e-4), 0.0, 1.0); }

const float BAYER16[16] = float[16](
   0.0,  8.0,  2.0, 10.0,
  12.0,  4.0, 14.0,  6.0,
   3.0, 11.0,  1.0,  9.0,
  15.0,  7.0, 13.0,  5.0);
float bayer4(vec2 c){
  ivec2 p = ivec2(mod(c, 4.0));
  return (BAYER16[p.y*4 + p.x] + 0.5) / 16.0;
}

// Summed value noise is a near-Gaussian that only really occupies the middle
// third of [0,1]. Every threshold below assumes a full-range field, so stretch
// it once here instead of hand-tuning every constant against a hidden scale.
float spread01(float x){ return smoothstep(0.28, 0.72, x); }

vec2 cloudDrift(){ return uWindDirV.xz * uTime * uCloudSpeed; }

// x = coverage 0..1, y = cloud type (0 flat stratus .. 1 towering cumulus).
vec2 cloudWeather(vec2 xz){
  vec2 w = (xz + cloudDrift()) / max(uCloudScale, 200.0);
  float c = spread01(fbm2(w, 4));
  // Cloud type has to vary on roughly the cluster scale, otherwise every cloud
  // in frame is the same height and the deck reads as one extruded pancake.
  float t = spread01(fbm2(w*1.3 + 41.3, 3));
  // Coverage knob slides the threshold across the whole noise range so 0 is a
  // clear sky and 1 is solid overcast, with a soft edge either way.
  float thr = 1.04 - uCloudCoverage*1.12;
  float cov = remap01(c, thr, thr + 0.34);
  // The march has a finite range and cutting it off geometrically draws a ruled
  // line across the sky - the cloud-base shell crossing runs past the limit at a
  // definite elevation, which is exactly what makes a horizon deck present the
  // flat bottom edge that reads as a distant coastline. Taper the *coverage*
  // instead: clusters shrink and drop out one at a time, so the band breaks into
  // separate cells and dissolves into haze the way real distant cumulus does.
  // It only thins the field - it must not clear it, or an overcast deck opens a
  // bright hole on the horizon, which is a worse lie than the wall.
  float dxz = length(xz - uCamPos.xz);
  float far = max(uCloudMaxDist, 4000.0);
  cov *= 1.0 - 0.45*remap01(dxz, far*uCloudFade, far);
  return vec2(cov, t);
}

float heightProfile(float h, float type){
  // Condensation level is sharp, so cumulus bases are nearly flat - but not
  // razor sharp, or the deck terminates on a ruled plane.
  float base = smoothstep(0.0, mix(0.06, 0.16, type), h);
  // topB must stay inside the slab: clipping it at h = 1 shears every tall
  // cloud off along the same plane and the deck reads as an extruded sheet.
  float topA = mix(0.13, 0.55, type);
  float topB = mix(0.32, 0.98, type);
  // Anvil flattens the top and spreads it - the difference between a fair
  // weather cumulus and a squall line.
  topB = mix(topB, topB*0.62, uCloudAnvil);
  float top = smoothstep(topB, topA, h);
  return base * top;
}

// lod 0 = full detail, 1 = shape only.
float cloudDensity(vec3 p, float alt, float lod){
  float h0 = (alt - uCloudAltitude) / max(uCloudThickness, 1.0);
  // A little wind shear leans the column downwind and stops the weather map
  // reading as a pure vertical extrusion. It has to stay small: a large linear
  // shear sweeps every coverage edge through height and flutes the cloud.
  vec2 shear = normalize(uWindDirV.xz + vec2(1e-3,0.0)) * clamp(h0,0.0,1.2) * uCloudThickness * 0.13;
  vec2 wth = cloudWeather(p.xz + shear);
  if (wth.x <= 0.002) return 0.0;
  // A common condensation level is real, but a *perfectly* common one draws a
  // ruled line across the sky, so let each cluster sit a little high or low.
  float h = h0 - (wth.y - 0.5) * 0.34;
  if (h < 0.0 || h > 1.0) return 0.0;
  float prof = heightProfile(h, wth.y);
  if (prof <= 0.002) return 0.0;

  // Billow size tracks cloud type: a flat stratus deck is finely mottled, a
  // towering cumulus is built from far larger lobes. One global billow size
  // gives every cloud in frame the same grain, which is a texture, not weather.
  float S = max(uCloudShape, 50.0) * mix(0.72, 1.30, wth.y);
  vec3 q = vec3(p.x + cloudDrift().x, alt, p.z + cloudDrift().y) / S;
  q.y += uTime * uCloudSpeed * 0.0022;   // slow internal churn
  // Perlin fbm is the connective tissue; the billow supplies the rounded
  // cumuliform lumps. Weighted toward the fbm on purpose - a billow-dominated
  // field puts a hard ridged relief on the first-hit surface and the deck reads
  // as a mountain range. And no hard contrast curve here: a steep density
  // gradient in world space is exactly what turns a volume into an isosurface.
  int oct = lod < 0.5 ? 4 : 3;
  float shape = spread01(mix(fbm3(q, oct), billow(q*1.27 + 5.1, oct-1), 0.34));

  // Nubis-style remap: the threshold rides on coverage*profile, so density
  // decays smoothly to zero at cluster edges and at the base and top rather
  // than terminating on a contour. The extra falloff makes the decay quadratic
  // where the cloud is thin - that is what lets a silhouette fray - but it has
  // to saturate well before full coverage or an overcast deck goes translucent.
  float covp = wth.x * prof;
  float d = remap01(shape, 1.0 - covp, 1.0) * smoothstep(0.0, 0.55, covp);
  if (d <= 0.0) return 0.0;

  float det = uCloudDetail * (1.0 - lod);
  if (det > 0.004){
    float hi = spread01(billow(q*3.3 + 13.7, 2));
    // Wispy shredding at the base, billowed cauliflower toward the top.
    float m = mix(1.0 - hi, hi, clamp(h*2.4, 0.0, 1.0));
    // remap01 is self-limiting: it bites hardest where d is already small, so
    // the erosion nibbles the edge instead of drilling holes through the body.
    // Applied as a multiplier rather than a replacement so the interior keeps
    // the density the coverage remap gave it and only the rim thins out.
    d *= remap01(d, m*det*0.5, 1.0);
  }
  return d * uCloudDensity;
}

// Cone taps for the light march. A pencil of samples gives razor-sharp
// self-shadowing that reads as terrain relief; real cloud shadows are blurred
// by the multiple scattering that delivered the light in the first place.
const vec3 LCONE[5] = vec3[5](
  vec3( 0.00, 0.00, 0.00), vec3( 0.34, 0.19,-0.16),
  vec3(-0.28, 0.09, 0.31), vec3( 0.06,-0.31,-0.25), vec3(-0.19,-0.15, 0.24));

// Optical depth toward the light. Geometric spacing plus a long tail sample so a
// 3 km cumulus actually shadows its own base.
float cloudLightOD(vec3 p, float alt, vec3 L){
  float od = 0.0, t = 0.0, dl = 110.0;
  for (int i=0;i<5;i++){
    float tm = t + dl*0.5;
    vec3 o = L*tm + LCONE[i]*tm*0.34;
    od += cloudDensity(p + o, alt + o.y, 1.0) * dl;
    t += dl; dl *= 1.9;
  }
  od += cloudDensity(p + L*(t+1000.0), alt + L.y*(t+1000.0), 1.0) * 1800.0;
  return od * uCloudExtinction;
}

// Multiple-scattering octaves: each successive order is dimmer, more isotropic
// and penetrates deeper. This is what makes a thick cloud bright white instead
// of black, and what puts the silver lining on a backlit edge.
float cloudPhaseEnergy(float od, float mu){
  float a = 1.0, b = 1.0, g = 1.0;
  float lum = 0.0;
  for (int n=0;n<4;n++){
    // Each order is dimmer, penetrates deeper (lower effective extinction) and
    // has lost most of its directionality: by the third bounce the field inside
    // a cloud is essentially isotropic, which is why a thick cumulus reads as
    // uniformly white rather than as one big Mie lobe swung round the sun.
    float ph = mix(miePhase(mu, 0.80*g), miePhase(mu, -0.42*g), 0.32);
    lum += a * mix(0.25/PI_A, ph, g*g) * exp(-od * b);
    a *= uCloudMS; b *= 0.5; g *= 0.5;
  }
  // Four orders is nowhere near enough: a cloud droplet's single-scatter albedo
  // is ~1, so nearly all of the light that goes in comes back out and a real
  // sunlit cumulus top sits near albedo*E/pi. Truncating the series without its
  // tail is what leaves clouds several times too dark and makes them read as
  // grey cutouts against a bright sky.
  lum += a / max(1.0 - uCloudMS, 0.05) * (0.25/PI_A) * exp(-od*0.12);
  return lum;
}

float shellFar(vec3 c, vec3 rd, float R){
  float b = dot(c, rd);
  float disc = b*b - (dot(c,c) - R*R);
  if (disc < 0.0) return -1.0;
  return -b + sqrt(disc);
}

// Scattered radiance leaving a cloud element toward the eye for one light.
// Factored out because a cloud lit only by the sun is a black cutout the moment
// the sun sets, and a moonlit deck with a glitter path on the water underneath
// it plainly has lit tops.
vec3 cloudLight(vec3 p, float alt, vec3 L, vec3 col, float mu){
  if (dot(col, col) < 1e-10) return vec3(0.0);
  float od = cloudLightOD(p, alt, L);
  float lum = cloudPhaseEnergy(od, mu);
  // Powder: near the lit surface a single scattering event is unlikely, so
  // edges facing away from the light go dark. Only applies backlit-ish.
  float powder = 1.0 - exp(-od * 2.6);
  lum *= mix(1.0, powder, uCloudPowder * (0.5 - 0.5*mu));
  // Silver lining: the thin rim of a backlit cloud transmits forward-scattered
  // light almost unattenuated. Gated on a *short* light path so it lands on the
  // rim rather than washing the whole disc.
  lum += uCloudSilver * pow(max(mu, 0.0), 6.0) * exp(-od*1.6) * 0.5;
  return col * lum;
}

vec4 marchClouds(vec3 ro, vec3 rd, vec3 sunDir, vec3 sunColor,
                 vec3 moonDir, vec3 moonColor, vec3 skyTop, vec3 skyLow){
  if (uCloudCoverage <= 0.002 || uCloudDensity <= 0.001) return vec4(0.0);
  vec3 c = vec3(0.0, R_PLANET + max(ro.y, 0.5), 0.0);
  if (planetDist(c, rd) > 0.0) return vec4(0.0);

  float lo = uCloudAltitude, hi = uCloudAltitude + uCloudThickness;
  // Spherical shells, not planes: the deck then genuinely converges on the
  // horizon instead of shooting off to infinity as rd.y goes to zero.
  float t0 = ro.y < lo ? shellFar(c, rd, R_PLANET + lo) : 0.0;
  float t1 = shellFar(c, rd, R_PLANET + hi);
  if (t1 <= 0.0) return vec4(0.0);
  t0 = max(t0, 0.0);
  float far = max(uCloudMaxDist, 4000.0);
  t1 = min(t1, far);
  if (t1 <= t0) return vec4(0.0);

  int steps = int(uCloudSteps);
  float span = t1 - t0;
  // The coarse step is a search step: if it strides past a whole cumulus the
  // hit becomes jitter-dependent and the deck stipples. Cap it well under the
  // billow scale and let the iteration budget - not the step length - bound the
  // range.
  float dtC = clamp(span / float(steps), 35.0, 300.0);
  float dtF = clamp(dtC * 0.30, 15.0, 90.0);
  float lodStep = remap01(dtF, 45.0, 260.0);
  int maxIter = min(steps*4, 256);

  // An ordered 4x4 dither, not a white-noise hash and not interleaved-gradient
  // noise: the hash clumps into salt-and-pepper and IGN's frequency is far
  // higher in x than in y, which combs a still frame into vertical stripes.
  // The hash term only fills in *within* a Bayer bucket - 16 discrete phases
  // leave a whole scanline sampling the same t values, which is what draws the
  // horizontal streaks across a thin deck.
  float ign = fract(bayer4(gl_FragCoord.xy) + hash12(gl_FragCoord.xy)*0.0625);
  float t = t0 + dtC*ign;

  vec3 scatter = vec3(0.0);
  float trans = 1.0;
  float mu = dot(rd, sunDir);
  float muM = dot(rd, moonDir);
  bool inside = false;
  int empty = 0;
  float distSum = 0.0, distW = 0.0;

  for (int i=0;i<256;i++){
    if (i >= maxIter || t > t1 || trans < 0.015) break;
    float dt = inside ? dtF : dtC;
    vec3 p = ro + rd*t;
    float alt = length(c + rd*t) - R_PLANET;
    // LOD must depend only on the ray, never on which mode the march is in:
    // if the coarse search tests a different density field from the one the
    // fine march integrates, it steps over cloud the fine pass would have found
    // and the miss is decided by the dither offset - which is a hole per pixel.
    // The distance term must not outrun the projected size of the detail band:
    // at 25 km a 400 m wisp is still ~20 px across, and dropping it there is
    // what left far cloud as featureless dough. Step length, not range, is the
    // thing that actually forces the LOD down.
    float lod = max(lodStep, remap01(t, 18000.0, 70000.0));
    float d = cloudDensity(p, alt, lod);

    if (!inside){
      if (d > 0.0){
        // Back up one coarse step and re-enter with fine steps so the leading
        // edge is not chopped off at coarse resolution. The offset has to be
        // dithered as well: an undithered fine lattice quantises every
        // silhouette to one fine step and draws a comb across the cloud.
        inside = true; empty = 0;
        t = max(t - dtC + dtF*ign, t0);
        continue;
      }
      t += dt;
      continue;
    }

    if (d <= 0.0){
      empty++;
      if (empty > 4) { inside = false; empty = 0; }
      t += dt;
      continue;
    }
    empty = 0;

    float sigma = d * uCloudExtinction;
    float hRel = clamp((alt - lo) / max(uCloudThickness, 1.0), 0.0, 1.0);
    vec3 direct = cloudLight(p, alt, sunDir, sunColor, mu)
                + cloudLight(p, alt, moonDir, moonColor, muM);

    // An optically thin element sitting in a roughly isotropic radiance field
    // re-emits that field: in the thin limit the source function IS the sky
    // radiance, which is why a wisp of cirrus is invisible against blue sky.
    // The old 0.45*0.28 floor made every thin edge *darker* than the sky behind
    // it - hence dark streaks across the deck and shadow sides that went brown
    // instead of blue-grey.
    float ao = mix(uCloudAmbFloor, 1.0, hRel);
    vec3 amb = mix(skyLow, skyTop, hRel) * uCloudAmbient * ao;
    vec3 lightIn = direct + amb;

    float tr = exp(-sigma * dt);
    scatter += trans * lightIn * (1.0 - tr);
    distSum += t * trans * (1.0 - tr);
    distW += trans * (1.0 - tr);
    trans *= tr;
    t += dt;
  }

  // The march bails early rather than at trans = 0; renormalise so a saturated
  // cloud really does reach alpha 1. A leftover 0.4% is not a rounding detail:
  // a star is two orders of magnitude brighter than a moonlit cloud, so 0.4%
  // of it is still plainly visible *through* a 3 km cumulus.
  float alpha = clamp((1.0 - trans) / 0.985, 0.0, 1.0);
  if (alpha <= 0.001) return vec4(0.0);
  float dist = distW > 1e-5 ? distSum/distW : t0;

  // Haze the deck with distance so far clouds sit behind the same air the water
  // does, instead of staying crisp all the way to the horizon. Mie dominates at
  // cloud level and it is what actually washes a distant deck out into the sky,
  // so it gets its own weight rather than riding on turbidity alone.
  float meanD = exp(-(uCloudAltitude + uCloudThickness*0.35) / H_RAY);
  vec3 hazeTr = exp(-(BETA_R + vec3(BETA_MS+BETA_MA)*uTurbidity) * meanD * dist * uCloudHaze);

  // The march has a hard range limit, and the elevation at which the cloud-base
  // shell crossing runs past it is a *line* across the sky. Fading alpha there
  // would punch a bright hole in an overcast deck; driving the deck fully into
  // the air colour instead makes the truncation literally invisible, because
  // what is left is the same sky the background pass already drew.
  hazeTr *= 1.0 - remap01(dist, far*uCloudFade, far);
  vec3 air = sampleSky(rd);
  return vec4(scatter * hazeTr + air * (1.0 - hazeTr) * alpha, alpha);
}

// ---- cirrus -----------------------------------------------------------------
float cirrusLayer(vec3 rd, vec3 ro, float pxAng, out float dist){
  dist = 0.0;
  if (uCirrus <= 0.002) return 0.0;
  vec3 c = vec3(0.0, R_PLANET + max(ro.y, 0.5), 0.0);
  if (planetDist(c, rd) > 0.0) return 0.0;
  float H = max(uCirrusAlt, 4000.0);
  float t = shellFar(c, rd, R_PLANET + H);
  if (t <= 0.0 || t > 400000.0) return 0.0;
  dist = t;

  // Distance to the shell goes as H/elevation, so d(range)/d(pixel) grows as
  // t^2/H: within a few degrees of the horizon one pixel covers KILOMETRES of
  // the layer. A five-octave field sampled that coarsely does not look like
  // cirrus, it aliases into a fan of perfectly straight converging stripes -
  // that fan, not the wind shear, is what read as a ruled venetian-blind hatch.
  // Drop octaves as the footprint grows and dissolve the veil before it aliases.
  float fp = (t*t/H) * pxAng / 9000.0;
  int oct = fp > 0.30 ? 2 : (fp > 0.10 ? 3 : 5);
  float aa = 1.0 - smoothstep(0.22, 0.85, fp);
  if (aa <= 0.002) return 0.0;
  // Cirrus fibres are kilometre-scale; at 34 km per noise cell the whole sky
  // fits inside one lobe and the veil reads as a single grey smear.
  vec2 xz = (ro.xz + rd.xz*t + uWindDirV.xz*uTime*uCloudSpeed*2.2) / 9000.0;
  vec2 w = normalize(uWindDirV.xz + vec2(1e-3, 0.0));
  vec2 s = vec2(dot(xz, w), dot(xz, vec2(-w.y, w.x)));

  // Shear alone draws a ruled hatch: parallel, evenly spaced, edge to edge. Real
  // cirrus is fibrous and hooked, because the fall streaks are dragged through a
  // sheared wind field. It takes TWO scales of domain warp to get that: a single
  // coarse field whose period is wider than the frame only slides the whole
  // sheet sideways, and the streaks stay as straight as they ever were. The
  // tight field is the one that does the visible bending.
  vec2 g0 = vec2(fbm2(s*0.30 + 4.7, 3),  fbm2(s*0.30 + 19.1, 3)) - 0.5;
  vec2 g1 = vec2(fbm2(s*1.15 + 31.4, 2), fbm2(s*1.15 + 57.2, 2)) - 0.5;
  s += (vec2(-g0.y, g0.x)*2.4 + vec2(-g1.y, g1.x)*0.75) * uCirrusCurl;
  // Even spacing is the other half of the ruled-hatch read, so let the
  // cross-wind scale breathe: no two fibres then sit the same distance apart.
  s.y *= 1.0 + g0.x * uCirrusCurl * 0.9;
  s *= vec2(0.55, 1.6);
  float f = spread01(fbm2(s, oct));
  f = remap01(f, 0.62 - uCirrus*0.42, 1.0);

  // Independent low-frequency mask so the veil is patchy: without it every
  // streak runs the full width of the frame at constant density, which is the
  // single most obvious tell that it is procedural.
  float mask = smoothstep(0.30, 0.78, fbm2(xz / max(uCirrusMask, 0.05) + 61.7, 3));
  return f * f * mask * aa * smoothstep(0.0, 0.05, rd.y);
}

// Stars need a point-spread function measured in *pixels*, not in noise cells:
// a star whose profile is narrower than a pixel is a single blown texel and
// reads as a dead pixel, which is an instant tell. pxAng is the angular size of
// a pixel, so the disc stays the same apparent size at any resolution or zoom.
vec3 starField(vec3 rd, float pxAng){
  if (uStars <= 0.001) return vec3(0.0);
  const float DENS = 190.0;      // cells per unit direction; ~6k stars on the sphere
  vec3 p = rd * DENS;
  vec3 base = floor(p - 0.5);
  // The PSF can now spill across a cell boundary, so the 2x2x2 neighbourhood
  // has to be visited or stars get clipped in half along the lattice.
  // The floor has to stay well under a pixel: at 720p one cell is ~4 px, so a
  // 0.32-cell sigma is a 1.3 px sigma - a 4 px lump, which is what turned the
  // field into a scatter of identical blobs. A real star is a sub-pixel point
  // spread by the optics, so let the pixel footprint drive it and keep the floor
  // only as an anti-alias guard.
  float sig = max(max(uStarSize, 0.25) * pxAng * DENS, 0.16);
  float inv2 = 0.5/(sig*sig);
  float air = 1.0 / max(rd.y + 0.06, 0.06);
  float ext = exp(-0.11*(air - 1.0)) * smoothstep(-0.015, 0.035, rd.y);
  if (ext <= 0.001) return vec3(0.0);
  vec3 sum = vec3(0.0);
  for (int i=0;i<8;i++){
    vec3 c = base + vec3(float(i & 1), float((i >> 1) & 1), float((i >> 2) & 1));
    float h = hash13(c);
    // uStarCutoff is a limiting-magnitude control: raising it thins the field to
    // the bright stars a photographic exposure would actually record.
    if (h < uStarCutoff) continue;
    vec3 cc = c + 0.5 + (vec3(hash13(c+1.0), hash13(c+2.0), hash13(c+3.0)) - 0.5)*0.9;
    float r2 = dot(p - cc, p - cc);
    // Steep magnitude distribution: a real field is a handful of bright stars in
    // a haze of faint ones, not a uniform scatter of equal dots.
    // Real magnitude distribution spans many stops: one Vega for a hundred
    // 5th-magnitude specks. A shallow exponent gives a field of equal white
    // dots, which is what made this read as snow rather than sky.
    float mag = pow(hash13(c+7.0), 6.2);
    // Gaussian core plus a faint wide halo - the halo is what stops a bright
    // star looking like a sticker.
    float psf = exp(-r2*inv2) + 0.035/(1.0 + r2*inv2*0.10);
    // Scintillation is atmospheric, so it is far stronger near the horizon.
    float tw = 1.0 - 0.4*min(air*0.09, 1.0)*(0.5 + 0.5*sin(uTime*3.1 + h*190.0));
    // Stellar colour is a subtle B-V shift, not a saturated hue.
    // Most naked-eye stars are white to blue-white; the K/M giants that read
    // orange are the minority, so bias the draw rather than splitting it evenly.
    vec3 tint = mix(vec3(1.0), mix(vec3(1.0,0.88,0.76), vec3(0.78,0.86,1.0),
                                   pow(hash13(c+3.7), 0.42)), uStarColorTemp);
    sum += tint * mag * psf * tw;
  }
  return sum * ext * uStars * 1.1;
}

void main(){
  vec4 ndc = vec4(vUv*2.0-1.0, 1.0, 1.0);
  vec4 wp = uInvViewProj * ndc;
  vec3 rd = normalize(wp.xyz/wp.w - uCamPos);
  // Angular footprint of one pixel: drives the star PSF and the disc antialias
  // so neither depends on render resolution.
  float pxAng = max(length(fwidth(rd)) * 0.7, 1e-6);

  vec3 col = sampleSkyDither(rd, gl_FragCoord.xy);
  vec3 atmoRo = vec3(0.0, R_PLANET + max(uCamPos.y, 1.0), 0.0);
  vec3 sunTr = sunTransmittance(atmoRo, uSunDir);
  vec3 sunCol = uSunIrradiance * sunTr * uAtmoExposure;

  // Stars behind everything, drowned by airglow as soon as the sky lifts. A
  // reciprocal rather than an exponential: moonlit sky is already ~100x a star,
  // and an exponential falloff tuned to kill stars by day also kills them on
  // any night with a moon in it.
  float night = 1.0 / (1.0 + dot(col, vec3(0.2126,0.7152,0.0722)) * 240.0);
  col += starField(rd, pxAng) * night;

  // Moon: a real disc, reddened and flattened by the same air the sun is.
  float moonR = 0.00475;
  float mAng = discAngle(rd, uMoonDir, refractFlatten(uMoonDir.y));
  vec3 moonTr = sunTransmittance(atmoRo, uMoonDir);
  // Antialias the limb against the pixel footprint - a hard step on a disc this
  // small is a staircase of blown texels.
  float mDisc = 1.0 - smoothstep(moonR - pxAng*0.8, moonR + pxAng*0.8, mAng);
  if (mDisc > 0.0){
    // The moon is a rough Lambertian ball, not a limb-darkened star: it is
    // nearly uniform across the disc with a slight brightening at the edge.
    float m = sqrt(max(0.0, 1.0 - (mAng/moonR)*(mAng/moonR)));
    float solid = TAU_A * (1.0 - cos(moonR));
    vec3 disc = uMoonColor / max(solid, 1e-7) * (0.62 + 0.38*m) * mDisc * moonTr * uAtmoExposure * 0.04;
    col += capRadiance(disc, uDiscCap);
  }
  // Moon aureole from forward Mie scattering in the haze around it.
  col += uMoonColor * moonTr * pow(max(dot(rd, uMoonDir),0.0), 340.0) * 0.7 * uAtmoExposure;

  // Sun disc with limb darkening, only when actually above the horizon line.
  float sAng = discAngle(rd, uSunDir, refractFlatten(uSunDir.y));
  float sDisc = 1.0 - smoothstep(uSunAngularRadius - pxAng*0.8, uSunAngularRadius + pxAng*0.8, sAng);
  if (sDisc > 0.0){
    float m = sqrt(max(0.0, 1.0 - pow(min(sAng/max(uSunAngularRadius,1e-5), 1.0), 2.0)));
    // Eddington limb darkening, plus a redder limb because the cooler edge of
    // the photosphere darkens more in blue than in red.
    vec3 u = vec3(0.64, 0.58, 0.53) * uSunLimb;
    vec3 limb = (1.0 - u) + u*pow(m, 0.42);
    float solidAngle = TAU_A * (1.0 - cos(uSunAngularRadius));
    // Irradiance -> radiance across the solar disc's actual solid angle. This is
    // what makes the sun read as blindingly bright next to the sky around it.
    vec3 disc = uSunIrradiance / max(solidAngle, 1e-7) * uSunDiscIntensity * limb * sDisc * sunTr * uAtmoExposure;
    col += capRadiance(disc, uDiscCap);
  }

  vec3 skyTop = sampleSky(vec3(0.0,1.0,0.0));
  vec3 skyLow = sampleSky(normalize(vec3(rd.x, 0.12, rd.z)));

  // Cirrus veil above the cumulus deck: optically thin, so it mostly shows as
  // forward-scattered light with a little of its own shadowing.
  float cDist;
  float ci = cirrusLayer(rd, uCamPos, pxAng, cDist);
  if (ci > 0.001){
    // Ice cloud at 9 km is above most of the reddening air, so it sees a far
    // shorter slant path than the sea does. That is exactly why cirrus is the
    // last thing still burning after the sun has left the surface, and why it is
    // the most saturated pink in a sunset - lighting it with the *camera's*
    // transmittance puts it out early and leaves it grey.
    vec3 hiPos = vec3(0.0, R_PLANET + max(uCirrusAlt, 4000.0), 0.0);
    float fwd  = miePhase(dot(rd, uSunDir), 0.62) * 2.6 + 0.09;
    float fwdM = miePhase(dot(rd, uMoonDir), 0.62) * 2.6 + 0.09;
    vec3 lit = uSunIrradiance * sunTransmittance(hiPos, uSunDir) * fwd
             + uMoonColor    * sunTransmittance(hiPos, uMoonDir) * fwdM;
    // Ambient is the sky behind *this* direction, never the zenith: pasting
    // zenith blue over a warm horizon drags every streak colder and darker than
    // the sky it lies on, which is the opposite of what ice cloud does.
    vec3 back = sampleSky(rd);
    vec3 cc = lit * uAtmoExposure * exp(-ci*1.4) + back * 0.72;
    vec3 hz = exp(-(BETA_R + vec3(BETA_MS+BETA_MA)*uTurbidity) * 0.42 * min(cDist, 200000.0));
    float a = clamp(ci * uCirrus * 1.1, 0.0, 0.92);
    col = mix(col, cc*hz + back*(1.0-hz), a);
  }

  vec3 moonCol = uMoonColor * moonTr * uAtmoExposure;
  vec4 cl = marchClouds(uCamPos, rd, uSunDir, sunCol, uMoonDir, moonCol, skyTop, skyLow);
  col = col*(1.0 - cl.a) + cl.rgb;

  fragColor = vec4(col, 1.0);
}
`;
