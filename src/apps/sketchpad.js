/* Sketchpad — a small paint program with the tools you actually used:
   pencil, brush, line, box, ellipse, fill and the spray can. */

import { h, clear, drag } from '../core/dom.js';
import { openWindow, dialog } from '../core/wm.js';
import * as A from '../core/audio.js';

const PALETTE = [
  '#000000', '#808080', '#800000', '#808000', '#008000', '#008080', '#000080', '#800080',
  '#808040', '#004040', '#0080ff', '#004080', '#8000ff', '#804000', '#ff0000', '#ffff00',
  '#00ff00', '#00ffff', '#0000ff', '#ff00ff', '#ffff80', '#00ff80', '#80ffff', '#8080ff',
  '#ff0080', '#ff8040', '#ffffff', '#c0c0c0',
];
const TOOLS = ['Pencil', 'Brush', 'Spray', 'Line', 'Box', 'Ellipse', 'Fill', 'Eraser'];

export function open(ctx) {
  const W = 460, H = 300;
  const canvas = h('canvas', { width: W, height: H, class: 'pad-canvas' });
  const g = canvas.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);

  let tool = 'Pencil', color = '#000000', size = 2, snapshot = null;
  const status = h('span', {}, '');

  const win = openWindow({
    id: 'sketchpad', title: 'untitled - Sketchpad', icon: 'paint',
    width: 620, height: 410, minWidth: 420, minHeight: 300,
    status: ['', ''],
    menu: [
      { label: 'File', onclick: () => save() },
      { label: 'Edit', onclick: () => clearAll() },
      { label: 'Help', onclick: () => dialog({
        title: 'Sketchpad', icon: 'help',
        message: 'Pick a tool on the left and a colour underneath.\n' +
                 'File clears to a new picture, Edit undoes the last stroke.' }) },
    ],
  });

  const toolbox = h('div.pad-tools', {}, TOOLS.map(t =>
    h('button.pad-tool', {
      type: 'button', class: t === tool ? 'on' : '', dataset: { tool: t }, title: t,
      onclick: ev => {
        tool = t;
        [...toolbox.children].forEach(b => b.classList.toggle('on', b.dataset.tool === t));
        status.textContent = t;
      },
    }, t.slice(0, 4))));

  const sizes = h('div.pad-sizes', {}, [1, 2, 4, 8].map(s =>
    h('button.pad-size', {
      type: 'button', class: s === size ? 'on' : '', dataset: { s },
      onclick: ev => {
        size = s;
        [...sizes.children].forEach(b => b.classList.toggle('on', Number(b.dataset.s) === s));
      },
    }, h('i', { style: { width: s * 2 + 'px', height: s * 2 + 'px' } }))));

  const swatches = h('div.pad-palette', {}, PALETTE.map(c =>
    h('button.pad-swatch', {
      type: 'button', style: { background: c }, dataset: { c },
      onclick: () => {
        color = c;
        [...swatches.children].forEach(b => b.classList.toggle('on', b.dataset.c === c));
        current.style.background = c;
      },
    })));
  const current = h('div.pad-current', { style: { background: color } });

  clear(win.body).append(h('div.pad', {},
    h('div.pad-left', {}, toolbox, sizes),
    h('div.pad-main', {},
      h('div.pad-canvas-wrap.sunken', {}, canvas),
      h('div.pad-bottom', {}, current, swatches, status))));

  /* ── drawing ─────────────────────────────────────────────────────── */

  const pos = ev => {
    const r = canvas.getBoundingClientRect();
    return {
      x: Math.round((ev.clientX - r.left) * (W / r.width)),
      y: Math.round((ev.clientY - r.top) * (H / r.height)),
    };
  };

  let start = null, last = null, undo = null;

  drag(canvas, ev => {
    undo = g.getImageData(0, 0, W, H);
    start = last = pos(ev);
    if (tool === 'Fill') { flood(start.x, start.y, color); return false; }
    if (tool === 'Pencil' || tool === 'Brush' || tool === 'Eraser') stroke(last, last);
    if (tool === 'Spray') spray(last);
    snapshot = g.getImageData(0, 0, W, H);
  }, (dx, dy, ev) => {
    const p = pos(ev);
    status.textContent = p.x + ', ' + p.y;
    if (tool === 'Pencil' || tool === 'Brush' || tool === 'Eraser') { stroke(last, p); last = p; }
    else if (tool === 'Spray') spray(p);
    else if (snapshot) {
      g.putImageData(snapshot, 0, 0);
      shape(start, p);
    }
  }, () => { snapshot = null; });

  function setPen() {
    g.strokeStyle = tool === 'Eraser' ? '#ffffff' : color;
    g.fillStyle = tool === 'Eraser' ? '#ffffff' : color;
    g.lineWidth = tool === 'Brush' ? size * 3 : (tool === 'Eraser' ? size * 5 : size);
    g.lineCap = tool === 'Brush' ? 'round' : 'butt';
    g.lineJoin = 'round';
  }

  function stroke(a, b) {
    setPen();
    g.beginPath(); g.moveTo(a.x + .5, a.y + .5); g.lineTo(b.x + .5, b.y + .5); g.stroke();
  }

  function spray(p) {
    g.fillStyle = color;
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * 6.283, r = Math.random() * size * 4;
      g.fillRect(p.x + Math.cos(a) * r, p.y + Math.sin(a) * r, 1, 1);
    }
  }

  function shape(a, b) {
    setPen();
    g.beginPath();
    if (tool === 'Line') { g.moveTo(a.x + .5, a.y + .5); g.lineTo(b.x + .5, b.y + .5); }
    else if (tool === 'Box') g.rect(a.x + .5, a.y + .5, b.x - a.x, b.y - a.y);
    else if (tool === 'Ellipse') {
      g.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2,
        Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, 6.284);
    }
    g.stroke();
  }

  function flood(x, y, fill) {
    const img = g.getImageData(0, 0, W, H), d = img.data;
    const at = (px, py) => (py * W + px) * 4;
    const t = at(x, y);
    const target = [d[t], d[t + 1], d[t + 2], d[t + 3]];
    const c = document.createElement('canvas').getContext('2d');
    c.fillStyle = fill; c.fillRect(0, 0, 1, 1);
    const rep = c.getImageData(0, 0, 1, 1).data;
    if (target.every((v, i) => v === rep[i])) return;

    const stack = [[x, y]];
    while (stack.length) {
      const [px, py] = stack.pop();
      if (px < 0 || py < 0 || px >= W || py >= H) continue;
      const i = at(px, py);
      if (d[i] !== target[0] || d[i + 1] !== target[1] ||
          d[i + 2] !== target[2] || d[i + 3] !== target[3]) continue;
      d[i] = rep[0]; d[i + 1] = rep[1]; d[i + 2] = rep[2]; d[i + 3] = rep[3];
      stack.push([px + 1, py], [px - 1, py], [px, py + 1], [px, py - 1]);
    }
    g.putImageData(img, 0, 0);
    A.click();
  }

  function clearAll() {
    if (undo) { g.putImageData(undo, 0, 0); undo = null; return; }
    g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
  }

  async function save() {
    const ok = await dialog({
      title: 'Sketchpad', icon: 'paint',
      message: 'Start a new picture? The current one will be lost.',
      buttons: ['New', 'Cancel'],
    });
    if (ok === 'New') { g.fillStyle = '#fff'; g.fillRect(0, 0, W, H); A.click(); }
  }

  return win;
}
