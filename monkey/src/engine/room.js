// A room: the painting, the floor, the things you can click, and the camera.
//
// The three numbers that make a 2D room feel like a place are all here, and
// they are the ones a generated backdrop cannot supply on its own:
//
//   scale      how big the actor is at a given depth. Two anchor lines, lerped.
//              Without it a character walking upstage stays the same size and
//              the painting instantly reads as a flat picture behind a sticker.
//   occluders  what the actor passes behind. A crate is a cutout with a
//              baseline; if the actor's feet are above it, the crate draws last.
//   walk       where the floor is (see pathfind.js).
//
// Everything else — layers, parallax, hotspots — is bookkeeping. This is the
// authoring burden per room, and it is the number that decides whether a
// generated-art pipeline actually scales: three annotations, all of which a
// 3D proxy render or a depth pass can produce automatically later.

import { WalkArea } from './pathfind.js';

export class Room {
  constructor(def, view) {
    this.def = def;
    this.id = def.id;
    this.width = def.width;
    this.height = def.height;
    this.view = view;                 // { w, h } of the visible window
    this.walk = new WalkArea(def.walk, def.width, def.height);
    this.layers = def.layers || [];
    this.occluders = def.occluders || [];
    this.hotspots = def.hotspots || [];
    this.camX = 0;
    this.time = 0;
  }

  scaleAt(y) {
    const s = this.def.scale;
    if (!s) return 1;
    const t = (y - s.y0) / (s.y1 - s.y0);
    return s.s0 + (s.s1 - s.s0) * Math.max(0, Math.min(1, t));
  }

  // The camera trails the player instead of centring hard on them, because a
  // camera locked to the actor makes the background feel like it is sliding
  // and the actor like they are on a treadmill.
  follow(actor, dt, snap = false) {
    const span = Math.max(0, this.width - this.view.w);
    if (span <= 0) { this.camX = 0; return; }
    const want = Math.max(0, Math.min(span, actor.x - this.view.w * 0.5));
    this.camX = snap ? want : this.camX + (want - this.camX) * Math.min(1, dt * 3.5);
  }

  update(dt) { this.time += dt; }

  hotspotAt(x, y) {
    // Last declared wins, so a small thing sitting on a big thing (a cup on a
    // wall) can be listed after it and still be clickable.
    for (let i = this.hotspots.length - 1; i >= 0; i--) {
      const h = this.hotspots[i];
      if (h.hidden?.()) continue;
      const r = h.rect;
      if (x >= r[0] && x <= r[0] + r[2] && y >= r[1] && y <= r[1] + r[3]) return h;
    }
    return null;
  }

  render(ctx, actors) {
    ctx.save();
    ctx.translate(-Math.round(this.camX), 0);

    for (const l of this.layers) {
      if (l.front) continue;
      ctx.save();
      // Parallax is expressed as a fraction of the camera's own motion, so a
      // layer at 0 is nailed to the room and one at 1 never moves at all.
      if (l.parallax) ctx.translate(this.camX * l.parallax, 0);
      l.paint(ctx, this);
      ctx.restore();
    }

    // Actors and occluders share one depth list keyed on the y of whatever
    // touches the floor. This is the whole of 2D depth sorting and it is why
    // a room needs no per-object z beyond "where does it stand".
    const items = [];
    for (const a of actors) if (a.visible) items.push({ y: a.y, render: (c) => a.render(c, this) });
    for (const o of this.occluders) {
      if (o.hidden?.()) continue;
      items.push({ y: o.baseline, render: (c) => o.paint(c, this) });
    }
    items.sort((a, b) => a.y - b.y);
    for (const it of items) it.render(ctx);

    for (const l of this.layers) {
      if (!l.front) continue;
      ctx.save();
      if (l.parallax) ctx.translate(this.camX * l.parallax, 0);
      l.paint(ctx, this);
      ctx.restore();
    }

    ctx.restore();
  }
}
