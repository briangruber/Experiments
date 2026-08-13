import * as THREE from 'three';
import { rand } from './util.js';
import { DOOR, YARD, WALL_Z } from './zones.js';

// Builds the coop interior: plank walls, straw floor, roosts, nesting boxes,
// feeder, window with a sun shaft, hanging bulb. Returns the points of
// interest the behaviors need.

const wood = (color, rough = 0.9) =>
  new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: rough });

function plankRow(group, rng, { axis, length, y, h, thickness, fixed, base, gapChance = 0 }) {
  // One horizontal plank at height y, hue-jittered so walls read as boards.
  const c = new THREE.Color(base);
  c.offsetHSL(rand(rng, -0.015, 0.015), rand(rng, -0.05, 0.05), rand(rng, -0.05, 0.05));
  const geo = new THREE.BoxGeometry(
    axis === 'x' ? length : thickness, h * 0.94,
    axis === 'x' ? thickness : length);
  const m = new THREE.Mesh(geo, wood(c));
  m.position.y = y;
  if (axis === 'x') { m.position.z = fixed; } else { m.position.x = fixed; }
  m.receiveShadow = true;
  group.add(m);
  return m;
}

export function buildCoop(scene, rng) {
  const g = new THREE.Group();
  const W = 5, H = 4;             // half-width and wall height
  const WALL = 0.12;
  const baseWall = 0x7a5c3d;

  // ---- floor: boards + dirt tone underneath ------------------------------
  const floorBase = new THREE.Mesh(
    new THREE.BoxGeometry(W * 2, 0.1, W * 2),
    wood(0x5c4530));
  floorBase.position.y = -0.05;
  floorBase.receiveShadow = true;
  g.add(floorBase);

  for (let i = 0; i < 10; i++) {
    const c = new THREE.Color(0x6b5138);
    c.offsetHSL(rand(rng, -0.01, 0.01), rand(rng, -0.04, 0.04), rand(rng, -0.045, 0.045));
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.98, 0.04, W * 2), wood(c));
    b.position.set(-W + 0.5 + i, 0.0, 0);
    b.receiveShadow = true;
    g.add(b);
  }

  // ---- walls (window cut into the +X wall) -------------------------------
  const rows = 8, rowH = H / rows;
  const win = { y0: 2.0, y1: 3.1, z0: -2.4, z1: -0.8 };  // on +X wall
  const doorX0 = DOOR.x - DOOR.halfWidth, doorX1 = DOOR.x + DOOR.halfWidth;
  for (let i = 0; i < rows; i++) {
    const y = rowH * (i + 0.5);
    plankRow(g, rng, { axis: 'x', length: W * 2, y, h: rowH, thickness: WALL, fixed: -W, base: baseWall }); // -Z
    // +Z wall: split around the pop-hole for every row below the lintel.
    if (y - rowH / 2 >= DOOR.top - 0.01) {
      plankRow(g, rng, { axis: 'x', length: W * 2, y, h: rowH, thickness: WALL, fixed: W, base: baseWall });
    } else {
      const segA = doorX0 + W;      // -W .. door
      const segB = W - doorX1;      // door .. +W
      const a = plankRow(g, rng, { axis: 'x', length: segA, y, h: rowH, thickness: WALL, fixed: W, base: baseWall });
      a.position.x = -W + segA / 2;
      const b = plankRow(g, rng, { axis: 'x', length: segB, y, h: rowH, thickness: WALL, fixed: W, base: baseWall });
      b.position.x = doorX1 + segB / 2;
    }
    plankRow(g, rng, { axis: 'z', length: W * 2, y, h: rowH, thickness: WALL, fixed: -W, base: baseWall }); // -X
    if (y - rowH / 2 >= win.y1 - 0.01 || y + rowH / 2 <= win.y0 + 0.01) {
      plankRow(g, rng, { axis: 'z', length: W * 2, y, h: rowH, thickness: WALL, fixed: W, base: baseWall }); // +X full
    } else {
      // split the row around the window opening
      const segA = (win.z0 + W);        // from -W to z0
      const segB = (W - win.z1);        // from z1 to +W
      const a = plankRow(g, rng, { axis: 'z', length: segA, y, h: rowH, thickness: WALL, fixed: W, base: baseWall });
      a.position.z = -W + segA / 2;
      const b = plankRow(g, rng, { axis: 'z', length: segB, y, h: rowH, thickness: WALL, fixed: W, base: baseWall });
      b.position.z = win.z1 + segB / 2;
    }
  }

  // ---- ceiling + rafters --------------------------------------------------
  const ceil = new THREE.Mesh(new THREE.BoxGeometry(W * 2, 0.1, W * 2), wood(0x4a3826));
  ceil.position.y = H + 0.05;
  g.add(ceil);
  for (const z of [-2.6, 0, 2.6]) {
    const beam = new THREE.Mesh(new THREE.BoxGeometry(W * 2, 0.22, 0.16), wood(0x54402c));
    beam.position.set(0, H - 0.11, z);
    beam.castShadow = true;
    g.add(beam);
  }

  // ---- window: frame + bright sky ----------------------------------------
  const winW = win.z1 - win.z0, winH = win.y1 - win.y0;
  const winSkyMat = new THREE.MeshBasicMaterial({ color: 0xcfe6f5 });
  const sky = new THREE.Mesh(new THREE.PlaneGeometry(winW, winH), winSkyMat);
  sky.position.set(W + WALL / 2 + 0.01, (win.y0 + win.y1) / 2, (win.z0 + win.z1) / 2);
  sky.rotation.y = -Math.PI / 2;
  g.add(sky);
  const frameMat = wood(0x8f6c46);
  for (const [len, y, z, vert] of [
    [winW + 0.2, win.y0, (win.z0 + win.z1) / 2, false],
    [winW + 0.2, win.y1, (win.z0 + win.z1) / 2, false],
    [winH + 0.2, (win.y0 + win.y1) / 2, win.z0, true],
    [winH + 0.2, (win.y0 + win.y1) / 2, win.z1, true],
  ]) {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.1, vert ? len : 0.1, vert ? 0.1 : len), frameMat);
    bar.position.set(W - 0.04, y, z);
    g.add(bar);
  }

  // ---- sun shaft through the window --------------------------------------
  const winCenter = new THREE.Vector3(W, (win.y0 + win.y1) / 2, (win.z0 + win.z1) / 2);
  const shaftTarget = new THREE.Vector3(1.1, 0, -0.4);
  const shaftDir = shaftTarget.clone().sub(winCenter);
  const shaftLen = shaftDir.length();
  const shaftMat = new THREE.MeshBasicMaterial({
    color: 0xffe9b8, transparent: true, opacity: 0.055,
    blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false,
  });
  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(1.15, 0.62, shaftLen, 18, 1, true), shaftMat);
  shaft.position.copy(winCenter).addScaledVector(shaftDir, 0.5);
  shaft.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), shaftDir.clone().normalize());
  g.add(shaft);

  // Dust motes drifting in the shaft.
  const MOTES = 150;
  const motePos = new Float32Array(MOTES * 3);
  for (let i = 0; i < MOTES; i++) {
    const k = rng();
    const p = winCenter.clone().addScaledVector(shaftDir, k);
    const spread = 0.35 + k * 0.75;
    motePos[i * 3] = p.x + rand(rng, -spread, spread);
    motePos[i * 3 + 1] = p.y + rand(rng, -spread, spread) * 0.6;
    motePos[i * 3 + 2] = p.z + rand(rng, -spread, spread);
  }
  const moteGeo = new THREE.BufferGeometry();
  moteGeo.setAttribute('position', new THREE.BufferAttribute(motePos, 3));
  const motes = new THREE.Points(moteGeo, new THREE.PointsMaterial({
    color: 0xffe9b8, size: 0.02, transparent: true, opacity: 0.55,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  g.add(motes);

  // ---- roosts: two bars along the back wall ------------------------------
  const roosts = [
    { y: 1.0, z: -3.9, x0: -3.2, x1: 3.2 },
    { y: 1.6, z: -4.4, x0: -3.2, x1: 3.2 },
  ];
  const barMat = wood(0x8f6c46);
  for (const r of roosts) {
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, r.x1 - r.x0 + 0.6, 8), barMat);
    bar.rotation.z = Math.PI / 2;
    bar.position.set((r.x0 + r.x1) / 2, r.y, r.z);
    bar.castShadow = true;
    g.add(bar);
  }
  for (const x of [-3.4, 3.4]) {
    // A-frame supports carrying both bars
    for (const r of roosts) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.09, r.y, 0.09), barMat);
      leg.position.set(x, r.y / 2, r.z);
      leg.castShadow = true;
      g.add(leg);
    }
  }

  // ---- nesting boxes along the -X wall -----------------------------------
  const nests = [];
  const nestMat = wood(0x6e523a);
  const hayMat = new THREE.MeshStandardMaterial({ color: 0xc9a24e, flatShading: true, roughness: 1 });
  for (const z of [-1.5, 0, 1.5]) {
    const box = new THREE.Group();
    box.position.set(-4.55, 0, z);
    const back = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.75, 0.85), nestMat);
    back.position.set(-0.35, 0.375, 0);
    box.add(back);
    for (const side of [-1, 1]) {
      const wall2 = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.75, 0.06), nestMat);
      wall2.position.set(0, 0.375, side * 0.42);
      wall2.castShadow = true;
      box.add(wall2);
    }
    const roof = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.05, 0.9), nestMat);
    roof.position.set(-0.03, 0.78, 0);
    roof.rotation.z = 0.18;
    roof.castShadow = true;
    box.add(roof);
    const lip = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.16, 0.85), nestMat);
    lip.position.set(0.38, 0.08, 0);
    box.add(lip);
    const hay = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.38, 0.09, 9), hayMat);
    hay.position.set(0, 0.045, 0);
    box.add(hay);
    g.add(box);
    nests.push(new THREE.Vector3(-4.32, 0, z));
  }

  // ---- hanging feeder + water dish ---------------------------------------
  const feeder = new THREE.Vector3(2.2, 0, 2.4);
  const fGroup = new THREE.Group();
  fGroup.position.set(feeder.x, 0, feeder.z);
  const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, H - 0.72, 5),
    new THREE.MeshStandardMaterial({ color: 0x3a2f24, roughness: 0.8 }));
  cord.position.y = (H - 0.72) / 2 + 0.72;
  fGroup.add(cord);
  const hopper = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.3, 0.5, 10),
    new THREE.MeshStandardMaterial({ color: 0xb8422f, flatShading: true, roughness: 0.55 }));
  hopper.position.y = 0.62;
  hopper.castShadow = true;
  fGroup.add(hopper);
  const tray = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.34, 0.09, 12),
    new THREE.MeshStandardMaterial({ color: 0xd9c58f, flatShading: true, roughness: 0.8 }));
  tray.position.y = 0.32;
  tray.castShadow = true;
  fGroup.add(tray);
  g.add(fGroup);

  const water = new THREE.Vector3(-2.4, 0, 2.7);
  const dish = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.26, 0.11, 12),
    new THREE.MeshStandardMaterial({ color: 0x4a748f, flatShading: true, roughness: 0.4 }));
  dish.position.set(water.x, 0.055, water.z);
  dish.castShadow = true;
  g.add(dish);
  const waterSurf = new THREE.Mesh(new THREE.CircleGeometry(0.24, 12),
    new THREE.MeshStandardMaterial({ color: 0x7fb0c9, roughness: 0.1, metalness: 0.3 }));
  waterSurf.rotation.x = -Math.PI / 2;
  waterSurf.position.set(water.x, 0.105, water.z);
  g.add(waterSurf);

  // ---- hay bales in a corner ---------------------------------------------
  const hayBaleMat = new THREE.MeshStandardMaterial({ color: 0xc2a050, flatShading: true, roughness: 1 });
  const bale1 = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.7, 0.85), hayBaleMat);
  bale1.position.set(3.95, 0.35, 4.3);
  bale1.rotation.y = 0.25;
  bale1.castShadow = true;
  g.add(bale1);
  const bale2 = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.7, 0.85), hayBaleMat);
  bale2.position.set(4.25, 1.02, 4.45);
  bale2.rotation.y = -0.12;
  bale2.castShadow = true;
  g.add(bale2);

  // ---- scattered straw (instanced) ---------------------------------------
  const STRAW = 160;
  const strawGeo = new THREE.BoxGeometry(0.22, 0.012, 0.035);
  const strawMesh = new THREE.InstancedMesh(strawGeo,
    new THREE.MeshStandardMaterial({ flatShading: true, roughness: 1 }), STRAW);
  const dummy = new THREE.Object3D();
  const straw = new THREE.Color();
  for (let i = 0; i < STRAW; i++) {
    dummy.position.set(rand(rng, -4.7, 4.7), 0.028, rand(rng, -4.7, 4.7));
    dummy.rotation.set(0, rand(rng, 0, Math.PI * 2), rand(rng, -0.08, 0.08));
    dummy.scale.setScalar(rand(rng, 0.6, 1.5));
    dummy.updateMatrix();
    strawMesh.setMatrixAt(i, dummy.matrix);
    straw.setHex(0xc9a24e).offsetHSL(rand(rng, -0.02, 0.02), rand(rng, -0.1, 0.1), rand(rng, -0.12, 0.1));
    strawMesh.setColorAt(i, straw);
  }
  strawMesh.receiveShadow = true;
  g.add(strawMesh);

  // ---- "days without incident" sign (it never gets far) -------------------
  const signCanvas = document.createElement('canvas');
  signCanvas.width = 256; signCanvas.height = 128;
  const signCtx = signCanvas.getContext('2d');
  const signTex = new THREE.CanvasTexture(signCanvas);
  const drawSign = (days) => {
    const ctx = signCtx;
    ctx.fillStyle = '#2b2019'; ctx.fillRect(0, 0, 256, 128);
    ctx.strokeStyle = '#c9b28a'; ctx.lineWidth = 5; ctx.strokeRect(6, 6, 244, 116);
    ctx.fillStyle = '#e8dcc0'; ctx.textAlign = 'center';
    ctx.font = '22px Georgia';
    ctx.fillText('DAYS WITHOUT', 128, 40);
    ctx.fillText('INCIDENT', 128, 66);
    ctx.font = 'bold 44px Georgia';
    ctx.fillStyle = days > 0 ? '#8fbf6a' : '#e8a33d';
    ctx.fillText(String(days), 128, 112);
    signTex.needsUpdate = true;
  };
  drawSign(0);
  const sign = new THREE.Mesh(
    new THREE.PlaneGeometry(1.0, 0.5),
    new THREE.MeshStandardMaterial({ map: signTex, roughness: 0.9 }));
  sign.position.set(0.6, 2.3, 4.93);
  sign.rotation.y = Math.PI;
  g.add(sign);

  // ---- hanging bulb -------------------------------------------------------
  // Pivoted at the ceiling so the whole fixture can swing when Bertha walks.
  const bulbGroup = new THREE.Group();
  bulbGroup.position.set(0, H, 0.4);
  const bulbCord = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.85, 5),
    new THREE.MeshStandardMaterial({ color: 0x1e1a16, roughness: 0.9 }));
  bulbCord.position.y = -0.425;
  bulbGroup.add(bulbCord);
  const shade = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.22, 12, 1, true),
    new THREE.MeshStandardMaterial({ color: 0x2e5545, flatShading: true, roughness: 0.5, side: THREE.DoubleSide }));
  shade.position.y = -0.9;
  bulbGroup.add(shade);
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 8),
    new THREE.MeshBasicMaterial({ color: 0xffe6b0 }));
  bulb.position.y = -1.0;
  bulbGroup.add(bulb);
  g.add(bulbGroup);

  // ---- the pop-hole and its door ------------------------------------------
  const frameWood = wood(0x8f6c46);
  for (const side of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, DOOR.top + 0.1, 0.2), frameWood);
    post.position.set(DOOR.x + side * (DOOR.halfWidth + 0.05), (DOOR.top + 0.1) / 2, W);
    post.castShadow = true;
    g.add(post);
  }
  const lintel = new THREE.Mesh(
    new THREE.BoxGeometry(DOOR.halfWidth * 2 + 0.24, 0.14, 0.2), frameWood);
  lintel.position.set(DOOR.x, DOOR.top + 0.07, W);
  lintel.castShadow = true;
  g.add(lintel);

  // Hinged on the left post, swinging out into the yard.
  const doorPivot = new THREE.Group();
  doorPivot.position.set(DOOR.x - DOOR.halfWidth, 0, W + 0.09);
  const doorPanel = new THREE.Mesh(
    new THREE.BoxGeometry(DOOR.halfWidth * 2, DOOR.top - 0.04, 0.06),
    wood(0x7d5c3a, 0.85));
  doorPanel.position.set(DOOR.halfWidth, (DOOR.top - 0.04) / 2, 0);
  doorPanel.castShadow = true;
  doorPivot.add(doorPanel);
  for (const dy of [0.35, 1.1]) {
    const brace = new THREE.Mesh(new THREE.BoxGeometry(DOOR.halfWidth * 2, 0.09, 0.02), frameWood);
    brace.position.set(DOOR.halfWidth, dy, 0.04);
    doorPivot.add(brace);
  }
  g.add(doorPivot);

  // ---- a simple roof, so the coop reads as a building from outside --------
  const roofMat = wood(0x6a4a33, 0.95);
  for (const side of [-1, 1]) {
    const slope = new THREE.Mesh(new THREE.BoxGeometry(W * 2 + 0.7, 0.12, W * 1.55), roofMat);
    slope.position.set(0, H + 0.62, side * W * 0.55);
    slope.rotation.x = side * -0.42;
    slope.castShadow = true;
    g.add(slope);
  }

  const yard = buildYard(g, rng);

  scene.add(g);

  return {
    W, H, roosts, nests, feeder, water, doorPivot, yard,
    motes, motePos, shaftDir, winCenter, drawSign, shaftMat, winSkyMat,
    bulbRig: bulbGroup, bulbMesh: bulb,
    bulbPos: new THREE.Vector3(0, H - 1.0, 0.4),
  };
}

// The run outside the pop-hole: grass, a fence, a stump to perch on, a
// puddle, and a sky to sit under. Built into the same group as the coop so
// the two can never drift apart.
function buildYard(g, rng) {
  const yard = new THREE.Group();

  // Sky dome. A vertical gradient painted on a canvas beats a flat colour
  // and costs nothing; the coop's own walls occlude it from inside.
  const skyCanvas = document.createElement('canvas');
  skyCanvas.width = 4; skyCanvas.height = 128;
  const sctx = skyCanvas.getContext('2d');
  const grad = sctx.createLinearGradient(0, 0, 0, 128);
  grad.addColorStop(0, '#3f78b5');
  grad.addColorStop(0.45, '#8fc0dd');
  grad.addColorStop(0.75, '#d8e6ea');
  grad.addColorStop(1, '#e8e0cb');
  sctx.fillStyle = grad;
  sctx.fillRect(0, 0, 4, 128);
  const skyMat = new THREE.MeshBasicMaterial({
    map: new THREE.CanvasTexture(skyCanvas), side: THREE.BackSide, depthWrite: false,
  });
  yard.add(new THREE.Mesh(new THREE.SphereGeometry(46, 16, 12), skyMat));

  // Ground. Tucked under the coop wall so there is no seam at the threshold.
  const ground = new THREE.Mesh(
    new THREE.BoxGeometry((YARD.x1 - YARD.x0) + 3.5, 0.2, (YARD.z1 - YARD.z0) + 3.2),
    new THREE.MeshStandardMaterial({ color: 0x6f8347, flatShading: true, roughness: 1 }));
  ground.position.set((YARD.x0 + YARD.x1) / 2, -0.1, (WALL_Z + YARD.z1 + 0.9) / 2);
  ground.receiveShadow = true;
  yard.add(ground);

  // A scuffed patch of bare earth just outside the door, where they mill.
  const scuff = new THREE.Mesh(
    new THREE.CircleGeometry(2.1, 14),
    new THREE.MeshStandardMaterial({ color: 0x7d6743, flatShading: true, roughness: 1 }));
  scuff.rotation.x = -Math.PI / 2;
  scuff.position.set(DOOR.x, 0.012, WALL_Z + 1.5);
  scuff.receiveShadow = true;
  yard.add(scuff);

  // Grass tufts, thinning out near the scuffed patch.
  const TUFTS = 420;
  const tuft = new THREE.ConeGeometry(0.075, 0.3, 4);
  const grass = new THREE.InstancedMesh(
    tuft, new THREE.MeshStandardMaterial({ flatShading: true, roughness: 1 }), TUFTS);
  const dummy = new THREE.Object3D();
  const col = new THREE.Color();
  let placed = 0;
  for (let i = 0; i < TUFTS * 3 && placed < TUFTS; i++) {
    const x = rand(rng, YARD.x0 - 1, YARD.x1 + 1);
    const z = rand(rng, WALL_Z + 0.4, YARD.z1 + 1);
    const bare = Math.hypot(x - DOOR.x, z - (WALL_Z + 1.5)) < rand(rng, 0.6, 2.4);
    if (bare) continue;
    dummy.position.set(x, rand(rng, 0.08, 0.15), z);
    dummy.rotation.set(rand(rng, -0.2, 0.2), rand(rng, 0, Math.PI), rand(rng, -0.2, 0.2));
    dummy.scale.setScalar(rand(rng, 0.7, 1.5));
    dummy.updateMatrix();
    grass.setMatrixAt(placed, dummy.matrix);
    col.setHex(0x7e9b4e).offsetHSL(rand(rng, -0.04, 0.04), rand(rng, -0.1, 0.12), rand(rng, -0.1, 0.1));
    grass.setColorAt(placed, col);
    placed++;
  }
  grass.count = placed;
  grass.receiveShadow = true;
  yard.add(grass);

  // Fence: posts and two rails, open where it meets the coop.
  const postMat = wood(0x6b5236, 0.95);
  const railMat = wood(0x7a5f3d, 0.95);
  const fence = [];
  const step = 1.55;
  for (let x = YARD.x0 - 0.4; x <= YARD.x1 + 0.4; x += step) fence.push([x, YARD.z1 + 0.4]);
  for (let z = WALL_Z; z <= YARD.z1 + 0.4; z += step) {
    fence.push([YARD.x0 - 0.4, z]);
    fence.push([YARD.x1 + 0.4, z]);
  }
  for (const [x, z] of fence) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.25, 0.1), postMat);
    post.position.set(x, 0.62, z);
    post.castShadow = true;
    yard.add(post);
  }
  const railRuns = [
    { len: (YARD.x1 - YARD.x0) + 0.8, pos: [(YARD.x0 + YARD.x1) / 2, 0, YARD.z1 + 0.4], rot: 0 },
    { len: (YARD.z1 + 0.4 - WALL_Z), pos: [YARD.x0 - 0.4, 0, (WALL_Z + YARD.z1 + 0.4) / 2], rot: Math.PI / 2 },
    { len: (YARD.z1 + 0.4 - WALL_Z), pos: [YARD.x1 + 0.4, 0, (WALL_Z + YARD.z1 + 0.4) / 2], rot: Math.PI / 2 },
  ];
  for (const run of railRuns) {
    for (const y of [0.45, 1.0]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(run.len, 0.07, 0.05), railMat);
      rail.position.set(run.pos[0], y, run.pos[2]);
      rail.rotation.y = run.rot;
      rail.castShadow = true;
      yard.add(rail);
    }
  }

  // A stump to stand on and feel important about.
  const stump = new THREE.Mesh(
    new THREE.CylinderGeometry(0.55, 0.62, 0.7, 9),
    wood(0x6b5138, 0.95));
  stump.position.set(3.1, 0.35, 8.6);
  stump.castShadow = true;
  stump.receiveShadow = true;
  yard.add(stump);
  const stumpTop = new THREE.Mesh(
    new THREE.CylinderGeometry(0.55, 0.55, 0.04, 9),
    new THREE.MeshStandardMaterial({ color: 0xa8845a, flatShading: true, roughness: 0.9 }));
  stumpTop.position.set(3.1, 0.71, 8.6);
  yard.add(stumpTop);

  // A puddle that never quite dries out.
  const puddle = new THREE.Mesh(
    new THREE.CircleGeometry(1.05, 16),
    new THREE.MeshStandardMaterial({ color: 0x7fa6b8, roughness: 0.12, metalness: 0.45 }));
  puddle.rotation.x = -Math.PI / 2;
  puddle.position.set(-3.6, 0.016, 10.2);
  yard.add(puddle);

  g.add(yard);
  return {
    group: yard, skyMat,
    stump: new THREE.Vector3(3.1, 0.74, 8.6),
    puddle: new THREE.Vector3(-3.6, 0, 10.2),
  };
}

// Gentle drift for the dust motes; called every frame.
export function updateMotes(coop, time) {
  const p = coop.motePos;
  const attr = coop.motes.geometry.attributes.position;
  for (let i = 0; i < p.length / 3; i++) {
    attr.array[i * 3] = p[i * 3] + Math.sin(time * 0.35 + i * 1.7) * 0.06;
    attr.array[i * 3 + 1] = p[i * 3 + 1] + Math.sin(time * 0.22 + i * 2.3) * 0.09;
    attr.array[i * 3 + 2] = p[i * 3 + 2] + Math.cos(time * 0.28 + i * 0.9) * 0.06;
  }
  attr.needsUpdate = true;
}
