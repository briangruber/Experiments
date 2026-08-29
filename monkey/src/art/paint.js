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
  moon: { x: 980, y: 120, r: 46 },
  horizon: 470,
  dockTop: 596,
  // The tavern mass, generously bounded. Clouds are kept out of it; a little
  // slack absorbs the small drift between blockout and repaint.
  tavern: { right: 452, top: 108 },
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
  ctx.strokeStyle = 'rgba(140,124,96,0.62)';
  ctx.lineWidth = 2;
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
// Two things do most of the work of sitting a drawn character inside a painted
// scene, and neither is more detail. The first is light: the scene has a cold
// moon up to the right and a warm window down to the left, so the figure gets
// a cool rim on one side and a warm bounce on the other, and stops looking
// like a sticker. The second is lag — hair, coat-tail and sash trailing a
// frame behind the body — which is what separates a puppet from a rig.
const MOONLIGHT = 'rgba(186,206,255,';
const LAMPLIGHT = 'rgba(255,168,92,';

export function makePerson(spec) {
  return function drawPerson(ctx, actor) {
    const walking = actor.state === 'walk';
    const p = actor.phase * Math.PI * 2;
    const swing = walking ? Math.sin(p) : 0;
    const bob = walking ? Math.abs(Math.cos(p)) * 4 : Math.sin(actor.phase * 1.7) * 1.4;
    const flip = actor.facing === 'left' ? -1 : 1;
    const away = actor.facing === 'back';
    const H = spec.height;
    // After the mirror, local +x is world x*flip. Multiplying by lx keeps the
    // moon on the moon's side of the sky when the character turns around.
    const lx = flip;
    // Trailing cloth. `lag` is smoothed in Actor.update, so it overshoots when
    // the character stops rather than snapping upright.
    const lag = actor.lag || 0;

    ctx.save();
    ctx.scale(flip, 1);
    ctx.translate(0, -bob);

    // Contact shadow, thrown away from the moon and softened at the edge.
    ctx.save();
    ctx.translate(0, bob);
    const sh = ctx.createRadialGradient(-lx * H * 0.03, 0, H * 0.02, -lx * H * 0.03, 0, H * 0.23);
    sh.addColorStop(0, 'rgba(0,0,0,0.40)');
    sh.addColorStop(0.6, 'rgba(0,0,0,0.16)');
    sh.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = sh;
    ctx.save();
    ctx.scale(1, 0.22);
    ctx.beginPath();
    ctx.arc(-lx * H * 0.03, 0, H * 0.23, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.restore();

    const hipY = -H * 0.42, shoY = -H * 0.72, headY = -H * 0.86;

    // A vertical gradient per part: the scene's key is high, so every form is
    // lighter at the top and sinks into its own shadow at the bottom.
    const lit = (c0, c1, y0, y1) => {
      const g = ctx.createLinearGradient(lx * H * 0.08, y0, -lx * H * 0.10, y1);
      g.addColorStop(0, c0);
      g.addColorStop(1, c1);
      return g;
    };
    const shade = (hex, k) => {
      const n = parseInt(hex.slice(1), 16);
      const f = (v) => Math.max(0, Math.min(255, Math.round(v * k)));
      return `rgb(${f((n >> 16) & 255)},${f((n >> 8) & 255)},${f(n & 255)})`;
    };

    const leg = (dir) => {
      ctx.strokeStyle = lit(shade(spec.legs, 1.18), shade(spec.legs, 0.62), hipY, 0);
      ctx.lineWidth = H * 0.075;
      ctx.lineCap = 'round';
      const kx = dir * swing * H * 0.13;
      ctx.beginPath();
      ctx.moveTo(dir * H * 0.045, hipY);
      ctx.quadraticCurveTo(kx * 0.6, hipY * 0.5, kx, -H * 0.035);
      ctx.stroke();
      ctx.fillStyle = lit(shade(spec.boots, 1.5), spec.boots, -H * 0.05, 0);
      ctx.beginPath();
      ctx.ellipse(kx + H * 0.022, -H * 0.022, H * 0.055, H * 0.030, 0, 0, Math.PI * 2);
      ctx.fill();
    };
    leg(-1); leg(1);

    // torso, with the coat hem swung by the lag
    const torsoPath = () => {
      ctx.beginPath();
      ctx.moveTo(-H * 0.115 + lag * H * 0.03, hipY + H * 0.04);
      ctx.quadraticCurveTo(-H * 0.165, shoY + H * 0.06, -H * 0.135, shoY);
      ctx.lineTo(H * 0.135, shoY);
      ctx.quadraticCurveTo(H * 0.165, shoY + H * 0.06, H * 0.115 + lag * H * 0.05, hipY + H * 0.04);
      ctx.closePath();
    };
    ctx.fillStyle = lit(shade(spec.coat, 1.22), shade(spec.coat, 0.58), shoY, hipY);
    torsoPath();
    ctx.fill();
    if (spec.shirt) {
      ctx.fillStyle = lit(shade(spec.shirt, 1.10), shade(spec.shirt, 0.66), shoY, hipY);
      ctx.beginPath();
      ctx.moveTo(-H * 0.045, shoY + H * 0.005);
      ctx.lineTo(H * 0.045, shoY + H * 0.005);
      ctx.lineTo(H * 0.030, hipY + H * 0.02);
      ctx.lineTo(-H * 0.030, hipY + H * 0.02);
      ctx.closePath();
      ctx.fill();
    }
    if (spec.sash) {
      ctx.fillStyle = lit(shade(spec.sash, 1.20), shade(spec.sash, 0.70), hipY - H * 0.02, hipY + H * 0.03);
      ctx.fillRect(-H * 0.125, hipY - H * 0.02, H * 0.25, H * 0.045);
      // the loose end, trailing
      ctx.beginPath();
      ctx.moveTo(-H * 0.115, hipY - H * 0.01);
      ctx.quadraticCurveTo(-H * 0.16 + lag * H * 0.05, hipY + H * 0.07, -H * 0.12 + lag * H * 0.09, hipY + H * 0.13);
      ctx.lineTo(-H * 0.085 + lag * H * 0.07, hipY + H * 0.11);
      ctx.quadraticCurveTo(-H * 0.115, hipY + H * 0.05, -H * 0.075, hipY - H * 0.005);
      ctx.closePath();
      ctx.fill();
    }

    const arm = (dir) => {
      ctx.strokeStyle = lit(shade(spec.coat, 1.14), shade(spec.coat, 0.60), shoY, hipY);
      ctx.lineWidth = H * 0.058;
      ctx.lineCap = 'round';
      const hx = dir * (H * 0.075 - dir * swing * H * 0.10);
      const hy = hipY + H * 0.05;
      ctx.beginPath();
      ctx.moveTo(dir * H * 0.125, shoY + H * 0.025);
      ctx.quadraticCurveTo(dir * H * 0.155, (shoY + hy) / 2, hx, hy);
      ctx.stroke();
      ctx.fillStyle = lit(shade(spec.skin, 1.10), shade(spec.skin, 0.74), hy - H * 0.03, hy + H * 0.03);
      ctx.beginPath(); ctx.arc(hx, hy, H * 0.035, 0, Math.PI * 2); ctx.fill();
    };
    arm(-1); arm(1);

    // head
    ctx.save();
    ctx.translate(0, headY);
    const talking = actor.line !== null;
    const jaw = talking ? Math.abs(Math.sin(actor.phase * 26)) : 0;
    const headR = { rx: H * 0.105, ry: H * 0.115 + jaw * H * 0.012 };
    const hg = ctx.createLinearGradient(lx * headR.rx, -headR.ry, -lx * headR.rx, headR.ry);
    hg.addColorStop(0, shade(spec.skin, 1.12));
    hg.addColorStop(1, shade(spec.skin, 0.72));
    ctx.fillStyle = hg;
    ctx.beginPath();
    ctx.ellipse(0, 0, headR.rx, headR.ry, 0, 0, Math.PI * 2);
    ctx.fill();
    if (spec.hair) {
      ctx.fillStyle = lit(shade(spec.hair, 1.25), shade(spec.hair, 0.65), -H * 0.10, H * 0.02);
      ctx.beginPath();
      ctx.ellipse(0, -H * 0.045, H * 0.112, H * 0.072, 0, Math.PI, Math.PI * 2);
      ctx.fill();
      // the side lock, which lags and gives the head some weight
      ctx.beginPath();
      ctx.ellipse(-H * 0.085 + lag * H * 0.03, H * 0.005 + Math.abs(lag) * H * 0.01,
        H * 0.045, H * 0.075, 0.3 + lag * 0.35, 0, Math.PI * 2);
      ctx.fill();
    }
    if (!away) {
      const blink = actor.blink < 0 ? 0.15 : 1;
      ctx.fillStyle = '#fff';
      for (const ex of [H * 0.012, H * 0.058]) {
        ctx.beginPath();
        ctx.ellipse(ex, -H * 0.012, H * 0.021, H * 0.024 * blink, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = '#181008';
      for (const ex of [H * 0.018, H * 0.062]) {
        ctx.beginPath();
        ctx.ellipse(ex, -H * 0.012, H * 0.010, H * 0.014 * blink, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.strokeStyle = '#241608';
      ctx.lineWidth = H * 0.010;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(H * 0.000, -H * 0.045); ctx.lineTo(H * 0.032, -H * 0.050);
      ctx.moveTo(H * 0.050, -H * 0.050); ctx.lineTo(H * 0.080, -H * 0.043);
      ctx.stroke();
      ctx.fillStyle = shade(spec.skin2 || spec.skin, 0.94);
      ctx.beginPath();
      ctx.ellipse(H * 0.078, H * 0.014, H * 0.026, H * 0.020, 0.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#3a1a12';
      ctx.beginPath();
      ctx.ellipse(H * 0.045, H * 0.058, H * 0.028, H * 0.008 + jaw * H * 0.020, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    if (spec.hat) spec.hat(ctx, H, lag);
    if (spec.beard) {
      ctx.fillStyle = lit(shade(spec.beard, 1.2), shade(spec.beard, 0.7), 0, H * 0.12);
      ctx.beginPath();
      ctx.ellipse(H * 0.030, H * 0.075, H * 0.080, H * 0.055, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    // The moon rim, last, over everything: a thin cold edge down the lit side
    // of the head. One stroke, and the head stops being a flat oval.
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = MOONLIGHT + '0.5)';
    ctx.lineWidth = H * 0.013;
    ctx.beginPath();
    ctx.ellipse(0, 0, headR.rx * 0.97, headR.ry * 0.97, 0, lx > 0 ? -1.5 : 1.5, lx > 0 ? 0.5 : Math.PI + 1.1, lx < 0);
    ctx.stroke();
    ctx.restore();

    // Body rim and the warm bounce off the planks, filled into the torso's own
    // outline rather than a rectangle over it. A linear gradient clamps to its
    // end colour outside its range, so a rect under `lighter` lights the whole
    // rect and the character wears a glowing box.
    ctx.globalCompositeOperation = 'lighter';
    const rim = ctx.createLinearGradient(lx * H * 0.15, shoY, -lx * H * 0.04, hipY + H * 0.04);
    rim.addColorStop(0, MOONLIGHT + '0.26)');
    rim.addColorStop(0.55, MOONLIGHT + '0.05)');
    rim.addColorStop(1, MOONLIGHT + '0)');
    ctx.fillStyle = rim;
    torsoPath();
    ctx.fill();

    const bounce = ctx.createLinearGradient(0, hipY - H * 0.02, 0, hipY + H * 0.06);
    bounce.addColorStop(0, LAMPLIGHT + '0)');
    bounce.addColorStop(1, LAMPLIGHT + '0.16)');
    ctx.fillStyle = bounce;
    torsoPath();
    ctx.fill();

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
