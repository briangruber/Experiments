// The whole look, in five programs: solid geometry, water, sky, foam sprites
// and the tonemap. Everything is authored for a bright, saturated, painted
// afternoon - the lighting bands rather than falls off smoothly, shadows are
// tinted towards the sky instead of towards black, and the sea reads as clear
// glass over a sandy bed near the harbour and as flat cyan paint further out.

// ---------------------------------------------------------------- shared
export const COMMON = /* glsl */`
const float PI = 3.14159265;

float hash21(vec2 p){
  p = fract(p*vec2(123.34, 456.21));
  p += dot(p, p+45.32);
  return fract(p.x*p.y);
}
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f*f*(3.0-2.0*f);
  float a = hash21(i), b = hash21(i+vec2(1,0));
  float c = hash21(i+vec2(0,1)), d = hash21(i+vec2(1,1));
  return mix(mix(a,b,f.x), mix(c,d,f.x), f.y);
}
float fbm(vec2 p){
  float s = 0.0, a = 0.5;
  for(int i=0;i<5;i++){ s += a*vnoise(p); p = p*2.03 + 11.7; a *= 0.5; }
  return s;
}

// Stylised sky. Deep at the zenith, bleached at the horizon, with flat-bottomed
// cumulus banked along the far edge - painted rather than physically scattered.
vec3 skyColor(vec3 dir, vec3 sunDir, float time, float cloudy, float cloudGain){
  float h = clamp(dir.y, -1.0, 1.0);
  float t = pow(clamp(h, 0.0, 1.0), 0.34);
  vec3 zenith  = vec3(0.013, 0.115, 0.66);
  vec3 horizon = vec3(0.33, 0.62, 0.94);
  vec3 col = mix(horizon, zenith, t);

  // a thin haze band right on the waterline, so distant islands sit in air
  // without bleaching the whole lower sky
  // (edge0 < edge1: a reversed smoothstep is undefined in GLSL ES and some
  // drivers hand back NaN, which propagates straight through the tonemap)
  col = mix(col, vec3(0.70, 0.87, 0.99), (1.0 - smoothstep(-0.006, 0.018, h))*0.42);

  float sd = max(dot(dir, sunDir), 0.0);
  col += vec3(1.0, 0.86, 0.62) * pow(sd, 9.0) * 0.35;
  col += vec3(1.0, 0.95, 0.85) * pow(sd, 220.0) * 3.0;

  if(dir.y > 0.01){
    // Ray hits a flat cloud deck. Clamping the divisor stops the puffs
    // smearing into grey banks along the horizon.
    vec2 cp = dir.xz / (dir.y*0.55 + 0.26) * 1.15;
    cp += vec2(time*0.006, time*0.0025);
    float cover = mix(0.50, 0.40, cloudy);
    float n  = fbm(cp*0.50);
    float nb = fbm(cp*0.50 + vec2(0.0, 0.34));    // "below" the puff: its base
    float m  = smoothstep(cover, cover + 0.09, n);
    float mb = smoothstep(cover, cover + 0.09, nb);
    m *= smoothstep(0.012, 0.10, dir.y);          // stacked down towards the horizon, not into it
    // Bright almost everywhere, with a cool base only where the puff is deep -
    // flat-bottomed cumulus, painted rather than shaded.
    vec3 lit  = vec3(1.10, 1.09, 1.06);
    vec3 base = vec3(0.80, 0.87, 0.98);
    vec3 cloud = mix(lit, base, clamp(mb*0.85, 0.0, 0.85));
    cloud += vec3(0.30,0.21,0.11)*pow(sd, 5.0)*m;
    col = mix(col, cloud, m*0.96*cloudGain);
  }
  return col;
}
vec3 skyColor(vec3 dir, vec3 sunDir, float time, float cloudy){
  return skyColor(dir, sunDir, time, cloudy, 1.0);
}

// Wrapped, banded diffuse. The two smoothsteps are the whole toon look: a
// terminator with a soft shoulder and a lifted core, so curved surfaces read
// as two or three painted planes instead of a gradient.
float bandedDiffuse(float ndl){
  float w = ndl*0.5 + 0.5;                 // wrap - nothing goes fully black
  float b = smoothstep(0.32, 0.52, w)*0.55 + smoothstep(0.55, 0.85, w)*0.45;
  return mix(w, b, 0.72);
}
`;

// ---------------------------------------------------------------- solid mesh
export const SOLID_VS = /* glsl */`
layout(location=0) in vec3 a_pos;
layout(location=1) in vec3 a_nrm;
layout(location=2) in vec3 a_col;
layout(location=3) in float a_emis;

uniform mat4 u_viewProj;
uniform mat4 u_model;
uniform mat3 u_normalMat;
uniform mat4 u_lightViewProj;
uniform vec3 u_camPos;

out vec3 vWorld;
out vec3 vNormal;
out vec3 vColor;
out float vEmis;
out vec4 vLightPos;
out float vViewDist;

void main(){
  vec4 w = u_model * vec4(a_pos, 1.0);
  vWorld = w.xyz;
  vNormal = normalize(u_normalMat * a_nrm);
  vColor = a_col;
  vEmis = a_emis;
  vLightPos = u_lightViewProj * w;
  vViewDist = length(w.xyz - u_camPos);
  gl_Position = u_viewProj * w;
}
`;

export const SOLID_FS = COMMON + /* glsl */`
in vec3 vWorld;
in vec3 vNormal;
in vec3 vColor;
in float vEmis;
in vec4 vLightPos;
in float vViewDist;

uniform vec3 u_sunDir;
uniform vec3 u_sunColor;
uniform vec3 u_camPos;
uniform sampler2D u_shadowMap;
uniform float u_shadowTexel;
uniform float u_time;
uniform float u_clipBelow;    // >0.5: discard anything above the waterline
uniform float u_waterY;
uniform float u_fogDensity;
uniform float u_shadowStrength;

layout(location=0) out vec4 fragColor;

float shadowFactor(){
  vec3 p = vLightPos.xyz / vLightPos.w;
  p = p*0.5 + 0.5;
  if(p.x < 0.002 || p.x > 0.998 || p.y < 0.002 || p.y > 0.998 || p.z > 1.0) return 1.0;
  float bias = 0.0016;
  float s = 0.0;
  for(int y=-1;y<=1;y++){
    for(int x=-1;x<=1;x++){
      float d = texture(u_shadowMap, p.xy + vec2(float(x), float(y))*u_shadowTexel).r;
      s += (p.z - bias > d) ? 0.0 : 1.0;
    }
  }
  return s/9.0;
}

void main(){
  if(u_clipBelow > 0.5 && vWorld.y > u_waterY + 0.02) discard;

  vec3 N = normalize(vNormal);
  vec3 V = normalize(u_camPos - vWorld);
  float ndl = dot(N, u_sunDir);

  float sh = mix(1.0, shadowFactor(), u_shadowStrength);
  float dif = bandedDiffuse(ndl) * mix(0.34, 1.0, sh);

  // Sky/ground hemispheric fill. The upward bounce is cyan because everything
  // here stands over turquoise water - that tint is most of the "seaside".
  vec3 skyFill = vec3(0.42, 0.62, 0.92);
  vec3 seaFill = vec3(0.22, 0.55, 0.60);
  vec3 ambient = mix(seaFill, skyFill, N.y*0.5+0.5) * 0.55;

  vec3 col = vColor * (u_sunColor * dif * 1.15 + ambient);

  // soft specular sheen so paint and varnish separate from cloth and stone
  vec3 H = normalize(u_sunDir + V);
  col += u_sunColor * pow(max(dot(N,H),0.0), 24.0) * 0.16 * sh;

  // rim light picks the silhouette off the water
  float rim = pow(1.0 - max(dot(N,V), 0.0), 2.6);
  col += vec3(0.55, 0.78, 1.0) * rim * 0.20;

  col += vColor * vEmis * 2.2;

  // Underwater: attenuate towards the bed colour with depth below the surface,
  // and paint moving caustic bands over whatever is down there.
  if(u_clipBelow > 0.5){
    float depth = max(0.0, u_waterY - vWorld.y);
    float c = 0.0;
    vec2 q = vWorld.xz*0.55 + vec2(u_time*0.09, u_time*0.06);
    c = fbm(q) + fbm(q*1.9 + 3.1)*0.5;
    c = smoothstep(0.72, 1.12, c);
    col += u_sunColor * c * 0.30 * exp(-depth*0.45) * max(N.y, 0.0);
    col *= mix(vec3(1.0), vec3(0.16, 0.50, 0.54), clamp(depth*0.22, 0.0, 0.85));
  }

  float fog = 1.0 - exp(-vViewDist * u_fogDensity);
  vec3 fogCol = skyColor(normalize(vWorld - u_camPos), u_sunDir, u_time, 0.5);
  col = mix(col, fogCol, fog * 0.92);

  fragColor = vec4(col, vViewDist);
}
`;

// ---------------------------------------------------------------- shadow map
export const SHADOW_VS = /* glsl */`
layout(location=0) in vec3 a_pos;
uniform mat4 u_lightViewProj;
uniform mat4 u_model;
void main(){ gl_Position = u_lightViewProj * u_model * vec4(a_pos, 1.0); }
`;

export const SHADOW_FS = /* glsl */`
layout(location=0) out vec4 fragColor;
void main(){ fragColor = vec4(gl_FragCoord.z); }
`;

// ---------------------------------------------------------------- sky
export const SKY_FS = COMMON + /* glsl */`
in vec2 vUv;
uniform mat4 u_invViewProj;
uniform vec3 u_camPos;
uniform vec3 u_sunDir;
uniform float u_time;
layout(location=0) out vec4 fragColor;

void main(){
  vec4 near = u_invViewProj * vec4(vUv*2.0-1.0, -1.0, 1.0);
  vec4 far  = u_invViewProj * vec4(vUv*2.0-1.0,  1.0, 1.0);
  vec3 dir = normalize(far.xyz/far.w - near.xyz/near.w);
  fragColor = vec4(skyColor(dir, u_sunDir, u_time, 0.5), 40000.0);
}
`;

// ---------------------------------------------------------------- water
// A camera-centred disc: dense under the boat where the ripples and the bed
// matter, coarse out towards the horizon where it is flat colour anyway.
export const WATER_VS = COMMON + /* glsl */`
layout(location=0) in vec2 a_rt;      // radial t, angular t

uniform mat4 u_viewProj;
uniform vec3 u_camPos;
uniform float u_time;
uniform float u_waterY;
uniform float u_chop;

out vec3 vWorld;
out float vRadius;

// Three crossing swells plus a fine ripple. Amplitudes stay tiny - this is a
// sheltered bay, and the reference reads almost glassy.
vec3 waveAt(vec2 p, float t){
  float y = 0.0; vec2 d = vec2(0.0);
  vec2 k1 = vec2(0.92, 0.39)*0.42; float a1 = 0.085;
  vec2 k2 = vec2(-0.42, 0.90)*0.71; float a2 = 0.045;
  vec2 k3 = vec2(0.71,-0.70)*1.35;  float a3 = 0.022;
  float p1 = dot(p,k1) - t*1.05, p2 = dot(p,k2) - t*1.55, p3 = dot(p,k3) - t*2.1;
  y += sin(p1)*a1 + sin(p2)*a2 + sin(p3)*a3;
  d += k1*cos(p1)*a1 + k2*cos(p2)*a2 + k3*cos(p3)*a3;
  return vec3(y, d);
}

void main(){
  float r = pow(a_rt.x, 3.0) * 2600.0 + a_rt.x*8.0;
  float a = a_rt.y * 2.0*PI;
  vec2 p = u_camPos.xz + vec2(cos(a), sin(a))*r;
  vec3 w = waveAt(p, u_time);
  vWorld = vec3(p.x, u_waterY + w.x*u_chop, p.y);
  vRadius = r;
  gl_Position = u_viewProj * vec4(vWorld, 1.0);
}
`;

export const WATER_FS = COMMON + /* glsl */`
in vec3 vWorld;
in float vRadius;

uniform vec3 u_camPos;
uniform vec3 u_sunDir;
uniform vec3 u_sunColor;
uniform float u_time;
uniform float u_waterY;
uniform float u_chop;
uniform vec2 u_texel;
uniform sampler2D u_refract;   // rgb = submerged scene, a = view distance
uniform sampler2D u_foam;      // wake/impact foam, r = coverage
uniform vec4 u_foamRect;       // xz origin + size of the foam field
uniform float u_fogDensity;
uniform sampler2D u_shadowMap;
uniform mat4 u_lightViewProj;
uniform float u_shadowTexel;

layout(location=0) out vec4 fragColor;

// Analytic normal of the same swell the vertex shader displaces by, plus a
// couple of octaves of fine ripple that only ever live in the normal.
vec3 waterNormal(vec2 p, float t, float detail){
  vec2 d = vec2(0.0);
  vec2 k1 = vec2(0.92, 0.39)*0.42; float a1 = 0.085;
  vec2 k2 = vec2(-0.42, 0.90)*0.71; float a2 = 0.045;
  vec2 k3 = vec2(0.71,-0.70)*1.35;  float a3 = 0.022;
  d += k1*cos(dot(p,k1) - t*1.05)*a1;
  d += k2*cos(dot(p,k2) - t*1.55)*a2;
  d += k3*cos(dot(p,k3) - t*2.1 )*a3;
  d *= u_chop;
  // fine chop, faded with distance so the horizon stays calm and unaliased
  float e = 0.06;
  vec2 q = p*0.9 + vec2(t*0.13, -t*0.09);
  float n0 = fbm(q);
  float nx = fbm(q + vec2(e,0.0)), nz = fbm(q + vec2(0.0,e));
  d += vec2(nx-n0, nz-n0)/e * 0.010 * detail;
  return normalize(vec3(-d.x, 1.0, -d.y));
}

// Same 3x3 PCF as the solid shader, on the sea surface. Without it the piers
// float, because nothing under them ever darkens.
float seaShadow(vec3 world){
  vec4 lp = u_lightViewProj * vec4(world, 1.0);
  vec3 p = lp.xyz/lp.w * 0.5 + 0.5;
  if(p.x < 0.002 || p.x > 0.998 || p.y < 0.002 || p.y > 0.998 || p.z > 1.0) return 1.0;
  float s = 0.0;
  for(int y=-1;y<=1;y++){
    for(int x=-1;x<=1;x++){
      float d = texture(u_shadowMap, p.xy + vec2(float(x), float(y))*u_shadowTexel).r;
      s += (p.z - 0.0022 > d) ? 0.0 : 1.0;
    }
  }
  return s/9.0;
}

void main(){
  vec3 V = normalize(u_camPos - vWorld);
  float dist = length(u_camPos - vWorld);
  float shadow = seaShadow(vWorld);
  float detail = exp(-dist*0.012);
  vec3 N = waterNormal(vWorld.xz, u_time, detail);

  vec2 uv = gl_FragCoord.xy * u_texel;

  // Refraction: nudge the lookup along the surface normal, then reject the
  // sample if it turns out to be nearer than the surface (classic bleed fix).
  float surf = dist;
  vec4 straight = texture(u_refract, uv);
  float bedDist = straight.a;
  float thick0 = max(0.0, bedDist - surf);
  vec2 off = N.xz * 0.055 * clamp(thick0, 0.0, 1.6) * (1.0 - clamp(dist*0.02,0.0,0.9));
  vec4 refr = texture(u_refract, uv + off);
  if(refr.a < surf) refr = straight;
  float thick = max(0.0, refr.a - surf);

  // Depth ramp. Two tuned colours do more for this style than any physically
  // derived extinction: saturated jade in the shallows, deep cyan-blue beyond.
  vec3 shallow = vec3(0.13, 0.64, 0.53);
  vec3 deep    = vec3(0.005, 0.10, 0.34);
  float t = 1.0 - exp(-thick*0.22);
  vec3 body = mix(shallow, deep, t);

  // Slow extinction on purpose: the bed staying legible through three or four
  // metres of water is the single most recognisable thing about the reference.
  float clarity = exp(-thick*0.20);
  vec3 col = mix(body, refr.rgb, clarity);

  // The bed picks up a green cast right where it disappears - keeps the
  // transition from "seeing sand" to "seeing water" from looking like a fade.
  col = mix(col, col*vec3(0.86,1.04,0.99), smoothstep(0.0,2.5,thick)*0.5);

  col *= mix(vec3(0.62, 0.76, 0.86), vec3(1.0), shadow);

  // Sky reflection with a Schlick fresnel. The reflected ray is bent back
  // towards vertical first: a mirror-sharp sky turns every ripple into a white
  // streak, and painted water wants a soft, low-contrast sheen instead.
  vec3 Nr = normalize(mix(N, vec3(0.0, 1.0, 0.0), 0.55));
  vec3 R = reflect(-V, Nr);
  R.y = abs(R.y) + 0.06;
  vec3 sky = skyColor(normalize(R), u_sunDir, u_time, 0.5, 0.42);
  float f = 0.02 + 0.98*pow(1.0 - max(dot(N,V),0.0), 5.0);
  // Capped hard: a physical fresnel turns the whole middle distance into a
  // mirror, and the painted look wants the sea's own colour to keep winning.
  col = mix(col, sky, clamp(f, 0.0, 0.28));

  // Sun glitter: a hard-edged specular, broken up by a moving speckle so it
  // reads as thousands of little facets rather than one smeared highlight.
  vec3 H = normalize(u_sunDir + V);
  float ndh = max(dot(N,H), 0.0);
  // Fine, high-frequency glitter. A broad lobe here just paints white bands
  // along the swell crests, which reads as haze rather than sun on water.
  float sparkleMask = smoothstep(0.66, 0.93, fbm(vWorld.xz*9.0 + vec2(u_time*0.9, -u_time*0.7)));
  col += u_sunColor * (pow(ndh, 900.0)*3.0 + pow(ndh, 460.0)*1.1*sparkleMask) * shadow * detail;

  // shoreline + wake foam
  float shoreline = 1.0 - smoothstep(0.05, 1.05, thick);
  float lace = smoothstep(0.42, 0.78, fbm(vWorld.xz*3.1 + vec2(0.0, u_time*0.35)));
  float foamS = shoreline * mix(0.55, 1.0, lace);
  vec2 fuv = (vWorld.xz - u_foamRect.xy) / u_foamRect.zw;
  float wake = 0.0;
  if(all(greaterThan(fuv, vec2(0.0))) && all(lessThan(fuv, vec2(1.0)))){
    wake = texture(u_foam, fuv).r;
  }
  float foam = clamp(foamS + wake, 0.0, 1.0);
  vec3 foamCol = vec3(0.97, 0.995, 1.0);
  col = mix(col, foamCol, smoothstep(0.22, 0.85, foam)*0.92);

  float fog = 1.0 - exp(-dist * u_fogDensity);
  col = mix(col, skyColor(normalize(vWorld-u_camPos), u_sunDir, u_time, 0.5), fog*0.42);

  fragColor = vec4(col, dist);
}
`;

// ---------------------------------------------------------------- foam field
// Wake and splashes are stamped into a small world-space texture that fades
// every frame, then read back by the water shader. Cheap, and it lets a wake
// curve behind the boat and linger the way a real one does.
export const FOAM_STAMP_VS = /* glsl */`
layout(location=0) in vec2 a_corner;
layout(location=1) in vec4 a_inst;    // xy = uv centre, z = radius(uv), w = strength
out vec2 vLocal;
out float vStrength;
void main(){
  vLocal = a_corner;
  vStrength = a_inst.w;
  vec2 uv = a_inst.xy + a_corner*a_inst.z;
  gl_Position = vec4(uv*2.0-1.0, 0.0, 1.0);
}
`;

export const FOAM_STAMP_FS = /* glsl */`
in vec2 vLocal;
in float vStrength;
layout(location=0) out vec4 fragColor;
void main(){
  float d = length(vLocal);
  float a = smoothstep(1.0, 0.15, d) * vStrength;
  fragColor = vec4(a, 0.0, 0.0, 1.0);
}
`;

export const FOAM_FADE_FS = /* glsl */`
in vec2 vUv;
uniform sampler2D u_src;
uniform float u_decay;
uniform vec2 u_shift;
layout(location=0) out vec4 fragColor;
void main(){
  float v = texture(u_src, vUv + u_shift).r * u_decay;
  fragColor = vec4(v, 0.0, 0.0, 1.0);
}
`;

// ---------------------------------------------------------------- sprites
// Camera-facing quads: splash puffs, spray, the bite ring, gull shadows.
export const SPRITE_VS = /* glsl */`
layout(location=0) in vec2 a_corner;
layout(location=1) in vec4 a_posSize;   // world xyz + size
layout(location=2) in vec4 a_color;     // rgb + alpha

uniform mat4 u_viewProj;
uniform vec3 u_right;
uniform vec3 u_up;

out vec2 vLocal;
out vec4 vColor;
void main(){
  vLocal = a_corner;
  vColor = a_color;
  vec3 w = a_posSize.xyz + (u_right*a_corner.x + u_up*a_corner.y) * a_posSize.w;
  gl_Position = u_viewProj * vec4(w, 1.0);
}
`;

export const SPRITE_FS = /* glsl */`
in vec2 vLocal;
in vec4 vColor;
layout(location=0) out vec4 fragColor;
void main(){
  float d = length(vLocal);
  float a = smoothstep(1.0, 0.55, d) * vColor.a;
  if(a < 0.004) discard;
  fragColor = vec4(vColor.rgb * a, a);
}
`;

// ---------------------------------------------------------------- present
export const POST_FS = /* glsl */`
in vec2 vUv;
uniform sampler2D u_src;
uniform sampler2D u_bloom;
uniform float u_exposure;
uniform float u_bloomAmount;
uniform float u_vignette;
layout(location=0) out vec4 fragColor;

vec3 tonemap(vec3 x){
  // Slightly lifted filmic curve: keeps highlights from going white too early
  // while leaving the mid saturation alone, which cel-ish art needs.
  return (x*(2.05*x + 0.10)) / (x*(2.05*x + 0.55) + 0.14);
}

void main(){
  vec3 c = texture(u_src, vUv).rgb;
  c += texture(u_bloom, vUv).rgb * u_bloomAmount;
  c *= u_exposure;
  c = tonemap(c);

  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, 1.18);                       // paint-like saturation
  c = clamp(c, 0.0, 1.0);
  c = c*c*(3.0 - 2.0*c)*0.34 + c*0.66;             // soft contrast

  vec2 q = (vUv - 0.5) * vec2(1.0, 0.92);
  c *= 1.0 - dot(q,q) * u_vignette;

  c = pow(max(c, 0.0), vec3(1.0/2.2));
  fragColor = vec4(c, 1.0);
}
`;

export const BRIGHT_FS = /* glsl */`
in vec2 vUv;
uniform sampler2D u_src;
uniform float u_threshold;
layout(location=0) out vec4 fragColor;
void main(){
  vec3 c = texture(u_src, vUv).rgb;
  float l = dot(c, vec3(0.2126,0.7152,0.0722));
  fragColor = vec4(c * smoothstep(u_threshold, u_threshold*2.0, l), 1.0);
}
`;

export const BLUR_FS = /* glsl */`
in vec2 vUv;
uniform sampler2D u_src;
uniform vec2 u_dir;
layout(location=0) out vec4 fragColor;
void main(){
  vec3 s = texture(u_src, vUv).rgb * 0.227;
  s += (texture(u_src, vUv + u_dir*1.385).rgb + texture(u_src, vUv - u_dir*1.385).rgb) * 0.316;
  s += (texture(u_src, vUv + u_dir*3.231).rgb + texture(u_src, vUv - u_dir*3.231).rgb) * 0.070;
  fragColor = vec4(s, 1.0);
}
`;
