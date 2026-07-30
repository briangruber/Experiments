import { WORLD, MONSTERS, MONSTER_BY_ID } from '/shared/config.js';

// A chart, not a radar: the rings are the monster zones, so the map is also the
// answer to "where do I have to go for something bigger?".

const ZONE_COLOURS = ['#6fa8b8', '#8d7bd0', '#c46a5e', '#7f95a8', '#5ec9b4', '#9fd8ea', '#ff8a3d'];

export class Minimap {
  /** `size` is the on-screen size in CSS pixels; the backing store is scaled
   *  for the display. It is set here rather than in CSS because the canvas
   *  needs the same number for its own coordinate system. */
  constructor(canvas, { range = 700, size = 220 } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.range = range;
    const dpr = Math.min(2, devicePixelRatio || 1);
    this.size = size;
    canvas.width = canvas.height = size * dpr;
    canvas.style.width = canvas.style.height = `${size}px`;
    this.ctx.scale(dpr, dpr);
  }

  draw({ me, heading, monsters, players, tetherId }) {
    const ctx = this.ctx;
    const S = this.size;
    const C = S / 2;
    const k = C / this.range;

    ctx.clearRect(0, 0, S, S);
    ctx.save();
    ctx.beginPath();
    ctx.arc(C, C, C - 1, 0, Math.PI * 2);
    ctx.clip();

    ctx.fillStyle = 'rgba(4, 22, 33, 0.55)';
    ctx.fillRect(0, 0, S, S);

    // World is drawn rotated so "up" is always the way the bow points.
    const rot = -heading - Math.PI / 2;
    const cos = Math.cos(rot), sin = Math.sin(rot);
    const project = (x, z) => {
      const dx = (x - me.x) * k, dz = (z - me.z) * k;
      return [C + dx * cos - dz * sin, C + dx * sin + dz * cos];
    };

    // Zone rings, drawn from the actual monster table.
    const bands = [...new Set(MONSTERS.map((m) => m.zone[0]))].sort((a, b) => a - b);
    ctx.lineWidth = 1;
    bands.forEach((r, i) => {
      const [cx, cy] = project(0, 0);
      ctx.beginPath();
      ctx.arc(cx, cy, r * k, 0, Math.PI * 2);
      ctx.strokeStyle = ZONE_COLOURS[i % ZONE_COLOURS.length] + '33';
      ctx.stroke();
    });

    // World edge.
    {
      const [cx, cy] = project(0, 0);
      ctx.beginPath();
      ctx.arc(cx, cy, WORLD.radius * k, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(216, 80, 63, 0.5)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Town.
    {
      const [cx, cy] = project(0, 0);
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(4, WORLD.townRadius * k), 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(242, 192, 87, 0.22)';
      ctx.fill();
      ctx.strokeStyle = '#f2c057';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      // Always show a bearing to home, even when it is off the chart.
      const d = Math.hypot(me.x, me.z);
      if (d * k > C - 10) {
        const a = Math.atan2(cy - C, cx - C);
        ctx.beginPath();
        ctx.arc(C + Math.cos(a) * (C - 9), C + Math.sin(a) * (C - 9), 4, 0, Math.PI * 2);
        ctx.fillStyle = '#f2c057';
        ctx.fill();
      }
    }

    for (const p of players) {
      const [x, y] = project(p.x, p.z);
      ctx.beginPath();
      ctx.arc(x, y, 3.2, 0, Math.PI * 2);
      ctx.fillStyle = '#7ee0ff';
      ctx.fill();
    }

    for (const m of monsters) {
      const type = MONSTER_BY_ID[m.kind] || MONSTER_BY_ID.silverfin;
      const [x, y] = project(m.x, m.z);
      const r = 2.6 + type.tier * 0.7;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = ZONE_COLOURS[type.tier % ZONE_COLOURS.length];
      ctx.globalAlpha = m.hunting ? 1 : 0.7;
      ctx.fill();
      ctx.globalAlpha = 1;
      if (m.id === tetherId) {
        ctx.beginPath();
        ctx.arc(x, y, r + 3.5, 0, Math.PI * 2);
        ctx.strokeStyle = '#f2c057';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }

    // Own boat: a bow arrow at the centre.
    ctx.translate(C, C);
    ctx.beginPath();
    ctx.moveTo(0, -7);
    ctx.lineTo(4.6, 5);
    ctx.lineTo(0, 2.6);
    ctx.lineTo(-4.6, 5);
    ctx.closePath();
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.restore();

    ctx.strokeStyle = 'rgba(126, 197, 219, 0.28)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(C, C, C - 1, 0, Math.PI * 2);
    ctx.stroke();
  }
}

/** Plain-language label for how far out the player has sailed. */
export function depthLabel(d) {
  if (d < WORLD.townRadius) return 'in harbour';
  if (d < 420) return 'home waters';
  if (d < 700) return 'the shelf';
  if (d < 1150) return 'open sea';
  if (d < 1600) return 'the deeps';
  if (d < 2100) return 'the trench';
  if (d < 2600) return 'black water';
  return 'the maelstrom';
}
