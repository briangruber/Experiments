// The water the wake is drawn on.
//
// Deliberately plain: a few sine swells plus a little chop, so that anything
// that looks interesting in a screenshot is coming from the wake and not from
// the ocean dressing it up.
//
// Everything the wake contributes arrives through one texture lookup, and the
// surface normal is central-differenced from the same height function used for
// displacement — so the ridge shading and the geometry can never disagree.

import * as THREE from 'three';
import { get } from './params.js';

const HEIGHT_GLSL = /* glsl */`
  uniform sampler2D uWake;
  uniform vec2  uWakeCenter;
  uniform float uWakeExtent;
  uniform float uSwellAmp, uSwellLen, uChopAmp, uTime;
  uniform vec3  uEyePos;
  uniform float uVertexStep;

  vec2 wakeUV(vec2 p){ return (p - uWakeCenter) / uWakeExtent * vec2(1.0, -1.0) + 0.5; }

  vec4 wakeAt(vec2 p){
    vec2 uv = wakeUV(p);
    if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return vec4(0.0);
    // Feather the field edge so the wake doesn't end on a straight cut.
    vec2 e = smoothstep(vec2(0.0), vec2(0.03), uv) * (1.0 - smoothstep(vec2(0.97), vec2(1.0), uv));
    return texture2D(uWake, uv) * (e.x * e.y);
  }

  // px: the world-space width of one screen pixel here. Any wave shorter than a
  // couple of pixels is just a moire generator, so it is faded out.
  float swellAt(vec2 p, float px){
    float lod  = 1.0 - smoothstep(0.10, 0.42, px / max(uSwellLen * 0.17, 0.5));
    float lodS = 1.0 - smoothstep(0.10, 0.42, px / max(uSwellLen, 1.0));
    float k = 6.28318 / max(uSwellLen, 1.0);
    float h = sin(p.x * k * 0.86 + p.y * k * 0.51 - uTime * 0.55) * uSwellAmp * lodS;
    h += sin(p.x * k * -0.42 + p.y * k * 1.13 - uTime * 0.79) * uSwellAmp * 0.55 * lodS;
    float kc = 6.28318 / (max(uSwellLen, 1.0) * 0.17);
    h += sin(p.x * kc * 1.1 + p.y * kc * 0.7 - uTime * 2.4) * uChopAmp * lod;
    h += sin(p.x * kc * -0.6 + p.y * kc * 1.4 - uTime * 3.1) * uChopAmp * 0.7 * lod;
    return h;
  }

  // One height function, used for both displacement and normals.
  float heightAt(vec2 p, float px){
    vec4 w = wakeAt(p);
    return swellAt(p, px) * (1.0 - w.b) + w.g;
  }
`;

const VERT = /* glsl */`
  precision highp float;
  varying vec3 vWorld;
  ${HEIGHT_GLSL}
  void main(){
    vec3 wp = (modelMatrix * vec4(position, 1.0)).xyz;
    wp.y = heightAt(wp.xz, uVertexStep);
    vWorld = wp;
    gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  }
`;

const FRAG = /* glsl */`
  precision highp float;
  varying vec3 vWorld;
  ${HEIGHT_GLSL}
  uniform vec3  uSunDir, uDeep, uSky, uHorizon;
  uniform float uSpecular, uExposure, uFar;
  #define uEye uEyePos

  void main(){
    // How wide is one pixel, here, in metres? Everything that needs a level of
    // detail hangs off this rather than off distance -- which is what makes it
    // hold up both from 20 m up and from 400 m up.
    float px = max(length(vec2(dFdx(vWorld.x), dFdy(vWorld.x))),
                   length(vec2(dFdx(vWorld.z), dFdy(vWorld.z))));
    float dist = distance(vWorld.xz, uEye.xz);   // horizontal: this is a haze, not a depth fade
    px = max(px, uVertexStep);
    float e = max(0.18, px * 1.2);

    float hL = heightAt(vWorld.xz - vec2(e, 0.0), px);
    float hR = heightAt(vWorld.xz + vec2(e, 0.0), px);
    float hD = heightAt(vWorld.xz - vec2(0.0, e), px);
    float hU = heightAt(vWorld.xz + vec2(0.0, e), px);
    vec3 N = normalize(vec3(hL - hR, 2.0 * e, hD - hU));

    vec3 V = normalize(uEye - vWorld);
    vec3 L = normalize(uSunDir);
    vec3 H = normalize(L + V);

    float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 5.0);
    fres = mix(0.02, 1.0, fres);

    vec3 sky = mix(uSky, uHorizon, pow(1.0 - clamp(N.y, 0.0, 1.0), 1.5));
    vec3 col = mix(uDeep, sky, fres);
    col += uSky * pow(max(dot(N, H), 0.0), 70.0) * uSpecular
         * (1.0 - smoothstep(0.05, 0.30, px));
    col += uDeep * max(dot(N, L), 0.0) * 0.25;

    // ------------------------------------------------------------------ foam --
    vec4 w = wakeAt(vWorld.xz);
    float foam = clamp(w.r, 0.0, 1.6);
    // Foam is thick where it is dense and thins to a bubble veil at the edges,
    // so it reads as coverage rather than as a painted-on white decal.
    // Thin aeration scatters light back as a pale teal long before it is white
    // enough to read as foam. That halo is what sells the edge of the wake.
    vec3 aerated = mix(uDeep, vec3(0.30, 0.60, 0.66), 0.80);
    col = mix(col, aerated, clamp(foam * 3.0, 0.0, 1.0) * 0.6);

    // Thin foam is a translucent veil over that teal; only thick foam is white.
    float cover = smoothstep(0.10, 0.85, foam);
    vec3 foamCol = mix(vec3(0.66, 0.78, 0.82), vec3(0.96, 0.98, 1.0),
                       smoothstep(0.35, 1.15, foam));
    foamCol *= 0.60 + 0.40 * max(dot(N, L), 0.0);
    col = mix(col, foamCol, cover);

    // Distance haze towards the horizon colour.
    col = mix(col, uHorizon, smoothstep(uFar * 0.62, uFar * 1.02, dist) * 0.9);

    col *= uExposure;
    col = col / (col + 0.72);                    // tonemap
    col = pow(clamp(col, 0.0, 1.0), vec3(1.0 / 2.2));
    gl_FragColor = vec4(col, 1.0);
  }
`;

export class Ocean {
  constructor(wakeField, size = 520, seg = 560) {
    this.size = size;
    this.uniforms = {
      uWake: { value: wakeField.rt.texture },
      uWakeCenter: { value: wakeField.center },
      uWakeExtent: { value: wakeField.extent },
      uSwellAmp: { value: 0 }, uSwellLen: { value: 20 }, uChopAmp: { value: 0 },
      uTime: { value: 0 },
      uEyePos: { value: new THREE.Vector3() },
      uVertexStep: { value: size / seg },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uDeep: { value: new THREE.Color() },
      uSky: { value: new THREE.Color() },
      uHorizon: { value: new THREE.Color() },
      uSpecular: { value: 1 }, uExposure: { value: 1 },
      uFar: { value: size * 0.55 },
    };

    const g = new THREE.PlaneGeometry(size, size, seg, seg);
    g.rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(g, new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
    }));
    this.mesh.frustumCulled = false;
  }

  update(t, eye, focusX, focusZ, wakeField) {
    const u = this.uniforms;
    u.uTime.value = t;
    u.uSwellAmp.value = get('ocean.swellAmp');
    u.uSwellLen.value = get('ocean.swellLen');
    u.uChopAmp.value = get('ocean.chopAmp');
    u.uWakeExtent.value = wakeField.extent;
    u.uEyePos.value.copy(eye);

    const el = get('ocean.sunElev') * Math.PI / 180;
    const az = get('ocean.sunAzim') * Math.PI / 180;
    u.uSunDir.value.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));

    const lum = get('ocean.deepColor');
    const tint = get('ocean.tint');
    u.uDeep.value.setRGB(lum * 0.55, lum * (0.9 + tint * 0.5), lum * (1.6 - tint * 0.35));
    u.uSky.value.setRGB(0.42, 0.55, 0.72);
    u.uHorizon.value.setRGB(0.30, 0.40, 0.53);
    u.uSpecular.value = get('ocean.specular');
    u.uExposure.value = get('ocean.exposure');

    // Follow the boat, snapped to the vertex grid so the mesh doesn't crawl.
    const step = this.size / 560 * 8;
    this.mesh.position.set(Math.round(focusX / step) * step, 0, Math.round(focusZ / step) * step);
  }
}
