/* Four screensavers on one canvas. They kick in after 75 seconds of not
   touching anything, and the first input kills them — including the
   pointer move that woke you up, which is the correct behaviour and was
   also the most annoying part of the era. */

import { h, clear, $, pick } from '../core/dom.js';

let raf = 0, running = false;

export const saverRunning = () => running;

export function stopSaver() {
  if (!running) return;
  running = false;
  cancelAnimationFrame(raf);
  const layer = $('#screensaver');
  layer.hidden = true;
  clear(layer);
}

export function startSaver(kind = 'floppies') {
  if (running) return;
  running = true;
  const layer = clear($('#screensaver'));
  layer.hidden = false;

  const canvas = h('canvas');
  layer.append(canvas);
  const g = canvas.getContext('2d');

  const fit = () => {
    const r = layer.getBoundingClientRect();
    canvas.width = Math.max(1, r.width | 0);
    canvas.height = Math.max(1, r.height | 0);
  };
  fit();
  const onResize = () => fit();
  window.addEventListener('resize', onResize);

  const saver = ({ floppies, starfield, mystify, marquee })[kind] || floppies;
  const step = saver(g, canvas);

  const frame = () => {
    if (!running) { window.removeEventListener('resize', onResize); return; }
    step();
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
}

/* ── flying floppy disks ─────────────────────────────────────────────
   The one everybody remembers had toasters. This one has the other thing
   that filled a 1997 desk drawer. */

function floppies(g, c) {
  const N = 26;
  const disks = Array.from({ length: N }, () => spawn(c, true));

  return () => {
    g.fillStyle = '#000010';
    g.fillRect(0, 0, c.width, c.height);
    for (let i = 0; i < disks.length; i++) {
      const d = disks[i];
      d.z -= d.v;
      d.wing += 0.22;
      if (d.z < 8) { disks[i] = spawn(c); continue; }
      const s = 260 / d.z;
      const x = c.width / 2 + d.x * s;
      const y = c.height / 2 + d.y * s;
      if (x < -80 || x > c.width + 80 || y < -80 || y > c.height + 80) { disks[i] = spawn(c); continue; }
      drawFloppy(g, x, y, s * 34, d.wing, d.tilt);
    }
  };
}

function spawn(c, anywhere = false) {
  return {
    x: (Math.random() - 0.5) * 900,
    y: (Math.random() - 0.5) * 700,
    z: anywhere ? 8 + Math.random() * 620 : 560 + Math.random() * 200,
    v: 1.6 + Math.random() * 2.6,
    wing: Math.random() * 6.283,
    tilt: (Math.random() - 0.5) * 0.5,
  };
}

function drawFloppy(g, x, y, size, wing, tilt) {
  if (size < 3) return;
  const s = size;
  g.save();
  g.translate(x, y);
  g.rotate(tilt);

  // wings, flapping
  const flap = Math.sin(wing) * 0.55;
  for (const dir of [-1, 1]) {
    g.save();
    g.scale(dir, 1);
    g.rotate(flap * 0.6);
    g.fillStyle = 'rgba(220,230,255,.75)';
    g.beginPath();
    g.moveTo(s * 0.42, -s * 0.05);
    g.quadraticCurveTo(s * 1.25, -s * (0.55 + flap * 0.4), s * 1.5, s * 0.18);
    g.quadraticCurveTo(s * 0.95, s * 0.12, s * 0.42, s * 0.22);
    g.closePath();
    g.fill();
    g.restore();
  }

  // the disk itself
  g.fillStyle = '#23262e';
  g.fillRect(-s * 0.45, -s * 0.45, s * 0.9, s * 0.9);
  g.fillStyle = '#c9ccd4';
  g.fillRect(-s * 0.2, -s * 0.45, s * 0.42, s * 0.36);
  g.fillStyle = '#4a505c';
  g.fillRect(-s * 0.08, -s * 0.42, s * 0.18, s * 0.28);
  g.fillStyle = '#e6e9ee';
  g.fillRect(-s * 0.34, s * 0.02, s * 0.62, s * 0.34);
  g.restore();
}

/* ── starfield ───────────────────────────────────────────────────────── */

function starfield(g, c) {
  const N = 480;
  const stars = Array.from({ length: N }, () => ({
    x: (Math.random() - 0.5) * 1600,
    y: (Math.random() - 0.5) * 1200,
    z: Math.random() * 900 + 1,
  }));
  return () => {
    g.fillStyle = 'rgba(0,0,0,.35)';
    g.fillRect(0, 0, c.width, c.height);
    const cx = c.width / 2, cy = c.height / 2;
    for (const s of stars) {
      const pz = s.z;
      s.z -= 9;
      if (s.z < 1) { s.z = 900; s.x = (Math.random() - 0.5) * 1600; s.y = (Math.random() - 0.5) * 1200; continue; }
      const k = 320 / s.z, pk = 320 / pz;
      const x = cx + s.x * k, y = cy + s.y * k;
      const px = cx + s.x * pk, py = cy + s.y * pk;
      const b = Math.min(1, (900 - s.z) / 620);
      g.strokeStyle = 'rgba(255,255,255,' + b.toFixed(2) + ')';
      g.lineWidth = b * 2.2;
      g.beginPath(); g.moveTo(px, py); g.lineTo(x, y); g.stroke();
    }
  };
}

/* ── mystify ─────────────────────────────────────────────────────────── */

function mystify(g, c) {
  const shapes = [0, 1].map(i => ({
    hue: i ? 190 : 300,
    pts: Array.from({ length: 4 }, () => ({
      x: Math.random() * c.width, y: Math.random() * c.height,
      vx: (Math.random() - 0.5) * 6, vy: (Math.random() - 0.5) * 6,
    })),
    trail: [],
  }));
  return () => {
    g.fillStyle = 'rgba(0,0,0,.10)';
    g.fillRect(0, 0, c.width, c.height);
    for (const sh of shapes) {
      for (const p of sh.pts) {
        p.x += p.vx; p.y += p.vy;
        if (p.x < 0 || p.x > c.width) { p.vx *= -1; p.x = Math.max(0, Math.min(c.width, p.x)); }
        if (p.y < 0 || p.y > c.height) { p.vy *= -1; p.y = Math.max(0, Math.min(c.height, p.y)); }
      }
      sh.trail.push(sh.pts.map(p => ({ x: p.x, y: p.y })));
      if (sh.trail.length > 16) sh.trail.shift();
      sh.trail.forEach((poly, i) => {
        const a = (i + 1) / sh.trail.length;
        g.strokeStyle = 'hsla(' + (sh.hue + i * 6) + ',90%,' + (45 + a * 25) + '%,' + (a * 0.9).toFixed(2) + ')';
        g.lineWidth = 2;
        g.beginPath();
        poly.forEach((p, j) => j ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y));
        g.closePath(); g.stroke();
      });
    }
  };
}

/* ── scrolling marquee ───────────────────────────────────────────────── */

const MESSAGES = [
  'DO NOT TURN OFF YOUR COMPUTER',
  'YOU HAVE 47 UNREAD MESSAGES',
  'PLEASE HANG UP THE PHONE',
  'HALCYON ONLINE  --  KEYWORD: FRIENDS',
  'INSERT DISK 2 OF 14',
];

function marquee(g, c) {
  const text = pick(MESSAGES);
  let x = c.width, hue = 0;
  return () => {
    g.fillStyle = '#000';
    g.fillRect(0, 0, c.width, c.height);
    const size = Math.max(28, Math.min(84, c.width / 14));
    g.font = 'bold ' + size + 'px Tahoma, sans-serif';
    hue = (hue + 0.7) % 360;
    const grad = g.createLinearGradient(x, 0, x + g.measureText(text).width, 0);
    grad.addColorStop(0, 'hsl(' + hue + ',95%,60%)');
    grad.addColorStop(1, 'hsl(' + ((hue + 120) % 360) + ',95%,60%)');
    g.fillStyle = grad;
    g.textBaseline = 'middle';
    g.fillText(text, x, c.height / 2);
    x -= 4;
    if (x + g.measureText(text).width < 0) x = c.width;
  };
}
