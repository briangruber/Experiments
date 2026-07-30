import * as THREE from 'three';
import { BOATS } from '/shared/config.js';

// Every hull is lofted from the same section sweep, so a rowboat and a
// Leviathan-Class read as the same shipyard at different budgets. Forward is
// +X in local space, which lines up with the heading angle used everywhere else.

const RIGS = [
  { // Rowboat
    palette: { hull: 0x8a6a45, trim: 0xc7a45c, deck: 0x9c7a52 },
    beam: 0.40, depth: 0.42, deck: true, oars: true, masts: [],
    winch: 0.30, rail: false, thwarts: true,
  },
  { // Skiff
    palette: { hull: 0x99754f, trim: 0xa8443f, deck: 0xb09268 },
    beam: 0.34, depth: 0.40, deck: true, oars: false,
    masts: [{ at: 0.05, h: 1.5, sails: [{ y: 0.30, w: 0.55, h: 0.62 }] }],
    winch: 0.34, rail: false, cabin: { at: -0.28, w: 0.34, h: 0.22 },
  },
  { // Cutter
    palette: { hull: 0x7c5c3e, trim: 0x2f6f92, deck: 0xa88a60 },
    beam: 0.31, depth: 0.40, deck: true, oars: false,
    masts: [{ at: 0.0, h: 1.7, sails: [{ y: 0.26, w: 0.62, h: 0.66 }, { y: 0.62, w: 0.34, h: 0.30 }] }],
    winch: 0.36, rail: true, cabin: { at: -0.30, w: 0.40, h: 0.24 }, bowsprit: true,
  },
  { // Whaler
    palette: { hull: 0x6b4f36, trim: 0xd8a13c, deck: 0x9d8054 },
    beam: 0.30, depth: 0.42, deck: true, oars: false,
    masts: [
      { at: 0.14, h: 1.55, sails: [{ y: 0.28, w: 0.56, h: 0.58 }] },
      { at: -0.20, h: 1.85, sails: [{ y: 0.24, w: 0.66, h: 0.68 }, { y: 0.64, w: 0.36, h: 0.30 }] },
    ],
    winch: 0.38, rail: true, cabin: { at: -0.34, w: 0.42, h: 0.26 }, bowsprit: true, platform: true,
  },
  { // Brigantine
    palette: { hull: 0x5d4630, trim: 0x8f2f2f, deck: 0x91764e },
    beam: 0.29, depth: 0.44, deck: true, oars: false,
    masts: [
      { at: 0.20, h: 1.75, sails: [{ y: 0.24, w: 0.70, h: 0.34, square: true }, { y: 0.60, w: 0.58, h: 0.28, square: true }] },
      { at: -0.16, h: 2.0, sails: [{ y: 0.22, w: 0.68, h: 0.66 }, { y: 0.64, w: 0.38, h: 0.30 }] },
    ],
    winch: 0.40, rail: true, cabin: { at: -0.36, w: 0.44, h: 0.30 }, bowsprit: true, platform: true,
  },
  { // Galleon
    palette: { hull: 0x4d3a28, trim: 0xd4af37, deck: 0x8a7048 },
    beam: 0.28, depth: 0.48, deck: true, oars: false, castle: true, ports: true,
    masts: [
      { at: 0.26, h: 1.6, sails: [{ y: 0.26, w: 0.62, h: 0.30, square: true }, { y: 0.62, w: 0.50, h: 0.26, square: true }] },
      { at: 0.0, h: 2.1, sails: [{ y: 0.22, w: 0.78, h: 0.34, square: true }, { y: 0.58, w: 0.64, h: 0.30, square: true }, { y: 0.84, w: 0.44, h: 0.20, square: true }] },
      { at: -0.28, h: 1.7, sails: [{ y: 0.26, w: 0.52, h: 0.52 }] },
    ],
    winch: 0.42, rail: true, cabin: null, bowsprit: true, platform: true,
  },
  { // Leviathan-Class
    palette: { hull: 0x3a4249, trim: 0xb8792f, deck: 0x5d5f5c },
    beam: 0.27, depth: 0.50, deck: true, oars: false, castle: true, ports: true, iron: true,
    masts: [
      { at: 0.28, h: 1.5, sails: [{ y: 0.28, w: 0.60, h: 0.28, square: true, dark: true }] },
      { at: -0.02, h: 2.2, sails: [{ y: 0.22, w: 0.80, h: 0.34, square: true, dark: true }, { y: 0.58, w: 0.66, h: 0.30, square: true, dark: true }] },
      { at: -0.32, h: 1.8, sails: [{ y: 0.26, w: 0.54, h: 0.50, dark: true }] },
    ],
    winch: 0.46, rail: true, cabin: null, bowsprit: true, platform: true, cannon: true,
  },
];

// Clamped: an unclamped t here silently produces NaN vertices via Math.pow.
const smoothstep = (t) => {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
};
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function hullGeometry(len, beam, depth, { transom = 0.52, bowSharp = 0.10 } = {}) {
  const NS = 22, NP = 13;
  const positions = [];
  const indices = [];
  const sections = [];

  for (let i = 0; i < NS; i++) {
    const t = i / (NS - 1); // 0 = transom, 1 = stem
    let f;
    if (t < 0.42) f = transom + (1 - transom) * smoothstep(t / 0.42);
    else f = bowSharp + (1 - bowSharp) * Math.pow(clamp01(1 - (t - 0.42) / 0.58), 0.8);
    const w = (beam / 2) * f;
    const d = depth * (1 - 0.42 * smoothstep((t - 0.62) / 0.38));
    const rise = Math.pow(clamp01(Math.abs(t - 0.46) / 0.54), 2.1);
    const sheer = depth * (0.10 + 0.30 * rise) * (t > 0.5 ? 1.25 : 1);
    const x = (t - 0.5) * len;
    const ring = [];
    for (let j = 0; j < NP; j++) {
      const s = (j / (NP - 1)) * 2 - 1;
      const z = w * s;
      const y = sheer - d * (1 - Math.pow(Math.abs(s), 2.2));
      ring.push([x, y, z]);
    }
    sections.push({ x, w, sheer, ring });
    for (const p of ring) positions.push(p[0], p[1], p[2]);
  }

  for (let i = 0; i < NS - 1; i++) {
    for (let j = 0; j < NP - 1; j++) {
      const a = i * NP + j, b = a + 1, c = a + NP, d = c + 1;
      indices.push(a, b, c, b, d, c);
    }
  }

  // Flat transom so the stern is not an open shell.
  const centre = positions.length / 3;
  positions.push(sections[0].x, sections[0].sheer - 0.4 * depth, 0);
  for (let j = 0; j < NP - 1; j++) indices.push(centre, j + 1, j);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return { geo, sections };
}

function deckGeometry(sections, depth) {
  const positions = [];
  const indices = [];
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    const y = s.sheer - depth * 0.16;
    positions.push(s.x, y, -s.w * 0.94, s.x, y, s.w * 0.94);
  }
  for (let i = 0; i < sections.length - 1; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    indices.push(a, c, b, b, c, d);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

function sailGeometry(w, h, bulge, square) {
  const NX = 8, NY = 8;
  const positions = [];
  const indices = [];
  for (let j = 0; j <= NY; j++) {
    for (let i = 0; i <= NX; i++) {
      const u = i / NX, v = j / NY;
      // A fore-and-aft sail tapers to the masthead; a square sail does not.
      const taper = square ? 1 : 1 - v * 0.82;
      const x = (u - (square ? 0.5 : 0.0)) * w * taper;
      const y = v * h;
      const z = Math.sin(Math.PI * u) * Math.sin(Math.PI * v * 0.9) * bulge;
      positions.push(x, y, z);
    }
  }
  for (let j = 0; j < NY; j++) {
    for (let i = 0; i < NX; i++) {
      const a = j * (NX + 1) + i, b = a + 1, c = a + NX + 1, d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

const mat = (color, opts = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness: 0.82, metalness: 0.02, flatShading: true, ...opts });

function crewFigure(color) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.22, 0.62, 6), mat(color));
  body.position.y = 0.31;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.15, 7, 6), mat(0xc79f7c));
  head.position.y = 0.75;
  const hat = new THREE.Mesh(new THREE.ConeGeometry(0.19, 0.16, 7), mat(0x2b3b47));
  hat.position.y = 0.88;
  g.add(body, head, hat);
  return g;
}

/**
 * Build a boat for a tier. Returns a group plus the attachment points the rest
 * of the game needs: where the harpoon leaves from, where the rope is cleated,
 * and where the wake is born.
 */
export function createBoat(tier, { crew = null, color = 0xd8503f } = {}) {
  const spec = BOATS[Math.max(0, Math.min(BOATS.length - 1, tier))];
  const rig = RIGS[Math.max(0, Math.min(RIGS.length - 1, tier))];
  const len = spec.length;
  const beam = len * rig.beam;
  const depth = len * rig.depth;

  const group = new THREE.Group();
  const { geo: hullGeo, sections } = hullGeometry(len, beam, depth, {});
  const hull = new THREE.Mesh(hullGeo, mat(rig.palette.hull, { side: THREE.DoubleSide, roughness: rig.iron ? 0.55 : 0.85, metalness: rig.iron ? 0.35 : 0.02 }));
  group.add(hull);

  const deckY = sections[Math.floor(sections.length / 2)].sheer - depth * 0.16;
  if (rig.deck) group.add(new THREE.Mesh(deckGeometry(sections, depth), mat(rig.palette.deck)));

  // Rubbing strake: a painted line along the sheer that sells the scale.
  for (const side of [-1, 1]) {
    const pts = sections.map((s) => new THREE.Vector3(s.x, s.sheer + depth * 0.012, s.w * side * 0.99));
    const curve = new THREE.CatmullRomCurve3(pts);
    const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 24, len * 0.012, 5, false), mat(rig.palette.trim));
    group.add(tube);
  }

  if (rig.rail) {
    for (const side of [-1, 1]) {
      for (let i = 2; i < sections.length - 3; i += 2) {
        const s = sections[i];
        const post = new THREE.Mesh(
          new THREE.BoxGeometry(len * 0.012, depth * 0.18, len * 0.012),
          mat(rig.palette.deck)
        );
        post.position.set(s.x, s.sheer + depth * 0.09, s.w * side * 0.95);
        group.add(post);
      }
    }
  }

  if (rig.thwarts) {
    for (const at of [-0.22, 0.06, 0.3]) {
      const seat = new THREE.Mesh(
        new THREE.BoxGeometry(len * 0.07, len * 0.018, beam * 0.92), mat(rig.palette.trim)
      );
      seat.position.set(len * at, deckY + len * 0.055, 0);
      group.add(seat);
    }
  }

  if (rig.cabin) {
    const c = rig.cabin;
    const cab = new THREE.Mesh(
      new THREE.BoxGeometry(len * 0.22, len * c.h, beam * c.w * 2),
      mat(rig.palette.deck)
    );
    cab.position.set(len * c.at, deckY + len * c.h * 0.5, 0);
    group.add(cab);
    const roof = new THREE.Mesh(
      new THREE.BoxGeometry(len * 0.24, len * 0.02, beam * c.w * 2.1),
      mat(rig.palette.trim)
    );
    roof.position.set(len * c.at, deckY + len * c.h + len * 0.01, 0);
    group.add(roof);
  }

  if (rig.castle) {
    const cast = new THREE.Mesh(
      new THREE.BoxGeometry(len * 0.20, len * 0.13, beam * 0.78),
      mat(rig.palette.hull)
    );
    cast.position.set(-len * 0.34, deckY + len * 0.065, 0);
    group.add(cast);
    const rail = new THREE.Mesh(
      new THREE.BoxGeometry(len * 0.21, len * 0.012, beam * 0.82),
      mat(rig.palette.trim)
    );
    rail.position.set(-len * 0.34, deckY + len * 0.135, 0);
    group.add(rail);
    const lantern = new THREE.Mesh(new THREE.SphereGeometry(len * 0.02, 7, 6), mat(0xffd88a, { emissive: 0xffa53d, emissiveIntensity: 1.4 }));
    lantern.position.set(-len * 0.44, deckY + len * 0.16, 0);
    group.add(lantern);
  }

  if (rig.ports) {
    for (const side of [-1, 1]) {
      for (let i = 0; i < 5; i++) {
        const x = (-0.28 + i * 0.13) * len;
        const s = sections[Math.round(((x / len) + 0.5) * (sections.length - 1))];
        const port = new THREE.Mesh(
          new THREE.BoxGeometry(len * 0.035, len * 0.035, len * 0.01),
          mat(0x14181c)
        );
        port.position.set(x, s.sheer - depth * 0.30, s.w * side * 1.0);
        group.add(port);
      }
    }
  }

  // Masts and canvas.
  const sailMat = mat(0xe6dcc6, { side: THREE.DoubleSide, roughness: 0.95 });
  const darkSailMat = mat(0x4a3b3f, { side: THREE.DoubleSide, roughness: 0.95 });
  const woodMat = mat(0x6d5334);
  for (const m of rig.masts) {
    const h = len * m.h * 0.5;
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(len * 0.012, len * 0.02, h, 7), woodMat);
    mast.position.set(len * m.at, deckY + h * 0.5, 0);
    group.add(mast);
    for (const s of m.sails) {
      const sw = len * s.w, sh = h * s.h;
      const sail = new THREE.Mesh(sailGeometry(sw, sh, sw * 0.13, s.square), s.dark ? darkSailMat : sailMat);
      sail.position.set(len * m.at + (s.square ? 0 : len * 0.02), deckY + h * s.y, 0);
      if (s.square) sail.rotation.y = Math.PI / 2;
      group.add(sail);
      const yard = new THREE.Mesh(
        new THREE.CylinderGeometry(len * 0.006, len * 0.006, s.square ? sw : sw * 0.9, 5),
        woodMat
      );
      yard.rotation.x = Math.PI / 2;
      if (!s.square) yard.rotation.z = Math.PI / 2;
      yard.position.set(len * m.at, deckY + h * s.y + (s.square ? sh : 0), 0);
      group.add(yard);
    }
  }

  if (rig.bowsprit) {
    const sprit = new THREE.Mesh(new THREE.CylinderGeometry(len * 0.008, len * 0.016, len * 0.30, 6), woodMat);
    sprit.rotation.z = Math.PI / 2 - 0.22;
    sprit.position.set(len * 0.56, deckY + len * 0.05, 0);
    group.add(sprit);
  }

  // The winch: the whole game hangs off this thing.
  const winchX = len * rig.winch;
  const drum = new THREE.Mesh(
    new THREE.CylinderGeometry(len * 0.035, len * 0.035, len * 0.09, 10),
    mat(0x8a6a45, { metalness: 0.3, roughness: 0.6 })
  );
  drum.rotation.x = Math.PI / 2;
  drum.position.set(winchX, deckY + len * 0.04, 0);
  group.add(drum);
  const post = new THREE.Mesh(new THREE.BoxGeometry(len * 0.02, len * 0.08, len * 0.02), mat(0x4a5257, { metalness: 0.5 }));
  post.position.set(winchX, deckY + len * 0.03, 0);
  group.add(post);

  if (rig.platform) {
    const plat = new THREE.Mesh(new THREE.BoxGeometry(len * 0.13, len * 0.014, beam * 0.5), mat(rig.palette.deck));
    plat.position.set(len * 0.42, deckY + len * 0.03, 0);
    group.add(plat);
  }

  if (rig.cannon) {
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(len * 0.022, len * 0.03, len * 0.20, 10), mat(0x2f373d, { metalness: 0.7, roughness: 0.35 }));
    barrel.rotation.z = Math.PI / 2 - 0.12;
    barrel.position.set(len * 0.46, deckY + len * 0.07, 0);
    group.add(barrel);
  }

  if (rig.oars) {
    for (const side of [-1, 1]) {
      // The pivot sits on the gunwale; the loom runs inboard, the blade aft
      // and outboard into the water.
      const oar = new THREE.Group();
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(len * 0.014, len * 0.014, len * 0.78, 5), woodMat);
      shaft.rotation.z = Math.PI / 2;
      shaft.position.x = -len * 0.16;
      const blade = new THREE.Mesh(new THREE.BoxGeometry(len * 0.16, len * 0.012, len * 0.055), woodMat);
      blade.position.set(-len * 0.52, -len * 0.02, 0);
      oar.add(shaft, blade);
      oar.position.set(len * 0.04, deckY + len * 0.05, side * beam * 0.54);
      oar.rotation.z = -0.16;
      oar.rotation.y = side * 0.34;
      oar.userData.side = side;
      oar.userData.oar = true;
      group.add(oar);
    }
  }

  // Flag, so you can read the wind and spot friends.
  const flagMat = mat(color, { side: THREE.DoubleSide });
  const flag = new THREE.Mesh(sailGeometry(len * 0.16, len * 0.10, len * 0.02, true), flagMat);
  const tallest = rig.masts.reduce((a, m) => Math.max(a, m.h), 0);
  flag.position.set(len * (rig.masts[0]?.at ?? -0.3), deckY + len * tallest * 0.5 - len * 0.12, 0);
  flag.rotation.y = Math.PI / 2;
  group.add(flag);

  // Crew on deck. They are the winch, and the monsters eat them.
  const crewHolder = new THREE.Group();
  group.add(crewHolder);
  const crewScale = 1.55; // a person is a person, whatever the hull
  const crewSlots = [];
  const maxShown = Math.min(spec.crew, 9);
  for (let i = 0; i < maxShown; i++) {
    const row = Math.floor(i / 3), col = i % 3;
    const fig = crewFigure([0x9c4b3f, 0x3f5a6b, 0x6b6142][i % 3]);
    fig.scale.setScalar(crewScale);
    fig.position.set(len * (0.24 - row * 0.15), deckY, Math.min(beam * 0.32, 1.1) * (col - 1));
    fig.rotation.y = Math.PI / 2;
    crewHolder.add(fig);
    crewSlots.push(fig);
  }

  const bowPoint = new THREE.Vector3(winchX + len * 0.06, deckY + len * 0.08, 0);
  const sternPoint = new THREE.Vector3(-len * 0.5, -depth * 0.1, 0);

  const api = {
    group, hull, spec, len, beam, depth, deckY,
    bowPoint, sternPoint,
    // How far above the water the hull's origin rides. Without this the
    // gunwale sits level with the sea and the boat reads as swamped.
    floatY: depth * 0.36,
    oars: group.children.filter((c) => c.userData.oar),
    setCrew(n) {
      for (let i = 0; i < crewSlots.length; i++) crewSlots[i].visible = i < n;
    },
    setFlagColor(c) { flagMat.color.set(c); },
    dispose() {
      group.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
      });
    },
  };
  api.setCrew(crew == null ? spec.crew : crew);
  return api;
}

/** A floating name plate for other players. */
export function createLabel(text, sub = '') {
  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 512, 128);
  ctx.font = '700 52px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.lineWidth = 8;
  ctx.strokeStyle = 'rgba(0,0,0,0.75)';
  ctx.strokeText(text, 256, 56);
  ctx.fillStyle = '#dff0f6';
  ctx.fillText(text, 256, 56);
  if (sub) {
    ctx.font = '600 32px ui-sans-serif, system-ui, sans-serif';
    ctx.strokeText(sub, 256, 100);
    ctx.fillStyle = '#f2c057';
    ctx.fillText(sub, 256, 100);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sprite.scale.set(9, 2.25, 1);
  sprite.renderOrder = 50;
  return sprite;
}
