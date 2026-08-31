// Placeholder art, drawn in code.
//
// This exists so the game is playable on the first run, with no API key, no
// credits spent and no waiting on a render. That matters more than it sounds:
// the expensive mistake in a generated-art pipeline is commissioning forty
// backdrops for a game whose verbs do not feel good yet. Procedural placeholder
// first, generated plate second, is the order that does not waste money.
//
// Every painter here has the signature the room expects — (ctx, room) for
// layers, (ctx, actor, scale) for actors — so replacing one with a drawImage of
// a generated PNG is a one-line edit. tools/plate.mjs writes exactly that
// PNG, and src/game/dock.js prefers it when it is on disk.

// Deterministic noise: the same room paints identically every frame and every
// run, so a visual check can compare two screenshots and mean it.
export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// The scene's fixed geometry. These numbers are the contract between the
// blockout, the generated plate and the animated layers: the horizon and the
// dock line are where they are because the walk polygons and scale anchors say
// so, and the repaint was instructed to keep them. Anything that needs to cut
// the plate back apart — the water shimmer, the cloud field — reads them here
// rather than guessing at the painting.
export const SCENE = {
  // Measured off the generated backdrop, not off a blockout — the art comes
  // first now. Anything sampling the backdrop converts into ITS pixel space
  // rather than assuming the two are the same size.
  roomW: 1280,
  roomH: 720,
  moon: { x: 340, y: 112, r: 40 },
  horizon: 392,       // sky meets sea
  dockTop: 512,       // sea meets planks, measured by tools/measure-room.mjs
  // The tavern mass on the right, generously bounded.
  tavern: { right: 780, top: 56 },
};

const MOON = SCENE.moon;

export function paintSky(ctx, room) {
  const g = ctx.createLinearGradient(0, 0, 0, 460);
  g.addColorStop(0, '#0a1430');
  g.addColorStop(0.45, '#1d2f57');
  g.addColorStop(0.78, '#3f4a70');
  g.addColorStop(1, '#7b6b84');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, room.width, 470);

  const r = rng(7);
  for (let i = 0; i < 220; i++) {
    const x = r() * room.width, y = r() * 380;
    const a = (1 - y / 420) * (0.25 + r() * 0.75);
    ctx.fillStyle = `rgba(255,246,222,${a * 0.85})`;
    ctx.fillRect(x, y, 1.6, 1.6);
  }

  ctx.save();
  const halo = ctx.createRadialGradient(MOON.x, MOON.y, MOON.r * 0.6, MOON.x, MOON.y, MOON.r * 6);
  halo.addColorStop(0, 'rgba(255,244,214,0.34)');
  halo.addColorStop(1, 'rgba(255,244,214,0)');
  ctx.fillStyle = halo;
  ctx.fillRect(MOON.x - MOON.r * 6, MOON.y - MOON.r * 6, MOON.r * 12, MOON.r * 12);
  ctx.fillStyle = '#fdf3d2';
  ctx.beginPath(); ctx.arc(MOON.x, MOON.y, MOON.r, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(214,203,176,0.5)';
  ctx.beginPath(); ctx.arc(MOON.x - 14, MOON.y - 10, 9, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(MOON.x + 12, MOON.y + 14, 6, 0, Math.PI * 2); ctx.fill();
  ctx.restore();

  // Cloud bands, painted as stacked translucent lozenges rather than blurred
  // blobs — a shape with an edge reads as painted, a gaussian reads as fog.
  const cr = rng(31);
  for (let i = 0; i < 16; i++) {
    const x = cr() * room.width * 1.1 - 60;
    const y = 70 + cr() * 250;
    const w = 140 + cr() * 300, h = 16 + cr() * 26;
    ctx.fillStyle = `rgba(${180 + cr() * 40 | 0},${170 + cr() * 40 | 0},190,${0.06 + cr() * 0.12})`;
    ctx.beginPath();
    ctx.ellipse(x, y, w / 2, h / 2, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

export function paintSea(ctx, room) {
  const horizon = 470;
  const g = ctx.createLinearGradient(0, horizon, 0, 620);
  g.addColorStop(0, '#5c5f81');
  g.addColorStop(0.4, '#2b3550');
  g.addColorStop(1, '#141c30');
  ctx.fillStyle = g;
  ctx.fillRect(0, horizon, room.width, 620 - horizon);

  // Moon glitter: a vertical column of short strokes that widens with distance
  // from the horizon. Cheap, and it is the single cue that says "water" more
  // than any amount of wave geometry at this size.
  const r = rng(19);
  for (let i = 0; i < 260; i++) {
    const t = r();
    const y = horizon + t * 148;
    const spread = 12 + t * 190;
    const x = MOON.x + (r() - 0.5) * spread * 2;
    const w = 3 + r() * (6 + t * 22);
    ctx.fillStyle = `rgba(255,244,214,${(1 - t) * 0.30 * (0.4 + r() * 0.6)})`;
    ctx.fillRect(x, y, w, 1.7);
  }
  for (let i = 0; i < 200; i++) {
    const y = horizon + r() * 150;
    ctx.fillStyle = `rgba(150,166,200,${0.05 + r() * 0.10})`;
    ctx.fillRect(r() * room.width, y, 8 + r() * 34, 1.4);
  }

  // A ship on the horizon, because the goal of the room should be visible from
  // the moment it starts. An adventure room with no visible objective is a
  // room full of clicking.
  ctx.save();
  ctx.fillStyle = '#0d1526';
  ctx.translate(1520, horizon - 4);
  ctx.beginPath();
  ctx.moveTo(-96, 0); ctx.lineTo(96, 0); ctx.lineTo(74, 26); ctx.lineTo(-72, 26); ctx.closePath();
  ctx.fill();
  for (const [mx, mh] of [[-46, 122], [4, 150], [50, 108]]) {
    ctx.fillRect(mx - 2.5, -mh, 5, mh);
    ctx.beginPath();
    ctx.moveTo(mx, -mh + 16);
    ctx.quadraticCurveTo(mx + 40, -mh * 0.55, mx + 6, -12);
    ctx.quadraticCurveTo(mx - 34, -mh * 0.55, mx, -mh + 16);
    ctx.fill();
  }
  ctx.restore();
}

export function paintDock(ctx, room) {
  const top = 596;
  ctx.fillStyle = '#2a2018';
  ctx.fillRect(0, top, room.width, room.height - top);

  const r = rng(53);
  // Planks run across the dock, darkening downstage so the floor has a depth
  // gradient the actor's own scaling can agree with.
  for (let y = top; y < room.height; y += 15) {
    const t = (y - top) / (room.height - top);
    const base = 62 - t * 22;
    ctx.fillStyle = `rgb(${base + r() * 14 | 0},${base * 0.76 + r() * 10 | 0},${base * 0.52 | 0})`;
    ctx.fillRect(0, y, room.width, 13.5);
    ctx.fillStyle = `rgba(12,8,5,${0.20 + r() * 0.14})`;
    ctx.fillRect(0, y + 13, room.width, 2.4);
  }
  for (let i = 0; i < 190; i++) {
    const x = r() * room.width, y = top + r() * (room.height - top);
    ctx.fillStyle = `rgba(18,12,8,${0.10 + r() * 0.20})`;
    ctx.fillRect(x, y, 20 + r() * 60, 1.6);
  }
  // Warm spill from the tavern window, laid over the planks.
  const spill = ctx.createRadialGradient(300, 640, 20, 300, 640, 420);
  spill.addColorStop(0, 'rgba(255,186,96,0.20)');
  spill.addColorStop(1, 'rgba(255,186,96,0)');
  ctx.fillStyle = spill;
  ctx.fillRect(0, top, 760, room.height - top);
}

export function paintTavern(ctx, room) {
  ctx.save();
  // Wall
  ctx.fillStyle = '#241a15';
  ctx.beginPath();
  ctx.moveTo(0, 120); ctx.lineTo(430, 168); ctx.lineTo(430, 620); ctx.lineTo(0, 620); ctx.closePath();
  ctx.fill();
  ctx.fillStyle = 'rgba(90,64,40,0.35)';
  for (let y = 180; y < 610; y += 26) ctx.fillRect(0, y, 430 * ((y - 120) / 500), 3);
  // Roof
  ctx.fillStyle = '#150f0c';
  ctx.beginPath();
  ctx.moveTo(-20, 128); ctx.lineTo(452, 176); ctx.lineTo(452, 202); ctx.lineTo(-20, 154); ctx.closePath();
  ctx.fill();
  // Window, the only warm thing in the frame
  const wx = 210, wy = 300, ww = 130, wh = 110;
  ctx.fillStyle = '#0d0906';
  ctx.fillRect(wx - 8, wy - 8, ww + 16, wh + 16);
  const wg = ctx.createLinearGradient(0, wy, 0, wy + wh);
  wg.addColorStop(0, '#ffd48a');
  wg.addColorStop(1, '#e0892f');
  ctx.fillStyle = wg;
  ctx.fillRect(wx, wy, ww, wh);
  ctx.fillStyle = '#0d0906';
  ctx.fillRect(wx + ww / 2 - 3, wy, 6, wh);
  ctx.fillRect(wx, wy + wh / 2 - 3, ww, 6);
  const glow = ctx.createRadialGradient(wx + ww / 2, wy + wh / 2, 10, wx + ww / 2, wy + wh / 2, 300);
  glow.addColorStop(0, 'rgba(255,186,96,0.30)');
  glow.addColorStop(1, 'rgba(255,186,96,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(wx - 300, wy - 300, 600, 600);
  // Door
  ctx.fillStyle = '#120c09';
  ctx.fillRect(60, 380, 104, 240);
  ctx.fillStyle = '#2e2118';
  ctx.fillRect(66, 386, 92, 234);
  // Hanging sign
  ctx.strokeStyle = '#0f0a07'; ctx.lineWidth = 4;
  ctx.beginPath(); ctx.moveTo(300, 210); ctx.lineTo(300, 240); ctx.stroke();
  ctx.fillStyle = '#3a2a1c';
  ctx.fillRect(232, 240, 136, 62);
  ctx.strokeStyle = '#6b5334'; ctx.lineWidth = 3;
  ctx.strokeRect(232, 240, 136, 62);
  ctx.fillStyle = '#c9a86a';
  ctx.font = 'italic 25px Georgia, serif';
  ctx.textAlign = 'center';
  ctx.fillText('THE BILGE', 300, 279);
  ctx.restore();
}

// --- props (occluders and hotspot art) --------------------------------------

export function paintBarrel(ctx) {
  ctx.save();
  ctx.translate(560, 660);
  ctx.fillStyle = 'rgba(0,0,0,0.34)';
  ctx.beginPath(); ctx.ellipse(0, 4, 46, 11, 0, 0, Math.PI * 2); ctx.fill();
  const g = ctx.createLinearGradient(-44, 0, 44, 0);
  g.addColorStop(0, '#2c1d12'); g.addColorStop(0.42, '#6b4527'); g.addColorStop(1, '#33220f');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(-36, 0); ctx.quadraticCurveTo(-48, -60, -34, -118);
  ctx.lineTo(34, -118); ctx.quadraticCurveTo(48, -60, 36, 0);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#20160e';
  for (const y of [-14, -60, -106]) ctx.fillRect(-46, y, 92, 8);
  ctx.fillStyle = '#4a3220';
  ctx.beginPath(); ctx.ellipse(0, -118, 34, 9, 0, 0, Math.PI * 2); ctx.fill();
  // Spigot — the thing the puzzle actually turns on.
  ctx.fillStyle = '#2a2a2e';
  ctx.fillRect(30, -46, 22, 8);
  ctx.fillRect(46, -52, 7, 20);
  ctx.restore();
}

export function paintCrates(ctx) {
  ctx.save();
  ctx.translate(880, 700);
  ctx.fillStyle = 'rgba(0,0,0,0.34)';
  ctx.beginPath(); ctx.ellipse(0, 4, 74, 13, 0, 0, Math.PI * 2); ctx.fill();
  const crate = (x, y, w, h, tone) => {
    ctx.fillStyle = tone;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = 'rgba(20,13,8,0.75)'; ctx.lineWidth = 3;
    ctx.strokeRect(x, y, w, h);
    ctx.beginPath();
    ctx.moveTo(x, y); ctx.lineTo(x + w, y + h); ctx.moveTo(x + w, y); ctx.lineTo(x, y + h);
    ctx.stroke();
  };
  crate(-70, -78, 74, 78, '#5c3f26');
  crate(2, -66, 64, 66, '#4a3220');
  crate(-46, -140, 62, 62, '#6b4a2c');
  ctx.restore();
}

export function paintNets(ctx) {
  ctx.save();
  ctx.translate(1120, 690);
  // A solid mound under the strands. Without it the pile's silhouette is a few
  // thin lines, which forces the matte to be dilated to find it — and a dilated
  // matte drags in a halo of the grey backing. Give the object a real shape and
  // the cut is clean.
  const mound = ctx.createLinearGradient(0, -78, 0, 8);
  mound.addColorStop(0, '#2a2820');
  mound.addColorStop(1, '#14120d');
  ctx.fillStyle = mound;
  ctx.beginPath();
  ctx.moveTo(-104, 6);
  ctx.bezierCurveTo(-96, -54, -48, -78, -8, -70);
  ctx.bezierCurveTo(34, -80, 88, -52, 100, 6);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = 'rgba(52,48,36,0.9)';
  ctx.lineWidth = 3;
  const r = rng(11);
  for (let i = 0; i < 34; i++) {
    ctx.beginPath();
    const x = (r() - 0.5) * 190, y = -r() * 74;
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(x + (r() - 0.5) * 90, y - 30 - r() * 40, x + (r() - 0.5) * 170, y + 8);
    ctx.stroke();
  }
  ctx.fillStyle = '#2a2019';
  ctx.beginPath(); ctx.ellipse(0, 2, 96, 18, 0, 0, Math.PI * 2); ctx.fill();
  // The boat hook, poking out of the pile.
  ctx.save();
  ctx.rotate(-0.34);
  ctx.fillStyle = '#4e3a24';
  ctx.fillRect(-10, -104, 11, 112);
  ctx.fillStyle = '#7c7f88';
  ctx.beginPath();
  ctx.moveTo(-5, -104); ctx.quadraticCurveTo(30, -116, 22, -84);
  ctx.quadraticCurveTo(18, -96, -4, -92); ctx.closePath();
  ctx.fill();
  ctx.restore();
  ctx.restore();
}

export function paintPilings(ctx, room) {
  ctx.save();
  for (const [x, h] of [[470, 150], [760, 132], [1040, 158], [1330, 140], [1620, 150]]) {
    ctx.fillStyle = '#1a120c';
    ctx.fillRect(x, 596 - h, 30, h + 40);
    ctx.fillStyle = 'rgba(120,96,66,0.28)';
    ctx.fillRect(x + 4, 596 - h, 7, h);
    ctx.fillStyle = 'rgba(90,120,90,0.30)';
    ctx.fillRect(x, 596 - 16, 30, 18);
  }
  ctx.restore();
}

// The cup on its nail: hotspot art that changes with the puzzle, so the room
// shows its own state instead of announcing it in a line of dialogue.
export function paintCup(ctx, room, taken) {
  if (taken) return;
  ctx.save();
  ctx.translate(408, 452);
  ctx.fillStyle = '#8d8f96';
  ctx.fillRect(-3, -14, 5, 14);
  ctx.fillStyle = '#b9a06a';
  ctx.beginPath();
  ctx.moveTo(-13, 0); ctx.lineTo(13, 0); ctx.lineTo(10, 30); ctx.lineTo(-10, 30); ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#7d6738'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(15, 14, 9, -1.2, 1.2); ctx.stroke();
  ctx.fillStyle = 'rgba(255,222,160,0.5)';
  ctx.fillRect(-10, 2, 4, 24);
  ctx.restore();
}

// --- actors -----------------------------------------------------------------

// One cartoon-proportioned body, parameterised. Big head, small hips, wide
// shoulders — the CMI silhouette. Origin is between the feet at (0,0).
//
// The figure is ~165px tall in a 720px frame, which makes the head about 35px
// across. That number decides the whole approach. At 35px a painted head is a
// coloured blob and a drawn one still has eyes, a brow and a jaw — so this
// stays vector on purpose, and everything spent on it goes into readability
// and motion rather than texture. Cel characters over painted backgrounds is
// what the era actually did, and for this reason.
//
// What sells the walk is not the leg positions, it is the weight: the pelvis
// drops onto the supporting leg, the chest counter-rotates against the hips,
// the body falls and catches twice per stride, and the cloth arrives late.
// Take those four out and you have a pair of scissors walking.

const MOONLIGHT = 'rgba(186,206,255,';
const LAMPLIGHT = 'rgba(255,168,92,';
const TAU = Math.PI * 2;

// Two-bone IK. Given a hip and a foot it finds the knee, which is the whole
// difference between a leg that bends and a leg that swings from the hip like
// a pendulum.
//
// `bend` picks which side of the hip-to-ankle line the joint falls on, and
// getting it backwards is not subtle — it is an ostrich. The sign is stated
// here once because it has been flipped in error twice:
//
//   canvas +y is DOWN, and the limb runs downward, so the base angle is near
//   +PI/2. bend = -1 then puts the joint at +x, which after ctx.scale(flip,1)
//   is the direction the character faces.
//
//   KNEE_FORWARD = -1   a knee points the way you are walking
//   ELBOW_BACK   = +1   an elbow points the other way
//
// tools/check-rig.mjs asserts both, so a third flip fails a check instead of
// shipping.
export const KNEE_FORWARD = -1;
export const ELBOW_BACK = 1;

export function joint(ax, ay, bx, by, l1, l2, bend) {
  const dx = bx - ax, dy = by - ay;
  const d = Math.min(Math.hypot(dx, dy), l1 + l2 - 0.0001) || 0.0001;
  const base = Math.atan2(dy, dx);
  const cos = Math.max(-1, Math.min(1, (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d)));
  const a = base + Math.acos(cos) * bend;
  return { x: ax + Math.cos(a) * l1, y: ay + Math.sin(a) * l1 };
}

export function makePerson(spec) {
  // A line the colour of the scene's shadows rather than black. Ink reads as a
  // cartoon sticker on a painted plate; a deep blue-brown reads as drawn.
  const INK = spec.ink || 'rgba(28,20,26,0.62)';

  return function drawPerson(ctx, actor) {
    const H = spec.height;
    const walking = actor.state === 'walk';
    const p = actor.phase * TAU;
    const flip = actor.facing === 'left' ? -1 : 1;
    const away = actor.facing === 'back';
    const lx = flip;                       // keeps the moon on the moon's side
    const lag = actor.lag || 0;            // cloth, arriving late
    const breath = Math.sin(actor.phase * 1.7);

    // The body drops onto each landing foot and rises through the passing
    // stride — twice per cycle. It was inverted before (highest at contact),
    // and it was applied with ctx.translate, which moved the FEET with it, so
    // they lifted off the ground on every step instead of staying planted.
    // The drop now moves the pelvis and everything hanging off it; the feet
    // are in ground space and stay there.
    const drop = walking ? Math.abs(Math.cos(p)) * H * 0.022 : -breath * H * 0.006;
    const sway = walking ? Math.sin(p) * H * 0.010 : 0;
    const hipTilt = walking ? Math.sin(p) * 0.13 : breath * 0.012;
    const chestTwist = walking ? -Math.sin(p) * 0.075 : -breath * 0.010;

    const hipY = -H * 0.42 + drop, shoY = -H * 0.72 + drop, headY = -H * 0.86 + drop;
    // Leg length is set from the standing pose, not guessed. Standing, the hip
    // is 0.40H above the ankle; at 0.416H of reach that is 96% extension, which
    // leaves a permanent ~10px kink in both legs — and a leg that never
    // straightens reads as a knee bent the wrong way rather than as a knee.
    // At 0.402H it stands at 99.7% and the kink disappears.
    const THIGH = H * 0.201, SHIN = H * 0.201;
    const UPPER = H * 0.150, FORE = H * 0.150;

    const shade = (hex, k) => {
      const n = parseInt(hex.slice(1), 16);
      const f = (v) => Math.max(0, Math.min(255, Math.round(v * k)));
      return `rgb(${f((n >> 16) & 255)},${f((n >> 8) & 255)},${f(n & 255)})`;
    };
    const lit = (base, y0, y1, hi = 1.20, lo = 0.60) => {
      const g = ctx.createLinearGradient(lx * H * 0.09, y0, -lx * H * 0.10, y1);
      g.addColorStop(0, shade(base, hi));
      g.addColorStop(1, shade(base, lo));
      return g;
    };

    // A limb segment: outline first at a wider stroke, colour over it. Two
    // strokes rather than a path with a border, which keeps the joins clean
    // where segments meet.
    const bone = (x0, y0, x1, y1, w, paint) => {
      ctx.lineCap = 'round';
      ctx.strokeStyle = INK;
      ctx.lineWidth = w + H * 0.016;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      ctx.strokeStyle = paint;
      ctx.lineWidth = w;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    };

    ctx.save();
    ctx.scale(flip, 1);

    // Debug record of the pose, in local (pre-mirror) space. tools/pose.mjs
    // draws it; nothing else reads it.
    const rig = { flip, legs: [], arms: [] };
    actor.rig = rig;

    // --- feet, in world-ish space before the body offset -------------------
    // The foot is planted for half the cycle and swings for the other half,
    // and it stays on the ground while planted. A foot that slides is the
    // single most obvious tell of a bad walk cycle.
    //
    // Stride follows from leg length rather than taste: at the contact pose the
    // hip has dropped, so the hip-to-ankle distance is sqrt(stride^2 + (0.40H -
    // drop)^2), and that has to stay inside the leg's reach or the IK clamps
    // and the foot slides out from under the body.
    const stride = H * 0.128, lift = H * 0.072;
    const footOf = (ph) => {
      const c = Math.cos(ph);
      const swing = Math.sin(ph) > 0;
      return {
        x: sway + c * stride,
        y: swing ? -Math.sin(ph) * lift : 0,
        planted: !swing,
      };
    };
    const feet = walking
      ? [footOf(p), footOf(p + Math.PI)]
      : [{ x: -H * 0.045, y: 0 }, { x: H * 0.050, y: 0 }];

    // Contact shadow, pooled under whichever foot is down.
    ctx.save();
    const sh = ctx.createRadialGradient(sway * 0.5, 0, H * 0.015, sway * 0.5, 0, H * 0.24);
    sh.addColorStop(0, 'rgba(0,0,0,0.42)');
    sh.addColorStop(0.55, 'rgba(0,0,0,0.15)');
    sh.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = sh;
    ctx.scale(1, 0.20);
    ctx.beginPath(); ctx.arc(sway * 0.5, 0, H * 0.24, 0, TAU); ctx.fill();
    ctx.restore();

    // --- pelvis and chest ---------------------------------------------------
    const hipAt = (side) => ({
      x: sway + side * H * 0.048 * Math.cos(hipTilt),
      y: hipY + side * H * 0.048 * Math.sin(hipTilt),
    });
    const shoAt = (side) => ({
      x: sway * 0.4 + side * H * 0.115 * Math.cos(chestTwist),
      y: shoY + side * H * 0.115 * Math.sin(chestTwist),
    });

    // --- legs ---------------------------------------------------------------
    // Back leg first so the near leg overlaps it: with both legs the same
    // colour, that overlap is the only depth cue there is.
    const legOrder = walking && Math.sin(p) > 0 ? [1, 0] : [0, 1];
    for (const i of legOrder) {
      const back = i === legOrder[0];
      const hip = hipAt(i === 0 ? -1 : 1);
      const foot = feet[i];
      const ankle = { x: foot.x, y: -H * 0.020 + foot.y };
      const knee = joint(hip.x, hip.y, ankle.x, ankle.y, THIGH, SHIN, KNEE_FORWARD);
      rig.legs.push({ hip: { ...hip }, knee: { ...knee }, ankle: { ...ankle } });
      const tone = back ? 0.72 : 1;
      bone(hip.x, hip.y, knee.x, knee.y, H * 0.078,
        lit(spec.legs, hipY, 0, 1.18 * tone, 0.62 * tone));
      bone(knee.x, knee.y, ankle.x, ankle.y, H * 0.066,
        lit(spec.legs, hipY * 0.5, 0, 1.05 * tone, 0.55 * tone));
      // boot, tipped as the foot swings through
      ctx.save();
      ctx.translate(ankle.x, ankle.y);
      ctx.rotate(foot.planted === false ? -0.35 * Math.cos(p + (i ? Math.PI : 0)) : 0.05);
      ctx.fillStyle = INK;
      ctx.beginPath(); ctx.ellipse(H * 0.016, H * 0.014, H * 0.062, H * 0.037, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = lit(spec.boots, -H * 0.05, H * 0.02, 1.5 * tone, 0.9 * tone);
      ctx.beginPath(); ctx.ellipse(H * 0.016, H * 0.012, H * 0.054, H * 0.029, 0, 0, TAU); ctx.fill();
      ctx.restore();
    }

    // --- far arm ------------------------------------------------------------
    const armAt = (side, dim) => {
      const sh0 = shoAt(side);
      const phase = p + (side > 0 ? Math.PI : 0);
      const reach = walking ? Math.cos(phase) : 0;
      const hand = {
        x: sway * 0.5 + reach * H * 0.105 + side * H * 0.055,
        y: hipY + H * 0.075 - Math.abs(reach) * H * 0.012 + (walking ? 0 : breath * H * 0.006),
      };
      const el = joint(sh0.x, sh0.y, hand.x, hand.y, UPPER, FORE, ELBOW_BACK);
      rig.arms.push({ shoulder: { ...sh0 }, elbow: { ...el }, hand: { ...hand } });
      // An arm the same colour as the coat in front of it is invisible. The far
      // arm goes into shadow, the near one comes up a stop — the only two
      // things separating them are value and the outline.
      const k = dim ? 0.55 : 1.12;
      bone(sh0.x, sh0.y, el.x, el.y, H * 0.058, lit(spec.coat, shoY, hipY, 1.14 * k, 0.58 * k));
      bone(el.x, el.y, hand.x, hand.y, H * 0.050, lit(spec.coat, shoY, hipY, 1.06 * k, 0.54 * k));
      const cuffA = Math.atan2(hand.y - el.y, hand.x - el.x);
      ctx.save();
      ctx.translate(hand.x - Math.cos(cuffA) * H * 0.028, hand.y - Math.sin(cuffA) * H * 0.028);
      ctx.rotate(cuffA);
      ctx.fillStyle = INK;
      ctx.fillRect(-H * 0.016, -H * 0.034, H * 0.032, H * 0.068);
      ctx.fillStyle = lit(spec.shirt || spec.skin, 0, H * 0.05, 1.0 * k, 0.66 * k);
      ctx.fillRect(-H * 0.011, -H * 0.029, H * 0.022, H * 0.058);
      ctx.restore();
      ctx.fillStyle = INK;
      ctx.beginPath(); ctx.arc(hand.x, hand.y, H * 0.038, 0, TAU); ctx.fill();
      ctx.fillStyle = lit(spec.skin, hipY, hipY + H * 0.1, 1.10 * k, 0.74 * k);
      ctx.beginPath(); ctx.arc(hand.x, hand.y, H * 0.031, 0, TAU); ctx.fill();
    };
    armAt(-1, true);

    // --- torso --------------------------------------------------------------
    const shL = shoAt(-1), shR = shoAt(1), hpL = hipAt(-1), hpR = hipAt(1);
    const torsoPath = () => {
      ctx.beginPath();
      // Pinched at the waist and flared at the hem: the coat silhouette is
      // doing all the character work at this size.
      ctx.moveTo(hpL.x - H * 0.070 + lag * H * 0.03, hpL.y + H * 0.055);
      ctx.quadraticCurveTo(shL.x - H * 0.014, hipY - H * 0.075, shL.x, shL.y);
      ctx.quadraticCurveTo(0, shL.y - H * 0.026, shR.x, shR.y);
      ctx.quadraticCurveTo(shR.x + H * 0.014, hipY - H * 0.075, hpR.x + H * 0.070 + lag * H * 0.05, hpR.y + H * 0.055);
      ctx.quadraticCurveTo(0, hipY + H * 0.095, hpL.x - H * 0.070 + lag * H * 0.03, hpL.y + H * 0.055);
      ctx.closePath();
    };
    ctx.strokeStyle = INK;
    ctx.lineWidth = H * 0.016;
    ctx.lineJoin = 'round';
    torsoPath(); ctx.stroke();
    ctx.fillStyle = lit(spec.coat, shoY, hipY, 1.22, 0.58);
    torsoPath(); ctx.fill();

    if (spec.shirt) {
      // A collar and a strip of shirt where the coat is open, not a bib. At
      // 35px a big pale rectangle on the chest is the only thing you see.
      const shirtBot = shoY + H * 0.125;
      ctx.fillStyle = lit(spec.shirt, shoY, shirtBot, 0.94, 0.62);
      ctx.beginPath();
      ctx.moveTo(-H * 0.032, shL.y + H * 0.012);
      ctx.lineTo(H * 0.032, shR.y + H * 0.012);
      ctx.lineTo(0, shirtBot);
      ctx.closePath(); ctx.fill();
      // the coat's open edges, closing under the collar
      ctx.strokeStyle = 'rgba(24,16,20,0.45)';
      ctx.lineWidth = H * 0.010;
      ctx.beginPath();
      ctx.moveTo(-H * 0.032, shL.y + H * 0.012); ctx.lineTo(0, shirtBot);
      ctx.moveTo(H * 0.032, shR.y + H * 0.012); ctx.lineTo(0, shirtBot);
      ctx.stroke();
    }
    if (spec.sash) {
      ctx.save();
      ctx.translate(sway, hipY);
      ctx.rotate(hipTilt * 0.6);
      ctx.fillStyle = INK;
      ctx.fillRect(-H * 0.092, -H * 0.017, H * 0.184, H * 0.038);
      ctx.fillStyle = lit(spec.sash, hipY - H * 0.02, hipY + H * 0.02, 0.98, 0.54);
      ctx.fillRect(-H * 0.088, -H * 0.013, H * 0.176, H * 0.030);
      ctx.fillStyle = lit(spec.sash, hipY - H * 0.02, hipY + H * 0.02, 1.35, 0.85);
      ctx.fillRect(-H * 0.014, -H * 0.017, H * 0.028, H * 0.038);
      ctx.beginPath();
      ctx.moveTo(-H * 0.112, -H * 0.010);
      ctx.quadraticCurveTo(-H * 0.158 + lag * H * 0.05, H * 0.062, -H * 0.118 + lag * H * 0.09, H * 0.125);
      ctx.lineTo(-H * 0.082 + lag * H * 0.07, H * 0.108);
      ctx.quadraticCurveTo(-H * 0.112, H * 0.046, -H * 0.072, -H * 0.006);
      ctx.closePath(); ctx.fill();
      ctx.restore();
    }

    // The shadow the chest throws onto the belly. One ellipse, and the torso
    // stops being a flat shield.
    ctx.save();
    torsoPath(); ctx.clip();
    const ao = ctx.createLinearGradient(0, shoY, 0, hipY);
    ao.addColorStop(0, 'rgba(20,14,22,0.30)');
    ao.addColorStop(0.45, 'rgba(20,14,22,0)');
    ctx.fillStyle = ao;
    ctx.fillRect(-H * 0.2, shoY - H * 0.05, H * 0.4, H * 0.4);
    ctx.restore();

    // --- near arm -----------------------------------------------------------
    armAt(1, false);

    // --- head ---------------------------------------------------------------
    ctx.save();
    // The head leads the body slightly and settles late, which is most of what
    // makes a walk look like a person rather than a mechanism.
    ctx.translate(sway * 0.7 + lag * H * 0.012, headY);
    ctx.rotate(chestTwist * 0.5 + lag * 0.06);
    const talking = actor.line !== null;
    const jaw = talking ? Math.abs(Math.sin(actor.phase * 26)) : 0;
    const rx = H * 0.105, ry = H * 0.115 + jaw * H * 0.012;

    ctx.strokeStyle = INK;
    ctx.lineWidth = H * 0.016;
    ctx.beginPath(); ctx.ellipse(0, 0, rx, ry, 0, 0, TAU); ctx.stroke();
    const hg = ctx.createLinearGradient(lx * rx, -ry, -lx * rx, ry);
    hg.addColorStop(0, shade(spec.skin, 1.12));
    hg.addColorStop(1, shade(spec.skin, 0.72));
    ctx.fillStyle = hg;
    ctx.beginPath(); ctx.ellipse(0, 0, rx, ry, 0, 0, TAU); ctx.fill();

    if (spec.hair) {
      ctx.fillStyle = lit(spec.hair, -H * 0.10, H * 0.02, 1.25, 0.65);
      ctx.beginPath();
      ctx.ellipse(0, -H * 0.045, H * 0.112, H * 0.072, 0, Math.PI, TAU);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(-H * 0.085 + lag * H * 0.03, H * 0.005 + Math.abs(lag) * H * 0.01,
        H * 0.045, H * 0.075, 0.3 + lag * 0.35, 0, TAU);
      ctx.fill();
    }
    if (!away) {
      const blink = actor.blink < 0 ? 0.15 : 1;
      ctx.fillStyle = '#fff';
      for (const ex of [H * 0.012, H * 0.058]) {
        ctx.beginPath(); ctx.ellipse(ex, -H * 0.012, H * 0.021, H * 0.024 * blink, 0, 0, TAU); ctx.fill();
      }
      ctx.fillStyle = '#181008';
      for (const ex of [H * 0.018, H * 0.062]) {
        ctx.beginPath(); ctx.ellipse(ex, -H * 0.012, H * 0.010, H * 0.014 * blink, 0, 0, TAU); ctx.fill();
      }
      ctx.strokeStyle = '#241608';
      ctx.lineWidth = H * 0.010;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(0, -H * 0.045); ctx.lineTo(H * 0.032, -H * 0.050);
      ctx.moveTo(H * 0.050, -H * 0.050); ctx.lineTo(H * 0.080, -H * 0.043);
      ctx.stroke();
      ctx.fillStyle = shade(spec.skin2 || spec.skin, 0.94);
      ctx.beginPath(); ctx.ellipse(H * 0.078, H * 0.014, H * 0.026, H * 0.020, 0.4, 0, TAU); ctx.fill();
      ctx.fillStyle = '#3a1a12';
      ctx.beginPath(); ctx.ellipse(H * 0.045, H * 0.058, H * 0.028, H * 0.008 + jaw * H * 0.020, 0, 0, TAU); ctx.fill();
    }
    if (spec.hat) spec.hat(ctx, H, lag);
    if (spec.beard) {
      ctx.fillStyle = lit(spec.beard, 0, H * 0.12, 1.2, 0.7);
      ctx.beginPath(); ctx.ellipse(H * 0.030, H * 0.075, H * 0.080, H * 0.055, 0, 0, TAU); ctx.fill();
    }
    // The moon rim: one cold stroke down the lit side, over everything.
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = MOONLIGHT + '0.45)';
    ctx.lineWidth = H * 0.013;
    ctx.beginPath();
    ctx.ellipse(0, 0, rx * 0.95, ry * 0.95, 0, lx > 0 ? -1.5 : 1.5, lx > 0 ? 0.5 : Math.PI + 1.1, lx < 0);
    ctx.stroke();
    ctx.restore();

    // --- light, filled into the torso's own outline -------------------------
    // A linear gradient clamps to its end colour outside its range, so a
    // fillRect under `lighter` lights the whole rect and the figure wears a
    // glowing box. Fill the shape, not a rectangle around it.
    ctx.globalCompositeOperation = 'lighter';
    const rim = ctx.createLinearGradient(lx * H * 0.15, shoY, -lx * H * 0.04, hipY + H * 0.04);
    rim.addColorStop(0, MOONLIGHT + '0.24)');
    rim.addColorStop(0.55, MOONLIGHT + '0.04)');
    rim.addColorStop(1, MOONLIGHT + '0)');
    ctx.fillStyle = rim; torsoPath(); ctx.fill();
    const bounce = ctx.createLinearGradient(0, hipY - H * 0.02, 0, hipY + H * 0.07);
    bounce.addColorStop(0, LAMPLIGHT + '0)');
    bounce.addColorStop(1, LAMPLIGHT + '0.15)');
    ctx.fillStyle = bounce; torsoPath(); ctx.fill();

    ctx.restore();
  };
}

export const TRICORN = (ctx, H) => {
  ctx.fillStyle = '#2b1d13';
  ctx.beginPath();
  ctx.moveTo(-H * 0.15, -H * 0.075);
  ctx.quadraticCurveTo(0, -H * 0.135, H * 0.15, -H * 0.075);
  ctx.quadraticCurveTo(H * 0.06, -H * 0.055, 0, -H * 0.058);
  ctx.quadraticCurveTo(-H * 0.06, -H * 0.055, -H * 0.15, -H * 0.075);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(0, -H * 0.088, H * 0.085, H * 0.055, 0, Math.PI, Math.PI * 2);
  ctx.fill();
};

export const BANDANA = (ctx, H, lag = 0) => {
  ctx.fillStyle = '#a8332e';
  ctx.beginPath();
  ctx.ellipse(0, -H * 0.058, H * 0.112, H * 0.055, 0, Math.PI, Math.PI * 2);
  ctx.fill();
  ctx.fillRect(-H * 0.112, -H * 0.062, H * 0.224, H * 0.022);
  ctx.beginPath();
  ctx.moveTo(-H * 0.105, -H * 0.050);
  ctx.quadraticCurveTo(-H * 0.150 + lag * H * 0.05, -H * 0.030 + lag * H * 0.02,
    -H * 0.165 + lag * H * 0.10, -H * 0.005 + Math.abs(lag) * H * 0.02);
  ctx.lineTo(-H * 0.100, -H * 0.020);
  ctx.fill();
};

// --- inventory icons --------------------------------------------------------

export const ICONS = {
  boathook: (ctx) => {
    ctx.rotate(-0.5);
    ctx.fillStyle = '#4e3a24'; ctx.fillRect(-3, -22, 6, 44);
    ctx.fillStyle = '#9aa0aa';
    ctx.beginPath();
    ctx.moveTo(0, -22); ctx.quadraticCurveTo(17, -30, 12, -12);
    ctx.quadraticCurveTo(9, -22, -1, -18); ctx.closePath(); ctx.fill();
  },
  cup: (ctx) => {
    ctx.fillStyle = '#b9a06a';
    ctx.beginPath();
    ctx.moveTo(-13, -14); ctx.lineTo(13, -14); ctx.lineTo(10, 17); ctx.lineTo(-10, 17); ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#7d6738'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(15, 0, 9, -1.2, 1.2); ctx.stroke();
  },
  'cup-of-grog': (ctx) => {
    ICONS.cup(ctx);
    ctx.fillStyle = '#c8752a';
    ctx.beginPath();
    ctx.ellipse(0, -12, 12, 4, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(255,236,190,0.75)';
    ctx.beginPath(); ctx.ellipse(-4, -13, 4, 2, 0, 0, Math.PI * 2); ctx.fill();
  },
};

// --- the galley -------------------------------------------------------------

// A smoked herring on a floor. Generated art would be the house style, but
// this exists for about ninety seconds of one puzzle and is a fish seen from
// above, which a canvas path can manage without spending a credit.
export function paintKipper(ctx) {
  ctx.save();
  ctx.rotate(-0.12);
  ctx.fillStyle = '#8a6a3f';
  ctx.beginPath();
  ctx.moveTo(-44, 0);
  ctx.quadraticCurveTo(-14, -16, 26, -11);
  ctx.lineTo(44, -18); ctx.lineTo(40, 0); ctx.lineTo(44, 18);
  ctx.lineTo(26, 11);
  ctx.quadraticCurveTo(-14, 16, -44, 0);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#a8834f';
  ctx.beginPath(); ctx.ellipse(-8, -3, 26, 5, -0.06, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#5c452a'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(-44, 0); ctx.quadraticCurveTo(-14, -16, 26, -11); ctx.stroke();
  ctx.fillStyle = '#241811';
  ctx.beginPath(); ctx.arc(-34, -3, 2.6, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

// The stand-in for the ship's cat, for the case where its atlas does not load.
// Drawn at the actor's own scale, origin between its feet.
export function paintCatPuppet(ctx, actor, scale) {
  const h = (actor.height || 60);
  ctx.save();
  ctx.scale(h / 60, h / 60);
  ctx.fillStyle = '#c8792f';
  ctx.beginPath(); ctx.ellipse(0, -22, 26, 15, 0, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(24, -34, 12, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.moveTo(17, -44); ctx.lineTo(20, -56); ctx.lineTo(27, -46); ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.moveTo(29, -46); ctx.lineTo(34, -56); ctx.lineTo(36, -44); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = '#c8792f'; ctx.lineWidth = 6; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(-24, -24); ctx.quadraticCurveTo(-44, -30, -38, -50); ctx.stroke();
  ctx.fillStyle = '#c8792f';
  for (const x of [-10, 12]) { ctx.fillRect(x, -10, 7, 10); }
  ctx.fillStyle = '#241811';
  ctx.beginPath(); ctx.arc(28, -36, 2, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

// The galley's three. Written here rather than in the room because an icon is
// art, and because the strip draws from one table however many rooms there are.
ICONS.pepper = (ctx) => {
  ctx.fillStyle = '#b9b2a4';
  ctx.beginPath();
  ctx.moveTo(-10, -8); ctx.lineTo(10, -8); ctx.lineTo(8, 18); ctx.lineTo(-8, 18);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#8f887a';
  ctx.beginPath(); ctx.ellipse(0, -9, 10, 4, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#3a352d';
  for (const [x, y] of [[-4, -11], [0, -12], [4, -11], [-2, -9], [2, -9]]) {
    ctx.beginPath(); ctx.arc(x, y, 1.2, 0, Math.PI * 2); ctx.fill();
  }
};

ICONS['loaded-bellows'] = (ctx) => {
  ctx.fillStyle = '#7a4a2c';
  ctx.beginPath();
  ctx.moveTo(-14, 0); ctx.quadraticCurveTo(-4, -15, 12, -9);
  ctx.lineTo(12, 9); ctx.quadraticCurveTo(-4, 15, -14, 0);
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = '#4e3a24'; ctx.lineWidth = 3; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(12, -5); ctx.lineTo(21, -3); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(-12, -7); ctx.lineTo(-19, -16); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(-12, 7); ctx.lineTo(-19, 16); ctx.stroke();
  // The pepper, which is the whole point of them.
  ctx.fillStyle = 'rgba(58,53,45,0.85)';
  for (const [x, y] of [[19, -9], [23, -1], [18, 4]]) {
    ctx.beginPath(); ctx.arc(x, y, 1.6, 0, Math.PI * 2); ctx.fill();
  }
};

ICONS.kipper = (ctx) => {
  ctx.save();
  ctx.scale(0.42, 0.42);
  paintKipper(ctx);
  ctx.restore();
};
