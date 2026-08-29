// The in-game annotation editor. Press ` to toggle.
//
// This is the piece that decides whether the pipeline scales, and it is the one
// most often skipped in a prototype. Generating a backdrop takes thirty seconds;
// tracing its floor, placing its hotspots and setting its two scale anchors by
// editing numbers in a source file and reloading takes twenty minutes. Do that
// forty times and the generated art has saved nothing.
//
// So: drag the floor with the mouse, see the mask update live, and press E to
// print the polygons in the exact form src/game/dock.js wants pasted back. The
// round trip is the feature. Everything else here is a debug overlay.

import { CELL } from './pathfind.js';

const HANDLE = 7;

export class Editor {
  constructor(room, view) {
    this.room = room;
    this.view = view;
    this.active = false;
    this.drag = null;         // { poly, i }
    this.hoverHandle = null;
    this.mouse = { x: 0, y: 0, rx: 0, ry: 0 };
    this.showMask = true;
  }

  toggle() { this.active = !this.active; this.drag = null; }

  move(mouse) {
    this.mouse = mouse;
    if (!this.active) return;
    if (this.drag) {
      const p = this.drag.poly;
      p[this.drag.i] = Math.round(mouse.rx);
      p[this.drag.i + 1] = Math.round(mouse.ry);
      this.room.walk.rebuild();
      return;
    }
    this.hoverHandle = this.handleAt(mouse.rx, mouse.ry);
  }

  handleAt(x, y) {
    for (const poly of this.room.def.walk) {
      for (let i = 0; i < poly.length; i += 2) {
        if (Math.hypot(x - poly[i], y - poly[i + 1]) < HANDLE + 5) return { poly, i };
      }
    }
    return null;
  }

  pointerDown(rp, e) {
    if (!this.active) return false;
    const h = this.handleAt(rp.x, rp.y);
    if (h) {
      // Alt-click removes a vertex; a triangle is the floor of last resort.
      if (e.altKey && h.poly.length > 6) {
        h.poly.splice(h.i, 2);
        this.room.walk.rebuild();
      } else {
        this.drag = h;
      }
      return true;
    }
    // Shift-click inserts a vertex into the nearest edge of the nearest polygon.
    if (e.shiftKey) {
      const target = this.nearestEdge(rp.x, rp.y);
      if (target) {
        target.poly.splice(target.i + 2, 0, Math.round(rp.x), Math.round(rp.y));
        this.room.walk.rebuild();
      }
      return true;
    }
    return false;
  }

  nearestEdge(x, y) {
    let best = null, bestD = Infinity;
    for (const poly of this.room.def.walk) {
      for (let i = 0; i < poly.length; i += 2) {
        const j = (i + 2) % poly.length;
        const ax = poly[i], ay = poly[i + 1], bx = poly[j], by = poly[j + 1];
        const dx = bx - ax, dy = by - ay;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
        const d = Math.hypot(x - (ax + dx * t), y - (ay + dy * t));
        if (d < bestD) { bestD = d; best = { poly, i }; }
      }
    }
    return bestD < 40 ? best : null;
  }

  key(e) {
    if (!this.active) return false;
    if (e.key === 'm') { this.showMask = !this.showMask; return true; }
    if (e.key === 'e') { this.dump(); return true; }
    return false;
  }

  dump() {
    const body = this.room.def.walk
      .map((p) => '      [' + p.map((n) => Math.round(n)).join(', ') + '],')
      .join('\n');
    const text = '    walk: [\n' + body + '\n    ],';
    console.log('%c[editor] paste into src/game/dock.js:', 'color:#f6d78a');
    console.log(text);
    navigator.clipboard?.writeText(text).catch(() => {});
  }

  render(ctx) {
    if (!this.active) return;
    const { room } = this;
    ctx.save();
    ctx.translate(-Math.round(room.camX), 0);

    if (this.showMask) {
      const wa = room.walk;
      ctx.fillStyle = 'rgba(90,200,140,0.20)';
      for (let cy = 0; cy < wa.h; cy++) {
        for (let cx = 0; cx < wa.w; cx++) {
          if (wa.mask[cy * wa.w + cx]) ctx.fillRect(cx * CELL, cy * CELL, CELL - 1, CELL - 1);
        }
      }
    }

    for (const h of room.hotspots) {
      const dim = h.hidden?.();
      ctx.strokeStyle = dim ? 'rgba(200,120,120,0.35)' : 'rgba(120,180,255,0.75)';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(h.rect[0], h.rect[1], h.rect[2], h.rect[3]);
      ctx.fillStyle = dim ? 'rgba(200,120,120,0.55)' : 'rgba(160,210,255,0.95)';
      ctx.font = '13px ui-monospace, monospace';
      ctx.fillText(h.id, h.rect[0] + 3, h.rect[1] - 4);
      if (h.at) {
        ctx.fillStyle = '#ffd166';
        ctx.beginPath(); ctx.arc(h.at.x, h.at.y, 4, 0, Math.PI * 2); ctx.fill();
      }
    }

    // Scale anchors, drawn as the two lines they actually are.
    const s = room.def.scale;
    if (s) {
      ctx.strokeStyle = 'rgba(255,120,200,0.6)';
      ctx.setLineDash([8, 6]);
      for (const [y, label] of [[s.y0, `scale ${s.s0}`], [s.y1, `scale ${s.s1}`]]) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(room.width, y); ctx.stroke();
        ctx.fillStyle = 'rgba(255,150,210,0.9)';
        ctx.fillText(label, 8, y - 5);
      }
      ctx.setLineDash([]);
    }

    for (const poly of room.def.walk) {
      ctx.strokeStyle = '#7fffc4';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(poly[0], poly[1]);
      for (let i = 2; i < poly.length; i += 2) ctx.lineTo(poly[i], poly[i + 1]);
      ctx.closePath();
      ctx.stroke();
      for (let i = 0; i < poly.length; i += 2) {
        const on = this.hoverHandle?.poly === poly && this.hoverHandle.i === i;
        ctx.fillStyle = on ? '#fff' : '#7fffc4';
        ctx.beginPath(); ctx.arc(poly[i], poly[i + 1], on ? HANDLE + 2 : HANDLE, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.restore();

    ctx.save();
    ctx.font = '14px ui-monospace, monospace';
    ctx.fillStyle = '#7fffc4';
    ctx.fillText('EDITOR  drag=move vertex  shift=insert  alt=delete  m=mask  e=export  `=exit', 14, 40);
    ctx.fillText(`room ${Math.round(this.mouse.rx)},${Math.round(this.mouse.ry)}`, 14, 60);
    ctx.restore();
  }
}
