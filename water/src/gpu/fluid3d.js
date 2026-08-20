// WebGPU port of the stable-fluids solver: TSL compute kernels over true 3D
// storage textures (no Z-slice atlas, hardware trilinear everywhere).
//
// The dispatch schedule is fixed so every kernel keeps the same bindings:
// velocity ends each frame in vel0, foam in foam0, warm-started pressure in
// prs0. All volumes are rgba16float (the guaranteed filterable storage
// format); scalar fields just use .x.

import * as THREE from '../../vendor/three.webgpu.min.js';

// THREE.TSL carries the full node namespace (the standalone tsl build misses
// some exports, e.g. texture3DLoad)
const {
  Fn, If, Loop, uniform, instanceIndex, textureStore, texture3DLoad,
  float, int, uint, vec3, vec4, ivec3, uvec3, smoothstep,
} = THREE.TSL;

export class Fluid3D {
  constructor(renderer, { N = 128, jacobi = 26, lightDir }) {
    this.renderer = renderer;
    this.N = N;
    this.jacobi = jacobi + (jacobi % 2); // even, so pressure ends in prs0

    const vol = () => {
      const t = new THREE.Storage3DTexture(N, N, N);
      t.type = THREE.HalfFloatType;
      t.format = THREE.RGBAFormat;
      t.minFilter = THREE.LinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.generateMipmaps = false;
      return t;
    };
    const vel0 = vol(), vel1 = vol();
    const foam0 = vol(), foam1 = vol();
    const prs0 = vol(), prs1 = vol();
    const div = vol(), curl = vol();
    const tmp1 = vol(), tmp2 = vol();
    const light = vol();
    this.foam0 = foam0;
    this.light = light;
    this.vel0 = vel0;
    this.bytes = 11 * N * N * N * 8;

    const u = this.u = {
      dt: uniform(0),
      time: uniform(0),
      dissV: uniform(1),
      dissF: uniform(1),
      buoyancy: uniform(0.24 * N),
      maxVel: uniform(2.6 * N),
      eps: uniform(0.09 * N),
      foamGain: uniform(1.8),
      paddleOn: uniform(0),
      paddlePos: uniform(new THREE.Vector3()),
      paddleVel: uniform(new THREE.Vector3()),   // voxels/s
      paddleVelW: uniform(new THREE.Vector3()),  // world/s
      paddleAng: uniform(new THREE.Vector3()),
      paddleHalf: uniform(new THREE.Vector3(0.30, 0.05, 0.20)),
      paddleRot: uniform(new THREE.Matrix3()),
      barrelOn: uniform(0),
      barrelPos: uniform(new THREE.Vector3()),
      barrelVel: uniform(new THREE.Vector3()),
      barrelVelW: uniform(new THREE.Vector3()),
      barrelAng: uniform(new THREE.Vector3()),
      barrelHalf: uniform(new THREE.Vector3(0.13, 0.17, 0.13)),
      barrelRot: uniform(new THREE.Matrix3()),
      burstPos: uniform(new THREE.Vector3()),
      burstAmt: uniform(0),
      burstUp: uniform(0),
      burstFoam: uniform(0),
      burstR: uniform(0.18),
      lightDir: uniform(lightDir.clone()),
      sigmaFoam: uniform(22 / N),
      sigmaWater: uniform(0.9 / N),
      lightStep: uniform(N / 22),
    };

    // ---- helpers -----------------------------------------------------------

    const voxel = () => {
      const id = instanceIndex;
      const x = id.mod(uint(N));
      const y = id.div(uint(N)).mod(uint(N));
      const z = id.div(uint(N * N));
      return uvec3(x, y, z);
    };
    const fetch = (tex, v) => texture3DLoad(tex, v, int(0));
    const fetchOff = (tex, v, ox, oy, oz) =>
      texture3DLoad(tex, ivec3(v).add(ivec3(ox, oy, oz)).clamp(ivec3(0), ivec3(N - 1)), int(0));
    // three r185 lowers sampled texture3D() in compute to a 2d textureLoad,
    // so trilinear filtering is done by hand from 8 exact loads
    const sample = (tex, p) => {
      const pc = p.clamp(vec3(0.5), vec3(N - 0.5)).sub(0.5);
      const i0 = ivec3(pc.floor());
      const f = pc.fract();
      const c = (ox, oy, oz) =>
        texture3DLoad(tex, i0.add(ivec3(ox, oy, oz)).clamp(ivec3(0), ivec3(N - 1)), int(0));
      const x00 = c(0, 0, 0).mix(c(1, 0, 0), f.x);
      const x10 = c(0, 1, 0).mix(c(1, 1, 0), f.x);
      const x01 = c(0, 0, 1).mix(c(1, 0, 1), f.x);
      const x11 = c(0, 1, 1).mix(c(1, 1, 1), f.x);
      return x00.mix(x10, f.y).mix(x01.mix(x11, f.y), f.z);
    };
    // nearest-voxel load: enough for the soft shadow march
    const samplePoint = (tex, p) =>
      texture3DLoad(tex, ivec3(p.clamp(vec3(0.5), vec3(N - 0.5))), int(0));
    const world = (v) => vec3(v).add(0.5).div(N).mul(2).sub(1);

    const sdBox = (p, b) => {
      const d = p.abs().sub(b);
      return d.max(0).length().add(d.x.max(d.y.max(d.z)).min(0));
    };
    const hash13 = (p) => {
      const q = p.mul(0.1031).fract();
      const r = q.add(q.dot(q.zyx.add(31.32)));
      return r.x.add(r.y).mul(r.z).fract();
    };
    const noise3 = (p) => {
      const i = p.floor();
      const f = p.fract();
      const s = f.mul(f).mul(f.mul(-2).add(3));
      const c = (ox, oy, oz) => hash13(i.add(vec3(ox, oy, oz)));
      const nx0 = c(0, 0, 0).mix(c(1, 0, 0), s.x);
      const nx1 = c(0, 1, 0).mix(c(1, 1, 0), s.x);
      const nx2 = c(0, 0, 1).mix(c(1, 0, 1), s.x);
      const nx3 = c(0, 1, 1).mix(c(1, 1, 1), s.x);
      return nx0.mix(nx1, s.y).mix(nx2.mix(nx3, s.y), s.z);
    };

    const K = (fn) => fn().compute(N * N * N);

    // ---- kernels (fixed schedule) -----------------------------------------

    // 1. advect velocity: vel0 -> vel1
    this.kAdvectVel = K(Fn(() => {
      const v = voxel();
      const p = vec3(v).add(0.5);
      const vel = fetch(vel0, v).xyz;
      const mid = p.sub(vel.mul(u.dt.mul(0.5)));
      const q = p.sub(sample(vel0, mid).xyz.mul(u.dt));
      textureStore(vel1, v, vec4(sample(vel0, q).xyz.mul(u.dissV), 0));
    }));

    // 2. forces: vel1 (+foam0) -> vel0
    this.kForces = K(Fn(() => {
      const v = voxel();
      const wp = world(v);
      const vel = fetch(vel1, v).xyz.toVar();
      const foam = fetch(foam0, v).x;
      vel.y.addAssign(u.buoyancy.mul(foam.clamp(0, 2.5)).mul(u.dt));

      If(u.paddleOn.greaterThan(0.5), () => {
        const d = sdBox(u.paddleRot.mul(wp.sub(u.paddlePos)), u.paddleHalf);
        const w = float(1).sub(smoothstep(0.0, 0.18, d));
        const target = u.paddleVel.add(u.paddleAng.cross(wp.sub(u.paddlePos)).mul(N * 0.5));
        vel.addAssign(target.sub(vel).mul(w.mul(u.dt.mul(16).min(1))));
      });
      If(u.barrelOn.greaterThan(0.5), () => {
        const d = sdBox(u.barrelRot.mul(wp.sub(u.barrelPos)), u.barrelHalf);
        const w = float(1).sub(smoothstep(0.0, 0.15, d));
        const target = u.barrelVel.add(u.barrelAng.cross(wp.sub(u.barrelPos)).mul(N * 0.5));
        vel.addAssign(target.sub(vel).mul(w.mul(u.dt.mul(16).min(1))));
      });
      If(u.burstAmt.notEqual(0).or(u.burstUp.notEqual(0)), () => {
        const dp = wp.sub(u.burstPos);
        const w = dp.dot(dp).div(u.burstR.mul(u.burstR)).negate().exp();
        const dir = dp.div(dp.length().max(1e-4));
        vel.addAssign(dir.mul(u.burstAmt.mul(w)).add(vec3(0, 1, 0).mul(u.burstUp.mul(w))));
      });

      const m = vel.length();
      If(m.greaterThan(u.maxVel), () => {
        vel.mulAssign(u.maxVel.div(m));
      });
      textureStore(vel0, v, vec4(vel, 0));
    }));

    // 3. curl: vel0 -> curl
    this.kCurl = K(Fn(() => {
      const v = voxel();
      const xp = fetchOff(vel0, v, 1, 0, 0).xyz, xm = fetchOff(vel0, v, -1, 0, 0).xyz;
      const yp = fetchOff(vel0, v, 0, 1, 0).xyz, ym = fetchOff(vel0, v, 0, -1, 0).xyz;
      const zp = fetchOff(vel0, v, 0, 0, 1).xyz, zm = fetchOff(vel0, v, 0, 0, -1).xyz;
      const c = vec3(
        yp.z.sub(ym.z).sub(zp.y.sub(zm.y)),
        zp.x.sub(zm.x).sub(xp.z.sub(xm.z)),
        xp.y.sub(xm.y).sub(yp.x.sub(ym.x))).mul(0.5);
      textureStore(curl, v, vec4(c, c.length()));
    }));

    // 4. vorticity confinement: vel0 + curl -> vel1
    this.kConfine = K(Fn(() => {
      const v = voxel();
      const vel = fetch(vel0, v).xyz.toVar();
      const eta = vec3(
        fetchOff(curl, v, 1, 0, 0).w.sub(fetchOff(curl, v, -1, 0, 0).w),
        fetchOff(curl, v, 0, 1, 0).w.sub(fetchOff(curl, v, 0, -1, 0).w),
        fetchOff(curl, v, 0, 0, 1).w.sub(fetchOff(curl, v, 0, 0, -1).w)).mul(0.5);
      const m = eta.length();
      If(m.greaterThan(1e-5), () => {
        vel.addAssign(eta.div(m).cross(fetch(curl, v).xyz).mul(u.eps.mul(u.dt)));
      });
      const s = vel.length();
      If(s.greaterThan(u.maxVel), () => {
        vel.mulAssign(u.maxVel.div(s));
      });
      textureStore(vel1, v, vec4(vel, 0));
    }));

    // 5. divergence: vel1 -> div
    this.kDiv = K(Fn(() => {
      const v = voxel();
      const d = fetchOff(vel1, v, 1, 0, 0).x.sub(fetchOff(vel1, v, -1, 0, 0).x)
        .add(fetchOff(vel1, v, 0, 1, 0).y.sub(fetchOff(vel1, v, 0, -1, 0).y))
        .add(fetchOff(vel1, v, 0, 0, 1).z.sub(fetchOff(vel1, v, 0, 0, -1).z))
        .mul(0.5);
      textureStore(div, v, vec4(d, 0, 0, 0));
    }));

    // 6. Jacobi pressure pair: prs0 <-> prs1
    const makeJacobi = (src, dst) => K(Fn(() => {
      const v = voxel();
      const s = fetchOff(src, v, 1, 0, 0).x.add(fetchOff(src, v, -1, 0, 0).x)
        .add(fetchOff(src, v, 0, 1, 0).x).add(fetchOff(src, v, 0, -1, 0).x)
        .add(fetchOff(src, v, 0, 0, 1).x).add(fetchOff(src, v, 0, 0, -1).x);
      textureStore(dst, v, vec4(s.sub(fetch(div, v).x).div(6), 0, 0, 0));
    }));
    this.kJacobiA = makeJacobi(prs0, prs1);
    this.kJacobiB = makeJacobi(prs1, prs0);

    // 7. project: vel1 + prs0 -> vel0, with one-sided wall clamps
    this.kProject = K(Fn(() => {
      const v = voxel();
      const vel = fetch(vel1, v).xyz.toVar();
      vel.subAssign(vec3(
        fetchOff(prs0, v, 1, 0, 0).x.sub(fetchOff(prs0, v, -1, 0, 0).x),
        fetchOff(prs0, v, 0, 1, 0).x.sub(fetchOff(prs0, v, 0, -1, 0).x),
        fetchOff(prs0, v, 0, 0, 1).x.sub(fetchOff(prs0, v, 0, 0, -1).x)).mul(0.5));
      const n = uint(N - 1);
      If(v.x.equal(uint(0)), () => { vel.x.assign(vel.x.max(0)); });
      If(v.x.equal(n), () => { vel.x.assign(vel.x.min(0)); });
      If(v.y.equal(uint(0)), () => { vel.y.assign(vel.y.max(0)); });
      If(v.y.equal(n), () => { vel.y.assign(vel.y.min(0)); });
      If(v.z.equal(uint(0)), () => { vel.z.assign(vel.z.max(0)); });
      If(v.z.equal(n), () => { vel.z.assign(vel.z.min(0)); });
      textureStore(vel0, v, vec4(vel, 0));
    }));

    // 8. MacCormack forward: foam0 (+vel0) -> tmp1 (value, min, max)
    this.kMMForward = K(Fn(() => {
      const v = voxel();
      const p = vec3(v).add(0.5);
      const vel = fetch(vel0, v).xyz;
      const mid = p.sub(vel.mul(u.dt.mul(0.5)));
      const q = p.sub(sample(vel0, mid).xyz.mul(u.dt));
      const val = sample(foam0, q).x;
      const q0 = ivec3(q.clamp(vec3(0.5), vec3(N - 0.5)).sub(0.5).floor());
      const mn = float(1e9).toVar();
      const mx = float(-1e9).toVar();
      for (let i = 0; i < 8; i++) {
        const s = texture3DLoad(foam0,
          q0.add(ivec3(i & 1, (i >> 1) & 1, (i >> 2) & 1)).clamp(ivec3(0), ivec3(N - 1)), int(0)).x;
        mn.assign(mn.min(s));
        mx.assign(mx.max(s));
      }
      textureStore(tmp1, v, vec4(val, mn, mx, 0));
    }));

    // 9. MacCormack reverse: tmp1 (+vel0, -dt) -> tmp2
    this.kMMReverse = K(Fn(() => {
      const v = voxel();
      const p = vec3(v).add(0.5);
      const vel = fetch(vel0, v).xyz;
      const mid = p.add(vel.mul(u.dt.mul(0.5)));
      const q = p.add(sample(vel0, mid).xyz.mul(u.dt));
      textureStore(tmp2, v, vec4(sample(tmp1, q).x, 0, 0, 0));
    }));

    // 10. MacCormack combine: foam0, tmp1, tmp2 -> foam1
    this.kMMCombine = K(Fn(() => {
      const v = voxel();
      const f1 = fetch(tmp1, v);
      const val = f1.x.add(fetch(foam0, v).x.sub(fetch(tmp2, v).x).mul(0.5))
        .clamp(f1.y, f1.z);
      textureStore(foam1, v, vec4(val.max(0).mul(u.dissF), 0, 0, 0));
    }));

    // 11. inject foam: foam1 -> foam0
    this.kInject = K(Fn(() => {
      const v = voxel();
      const wp = world(v);
      const foam = fetch(foam1, v).x.toVar();

      If(u.paddleOn.greaterThan(0.5), () => {
        const rel = wp.sub(u.paddlePos);
        const speed = u.paddleVelW.add(u.paddleAng.cross(rel)).length().min(3);
        If(speed.greaterThan(0.02), () => {
          const d = sdBox(u.paddleRot.mul(rel), u.paddleHalf);
          const w = float(1).sub(smoothstep(0.0, 0.14, d));
          const churn = noise3(wp.mul(14).add(vec3(0, u.time.mul(2.1), u.time.mul(1.3))))
            .mul(1.2).add(0.45);
          foam.addAssign(w.mul(u.foamGain).mul(speed).mul(churn).mul(u.dt));
        });
      });
      If(u.barrelOn.greaterThan(0.5), () => {
        const bs = u.barrelVelW.length();
        If(bs.greaterThan(0.05), () => {
          const dir = u.barrelVelW.div(bs);
          const ba = dir.mul(-0.4);
          const pa = wp.sub(u.barrelPos);
          const h = pa.dot(ba).div(ba.dot(ba)).clamp(0, 1);
          const dseg = pa.sub(ba.mul(h)).length().sub(0.055);
          const w = float(1).sub(smoothstep(0.0, 0.10, dseg)).mul(float(1).sub(h.mul(0.55)));
          const churn = noise3(wp.mul(17).add(vec3(0, u.time.mul(2.7), u.time.mul(1.9))))
            .mul(1.3).add(0.4);
          foam.addAssign(w.mul(u.foamGain).mul(bs.min(3)).mul(churn).mul(1.4).mul(u.dt));
        });
      });
      If(u.burstFoam.greaterThan(0), () => {
        const dp = wp.sub(u.burstPos);
        const w = dp.dot(dp).div(u.burstR.mul(u.burstR)).negate().exp();
        foam.addAssign(w.mul(u.burstFoam).mul(noise3(wp.mul(12).add(u.time)).mul(0.8).add(0.6)));
      });
      textureStore(foam0, v, vec4(foam.min(4), 0, 0, 0));
    }));

    // 12. light transmittance: foam0 -> light
    this.kLight = K(Fn(() => {
      const v = voxel();
      const p = vec3(v).add(0.5);
      const dir = u.lightDir.negate();
      const od = float(0).toVar();
      const done = float(0).toVar();
      Loop({ start: int(1), end: int(25) }, ({ i }) => {
        const q = p.add(dir.mul(u.lightStep.mul(float(i))));
        If(q.lessThan(vec3(0)).any().or(q.greaterThan(vec3(N)).any()), () => {
          done.assign(1);
        });
        If(done.equal(0), () => {
          od.addAssign(samplePoint(foam0, q).x);
        });
      });
      const inv = vec3(1).div(dir);
      const t1 = vec3(0).sub(p).mul(inv);
      const t2 = vec3(N).sub(p).mul(inv);
      const tExit = t1.max(t2).x.min(t1.max(t2).y).min(t1.max(t2).z);
      const t = od.mul(u.sigmaFoam).mul(u.lightStep)
        .add(u.sigmaWater.mul(tExit.max(0))).negate().exp();
      textureStore(light, v, vec4(t, 0, 0, 0));
    }));

    // clear kernels
    const clearK = (tex, value) => K(Fn(() => {
      textureStore(tex, voxel(), vec4(value, value, value, value));
    }));
    this.clearKernels = [vel0, vel1, foam0, foam1, prs0, prs1, div, curl].map((t) => clearK(t, 0));
    this.clearKernels.push(clearK(light, 1));

    // one-shot inputs, same interface as the WebGL Fluid class
    this.burst = null;
    this.paddle = null;
    this.barrel = null;
  }

  step(dt, time) {
    const { u, renderer } = this;
    const voxPerWorld = this.N / 2;
    u.dt.value = dt;
    u.time.value = time;
    u.dissV.value = Math.pow(0.999, dt * 60);
    u.dissF.value = Math.pow(0.978, dt * 60);

    if (this.paddle && this.paddle.on) {
      u.paddleOn.value = 1;
      u.paddlePos.value.copy(this.paddle.pos);
      u.paddleVel.value.copy(this.paddle.vel).multiplyScalar(voxPerWorld);
      u.paddleVelW.value.copy(this.paddle.vel);
      u.paddleAng.value.copy(this.paddle.angVel);
      u.paddleHalf.value.copy(this.paddle.half);
      u.paddleRot.value.copy(this.paddle.rot);
    } else {
      u.paddleOn.value = 0;
    }
    if (this.barrel && this.barrel.on) {
      u.barrelOn.value = 1;
      u.barrelPos.value.copy(this.barrel.pos);
      u.barrelVel.value.copy(this.barrel.vel).multiplyScalar(voxPerWorld);
      u.barrelVelW.value.copy(this.barrel.vel);
      u.barrelAng.value.copy(this.barrel.angVel);
      u.barrelHalf.value.copy(this.barrel.half);
      u.barrelRot.value.copy(this.barrel.rot);
    } else {
      u.barrelOn.value = 0;
    }
    if (this.burst) {
      u.burstPos.value.copy(this.burst.pos);
      u.burstAmt.value = (this.burst.vel ?? 0) * voxPerWorld;
      u.burstUp.value = (this.burst.up ?? 0) * voxPerWorld;
      u.burstFoam.value = this.burst.foam ?? 0;
      u.burstR.value = this.burst.radius ?? 0.18;
      this.burst = null;
    } else {
      u.burstAmt.value = 0;
      u.burstUp.value = 0;
      u.burstFoam.value = 0;
    }

    const seq = [this.kAdvectVel, this.kForces, this.kCurl, this.kConfine, this.kDiv];
    for (let i = 0; i < this.jacobi; i += 2) seq.push(this.kJacobiA, this.kJacobiB);
    seq.push(this.kProject, this.kMMForward, this.kMMReverse, this.kMMCombine,
      this.kInject, this.kLight);
    // this.limit (debug): dispatch only the first n kernels of the schedule
    const n = this.limit ?? seq.length;
    for (let i = 0; i < n && i < seq.length; i++) renderer.compute(seq[i]);
  }

  clear() {
    for (const k of this.clearKernels) this.renderer.compute(k);
  }

  get foamTexture() { return this.foam0; }
  get lightTexture() { return this.light; }
}
