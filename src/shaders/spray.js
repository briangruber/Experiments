// GPU spray. Particles live entirely in two float textures; emission samples the
// ocean's own folding term, so droplets only ever leave genuinely breaking water.

import { NOISE_GLSL, ATMOSPHERE_GLSL, SKY_LUT_MAP_GLSL } from './sky.js';

const SAMPLE_OCEAN = /* glsl */`
uniform sampler2DArray uDisp, uFoam;
uniform float uPatch[4];
uniform int uCascadeCount;

vec4 oceanAt(vec2 xz){
  vec3 d = vec3(0.0);
  float foam = 0.0, fold = 0.0;
  for (int c=0;c<4;c++){
    if (c >= uCascadeCount) break;
    vec3 uvc = vec3(xz/uPatch[c], float(c));
    d += texture(uDisp, uvc).xyz;
    vec2 f = texture(uFoam, uvc).xy;
    foam += f.x; fold += f.y;
  }
  return vec4(d.y, foam, fold, 0.0);
}
`;

export const SPRAY_SIM_FS = /* glsl */`
${NOISE_GLSL}
${SAMPLE_OCEAN}
in vec2 vUv;
uniform sampler2D uPos, uVel;
uniform vec3  uCamPos, uWind;
uniform float uDt, uTime, uFrame;
uniform float uSpawnRadius, uSpawnRate, uFoldThreshold;
uniform float uLifetime, uGravity, uDrag, uLaunchSpeed, uSizeMin, uSizeMax;
uniform float uHeightScale;
layout(location=0) out vec4 oPos;   // xyz world, w life remaining
layout(location=1) out vec4 oVel;   // xyz velocity, w size

void main(){
  vec4 P = texture(uPos, vUv);
  vec4 V = texture(uVel, vUv);
  float id = vUv.x*4096.0 + vUv.y*7919.0;

  if (P.w <= 0.0){
    // Dead: try to find a breaking crest to be born on.
    float h1 = hash12(vec2(id, uFrame*0.37));
    float h2 = hash12(vec2(id*1.7+3.1, uFrame*0.71));
    float h3 = hash12(vec2(id*2.3+9.7, uFrame*1.13));
    if (h3 > uSpawnRate){ oPos = vec4(P.xyz, 0.0); oVel = V; return; }

    // Concentrate spawns near the camera where they are actually resolvable.
    float r = uSpawnRadius * pow(h1, 0.55);
    float a = h2 * 6.28318530718;
    vec2 xz = uCamPos.xz + vec2(cos(a), sin(a)) * r;
    vec4 o = oceanAt(xz);
    if (o.z < uFoldThreshold){ oPos = vec4(P.xyz, 0.0); oVel = V; return; }

    float energy = clamp((o.z - uFoldThreshold) / max(1.0 - uFoldThreshold, 0.05), 0.0, 1.0);
    vec3 p = vec3(xz.x, o.x*uHeightScale + 0.05, xz.y);
    float s1 = hash12(vec2(id*3.3, uFrame*0.23)) - 0.5;
    float s2 = hash12(vec2(id*5.1, uFrame*0.29)) - 0.5;
    float s3 = hash12(vec2(id*7.9, uFrame*0.31));
    vec3 v = normalize(vec3(s1*1.4, 1.0, s2*1.4)) * uLaunchSpeed * (0.35 + 1.15*energy) * (0.5+s3);
    v += uWind * (0.25 + 0.55*s3);
    oPos = vec4(p, uLifetime * (0.45 + 0.9*hash12(vec2(id*11.0, uFrame))));
    oVel = vec4(v, mix(uSizeMin, uSizeMax, hash12(vec2(id*13.0, uFrame))) * (0.6+0.8*energy));
    return;
  }

  vec3 v = V.xyz;
  // Wind drag pulls droplets downwind into streaks; gravity brings them home.
  v += (uWind - v) * clamp(uDrag*uDt, 0.0, 1.0);
  v.y -= uGravity * uDt;
  // A little turbulence so the plume is not a clean ballistic fan.
  v += (vec3(vnoise(P.xyz*0.15 + uTime*0.6), vnoise(P.xyz*0.15 + 31.0 + uTime*0.6), vnoise(P.xyz*0.15 + 77.0 + uTime*0.6)) - 0.5) * uDt * 3.0;

  vec3 p = P.xyz + v*uDt;
  float life = P.w - uDt;

  float surf = oceanAt(p.xz).x * uHeightScale;
  if (p.y < surf) life = 0.0;
  if (distance(p.xz, uCamPos.xz) > uSpawnRadius*1.6) life = 0.0;

  oPos = vec4(p, max(life, 0.0));
  oVel = vec4(v, V.w);
}
`;

export const SPRAY_VS = /* glsl */`
layout(location=0) in vec2 aCorner;
uniform sampler2D uPos, uVel;
uniform mat4 uViewProj;
uniform vec3 uCamRight, uCamUp, uCamPos;
uniform float uTexSize, uLifetime, uSizeScale, uStretch;
out vec2 vCorner;
out float vFade;
out vec3 vWorld;
out float vSeed;

void main(){
  int id = gl_InstanceID;
  int w = int(uTexSize);
  vec2 uv = (vec2(float(id % w), float(id / w)) + 0.5) / uTexSize;
  vec4 P = texture(uPos, uv);
  vec4 V = texture(uVel, uv);
  if (P.w <= 0.0){ gl_Position = vec4(2.0,2.0,2.0,1.0); vFade=0.0; vCorner=aCorner; vWorld=vec3(0.0); vSeed=0.0; return; }

  float age = 1.0 - clamp(P.w/uLifetime, 0.0, 1.0);
  // Droplets expand into mist as they age, then fade out.
  float size = V.w * uSizeScale * (0.55 + 1.9*age);
  vFade = smoothstep(0.0, 0.12, 1.0-age) * smoothstep(1.0, 0.72, age);

  // Motion stretch along the velocity direction reads as speed.
  vec3 vd = length(V.xyz) > 0.001 ? normalize(V.xyz) : vec3(0.0,1.0,0.0);
  float along = dot(vd, uCamRight)*aCorner.x + dot(vd, uCamUp)*aCorner.y;
  vec3 offs = uCamRight*aCorner.x + uCamUp*aCorner.y;
  offs += vd * along * uStretch * clamp(length(V.xyz)*0.05, 0.0, 1.5);

  vec3 world = P.xyz + offs * size;
  vWorld = world;
  vCorner = aCorner;
  vSeed = fract(float(id)*0.618034);
  gl_Position = uViewProj * vec4(world, 1.0);
}
`;

export const SPRAY_FS = /* glsl */`
${ATMOSPHERE_GLSL}
${SKY_LUT_MAP_GLSL}
in vec2 vCorner;
in float vFade;
in vec3 vWorld;
in float vSeed;
uniform sampler2D uSkyLUT;
uniform vec3 uSunDir, uSunColor, uCamPos;
uniform float uOpacity, uScatter;
out vec4 fragColor;

void main(){
  float d = length(vCorner);
  if (d > 1.0) discard;
  // Soft droplet falloff; slightly denser core keeps it from looking like fog.
  float a = pow(1.0 - d, 1.7) * vFade * uOpacity;
  if (a < 0.002) discard;

  vec3 V = normalize(uCamPos - vWorld);
  vec3 sunTr = sunTransmittance(vec3(0.0, R_PLANET + max(uCamPos.y,1.0), 0.0), uSunDir);
  vec3 sun = uSunColor * sunTr * uAtmoExposure * smoothstep(-0.09, 0.02, uSunDir.y);
  vec3 amb = textureLod(uSkyLUT, dirToSkyUv(vec3(0.0,1.0,0.0)), 2.0).rgb;

  // Water droplets forward-scatter hard: backlit spray is the money shot.
  float mu = dot(-V, uSunDir);
  float phase = miePhase(mu, 0.62)*0.85 + 0.15/(4.0*3.14159265);
  vec3 col = sun * phase * uScatter * 6.0 + amb * 0.85;

  fragColor = vec4(col * a, a);
}
`;
