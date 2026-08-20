// GPU bubble particles: positions in a ping-pong float texture, advected by
// the fluid velocity field, emitted where the paddle churns, drawn as small
// additive points gated to the shell of foam plumes.

import * as THREE from '../vendor/three.module.min.js';
import { FS_TRI_VERT, PARTICLE_UPDATE_FRAG, PARTICLE_VERT, PARTICLE_FRAG } from './shaders.js';

export class Particles {
  constructor(renderer, fluid, texSize) {
    const surfaceY = fluid.surfaceY ?? 0.72;
    this.renderer = renderer;
    this.fluid = fluid;
    this.size = texSize;
    this.count = texSize * texSize;

    const rt = () => new THREE.WebGLRenderTarget(texSize, texSize, {
      type: THREE.FloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });
    this.pos = [rt(), rt()];
    this.bytes = 2 * texSize * texSize * 16;

    const volUniforms = {
      uNi: { value: fluid.N }, uNf: { value: fluid.N },
      uTi: { value: fluid.T }, uAtlas: { value: new THREE.Vector2(fluid.W, fluid.H) },
    };

    this.updateMat = new THREE.ShaderMaterial({
      vertexShader: FS_TRI_VERT,
      fragmentShader: PARTICLE_UPDATE_FRAG,
      depthTest: false, depthWrite: false,
      uniforms: {
        ...volUniforms,
        uPos: { value: null },
        uVel: { value: null },
        uDt: { value: 0 },
        uTime: { value: 0 },
        uInit: { value: 1 },
        uPaddlePos: { value: new THREE.Vector3() },
        uPaddleSpeed: { value: 0 },
        uSurfaceY: { value: surfaceY },
      },
    });

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const quadGeo = new THREE.BufferGeometry();
    quadGeo.setAttribute('position', new THREE.BufferAttribute(
      new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.quad = new THREE.Mesh(quadGeo, this.updateMat);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.count * 3), 3));
    this.material = new THREE.ShaderMaterial({
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: false, depthWrite: false,
      uniforms: {
        ...volUniforms,
        uPos: { value: null },
        uFoamTex: { value: null },
        uLightTex: { value: null },
        uTexSize: { value: texSize },
        uPointScale: { value: 3.0 },
        uPaddlePos: { value: new THREE.Vector3() },
      },
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.pointScene = new THREE.Scene();
    this.pointScene.add(this.points);
  }

  step(dt, time, paddlePos, paddleSpeed) {
    const u = this.updateMat.uniforms;
    u.uPos.value = this.pos[0].texture;
    u.uVel.value = this.fluid.vel[0].texture;
    u.uDt.value = dt;
    u.uTime.value = time;
    u.uPaddlePos.value.copy(paddlePos);
    u.uPaddleSpeed.value = paddleSpeed;
    this.material.uniforms.uPaddlePos.value.copy(paddlePos);
    this.renderer.setRenderTarget(this.pos[1]);
    this.renderer.render(this.scene, this.camera);
    this.pos.reverse();
    u.uInit.value = 0;
    this.renderer.setRenderTarget(null);
  }

  // draw into the currently bound target with the scene camera
  draw(camera, heightPx) {
    const m = this.material.uniforms;
    m.uPos.value = this.pos[0].texture;
    m.uFoamTex.value = this.fluid.foamTexture;
    m.uLightTex.value = this.fluid.lightTexture;
    m.uPointScale.value = heightPx * 0.0022;
    this.renderer.render(this.pointScene, camera);
  }
}
