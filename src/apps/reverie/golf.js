/*
 * Crazy golf, on the Boardwalk.
 *
 * Six holes, drag back from the ball to putt, and a windmill on the last
 * because there is always a windmill on the last. The hazards are the four
 * a seaside course actually had: rails, a pond, a bunker, and bumpers
 * robbed off a pinball table.
 *
 * The ball is a circle with friction that resolves against axis-aligned
 * rails, circular bumpers and one rotating blade. Everything else — the
 * pond, the sand — changes what friction does rather than where the ball
 * can be, which is both simpler and how the real thing felt.
 */

import { h, clear, drag, pick } from '../../core/dom.js';
import * as A from '../../core/audio.js';
import { faceFor } from './faces.js';
import { portrait, btn, shell } from './ui.js';
import { ART } from '../../assets/art.js';
import { PERSONAS } from '../halcyon/people.js';

const W = 440, H = 300;
const R = 6;                       // ball radius
const CUP = 10;                    // cup radius
const GRASS = 0.978, SAND = 0.900; // per-frame speed retained
const BOUNCE = 0.68, BUMPER = 1.06, STOP = 0.14, MAX_PULL = 100;

/* Rails are [x, y, w, h]; so are ponds and bunkers. Bumpers are circles. */
const HOLES = [
  {
    name: 'The Straight One', par: 2,
    tee: [58, 240], cup: [370, 66],
    walls: [[150, 130, 18, 170], [270, 0, 18, 170]],
  },
  {
    name: 'The Pond', par: 3,
    tee: [56, 150], cup: [382, 150],
    walls: [[120, 0, 16, 74], [120, 226, 16, 74]],
    water: [[168, 0, 92, 116], [168, 184, 92, 116]],
  },
  {
    name: 'The Bunker', par: 3,
    tee: [60, 60], cup: [368, 236],
    walls: [[130, 62, 16, 150], [246, 88, 16, 178]],
    sand: [[286, 150, 120, 100]],
  },
  {
    name: 'The Bumpers', par: 3,
    tee: [58, 150], cup: [388, 150],
    walls: [[176, 0, 14, 56], [176, 244, 14, 56]],
    bumpers: [[240, 92, 17], [240, 208, 17], [316, 150, 20]],
  },
  {
    name: 'The Dog-leg', par: 3,
    tee: [54, 56], cup: [382, 244],
    walls: [[112, 0, 16, 160], [112, 160, 210, 16], [244, 176, 16, 66], [312, 60, 16, 116]],
    sand: [[128, 186, 96, 60]],
  },
  {
    name: 'The Windmill', par: 4,
    tee: [58, 150], cup: [392, 150],
    walls: [[150, 0, 16, 104], [150, 196, 16, 104], [268, 0, 16, 76], [268, 224, 16, 76]],
    water: [[300, 0, 96, 46], [300, 254, 96, 46]],
    bumpers: [[340, 150, 15]],
    windmill: { x: 216, y: 150, len: 74, speed: 0.026 },
  },
];

const TOTAL_PAR = HOLES.reduce((n, x) => n + x.par, 0);

const verdict = (s, par) =>
  s === 1 ? 'hole in one' : s === par - 2 ? 'eagle' : s === par - 1 ? 'birdie'
    : s === par ? 'par' : s === par + 1 ? 'bogey' : 'ouch';

/* A fixed sprinkle of grains per bunker, so the sand does not crawl. */
function stipple(seed, n) {
  let s = seed >>> 0;
  const out = [];
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const a = (s >>> 8) / 16777216;
    s = (s * 1664525 + 1013904223) >>> 0;
    out.push([a, (s >>> 8) / 16777216]);
  }
  return out;
}
const GRAINS = HOLES.map((_, i) => stipple(i * 7919 + 13, 90));

export function openGolf(stage, session, myFace, onBack) {
  const rival = pick(PERSONAS);
  const canvas = h('canvas', { width: W, height: H, class: 'gm-canvas' });
  const card = h('div.gm-card');
  const said = h('div.gm-said');

  const { bar, note } = shell(stage, {
    ground: 'pur', title: 'Crazy Golf  ·  The Boardwalk',
    art: ART.game_golf,
    backLabel: 'The Boardwalk', onBack: () => stop(onBack),
    side: [
      portrait(myFace, session.name, { size: 60, cls: 'me' }),
      card,
      said,
      portrait(faceFor(rival.name), rival.name, { size: 40, cls: 'small' }),
    ],
    middle: h('div.rev-frame', {}, canvas),
    note: 'Drag back from the ball and let go.',
  });
  const status = text => { note.textContent = text; };

  const g = canvas.getContext('2d');
  let holeIx = 0, strokes = 0, total = 0, sunk = false, running = true;
  let ball = { x: 0, y: 0, vx: 0, vy: 0 };
  let lie = { x: 0, y: 0 };        // where the stroke began, for the pond
  let aim = null;                  // {dx, dy} while dragging
  let spin = 0, raf = 0, t = 0;
  let flash = null;                // a bumper lighting up
  const scores = [];

  const hole = () => HOLES[holeIx];
  const speed = () => Math.hypot(ball.vx, ball.vy);
  const inRects = (rects, x, y) => (rects || []).some(
    ([rx, ry, rw, rh]) => x > rx && x < rx + rw && y > ry && y < ry + rh);

  function wallsOf(hl) {
    return [
      [0, 0, W, 8], [0, H - 8, W, 8], [0, 0, 8, H], [W - 8, 0, 8, H],
      ...hl.walls,
    ];
  }

  function startHole() {
    sunk = false; strokes = 0;
    ball = { x: hole().tee[0], y: hole().tee[1], vx: 0, vy: 0 };
    lie = { x: ball.x, y: ball.y };
    status('Hole ' + (holeIx + 1) + ': ' + hole().name + ' — par ' + hole().par + '.');
    drawCard();
  }

  /* The card every seaside course had a pencil hanging off. */
  function drawCard() {
    clear(card).append(
      h('h4', {}, 'Score Card'),
      ...HOLES.map((hl, i) => h('div', {
        class: 'row' + (i === holeIx ? ' now' : ''),
      },
        h('span', {}, (i + 1) + '. ' + hl.name),
        h('span', {}, i < scores.length ? String(scores[i])
          : i === holeIx ? String(strokes) : '–'))),
      h('div', { class: 'row tot' },
        h('span', {}, 'Total · par ' + TOTAL_PAR),
        h('span', {}, String(total + (sunk ? 0 : strokes)))));
  }

  function stop(then) {
    running = false;
    cancelAnimationFrame(raf);
    if (then) then();
  }

  function say(text) {
    said.textContent = text;
    setTimeout(() => { if (running) said.textContent = ''; }, 3600);
  }

  /* ── physics ────────────────────────────────────────────────────────── */

  function windmillSegment() {
    const wm = hole().windmill;
    if (!wm) return null;
    return {
      x1: wm.x + Math.cos(spin) * wm.len / 2, y1: wm.y + Math.sin(spin) * wm.len / 2,
      x2: wm.x - Math.cos(spin) * wm.len / 2, y2: wm.y - Math.sin(spin) * wm.len / 2,
    };
  }

  /** Distance from the ball to a line segment, for the windmill blade. */
  function nearSegment(seg) {
    const dx = seg.x2 - seg.x1, dy = seg.y2 - seg.y1;
    const p = Math.max(0, Math.min(1,
      ((ball.x - seg.x1) * dx + (ball.y - seg.y1) * dy) / (dx * dx + dy * dy)));
    const px = seg.x1 + dx * p, py = seg.y1 + dy * p;
    return { d: Math.hypot(ball.x - px, ball.y - py), px, py };
  }

  function splash() {
    strokes++;
    ball = { x: lie.x, y: lie.y, vx: 0, vy: 0 };
    A.doorClose();
    say('oh no');
    status('In the pond. A penalty stroke, and play it again from where you were.');
    drawCard();
  }

  function step() {
    if (sunk) return;
    ball.x += ball.vx; ball.y += ball.vy;

    const bogged = inRects(hole().sand, ball.x, ball.y);
    const f = bogged ? SAND : GRASS;
    ball.vx *= f; ball.vy *= f;

    if (inRects(hole().water, ball.x, ball.y)) return splash();

    for (const [x, y, w, hgt] of wallsOf(hole())) {
      const cx = Math.max(x, Math.min(ball.x, x + w));
      const cy = Math.max(y, Math.min(ball.y, y + hgt));
      const dx = ball.x - cx, dy = ball.y - cy;
      if (dx * dx + dy * dy >= R * R) continue;
      // Push out along the shallower axis, which is the face it hit.
      if (Math.abs(dx) > Math.abs(dy)) {
        ball.x = dx > 0 ? x + w + R : x - R;
        ball.vx = -ball.vx * BOUNCE;
      } else {
        ball.y = dy > 0 ? y + hgt + R : y - R;
        ball.vy = -ball.vy * BOUNCE;
      }
      if (speed() > 1) A.click();
    }

    (hole().bumpers || []).forEach(([bx, by, br], i) => {
      const dx = ball.x - bx, dy = ball.y - by;
      const d = Math.hypot(dx, dy);
      if (d >= br + R || d === 0) return;
      const nx = dx / d, ny = dy / d;
      ball.x = bx + nx * (br + R); ball.y = by + ny * (br + R);
      const dot = ball.vx * nx + ball.vy * ny;
      // A bumper gives back more than it took, which is the whole appeal.
      ball.vx = (ball.vx - 2 * dot * nx) * BUMPER;
      ball.vy = (ball.vy - 2 * dot * ny) * BUMPER;
      flash = { i, ttl: 14 };
      A.beep();
    });

    const seg = windmillSegment();
    if (seg) {
      const n = nearSegment(seg);
      if (n.d < R + 3) {
        const nx = (ball.x - n.px) / (n.d || 1), ny = (ball.y - n.py) / (n.d || 1);
        ball.x = n.px + nx * (R + 3.5); ball.y = n.py + ny * (R + 3.5);
        const dot = ball.vx * nx + ball.vy * ny;
        ball.vx = (ball.vx - 2 * dot * nx) * BOUNCE + nx * 0.8;
        ball.vy = (ball.vy - 2 * dot * ny) * BOUNCE + ny * 0.8;
        A.beep();
      }
    }

    const [hx, hy] = hole().cup;
    const dh = Math.hypot(ball.x - hx, ball.y - hy);
    if (dh < CUP - 2 && speed() < 3.4) return sink();
    if (dh < CUP + 2 && speed() < 5) {                    // lipped out
      ball.vx += (hx - ball.x) * 0.05;
      ball.vy += (hy - ball.y) * 0.05;
    }
    if (speed() < STOP) { ball.vx = 0; ball.vy = 0; }
  }

  function sink() {
    sunk = true;
    ball.vx = ball.vy = 0;
    total += strokes;
    scores.push(strokes);
    A.startupChime();
    const v = verdict(strokes, hole().par);
    say(v === 'ouch' ? 'that stinks' : v === 'hole in one' ? 'wow' : 'nice one');
    status('In, in ' + strokes + '. That is a ' + v + '.');
    drawCard();

    setTimeout(() => {
      if (!running) return;
      if (holeIx < HOLES.length - 1) { holeIx++; startHole(); return; }
      status('Round finished: ' + total + ' against a par of ' + TOTAL_PAR + '. ' +
        (total <= TOTAL_PAR ? 'The pier is impressed.' : 'The windmill is undefeated.'));
      bar.insertBefore(
        btn('Play Again', () => { stop(); openGolf(stage, session, myFace, onBack); },
          { cls: 'go' }),
        bar.querySelector('.spacer'));
    }, 1800);
  }

  /* ── aiming ─────────────────────────────────────────────────────────── */

  const at = ev => {
    const r = canvas.getBoundingClientRect();
    return { x: (ev.clientX - r.left) * (W / r.width), y: (ev.clientY - r.top) * (H / r.height) };
  };

  drag(canvas,
    ev => {
      if (sunk || speed() > STOP) return false;
      const p = at(ev);
      if (Math.hypot(p.x - ball.x, p.y - ball.y) > 40) return false;
      aim = { dx: 0, dy: 0 };
      return true;
    },
    (mx, my) => {
      if (!aim) return;
      const len = Math.min(Math.hypot(mx, my), MAX_PULL);
      const a = Math.atan2(my, mx);
      aim = { dx: Math.cos(a) * len, dy: Math.sin(a) * len };
    },
    () => {
      if (!aim) return;
      const power = Math.hypot(aim.dx, aim.dy) / MAX_PULL;
      if (power > 0.06) {
        lie = { x: ball.x, y: ball.y };
        ball.vx = -aim.dx * 0.125; ball.vy = -aim.dy * 0.125;
        strokes++;
        A.doorClose();
        drawCard();
      }
      aim = null;
    });

  /* ── drawing ────────────────────────────────────────────────────────── */

  /* Rails were painted timber: a light edge along the top, a dark one
     underneath, and nothing in between. */
  function rail(x, y, w, hgt) {
    g.fillStyle = '#8a6a3c'; g.fillRect(x, y, w, hgt);
    g.fillStyle = '#c49a58'; g.fillRect(x, y, w, 2); g.fillRect(x, y, 2, hgt);
    g.fillStyle = '#4e3a1e';
    g.fillRect(x, y + hgt - 2, w, 2); g.fillRect(x + w - 2, y, 2, hgt);
  }

  function drawHazards() {
    for (const [x, y, w, hgt] of hole().water || []) {
      g.fillStyle = '#2c62a8'; g.fillRect(x, y, w, hgt);
      g.fillStyle = '#4a86d0';
      for (let i = 0; i < hgt; i += 9) {
        const off = Math.sin((t + i) * 0.05) * 5;
        g.fillRect(x + 6 + off, y + 4 + i, w - 20, 2);
      }
      g.strokeStyle = '#17406e'; g.lineWidth = 2; g.strokeRect(x + 1, y + 1, w - 2, hgt - 2);
    }
    (hole().sand || []).forEach(([x, y, w, hgt], si) => {
      g.fillStyle = '#dcc482'; g.fillRect(x, y, w, hgt);
      g.fillStyle = '#c0a662';
      for (const [a, b] of GRAINS[holeIx]) {
        if (si && (a * 7 | 0) % 2) continue;
        g.fillRect(x + a * (w - 3) | 0, y + b * (hgt - 3) | 0, 2, 2);
      }
      g.strokeStyle = '#a88d4e'; g.lineWidth = 2; g.strokeRect(x + 1, y + 1, w - 2, hgt - 2);
    });
    (hole().bumpers || []).forEach(([x, y, r], i) => {
      const lit = flash && flash.i === i;
      g.fillStyle = lit ? '#fff2a0' : '#d43a3a';
      g.beginPath(); g.arc(x, y, r, 0, 6.283); g.fill();
      g.fillStyle = lit ? '#fff' : '#f0e0c0';
      g.beginPath(); g.arc(x, y, r * 0.62, 0, 6.283); g.fill();
      g.fillStyle = lit ? '#ffd23a' : '#8a2020';
      g.beginPath(); g.arc(x, y, r * 0.3, 0, 6.283); g.fill();
      g.strokeStyle = 'rgba(0,0,0,.45)'; g.lineWidth = 1.5;
      g.beginPath(); g.arc(x, y, r, 0, 6.283); g.stroke();
    });
    if (flash && --flash.ttl <= 0) flash = null;
  }

  function draw() {
    g.fillStyle = '#2f6b34'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#357a3a';
    for (let y = 0; y < H; y += 14) g.fillRect(0, y, W, 7);

    drawHazards();
    for (const r of wallsOf(hole())) rail(...r);

    const [hx, hy] = hole().cup;
    g.fillStyle = '#0e1c0c';
    g.beginPath(); g.ellipse(hx, hy, CUP, CUP * 0.86, 0, 0, 6.283); g.fill();
    g.strokeStyle = 'rgba(255,255,255,.28)'; g.lineWidth = 1.5;
    g.beginPath(); g.ellipse(hx, hy, CUP, CUP * 0.86, 0, Math.PI, 6.283); g.stroke();
    g.strokeStyle = '#e8e4d0'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(hx, hy - 2); g.lineTo(hx, hy - 32); g.stroke();
    g.fillStyle = '#d63a3a';
    g.beginPath(); g.moveTo(hx + 1, hy - 32); g.lineTo(hx + 18, hy - 26); g.lineTo(hx + 1, hy - 20);
    g.closePath(); g.fill();
    g.fillStyle = '#fff';
    g.font = 'bold 8px Tahoma, sans-serif';
    g.fillText(String(holeIx + 1), hx + 5, hy - 24);

    const seg = windmillSegment();
    if (seg) {
      const wm = hole().windmill;
      g.fillStyle = '#8a3a2a'; g.fillRect(wm.x - 14, wm.y - 14, 28, 28);
      g.fillStyle = '#b45a42'; g.fillRect(wm.x - 14, wm.y - 14, 28, 3);
      g.strokeStyle = '#f0e8d0'; g.lineWidth = 7; g.lineCap = 'round';
      g.beginPath(); g.moveTo(seg.x1, seg.y1); g.lineTo(seg.x2, seg.y2); g.stroke();
      g.strokeStyle = '#8a7a58'; g.lineWidth = 2;
      g.beginPath(); g.moveTo(seg.x1, seg.y1); g.lineTo(seg.x2, seg.y2); g.stroke();
      g.lineCap = 'butt';
    }

    /* Waiting to putt: a ring around the ball that breathes, so it is never
       a mystery whose turn it is or where the thing you hit has got to. */
    if (!sunk && !aim && speed() <= STOP) {
      g.strokeStyle = 'rgba(255,255,255,' + (0.3 + Math.sin(t * 0.08) * 0.22).toFixed(2) + ')';
      g.lineWidth = 2;
      g.beginPath(); g.arc(ball.x, ball.y, R + 6, 0, 6.283); g.stroke();
    }

    if (aim) drawAim();

    g.fillStyle = 'rgba(0,0,0,.3)';
    g.beginPath(); g.ellipse(ball.x + 1.5, ball.y + 2.5, R, R * 0.8, 0, 0, 6.283); g.fill();
    g.fillStyle = sunk ? '#9aa' : '#fff';
    g.beginPath(); g.arc(ball.x, ball.y, R, 0, 6.283); g.fill();
    g.fillStyle = 'rgba(0,0,0,.18)';
    g.beginPath(); g.arc(ball.x + 1.5, ball.y + 1.5, R * 0.55, 0, 6.283); g.fill();
    g.strokeStyle = 'rgba(0,0,0,.4)'; g.lineWidth = 1;
    g.beginPath(); g.arc(ball.x, ball.y, R, 0, 6.283); g.stroke();
  }

  /* The line the ball will leave on, an arrowhead on the end of it, and a
     meter that says how hard. Guessing at the power was the one thing these
     games never told you and always should have. */
  function drawAim() {
    const p = Math.hypot(aim.dx, aim.dy) / MAX_PULL;
    const a = Math.atan2(-aim.dy, -aim.dx);
    const len = 26 + p * 120;
    const ex = ball.x + Math.cos(a) * len, ey = ball.y + Math.sin(a) * len;
    const col = p > 0.85 ? '#ff6a4a' : p > 0.55 ? '#ffd23a' : '#b8f0a0';

    g.strokeStyle = 'rgba(0,0,0,.45)'; g.lineWidth = 4;
    g.beginPath(); g.moveTo(ball.x, ball.y); g.lineTo(ex, ey); g.stroke();
    g.strokeStyle = col; g.lineWidth = 2;
    g.setLineDash([5, 4]);
    g.beginPath(); g.moveTo(ball.x, ball.y); g.lineTo(ex, ey); g.stroke();
    g.setLineDash([]);
    g.fillStyle = col;
    g.beginPath();
    g.moveTo(ex + Math.cos(a) * 9, ey + Math.sin(a) * 9);
    g.lineTo(ex + Math.cos(a + 2.5) * 8, ey + Math.sin(a + 2.5) * 8);
    g.lineTo(ex + Math.cos(a - 2.5) * 8, ey + Math.sin(a - 2.5) * 8);
    g.closePath(); g.fill();

    // where you have dragged to, so a long pull is legible on a small canvas
    g.strokeStyle = 'rgba(255,255,255,.5)'; g.lineWidth = 1;
    g.setLineDash([2, 3]);
    g.beginPath(); g.moveTo(ball.x, ball.y); g.lineTo(ball.x - aim.dx, ball.y - aim.dy); g.stroke();
    g.setLineDash([]);

    g.fillStyle = 'rgba(0,0,0,.6)'; g.fillRect(10, H - 26, 124, 16);
    g.fillStyle = '#e8e4d0'; g.font = 'bold 9px Tahoma, sans-serif';
    g.fillText('POWER', 14, H - 15);
    g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(56, H - 22, 72, 8);
    g.fillStyle = col; g.fillRect(57, H - 21, 70 * p, 6);
    g.strokeStyle = 'rgba(255,255,255,.4)'; g.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      g.beginPath(); g.moveTo(57 + 17.5 * i, H - 21); g.lineTo(57 + 17.5 * i, H - 15); g.stroke();
    }
  }

  function tick() {
    if (!running) return;
    t++;
    if (hole().windmill) spin += hole().windmill.speed;
    step();
    draw();
    raf = requestAnimationFrame(tick);
  }

  startHole();
  tick();
  return { stop };
}
