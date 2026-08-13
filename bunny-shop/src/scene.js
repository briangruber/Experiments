// The shop itself: renderer, lighting, the room shell, and the placement of
// every generated prop.
//
// The room is built from primitives and canvas textures rather than generated
// models — walls and floors are exactly the kind of thing an image-to-3D model
// is bad at, and exactly the kind of thing a box is good at.

import * as THREE from 'three';
import { place } from './assets.js';
import { BAG, BELL, COUNTER, CRATE_X, DOOR, ROOM, SHELVES, STOCK } from './config.js';

// Per-asset framing. Heights are in metres; `ry` corrects models that came out
// of the generator facing the wrong way.
export const TWEAKS = {
  counter: { height: 0.94 },
  shelf: { height: 2.05 },
  crate: { height: 0.36 },
  sign: { height: 0.85 },
  plant: { height: 0.78 },
  basket: { height: 0.4 },
  bell: { height: 0.26 },
  trenchcoat: { height: 1.9 },
  // The generated rabbits rest facing +x; the game drives yaw assuming +z.
  bunny_round: { height: 1.34, ry: -Math.PI / 2 },
  bunny_lanky: { height: 1.68, ry: -Math.PI / 2 },
  carrot: { height: 0.26 },
  cabbage: { height: 0.22 },
  strawberry: { height: 0.18 },
  corn: { height: 0.3 },
  radish: { height: 0.18 },
  muffin: { height: 0.2 },
};

// ---------------------------------------------------------------- textures

function canvasTexture(w, h, draw, repeat = [1, 1]) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(...repeat);
  t.anisotropy = 8;
  return t;
}

const rand = (a, b) => a + Math.random() * (b - a);

function woodTexture() {
  return canvasTexture(
    512,
    512,
    (g, w, h) => {
      const plank = h / 8;
      for (let i = 0; i < 8; i++) {
        const shade = rand(0.86, 1.06);
        g.fillStyle = `rgb(${Math.min(255, 176 * shade)}, ${Math.min(255, 130 * shade)}, ${Math.min(255, 88 * shade)})`;
        g.fillRect(0, i * plank, w, plank);

        // Grain: long, low-contrast horizontal streaks.
        for (let k = 0; k < 26; k++) {
          g.strokeStyle = `rgba(96, 62, 34, ${rand(0.03, 0.11)})`;
          g.lineWidth = rand(0.6, 2.2);
          const y = i * plank + rand(2, plank - 2);
          g.beginPath();
          g.moveTo(rand(-40, 120), y);
          g.bezierCurveTo(w * 0.3, y + rand(-3, 3), w * 0.7, y + rand(-3, 3), w + 40, y + rand(-2, 2));
          g.stroke();
        }
        // Seam between planks.
        g.fillStyle = 'rgba(70, 44, 26, 0.5)';
        g.fillRect(0, i * plank, w, 2);
      }
    },
    [6, 5],
  );
}

function plasterTexture(hex) {
  return canvasTexture(
    256,
    256,
    (g, w, h) => {
      g.fillStyle = hex;
      g.fillRect(0, 0, w, h);
      for (let i = 0; i < 5000; i++) {
        g.fillStyle = `rgba(255,255,255,${rand(0.01, 0.05)})`;
        g.fillRect(Math.random() * w, Math.random() * h, 2, 2);
      }
      for (let i = 0; i < 2200; i++) {
        g.fillStyle = `rgba(0,0,0,${rand(0.01, 0.04)})`;
        g.fillRect(Math.random() * w, Math.random() * h, 2, 2);
      }
    },
    [4, 2],
  );
}

// ---------------------------------------------------------------- renderer

export function createRenderer(canvas) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  return renderer;
}

// ---------------------------------------------------------------- the room

function buildRoom(scene) {
  const { width: W, depth: D, height: H, zBack, zFront } = ROOM;
  const wallColour = '#f2e2c2';

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(W, D),
    new THREE.MeshStandardMaterial({ map: woodTexture(), roughness: 0.78, metalness: 0 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, 0, (zBack + zFront) / 2);
  floor.receiveShadow = true;
  scene.add(floor);

  const wallMat = new THREE.MeshStandardMaterial({ map: plasterTexture(wallColour), roughness: 0.94 });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x6f9e78, roughness: 0.6 });

  // Back wall, plus the two returns. No fourth wall — the camera lives there.
  const back = new THREE.Mesh(new THREE.PlaneGeometry(W, H), wallMat);
  back.position.set(0, H / 2, zBack);
  back.receiveShadow = true;
  scene.add(back);

  for (const sx of [-1, 1]) {
    const side = new THREE.Mesh(new THREE.PlaneGeometry(D, H), wallMat);
    side.rotation.y = (-sx * Math.PI) / 2;
    side.position.set((sx * W) / 2, H / 2, (zBack + zFront) / 2);
    side.receiveShadow = true;
    scene.add(side);
  }

  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(W, D), new THREE.MeshStandardMaterial({ color: 0xfaf0dd, roughness: 1 }));
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.set(0, H, (zBack + zFront) / 2);
  scene.add(ceiling);

  // Wainscot: a painted band around the bottom of the walls.
  const skirt = (w, x, z, ry) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.92, 0.09), trimMat);
    m.position.set(x, 0.46, z);
    m.rotation.y = ry;
    m.receiveShadow = true;
    scene.add(m);
  };
  skirt(W, 0, zBack + 0.05, 0);
  skirt(D, -W / 2 + 0.05, (zBack + zFront) / 2, Math.PI / 2);
  skirt(D, W / 2 - 0.05, (zBack + zFront) / 2, Math.PI / 2);

  buildRug(scene);
  buildDoor(scene, trimMat);
  buildWindow(scene);
  buildBunting(scene);
  buildLamps(scene);
}

// A braided rug, to stop the middle of the floor reading as an empty car park.
function buildRug(scene) {
  // Few, wide, low-contrast bands. Many bright ones turn a rug into a dartboard.
  const texture = canvasTexture(256, 256, (g, w, h) => {
    const bands = ['#d9c3a0', '#c9a882', '#dcc9ab', '#b99a78'];
    for (let r = bands.length - 1; r >= 0; r--) {
      g.beginPath();
      g.arc(w / 2, h / 2, ((r + 1) * w) / (2 * bands.length), 0, Math.PI * 2);
      g.fillStyle = bands[r];
      g.fill();
    }
    // A faint woven grain across the whole thing.
    for (let i = 0; i < 6000; i++) {
      g.fillStyle = `rgba(90, 62, 40, ${rand(0.02, 0.07)})`;
      g.fillRect(Math.random() * w, Math.random() * h, 3, 1);
    }
  });
  texture.repeat.set(1, 1);

  const rug = new THREE.Mesh(
    new THREE.CircleGeometry(2.3, 48),
    new THREE.MeshStandardMaterial({ map: texture, roughness: 1 }),
  );
  rug.rotation.x = -Math.PI / 2;
  // A hair above the boards, or the two planes fight over the same depth.
  rug.position.set(-1.4, 0.004, -1.6);
  rug.receiveShadow = true;
  scene.add(rug);
}

// A doorway punched into the back wall, with daylight behind it. It is a
// cut-out rather than real geometry: rabbits walk in from a spot outside and
// the frame sells the illusion.
function buildDoor(scene, trimMat) {
  const w = 1.9;
  const h = 2.7;

  // These sit just *inside* the back wall. Putting them behind it hides them
  // completely, which is the difference between a doorway and a green rectangle.
  const opening = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({ color: 0xbfe4f2, toneMapped: false }),
  );
  opening.position.set(DOOR.x, h / 2, ROOM.zBack + 0.01);
  scene.add(opening);

  // Suggestion of a meadow through the door.
  const meadow = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h * 0.42),
    new THREE.MeshBasicMaterial({ color: 0x93c96d, toneMapped: false }),
  );
  meadow.position.set(DOOR.x, h * 0.21, ROOM.zBack + 0.015);
  scene.add(meadow);

  const frame = new THREE.Group();
  const bar = (bw, bh, x, y) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, 0.16), trimMat);
    m.position.set(x, y, 0);
    m.castShadow = true;
    frame.add(m);
  };
  bar(0.18, h + 0.18, -w / 2, h / 2);
  bar(0.18, h + 0.18, w / 2, h / 2);
  bar(w + 0.36, 0.2, 0, h + 0.09);
  frame.position.set(DOOR.x, 0, ROOM.zBack + 0.03);
  scene.add(frame);
}

// A window high on the right wall. It is the motivation for the key light, so
// the shadows in the room have a reason to fall the way they do.
function buildWindow(scene) {
  const w = 2.6;
  const h = 1.8;
  const x = ROOM.width / 2 - 0.04;
  const y = 2.5;
  const z = 0.4;

  const pane = new THREE.Mesh(
    new THREE.PlaneGeometry(h, w),
    new THREE.MeshBasicMaterial({ color: 0xfff4d8, toneMapped: false }),
  );
  pane.rotation.y = -Math.PI / 2;
  pane.rotation.z = Math.PI / 2;
  pane.position.set(x, y, z);
  scene.add(pane);

  const frameMat = new THREE.MeshStandardMaterial({ color: 0xf6efe0, roughness: 0.7 });
  const mullion = (len, vertical) => {
    const g = vertical ? new THREE.BoxGeometry(0.1, h, 0.1) : new THREE.BoxGeometry(0.1, 0.1, w);
    const m = new THREE.Mesh(g, frameMat);
    m.position.set(x - 0.06, y, z);
    scene.add(m);
    return m;
  };
  mullion(h, true);
  mullion(w, false);
}

// Triangular bunting strung across the ceiling. Cheap, and it does more for the
// "cosy village shop" read than any amount of shader work.
function buildBunting(scene) {
  const colours = [0xff8f6b, 0xffd166, 0x8fd06a, 0x6bc4d6, 0xd694e8];
  const group = new THREE.Group();
  const span = ROOM.width - 1.4;
  const n = 15;

  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const x = -span / 2 + t * span;
    // A shallow catenary so the string sags convincingly.
    const sag = Math.sin(t * Math.PI) * 0.42;
    const flag = new THREE.Mesh(
      new THREE.ConeGeometry(0.17, 0.34, 3),
      new THREE.MeshStandardMaterial({ color: colours[i % colours.length], roughness: 0.85, side: THREE.DoubleSide }),
    );
    flag.rotation.x = Math.PI;
    flag.rotation.y = Math.PI / 2;
    flag.position.set(x, ROOM.height - 0.55 - sag, -1.6);
    group.add(flag);
  }

  const curve = new THREE.CatmullRomCurve3(
    Array.from({ length: 16 }, (_, i) => {
      const t = i / 15;
      return new THREE.Vector3(-span / 2 + t * span, ROOM.height - 0.36 - Math.sin(t * Math.PI) * 0.42, -1.6);
    }),
  );
  const string = new THREE.Mesh(
    new THREE.TubeGeometry(curve, 40, 0.012, 5, false),
    new THREE.MeshStandardMaterial({ color: 0x8a6a4a, roughness: 1 }),
  );
  group.add(string);
  scene.add(group);
}

function buildLamps(scene) {
  for (const x of [-3.4, 2.2]) {
    const g = new THREE.Group();
    const cord = new THREE.Mesh(
      new THREE.CylinderGeometry(0.012, 0.012, 0.85),
      new THREE.MeshStandardMaterial({ color: 0x4a3a2c }),
    );
    cord.position.y = ROOM.height - 0.42;
    g.add(cord);

    const shade = new THREE.Mesh(
      new THREE.ConeGeometry(0.34, 0.3, 20, 1, true),
      new THREE.MeshStandardMaterial({ color: 0xe0664f, roughness: 0.6, side: THREE.DoubleSide }),
    );
    shade.position.y = ROOM.height - 0.98;
    shade.castShadow = true;
    g.add(shade);

    const bulb = new THREE.Mesh(
      new THREE.SphereGeometry(0.075, 14, 10),
      new THREE.MeshBasicMaterial({ color: 0xffe9b8, toneMapped: false }),
    );
    bulb.position.y = ROOM.height - 1.11;
    g.add(bulb);

    const light = new THREE.PointLight(0xffd9a0, 9, 9, 2);
    light.position.set(0, ROOM.height - 1.15, 0);
    g.add(light);

    g.position.set(x, 0, -1.2);
    scene.add(g);
  }
}

// ---------------------------------------------------------------- lighting

function buildLights(scene) {
  scene.add(new THREE.HemisphereLight(0xdff0ff, 0x6b5540, 0.85));

  // Key light, motivated by the window on the right wall.
  const sun = new THREE.DirectionalLight(0xfff0d0, 3.1);
  sun.position.set(9, 7.5, 3.5);
  sun.target.position.set(-1, 0.6, -1.5);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -12;
  sun.shadow.camera.right = 12;
  sun.shadow.camera.top = 10;
  sun.shadow.camera.bottom = -8;
  sun.shadow.camera.near = 0.5;
  sun.shadow.camera.far = 34;
  sun.shadow.bias = -0.0012;
  sun.shadow.normalBias = 0.02;
  scene.add(sun, sun.target);

  // Cool bounce from the open doorway, so the back of the shop is not dead.
  const fill = new THREE.DirectionalLight(0xbcd8ff, 0.5);
  fill.position.set(-6, 4, -8);
  scene.add(fill);

  // A soft lift on whoever is standing at the counter.
  const service = new THREE.PointLight(0xffe0b0, 6, 7, 2);
  service.position.set(3.4, 2.6, 2.2);
  scene.add(service);

  return sun;
}

// ---------------------------------------------------------------- props

// A plain length of shop counter: carcass, overhanging top, and a rail along
// the customer's side. Built rather than generated so it tiles cleanly with the
// till and takes the same wood as the floor.
function buildCounterRun(width, centreX) {
  const group = new THREE.Group();
  const wood = woodTexture();
  wood.repeat.set(width * 0.5, 1);

  const carcass = new THREE.Mesh(
    new THREE.BoxGeometry(width, COUNTER.top - 0.07, COUNTER.depth * 0.86),
    new THREE.MeshStandardMaterial({ color: 0xd9a86e, roughness: 0.72 }),
  );
  carcass.position.y = (COUNTER.top - 0.07) / 2;
  carcass.castShadow = true;
  carcass.receiveShadow = true;
  group.add(carcass);

  const top = new THREE.Mesh(
    new THREE.BoxGeometry(width + 0.08, 0.09, COUNTER.depth + 0.14),
    new THREE.MeshStandardMaterial({ map: wood, roughness: 0.55 }),
  );
  top.position.y = COUNTER.top - 0.025;
  top.castShadow = true;
  top.receiveShadow = true;
  group.add(top);

  // Painted panelling on the front, to match the wainscot.
  const panel = new THREE.Mesh(
    new THREE.BoxGeometry(width - 0.1, 0.42, 0.06),
    new THREE.MeshStandardMaterial({ color: 0x6f9e78, roughness: 0.62 }),
  );
  panel.position.set(0, 0.42, COUNTER.depth * 0.43 + 0.04);
  group.add(panel);

  group.position.set(centreX, 0, COUNTER.z);
  return group;
}

// Puts the generated models where they belong and returns the pieces the game
// needs to poke at later.
export function dressShop(scene, gltf) {
  const handles = { crates: [], clickable: [] };

  // The service counter is built rather than generated: stretching the
  // generated one to the width of the shop smeared its cash register into a
  // puddle, and a long plain run reads better under the produce anyway.
  const run = buildCounterRun(COUNTER.width, 0);
  run.userData.prop = 'counter';
  scene.add(run);
  handles.counter = run;
  handles.solids = [run];

  // The generated counter keeps its own proportions as a back counter against
  // the wall, which is the one place its little brass register can be seen.
  const till = place(gltf.counter, TWEAKS.counter);
  till.position.set(5.0, 0, ROOM.zBack + 0.9);
  till.rotation.y = -0.22;
  till.userData.prop = 'back counter';
  scene.add(till);
  handles.till = till;
  handles.solids.push(till);

  SHELVES.forEach((s, i) => {
    const shelf = place(gltf.shelf, { ...TWEAKS.shelf, clone: true });
    shelf.position.set(s.pos.x, 0, s.pos.z);
    shelf.rotation.y = s.ry;
    shelf.userData.prop = `shelf ${i}`;
    scene.add(shelf);
    handles.solids.push(shelf);
  });

  // Produce crates along the counter, each with a sample of its stock floating
  // just above it so the shelf reads at a glance.
  STOCK.forEach((item, i) => {
    const crate = place(gltf.crate, { ...TWEAKS.crate, clone: true });
    crate.position.set(CRATE_X[i], COUNTER.top, COUNTER.z - 0.16);
    scene.add(crate);

    // Oversized on purpose: at this camera distance a life-size radish is a
    // brown speck, and the crate has to be readable at a glance.
    const sample = place(gltf[item.id], { ...TWEAKS[item.id], height: TWEAKS[item.id].height * 1.4, clone: true });
    sample.position.set(CRATE_X[i], COUNTER.top + TWEAKS.crate.height * 0.55, COUNTER.z - 0.16);
    sample.rotation.y = Math.random() * Math.PI;
    scene.add(sample);

    // An invisible slab is a far more forgiving click target than the produce.
    const hit = new THREE.Mesh(
      new THREE.BoxGeometry(1.15, 0.9, 1.0),
      new THREE.MeshBasicMaterial({ visible: false }),
    );
    hit.position.set(CRATE_X[i], COUNTER.top + 0.35, COUNTER.z - 0.16);
    hit.userData = { kind: 'crate', id: item.id, index: i };
    scene.add(hit);

    handles.crates.push({ item, crate, sample, hit, home: crate.position.clone() });
    handles.clickable.push(hit);
  });

  const bag = place(gltf.basket, TWEAKS.basket);
  bag.position.set(BAG.x, BAG.y, BAG.z);
  scene.add(bag);
  handles.bag = bag;

  const bell = place(gltf.bell, TWEAKS.bell);
  bell.position.set(BELL.x, BELL.y, BELL.z);
  scene.add(bell);
  handles.bell = bell;

  const bellHit = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.8, 0.8), new THREE.MeshBasicMaterial({ visible: false }));
  bellHit.position.set(BELL.x, BELL.y + 0.25, BELL.z);
  bellHit.userData = { kind: 'bell' };
  scene.add(bellHit);
  handles.bellHit = bellHit;
  handles.clickable.push(bellHit);

  const sign = place(gltf.sign, TWEAKS.sign);
  sign.position.set(0.4, 3.15, ROOM.zBack + 0.25);
  scene.add(sign);

  for (const [x, z] of [
    [-6.2, 3.4],
    [6.2, -5.6],
  ]) {
    const plant = place(gltf.plant, { ...TWEAKS.plant, clone: true });
    plant.position.set(x, 0, z);
    plant.userData.prop = 'plant';
    scene.add(plant);
    handles.solids.push(plant);
  }

  // Stock on the shelves: a few items along the top plank of each unit, so the
  // shop looks like it sells something even when nobody is in it.
  SHELVES.forEach((s, i) => {
    const across = Math.sin(s.ry) === 0 ? 'x' : 'z';
    for (let k = 0; k < 3; k++) {
      const item = STOCK[(i * 2 + k) % STOCK.length];
      const goods = place(gltf[item.id], { ...TWEAKS[item.id], clone: true });
      const offset = (k - 1) * 0.42;
      goods.position.set(
        s.pos.x + (across === 'x' ? offset : 0),
        TWEAKS.shelf.height * 0.955,
        s.pos.z + (across === 'z' ? offset : 0),
      );
      goods.rotation.y = Math.random() * Math.PI * 2;
      scene.add(goods);
    }
  });

  // Full-size crates on the floor, as set dressing. The stacked pair share a
  // column, so the upper one sits on top of the lower one's height.
  const bigCrate = TWEAKS.crate.height * 1.7;
  for (const [x, y, z, ry] of [
    [-6.1, 0, -0.9, 0.3],
    [-6.05, bigCrate, -0.85, -0.2],
    [6.0, 0, 1.4, 0.5],
  ]) {
    const c = place(gltf.crate, { ...TWEAKS.crate, height: bigCrate, clone: true });
    c.position.set(x, y, z);
    c.rotation.y = ry;
    c.userData.prop = 'floor crate';
    scene.add(c);
    handles.solids.push(c);
  }

  // Flatten the solid props to XZ rectangles once, for the walking rabbits to
  // be pushed out of. Measuring the real geometry beats guessing: the shelves
  // turn out to be 2.68 deep, nothing like the footprint they appear to have.
  handles.obstacles = handles.solids.map((o) => {
    const b = new THREE.Box3().setFromObject(o);
    return { name: o.userData.prop, minX: b.min.x, maxX: b.max.x, minZ: b.min.z, maxZ: b.max.z };
  });

  return handles;
}

// ---------------------------------------------------------------- assembly

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => Math.max(0, Math.min(1, v));

// Hand-tuned compositions, blended by the shape of the canvas.
//
// Each stop is described by the half-height it wants to see, not the width:
// visible width follows from the aspect, but it is wasted *vertical* space —
// blank wall above, empty counter below — that makes a framing look wrong, and
// half-height is the number that controls it. There is no single camera that
// suits all of these:
//
//   tall    a phone upright — no room for a ten-metre counter, so close in on
//           the customer's face; the produce lives on the control pad anyway
//   normal  a laptop — the whole shop, rabbits browsing at the back
//   wide    a phone on its side — plenty of width, almost no height, so aim the
//           shallow band at the counter instead of the middle of the room
const FRAMINGS = [
  { aspect: 0.55, fov: 52, x: 2.75, y: 1.32, z: 0.3, halfHeight: 2.2, pitch: 0.14 },
  { aspect: 0.95, fov: 52, x: 2.3, y: 1.25, z: 0.2, halfHeight: 2.5, pitch: 0.2 },
  { aspect: 1.6, fov: 50, x: 0.0, y: 1.15, z: -0.8, halfHeight: 5.38, pitch: 0.355 },
  { aspect: 2.6, fov: 50, x: 1.2, y: 1.05, z: 0.4, halfHeight: 2.46, pitch: 0.26 },
];

function framingFor(aspect) {
  let lo = FRAMINGS[0];
  let hi = FRAMINGS[FRAMINGS.length - 1];
  for (let i = 0; i < FRAMINGS.length - 1; i++) {
    if (aspect <= FRAMINGS[i + 1].aspect) {
      lo = FRAMINGS[i];
      hi = FRAMINGS[i + 1];
      break;
    }
    lo = hi = FRAMINGS[i + 1];
  }
  const t = lo === hi ? 0 : clamp01((aspect - lo.aspect) / (hi.aspect - lo.aspect));
  const mix = {};
  for (const k of ['fov', 'x', 'y', 'z', 'halfHeight', 'pitch']) mix[k] = lerp(lo[k], hi[k], t);
  return mix;
}

/**
 * Frame the shop for whatever shape the viewport is.
 *
 * A phone held upright cannot show a ten-metre counter: at that aspect, fitting
 * the counter across the frame puts the camera further away than the room is
 * deep. So the framing slides between two compositions. Wide screens see the
 * whole shop, counter to back wall. Narrow ones close in on the customer being
 * served, and the produce moves out of the scene and onto the control pad,
 * where a thumb can actually hit it.
 *
 * The distance is solved from the horizontal extent that has to be visible,
 * rather than hard-coded, so nothing important slides off the edge at any
 * aspect in between.
 */
export function frameCamera(camera, aspect) {
  const f = framingFor(aspect);

  camera.fov = f.fov;
  const focus = new THREE.Vector3(f.x, f.y, f.z);
  const pitch = f.pitch;

  const dist = f.halfHeight / Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);

  const eye = new THREE.Vector3(
    focus.x,
    // Keep the eye under the ceiling; from above it, the ceiling is all you see.
    Math.min(focus.y + Math.sin(pitch) * dist, ROOM.height - 0.7),
    focus.z + Math.cos(pitch) * dist,
  );

  camera.position.copy(eye);
  camera.aspect = aspect;
  camera.lookAt(focus);
  camera.updateProjectionMatrix();

  return { eye, focus };
}

export function createWorld(canvas) {
  const renderer = createRenderer(canvas);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x2a1f1a);
  scene.fog = new THREE.Fog(0x3a2c22, 18, 38);

  const camera = new THREE.PerspectiveCamera(50, 1.777, 0.1, 90);
  frameCamera(camera, 1.777);

  buildRoom(scene);
  const sun = buildLights(scene);

  return { renderer, scene, camera, sun };
}
