// GPU 3D stable-fluids solver on a Z-slice atlas.
//
// Fields (all N³, RGBA16F atlases): velocity (voxels/s), foam density,
// pressure ×2 (warm-started), divergence, curl, light transmittance.

import * as THREE from '../vendor/three.module.min.js';
import {
  FS_TRI_VERT, ADVECT_FRAG, MM_ADVECT_FRAG, MM_COMBINE_FRAG, FORCES_FRAG,
  INJECT_FRAG, CURL_FRAG, CONFINE_FRAG, DIVERGENCE_FRAG, JACOBI_FRAG,
  PROJECT_FRAG, LIGHT_FRAG,
} from './shaders.js';

export class Fluid {
  constructor(renderer, { N = 100, jacobi = 22, lightDir }) {
    this.renderer = renderer;
    this.N = N;
    this.jacobi = jacobi;
    this.T = Math.ceil(Math.sqrt(N));
    this.R = Math.ceil(N / this.T);
    this.W = this.T * N;
    this.H = this.R * N;

    const rt = (format = THREE.RedFormat) => new THREE.WebGLRenderTarget(this.W, this.H, {
      type: THREE.HalfFloatType,
      format,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });

    // vector fields need rgba; scalar fields are R16F
    this.vel = [rt(THREE.RGBAFormat), rt(THREE.RGBAFormat)];
    this.foam = [rt(), rt()];
    this.prs = [rt(), rt()];
    this.div = rt();
    this.curl = rt(THREE.RGBAFormat);
    this.light = rt();
    this.tmp1 = rt(THREE.RGBAFormat); // MacCormack forward pass (val, min, max)
    this.tmp2 = rt();                 // MacCormack reverse pass
    this.bytes = this.W * this.H * (4 * 8 + 7 * 2);

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(
      new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.quad = new THREE.Mesh(geo, null);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);

    const volUniforms = () => ({
      uNi: { value: N },
      uNf: { value: N },
      uTi: { value: this.T },
      uAtlas: { value: new THREE.Vector2(this.W, this.H) },
    });
    const mat = (frag, uniforms) => new THREE.ShaderMaterial({
      vertexShader: FS_TRI_VERT,
      fragmentShader: frag,
      uniforms: { ...volUniforms(), ...uniforms },
      depthTest: false,
      depthWrite: false,
    });

    this.mAdvect = mat(ADVECT_FRAG, {
      uVel: { value: null }, uSrc: { value: null },
      uDt: { value: 0 }, uDissipation: { value: 1 },
    });
    this.mForces = mat(FORCES_FRAG, {
      uVel: { value: null }, uFoam: { value: null },
      uDt: { value: 0 },
      uBuoyancy: { value: 0.24 * N },   // grid-invariant: 0.48 world units/s^2
      uMaxVel: { value: N * 2.6 },
      uPaddleOn: { value: 0 },
      uPaddlePos: { value: new THREE.Vector3() },
      uPaddleVel: { value: new THREE.Vector3() },
      uPaddleAngVel: { value: new THREE.Vector3() },
      uPaddleHalf: { value: new THREE.Vector3(0.3, 0.05, 0.2) },
      uPaddleRot: { value: new THREE.Matrix3() },
      uBarrelOn: { value: 0 },
      uBarrelPos: { value: new THREE.Vector3() },
      uBarrelVel: { value: new THREE.Vector3() },
      uBarrelAngVel: { value: new THREE.Vector3() },
      uBarrelHalf: { value: new THREE.Vector3(0.13, 0.17, 0.13) },
      uBarrelRot: { value: new THREE.Matrix3() },
      uBurstPos: { value: new THREE.Vector3() },
      uBurstAmt: { value: 0 },
      uBurstUp: { value: 0 },
      uBurstR: { value: 0.18 },
    });
    this.mInject = mat(INJECT_FRAG, {
      uFoam: { value: null },
      uDt: { value: 0 }, uTime: { value: 0 },
      uFoamGain: { value: 1.8 },
      uPaddleOn: { value: 0 },
      uPaddlePos: { value: new THREE.Vector3() },
      uPaddleVelW: { value: new THREE.Vector3() },
      uPaddleAngVel: { value: new THREE.Vector3() },
      uPaddleHalf: { value: new THREE.Vector3(0.3, 0.05, 0.2) },
      uPaddleRot: { value: new THREE.Matrix3() },
      uBarrelOn: { value: 0 },
      uBarrelPos: { value: new THREE.Vector3() },
      uBarrelVelW: { value: new THREE.Vector3() },
      uBarrelAngVel: { value: new THREE.Vector3() },
      uBarrelHalf: { value: new THREE.Vector3(0.13, 0.17, 0.13) },
      uBarrelRot: { value: new THREE.Matrix3() },
      uBurstPos: { value: new THREE.Vector3() },
      uBurstFoam: { value: 0 },
      uBurstR: { value: 0.18 },
    });
    this.mMMAdvect = mat(MM_ADVECT_FRAG, {
      uVel: { value: null }, uSrc: { value: null }, uDt: { value: 0 },
    });
    this.mMMCombine = mat(MM_COMBINE_FRAG, {
      uPhi0: { value: null }, uPhi1: { value: null }, uPhi2: { value: null },
      uDissipation: { value: 1 },
    });
    this.mCurl = mat(CURL_FRAG, { uVel: { value: null } });
    this.mConfine = mat(CONFINE_FRAG, {
      uVel: { value: null }, uCurl: { value: null },
      uDt: { value: 0 },
      uEps: { value: 0.09 * N },        // grid-invariant confinement strength
      uMaxVel: { value: N * 2.6 },
    });
    this.mDiv = mat(DIVERGENCE_FRAG, { uVel: { value: null } });
    this.mJacobi = mat(JACOBI_FRAG, { uPrs: { value: null }, uDiv: { value: null } });
    this.mProject = mat(PROJECT_FRAG, { uVel: { value: null }, uPrs: { value: null } });
    this.mLight = mat(LIGHT_FRAG, {
      uFoam: { value: null },
      uLightDir: { value: lightDir.clone() },
      uStepLen: { value: N / 22 },
      uSigmaFoam: { value: 22 / N },    // grid-invariant: 11 per world unit
      uSigmaWater: { value: 0.9 / N },
    });

    // one-shot inputs, armed from main and cleared after the step
    this.burst = null;   // { pos, vel, up, foam, radius } (world units)
    this.paddle = null;  // { pos, vel(world/s), angVel, half, rot: Matrix3, on }
    this.barrel = null;  // same shape as paddle
  }

  pass(material, target) {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, this.camera);
  }

  step(dt, time) {
    const { vel, foam, prs } = this;
    const voxPerWorld = this.N / 2;

    // advect velocity
    this.mAdvect.uniforms.uVel.value = vel[0].texture;
    this.mAdvect.uniforms.uSrc.value = vel[0].texture;
    this.mAdvect.uniforms.uDt.value = dt;
    // decay is time-based (per 1/60 s), not per-frame, so the sim looks the
    // same at any refresh rate
    this.mAdvect.uniforms.uDissipation.value = Math.pow(0.999, dt * 60);
    this.pass(this.mAdvect, vel[1]);
    vel.reverse();

    // body forces + interaction impulses
    const fu = this.mForces.uniforms;
    fu.uVel.value = vel[0].texture;
    fu.uFoam.value = foam[0].texture;
    fu.uDt.value = dt;
    if (this.paddle && this.paddle.on) {
      fu.uPaddleOn.value = 1;
      fu.uPaddlePos.value.copy(this.paddle.pos);
      fu.uPaddleVel.value.copy(this.paddle.vel).multiplyScalar(voxPerWorld);
      fu.uPaddleAngVel.value.copy(this.paddle.angVel);
      fu.uPaddleHalf.value.copy(this.paddle.half);
      fu.uPaddleRot.value.copy(this.paddle.rot);
    } else {
      fu.uPaddleOn.value = 0;
    }
    if (this.barrel && this.barrel.on) {
      fu.uBarrelOn.value = 1;
      fu.uBarrelPos.value.copy(this.barrel.pos);
      fu.uBarrelVel.value.copy(this.barrel.vel).multiplyScalar(voxPerWorld);
      fu.uBarrelAngVel.value.copy(this.barrel.angVel);
      fu.uBarrelHalf.value.copy(this.barrel.half);
      fu.uBarrelRot.value.copy(this.barrel.rot);
    } else {
      fu.uBarrelOn.value = 0;
    }
    if (this.burst) {
      fu.uBurstPos.value.copy(this.burst.pos);
      fu.uBurstAmt.value = this.burst.vel * voxPerWorld;
      fu.uBurstUp.value = (this.burst.up ?? 0) * voxPerWorld;
      fu.uBurstR.value = this.burst.radius ?? 0.18;
    } else {
      fu.uBurstAmt.value = 0;
      fu.uBurstUp.value = 0;
    }
    this.pass(this.mForces, vel[1]);
    vel.reverse();

    // vorticity confinement
    this.mCurl.uniforms.uVel.value = vel[0].texture;
    this.pass(this.mCurl, this.curl);
    this.mConfine.uniforms.uVel.value = vel[0].texture;
    this.mConfine.uniforms.uCurl.value = this.curl.texture;
    this.mConfine.uniforms.uDt.value = dt;
    this.pass(this.mConfine, vel[1]);
    vel.reverse();

    // pressure solve + projection
    this.mDiv.uniforms.uVel.value = vel[0].texture;
    this.pass(this.mDiv, this.div);
    for (let i = 0; i < this.jacobi; i++) {
      this.mJacobi.uniforms.uPrs.value = prs[0].texture;
      this.mJacobi.uniforms.uDiv.value = this.div.texture;
      this.pass(this.mJacobi, prs[1]);
      prs.reverse();
    }
    this.mProject.uniforms.uVel.value = vel[0].texture;
    this.mProject.uniforms.uPrs.value = prs[0].texture;
    this.pass(this.mProject, vel[1]);
    vel.reverse();

    // advect foam with the divergence-free field. MacCormack (forward,
    // reverse, limited combine) keeps plume filaments crisp where plain
    // semi-Lagrangian advection would smear them.
    this.mMMAdvect.uniforms.uVel.value = vel[0].texture;
    this.mMMAdvect.uniforms.uSrc.value = foam[0].texture;
    this.mMMAdvect.uniforms.uDt.value = dt;
    this.pass(this.mMMAdvect, this.tmp1);

    this.mAdvect.uniforms.uVel.value = vel[0].texture;
    this.mAdvect.uniforms.uSrc.value = this.tmp1.texture;
    this.mAdvect.uniforms.uDt.value = -dt;
    this.mAdvect.uniforms.uDissipation.value = 1;
    this.pass(this.mAdvect, this.tmp2);

    this.mMMCombine.uniforms.uPhi0.value = foam[0].texture;
    this.mMMCombine.uniforms.uPhi1.value = this.tmp1.texture;
    this.mMMCombine.uniforms.uPhi2.value = this.tmp2.texture;
    this.mMMCombine.uniforms.uDissipation.value = Math.pow(0.978, dt * 60);
    this.pass(this.mMMCombine, foam[1]);
    foam.reverse();

    // inject foam
    const iu = this.mInject.uniforms;
    iu.uFoam.value = foam[0].texture;
    iu.uDt.value = dt;
    iu.uTime.value = time;
    if (this.paddle && this.paddle.on) {
      iu.uPaddleOn.value = 1;
      iu.uPaddlePos.value.copy(this.paddle.pos);
      iu.uPaddleHalf.value.copy(this.paddle.half);
      iu.uPaddleRot.value.copy(this.paddle.rot);
      iu.uPaddleVelW.value.copy(this.paddle.vel);
      iu.uPaddleAngVel.value.copy(this.paddle.angVel);
    } else {
      iu.uPaddleOn.value = 0;
    }
    if (this.barrel && this.barrel.on) {
      iu.uBarrelOn.value = 1;
      iu.uBarrelPos.value.copy(this.barrel.pos);
      iu.uBarrelVelW.value.copy(this.barrel.vel);
      iu.uBarrelAngVel.value.copy(this.barrel.angVel);
      iu.uBarrelHalf.value.copy(this.barrel.half);
      iu.uBarrelRot.value.copy(this.barrel.rot);
    } else {
      iu.uBarrelOn.value = 0;
    }
    if (this.burst) {
      iu.uBurstPos.value.copy(this.burst.pos);
      iu.uBurstFoam.value = this.burst.foam;
      iu.uBurstR.value = this.burst.radius ?? 0.18;
      this.burst = null;
    } else {
      iu.uBurstFoam.value = 0;
    }
    this.pass(this.mInject, foam[1]);
    foam.reverse();

    // light transmittance volume
    this.mLight.uniforms.uFoam.value = foam[0].texture;
    this.pass(this.mLight, this.light);

    this.renderer.setRenderTarget(null);
  }

  clear() {
    const r = this.renderer;
    const targets = [...this.vel, ...this.foam, ...this.prs, this.div, this.curl];
    const old = new THREE.Color();
    r.getClearColor(old);
    const oldAlpha = r.getClearAlpha();
    r.setClearColor(0x000000, 0);
    for (const t of targets) { r.setRenderTarget(t); r.clear(); }
    r.setClearColor(0xffffff, 1);
    r.setRenderTarget(this.light);
    r.clear();
    r.setClearColor(old, oldAlpha);
    r.setRenderTarget(null);
  }

  get foamTexture() { return this.foam[0].texture; }
  get lightTexture() { return this.light.texture; }
}
