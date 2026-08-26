/*
 * Dawn Patrol — the dogfight at Sky Squadron.
 *
 * The flight games were the reason a lot of people paid by the hour, and
 * the reason was always the same: somebody else was flying the other one.
 * Here the other one is a program, but it flies the same aeroplane under
 * the same physics and it is trying to get behind you.
 *
 * The model is arcade rather than aerodynamic — thrust along the nose,
 * lift across it, gravity, drag, and a stall if you get too slow — which
 * is what the home-computer flight games of the era actually did once you
 * got past the manual. What they mostly did not do, and this does, is tell
 * you your airspeed while you are busy losing it.
 */

import { h, pick } from '../../core/dom.js';
import * as A from '../../core/audio.js';
import { faceFor } from './faces.js';
import { portrait, btn, shell } from './ui.js';
import { ART } from '../../assets/art.js';
import { PERSONAS } from '../halcyon/people.js';

const W = 480, H = 280;
const GROUND = H - 30;
const THRUST = 0.18, GRAVITY = 0.055, DRAG = 0.992, TURN = 0.055;
const LIFT = 0.030, LIFT_MAX = 0.064;   // roughly cancels gravity at cruise
const STALL = 1.1, VNE = 6.2;           // stalling speed and never-exceed
const BULLET_SPEED = 5.2, RELOAD = 260, HITS = 4;

const CHATTER = {
  start: ['good luck', 'anyone want to play?', 'nice to meet you'],
  hit: ['nice move', 'wow', 'i did not see that coming'],
  took: ['oh no', 'that stinks', 'haha'],
  win: ['good game', 'one more?'],
  lose: ['good game', 'nice one'],
};

/* One fixed range of hills per sortie, so the horizon does not shimmer. */
function ridge(seed, n, base, amp) {
  let s = seed >>> 0;
  const pts = [];
  for (let i = 0; i <= n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    pts.push(base - ((s >>> 9) / 8388608) * amp);
  }
  return pts;
}

export function openDawn(stage, session, myFace, onBack) {
  const rival = pick(PERSONAS);
  const canvas = h('canvas', { width: W, height: H, class: 'gm-canvas' });
  const said = h('div.gm-said');
  const yourHearts = h('span.gm-hearts');
  const theirHearts = h('span.gm-hearts');

  const { bar, note } = shell(stage, {
    ground: 'blue', title: 'Dawn Patrol  ·  Sky Squadron',
    art: ART.game_dawn,
    backLabel: 'The Airfield', onBack: () => stop(onBack),
    side: [
      portrait(myFace, session.name, { size: 58, cls: 'me' }), yourHearts,
      said,
      portrait(faceFor(rival.name), rival.name, { size: 58 }), theirHearts,
    ],
    middle: h('div.rev-frame', {}, canvas),
    note: 'Up and Down fly. Left and Right work the throttle. Space fires.',
  });
  const status = text => { note.textContent = text; };

  const g = canvas.getContext('2d');
  let raf = 0, running = true, over = false, t = 0;

  const plane = (x, y, a, mine) => ({
    x, y, a, vx: Math.cos(a) * 2.6, vy: Math.sin(a) * 2.6,
    hits: HITS, cool: 0, mine, stalled: false, throttle: 0.75, grace: 0,
    trail: [],
  });
  let you = plane(90, 110, 0, true);
  let foe = plane(W - 90, 140, Math.PI, false);
  let bullets = [];
  const keys = new Set();

  const far = ridge(7, 24, GROUND - 26, 26);
  const near = ridge(29, 18, GROUND - 4, 18);

  const onKey = ev => {
    const k = ev.key;
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(k)) ev.preventDefault();
    if (ev.type === 'keydown') keys.add(k); else keys.delete(k);
  };
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKey);

  function stop(then) {
    running = false;
    cancelAnimationFrame(raf);
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('keyup', onKey);
    if (then) then();
  }

  function say(bank) {
    said.textContent = pick(CHATTER[bank]);
    setTimeout(() => { if (running) said.textContent = ''; }, 3800);
  }

  /* ── flight ─────────────────────────────────────────────────────────── */

  function fly(p, turn, throttleDelta) {
    p.throttle = Math.max(0, Math.min(1, p.throttle + throttleDelta * 0.03));
    p.a += turn * TURN * (p.stalled ? 0.4 : 1);
    const speed = Math.hypot(p.vx, p.vy);

    // Below flying speed the nose drops whatever the stick says.
    p.stalled = speed < STALL;
    if (p.stalled) p.a += (Math.PI / 2 - p.a) * 0.02;

    /* A holed engine will not make full power. Losing height you cannot get
       back is a better punishment than losing a life outright. */
    const power = THRUST * p.throttle * (p.hits <= 1 ? 0.6 : p.hits <= 2 ? 0.85 : 1);
    p.vx += Math.cos(p.a) * power;
    p.vy += Math.sin(p.a) * power + GRAVITY;

    /* Lift, perpendicular to the nose and proportional to airspeed. Without
       it a level aeroplane sinks like a brick with an engine on it, and the
       stall means nothing because there is nothing to lose. */
    const l = Math.min(speed * LIFT, LIFT_MAX);
    p.vx += Math.cos(p.a - Math.PI / 2) * l;
    p.vy += Math.sin(p.a - Math.PI / 2) * l;

    p.vx *= DRAG; p.vy *= DRAG;

    p.x += p.vx; p.y += p.vy;
    if (p.x < -20) p.x = W + 20;
    if (p.x > W + 20) p.x = -20;
    if (p.y < 14) { p.y = 14; p.vy = Math.abs(p.vy) * 0.4; }

    /* Touching the ground must cost one aeroplane, not one per frame:
       without the grace period a gentle taxi wrote off the whole machine
       in four frames. Scraping along is survivable; arriving is not. */
    if (p.y > GROUND - 6) {
      const impact = p.vy;
      p.y = GROUND - 6;
      p.vy = -Math.abs(p.vy) * 0.35;
      p.a *= 0.8;                              // the nose comes up off the grass
      if (impact > 1.5 && p.grace <= 0) { p.grace = 70; damage(p, 1); }
    }
    if (p.grace > 0) p.grace--;
    if (p.cool > 0) p.cool -= 16;

    /* A wounded machine leaves a trail, which is how you know at a glance
       who is in trouble without reading the hearts. */
    if (p.hits < HITS && p.hits > 0 && t % 2 === 0) {
      p.trail.push({ x: p.x - Math.cos(p.a) * 12, y: p.y - Math.sin(p.a) * 12, ttl: 34 });
    }
    p.trail = p.trail.filter(s => --s.ttl > 0);
  }

  function fire(p) {
    if (p.cool > 0 || p.hits <= 0) return;
    p.cool = RELOAD;
    bullets.push({
      x: p.x + Math.cos(p.a) * 14, y: p.y + Math.sin(p.a) * 14,
      vx: Math.cos(p.a) * BULLET_SPEED + p.vx * 0.4,
      vy: Math.sin(p.a) * BULLET_SPEED + p.vy * 0.4,
      ttl: 90, mine: p.mine,
    });
    A.click();
  }

  function damage(p, n) {
    if (over || p.hits <= 0) return;
    p.hits -= n;
    A.beep();
    hearts();
    if (p.hits <= 0) finish(p.mine ? 'lose' : 'win');
  }

  function hearts() {
    const draw = (el, n) => {
      el.textContent = '♥'.repeat(Math.max(0, n)) + '·'.repeat(HITS - Math.max(0, n));
      el.classList.toggle('gone', n <= 0);
    };
    draw(yourHearts, you.hits);
    draw(theirHearts, foe.hits);
  }

  /* The opponent: turn toward where you will be, fire when lined up. */
  function think() {
    if (foe.hits <= 0) return { turn: 0, throttle: 0, shoot: false };
    const lead = 12;
    const tx = you.x + you.vx * lead, ty = you.y + you.vy * lead;
    const want = Math.atan2(ty - foe.y, tx - foe.x);
    let d = ((want - foe.a + Math.PI * 3) % (Math.PI * 2)) - Math.PI;

    // Pull up early rather than fly into the ground.
    if (foe.y > GROUND - 60 && Math.sin(foe.a) > 0) d = -1;

    const range = Math.hypot(tx - foe.x, ty - foe.y);
    const speed = Math.hypot(foe.vx, foe.vy);
    // Throttle back inside a turn, open up on the way in, never stall.
    const throttle = speed < STALL * 1.6 ? 1
      : Math.abs(d) > 1.1 ? -1
      : range > 200 ? 1 : 0;
    const aligned = Math.abs(d) < 0.22 && range < 220;
    return { turn: Math.sign(d) * Math.min(1, Math.abs(d) * 2.4), throttle, shoot: aligned };
  }

  function finish(how) {
    if (over) return;
    over = true;
    status(how === 'win'
      ? 'You got him. ' + rival.name + ' is walking back across the field.'
      : 'He got you. There is another aeroplane in the hangar.');
    say(how === 'win' ? 'lose' : 'win');
    how === 'win' ? A.startupChime() : A.ding();
    bar.insertBefore(
      btn('Again', () => { stop(); openDawn(stage, session, myFace, onBack); }, { cls: 'go' }),
      bar.querySelector('.spacer'));
  }

  /* ── drawing ────────────────────────────────────────────────────────── */

  const clouds = Array.from({ length: 7 }, () => ({
    x: Math.random() * W, y: 20 + Math.random() * 90,
    r: 14 + Math.random() * 22, s: 0.12 + Math.random() * 0.22,
  }));

  function hills(pts, colour, drift) {
    const step = W / (pts.length - 1);
    const off = (t * drift) % step;
    g.fillStyle = colour;
    g.beginPath();
    g.moveTo(-off, H);
    pts.forEach((y, i) => g.lineTo(i * step - off, y));
    g.lineTo(W + step, H);
    g.closePath(); g.fill();
  }

  /* The field itself: a hangar, a windsock that reads the wind you do not
     have, and a mown strip. Fixed scenery, so the ground means something. */
  function field() {
    g.fillStyle = '#4a6b30'; g.fillRect(0, GROUND, W, H - GROUND);
    g.fillStyle = '#3d5a28';
    for (let x = 0; x < W; x += 26) g.fillRect(x, GROUND, 13, 4);
    g.fillStyle = '#6b5a3a'; g.fillRect(40, GROUND + 12, W - 80, 5);

    g.fillStyle = '#6a4a2c'; g.fillRect(46, GROUND - 18, 44, 18);
    g.fillStyle = '#8a6440';
    g.beginPath(); g.moveTo(42, GROUND - 18); g.lineTo(68, GROUND - 28);
    g.lineTo(94, GROUND - 18); g.closePath(); g.fill();
    g.fillStyle = '#2a1c10'; g.fillRect(60, GROUND - 12, 16, 12);

    g.strokeStyle = '#c8c0a8'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(W - 60, GROUND); g.lineTo(W - 60, GROUND - 26); g.stroke();
    const wag = Math.sin(t * 0.04) * 3;
    g.fillStyle = '#e8a030';
    g.beginPath();
    g.moveTo(W - 59, GROUND - 26); g.lineTo(W - 40, GROUND - 23 + wag);
    g.lineTo(W - 59, GROUND - 19); g.closePath(); g.fill();
  }

  function drawPlane(p, colour, trim) {
    for (const s of p.trail) {
      const k = s.ttl / 34;
      g.fillStyle = p.hits <= 1
        ? 'rgba(' + (240 - k * 60 | 0) + ',' + (120 * k | 0) + ',40,' + (k * 0.7).toFixed(2) + ')'
        : 'rgba(70,70,70,' + (k * 0.5).toFixed(2) + ')';
      g.beginPath(); g.arc(s.x, s.y, 2 + (1 - k) * 5, 0, 6.283); g.fill();
    }

    g.save();
    g.translate(p.x, p.y);
    g.rotate(p.a);
    if (p.hits <= 0) g.globalAlpha = 0.35;

    g.fillStyle = colour;
    g.beginPath();                                   // fuselage
    g.moveTo(15, 0); g.lineTo(-8, -4); g.lineTo(-12, 0); g.lineTo(-8, 4);
    g.closePath(); g.fill();
    g.fillStyle = trim;
    g.fillRect(-5, -10, 4, 20);                      // lower wing
    g.fillRect(2, -8, 3, 16);                        // upper wing
    g.fillStyle = colour;
    g.fillRect(-12, -6, 3, 12);                      // tail
    g.fillStyle = '#2a2a2a';
    g.fillRect(-1, -1.5, 4, 3);                      // cockpit
    g.fillStyle = 'rgba(220,220,220,.5)';            // propeller disc
    g.fillRect(15, -6 - (t % 3), 2, 12);
    g.strokeStyle = 'rgba(0,0,0,.55)'; g.lineWidth = 1;
    g.strokeRect(-5, -10, 4, 20);
    g.restore();
  }

  /* The instruments, such as they are: how fast, how high, how much
     throttle, and a red light when the wing stops working. */
  function hud() {
    const speed = Math.hypot(you.vx, you.vy);
    const alt = Math.max(0, GROUND - 6 - you.y);

    g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(6, 6, 104, 44);
    g.strokeStyle = 'rgba(255,255,255,.3)'; g.lineWidth = 1; g.strokeRect(6.5, 6.5, 103, 43);
    g.font = 'bold 8px Tahoma, sans-serif';

    const gauge = (y, label, frac, colour) => {
      g.fillStyle = '#cfd6e8'; g.fillText(label, 11, y + 7);
      g.fillStyle = 'rgba(255,255,255,.15)'; g.fillRect(42, y, 62, 7);
      g.fillStyle = colour; g.fillRect(42, y, 62 * Math.max(0, Math.min(1, frac)), 7);
    };
    gauge(11, 'SPD', speed / VNE,
      speed < STALL ? '#ff5040' : speed > VNE ? '#ffd23a' : '#7fe0a0');
    gauge(24, 'ALT', alt / (GROUND - 20), alt < 34 ? '#ff5040' : '#8fb6e8');
    gauge(37, 'THR', you.throttle, '#ffd23a');

    // the stalling speed, marked on the dial where it belongs
    g.fillStyle = '#ffffff'; g.fillRect(42 + 62 * (STALL / VNE), 11, 1, 7);

    if (you.stalled && you.hits > 0 && t % 30 < 18) {
      g.fillStyle = '#ff5040';
      g.font = 'bold 13px Tahoma, sans-serif';
      g.fillText('STALL', W / 2 - 20, 24);
    }
    if (you.hits <= 1 && you.hits > 0 && t % 40 < 24) {
      g.fillStyle = '#ffa030';
      g.font = 'bold 10px Tahoma, sans-serif';
      g.fillText('ENGINE', W / 2 - 21, 40);
    }
  }

  function draw() {
    const sky = g.createLinearGradient(0, 0, 0, GROUND);
    sky.addColorStop(0, '#2a3f6e');
    sky.addColorStop(0.55, '#c97a4a');
    sky.addColorStop(1, '#f0c06a');
    g.fillStyle = sky; g.fillRect(0, 0, W, GROUND);

    g.fillStyle = '#ffe0a0';
    g.beginPath(); g.arc(W - 96, GROUND - 66, 20, 0, 6.283); g.fill();

    g.fillStyle = 'rgba(255,255,255,.55)';
    for (const c of clouds) {
      c.x -= c.s;
      if (c.x < -c.r * 2) c.x = W + c.r * 2;
      g.beginPath();
      g.arc(c.x, c.y, c.r, 0, 6.283);
      g.arc(c.x + c.r * 0.7, c.y + 3, c.r * 0.7, 0, 6.283);
      g.arc(c.x - c.r * 0.7, c.y + 4, c.r * 0.6, 0, 6.283);
      g.fill();
    }

    hills(far, '#5a4a6a', 0.06);
    hills(near, '#3c5a34', 0.14);
    field();

    g.fillStyle = '#f4e07a';
    for (const b of bullets) g.fillRect(b.x - 1.5, b.y - 1.5, 3, 3);

    drawPlane(foe, '#c0392b', '#e87060');
    drawPlane(you, '#2e8b57', '#7fd0a0');
    hud();
  }

  function tick() {
    if (!running) return;
    t++;
    if (!over) {
      const turn = (keys.has('ArrowUp') ? -1 : 0) + (keys.has('ArrowDown') ? 1 : 0);
      const thr = (keys.has('ArrowRight') ? 1 : 0) + (keys.has('ArrowLeft') ? -1 : 0);
      fly(you, turn, thr);
      if (keys.has(' ')) fire(you);

      const ai = think();
      fly(foe, ai.turn, ai.throttle);
      if (ai.shoot) fire(foe);

      for (const b of bullets) {
        b.x += b.vx; b.y += b.vy; b.vy += GRAVITY * 0.25; b.ttl--;
        const target = b.mine ? foe : you;
        if (target.hits > 0 && Math.hypot(b.x - target.x, b.y - target.y) < 10) {
          b.ttl = 0;
          damage(target, 1);
          say(b.mine ? 'took' : 'hit');
        }
      }
      bullets = bullets.filter(b => b.ttl > 0 && b.x > -30 && b.x < W + 30 && b.y < GROUND);
    }
    draw();
    raf = requestAnimationFrame(tick);
  }

  hearts();
  say('start');
  tick();
  return { stop };
}
