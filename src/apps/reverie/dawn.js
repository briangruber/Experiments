/*
 * Dawn Patrol — the dogfight at Sky Squadron.
 *
 * The flight games were the reason a lot of people paid by the hour, and
 * the reason was always the same: somebody else was flying the other one.
 * Here the other one is a program, but it flies the same aeroplane under
 * the same physics and it is trying to get behind you.
 *
 * The model is arcade rather than aerodynamic — thrust along the nose,
 * gravity, drag, and a stall if you climb too slowly — which is what the
 * home-computer flight games of the era actually did once you got past
 * the manual.
 */

import { h, clear, pick } from '../../core/dom.js';
import * as A from '../../core/audio.js';
import { faceSvg, faceFor } from './faces.js';
import { ART } from '../../assets/art.js';
import { PERSONAS } from '../halcyon/people.js';

const W = 480, H = 260;
const GROUND = H - 26;
const THRUST = 0.16, GRAVITY = 0.055, DRAG = 0.992, TURN = 0.055;
const LIFT = 0.030, LIFT_MAX = 0.064;   // roughly cancels gravity at cruise
const BULLET_SPEED = 5.2, RELOAD = 260, HITS = 4;

const CHATTER = {
  start: ['good luck', 'anyone want to play?', 'nice to meet you'],
  hit: ['nice move', 'wow', 'i did not see that coming'],
  took: ['oh no', 'that stinks', 'haha'],
  win: ['good game', 'one more?'],
  lose: ['good game', 'nice one'],
};

export function openDawn(stage, session, myFace, onBack) {
  const rival = pick(PERSONAS);
  const canvas = h('canvas', { width: W, height: H, class: 'dp-canvas' });
  const said = h('div.dp-said');
  const scoreYou = h('b'), scoreThem = h('b');
  const status = h('div.dp-status', {},
    'Arrow keys fly, space fires. Keep your speed up or you will stall.');

  clear(stage).append(h('div.dp', {},
    h('div.dp-bar', {},
      h('button.rev-back', { type: 'button', onclick: () => stop(onBack) }, '◀ The Airfield'),
      h('b', {}, 'Dawn Patrol')),
    h('div.dp-banner', { style: { backgroundImage: 'url(' + ART.game_dawn + ')' } }),
    h('div.dp-main', {},
      h('div.dp-side', {},
        h('div.dp-pilot', {},
          h('div.dp-face', {}, faceSvg(myFace, 38)),
          h('span', {}, session.name), scoreYou),
        said,
        h('div.dp-pilot', {},
          h('div.dp-face', {}, faceSvg(faceFor(rival.name), 38)),
          h('span', {}, rival.name), scoreThem)),
      h('div.dp-stage', {}, canvas)),
    status));

  const g = canvas.getContext('2d');
  let raf = 0, running = true, over = false;

  const plane = (x, y, a, mine) => ({
    x, y, a, vx: Math.cos(a) * 2.4, vy: Math.sin(a) * 2.4,
    hits: HITS, cool: 0, mine, stalled: false, smoke: 0, grace: 0,
  });
  let you = plane(90, 110, 0, true);
  let foe = plane(W - 90, 140, Math.PI, false);
  let bullets = [];
  const keys = new Set();

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

  function fly(p, turn, thrust) {
    p.a += turn * TURN;
    const speed = Math.hypot(p.vx, p.vy);

    // Below flying speed the nose drops whatever the stick says.
    p.stalled = speed < 1.1;
    if (p.stalled) p.a += (Math.PI / 2 - p.a) * 0.02;

    const t = thrust ? THRUST : THRUST * 0.55;
    p.vx += Math.cos(p.a) * t;
    p.vy += Math.sin(p.a) * t + GRAVITY;

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
    p.smoke = 40;
    A.beep();
    if (p.hits <= 0) finish(p.mine ? 'lose' : 'win');
  }

  /* The opponent: turn toward where you will be, fire when lined up. */
  function think() {
    if (foe.hits <= 0) return { turn: 0, thrust: true, shoot: false };
    const lead = 12;
    const tx = you.x + you.vx * lead, ty = you.y + you.vy * lead;
    let want = Math.atan2(ty - foe.y, tx - foe.x);
    let d = ((want - foe.a + Math.PI * 3) % (Math.PI * 2)) - Math.PI;

    // Pull up early rather than fly into the ground.
    if (foe.y > GROUND - 60 && Math.sin(foe.a) > 0) d = -1;
    const aligned = Math.abs(d) < 0.22 && Math.hypot(tx - foe.x, ty - foe.y) < 220;
    return { turn: Math.sign(d) * Math.min(1, Math.abs(d) * 2.4), thrust: true, shoot: aligned };
  }

  function finish(how) {
    if (over) return;
    over = true;
    status.textContent = how === 'win'
      ? 'You got him. ' + rival.name + ' is walking back across the field.'
      : 'He got you. There is another aeroplane in the hangar.';
    say(how === 'win' ? 'lose' : 'win');
    how === 'win' ? A.startupChime() : A.ding();
    stage.querySelector('.dp-bar').append(h('button.aol-btn.small', {
      type: 'button',
      onclick: () => { stop(); openDawn(stage, session, myFace, onBack); },
    }, 'Again'));
  }

  /* ── drawing ────────────────────────────────────────────────────────── */

  const clouds = Array.from({ length: 7 }, () => ({
    x: Math.random() * W, y: 20 + Math.random() * 110,
    r: 14 + Math.random() * 22, s: 0.12 + Math.random() * 0.22,
  }));

  function drawPlane(p, colour) {
    g.save();
    g.translate(p.x, p.y);
    g.rotate(p.a);
    if (p.hits <= 0) g.globalAlpha = 0.35;
    g.fillStyle = colour;
    g.beginPath();                                   // fuselage
    g.moveTo(14, 0); g.lineTo(-8, -4); g.lineTo(-11, 0); g.lineTo(-8, 4);
    g.closePath(); g.fill();
    g.fillRect(-4, -9, 4, 18);                       // wings
    g.fillRect(-11, -5, 3, 10);                      // tail
    g.strokeStyle = 'rgba(0,0,0,.55)'; g.lineWidth = 1;
    g.strokeRect(-4, -9, 4, 18);
    g.restore();
    if (p.smoke > 0) {
      p.smoke--;
      g.fillStyle = 'rgba(60,60,60,' + (p.smoke / 90).toFixed(2) + ')';
      g.beginPath(); g.arc(p.x - p.vx * 3, p.y - p.vy * 3, 5, 0, 6.283); g.fill();
    }
  }

  function draw() {
    const sky = g.createLinearGradient(0, 0, 0, GROUND);
    sky.addColorStop(0, '#2a3f6e');
    sky.addColorStop(0.55, '#c97a4a');
    sky.addColorStop(1, '#f0c06a');
    g.fillStyle = sky; g.fillRect(0, 0, W, GROUND);

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

    g.fillStyle = '#4a6b30'; g.fillRect(0, GROUND, W, H - GROUND);
    g.fillStyle = '#3d5a28';
    for (let x = 0; x < W; x += 26) g.fillRect(x, GROUND, 13, 4);

    g.fillStyle = '#f4e07a';
    for (const b of bullets) g.fillRect(b.x - 1.5, b.y - 1.5, 3, 3);

    drawPlane(foe, '#c0392b');
    drawPlane(you, '#2e8b57');

    if (you.stalled && you.hits > 0) {
      g.fillStyle = '#ffe066';
      g.font = 'bold 12px Tahoma, sans-serif';
      g.fillText('STALL', you.x - 16, you.y - 14);
    }
  }

  function tick() {
    if (!running) return;
    if (!over) {
      const turn = (keys.has('ArrowUp') ? -1 : 0) + (keys.has('ArrowDown') ? 1 : 0);
      fly(you, turn, !keys.has('ArrowLeft'));
      if (keys.has(' ')) fire(you);

      const ai = think();
      fly(foe, ai.turn, ai.thrust);
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

      scoreYou.textContent = '♥'.repeat(Math.max(0, you.hits));
      scoreThem.textContent = '♥'.repeat(Math.max(0, foe.hits));
    }
    draw();
    raf = requestAnimationFrame(tick);
  }

  say('start');
  tick();
  return { stop };
}
