/*
 * Crazy golf, on the Boardwalk.
 *
 * Three holes, drag back from the ball to putt, and a windmill on the
 * third because there is always a windmill on the third.
 *
 * The ball is a circle with friction that bounces off axis-aligned walls,
 * which is all any of these ever were.
 */

import { h, clear, drag, pick } from '../../core/dom.js';
import * as A from '../../core/audio.js';
import { faceSvg, faceFor } from './faces.js';
import { ART } from '../../assets/art.js';
import { PERSONAS } from '../halcyon/people.js';

const W = 420, H = 280;
const R = 6;                       // ball radius
const CUP = 10;                    // cup radius
const FRICTION = 0.978, BOUNCE = 0.68, STOP = 0.14, MAX_PULL = 92;

/* Walls are [x, y, w, h]. The border is added to every hole. */
const HOLES = [
  {
    name: 'The Straight One', par: 2,
    tee: [60, 210], cup: [350, 70],
    walls: [[140, 120, 20, 160], [260, 0, 20, 160]],
  },
  {
    name: 'The Dog-leg', par: 3,
    tee: [55, 55], cup: [360, 225],
    walls: [[110, 0, 18, 150], [110, 150, 200, 18], [230, 168, 18, 60], [300, 60, 18, 110]],
  },
  {
    name: 'The Windmill', par: 4,
    tee: [60, 140], cup: [365, 140],
    walls: [[150, 0, 16, 96], [150, 184, 16, 96], [250, 0, 16, 70], [250, 210, 16, 70]],
    windmill: { x: 208, y: 140, len: 62, speed: 0.028 },
  },
];

export function openGolf(stage, session, myFace, onBack) {
  const rival = pick(PERSONAS);
  const canvas = h('canvas', { width: W, height: H, class: 'gf-canvas' });
  const card = h('div.gf-card');
  const status = h('div.gf-status', {}, 'Drag back from the ball and let go.');
  const said = h('div.gf-said');

  clear(stage).append(h('div.gf', {},
    h('div.gf-bar', {},
      h('button.rev-back', { type: 'button', onclick: () => stop(onBack) }, '◀ The Boardwalk'),
      h('b', {}, 'Crazy Golf')),
    h('div.gf-banner', { style: { backgroundImage: 'url(' + ART.game_golf + ')' } }),
    h('div.gf-main', {},
      h('div.gf-side', {},
        h('div.gf-pilot', {},
          h('div.gf-face', {}, faceSvg(myFace, 34)), h('span', {}, session.name)),
        card,
        said,
        h('div.gf-pilot.small', {},
          h('div.gf-face', {}, faceSvg(faceFor(rival.name), 26)),
          h('span', {}, rival.name + ' is watching'))),
      h('div.gf-stage', {}, canvas)),
    status));

  const g = canvas.getContext('2d');
  let holeIx = 0, strokes = 0, total = 0, sunk = false, running = true;
  let ball = { x: 0, y: 0, vx: 0, vy: 0 };
  let aim = null;                  // {dx, dy} while dragging
  let spin = 0, raf = 0;
  const scores = [];

  const hole = () => HOLES[holeIx];

  function wallsOf(hl) {
    return [
      [0, 0, W, 8], [0, H - 8, W, 8], [0, 0, 8, H], [W - 8, 0, 8, H],
      ...hl.walls,
    ];
  }

  function startHole() {
    sunk = false; strokes = 0;
    ball = { x: hole().tee[0], y: hole().tee[1], vx: 0, vy: 0 };
    status.textContent = hole().name + ' — par ' + hole().par + '. Drag back and let go.';
    drawCard();
  }

  function drawCard() {
    clear(card).append(
      h('div.gf-hole', {}, 'Hole ' + (holeIx + 1) + ' of ' + HOLES.length),
      h('div.gf-par', {}, 'Par ' + hole().par + '   Strokes ' + strokes),
      h('div.gf-total', {}, 'Total ' + total),
      ...scores.map((s, i) => h('div.gf-score', {},
        'Hole ' + (i + 1) + ': ' + s + verdict(s, HOLES[i].par))));
  }

  const verdict = (s, par) =>
    s === 1 ? '  hole in one!' : s === par - 1 ? '  birdie' : s === par ? '  par'
      : s === par + 1 ? '  bogey' : s > par + 1 ? '  ouch' : '  eagle';

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
    const t = Math.max(0, Math.min(1,
      ((ball.x - seg.x1) * dx + (ball.y - seg.y1) * dy) / (dx * dx + dy * dy)));
    const px = seg.x1 + dx * t, py = seg.y1 + dy * t;
    return { d: Math.hypot(ball.x - px, ball.y - py), px, py };
  }

  function step() {
    if (sunk) return;
    ball.x += ball.vx; ball.y += ball.vy;
    ball.vx *= FRICTION; ball.vy *= FRICTION;

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
      if (Math.hypot(ball.vx, ball.vy) > 1) A.click();
    }

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
    const speed = Math.hypot(ball.vx, ball.vy);
    if (dh < CUP - 2 && speed < 3.4) return sink();
    if (dh < CUP + 2 && speed < 5) {                    // lipped out
      ball.vx += (hx - ball.x) * 0.05;
      ball.vy += (hy - ball.y) * 0.05;
    }
    if (speed < STOP) { ball.vx = 0; ball.vy = 0; }
  }

  function sink() {
    sunk = true;
    ball.vx = ball.vy = 0;
    total += strokes;
    scores.push(strokes);
    A.startupChime();
    say(strokes === 1 ? 'wow' : strokes <= hole().par ? 'nice one' : 'that stinks');
    status.textContent = 'In. ' + strokes + ' stroke' + (strokes === 1 ? '' : 's') +
      verdict(strokes, hole().par).trim() + '.';
    drawCard();

    setTimeout(() => {
      if (!running) return;
      if (holeIx < HOLES.length - 1) { holeIx++; startHole(); return; }
      const par = HOLES.reduce((n, x) => n + x.par, 0);
      status.textContent = 'Round finished: ' + total + ' against a par of ' + par + '. ' +
        (total <= par ? 'The pier is impressed.' : 'The windmill is undefeated.');
      stage.querySelector('.gf-bar').append(h('button.aol-btn.small', {
        type: 'button', onclick: () => { stop(); openGolf(stage, session, myFace, onBack); },
      }, 'Play Again'));
    }, 1700);
  }

  /* ── aiming ─────────────────────────────────────────────────────────── */

  const at = ev => {
    const r = canvas.getBoundingClientRect();
    return { x: (ev.clientX - r.left) * (W / r.width), y: (ev.clientY - r.top) * (H / r.height) };
  };

  drag(canvas,
    ev => {
      if (sunk || Math.hypot(ball.vx, ball.vy) > STOP) return false;
      const p = at(ev);
      if (Math.hypot(p.x - ball.x, p.y - ball.y) > 34) return false;
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
        ball.vx = -aim.dx * 0.13; ball.vy = -aim.dy * 0.13;
        strokes++;
        A.doorClose();
        drawCard();
      }
      aim = null;
    });

  /* ── drawing ────────────────────────────────────────────────────────── */

  function draw() {
    g.fillStyle = '#2f6b34'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#357a3a';
    for (let y = 0; y < H; y += 12) g.fillRect(0, y, W, 6);

    g.fillStyle = '#7a5a34';
    for (const [x, y, w, hgt] of wallsOf(hole())) {
      g.fillRect(x, y, w, hgt);
      g.fillStyle = 'rgba(255,255,255,.18)';
      g.fillRect(x, y, w, 2);
      g.fillStyle = '#7a5a34';
    }

    const [hx, hy] = hole().cup;
    g.fillStyle = '#12240f';
    g.beginPath(); g.arc(hx, hy, CUP, 0, 6.283); g.fill();
    g.strokeStyle = '#d8d8c0'; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(hx, hy); g.lineTo(hx, hy - 26); g.stroke();
    g.fillStyle = '#d63a3a';
    g.beginPath(); g.moveTo(hx, hy - 26); g.lineTo(hx + 15, hy - 21); g.lineTo(hx, hy - 16);
    g.closePath(); g.fill();

    const seg = windmillSegment();
    if (seg) {
      const wm = hole().windmill;
      g.fillStyle = '#8a3a2a';
      g.fillRect(wm.x - 12, wm.y - 12, 24, 24);
      g.strokeStyle = '#e8e0c8'; g.lineWidth = 6; g.lineCap = 'round';
      g.beginPath(); g.moveTo(seg.x1, seg.y1); g.lineTo(seg.x2, seg.y2); g.stroke();
      g.lineCap = 'butt';
    }

    if (aim) {
      g.strokeStyle = 'rgba(255,255,255,.85)'; g.lineWidth = 2;
      g.setLineDash([4, 4]);
      g.beginPath();
      g.moveTo(ball.x, ball.y);
      g.lineTo(ball.x - aim.dx, ball.y - aim.dy);
      g.stroke();
      g.setLineDash([]);
      const p = Math.hypot(aim.dx, aim.dy) / MAX_PULL;
      g.fillStyle = 'rgba(0,0,0,.5)'; g.fillRect(10, H - 20, 90, 10);
      g.fillStyle = p > 0.8 ? '#e8563a' : '#ffd23a';
      g.fillRect(11, H - 19, 88 * p, 8);
    }

    g.fillStyle = 'rgba(0,0,0,.3)';
    g.beginPath(); g.ellipse(ball.x + 1.5, ball.y + 2.5, R, R * 0.8, 0, 0, 6.283); g.fill();
    g.fillStyle = sunk ? '#9aa' : '#fff';
    g.beginPath(); g.arc(ball.x, ball.y, R, 0, 6.283); g.fill();
    g.strokeStyle = 'rgba(0,0,0,.35)'; g.lineWidth = 1; g.stroke();
  }

  function tick() {
    if (!running) return;
    if (hole().windmill) spin += hole().windmill.speed;
    step();
    draw();
    raf = requestAnimationFrame(tick);
  }

  startHole();
  tick();
  return { stop };
}
