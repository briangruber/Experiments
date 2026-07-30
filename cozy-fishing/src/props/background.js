// Everything past the water: treeline ridges, the village silhouette with
// lit windows, the lighthouse island, drifting clouds, circling gulls.
// Composition only — none of it is reachable, all of it is mood.

import * as THREE from 'three';
import { PALETTE } from '../config.js';
import { mulberry32 } from '../core/utils.js';
import { definePlaceholder } from './registry.js';
import { matte, glow, box, cyl, cone, sph, prism } from './parts.js';

const S = PALETTE.silhouette;

// Flattened dome of land/hill. Returns mesh + a surfaceY sampler.
function ridge(cx, cy, cz, sx, sy, sz, color) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 7), matte(color));
  m.scale.set(sx, sy, sz);
  m.position.set(cx, cy, cz);
  const surfaceY = (x, z) => {
    const dx = (x - cx) / sx, dz = (z - cz) / sz;
    const r2 = dx * dx + dz * dz;
    return r2 >= 1 ? -Infinity : cy + sy * Math.sqrt(1 - r2);
  };
  return { m, surfaceY };
}

definePlaceholder('background', () => {
  const g = new THREE.Group();
  const rnd = mulberry32(7);
  const rr = (a, b) => a + rnd() * (b - a);

  // --- ridges -------------------------------------------------------------
  const farRidges = [
    ridge(-30, -2.5, -235, 130, 13, 28, S.far),
    ridge(85, -2, -220, 75, 9, 22, S.far),
  ];
  const nearRidges = [
    ridge(-48, -1.5, -145, 62, 8.5, 18, S.near),
    ridge(88, -1.2, -195, 62, 7, 16, S.near),
  ];
  for (const r of [...farRidges, ...nearRidges]) g.add(r.m);

  // --- treeline (instanced cones on the near ridges) ----------------------
  {
    const geo = new THREE.ConeGeometry(1, 2.4, 6);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.95, flatShading: true });
    const trees = new THREE.InstancedMesh(geo, mat, 150);
    const dummy = new THREE.Object3D();
    const cA = new THREE.Color(0x24403f), cB = new THREE.Color(0x3d5a54);
    let i = 0;
    while (i < 150) {
      const r = nearRidges[rnd() < 0.6 ? 0 : 1];
      const x = r.m.position.x + rr(-1, 1) * r.m.scale.x * 0.92;
      const z = r.m.position.z + rr(-0.5, 0.75) * r.m.scale.z;
      const y = r.surfaceY(x, z);
      if (y < 0.6) continue;
      const s = rr(1.4, 3.4);
      dummy.position.set(x, y + s * 0.9, z);
      dummy.scale.set(s * rr(0.75, 1.05), s, s * rr(0.75, 1.05));
      dummy.rotation.y = rr(0, Math.PI);
      dummy.updateMatrix();
      trees.setMatrixAt(i, dummy.matrix);
      trees.setColorAt(i, cA.clone().lerp(cB, rnd()));
      i++;
    }
    trees.instanceMatrix.needsUpdate = true;
    trees.instanceColor.needsUpdate = true;
    g.add(trees);
  }

  // --- village silhouette on its spit, windows aglow ----------------------
  const windows = [];
  {
    const village = new THREE.Group();
    village.position.set(-34, 0, -108);
    const land = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 7), matte(S.land));
    land.scale.set(27, 2.4, 11);
    land.position.y = -0.4;
    village.add(land);

    const houseMat = matte(S.village);
    const winMat = glow(PALETTE.glowWindow, 2.2);
    const house = (x, w, h, d, roofH) => {
      const y0 = 1.2;
      const b = box(w, h, d, houseMat);
      b.position.set(x, y0 + h / 2, 0);
      village.add(b);
      const r = prism(w + 0.5, roofH, d + 0.4, houseMat);
      r.rotation.y = Math.PI / 2;
      r.position.set(x, y0 + h, 0);
      village.add(r);
      if (rnd() < 0.75) {
        const win = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 0.7), winMat);
        win.position.set(x + rr(-w / 4, w / 4), y0 + h * rr(0.4, 0.7), d / 2 + 0.02);
        village.add(win);
        windows.push({ x: village.position.x + win.position.x, z: village.position.z });
      }
    };
    house(-16, 4, 3.2, 4, 2.2);
    house(-10.5, 3.4, 4.2, 3.6, 2.6);
    house(-5.5, 4.4, 2.8, 4, 2);
    house(0.5, 3.6, 3.6, 3.8, 2.4);
    house(6, 4.8, 3, 4.2, 2.1);
    house(11.5, 3.2, 4.6, 3.4, 2.8);
    house(16.5, 3.8, 2.6, 3.6, 1.9);

    // A slim church tower breaks the roofline.
    const tower = box(2.2, 7.5, 2.2, houseMat);
    tower.position.set(-1.8, 4.9, -2.5);
    village.add(tower);
    const spire = cone(1.7, 3.4, 4, houseMat);
    spire.position.set(-1.8, 10.3, -2.5);
    spire.rotation.y = Math.PI / 4;
    village.add(spire);

    // Two little masts by the shore.
    for (const [mx, mz] of [[20, 3.5], [22.5, 2.8]]) {
      const mast = cyl(0.08, 0.1, 4.5, 5, houseMat);
      mast.position.set(mx, 2.6, mz);
      village.add(mast);
    }
    g.add(village);
  }

  // --- lighthouse island --------------------------------------------------
  let beaconMat;
  {
    const lh = new THREE.Group();
    lh.position.set(35, 0, -128);
    lh.scale.setScalar(1.25);
    const island = new THREE.Mesh(new THREE.SphereGeometry(1, 9, 6), matte(0x3a4152));
    island.scale.set(9.5, 2.6, 7);
    island.position.y = -0.5;
    lh.add(island);

    const tower = cyl(1.0, 1.5, 7.5, 10, matte(0xd8cfc4));
    tower.position.y = 5.2;
    lh.add(tower);
    for (const [y, r] of [[3.6, 1.36], [6.2, 1.14]]) {
      const band = cyl(r, r + 0.06, 1.1, 10, matte(0xb05548));
      band.position.y = y;
      lh.add(band);
    }
    const gallery = cyl(1.35, 1.35, 0.35, 10, matte(0x3a3550));
    gallery.position.y = 9.1;
    lh.add(gallery);
    beaconMat = new THREE.MeshStandardMaterial({
      color: 0xffd98c, emissive: 0xffd98c, emissiveIntensity: 2, roughness: 0.5,
    });
    const lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.8, 1.1, 8), beaconMat);
    lamp.position.y = 9.8;
    lh.add(lamp);
    const cap = cone(1.1, 1.1, 8, matte(0x3a3550));
    cap.position.y = 10.9;
    lh.add(cap);

    for (const [tx, tz, s] of [[-5, 2.5, 2.2], [4.5, -3, 1.8], [6.5, 2, 1.5]]) {
      const tr = cone(s * 0.55, s * 1.6, 6, matte(S.near));
      tr.position.set(tx, island.position.y + 1.8, tz);
      lh.add(tr);
    }
    g.add(lh);
  }

  // --- clouds -------------------------------------------------------------
  const clouds = [];
  {
    const mat = new THREE.MeshStandardMaterial({
      color: 0xf2d4c2, emissive: 0xff9e6a, emissiveIntensity: 0.28,
      roughness: 1, flatShading: true,
    });
    const spots = [[-110, 34, -235, 13], [-38, 24, -245, 9], [28, 38, -255, 15], [90, 27, -230, 10], [150, 33, -240, 8]];
    for (const [x, y, z, s] of spots) {
      const c = new THREE.Group();
      const n = 4 + ((rnd() * 3) | 0);
      for (let i = 0; i < n; i++) {
        const puff = new THREE.Mesh(new THREE.SphereGeometry(1, 7, 5), mat);
        puff.position.set(rr(-1.2, 1.2) * (i + 0.5), rr(-0.15, 0.3), rr(-0.4, 0.4));
        puff.scale.setScalar(rr(0.55, 1.1));
        c.add(puff);
      }
      c.scale.set(s, s * 0.38, s * 0.8);
      c.position.set(x, y, z);
      g.add(c);
      clouds.push({ c, speed: rr(0.25, 0.55) });
    }
  }

  // --- gulls --------------------------------------------------------------
  const gulls = [];
  {
    const mat = matte(0x4a4145, { side: THREE.DoubleSide });
    const paths = [
      { cx: 10, cy: 10.5, cz: -50, r: 16, sp: 0.14, dir: 1 },
      { cx: -16, cy: 13.5, cz: -72, r: 20, sp: 0.1, dir: -1 },
      { cx: 26, cy: 9, cz: -62, r: 12, sp: 0.18, dir: 1 },
    ];
    for (const p of paths) {
      const bird = new THREE.Group();
      const bod = sph(0.16, mat, 6, 4, false);
      bod.scale.set(2.1, 0.7, 0.8);
      bird.add(bod);
      const wingGeo = new THREE.PlaneGeometry(0.95, 0.28).translate(0.48, 0, 0);
      const wl = new THREE.Mesh(wingGeo, mat);
      const wr = new THREE.Mesh(wingGeo, mat);
      wr.rotation.y = Math.PI;
      wl.rotation.x = wr.rotation.x = -Math.PI / 2;
      bird.add(wl, wr);
      g.add(bird);
      gulls.push({ bird, wl, wr, ...p, a: rnd() * Math.PI * 2, flap: rnd() * 9 });
    }
  }

  // Light streaks for the lighthouse beacon and two village windows.
  g.userData.glowAnchors = [
    { x: 35, z: -126, color: 0xffd98c, w: 0.8, len: 10 },
    ...windows.slice(0, 2).map((w) => ({ x: w.x, z: w.z, color: PALETTE.glowWindow, w: 0.45, len: 6 })),
  ];

  g.userData.api = {
    update(dt, t) {
      beaconMat.emissiveIntensity = 1.2 + 1.6 * Math.pow(0.5 + 0.5 * Math.sin(t * 1.3), 3);
      for (const cl of clouds) {
        cl.c.position.x += cl.speed * dt;
        if (cl.c.position.x > 220) cl.c.position.x = -220;
      }
      for (const gu of gulls) {
        gu.a += gu.sp * gu.dir * dt;
        gu.bird.position.set(
          gu.cx + Math.cos(gu.a) * gu.r,
          gu.cy + Math.sin(t * 0.5 + gu.flap) * 0.8,
          gu.cz + Math.sin(gu.a) * gu.r * 0.7
        );
        gu.bird.rotation.y = -gu.a * gu.dir + (gu.dir > 0 ? Math.PI / 2 : -Math.PI / 2);
        const f = Math.sin(t * 7 + gu.flap) * 0.45;
        gu.wl.rotation.z = f;
        gu.wr.rotation.z = f;
      }
    },
  };
  return g;
});
