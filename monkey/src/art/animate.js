// The layers that move.
//
// A generated backdrop is one flat image, and a flat image is the thing that
// most gives away a 2D scene as a picture rather than a place. The fix is not
// to generate an animated backdrop — nothing does that usefully at this size —
// it is to cut the still one back into layers and move them.
//
// Cutting it apart is free here for the same reason the repaint held its
// composition: the blockout put the horizon and the dock line at known
// coordinates and the plate was instructed to keep them there, so SCENE
// already describes where each band of the painting is. No matte pass, no
// segmentation model — the geometry was never lost, only painted over.
//
// Three moving layers, in the order they read to the eye:
//
//   clouds   drift across the sky at two depths, lit from the moon
//   water    the sea band redrawn in strips with a swell, plus moon glitter
//   lamps    the tavern window flickers like a room with a fire in it
//
// Everything is pre-rendered to offscreen canvases once and blitted after
// that, so the per-frame cost is a few dozen drawImage calls rather than a few
// hundred gradients.

import { SCENE, rng } from './paint.js';

const { moon: MOON, horizon: HORIZON, dockTop: DOCK_TOP, tavern: TAVERN } = SCENE;

// --- clouds -----------------------------------------------------------------

// One cloud, painted once into its own canvas. Built from overlapping lobes
// with a moon-side rim and a heavy underside, which is what separates a cloud
// from a grey smudge: clouds are lit hard from one side and almost black
// underneath, and the eye reads that long before it reads the silhouette.
function cloudSprite(seed, w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const r = rng(seed);
  const lobes = [];
  const n = 7 + Math.floor(r() * 5);
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1);
    // Wide and flat, with the mass pushed off-centre and the ends torn into
    // wisps. Evenly sized lobes on an arc give the bubbly cartoon cloud; the
    // width variance and the low, stretched ends are what read as weather.
    const taper = Math.sin(Math.PI * Math.min(1, Math.max(0, (u - 0.05) / 0.9)));
    lobes.push({
      x: w * (0.08 + u * 0.84) + (r() - 0.5) * w * 0.06,
      y: h * (0.62 - taper * 0.22) + (r() - 0.5) * h * 0.09,
      rx: w * (0.09 + r() * 0.09) * (0.55 + taper * 0.75),
      ry: h * (0.10 + r() * 0.13) * (0.45 + taper * 0.80),
    });
  }
  // Underside first, then body, then the lit rim — the same order a brush
  // would take, and it keeps the rim from being swallowed.
  for (const pass of ['under', 'body', 'rim']) {
    for (const l of lobes) {
      ctx.save();
      if (pass === 'under') {
        ctx.globalAlpha = 0.11;
        ctx.fillStyle = '#141d36';
        ctx.beginPath();
        ctx.ellipse(l.x, l.y + l.ry * 0.30, l.rx * 1.06, l.ry * 0.82, 0, 0, Math.PI * 2);
      } else if (pass === 'body') {
        // Kept blue-grey and low-contrast. A night cloud is barely lighter
        // than the sky behind it; painting it as a pale mass is what makes a
        // sky look like a children's book.
        const g = ctx.createRadialGradient(l.x + l.rx * 0.3, l.y - l.ry * 0.4, l.rx * 0.1, l.x, l.y, l.rx * 1.35);
        g.addColorStop(0, 'rgba(126,140,178,0.34)');
        g.addColorStop(0.5, 'rgba(84,98,140,0.22)');
        g.addColorStop(1, 'rgba(44,54,86,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.ellipse(l.x, l.y, l.rx, l.ry, 0, 0, Math.PI * 2);
      } else {
        // The moon rim, deliberately weak and pulled toward the sky's own hue.
        // Warm light added over a blue ground in `lighter` goes mint long
        // before it goes silver, so the rim is barely warm and barely there.
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.085;
        const g = ctx.createRadialGradient(l.x + l.rx * 0.40, l.y - l.ry * 0.50, 1, l.x + l.rx * 0.40, l.y - l.ry * 0.50, l.rx * 0.95);
        g.addColorStop(0, 'rgba(226,226,236,0.9)');
        g.addColorStop(1, 'rgba(226,226,236,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.ellipse(l.x + l.rx * 0.20, l.y - l.ry * 0.26, l.rx * 0.80, l.ry * 0.64, 0, 0, Math.PI * 2);
      }
      ctx.fill();
      ctx.restore();
    }
  }
  return c;
}

export function makeClouds(seed = 91) {
  const r = rng(seed);
  // Two depths. The far band is smaller, dimmer and slower; that difference is
  // the whole of the parallax, and it is what stops the sky reading as one
  // sheet of wallpaper sliding past.
  // Big, flat and faint. A night cloud that reads clearly at a glance is
  // already too strong: it should be something you notice has moved, not
  // something you look at.
  const bands = [
    { count: 3, y: [40, 140], w: [460, 760], h: [52, 82], speed: 2.0, alpha: 0.22 },
    { count: 3, y: [110, 250], w: [620, 980], h: [70, 108], speed: 4.6, alpha: 0.30 },
  ];
  const clouds = [];
  let s = seed;
  for (const b of bands) {
    for (let i = 0; i < b.count; i++) {
      const w = b.w[0] + r() * (b.w[1] - b.w[0]);
      const h = b.h[0] + r() * (b.h[1] - b.h[0]);
      clouds.push({
        sprite: cloudSprite((s += 7919), Math.round(w), Math.round(h)),
        x: r(), y: b.y[0] + r() * (b.y[1] - b.y[0]),
        w, h, speed: b.speed * (0.8 + r() * 0.4), alpha: b.alpha * (0.7 + r() * 0.5),
      });
    }
  }

  const stars = [];
  for (let i = 0; i < 90; i++) {
    stars.push({ x: r(), y: r() * 300, phase: r() * 6.28, rate: 0.6 + r() * 1.8, a: 0.25 + r() * 0.6 });
  }

  return function paintClouds(ctx, room) {
    const t = room.time;
    ctx.save();
    // Keep the sky out of the building. The plate's tavern is opaque and drawn
    // underneath, so a cloud crossing it would be a cloud inside a wall.
    // The whole sky. The tavern is drawn after this layer, so a cloud crossing
    // it is simply covered — no mask needed, and a cloud genuinely passes
    // behind the building instead of stopping at its edge.
    ctx.beginPath();
    ctx.rect(0, 0, room.width, HORIZON);
    ctx.clip();

    for (const s of stars) {
      const tw = 0.55 + 0.45 * Math.sin(t * s.rate + s.phase);
      ctx.globalAlpha = s.a * tw * 0.5;
      ctx.fillStyle = '#fff8e0';
      ctx.fillRect(s.x * room.width, s.y, 1.7, 1.7);
    }

    const span = room.width + 900;
    for (const c of clouds) {
      const x = ((c.x * span + t * c.speed) % span) - 700;
      ctx.globalAlpha = c.alpha;
      ctx.drawImage(c.sprite, x, c.y, c.w, c.h);
    }
    ctx.restore();
  };
}

// --- water ------------------------------------------------------------------

export function makeWater(plate) {
  const H = DOCK_TOP - HORIZON;
  // The sea band, lifted out of the plate once so the shimmer has something to
  // displace. Without a plate (the placeholder path) there is nothing to
  // resample and the glitter carries the effect alone.
  let band = null;
  if (plate) {
    band = document.createElement('canvas');
    band.width = plate.width;
    band.height = H;
    band.getContext('2d').drawImage(plate, 0, HORIZON, plate.width, H, 0, 0, plate.width, H);
  }

  const STRIP = 4;
  const r = rng(23);
  const glints = [];
  for (let i = 0; i < 150; i++) {
    const d = r();                       // 0 at the horizon, 1 at the dock
    glints.push({
      d,
      x: (r() - 0.5) * (30 + d * 460),   // the moon's column widens toward the viewer
      w: 3 + r() * (5 + d * 26),
      rate: 0.7 + r() * 2.6,
      phase: r() * 6.28,
      a: 0.30 + r() * 0.70,
    });
  }

  return function paintWater(ctx, room) {
    const t = room.time;
    ctx.save();
    // Right of the tavern only: the building covers the sea on the left, and
    // redrawing the band across the whole width would paint water over it.
    ctx.beginPath();
    ctx.rect(TAVERN.right, HORIZON, room.width - TAVERN.right, H);
    ctx.clip();

    if (band) {
      // Swell: each strip slides a little, with the amplitude ramping to zero
      // at the horizon. Distant water barely moves and near water moves most,
      // which is both true and what keeps the horizon line crisp — the one
      // line the whole scene's depth is hung on.
      for (let y = 0; y < H; y += STRIP) {
        const d = y / H;
        const amp = d * d * 3.4;
        const dx = Math.sin(y * 0.075 + t * 1.15) * amp + Math.sin(y * 0.031 - t * 0.7) * amp * 0.6;
        ctx.drawImage(band, 0, y, band.width, STRIP, dx, HORIZON + y, band.width, STRIP + 0.6);
      }
    }

    // Moon glitter. Individually these are just bright dashes; together, and
    // flickering out of phase, they are the single cue that says "water".
    ctx.globalCompositeOperation = 'lighter';
    for (const g of glints) {
      const y = HORIZON + g.d * H;
      const tw = Math.max(0, Math.sin(t * g.rate + g.phase));
      if (tw < 0.05) continue;
      const drift = Math.sin(t * 0.5 + g.phase) * 6 * g.d;
      ctx.globalAlpha = (1 - g.d * 0.55) * 0.34 * g.a * tw;
      ctx.fillStyle = '#fff3cf';
      ctx.fillRect(MOON.x + g.x + drift, y, g.w, 1.6);
    }

    // A slow sheen crossing the water, which gives the surface a direction.
    const sx = ((t * 26) % (room.width + 1200)) - 600;
    const sheen = ctx.createLinearGradient(sx, 0, sx + 620, 0);
    sheen.addColorStop(0, 'rgba(150,178,220,0)');
    sheen.addColorStop(0.5, 'rgba(150,178,220,0.055)');
    sheen.addColorStop(1, 'rgba(150,178,220,0)');
    ctx.globalAlpha = 1;
    ctx.fillStyle = sheen;
    ctx.fillRect(0, HORIZON, room.width, H);
    ctx.restore();
  };
}

// --- lamps ------------------------------------------------------------------

// Candlelight is not a steady glow. Two detuned sine waves plus a rare dip
// read as a flame far better than random noise, which reads as a fault.
export function makeLamps() {
  const WIN = { x: 275, y: 355, r: 300 };
  return function paintLamps(ctx, room) {
    const t = room.time;
    const flicker = 0.80 + 0.13 * Math.sin(t * 5.1) + 0.07 * Math.sin(t * 11.7 + 1.3)
      + (Math.sin(t * 0.83) > 0.985 ? -0.22 : 0);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createRadialGradient(WIN.x, WIN.y, 12, WIN.x, WIN.y, WIN.r * flicker);
    g.addColorStop(0, 'rgba(255,196,110,0.34)');
    g.addColorStop(0.45, 'rgba(255,168,80,0.11)');
    g.addColorStop(1, 'rgba(255,168,80,0)');
    ctx.fillStyle = g;
    ctx.fillRect(WIN.x - WIN.r, WIN.y - WIN.r, WIN.r * 2, WIN.r * 2);

    // The spill on the planks, which is what actually sells the window as a
    // light source rather than a bright rectangle.
    // The spill is an ellipse lying on the planks, drawn under a scale so the
    // gradient reaches zero inside its own fill rect. Any rect that cuts a
    // gradient before it has faded turns that cut into a visible hard band —
    // a radial gradient clipped by a rectangle is a rectangle.
    const R = 400 * flicker;
    ctx.translate(300, DOCK_TOP + 74);
    ctx.scale(1, 0.34);
    const s = ctx.createRadialGradient(0, 0, 18, 0, 0, R);
    s.addColorStop(0, 'rgba(255,186,96,0.16)');
    s.addColorStop(0.6, 'rgba(255,170,80,0.05)');
    s.addColorStop(1, 'rgba(255,170,80,0)');
    ctx.fillStyle = s;
    ctx.fillRect(-R, -R, R * 2, R * 2);
    ctx.restore();
  };
}
