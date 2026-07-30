// Inverted sphere painted with the shared skyColor() gradient plus a big
// soft sun disc that the bloom pass turns into the evening glow.

import * as THREE from 'three';
import { skyColorGLSL, skyUniforms } from '../shaders/chunks.js';

export function createSky(scene) {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: skyUniforms(),
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vDir;
      ${skyColorGLSL}
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      void main() {
        vec3 d = normalize(vDir);
        vec3 c = skyColor(d);
        float s = max(dot(d, uSunDir), 0.0);
        c += uSunTint * smoothstep(0.99945, 0.99980, s) * 2.4;  // the disc itself
        c += (hash(d.xy * 480.0) - 0.5) * 0.012;                // dither the gradient
        gl_FragColor = vec4(c, 1.0);
      }
    `,
  });

  const mesh = new THREE.Mesh(new THREE.SphereGeometry(650, 40, 20), mat);
  mesh.name = 'sky';
  mesh.renderOrder = -1;
  mesh.frustumCulled = false;
  scene.add(mesh);
  return { mesh };
}
