// All rendering. Worlds are little round dioramas: a shaded disc, flora
// sticking out of the rim, fauna orbiting, swirling rifts set into the face.
// Everything is drawn from the world's precomputed feature lists — no state
// mutates here, so a world can be redrawn at any time and any transform.
(function () {
  'use strict';
  const TW = (window.TW = window.TW || {});
  const TAU = Math.PI * 2;

  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  function computeLayout(W, H) {
    const R = Math.min(W, H) * 0.3;
    return { cx: W / 2, cy: H / 2 + Math.min(W, H) * 0.015, R };
  }

  const rot = (w, t) => w.rot0 + w.rotSpeed * t;

  function portalPos(w, layout, i, t) {
    const p = w.portals[i];
    const a = p.angle + rot(w, t);
    return {
      x: layout.cx + Math.cos(a) * layout.R * p.dist,
      y: layout.cy + Math.sin(a) * layout.R * p.dist,
      r: layout.R * p.size,
    };
  }

  function motePos(w, layout, i, t) {
    const m = w.motes[i];
    const a = m.angle + t * m.speed;
    const d = layout.R * m.dist + Math.sin(t * 0.8 + m.phase) * 4;
    return { x: layout.cx + Math.cos(a) * d, y: layout.cy + Math.sin(a) * d };
  }

  // --- Background -----------------------------------------------------------

  function drawBackground(ctx, w, W, H, t) {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, w.pal.space[0]);
    g.addColorStop(1, w.pal.space[1]);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    for (const n of w.nebulas) {
      const x = n.x * W + Math.sin(t * 0.02 + n.drift) * 24;
      const y = n.y * H + Math.cos(t * 0.016 + n.drift) * 18;
      const r = n.r * Math.min(W, H) * 1.4;
      const rg = ctx.createRadialGradient(x, y, 0, x, y, r);
      rg.addColorStop(0, hexA(n.color, n.a));
      rg.addColorStop(1, hexA(n.color, 0));
      ctx.fillStyle = rg;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }

    for (const s of w.siblings) {
      ctx.fillStyle = 'rgba(10,12,24,' + s.a + ')';
      ctx.beginPath();
      ctx.arc(s.x * W, s.y * H, s.r, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = hexA(w.pal.glow, s.a * 0.5);
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    for (const s of w.stars) {
      const a = 0.3 + 0.55 * (0.5 + 0.5 * Math.sin(t * s.twf + s.tw));
      const x = s.x * W, y = s.y * H;
      ctx.fillStyle = 'rgba(230,238,255,' + a + ')';
      ctx.beginPath();
      ctx.arc(x, y, s.s, 0, TAU);
      ctx.fill();
      if (s.bright) {
        ctx.strokeStyle = 'rgba(230,238,255,' + a * 0.5 + ')';
        ctx.lineWidth = 0.7;
        const l = s.s * 4;
        ctx.beginPath();
        ctx.moveTo(x - l, y); ctx.lineTo(x + l, y);
        ctx.moveTo(x, y - l); ctx.lineTo(x, y + l);
        ctx.stroke();
      }
    }
  }

  // --- Planet body ----------------------------------------------------------

  function drawRingHalf(ctx, w, layout, front) {
    const r = w.ring;
    if (!r) return;
    const { cx, cy, R } = layout;
    const rMid = ((r.rIn + r.rOut) / 2) * R;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(w.tilt * 0.6);
    ctx.beginPath();
    ctx.rect(-R * 4, front ? 0 : -R * 4, R * 8, R * 4);
    ctx.clip();
    ctx.strokeStyle = hexA(w.pal.accents[0], r.alpha);
    ctx.lineWidth = (r.rOut - r.rIn) * R;
    ctx.beginPath();
    ctx.ellipse(0, 0, rMid, rMid * r.squish, 0, 0, TAU);
    ctx.stroke();
    ctx.strokeStyle = hexA(w.pal.glow, r.alpha * 0.5);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(0, 0, rMid + ctx.lineWidth + (r.rOut - r.rIn) * R * 0.5, (rMid + (r.rOut - r.rIn) * R * 0.5) * r.squish, 0, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }

  function drawMoons(ctx, w, layout, t, front) {
    const { cx, cy, R } = layout;
    for (const m of w.moons) {
      const ma = m.phase + t * m.speed;
      const behind = Math.sin(ma) < 0;
      if (behind === front) continue;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(w.tilt * 0.6);
      const x = Math.cos(ma) * m.dist * R;
      const y = Math.sin(ma) * m.dist * R * m.squish;
      const r = m.size * R;
      const g = ctx.createRadialGradient(x - r * 0.4, y - r * 0.4, r * 0.1, x, y, r);
      g.addColorStop(0, '#e8ecf4');
      g.addColorStop(1, '#8a90a8');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      ctx.fill();
      ctx.fillStyle = 'rgba(90,96,120,0.5)';
      ctx.beginPath();
      ctx.arc(x + r * 0.25, y + r * 0.15, r * 0.28, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
  }

  function drawPlanet(ctx, w, layout, t) {
    const { cx, cy, R } = layout;
    const pal = w.pal;

    // body
    const g = ctx.createRadialGradient(cx - R * 0.4, cy - R * 0.45, R * 0.1, cx - R * 0.1, cy, R * 1.5);
    g.addColorStop(0, pal.planet[0]);
    g.addColorStop(0.55, pal.planet[1]);
    g.addColorStop(1, pal.planet[2]);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, TAU);
    ctx.fill();

    // texture, clipped to the disc
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, TAU);
    ctx.clip();

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(w.tilt);
    for (const b of w.bands) {
      ctx.fillStyle = b.light ? 'rgba(255,255,255,' + b.a + ')' : 'rgba(8,10,30,' + b.a + ')';
      ctx.fillRect(-R * 1.5, b.y * R - (b.h * R) / 2, R * 3, b.h * R);
    }
    ctx.restore();

    const rr = rot(w, t);
    for (const s of w.speckles) {
      const a = s.a + rr;
      ctx.fillStyle = s.light ? 'rgba(255,255,255,0.07)' : 'rgba(8,10,30,0.1)';
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * s.r * R, cy + Math.sin(a) * s.r * R, s.s * R, 0, TAU);
      ctx.fill();
    }

    // day-side light + night-side shade
    const lg = ctx.createRadialGradient(cx - R * 0.5, cy - R * 0.55, 0, cx - R * 0.5, cy - R * 0.55, R * 1.2);
    lg.addColorStop(0, 'rgba(255,255,255,0.14)');
    lg.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = lg;
    ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
    const sg = ctx.createRadialGradient(cx + R * 0.55, cy + R * 0.6, R * 0.2, cx + R * 0.45, cy + R * 0.5, R * 1.4);
    sg.addColorStop(0, 'rgba(4,5,18,0.42)');
    sg.addColorStop(0.5, 'rgba(4,5,18,0.12)');
    sg.addColorStop(1, 'rgba(4,5,18,0)');
    ctx.fillStyle = sg;
    ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
    ctx.restore();

    // rim glow
    ctx.save();
    ctx.strokeStyle = hexA(pal.glow, 0.55);
    ctx.lineWidth = 1.6;
    ctx.shadowColor = pal.glow;
    ctx.shadowBlur = R * 0.1;
    ctx.beginPath();
    ctx.arc(cx, cy, R + 0.5, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }

  // --- Surface features -----------------------------------------------------
  // Painters draw in local coords: origin on the rim, -y pointing away from
  // the planet, height h in pixels.

  const F = {
    tree(ctx, h, pal, f) {
      ctx.fillStyle = pal.dark;
      ctx.fillRect(-h * 0.045, -h * 0.5, h * 0.09, h * 0.5);
      const c1 = pal.planet[0], c2 = pal.accents[f.colorIdx];
      for (const [dx, dy, r, c] of [[-0.2, -0.55, 0.26, c1], [0.2, -0.58, 0.24, c1], [0, -0.75, 0.3, c2]]) {
        ctx.fillStyle = c;
        ctx.beginPath();
        ctx.arc(dx * h, dy * h, r * h, 0, TAU);
        ctx.fill();
      }
    },
    pine(ctx, h, pal, f) {
      ctx.fillStyle = pal.dark;
      ctx.fillRect(-h * 0.04, -h * 0.3, h * 0.08, h * 0.3);
      ctx.fillStyle = f.colorIdx % 2 ? pal.planet[1] : pal.planet[0];
      for (let i = 0; i < 3; i++) {
        const y = -h * (0.25 + i * 0.25);
        const s = h * (0.34 - i * 0.08);
        ctx.beginPath();
        ctx.moveTo(-s, y);
        ctx.lineTo(s, y);
        ctx.lineTo(0, y - h * 0.34);
        ctx.closePath();
        ctx.fill();
      }
    },
    flower(ctx, h, pal, f) {
      ctx.strokeStyle = pal.dark;
      ctx.lineWidth = h * 0.06;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.quadraticCurveTo(h * 0.1 * f.flip, -h * 0.4, 0, -h * 0.68);
      ctx.stroke();
      const c = pal.accents[f.colorIdx];
      ctx.fillStyle = c;
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * TAU + f.phase;
        ctx.beginPath();
        ctx.arc(Math.cos(a) * h * 0.13, -h * 0.68 + Math.sin(a) * h * 0.13, h * 0.11, 0, TAU);
        ctx.fill();
      }
      ctx.fillStyle = '#fff3cf';
      ctx.beginPath();
      ctx.arc(0, -h * 0.68, h * 0.08, 0, TAU);
      ctx.fill();
    },
    grass(ctx, h, pal, f) {
      ctx.strokeStyle = f.colorIdx % 2 ? pal.planet[0] : pal.planet[1];
      ctx.lineWidth = h * 0.05;
      ctx.lineCap = 'round';
      for (let i = -1; i <= 1; i++) {
        ctx.beginPath();
        ctx.moveTo(i * h * 0.09, 0);
        ctx.quadraticCurveTo(i * h * 0.2, -h * 0.35, i * h * 0.3 + h * 0.06 * f.flip, -h * 0.6 - (i === 0 ? h * 0.12 : 0));
        ctx.stroke();
      }
    },
    rock(ctx, h, pal, f) {
      ctx.fillStyle = pal.dark;
      ctx.beginPath();
      ctx.moveTo(-h * 0.32, 0);
      ctx.lineTo(-h * 0.18, -h * 0.34 - f.phase % 0.2 * h);
      ctx.lineTo(h * 0.1, -h * 0.42);
      ctx.lineTo(h * 0.3, -h * 0.12);
      ctx.lineTo(h * 0.26, 0);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.beginPath();
      ctx.moveTo(-h * 0.18, -h * 0.34 - f.phase % 0.2 * h);
      ctx.lineTo(h * 0.1, -h * 0.42);
      ctx.lineTo(h * 0.02, -h * 0.2);
      ctx.closePath();
      ctx.fill();
    },
    cactus(ctx, h, pal, f) {
      ctx.strokeStyle = pal.accents[0];
      ctx.lineWidth = h * 0.16;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(0, -h * 0.72);
      ctx.moveTo(0, -h * 0.4);
      ctx.quadraticCurveTo(h * 0.24 * f.flip, -h * 0.42, h * 0.25 * f.flip, -h * 0.6);
      ctx.stroke();
      if (f.colorIdx === 1) {
        ctx.fillStyle = pal.accents[3];
        ctx.beginPath();
        ctx.arc(0, -h * 0.76, h * 0.07, 0, TAU);
        ctx.fill();
      }
    },
    crystal(ctx, h, pal, f) {
      const c = pal.accents[f.colorIdx];
      for (const [dx, lean, hh, ww] of [[-0.14, -0.18, 0.6, 0.13], [0.12, 0.14, 0.85, 0.16], [0.02, -0.02, 0.45, 0.1]]) {
        const tipX = (dx + lean) * h, tipY = -hh * h;
        ctx.fillStyle = hexA(c, 0.55);
        ctx.beginPath();
        ctx.moveTo((dx - ww) * h, 0);
        ctx.lineTo(tipX, tipY);
        ctx.lineTo((dx + ww) * h, 0);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = hexA(c, 0.9);
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.strokeStyle = 'rgba(255,255,255,0.5)';
        ctx.beginPath();
        ctx.moveTo(dx * h, -h * 0.05);
        ctx.lineTo(tipX, tipY);
        ctx.stroke();
      }
    },
    mushroom(ctx, h, pal, f) {
      ctx.fillStyle = '#e8ddc8';
      ctx.fillRect(-h * 0.06, -h * 0.45, h * 0.12, h * 0.45);
      const c = pal.accents[f.colorIdx];
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.ellipse(0, -h * 0.45, h * 0.32, h * 0.24, 0, Math.PI, 0);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      for (const [dx, dy] of [[-0.14, -0.55], [0.08, -0.6], [0.2, -0.5]]) {
        ctx.beginPath();
        ctx.arc(dx * h, dy * h, h * 0.04, 0, TAU);
        ctx.fill();
      }
    },
    coral(ctx, h, pal, f) {
      ctx.strokeStyle = pal.accents[f.colorIdx];
      ctx.lineWidth = h * 0.1;
      ctx.lineCap = 'round';
      for (let i = -1; i <= 1; i++) {
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.quadraticCurveTo(i * h * 0.18, -h * 0.3, i * h * 0.32, -h * 0.55 - (i === 0 ? h * 0.1 : 0));
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(i * h * 0.24, -h * 0.4);
        ctx.lineTo(i * h * 0.24 + h * 0.1 * f.flip, -h * 0.52);
        ctx.stroke();
      }
    },
    kelp(ctx, h, pal, f, t) {
      ctx.strokeStyle = hexA(pal.accents[f.colorIdx], 0.85);
      ctx.lineWidth = h * 0.07;
      ctx.lineCap = 'round';
      const s = Math.sin(t * 1.2 + f.phase) * h * 0.14;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.quadraticCurveTo(s, -h * 0.45, s * 1.6, -h * 0.9);
      ctx.stroke();
      ctx.fillStyle = hexA(pal.accents[f.colorIdx], 0.7);
      for (const u of [0.35, 0.6, 0.85]) {
        ctx.beginPath();
        ctx.arc(s * u * 1.4 + h * 0.07 * f.flip, -h * u * 0.9, h * 0.05, 0, TAU);
        ctx.fill();
      }
    },
    shard(ctx, h, pal, f) {
      const c = pal.accents[f.colorIdx];
      ctx.fillStyle = hexA(c, 0.75);
      ctx.beginPath();
      ctx.moveTo(-h * 0.16, 0);
      ctx.lineTo(-h * 0.02 + f.flip * h * 0.08, -h * 0.8);
      ctx.lineTo(h * 0.16, 0);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.6)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(-h * 0.05, 0);
      ctx.lineTo(-h * 0.02 + f.flip * h * 0.08, -h * 0.8);
      ctx.stroke();
    },
    hut(ctx, h, pal, f, t) {
      ctx.fillStyle = pal.dark;
      ctx.fillRect(-h * 0.22, -h * 0.34, h * 0.44, h * 0.34);
      ctx.fillStyle = pal.accents[f.colorIdx];
      ctx.beginPath();
      ctx.moveTo(-h * 0.3, -h * 0.32);
      ctx.lineTo(0, -h * 0.6);
      ctx.lineTo(h * 0.3, -h * 0.32);
      ctx.closePath();
      ctx.fill();
      const win = 0.6 + 0.4 * Math.sin(t * 0.7 + f.phase);
      ctx.fillStyle = 'rgba(255,224,150,' + (0.4 + win * 0.5) + ')';
      ctx.fillRect(-h * 0.05, -h * 0.24, h * 0.1, h * 0.12);
    },
    droplet(ctx, h, pal, f, t) {
      const r = h * 0.3;
      const sq = 1 + Math.sin(t * 2 + f.phase) * 0.05;
      ctx.save();
      ctx.translate(0, -r);
      ctx.scale(sq, 1 / sq);
      const g = ctx.createRadialGradient(-r * 0.3, -r * 0.3, r * 0.1, 0, 0, r);
      g.addColorStop(0, 'rgba(255,255,255,0.75)');
      g.addColorStop(0.4, hexA(pal.accents[1] || pal.glow, 0.35));
      g.addColorStop(1, hexA(pal.glow, 0.15));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(-r * 0.3, -r * 0.35, r * 0.22, 0, TAU);
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.fill();
      ctx.restore();
    },
    blob(ctx, h, pal, f, t) {
      const c = pal.accents[f.colorIdx];
      const r = h * 0.32;
      ctx.save();
      ctx.translate(0, -r * 0.9);
      ctx.beginPath();
      for (let i = 0; i <= 14; i++) {
        const a = (i / 14) * TAU;
        const rr = r * (1 + 0.16 * Math.sin(a * 3 + f.phase) + 0.05 * Math.sin(t * 2 + a * 5));
        const x = Math.cos(a) * rr, y = Math.sin(a) * rr * 0.85;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.closePath();
      ctx.fillStyle = hexA(c, 0.5);
      ctx.fill();
      ctx.strokeStyle = hexA(c, 0.9);
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.fillStyle = hexA(pal.dark, 0.8);
      ctx.beginPath();
      ctx.arc(r * 0.15, 0, r * 0.3, 0, TAU);
      ctx.fill();
      ctx.restore();
    },
    spike(ctx, h, pal, f) {
      ctx.fillStyle = pal.dark;
      ctx.beginPath();
      ctx.moveTo(-h * 0.12, 0);
      ctx.lineTo(f.flip * h * 0.06, -h * 0.85);
      ctx.lineTo(h * 0.12, 0);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = hexA(pal.accents[f.colorIdx], 0.5);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(f.flip * h * 0.06, -h * 0.85);
      ctx.stroke();
    },
    door(ctx, h, pal, f, t) {
      const wD = h * 0.34, hD = h * 0.6;
      ctx.fillStyle = pal.dark;
      ctx.beginPath();
      ctx.moveTo(-wD / 2, 0);
      ctx.lineTo(-wD / 2, -hD + wD / 2);
      ctx.arc(0, -hD + wD / 2, wD / 2, Math.PI, 0);
      ctx.lineTo(wD / 2, 0);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = hexA(pal.glow, 0.5 + 0.3 * Math.sin(t * 1.5 + f.phase));
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.fillStyle = pal.glow;
      ctx.beginPath();
      ctx.arc(wD * 0.24, -hD * 0.42, h * 0.035, 0, TAU);
      ctx.fill();
    },
    eye(ctx, h, pal, f, t) {
      const blink = Math.max(0.08, Math.abs(Math.sin(t * 0.6 + f.phase)) ** 0.3);
      const wE = h * 0.42, hE = h * 0.26 * blink;
      ctx.save();
      ctx.translate(0, -h * 0.45);
      ctx.fillStyle = 'rgba(245,242,255,0.9)';
      ctx.beginPath();
      ctx.ellipse(0, 0, wE, hE, 0, 0, TAU);
      ctx.fill();
      ctx.fillStyle = pal.accents[f.colorIdx];
      ctx.beginPath();
      ctx.arc(Math.sin(t * 0.3 + f.phase) * wE * 0.3, 0, Math.min(hE, h * 0.11), 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#101018';
      ctx.beginPath();
      ctx.arc(Math.sin(t * 0.3 + f.phase) * wE * 0.3, 0, Math.min(hE * 0.6, h * 0.05), 0, TAU);
      ctx.fill();
      ctx.restore();
    },
    candle(ctx, h, pal, f, t) {
      ctx.fillStyle = '#e8e0d0';
      ctx.fillRect(-h * 0.08, -h * 0.42, h * 0.16, h * 0.42);
      const fl = 0.8 + 0.2 * Math.sin(t * 9 + f.phase);
      const g = ctx.createRadialGradient(0, -h * 0.52, 0, 0, -h * 0.52, h * 0.22 * fl);
      g.addColorStop(0, 'rgba(255,220,140,0.9)');
      g.addColorStop(1, 'rgba(255,160,60,0)');
      ctx.fillStyle = g;
      ctx.fillRect(-h * 0.25, -h * 0.8, h * 0.5, h * 0.5);
      ctx.fillStyle = '#ffdf9e';
      ctx.beginPath();
      ctx.ellipse(0, -h * 0.52, h * 0.045 * fl, h * 0.09 * fl, 0, 0, TAU);
      ctx.fill();
    },
  };

  function drawFeatures(ctx, w, layout, t) {
    const { cx, cy, R } = layout;
    const rr = rot(w, t);
    for (const f of w.features) {
      const painter = F[f.type];
      if (!painter) continue;
      const a = f.angle + rr;
      ctx.save();
      ctx.translate(cx + Math.cos(a) * (R - 1), cy + Math.sin(a) * (R - 1));
      ctx.rotate(a + Math.PI / 2 + Math.sin(t * f.wob + f.phase) * 0.05);
      painter(ctx, R * 0.17 * f.size, w.pal, f, t);
      ctx.restore();
    }
  }

  // --- Rifts ------------------------------------------------------------

  function drawPortal(ctx, w, layout, i, t, hovered) {
    const p = w.portals[i];
    const pos = portalPos(w, layout, i, t);
    const pulse = 1 + 0.05 * Math.sin(t * 2.2 + i * 2.1);
    const pr = pos.r * pulse * (hovered ? 1.22 : 1);
    const g = p.preview.glow;

    const rg = ctx.createRadialGradient(pos.x, pos.y, pr * 0.3, pos.x, pos.y, pr * 2.4);
    rg.addColorStop(0, hexA(g, hovered ? 0.58 : 0.42));
    rg.addColorStop(1, hexA(g, 0));
    ctx.fillStyle = rg;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, pr * 2.4, 0, TAU);
    ctx.fill();

    ctx.fillStyle = 'rgba(5,6,16,0.93)';
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, pr, 0, TAU);
    ctx.fill();

    ctx.save();
    ctx.shadowColor = g;
    ctx.shadowBlur = 7;
    for (let k = 0; k < 3; k++) {
      const ar = pr * (0.42 + k * 0.2);
      const a0 = t * p.spin * (1 + k * 0.35) + k * 2.4;
      const span = 1.6 + 0.5 * Math.sin(t * 0.9 + k + i);
      ctx.strokeStyle = hexA(g, 0.85 - k * 0.22);
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, ar, a0, a0 + span);
      ctx.stroke();
    }
    ctx.restore();

    for (let k = 0; k < 4; k++) {
      const u = (t * 0.32 + k * 0.25 + i * 0.13) % 1;
      const r2 = pr * (1.05 - u * 0.95);
      const a2 = u * 8 + k * 1.7 + t * p.spin;
      ctx.fillStyle = hexA(g, (1 - u) * 0.9);
      ctx.beginPath();
      ctx.arc(pos.x + Math.cos(a2) * r2, pos.y + Math.sin(a2) * r2, 1.4, 0, TAU);
      ctx.fill();
    }

    ctx.fillStyle = hexA('#ffffff', 0.5 + 0.4 * Math.sin(t * 3 + i));
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, 1.6, 0, TAU);
    ctx.fill();

    if (hovered) {
      ctx.strokeStyle = 'rgba(255,255,255,0.65)';
      ctx.lineWidth = 1.2;
      ctx.setLineDash([4, 5]);
      ctx.lineDashOffset = -t * 20;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, pr * 1.32, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // --- Motes ------------------------------------------------------------

  function drawMotes(ctx, w, layout, t) {
    for (let i = 0; i < w.motes.length; i++) {
      const m = w.motes[i];
      if (m.collected) continue;
      const pos = motePos(w, layout, i, t);
      const tw = 0.7 + 0.3 * Math.sin(t * 3 + m.phase);
      const s = m.size * tw;
      ctx.save();
      ctx.translate(pos.x, pos.y);
      ctx.rotate(t * 0.6 + m.phase);
      ctx.fillStyle = 'rgba(255,248,216,' + (0.55 + 0.4 * tw) + ')';
      ctx.shadowColor = w.pal.glow;
      ctx.shadowBlur = 6;
      ctx.beginPath();
      ctx.moveTo(0, -s * 1.8);
      ctx.quadraticCurveTo(s * 0.3, -s * 0.3, s * 1.8, 0);
      ctx.quadraticCurveTo(s * 0.3, s * 0.3, 0, s * 1.8);
      ctx.quadraticCurveTo(-s * 0.3, s * 0.3, -s * 1.8, 0);
      ctx.quadraticCurveTo(-s * 0.3, -s * 0.3, 0, -s * 1.8);
      ctx.fill();
      ctx.restore();
    }
  }

  // --- Creatures --------------------------------------------------------

  const RADIAL = { ember: 1, bubble: 1, flake: -1, spore: 1 };

  function creaturePos(c, layout, t) {
    const { cx, cy, R } = layout;
    if (RADIAL[c.type]) {
      const frac = (t * Math.abs(c.speed) * 0.5 + c.phase / TAU) % 1;
      const dir = RADIAL[c.type];
      const u = dir > 0 ? frac : 1 - frac;
      const r = R * (1.04 + u * 0.72);
      const a = c.phase + Math.sin(t * 0.5 + c.phase) * 0.1;
      return { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r, a, fade: Math.sin(frac * Math.PI) };
    }
    const a = c.phase + t * c.speed;
    const r = c.baseR * R * (1 + c.wobA * Math.sin(t * c.wobF + c.phase));
    return { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r, a, fade: 1 };
  }

  const C = {
    bird(ctx, c, pal, t, s) {
      const flap = 0.35 + 0.4 * Math.abs(Math.sin(t * 5 + c.phase));
      ctx.strokeStyle = 'rgba(235,240,255,0.85)';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(-s * 4, 0);
      ctx.quadraticCurveTo(-s * 1.6, -s * 4 * flap, 0, 0);
      ctx.quadraticCurveTo(s * 1.6, -s * 4 * flap, s * 4, 0);
      ctx.stroke();
    },
    butterfly(ctx, c, pal, t, s) {
      const flap = 0.3 + 0.7 * Math.abs(Math.sin(t * 7 + c.phase));
      ctx.fillStyle = hexA(pal.accents[c.colorIdx], 0.9);
      for (const d of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(d * s * 3.4 * flap, -s * 2.4);
        ctx.lineTo(d * s * 3 * flap, s * 1.6);
        ctx.closePath();
        ctx.fill();
      }
      ctx.fillStyle = 'rgba(30,30,45,0.9)';
      ctx.fillRect(-s * 0.4, -s * 1.6, s * 0.8, s * 3.2);
    },
    firefly(ctx, c, pal, t, s) {
      const a = 0.25 + 0.75 * (0.5 + 0.5 * Math.sin(t * 3.5 + c.phase * 3));
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, s * 4);
      g.addColorStop(0, hexA(pal.glow, a));
      g.addColorStop(1, hexA(pal.glow, 0));
      ctx.fillStyle = g;
      ctx.fillRect(-s * 4, -s * 4, s * 8, s * 8);
      ctx.fillStyle = 'rgba(255,255,240,' + a + ')';
      ctx.beginPath();
      ctx.arc(0, 0, s * 0.9, 0, TAU);
      ctx.fill();
    },
    fish(ctx, c, pal, t, s) {
      ctx.rotate(c.speed > 0 ? Math.PI / 2 : -Math.PI / 2);
      const col = pal.accents[c.colorIdx];
      ctx.fillStyle = hexA(col, 0.95);
      ctx.beginPath();
      ctx.ellipse(0, 0, s * 3, s * 1.4, 0, 0, TAU);
      ctx.fill();
      const wag = Math.sin(t * 8 + c.phase) * s;
      ctx.beginPath();
      ctx.moveTo(-s * 2.6, 0);
      ctx.lineTo(-s * 4.4, -s * 1.4 + wag);
      ctx.lineTo(-s * 4.4, s * 1.4 + wag);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#10141f';
      ctx.beginPath();
      ctx.arc(s * 1.6, -s * 0.3, s * 0.35, 0, TAU);
      ctx.fill();
    },
    bubble(ctx, c, pal, t, s) {
      ctx.strokeStyle = 'rgba(230,245,255,0.65)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(0, 0, s * 2.4, 0, TAU);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.beginPath();
      ctx.arc(0, 0, s * 1.7, -2.4, -1.4);
      ctx.stroke();
    },
    ember(ctx, c, pal, t, s) {
      const fl = 0.6 + 0.4 * Math.sin(t * 11 + c.phase * 5);
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, s * 3.5);
      g.addColorStop(0, 'rgba(255,190,110,' + 0.8 * fl + ')');
      g.addColorStop(1, 'rgba(255,110,40,0)');
      ctx.fillStyle = g;
      ctx.fillRect(-s * 3.5, -s * 3.5, s * 7, s * 7);
      ctx.fillStyle = 'rgba(255,225,170,' + fl + ')';
      ctx.beginPath();
      ctx.arc(0, 0, s * 0.8, 0, TAU);
      ctx.fill();
    },
    spore(ctx, c, pal, t, s) {
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, s * 2.6);
      g.addColorStop(0, hexA(pal.accents[c.colorIdx], 0.7));
      g.addColorStop(1, hexA(pal.accents[c.colorIdx], 0));
      ctx.fillStyle = g;
      ctx.fillRect(-s * 2.6, -s * 2.6, s * 5.2, s * 5.2);
    },
    flake(ctx, c, pal, t, s) {
      ctx.strokeStyle = 'rgba(240,248,255,0.85)';
      ctx.lineWidth = 0.9;
      ctx.rotate(t + c.phase);
      for (let i = 0; i < 3; i++) {
        ctx.beginPath();
        ctx.moveTo(-s * 1.6, 0);
        ctx.lineTo(s * 1.6, 0);
        ctx.stroke();
        ctx.rotate(Math.PI / 3);
      }
    },
    ciliate(ctx, c, pal, t, s) {
      ctx.rotate(Math.sin(t * 2 + c.phase) * 0.5 + c.phase);
      const col = pal.accents[c.colorIdx];
      ctx.fillStyle = hexA(col, 0.4);
      ctx.strokeStyle = hexA(col, 0.9);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.ellipse(0, 0, s * 2.8, s * 1.6, 0, 0, TAU);
      ctx.fill();
      ctx.stroke();
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * TAU;
        const wig = Math.sin(t * 9 + i * 2 + c.phase) * 0.3;
        ctx.beginPath();
        const x = Math.cos(a) * s * 2.8, y = Math.sin(a) * s * 1.6;
        ctx.moveTo(x, y);
        ctx.lineTo(x * 1.35 + wig * s, y * 1.35 + wig * s);
        ctx.stroke();
      }
      ctx.fillStyle = hexA(col, 0.9);
      ctx.beginPath();
      ctx.arc(s * 0.6, 0, s * 0.55, 0, TAU);
      ctx.fill();
    },
    electron(ctx, c, pal, t, s) {
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, s * 3.2);
      g.addColorStop(0, 'rgba(200,230,255,0.9)');
      g.addColorStop(1, 'rgba(120,180,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(-s * 3.2, -s * 3.2, s * 6.4, s * 6.4);
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(0, 0, s * 0.9, 0, TAU);
      ctx.fill();
    },
    wisp(ctx, c, pal, t, s) {
      const col = pal.glow;
      for (let i = 0; i < 4; i++) {
        const g = ctx.createRadialGradient(-i * s * 1.6, 0, 0, -i * s * 1.6, 0, s * (2.2 - i * 0.4));
        g.addColorStop(0, hexA(col, 0.5 - i * 0.11));
        g.addColorStop(1, hexA(col, 0));
        ctx.fillStyle = g;
        ctx.fillRect(-i * s * 1.6 - s * 3, -s * 3, s * 6, s * 6);
      }
    },
  };

  function drawCreatures(ctx, w, layout, t) {
    // electron orbit rings first, faint
    let ringDrawn = false;
    for (const c of w.creatures) {
      if (c.type !== 'electron' || ringDrawn) continue;
      ringDrawn = true;
      ctx.strokeStyle = hexA(w.pal.glow, 0.12);
      ctx.lineWidth = 1;
      for (const e of w.creatures) {
        if (e.type !== 'electron') continue;
        ctx.beginPath();
        ctx.arc(layout.cx, layout.cy, e.baseR * layout.R, 0, TAU);
        ctx.stroke();
      }
    }
    for (const c of w.creatures) {
      const painter = C[c.type];
      if (!painter) continue;
      const pos = creaturePos(c, layout, t);
      ctx.save();
      ctx.translate(pos.x, pos.y);
      ctx.globalAlpha *= pos.fade;
      if (c.type === 'fish') ctx.rotate(pos.a);
      painter(ctx, c, w.pal, t, 2.6 * c.size * (layout.R / 160));
      ctx.restore();
    }
  }

  // --- Whole scene ------------------------------------------------------

  function drawWorld(ctx, w, W, H, t, opts) {
    opts = opts || {};
    const layout = computeLayout(W, H);
    if (!opts.noBackground) drawBackground(ctx, w, W, H, t);
    drawRingHalf(ctx, w, layout, false);
    drawMoons(ctx, w, layout, t, false);
    drawPlanet(ctx, w, layout, t);
    drawFeatures(ctx, w, layout, t);
    for (let i = 0; i < w.portals.length; i++) {
      drawPortal(ctx, w, layout, i, t, i === opts.hover);
    }
    drawRingHalf(ctx, w, layout, true);
    drawMoons(ctx, w, layout, t, true);
    drawCreatures(ctx, w, layout, t);
    drawMotes(ctx, w, layout, t);
  }

  TW.draw = { computeLayout, portalPos, motePos, rot, drawWorld, drawBackground, hexA };
})();
