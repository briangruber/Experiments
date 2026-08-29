// The verb coin, the inventory strip, subtitles, and the dialogue menu.
//
// The verb coin is the interface Curse of Monkey Island introduced to replace
// the nine-verb wall of text, and it is worth copying exactly because of what
// it does to authoring: three verbs means every hotspot needs at most three
// responses, so a room is writable in an afternoon instead of a week. The
// nine-verb UI produced hundreds of "That doesn't work" lines nobody read.
//
// All of it is drawn into the same canvas as the game rather than laid over it
// in DOM. One surface means one coordinate system, one scale factor, and a
// screenshot that contains the whole game — which is what makes an automated
// check able to see the UI at all.

export const VERBS = [
  { id: 'look', label: 'Look at', angle: -Math.PI / 2 },
  { id: 'use',  label: 'Use',     angle: Math.PI / 6 },
  { id: 'talk', label: 'Talk to', angle: (Math.PI * 5) / 6 },
];

const COIN_R = 46;
const ICON_R = 19;

export class VerbCoin {
  constructor() { this.open = false; this.x = 0; this.y = 0; this.target = null; this.hover = null; this.t = 0; }

  show(x, y, target) { this.open = true; this.x = x; this.y = y; this.target = target; this.hover = null; this.t = 0; }
  hide() { this.open = false; this.target = null; this.hover = null; }

  move(x, y) {
    if (!this.open) return;
    this.hover = null;
    for (const v of VERBS) {
      const vx = this.x + Math.cos(v.angle) * COIN_R;
      const vy = this.y + Math.sin(v.angle) * COIN_R;
      if (Math.hypot(x - vx, y - vy) < ICON_R + 7) this.hover = v.id;
    }
  }

  // Returns the chosen verb id, or null when the click was a dismissal.
  pick(x, y) { this.move(x, y); const v = this.hover; this.hide(); return v; }

  update(dt) { if (this.open) this.t = Math.min(1, this.t + dt * 9); }

  render(ctx) {
    if (!this.open) return;
    const e = 1 - Math.pow(1 - this.t, 3);
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.scale(e, e);
    ctx.globalAlpha = e;
    for (const v of VERBS) {
      const vx = Math.cos(v.angle) * COIN_R;
      const vy = Math.sin(v.angle) * COIN_R;
      const on = this.hover === v.id;
      ctx.beginPath();
      ctx.arc(vx, vy, ICON_R, 0, Math.PI * 2);
      ctx.fillStyle = on ? '#f6d78a' : 'rgba(24,18,14,0.88)';
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = on ? '#fff6dc' : '#c9a86a';
      ctx.stroke();
      ctx.strokeStyle = on ? '#2a1d12' : '#e8cf9a';
      ctx.fillStyle = ctx.strokeStyle;
      ctx.lineWidth = 2;
      drawVerbIcon(ctx, v.id, vx, vy);
    }
    ctx.restore();
  }
}

function drawVerbIcon(ctx, id, x, y) {
  ctx.save();
  ctx.translate(x, y);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (id === 'look') {
    ctx.beginPath();
    ctx.moveTo(-10, 0); ctx.quadraticCurveTo(0, -8, 10, 0); ctx.quadraticCurveTo(0, 8, -10, 0);
    ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, 3.2, 0, Math.PI * 2); ctx.fill();
  } else if (id === 'use') {
    ctx.beginPath();                      // a mitten, read as "hand" at 19px
    ctx.moveTo(-5, 8); ctx.lineTo(-5, -3); ctx.quadraticCurveTo(-5, -9, -1, -9);
    ctx.quadraticCurveTo(3, -9, 3, -3); ctx.lineTo(3, -1);
    ctx.quadraticCurveTo(9, -3, 9, 2); ctx.quadraticCurveTo(9, 8, 3, 9);
    ctx.lineTo(-2, 9); ctx.closePath(); ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.moveTo(-9, -1); ctx.quadraticCurveTo(0, -7, 9, -1);
    ctx.quadraticCurveTo(0, 7, -9, -1); ctx.closePath(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-6, -1); ctx.lineTo(6, -1); ctx.stroke();
  }
  ctx.restore();
}

// --- inventory --------------------------------------------------------------

const SLOT = 60, PAD = 8;

export class Inventory {
  constructor(view) { this.view = view; this.selected = null; this.hover = null; }

  get top() { return this.view.h - SLOT - PAD * 2; }

  slotRect(i) { return [PAD + i * (SLOT + PAD), this.top + PAD, SLOT, SLOT]; }

  width(items) { return items.length ? PAD + items.length * (SLOT + PAD) : 0; }

  // The strip only exists where it is drawn. Reserving the full width of the
  // bottom of the screen — the obvious version — makes every low hotspot
  // unclickable while the inventory is empty, and the room's floor is exactly
  // where the low hotspots are.
  contains(x, y, items) {
    return items.length > 0 && y >= this.top && x <= this.width(items);
  }

  hit(x, y, items) {
    if (!this.contains(x, y, items)) return null;
    for (let i = 0; i < items.length; i++) {
      const [rx, ry, rw, rh] = this.slotRect(i);
      if (x >= rx && x <= rx + rw && y >= ry && y <= ry + rh) return items[i];
    }
    return null;
  }

  render(ctx, items, icons) {
    if (!items.length) return;
    const h = SLOT + PAD * 2;
    ctx.save();
    ctx.fillStyle = 'rgba(18,13,10,0.72)';
    ctx.fillRect(0, this.top, this.width(items), h);
    for (let i = 0; i < items.length; i++) {
      const [x, y, w, hh] = this.slotRect(i);
      const item = items[i];
      const on = this.selected === item;
      ctx.fillStyle = on ? 'rgba(246,215,138,0.22)' : 'rgba(0,0,0,0.30)';
      ctx.fillRect(x, y, w, hh);
      ctx.strokeStyle = on ? '#f6d78a' : (this.hover === item ? '#c9a86a' : '#6b5334');
      ctx.lineWidth = 2;
      ctx.strokeRect(x + 1, y + 1, w - 2, hh - 2);
      ctx.save();
      ctx.translate(x + w / 2, y + hh / 2);
      icons[item]?.(ctx);
      ctx.restore();
    }
    ctx.restore();
  }
}

// --- speech and dialogue ----------------------------------------------------

export function drawSpeech(ctx, actor, room, view) {
  if (!actor.line) return;
  const scale = room.scaleAt(actor.y);
  const x = actor.x - room.camX;
  const y = actor.y + actor.talkOffset * scale;
  const words = actor.line.text.split(' ');
  const maxW = 460;
  ctx.save();
  ctx.font = '600 25px Georgia, "Times New Roman", serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lines = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? cur + ' ' + w : w;
    if (ctx.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; } else cur = t;
  }
  if (cur) lines.push(cur);
  const lh = 30;
  const top = Math.max(24, y - (lines.length - 1) * lh);
  const cx = Math.max(maxW / 2 + 12, Math.min(view.w - maxW / 2 - 12, x));
  lines.forEach((ln, i) => {
    const ly = top + i * lh;
    ctx.lineWidth = 5;
    ctx.strokeStyle = 'rgba(8,6,4,0.92)';
    ctx.lineJoin = 'round';
    ctx.strokeText(ln, cx, ly);
    ctx.fillStyle = actor.talkColor;
    ctx.fillText(ln, cx, ly);
  });
  ctx.restore();
}

export class DialogueMenu {
  constructor(view) { this.view = view; this.options = null; this.hover = -1; this.onPick = null; }

  show(options, onPick) { this.options = options; this.onPick = onPick; this.hover = -1; }
  hide() { this.options = null; this.onPick = null; }
  get active() { return this.options !== null; }

  rowY(i) { return this.view.h - 34 - (this.options.length - 1 - i) * 34; }

  move(x, y) {
    if (!this.options) return;
    this.hover = -1;
    for (let i = 0; i < this.options.length; i++) {
      if (Math.abs(y - this.rowY(i)) < 17) this.hover = i;
    }
  }

  click(x, y) {
    this.move(x, y);
    if (this.hover < 0) return false;
    const opt = this.options[this.hover];
    const cb = this.onPick;
    this.hide();
    cb?.(opt);
    return true;
  }

  render(ctx) {
    if (!this.options) return;
    ctx.save();
    const h = this.options.length * 34 + 16;
    ctx.fillStyle = 'rgba(12,9,7,0.86)';
    ctx.fillRect(0, this.view.h - h, this.view.w, h);
    ctx.font = '22px Georgia, "Times New Roman", serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    this.options.forEach((o, i) => {
      ctx.fillStyle = this.hover === i ? '#ffe9b0' : '#9d8a6a';
      ctx.fillText(o.text, 32, this.rowY(i));
    });
    ctx.restore();
  }
}
