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

float fbm3(vec3 p, int oct){
  float a = 0.5, s = 0.0, n = 0.0;
  for (int i=0;i<8;i++){
    if (i>=oct) break;
    s += a * vnoise(p); n += a; a *= 0.5; p *= 2.02; p.xy += 7.13;
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
const vec3  BETA_R   = vec3(5.802e-6, 13.558e-6, 33.100e-6);
const float BETA_MS  = 3.996e-6;
const float BETA_MA  = 4.400e-6;
const vec3  BETA_O   = vec3(0.650e-6, 1.881e-6, 0.085e-6);

uniform float uTurbidity;
uniform float uOzone;
uniform vec3  uSunIrradiance;
uniform float uMieG;
uniform float uAtmoExposure;

float rayleighPhase(float c){ return 3.0/(16.0*3.14159265) * (1.0 + c*c); }
float miePhase(float c, float g){
  float g2 = g*g;
  return 3.0/(8.0*3.14159265) * ((1.0-g2)*(1.0+c*c)) / ((2.0+g2)*pow(1.0+g2-2.0*g*c, 1.5));
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
  dR = exp(-h / 8000.0);
  dM = exp(-h / 1200.0) * uTurbidity;
  dO = max(0.0, 1.0 - abs(h - 25000.0) / 15000.0) * uOzone;
}

vec3 sunTransmittance(vec3 p, vec3 sunDir){
  float d = atmosDist(p, sunDir);
  if (planetDist(p, sunDir) > 0.0) return vec3(0.0);
  const int N = 8;
  float dt = d / float(N);
  vec3 od = vec3(0.0);
  for (int i=0;i<N;i++){
    vec3 s = p + sunDir * (float(i)+0.5) * dt;
    float dR, dM, dO; densities(s, dR, dM, dO);
    od += (BETA_R*dR + vec3(BETA_MS+BETA_MA)*dM + BETA_O*dO) * dt;
  }
  return exp(-od);
}

// Single scattering plus a cheap isotropic multi-scatter term.
vec3 skyRadianceRaw(vec3 ro, vec3 rd, vec3 sunDir, int steps){
  float tMax = atmosDist(ro, rd);
  float tGround = planetDist(ro, rd);
  bool hitGround = tGround > 0.0;
  if (hitGround) tMax = tGround;
  if (tMax <= 0.0) return vec3(0.0);

  float cosT = dot(rd, sunDir);
  float pR = rayleighPhase(cosT);
  float pM = miePhase(cosT, uMieG);

  vec3 sumR = vec3(0.0), sumM = vec3(0.0), sumMS = vec3(0.0);
  vec3 od = vec3(0.0);
  float dt = tMax / float(steps);
  for (int i=0;i<64;i++){
    if (i>=steps) break;
    float t = (float(i)+0.5)*dt;
    vec3 p = ro + rd*t;
    float dR, dM, dO; densities(p, dR, dM, dO);
    vec3 ext = BETA_R*dR + vec3(BETA_MS+BETA_MA)*dM + BETA_O*dO;
    vec3 trans = exp(-od);
    od += ext*dt;
    vec3 tr = sunTransmittance(p, sunDir);
    sumR += trans * tr * BETA_R * dR * dt;
    sumM += trans * tr * vec3(BETA_MS) * dM * dt;
    // Ambient bounce: light that scattered more than once, approximated as an
    // isotropic term proportional to local density and sun visibility.
    sumMS += trans * (BETA_R*dR + vec3(BETA_MS)*dM) * dt * (0.35 + 0.65*max(tr.g, 0.0));
  }

  vec3 col = (sumR*pR + sumM*pM) * uSunIrradiance;
  col += sumMS * uSunIrradiance * 0.030;
  if (hitGround){
    // Sea reading below the horizon comes from the water pass, but the LUT still
    // needs something sane for downward reflection lookups.
    col *= 0.55;
  }
  return col * uAtmoExposure;
}

// Analytic aerial perspective for surface shading at distance d.
void aerialPerspective(vec3 ro, vec3 rd, float d, vec3 sunDir, out vec3 inscatter, out vec3 transmit){
  const int N = 6;
  float dt = d / float(N);
  vec3 od = vec3(0.0), sum = vec3(0.0);
  float cosT = dot(rd, sunDir);
  float pR = rayleighPhase(cosT), pM = miePhase(cosT, uMieG);
  for (int i=0;i<N;i++){
    vec3 p = ro + rd*((float(i)+0.5)*dt);
    float dR, dM, dO; densities(p, dR, dM, dO);
    vec3 ext = BETA_R*dR + vec3(BETA_MS+BETA_MA)*dM + BETA_O*dO;
    vec3 tr = exp(-od);
    od += ext*dt;
    vec3 st = sunTransmittance(p, sunDir);
    sum += tr * st * (BETA_R*dR*pR + vec3(BETA_MS)*dM*pM) * dt;
  }
  inscatter = sum * uSunIrradiance * uAtmoExposure;
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
uniform float uEyeHeight;
out vec4 fragColor;
void main(){
  vec3 rd = skyUvToDir(vUv);
  vec3 ro = vec3(0.0, R_PLANET + max(uEyeHeight, 1.0), 0.0);
  fragColor = vec4(skyRadianceRaw(ro, rd, uSunDir, 24), 1.0);
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
uniform vec3 uCamPos, uSunDir, uMoonDir;
uniform float uTime;
uniform float uSunAngularRadius, uSunDiscIntensity;
uniform float uCloudCoverage, uCloudDensity, uCloudAltitude, uCloudThickness;
uniform float uCloudSpeed, uCloudDetail, uCirrus, uStars, uCloudSteps;
uniform vec3 uWindDirV;
out vec4 fragColor;

vec3 sampleSky(vec3 rd){ return texture(uSkyLUT, dirToSkyUv(rd)).rgb; }

// ---- clouds -----------------------------------------------------------------
float cloudShape(vec3 p, float hRel){
  vec3 q = p * 0.00022;
  q.xz += uWindDirV.xz * uTime * uCloudSpeed * 0.0006;
  float base = fbm3(q, 4);
  // Domain warp gives the billowing, non-repeating cauliflower silhouette.
  vec3 w = vec3(fbm3(q*1.7+11.3, 3), fbm3(q*1.7+27.1, 3), fbm3(q*1.7+43.7, 3));
  base = mix(base, fbm3(q*1.35 + (w-0.5)*1.8, 4), 0.6);

  float cov = smoothstep(1.0 - uCloudCoverage, 1.0 - uCloudCoverage + 0.28, base);
  // Vertical profile: rounded bottom, anvil-flat top.
  float prof = smoothstep(0.0, 0.22, hRel) * smoothstep(1.0, 0.62, hRel);
  float d = cov * prof;
  if (d <= 0.001) return 0.0;
  float erode = billow(p*0.0016 + vec3(0.0, uTime*0.02, 0.0), 3);
  d = clamp(d - (1.0 - erode) * uCloudDetail * 0.55, 0.0, 1.0);
  return d * uCloudDensity;
}

float cloudLight(vec3 p, vec3 sunDir, float slabLo, float slabHi){
  float dens = 0.0;
  float t = 60.0;
  for (int i=0;i<5;i++){
    vec3 s = p + sunDir * t;
    float h = (s.y - slabLo) / max(slabHi - slabLo, 1.0);
    if (h > 0.0 && h < 1.0) dens += cloudShape(s, h) * t * 0.42;
    t *= 2.0;
  }
  return dens;
}

vec4 marchClouds(vec3 ro, vec3 rd, vec3 sunDir, vec3 sunColor, vec3 ambient){
  if (uCloudCoverage <= 0.001) return vec4(0.0);
  if (rd.y < 0.005) return vec4(0.0);
  float lo = uCloudAltitude, hi = uCloudAltitude + uCloudThickness;
  float t0 = (lo - ro.y) / rd.y;
  float t1 = (hi - ro.y) / rd.y;
  if (t1 < t0){ float tmp=t0; t0=t1; t1=tmp; }
  t0 = max(t0, 0.0);
  if (t1 <= t0) return vec4(0.0);
  t1 = min(t1, 90000.0);

  int steps = int(uCloudSteps);
  float dt = (t1 - t0) / float(steps);
  // Fixed dither so the march does not band; TAA/temporal jitter cleans it up.
  float jitter = hash12(gl_FragCoord.xy + fract(uTime)*17.0);
  float t = t0 + dt*jitter;

  vec3 scatter = vec3(0.0);
  float trans = 1.0;
  float mu = dot(rd, sunDir);
  float ph = mix(miePhase(mu, 0.72), miePhase(mu, -0.28), 0.42);
  ph = max(ph, 0.06);

  for (int i=0;i<128;i++){
    if (i>=steps || trans < 0.01) break;
    vec3 p = ro + rd*t;
    float h = (p.y - lo) / max(hi - lo, 1.0);
    float d = cloudShape(p, h);
    if (d > 0.001){
      float ld = cloudLight(p, sunDir, lo, hi);
      // Two-lobe transmittance: strong direct plus a broad powdered term.
      float lt = exp(-ld*0.35) * 0.85 + exp(-ld*0.06) * 0.15;
      float powder = 1.0 - exp(-d*dt*2.4);
      vec3 lum = sunColor * ph * lt * (0.4 + 0.6*powder) + ambient * (0.35 + 0.65*h);
      float ext = d * dt * 0.9;
      float tr = exp(-ext);
      scatter += trans * lum * (1.0 - tr);
      trans *= tr;
    }
    t += dt;
  }
  // Fade the slab out toward the horizon so it does not end in a hard line.
  float horizonFade = smoothstep(0.0, 0.085, rd.y);
  float alpha = (1.0 - trans) * horizonFade;
  return vec4(scatter * horizonFade, alpha);
}

float cirrus(vec3 rd){
  if (uCirrus <= 0.001 || rd.y < 0.02) return 0.0;
  vec3 p = rd / max(rd.y, 0.02) * 0.00035;
  p.xz += uWindDirV.xz * uTime * 0.0008;
  float f = fbm3(vec3(p.x*3.0, p.z*0.6, 0.0), 5);
  f = smoothstep(0.52, 0.86, f);
  return f * uCirrus * smoothstep(0.02, 0.16, rd.y);
}

float starField(vec3 rd){
  if (uStars <= 0.001) return 0.0;
  vec3 p = rd * 380.0;
  vec3 i = floor(p);
  float h = hash13(i);
  if (h < 0.9965) return 0.0;
  vec3 c = i + 0.5 + (vec3(hash13(i+1.0), hash13(i+2.0), hash13(i+3.0)) - 0.5)*0.8;
  float d = length(p - c);
  float mag = pow(hash13(i+7.0), 6.0);
  float tw = 0.75 + 0.25*sin(uTime*2.3 + h*90.0);
  return exp(-d*d*9.0) * mag * tw * uStars * 40.0;
}

void main(){
  vec4 ndc = vec4(vUv*2.0-1.0, 1.0, 1.0);
  vec4 wp = uInvViewProj * ndc;
  vec3 rd = normalize(wp.xyz/wp.w - uCamPos);

  vec3 col = sampleSky(rd);

  // Stars behind everything, dimmed by air glow.
  vec3 skyLum = col;
  float night = exp(-dot(skyLum, vec3(0.2126,0.7152,0.0722)) * 260.0);
  col += vec3(0.86,0.92,1.0) * starField(rd) * night;

  // Moon.
  float mc = dot(rd, uMoonDir);
  float mr = cos(0.0047);
  if (mc > mr){
    float e = clamp((mc-mr)/(1.0-mr), 0.0, 1.0);
    col += vec3(1.0,0.97,0.92) * 3.0 * night * smoothstep(0.0,0.25,e);
  }
  col += vec3(0.8,0.86,1.0) * pow(max(mc,0.0), 900.0) * 0.6 * night;

  // Sun disc with limb darkening, only when actually above the horizon line.
  float sc = dot(rd, uSunDir);
  float sr = cos(uSunAngularRadius);
  if (sc > sr){
    float e = clamp((sc - sr)/(1.0 - sr), 0.0, 1.0);
    float mu = sqrt(max(0.0, 1.0 - (1.0-e)*(1.0-e)));
    float limb = 0.4 + 0.6*pow(mu, 0.42);
    vec3 tr = sunTransmittance(vec3(0.0, R_PLANET + max(uCamPos.y,1.0), 0.0), uSunDir);
    // Irradiance -> radiance across the solar disc's actual solid angle. This is
    // what makes the sun read as blindingly bright next to the sky around it.
    float solidAngle = 6.28318530718 * (1.0 - cos(uSunAngularRadius));
    col += uSunIrradiance / max(solidAngle, 1e-7) * uSunDiscIntensity * limb * tr * uAtmoExposure;
  }

  // Cirrus veil above the cumulus deck.
  vec3 sunCol = uSunIrradiance * sunTransmittance(vec3(0.0, R_PLANET+max(uCamPos.y,1.0), 0.0), uSunDir) * uAtmoExposure;
  float ci = cirrus(rd);
  if (ci > 0.0){
    vec3 cc = mix(sampleSky(vec3(0.0,1.0,0.0)), sunCol*0.55, 0.35 + 0.45*pow(max(dot(rd,uSunDir),0.0), 6.0));
    col = mix(col, cc*1.15, ci*0.72);
  }

  vec3 amb = sampleSky(vec3(0.0,1.0,0.0)) * 1.1 + sampleSky(vec3(0.0,-0.35,0.0))*0.4;
  vec4 cl = marchClouds(uCamPos, rd, uSunDir, sunCol, amb);
  col = col*(1.0 - cl.a) + cl.rgb;

  fragColor = vec4(col, 1.0);
}
`;
