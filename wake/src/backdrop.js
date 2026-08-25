// Sky and far water.
//
// The detailed ocean is only a few hundred metres across — enough for the wake
// and no more — so from any altitude you were looking at a square of water
// floating in the void. This supplies what sits beyond it: a sky gradient and a
// flat sea running to the horizon.
//
// Both follow the camera, so the horizon is always at the right distance and
// neither ever runs out.
//
// The far water deliberately mirrors the detail shader's far-field terms —
// deep colour, Fresnel toward the sky, haze — because the join between them has
// to be invisible. Anything the detail plane does that this does not becomes a
// visible square edge in the middle of the sea.

import * as THREE from 'three';
import { get } from './params.js';
import { SKY_GLSL } from './sky.js';

const SHARED = /* glsl */`
  uniform vec3  uDeep, uSky, uHorizon, uZenith, uSunDir;
  uniform float uExposure, uHazeStart, uHazeEnd, uSunGlow, uReflect, uTime;
  uniform vec3  uSunset, uTree;
  uniform float uSkyWarm, uCloud, uCloudScale, uCloudSoft, uTreeHt, uTreeRough;


  ${SKY_GLSL}
`;

const SKY_VERT = /* glsl */`
  varying vec3 vDir;
  void main(){
    vDir = position;
    // Translation-only follow: the dome rides with the camera so it can never
    // be reached, while still rotating correctly around it.
    vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position = p.xyww;            // force to the far plane
  }
`;

const SKY_FRAG = /* glsl */`
  precision highp float;
  varying vec3 vDir;
  ${SHARED}
  void main(){
    vec3 d = normalize(vDir);
    // skyColour for every direction, including below the horizon: it carries
    // the treeline, and branching away from it there cut the shore off at the
    // waterline and left a grey sliver between the trees and their reflection.
    // Only well below does it settle towards deep water.
    vec3 c = mix(skyColour(d), uDeep, smoothstep(0.0, 0.22, -d.y));
    gl_FragColor = vec4(tonemap(c), 1.0);
  }
`;

const SEA_VERT = /* glsl */`
  varying vec3 vWorld;
  void main(){
    vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
  }
`;

const SEA_FRAG = /* glsl */`
  precision highp float;
  varying vec3 vWorld;
  uniform vec3 uEye;
  ${SHARED}
  void main(){
    vec3 N = vec3(0.0, 1.0, 0.0);
    vec3 V = normalize(uEye - vWorld);

    float fres = mix(0.02, 1.0, pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 5.0));
    vec3 R = reflect(-V, N);
    vec3 col = mix(uDeep, skyColour(R), fres * uReflect);

    // The detailed plane adds this; without it here the far sea sits about a
    // fifth darker and the join between them shows as a rectangle on the water.
    col += uDeep * max(dot(N, normalize(uSunDir)), 0.0) * 0.25;

    // Haze over kilometres, not hundreds of metres. Keyed too close, it turns
    // the whole sea into flat grey the moment the camera gains any altitude.
    // Distant water fades into the AIR IN THAT DIRECTION, not into a fixed
    // colour. Hazing towards a constant leaves a cool grey band along the
    // horizon that the sky no longer matches the moment it turns warm.
    float d = distance(vWorld.xz, uEye.xz);
    vec3 airCol = skyColour(normalize(vec3(-V.x, 0.05, -V.z)));
    col = mix(col, airCol, smoothstep(uHazeStart, uHazeEnd, d));

    gl_FragColor = vec4(tonemap(col), 1.0);
  }
`;

export class Backdrop {
  constructor() {
    this.uniforms = {
      uDeep: { value: new THREE.Color() },
      uSky: { value: new THREE.Color() },
      uHorizon: { value: new THREE.Color() },
      uZenith: { value: new THREE.Color() },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uExposure: { value: 1 },
      uHazeStart: { value: 1200 },
      uHazeEnd: { value: 14000 },
      uSunGlow: { value: 1 }, uReflect: { value: 1 }, uTime: { value: 0 },
      uSunset: { value: new THREE.Color() }, uTree: { value: new THREE.Color() },
      uSkyWarm: { value: 0 }, uCloud: { value: 0 }, uCloudScale: { value: 0.5 },
      uCloudSoft: { value: 0.3 }, uTreeHt: { value: 0 }, uTreeRough: { value: 0.5 },

      uEye: { value: new THREE.Vector3() },
    };

    const mat = (vs, fs, extra = {}) => new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: vs, fragmentShader: fs, ...extra,
    });

    this.sky = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 20),
      mat(SKY_VERT, SKY_FRAG, { side: THREE.BackSide, depthWrite: false, depthTest: false }));
    this.sky.renderOrder = -2;
    this.sky.frustumCulled = false;

    const sea = new THREE.PlaneGeometry(1, 1, 1, 1);
    sea.rotateX(-Math.PI / 2);
    // Drawn as a BACKGROUND, not as geometry: no depth test, no depth write,
    // before everything else. Sinking it below the detailed plane and letting
    // depth sort them out does not work -- wave troughs and the prop-wash
    // hollow dip the detailed surface below any fixed offset, and the far plane
    // then punches through as dark blotches scattered across the sea.
    this.sea = new THREE.Mesh(sea, mat(SEA_VERT, SEA_FRAG, {
      depthWrite: false, depthTest: false,
    }));
    this.sea.renderOrder = -1;
    this.sea.frustumCulled = false;
    this.sea.scale.setScalar(40000);
  }

  update(camera, sunDir, time = 0) {
    const u = this.uniforms;
    u.uEye.value.copy(camera.position);
    u.uTime.value = time;
    u.uSunDir.value.copy(sunDir);

    const lum = get('ocean.deepColor');
    const tint = get('ocean.tint');
    u.uDeep.value.setRGB(lum * 0.55, lum * (0.9 + tint * 0.5), lum * (1.6 - tint * 0.35));
    u.uSky.value.setRGB(0.42, 0.55, 0.72);
    u.uHorizon.value.setRGB(0.26, 0.35, 0.46);
    u.uZenith.value.setRGB(0.09, 0.20, 0.42);
    u.uExposure.value = get('ocean.exposure');
    u.uHazeStart.value = get('ocean.hazeStart');
    u.uHazeEnd.value = get('ocean.hazeStart') * 9.0;
    u.uSunGlow.value = get('ocean.sunGlow');
    u.uReflect.value = get('ocean.reflectivity');
    const scWarm = get('scene.warmth');
    u.uSkyWarm.value = scWarm;
    u.uCloud.value = get('scene.cloud');
    u.uCloudScale.value = get('scene.cloudScale');
    u.uCloudSoft.value = get('scene.cloudSoft');
    u.uTreeHt.value = get('scene.treeline');
    u.uTreeRough.value = get('scene.treeRough');
    const td = get('scene.treeDark');
    u.uTree.value.setRGB(td * 0.70, td * 0.92, td * 0.80);
    // Warm end of the sunset: pushed towards orange as the sun drops.
    u.uSunset.value.setRGB(1.25, 0.58, 0.26);


    this.sky.position.copy(camera.position);
    this.sky.scale.setScalar(Math.max(camera.far * 0.4, 500));
    this.sea.position.set(camera.position.x, 0, camera.position.z);
  }
}
