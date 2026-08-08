// The caustic net.
//
// A small tiling texture rendered into a render target once every couple of
// frames. Three layers of a *tiling* worley — the cell coordinates wrap at an
// integer period and the feature points orbit in place instead of the domain
// scrolling, so the pattern writhes the way real caustics do while staying
// perfectly seamless. The bright filament is the cell boundary (d2 - d1 near
// zero), sharpened with a power curve; the per-channel ridge widths give the
// warm/cool fringe that sunlight through a wavelet actually has.
//
// The water shader projects this onto the refracted seabed in world XZ.

import * as THREE from 'three';
import { GLSL } from '../core/glsl.js';

const QUAD_VERT = /* glsl */`
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const CAUSTIC_FRAG = /* glsl */`
varying vec2 vUv;
uniform float uTime;
uniform float uSeed;
${GLSL.constants}
${GLSL.util}
${GLSL.hash}

// Feature point of a cell, orbiting rather than translating: the tiling stays
// exact for any t.
vec2 cellPoint(vec2 cell, float t){
  vec2 h = hash22(cell);
  return 0.5 + 0.44 * sin(TAU*h + t*(0.72 + h.x*0.95));
}

// Worley whose lattice wraps at "period", so uv*period tiles over [0,1].
vec2 worleyTile(vec2 p, float period, float t, float seed){
  vec2 i = floor(p), f = fract(p);
  float d1 = 8.0, d2 = 8.0;
  for(int y=-1;y<=1;y++){
    for(int x=-1;x<=1;x++){
      vec2 g = vec2(float(x), float(y));
      vec2 cell = mod(i + g + period, period) + seed;
      float d = length(g + cellPoint(cell, t) - f);
      d2 = min(d2, max(d, d1));
      d1 = min(d1, d);
    }
  }
  return vec2(d1, d2);
}

// The filament, with a slightly different width per channel — red spills
// widest, so the outside of every strand goes warm and the core stays white.
vec3 ridgeRGB(vec2 p, float period, float t, float seed){
  vec2 w = worleyTile(p, period, t, seed);
  float e = w.y - w.x;
  return 1.0 - smoothstep(vec3(0.0), vec3(0.345, 0.296, 0.252), vec3(e));
}

void main(){
  vec2 p = vUv;
  float t = uTime;

  vec3 s = ridgeRGB(p * 5.0,   5.0, t * 0.55, uSeed)
         + ridgeRGB(p * 9.0,   9.0, t * 0.82, uSeed + 17.0) * 0.74
         + ridgeRGB(p * 17.0, 17.0, t * 1.14, uSeed + 53.0) * 0.46;

  // Sharpen the sum into filaments rather than a blurry mesh.
  s = pow(sat3(s * 0.56), vec3(2.4)) * 3.4;

  // A slow, large-scale swell in brightness so the net breathes.
  vec2 m = worleyTile(p * 3.0, 3.0, t * 0.26, uSeed + 91.0);
  s *= 0.40 + 0.80 * smoothstep(0.10, 0.62, m.y - m.x);

  // Stored at 0.4 scale: the byte target keeps ~2.5 units of headroom.
  gl_FragColor = vec4(sat3(s) * 0.4, 1.0);
}
`;

/**
 * @param {object} opts
 * @param {THREE.WebGLRenderer} opts.renderer
 * @param {number} [opts.size]     texture edge, power of two
 * @param {number} [opts.fps]      how often it is allowed to re-render
 * @param {number} [opts.seed]
 */
export function createCaustics({ renderer, size = 256, fps = 30, seed = 1 } = {}) {
  const target = new THREE.WebGLRenderTarget(size, size, {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    depthBuffer: false,
    stencilBuffer: false,
    colorSpace: THREE.NoColorSpace,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: true,
  });
  target.texture.wrapS = THREE.RepeatWrapping;
  target.texture.wrapT = THREE.RepeatWrapping;
  const maxAniso = renderer?.capabilities?.getMaxAnisotropy ? renderer.capabilities.getMaxAnisotropy() : 1;
  target.texture.anisotropy = Math.min(4, maxAniso || 1);

  const material = new THREE.ShaderMaterial({
    vertexShader: QUAD_VERT,
    fragmentShader: CAUSTIC_FRAG,
    uniforms: {
      uTime: { value: 0 },
      uSeed: { value: (seed % 97) * 0.37 },
    },
    depthTest: false,
    depthWrite: false,
  });

  const geometry = new THREE.PlaneGeometry(2, 2);
  const quad = new THREE.Mesh(geometry, material);
  quad.frustumCulled = false;
  const quadScene = new THREE.Scene();
  quadScene.add(quad);
  const quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const interval = 1 / Math.max(1, fps);
  let last = -1e9;

  function draw(time) {
    material.uniforms.uTime.value = time;
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(target);
    renderer.render(quadScene, quadCamera);
    renderer.setRenderTarget(prev);
  }

  // Fill it once so the first frame never samples an uninitialised target.
  draw(0);

  return {
    texture: target.texture,
    size,
    update(time) {
      if (time - last < interval) return;
      last = time;
      draw(time);
    },
    dispose() {
      target.dispose();
      geometry.dispose();
      material.dispose();
    },
  };
}
