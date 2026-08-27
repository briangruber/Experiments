// A real lake, as geometry.
//
// Not a silhouette painted on the sky: a heightfield with shorelines, inlets
// and islands that the boat moves around in and the camera can fly over. The
// same height function is exported, so anything else that needs to know where
// the land is -- collision, spawn points, shallow water -- asks the terrain
// rather than guessing.
//
// Land below the waterline is discarded rather than drawn, so the shoreline
// lands exactly on y = 0 without the water plane having to occlude it.

import * as THREE from 'three';
import { get } from './params.js';
import { heightAt } from './lakeHeight.js';

export { heightAt };
import { SKY_GLSL } from './sky.js';

const VERT = /* glsl */`
  varying vec3 vWorld;
  varying float vSlope;
  varying vec3 vNormal;
  void main(){
    vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
    vNormal = normalize(mat3(modelMatrix) * normal);
    vSlope = vNormal.y;                      // 1 flat, 0 vertical
    gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
  }
`;

const FRAG = /* glsl */`
  precision highp float;
  varying vec3 vWorld;
  varying float vSlope;
  varying vec3 vNormal;

  uniform vec3  uHorizon, uZenith, uSky, uSunDir, uDeep, uSunset, uTree;
  uniform float uExposure, uSunGlow, uSkyWarm, uCloud, uCloudScale, uCloudSoft;
  uniform float uTreeHt, uTreeRough, uTime, uHazeStart, uHazeEnd;
  uniform vec3  uEye;
  uniform vec3  uCanopy, uShore;

  ${SKY_GLSL}

  void main(){
    // Below the waterline is lake bed, not land: drop it and let the shoreline
    // fall exactly on y = 0 without needing the water to occlude anything.
    // ANALYTIC COVERAGE, not a binary test.
    //
    // A binary y < 0 discard gives the coastline no anti-aliasing whatsoever:
    // every pixel is wholly land or wholly sea, so the edge is a staircase
    // that crawls as the camera moves. From high up, where a pixel spans
    // several metres of a 11 m-per-vertex heightfield, that reads as a
    // shoreline boiling.
    //
    // fwidth(y) is how much the height changes across ONE PIXEL, so
    // smoothstep(-w, w, y) is the fraction of this pixel that is above the
    // waterline -- coverage, computed at whatever scale the pixel happens to
    // be. It costs one derivative and is correct at every zoom, where
    // supersampling the mesh would only move the problem.
    float shoreW = max(fwidth(vWorld.y), 1e-4);
    float land = smoothstep(-shoreW, shoreW, vWorld.y);
    if (land <= 0.002) discard;

    // Trees hold the gentle ground; steep faces show through as bare shore.
    float treed = smoothstep(0.55, 0.86, vSlope);
    vec3 base = mix(uShore, uCanopy, treed);

    // The real surface normal, not one reconstructed from the slope alone --
    // that has no horizontal direction, so every hillside faced the sun equally
    // and the shore came out as a flat green wall instead of a landform.
    float lam = max(dot(normalize(vNormal), normalize(uSunDir)), 0.0);

    // A low sun barely reaches into a canopy, which is why a treed shore reads
    // almost black against a bright sky at this hour.
    vec3 col = base * (0.10 + 0.75 * lam);
    col += uSunset * pow(lam, 2.5) * uSunGlow * 0.35 * uSkyWarm;

    // Same aerial perspective as the water, so distant shore sits in the same
    // air as the sea in front of it.
    vec3 V = normalize(uEye - vWorld);
    float d = distance(vWorld.xz, uEye.xz);
    vec3 airCol = skyColour(normalize(vec3(-V.x, 0.05, -V.z)));
    col = mix(col, airCol, smoothstep(uHazeStart, uHazeEnd, d));

    gl_FragColor = vec4(tonemap(col), land);
  }
`;

export class Terrain {
  constructor(size = 4200, seg = 384) {
    this.size = size;
    this.seg = seg;
    this.uniforms = {
      uHorizon: { value: new THREE.Color() }, uZenith: { value: new THREE.Color() },
      uSky: { value: new THREE.Color() }, uDeep: { value: new THREE.Color() },
      uSunset: { value: new THREE.Color() }, uTree: { value: new THREE.Color() },
      uCanopy: { value: new THREE.Color() }, uShore: { value: new THREE.Color() },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uEye: { value: new THREE.Vector3() },
      uExposure: { value: 1 }, uSunGlow: { value: 0.5 }, uSkyWarm: { value: 0 },
      uCloud: { value: 0 }, uCloudScale: { value: 0.5 }, uCloudSoft: { value: 0.3 },
      uTreeHt: { value: 0 }, uTreeRough: { value: 0.5 }, uTime: { value: 0 },
      uHazeStart: { value: 1400 }, uHazeEnd: { value: 12600 },
    };
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG,
      side: THREE.DoubleSide,
      // The shoreline is a coverage fraction now, so the edge pixels are
      // genuinely partial and have to blend. Depth is still written: land is
      // opaque everywhere except that one-pixel fringe, and letting the boat
      // and spray depth-test against it matters far more than the fringe's
      // own sort order.
      transparent: true,
      depthWrite: true,
    }));
    this.mesh.frustumCulled = false;
    this.build();
  }

  /** Rebuild the heightfield. Cheap enough to redo when the lake params move. */
  build() {
    const { size, seg } = this;
    const g = new THREE.PlaneGeometry(size, size, seg, seg);
    g.rotateX(-Math.PI / 2);
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      pos.setY(i, heightAt(pos.getX(i), pos.getZ(i)));
    }
    g.computeVertexNormals();
    this.mesh.geometry?.dispose();
    this.mesh.geometry = g;
    this.signature = [get('lake.radius'), get('lake.depth'), get('lake.rim'),
                      get('lake.relief'), get('lake.wobble'), get('lake.islands')].join(',');
  }

  update(camera, sunDir, time) {
    const sig = [get('lake.radius'), get('lake.depth'), get('lake.rim'),
                 get('lake.relief'), get('lake.wobble'), get('lake.islands')].join(',');
    if (sig !== this.signature) this.build();

    const u = this.uniforms;
    u.uEye.value.copy(camera.position);
    u.uSunDir.value.copy(sunDir);
    u.uTime.value = time;
    u.uExposure.value = get('ocean.exposure');
    u.uSunGlow.value = get('ocean.sunGlow');
    u.uSkyWarm.value = get('scene.warmth');
    u.uCloud.value = get('scene.cloud');
    u.uCloudScale.value = get('scene.cloudScale');
    u.uCloudSoft.value = get('scene.cloudSoft');
    u.uTreeHt.value = 0;                       // the silhouette is real geometry now
    u.uTreeRough.value = get('scene.treeRough');
    u.uHazeStart.value = get('ocean.hazeStart');
    u.uHazeEnd.value = get('ocean.hazeStart') * 9;

    const lum = get('ocean.deepColor'), tint = get('ocean.tint');
    u.uDeep.value.setRGB(lum * 0.55, lum * (0.9 + tint * 0.5), lum * (1.6 - tint * 0.35));
    u.uSky.value.setRGB(0.42, 0.55, 0.72);
    u.uHorizon.value.setRGB(0.26, 0.35, 0.46);
    u.uZenith.value.setRGB(0.09, 0.20, 0.42);
    u.uSunset.value.setRGB(1.25, 0.58, 0.26);
    const td = get('scene.treeDark');
    u.uTree.value.setRGB(td * 0.70, td * 0.92, td * 0.80);

    const c = get('lake.canopy');
    u.uCanopy.value.setRGB(c * 0.42, c * 1.0, c * 0.50);
    u.uShore.value.setRGB(c * 1.5, c * 1.35, c * 1.05);
  }
}
