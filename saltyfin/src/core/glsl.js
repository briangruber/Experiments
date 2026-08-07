// Shared GLSL. Import the chunks you need and paste them into your shader
// source; they are plain strings, there is no #include machinery.
//
//   import { GLSL } from '../core/glsl.js';
//   const frag = `${GLSL.hash}${GLSL.noise}${GLSL.fbm} void main(){ ... }`;
//
// Everything here is ES3-safe (the renderer runs WebGL2) and side-effect free.

export const GLSL = {};

GLSL.constants = /* glsl */`
const float PI  = 3.141592653589793;
const float TAU = 6.283185307179586;
`;

GLSL.hash = /* glsl */`
float hash11(float p){ p = fract(p*0.1031); p *= p+33.33; p *= p+p; return fract(p); }
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*0.1031); p3 += dot(p3, p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
vec2  hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*vec3(0.1031,0.1030,0.0973)); p3 += dot(p3, p3.yzx+33.33); return fract((p3.xx+p3.yz)*p3.zy); }
vec3  hash32(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*vec3(0.1031,0.1030,0.0973)); p3 += dot(p3, p3.yxz+33.33); return fract((p3.xxy+p3.yzz)*p3.zyx); }
float hash13(vec3 p){ p = fract(p*0.1031); p += dot(p, p.zyx+31.32); return fract((p.x+p.y)*p.z); }
`;

// Value noise. Cheap, smooth, the workhorse.
GLSL.noise = /* glsl */`
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(hash12(i), hash12(i+vec2(1,0)), u.x),
             mix(hash12(i+vec2(0,1)), hash12(i+vec2(1,1)), u.x), u.y);
}
float vnoise3(vec3 p){
  vec3 i = floor(p), f = fract(p);
  vec3 u = f*f*(3.0-2.0*f);
  float n000=hash13(i), n100=hash13(i+vec3(1,0,0));
  float n010=hash13(i+vec3(0,1,0)), n110=hash13(i+vec3(1,1,0));
  float n001=hash13(i+vec3(0,0,1)), n101=hash13(i+vec3(1,0,1));
  float n011=hash13(i+vec3(0,1,1)), n111=hash13(i+vec3(1,1,1));
  return mix(mix(mix(n000,n100,u.x), mix(n010,n110,u.x), u.y),
             mix(mix(n001,n101,u.x), mix(n011,n111,u.x), u.y), u.z);
}
// Gradient noise in [-1,1] — better for normals and waves than value noise.
float gnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f*f*f*(f*(f*6.0-15.0)+10.0);
  vec2 g00 = normalize(hash22(i)*2.0-1.0);
  vec2 g10 = normalize(hash22(i+vec2(1,0))*2.0-1.0);
  vec2 g01 = normalize(hash22(i+vec2(0,1))*2.0-1.0);
  vec2 g11 = normalize(hash22(i+vec2(1,1))*2.0-1.0);
  float n00 = dot(g00, f), n10 = dot(g10, f-vec2(1,0));
  float n01 = dot(g01, f-vec2(0,1)), n11 = dot(g11, f-vec2(1,1));
  return mix(mix(n00,n10,u.x), mix(n01,n11,u.x), u.y) * 1.4;
}
`;

// The octave count is masked rather than `break`-ed out of: ESSL 1.00 only
// guarantees loops with constant bounds, and these chunks have to compile
// unchanged in a plain THREE.ShaderMaterial (which is GLSL1) as well as in the
// GLSL3 post shaders.
GLSL.fbm = /* glsl */`
const mat2 FBM_ROT = mat2(0.8,-0.6,0.6,0.8);
float fbm(vec2 p, int oct){
  float s = 0.0, a = 0.5, n = 0.0;
  for(int i=0;i<8;i++){ float m = step(float(i), float(oct)-0.5);
    s += m*a*gnoise(p); n += m*a; a *= 0.5; p = FBM_ROT*p*2.03; }
  return s/max(n,1e-4);
}
float fbmV(vec2 p, int oct){
  float s = 0.0, a = 0.5, n = 0.0;
  for(int i=0;i<8;i++){ float m = step(float(i), float(oct)-0.5);
    s += m*a*vnoise(p); n += m*a; a *= 0.5; p = FBM_ROT*p*2.03; }
  return s/max(n,1e-4);
}
float fbm3(vec3 p, int oct){
  float s = 0.0, a = 0.5, n = 0.0;
  for(int i=0;i<8;i++){ float m = step(float(i), float(oct)-0.5);
    s += m*a*vnoise3(p); n += m*a; a *= 0.5; p = p*2.02 + 19.7; }
  return s/max(n,1e-4);
}
float ridged(vec2 p, int oct){
  float s = 0.0, a = 0.5, n = 0.0;
  for(int i=0;i<8;i++){ float m = step(float(i), float(oct)-0.5);
    float v = 1.0-abs(gnoise(p)); s += m*a*v*v; n += m*a; a *= 0.5; p = FBM_ROT*p*2.03; }
  return s/max(n,1e-4);
}
`;

// Voronoi returning (distance to nearest, distance to second, cell id).
GLSL.worley = /* glsl */`
vec3 worley(vec2 p){
  vec2 i = floor(p), f = fract(p);
  float d1 = 8.0, d2 = 8.0, id = 0.0;
  for(int y=-1;y<=1;y++) for(int x=-1;x<=1;x++){
    vec2 g = vec2(float(x), float(y));
    vec2 o = hash22(i+g);
    float d = length(g + o - f);
    if(d < d1){ d2 = d1; d1 = d; id = hash12(i+g); }
    else if(d < d2){ d2 = d; }
  }
  return vec3(d1, d2, id);
}
`;

// Caustic pattern — layered voronoi ridges, the classic "sunlight through
// wavelets" look. Returns roughly [0, 2.5]; multiply and clamp to taste.
GLSL.caustic = /* glsl */`
float causticLayer(vec2 uv, float t){
  vec2 p = uv;
  float acc = 0.0;
  for(int i=0;i<3;i++){
    float fi = float(i);
    vec2 q = p * (1.0 + fi*0.63) + vec2(t*(0.07+fi*0.031), -t*(0.053+fi*0.021));
    vec3 w = worley(q);
    float ridge = 1.0 - smoothstep(0.0, 0.34, w.y - w.x);
    acc += ridge * (1.0 - fi*0.26);
  }
  return acc;
}
`;

GLSL.color = /* glsl */`
float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 saturateColor(vec3 c, float s){ return mix(vec3(luma(c)), c, s); }
vec3 acesFilm(vec3 x){
  const float a=2.51, b=0.03, c=2.43, d=0.59, e=0.14;
  return clamp((x*(a*x+b))/(x*(c*x+d)+e), 0.0, 1.0);
}
// Slightly softer shoulder than ACES; keeps saturated sunsets from going white.
vec3 tonemapFilmic(vec3 x){
  x = max(vec3(0.0), x);
  vec3 t = acesFilm(x);
  vec3 r = x/(1.0+luma(x));
  return mix(t, r, 0.25);
}
vec3 linearToSrgb(vec3 c){
  return mix(c*12.92, 1.055*pow(max(c,vec3(1e-5)), vec3(1.0/2.4))-0.055, step(0.0031308, c));
}
vec3 srgbToLinear(vec3 c){
  return mix(c/12.92, pow((c+0.055)/1.055, vec3(2.4)), step(0.04045, c));
}
`;

GLSL.util = /* glsl */`
float sat(float x){ return clamp(x, 0.0, 1.0); }
vec3  sat3(vec3 x){ return clamp(x, 0.0, 1.0); }
mat2 rot2(float a){ float s=sin(a), c=cos(a); return mat2(c,-s,s,c); }
float remap(float x, float a, float b, float c, float d){ return c + (d-c)*sat((x-a)/max(b-a,1e-5)); }
// Interleaved gradient noise — the good cheap dither.
float ign(vec2 p){ return fract(52.9829189*fract(dot(p, vec2(0.06711056, 0.00583715)))); }
float fresnelSchlick(float cosT, float f0){ float m = clamp(1.0-cosT, 0.0, 1.0); float m2=m*m; return f0 + (1.0-f0)*m2*m2*m; }
`;

/** Convenience: everything, in dependency order. */
GLSL.all = GLSL.constants + GLSL.util + GLSL.hash + GLSL.noise + GLSL.fbm + GLSL.worley + GLSL.color;

/** The subset most surface shaders want. */
GLSL.common = GLSL.constants + GLSL.util + GLSL.hash + GLSL.noise + GLSL.fbm;
