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
  Fn, If, Loop, Break, uniform, uniformArray, instanceIndex, textureStore,
  texture3DLoad, float, int, uint, vec2, vec3, vec4, ivec3, uvec3, smoothstep,
} = THREE.TSL;

const MAX_BARRELS = 6;

export class Fluid3D {
  constructor(renderer, { N = 128, jacobi = 26, lightDir, surfaceY = 0.72, tank = 1 }) {
    this.renderer = renderer;
    this.surfaceY = surfaceY;
    // tank half-extent inside the grid; outside it is solid wall
    this.tank = tank;
    // same knobs, same units as the WebGL solver
    this.physics = {
      rise: 0.55, buoyancy: 0.48, foamLife: 5.0, swirl: 0.09, aeration: 1.8,
      caustics: 1.0, chop: 1.0, drag: 0.06, blast: 1.0, ring: 1.0,
    };
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
    this.prs0 = prs0;
    this.divTex = div;
    this.vel1 = vel1;
    this.curlTex = curl;
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
      // the paddle's world->local rotation, as three row vectors rather than a
      // mat3 uniform. Equivalent, and it keeps the uniform block to vec3s.
      paddleRotX: uniform(new THREE.Vector3(1, 0, 0)),
      paddleRotY: uniform(new THREE.Vector3(0, 1, 0)),
      paddleRotZ: uniform(new THREE.Vector3(0, 0, 1)),
      barrelCount: uniform(0),
      burstPos: uniform(new THREE.Vector3()),
      burstAmt: uniform(0),
      burstUp: uniform(0),
      burstFoam: uniform(0),
      burstR: uniform(0.18),
      burstRing: uniform(0),
      burstRingR: uniform(0.3),
      surfaceY: uniform(surfaceY),
      tank: uniform(tank),
      rise: uniform(0),
      lightDir: uniform(lightDir.clone()),
      sigmaFoam: uniform(22 / N),
      sigmaWater: uniform(0.9 / N),
      lightStep: uniform(N / 22),
      caustics: uniform(1),
    };
    // barrels as spheres: xyz = world position, w = radius / world velocity
    this.barrelPosArr = Array.from({ length: MAX_BARRELS }, () => new THREE.Vector4());
    this.barrelVelArr = Array.from({ length: MAX_BARRELS }, () => new THREE.Vector4());
    const uBarrels = uniformArray(this.barrelPosArr);
    const uBarrelVels = uniformArray(this.barrelVelArr);
    this.barrels = [];

    // ---- helpers -----------------------------------------------------------

    const voxel = () => {
      const id = instanceIndex;
      const x = id.mod(uint(N));
      const y = id.div(uint(N)).mod(uint(N));
      const z = id.div(uint(N * N));
      return uvec3(x, y, z);
    };
    // lerp written out rather than a.mix(b, t): in this three.js build the
    // method form binds the receiver as mix()'s THIRD argument, so a.mix(b, t)
    // compiles to mix(b, t, a) — the sampled texel ends up as the interpolation
    // weight. That silently turned every trilinear fetch into a wild
    // extrapolation and blew the velocity field up to float16 infinity.
    const lerp = (a, b, t) => a.add(b.sub(a).mul(t));

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
      const x00 = lerp(c(0, 0, 0), c(1, 0, 0), f.x);
      const x10 = lerp(c(0, 1, 0), c(1, 1, 0), f.x);
      const x01 = lerp(c(0, 0, 1), c(1, 0, 1), f.x);
      const x11 = lerp(c(0, 1, 1), c(1, 1, 1), f.x);
      return lerp(lerp(x00, x10, f.y), lerp(x01, x11, f.y), f.z);
    };
    // nearest-voxel load: enough for the soft shadow march
    const samplePoint = (tex, p) =>
      texture3DLoad(tex, ivec3(p.clamp(vec3(0.5), vec3(N - 0.5))), int(0));
    const world = (v) => vec3(v).add(0.5).div(N).mul(2).sub(1);

    // world -> paddle local, done as three dot products
    const toPaddleLocal = (rel) => vec3(
      u.paddleRotX.dot(rel), u.paddleRotY.dot(rel), u.paddleRotZ.dot(rel));

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
      const nx0 = lerp(c(0, 0, 0), c(1, 0, 0), s.x);
      const nx1 = lerp(c(0, 1, 0), c(1, 1, 0), s.x);
      const nx2 = lerp(c(0, 0, 1), c(1, 0, 1), s.x);
      const nx3 = lerp(c(0, 1, 1), c(1, 1, 1), s.x);
      return lerp(lerp(nx0, nx1, s.y), lerp(nx2, nx3, s.y), s.z);
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
      // buoyancy fades near the waterline, so plumes spread instead of piling up
      const lift = float(1).sub(smoothstep(u.surfaceY.sub(0.07), u.surfaceY, wp.y));
      vel.y.addAssign(u.buoyancy.mul(foam.clamp(0, 2.5)).mul(lift).mul(u.dt));

      If(u.paddleOn.greaterThan(0.5), () => {
        const d = sdBox(toPaddleLocal(wp.sub(u.paddlePos)), u.paddleHalf);
        const w = float(1).sub(smoothstep(0.0, 0.18, d));
        const target = u.paddleVel.add(u.paddleAng.cross(wp.sub(u.paddlePos)).mul(N * 0.5));
        vel.addAssign(target.sub(vel).mul(w.mul(u.dt.mul(16).min(1))));
      });
      Loop({ start: int(0), end: int(MAX_BARRELS) }, ({ i }) => {
        If(int(i).greaterThanEqual(u.barrelCount), () => { Break(); });
        const b = uBarrels.element(i);
        const d = wp.sub(b.xyz).length().sub(b.w);
        const w = float(1).sub(smoothstep(0.0, 0.12, d));
        const target = uBarrelVels.element(i).xyz.mul(N * 0.5);
        vel.addAssign(target.sub(vel).mul(w.mul(u.dt.mul(16).min(1))));
      });
      If(u.burstAmt.notEqual(0).or(u.burstUp.notEqual(0)), () => {
        const dp = wp.sub(u.burstPos);
        const w = dp.dot(dp).div(u.burstR.mul(u.burstR)).negate().exp();
        const dir = dp.div(dp.length().max(1e-4));
        vel.addAssign(dir.mul(u.burstAmt.mul(w)).add(vec3(0, 1, 0).mul(u.burstUp.mul(w))));
      });

      // Vortex ring: a rising blob only mushrooms if its cap rolls outward and
      // under, and that circulation is something a purely radial impulse never
      // creates. The blast seeds a torus of poloidal rotation.
      If(u.burstRing.greaterThan(0), () => {
        const dp = wp.sub(u.burstPos);
        const rxz = vec2(dp.x, dp.z).length();
        const er = vec3(dp.x, 0, dp.z).div(rxz.max(1e-4));
        const s = dp.sub(er.mul(u.burstRingR));
        const ls = s.length().max(1e-4);
        const core = u.burstRingR.mul(0.9);
        const w = ls.mul(ls).div(core.mul(core)).negate().exp();
        const omega = vec3(0, 1, 0).cross(er).mul(u.burstRing);
        vel.addAssign(omega.cross(s.div(ls)).mul(w));
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
      // free surface: air above the waterline is still, and water cannot flow
      // up through it — the lid is what makes plumes mushroom outward
      const wy = float(v.y).add(0.5).div(N).mul(2).sub(1);
      If(wy.add(2 / N).greaterThan(u.surfaceY), () => { vel.y.assign(vel.y.min(0)); });
      If(wy.greaterThan(u.surfaceY), () => { vel.assign(vec3(0)); });

      // tank walls: the grid stays cubic and uniformly spaced, the tank is a box
      // inside it, so resizing never disturbs the finite differences
      const wp = world(v);
      const h = u.tank;
      const cell = float(2 / N);
      If(wp.abs().greaterThan(vec3(h)).any(), () => { vel.assign(vec3(0)); });
      If(wp.x.sub(cell).lessThan(h.negate()), () => { vel.x.assign(vel.x.max(0)); });
      If(wp.x.add(cell).greaterThan(h), () => { vel.x.assign(vel.x.min(0)); });
      If(wp.y.sub(cell).lessThan(h.negate()), () => { vel.y.assign(vel.y.max(0)); });
      If(wp.z.sub(cell).lessThan(h.negate()), () => { vel.z.assign(vel.z.max(0)); });
      If(wp.z.add(cell).greaterThan(h), () => { vel.z.assign(vel.z.min(0)); });
      textureStore(vel0, v, vec4(vel, 0));
    }));

    // 8. MacCormack forward: foam0 (+vel0) -> tmp1 (value, min, max)
    this.kMMForward = K(Fn(() => {
      const v = voxel();
      const p = vec3(v).add(0.5);
      const rise = vec3(0, u.rise, 0);
      const vel = fetch(vel0, v).xyz.add(rise);
      const mid = p.sub(vel.mul(u.dt.mul(0.5)));
      const q = p.sub(sample(vel0, mid).xyz.add(rise).mul(u.dt));
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
      const rise = vec3(0, u.rise, 0);
      const vel = fetch(vel0, v).xyz.add(rise);
      const mid = p.add(vel.mul(u.dt.mul(0.5)));
      const q = p.add(sample(vel0, mid).xyz.add(rise).mul(u.dt));
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
          const d = sdBox(toPaddleLocal(rel), u.paddleHalf);
          const w = float(1).sub(smoothstep(0.0, 0.14, d));
          const churn = noise3(wp.mul(14).add(vec3(0, u.time.mul(2.1), u.time.mul(1.3))))
            .mul(1.2).add(0.45);
          foam.addAssign(w.mul(u.foamGain).mul(speed).mul(churn).mul(u.dt));
        });
      });
      Loop({ start: int(0), end: int(MAX_BARRELS) }, ({ i }) => {
        If(int(i).greaterThanEqual(u.barrelCount), () => { Break(); });
        const bvel = uBarrelVels.element(i).xyz;
        const bs = bvel.length();
        If(bs.greaterThan(0.05), () => {
          const dir = bvel.div(bs);
          const ba = dir.mul(-0.4);
          const pa = wp.sub(uBarrels.element(i).xyz);
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
      // bubbles that reach the waterline pop; what survives rafts underneath
      foam.mulAssign(float(1).sub(smoothstep(u.surfaceY.sub(0.008), u.surfaceY.add(0.05), wp.y)));
      If(wp.abs().greaterThan(vec3(u.tank)).any(), () => { foam.assign(float(0)); });
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
      const tr = od.mul(u.sigmaFoam).mul(u.lightStep)
        .add(u.sigmaWater.mul(tExit.max(0))).negate().exp().toVar();

      // caustics, walked back up the light path to the surface so the pattern
      // reads as descending shafts (see the WebGL shader for the derivation)
      const wp = world(v);
      const below = u.surfaceY.sub(wp.y).max(0);
      const cp = vec2(wp.x, wp.z).sub(vec2(u.lightDir.x, u.lightDir.z)
        .mul(below.div(u.lightDir.y.negate().max(1e-3)))).mul(4.5);
      const ct = u.time.mul(0.35);
      const q = cp.add(0.137);
      const ii = q.toVar();
      const cc = float(0).toVar();
      Loop({ start: int(0), end: int(3) }, ({ i }) => {
        const tn = ct.mul(float(1).sub(float(3).div(float(i).add(1))));
        ii.assign(q.add(vec2(
          tn.sub(ii.x).cos().add(tn.add(ii.y).sin()),
          tn.sub(ii.y).sin().add(tn.add(ii.x).cos()))));
        const d = vec2(ii.x.add(tn).sin(), ii.y.add(tn).cos());
        const ds = vec2(d.x.sign(), d.y.sign()).mul(vec2(d.x.abs().max(1e-3), d.y.abs().max(1e-3)))
          .div(0.006);
        cc.addAssign(float(1).div(q.div(ds).length().max(1e-4)));
      });
      // median-normalised exactly as in the WebGL shader: averages ~1 with
      // ~10% bright filaments, so the knob redistributes rather than exposes
      const cv = cc.div(77).pow(1.15).clamp(0, 3).div(1.25);
      tr.mulAssign(lerp(float(1), cv, u.caustics.mul(below.mul(0.9).negate().exp())));
      textureStore(light, v, vec4(tr.max(0).min(8), 0, 0, 0));
    }));

    // clear kernels
    const clearK = (tex, value) => K(Fn(() => {
      textureStore(tex, voxel(), vec4(value, value, value, value));
    }));
    this.clearKernels = [vel0, vel1, foam0, foam1, prs0, prs1, div, curl].map((t) => clearK(t, 0));
    this.clearKernels.push(clearK(light, 1));
    // velocity and pressure only — see still() below
    this.stillKernels = [vel0, vel1, prs0, prs1, div, curl].map((t) => clearK(t, 0));

    // one-shot inputs, same interface as the WebGL Fluid class
    this.burst = null;
    this.paddle = null;
    // this.barrels: [{ pos, vel (world/s), radius }] — as many as are in flight
  }

  step(dt, time) {
    const { u, renderer } = this;
    const voxPerWorld = this.N / 2;
    const ph = this.physics;
    u.dt.value = dt;
    u.time.value = time;
    u.dissV.value = Math.exp(-dt * ph.drag);
    u.dissF.value = Math.exp(-dt / Math.max(ph.foamLife, 0.05));
    u.rise.value = ph.rise * voxPerWorld;
    u.buoyancy.value = ph.buoyancy * voxPerWorld;
    u.eps.value = ph.swirl * this.N;
    u.foamGain.value = ph.aeration;
    u.caustics.value = ph.caustics;
    u.tank.value = this.tank;
    u.surfaceY.value = this.surfaceY;

    if (this.paddle && this.paddle.on) {
      u.paddleOn.value = 1;
      u.paddlePos.value.copy(this.paddle.pos);
      u.paddleVel.value.copy(this.paddle.vel).multiplyScalar(voxPerWorld);
      u.paddleVelW.value.copy(this.paddle.vel);
      u.paddleAng.value.copy(this.paddle.angVel);
      u.paddleHalf.value.copy(this.paddle.half);
      const e = this.paddle.rot.elements;
      u.paddleRotX.value.set(e[0], e[3], e[6]);
      u.paddleRotY.value.set(e[1], e[4], e[7]);
      u.paddleRotZ.value.set(e[2], e[5], e[8]);
    } else {
      u.paddleOn.value = 0;
    }
    const bs = this.barrels;
    const nb = Math.min(bs.length, 6);
    u.barrelCount.value = nb;
    for (let i = 0; i < nb; i++) {
      this.barrelPosArr[i].set(bs[i].pos.x, bs[i].pos.y, bs[i].pos.z, bs[i].radius);
      this.barrelVelArr[i].set(bs[i].vel.x, bs[i].vel.y, bs[i].vel.z, 0);
    }
    if (this.burst) {
      u.burstPos.value.copy(this.burst.pos);
      u.burstAmt.value = (this.burst.vel ?? 0) * voxPerWorld;
      u.burstUp.value = (this.burst.up ?? 0) * voxPerWorld;
      u.burstFoam.value = this.burst.foam ?? 0;
      u.burstR.value = this.burst.radius ?? 0.18;
      u.burstRing.value = (this.burst.ring ?? 0) * voxPerWorld;
      u.burstRingR.value = this.burst.ringR ?? 0.3;
      this.burst = null;
    } else {
      u.burstAmt.value = 0;
      u.burstUp.value = 0;
      u.burstFoam.value = 0;
      u.burstRing.value = 0;
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

  // Stop the water without emptying the tank: foam is buoyant, so it is what
  // keeps a tank moving after the paddle has gone. Killing the velocity alone
  // lets the bubbles settle instead of driving a fresh plume.
  still() {
    for (const k of this.stillKernels) this.renderer.compute(k);
  }

  get foamTexture() { return this.foam0; }
  get lightTexture() { return this.light; }
}
