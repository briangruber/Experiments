// A person on the floor.
//
// Everything an adventure-game actor does is one of four things: stand, walk a
// path, say a line, or play a one-shot animation. Keeping it to those four is
// what lets the script language stay small — a puzzle step is a sequence of
// actor verbs, and the sequencer in script.js only has to know how to wait for
// one to finish.
//
// The actor owns no art. It hands its state to a draw function supplied by the
// room's art module, so a procedurally drawn placeholder and a generated sprite
// sheet are the same actor with a different painter. That seam is the whole
// point: the game is playable before any asset exists, and swapping in real art
// is a one-line change rather than a rewrite.

const ARRIVE = 3;      // px; closer than this to a waypoint counts as reached
const TURN_RATE = 12;  // rad/s, so a change of direction reads as a turn

export class Actor {
  constructor(opts) {
    this.id = opts.id;
    this.name = opts.name || opts.id;
    this.x = opts.x || 0;
    this.y = opts.y || 0;
    this.speed = opts.speed || 180;      // px/s at scale 1
    this.colors = opts.colors || {};
    this.draw = opts.draw;               // (ctx, actor, scale) => void
    this.talkColor = opts.talkColor || '#ffe9b0';
    this.talkOffset = opts.talkOffset ?? -150;

    this.facing = opts.facing || 'right';
    this.state = 'idle';
    this.path = null;
    this.phase = 0;      // walk-cycle phase, in strides
    this.blink = Math.random() * 4;
    // Trailing cloth, on a damped spring rather than a chase: it overshoots
    // when the character stops and settles after, which is the difference
    // between cloth and a UI transition.
    this.lag = 0;
    this.lagV = 0;
    this.visible = opts.visible !== false;
    this.line = null;    // { text, until, voice }
    this.onArrive = null;
  }

  get busy() { return this.state === 'walk' || this.line !== null; }

  walkTo(walkArea, x, y, onArrive = null) {
    const path = walkArea.path({ x: this.x, y: this.y }, { x, y });
    if (!path || !path.length) { onArrive?.(); return false; }
    this.path = path;
    this.state = 'walk';
    this.onArrive = onArrive;
    return true;
  }

  stop() {
    this.path = null;
    this.state = 'idle';
    const cb = this.onArrive;
    this.onArrive = null;
    cb?.();
  }

  say(text, seconds, voice = null) {
    this.line = { text, until: seconds, voice };
    if (this.state !== 'walk') this.state = 'talk';
  }

  face(dir) { this.facing = dir; }

  update(dt, room) {
    const want = this.state === 'walk' ? (this.facing === 'left' ? 1 : -1) : 0;
    const step = Math.min(dt, 1 / 45);      // keep the spring stable on a long frame
    this.lagV += ((want - this.lag) * 85 - this.lagV * 11) * step;
    this.lag += this.lagV * step;

    this.blink -= dt;
    if (this.blink < -0.14) this.blink = 2.5 + Math.random() * 3.5;

    if (this.line) {
      this.line.until -= dt;
      if (this.line.until <= 0) {
        this.line = null;
        if (this.state === 'talk') this.state = 'idle';
      }
    }

    if (this.state === 'walk' && this.path) {
      const scale = room ? room.scaleAt(this.y) : 1;
      let budget = this.speed * scale * dt;
      while (budget > 0 && this.path.length) {
        const t = this.path[0];
        const dx = t.x - this.x, dy = t.y - this.y;
        const d = Math.hypot(dx, dy);
        if (d <= ARRIVE) { this.path.shift(); continue; }
        const step = Math.min(budget, d);
        this.x += (dx / d) * step;
        this.y += (dy / d) * step;
        this.phase += step / (46 * scale);   // one stride per ~46 scaled px
        // Facing is chosen from the direction of travel, biased to the sides:
        // a character seen from behind cannot act, so a diagonal reads as a
        // profile unless it is steeply vertical.
        if (Math.abs(dx) > Math.abs(dy) * 0.6) this.facing = dx > 0 ? 'right' : 'left';
        else this.facing = dy > 0 ? 'front' : 'back';
        budget -= step;
      }
      if (!this.path.length) {
        this.path = null;
        this.state = this.line ? 'talk' : 'idle';
        const cb = this.onArrive;
        this.onArrive = null;
        cb?.();
      }
    } else {
      this.phase += dt * 0.6;   // idle breathing rides the same clock
    }
  }

  render(ctx, room) {
    if (!this.visible) return;
    const scale = room ? room.scaleAt(this.y) : 1;
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.scale(scale, scale);
    this.draw?.(ctx, this, scale);
    ctx.restore();
  }
}
