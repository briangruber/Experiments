// Where the player is allowed to stand, and how they get there.
//
// SCUMM used convex walkboxes with a hand-authored adjacency matrix. That is
// the right answer when an artist is placing boxes by hand over a painting and
// wants exact control of the seams. It is the wrong answer here, because the
// backdrops are generated: the floor comes out of an image, its edge is a
// ragged curve, and carving that into convex boxes by hand is the slow step we
// are trying to remove.
//
// So the walkable area is a set of polygons rasterised to a coarse mask, and
// paths are A* over that mask, then pulled straight. Rasterising means the
// polygons may be concave, may overlap, and may be traced loosely around a
// generated floor without anyone checking convexity. A mask is also what a
// depth render or a segmentation pass hands you, so the same runtime accepts a
// hand-drawn area now and an extracted one later without changing.
//
// CELL is the whole quality/cost dial. At 6px a 1280x720 room is 213x120 = 25k
// cells, which A* crosses in well under a millisecond, and the 6px stair-step
// in the raw path is erased by the string pull afterwards.

export const CELL = 6;

const SQRT2 = Math.SQRT2;

function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 2; i < poly.length; j = i, i += 2) {
    const xi = poly[i], yi = poly[i + 1];
    const xj = poly[j], yj = poly[j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export class WalkArea {
  // polys: array of flat [x0,y0,x1,y1,...] in room space. Union, not difference —
  // a hole is expressed by tracing around it, which is what tracing a floor
  // around a crate actually produces.
  constructor(polys, width, height) {
    this.polys = polys;
    this.w = Math.ceil(width / CELL);
    this.h = Math.ceil(height / CELL);
    this.mask = new Uint8Array(this.w * this.h);
    this.rebuild();
  }

  rebuild() {
    const { w, h, mask, polys } = this;
    mask.fill(0);
    for (let cy = 0; cy < h; cy++) {
      const y = cy * CELL + CELL / 2;
      for (let cx = 0; cx < w; cx++) {
        const x = cx * CELL + CELL / 2;
        for (const p of polys) {
          if (pointInPoly(x, y, p)) { mask[cy * w + cx] = 1; break; }
        }
      }
    }
    this._dirty = false;
  }

  walkable(x, y) {
    const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
    if (cx < 0 || cy < 0 || cx >= this.w || cy >= this.h) return false;
    return this.mask[cy * this.w + cx] === 1;
  }

  // A click lands wherever the player clicked, including on the sky. Snapping to
  // the nearest legal cell is what makes a click near an edge feel like an
  // instruction rather than a rejection — the actor goes as close as the floor
  // allows instead of refusing to move.
  nearest(x, y) {
    if (this.walkable(x, y)) return { x, y };
    const { w, h, mask } = this;
    const sx = Math.max(0, Math.min(w - 1, Math.floor(x / CELL)));
    const sy = Math.max(0, Math.min(h - 1, Math.floor(y / CELL)));
    let best = null, bestD = Infinity;
    for (let cy = 0; cy < h; cy++) {
      for (let cx = 0; cx < w; cx++) {
        if (!mask[cy * w + cx]) continue;
        const dx = cx - sx, dy = cy - sy;
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = { cx, cy }; }
      }
    }
    if (!best) return { x, y };
    return { x: best.cx * CELL + CELL / 2, y: best.cy * CELL + CELL / 2 };
  }

  // Bresenham-ish walkability test along a segment. Used by the string pull, so
  // it is called a few hundred times per path and stays on integers.
  clear(x0, y0, x1, y1) {
    const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / (CELL * 0.5));
    for (let i = 0; i <= steps; i++) {
      const t = steps === 0 ? 0 : i / steps;
      if (!this.walkable(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t)) return false;
    }
    return true;
  }

  // Returns an array of {x,y} waypoints, or null if there is no route.
  path(from, to) {
    const start = this.nearest(from.x, from.y);
    const goal = this.nearest(to.x, to.y);
    const { w, h, mask } = this;
    const si = Math.floor(start.y / CELL) * w + Math.floor(start.x / CELL);
    const gi = Math.floor(goal.y / CELL) * w + Math.floor(goal.x / CELL);
    if (!mask[si] || !mask[gi]) return null;
    if (si === gi) return [goal];

    const n = w * h;
    const g = new Float32Array(n).fill(Infinity);
    const f = new Float32Array(n).fill(Infinity);
    const prev = new Int32Array(n).fill(-1);
    const open = new Set([si]);
    const closed = new Uint8Array(n);
    const gx = gi % w, gy = (gi / w) | 0;
    g[si] = 0;
    f[si] = Math.hypot((si % w) - gx, ((si / w) | 0) - gy);

    while (open.size) {
      // A linear scan for the minimum is O(open) per pop, which on a 25k-cell
      // grid is cheaper than maintaining a heap and is called once per click.
      let cur = -1, bestF = Infinity;
      for (const i of open) if (f[i] < bestF) { bestF = f[i]; cur = i; }
      if (cur === gi) break;
      open.delete(cur);
      closed[cur] = 1;
      const cx = cur % w, cy = (cur / w) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const ni = ny * w + nx;
          if (!mask[ni] || closed[ni]) continue;
          // No cutting a diagonal past a corner: without this the actor clips
          // the corner of a crate and walks through solid painting.
          if (dx && dy && (!mask[cy * w + nx] || !mask[ny * w + cx])) continue;
          const t = g[cur] + (dx && dy ? SQRT2 : 1);
          if (t < g[ni]) {
            g[ni] = t;
            f[ni] = t + Math.hypot(nx - gx, ny - gy);
            prev[ni] = cur;
            open.add(ni);
          }
        }
      }
    }
    if (prev[gi] === -1 && si !== gi) return null;

    const cells = [];
    for (let i = gi; i !== -1; i = prev[i]) cells.push(i);
    cells.reverse();
    const pts = cells.map((i) => ({ x: (i % w) * CELL + CELL / 2, y: ((i / w) | 0) * CELL + CELL / 2 }));
    pts[pts.length - 1] = goal;
    return this.pull(pts);
  }

  // Grid paths look like grid paths — 45-degree staircases. Dropping every
  // waypoint that the previous one can already see straight through turns the
  // staircase back into the two or three long strides a person would take.
  pull(pts) {
    if (pts.length <= 2) return pts;
    const out = [pts[0]];
    let anchor = 0;
    for (let i = 2; i < pts.length; i++) {
      if (!this.clear(pts[anchor].x, pts[anchor].y, pts[i].x, pts[i].y)) {
        out.push(pts[i - 1]);
        anchor = i - 1;
      }
    }
    out.push(pts[pts.length - 1]);
    return out.slice(1);
  }
}
