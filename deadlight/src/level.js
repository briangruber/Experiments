// Seeded layout for the hospital sublevel.
//
// A tile grid: rooms punched into solid rock, then joined by L-shaped
// corridors. Rooms give the player somewhere to be cornered; corridors give
// the creature its sight-lines. The two matter for different reasons and the
// generator keeps them distinct rather than producing an even maze — an even
// maze reads as a puzzle, and this is not a puzzle.
//
// Everything downstream (dressing, fuse placement, patrol routes, the
// creature's pathfinding) works on the tile grid rather than on world space,
// so the geometry stays a rendering detail.

import * as THREE from 'three';

export const TILE = 3.4;
export const CEILING = 3.15;
export const GRID_W = 30;
export const GRID_H = 30;

const DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

export class Level {
  constructor(rng) {
    this.rng = rng;
    this.w = GRID_W;
    this.h = GRID_H;
    /** Open (walkable) tiles, row-major. */
    this.open = new Uint8Array(this.w * this.h);
    this.rooms = [];

    this.#carveRooms();
    this.#carveCorridors();
    this.#chooseKeyRooms();
  }

  // ------------------------------------------------------------ generation

  #carveRooms() {
    const { rng } = this;
    // Reject-sample rooms rather than partitioning the grid: overlapping
    // attempts get thrown away, which leaves irregular gaps between rooms.
    // A BSP split would tile the space evenly and feel built rather than
    // dug out.
    const attempts = 220;
    const target = 15;

    for (let i = 0; i < attempts && this.rooms.length < target; i++) {
      const rw = rng.int(3, 7);
      const rh = rng.int(3, 6);
      const x = rng.int(1, this.w - rw - 2);
      const y = rng.int(1, this.h - rh - 2);
      const room = { x, y, w: rw, h: rh, cx: x + (rw >> 1), cy: y + (rh >> 1) };

      // One tile of separation so two rooms never share a wall.
      const clash = this.rooms.some(
        (r) => x < r.x + r.w + 1 && x + rw + 1 > r.x && y < r.y + r.h + 1 && y + rh + 1 > r.y,
      );
      if (clash) continue;

      for (let ty = y; ty < y + rh; ty++) {
        for (let tx = x; tx < x + rw; tx++) this.open[ty * this.w + tx] = 1;
      }
      this.rooms.push(room);
    }
  }

  #carveCorridors() {
    const { rng } = this;
    // Connect in sweep order so the spine of the level runs across the grid,
    // then add a few chords. The chords are what stop the level being a tree:
    // a tree means every retreat is back the way you came, and the creature
    // only ever has to guard one direction.
    const order = [...this.rooms].sort((a, b) => a.cx - b.cx || a.cy - b.cy);
    for (let i = 1; i < order.length; i++) {
      this.#connect(order[i - 1], order[i]);
    }
    for (let i = 0; i < 4; i++) {
      this.#connect(rng.pick(this.rooms), rng.pick(this.rooms));
    }
  }

  /** L-shaped corridor between two room centres, with a random elbow. */
  #connect(a, b) {
    if (a === b) return;
    const horizFirst = this.rng.bool();
    if (horizFirst) {
      this.#carveH(a.cx, b.cx, a.cy);
      this.#carveV(a.cy, b.cy, b.cx);
    } else {
      this.#carveV(a.cy, b.cy, a.cx);
      this.#carveH(a.cx, b.cx, b.cy);
    }
  }

  #carveH(x0, x1, y) {
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) {
      this.open[y * this.w + x] = 1;
    }
  }

  #carveV(y0, y1, x) {
    for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
      this.open[y * this.w + x] = 1;
    }
  }

  /**
   * Assign roles. The player starts as far from the exit as the layout
   * allows, and the fuses are spread by walking distance rather than straight
   * line so that "far away" survives the corridors actually being there.
   */
  #chooseKeyRooms() {
    const { rng } = this;
    const start = rng.pick(this.rooms);
    const distances = this.distanceField(start.cx, start.cy);
    const distTo = (r) => distances[r.cy * this.w + r.cx] ?? Infinity;

    const reachable = this.rooms.filter((r) => Number.isFinite(distTo(r)) && r !== start);
    const byDistance = [...reachable].sort((a, b) => distTo(b) - distTo(a));

    this.startRoom = start;
    this.exitRoom = byDistance[0] ?? start;
    this.generatorRoom = byDistance[Math.min(1, byDistance.length - 1)] ?? start;

    // Fuse rooms: greedily pick the room furthest from everything already
    // chosen, so no two fuses sit in adjacent rooms.
    const taken = [start, this.exitRoom, this.generatorRoom];
    const pool = reachable.filter((r) => !taken.includes(r));
    const fuseRooms = [];
    const wanted = Math.min(6, pool.length);
    while (fuseRooms.length < wanted) {
      let best = null;
      let bestScore = -Infinity;
      for (const r of pool) {
        if (fuseRooms.includes(r)) continue;
        const near = [...taken, ...fuseRooms].reduce(
          (m, t) => Math.min(m, Math.abs(t.cx - r.cx) + Math.abs(t.cy - r.cy)),
          Infinity,
        );
        const score = near + rng.float(0, 2);
        if (score > bestScore) {
          bestScore = score;
          best = r;
        }
      }
      if (!best) break;
      fuseRooms.push(best);
    }
    this.fuseRooms = fuseRooms;
  }

  // -------------------------------------------------------------- queries

  isOpen(tx, ty) {
    if (tx < 0 || ty < 0 || tx >= this.w || ty >= this.h) return false;
    return this.open[ty * this.w + tx] === 1;
  }

  /** Tile centre in world space. */
  tileToWorld(tx, ty, y = 0) {
    return new THREE.Vector3(
      (tx - this.w / 2 + 0.5) * TILE,
      y,
      (ty - this.h / 2 + 0.5) * TILE,
    );
  }

  worldToTile(v) {
    return {
      tx: Math.floor(v.x / TILE + this.w / 2),
      ty: Math.floor(v.z / TILE + this.h / 2),
    };
  }

  /** A random open point inside a room, kept off the walls. */
  pointInRoom(room, rng, inset = 0.62) {
    const tx = rng.int(room.x, room.x + room.w - 1);
    const ty = rng.int(room.y, room.y + room.h - 1);
    const p = this.tileToWorld(tx, ty);
    p.x += rng.float(-inset, inset);
    p.z += rng.float(-inset, inset);
    return p;
  }

  /** BFS hop-count from a tile. Infinity where unreachable. */
  distanceField(sx, sy) {
    const dist = new Float32Array(this.w * this.h).fill(Infinity);
    if (!this.isOpen(sx, sy)) return dist;
    const queue = [sy * this.w + sx];
    dist[queue[0]] = 0;
    for (let head = 0; head < queue.length; head++) {
      const at = queue[head];
      const x = at % this.w;
      const y = (at / this.w) | 0;
      for (const [dx, dy] of DIRS) {
        const nx = x + dx;
        const ny = y + dy;
        if (!this.isOpen(nx, ny)) continue;
        const ni = ny * this.w + nx;
        if (dist[ni] !== Infinity) continue;
        dist[ni] = dist[at] + 1;
        queue.push(ni);
      }
    }
    return dist;
  }

  /**
   * Tile path between two world points, as a list of world positions.
   *
   * Uses a distance field from the goal and then walks downhill. That is more
   * work than A* for one query but the creature re-paths constantly toward a
   * handful of targets, and a field can be cached and reused across frames
   * (see Creature#repath) where an A* result cannot.
   */
  path(from, to) {
    const a = this.worldToTile(from);
    const b = this.worldToTile(to);
    const field = this.distanceField(b.tx, b.ty);
    return this.followField(field, a.tx, a.ty);
  }

  /** Walk downhill through a distance field from a starting tile. */
  followField(field, tx, ty, limit = 400) {
    const out = [];
    let x = tx;
    let y = ty;
    if (!this.isOpen(x, y) || !Number.isFinite(field[y * this.w + x])) return out;

    for (let step = 0; step < limit; step++) {
      const here = field[y * this.w + x];
      if (here === 0) break;
      let best = null;
      let bestVal = here;
      for (const [dx, dy] of DIRS) {
        const nx = x + dx;
        const ny = y + dy;
        if (!this.isOpen(nx, ny)) continue;
        const v = field[ny * this.w + nx];
        if (v < bestVal) {
          bestVal = v;
          best = [nx, ny];
        }
      }
      if (!best) break;
      [x, y] = best;
      out.push(this.tileToWorld(x, y));
    }
    return out;
  }

  /**
   * Is the straight line between two world points clear of walls?
   *
   * A DDA march over the tile grid — used for "can the creature see the
   * player" and for deciding whether a mannequin is safely out of sight.
   */
  lineOfSight(from, to) {
    const a = this.worldToTile(from);
    const b = this.worldToTile(to);
    let x = a.tx;
    let y = a.ty;
    const dx = Math.abs(b.tx - x);
    const dy = Math.abs(b.ty - y);
    const sx = x < b.tx ? 1 : -1;
    const sy = y < b.ty ? 1 : -1;
    let err = dx - dy;

    for (let guard = 0; guard < 256; guard++) {
      if (!this.isOpen(x, y)) return false;
      if (x === b.tx && y === b.ty) return true;
      const e2 = err * 2;
      if (e2 > -dy) {
        err -= dy;
        x += sx;
      }
      if (e2 < dx) {
        err += dx;
        y += sy;
      }
    }
    return false;
  }

  /**
   * Push a point out of any wall it has entered.
   *
   * Circle-vs-tile resolved on each axis independently. Doing both axes in
   * one pass lets the player slide along a wall instead of sticking to it,
   * which matters a great deal when something is chasing you.
   */
  collide(pos, radius = 0.34) {
    const half = TILE / 2;
    const { tx, ty } = this.worldToTile(pos);

    for (let ny = ty - 1; ny <= ty + 1; ny++) {
      for (let nx = tx - 1; nx <= tx + 1; nx++) {
        if (this.isOpen(nx, ny)) continue;
        const c = this.tileToWorld(nx, ny);
        const dx = pos.x - c.x;
        const dz = pos.z - c.z;
        const overlapX = half + radius - Math.abs(dx);
        const overlapZ = half + radius - Math.abs(dz);
        if (overlapX <= 0 || overlapZ <= 0) continue;
        // Eject along the shallower axis — the one the point most recently
        // crossed.
        if (overlapX < overlapZ) pos.x += Math.sign(dx) * overlapX;
        else pos.z += Math.sign(dz) * overlapZ;
      }
    }
    return pos;
  }

  /** Every open tile, as {tx, ty}. */
  openTiles() {
    const out = [];
    for (let ty = 0; ty < this.h; ty++) {
      for (let tx = 0; tx < this.w; tx++) {
        if (this.open[ty * this.w + tx]) out.push({ tx, ty });
      }
    }
    return out;
  }

  /** Open tiles that touch at least one wall — where props belong. */
  wallTiles() {
    return this.openTiles().filter(({ tx, ty }) =>
      DIRS.some(([dx, dy]) => !this.isOpen(tx + dx, ty + dy)),
    );
  }

  /** Which way a wall-hugging prop on this tile should face (radians). */
  wallFacing(tx, ty) {
    for (const [dx, dy] of DIRS) {
      if (!this.isOpen(tx + dx, ty + dy)) return Math.atan2(-dx, -dy);
    }
    return 0;
  }

  // ------------------------------------------------------------- geometry

  /**
   * Build floor, ceiling and wall geometry as three merged buffers.
   *
   * Walls are emitted only where an open tile meets a solid one, so the
   * backs of walls are never built — nothing can get behind them. UVs are
   * world-space so a single tiling material runs across the whole level
   * without a seam at tile boundaries.
   */
  build() {
    const floor = new Surfaces();
    const ceiling = new Surfaces();
    const walls = new Surfaces();
    const half = TILE / 2;

    for (const { tx, ty } of this.openTiles()) {
      const c = this.tileToWorld(tx, ty);

      floor.quad(
        [c.x - half, 0, c.z - half],
        [c.x + half, 0, c.z - half],
        [c.x + half, 0, c.z + half],
        [c.x - half, 0, c.z + half],
        [0, 1, 0],
      );
      ceiling.quad(
        [c.x - half, CEILING, c.z + half],
        [c.x + half, CEILING, c.z + half],
        [c.x + half, CEILING, c.z - half],
        [c.x - half, CEILING, c.z - half],
        [0, -1, 0],
      );

      for (const [dx, dy] of DIRS) {
        if (this.isOpen(tx + dx, ty + dy)) continue;
        // Wall plane sits on the shared edge, facing back into the tile.
        const ex = c.x + dx * half;
        const ez = c.z + dy * half;
        // Tangent along the wall = perpendicular to the face normal.
        const ux = dy * half;
        const uz = -dx * half;
        walls.quad(
          [ex - ux, 0, ez - uz],
          [ex + ux, 0, ez + uz],
          [ex + ux, CEILING, ez + uz],
          [ex - ux, CEILING, ez - uz],
          [-dx, 0, -dy],
        );
      }
    }

    return {
      floor: floor.geometry(TILE),
      ceiling: ceiling.geometry(TILE),
      walls: walls.geometry(TILE),
    };
  }
}

/** Accumulates quads into a single indexed BufferGeometry. */
class Surfaces {
  constructor() {
    this.pos = [];
    this.nrm = [];
    this.uv = [];
    this.idx = [];
  }

  /** Four corners in winding order, plus a shared face normal. */
  quad(a, b, c, d, n) {
    const base = this.pos.length / 3;
    for (const p of [a, b, c, d]) {
      this.pos.push(p[0], p[1], p[2]);
      this.nrm.push(n[0], n[1], n[2]);
    }
    // Project world position onto the face plane for UVs. Walls use height
    // for V so vertical texture detail (rust runs, tide lines) stays vertical.
    const vertical = n[1] === 0;
    for (const p of [a, b, c, d]) {
      if (vertical) this.uv.push(p[0] + p[2], p[1]);
      else this.uv.push(p[0], p[2]);
    }
    // Reverse winding: the corner order above traces each face clockwise as
    // seen from the side the surface faces, and three treats counter-clockwise
    // as front. Emitting it unreversed builds a level inside out — the floor
    // is back-face culled from above, and the walls are only visible from
    // behind, lit by their own reversed normals. It renders as a level that is
    // simply never lit, which is a long way from where the bug actually is.
    this.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
  }

  /** `unit` scales world metres to texture repeats. */
  geometry(unit) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv.map((v) => v / unit), 2));
    g.setIndex(this.idx);
    // Tangents are not optional here. three's node materials read tangent-space
    // normal maps from a real `tangent` attribute rather than reconstructing a
    // basis from screen-space derivatives, and geometry without one shades to
    // black under every light in the scene — which looks exactly like a level
    // that simply is not lit.
    g.computeTangents();
    g.computeBoundingSphere();
    return g;
  }
}
