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

import { drawPixelSprite } from '../art/pixelate.js';

export class Actor {
  constructor(opts) {
    this.id = opts.id;
    this.name = opts.name || opts.id;
    this.x = opts.x || 0;
    this.y = opts.y || 0;
    this.speed = opts.speed || 180;      // px/s at scale 1
    this.colors = opts.colors || {};
    this.draw = opts.draw;               // (ctx, actor, scale) => void
    // A pixel sprite draws on a different surface — integer art pixels rather
    // than room units — so it is a separate slot, not a variant of `draw`.
    this.pixelDraw = opts.pixelDraw || null;
    this.height = opts.height || 165;    // room units, before depth scaling
    // How far one full stride carries the character. A person's gait cycle —
    // left foot down to left foot down — covers a little under their standing
    // height, so deriving it from the figure keeps the cadence right whatever
    // size the character is.
    //
    // This was a flat 46px, tuned by eye against nothing in particular, and at
    // 180px/s it made the legs cycle about four times a second: a sprint
    // played under a walk. The number has to relate to the body or it is only
    // ever right for one character at one speed.
    this.stride = opts.stride || this.height * 0.85;
    // Strides per second, per gait — and this is set rather than measured, on
    // evidence.
    //
    // The stride was being measured off the sheet's own foot separation, on
    // the theory that locking one cycle of animation to one stride of ground
    // would plant the feet. It does not, because the source art has no stance
    // to lock to: sweeping the stride across a 3.6x range moves the
    // planted-foot drift only between 3.4 and 4.7 pixels a frame, a flat
    // curve with no minimum, and the same measurement re-run after a re-cut
    // returned a stride 28% different. A video model animates a character that
    // LOOKS like it is walking; it does not put a foot down and leave it.
    //
    // So what the eye actually judges is set directly. 1.25 strides a second
    // is the walk this room was signed off on; 1.7 is a run, and it is the leg
    // cadence rather than the ground speed that makes a run read as one.
    this.cadence = opts.cadence || { walk: 1.25, run: 1.7 };
    // Three times walking pace. Two and a bit was already twice as fast to
    // arrive and still did not read as running, because at that speed the run
    // clip's long stride left the legs cycling at almost walking rate.
    this.runSpeed = opts.runSpeed || 3;
    this.running = false;
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
    this.body = null;              // set once a sprite atlas has loaded
    this.line = null;    // { text, until, voice }
    this.onArrive = null;
    // A named clip from the atlas — "drink", "asleep" — for the moments the
    // walk/idle pair cannot express. It is a third state rather than a mode of
    // idle, because the room asks for it by name at a scripted beat and the
    // sequencer has to be able to wait for it to end.
    this.clip = null;
    this.clipT = 0;
  }

  get busy() { return this.state === 'walk' || this.line !== null; }

  // Play a named clip from the body's atlas. Whether it loops or ends is a
  // property of the art and lives in the manifest, so the caller only names it.
  playClip(name) { this.clip = name; this.clipT = 0; return this; }
  stopClip() { this.clip = null; this.clipT = 0; }

  walkTo(walkArea, x, y, onArrive = null, run = false) {
    // Walking overrides a clip rather than blending with it: a man asleep who
    // is asked to walk is a man walking, and leaving the clip set would have
    // him slide across the dock in a sitting pose.
    this.clip = null;
    const path = walkArea.path({ x: this.x, y: this.y }, { x, y });
    if (!path || !path.length) { onArrive?.(); return false; }
    this.running = run;
    this.path = path;
    this.state = 'walk';
    this.onArrive = onArrive;
    return true;
  }

  stop() {
    this.path = null;
    this.running = false;
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

    if (this.clip) this.clipT += dt;

    if (this.line) {
      this.line.until -= dt;
      if (this.line.until <= 0) {
        this.line = null;
        if (this.state === 'talk') this.state = 'idle';
      }
    }

    if (this.state === 'walk' && this.path) {
      const scale = room ? room.scaleAt(this.y) : 1;
      const gait = this.running && this.body?.hasClip?.('run') ? 'run' : 'walk';
      const speed = this.speed * (this.running ? this.runSpeed : 1);
      // Ground covered per cycle of animation, from the cadence wanted rather
      // than from the sheet. Depth cancels: both the distance travelled and
      // the stride scale with it, so the legs cycle at the same rate wherever
      // the character is standing.
      const stride = this.cadence[gait] ? speed / this.cadence[gait] : this.stride;
      let budget = speed * scale * dt;
      while (budget > 0 && this.path.length) {
        const t = this.path[0];
        const dx = t.x - this.x, dy = t.y - this.y;
        const d = Math.hypot(dx, dy);
        if (d <= ARRIVE) { this.path.shift(); continue; }
        const step = Math.min(budget, d);
        this.x += (dx / d) * step;
        this.y += (dy / d) * step;
        this.phase += step / (stride * scale);
        // Facing is chosen from the direction of travel, biased to the sides:
        // a character seen from behind cannot act, so a diagonal reads as a
        // profile unless it is steeply vertical.
        if (Math.abs(dx) > Math.abs(dy) * 0.6) this.facing = dx > 0 ? 'right' : 'left';
        else this.facing = dy > 0 ? 'front' : 'back';
        budget -= step;
      }
      if (!this.path.length) {
        this.path = null;
        this.running = false;
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
    // An atlas sprite controls its own transform, because it has to snap to a
    // whole-pixel zoom that the room's continuous depth scale would otherwise
    // destroy. This is checked FIRST: an atlas body exposes drawAt and no
    // draw, so computing `paint` before this point and bailing when it is
    // missing skips the sprite entirely — which is how the player rendered as
    // nothing at all while every check still passed, because a bound body is
    // not a drawn one.
    if (this.body?.drawAt) {
      this.body.drawAt(ctx, this, this.x, this.y, scale);
      return;
    }
    // A pixel sprite is authored on the grid rather than scaled onto it, so it
    // takes a different surface: integer art pixels, origin between the feet.
    if (this.pixelDraw) {
      drawPixelSprite(ctx, this.x, this.y, (this.height ?? 165) * scale, this.pixelDraw, this);
      return;
    }
    // A baked sprite body when one loaded, the drawn puppet otherwise. Both
    // draw in the same space — origin between the feet, one unit per game
    // pixel — so nothing else in the engine has to know which is which.
    const paint = (this.body ? this.body.draw : this.draw);
    if (!paint) return;
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.scale(scale, scale);
    paint.call(this, ctx, this, scale);
    ctx.restore();
  }
}
