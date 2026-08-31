// Game state, and the sequencer that runs interactions.
//
// An adventure game interaction is almost always a short piece of blocking
// choreography: walk over there, face it, say a line, wait for the line, take
// the thing, say another line. Written with callbacks it is a pyramid; written
// with promises it is hard to cancel and impossible to save. Written as a
// generator that yields tasks it is exactly what it reads like, and the
// sequencer stays under fifty lines.
//
//   function* useHookOnCup(g) {
//     yield walk(g.player, 640, 520);
//     yield face(g.player, 'back');
//     yield say(g.player, "A little to the left...", 1.6);
//     g.state.give('cup');
//   }
//
// Only one interaction runs at a time and input is locked while it does, which
// is the behaviour that makes cutscenes and puzzle steps the same mechanism.

export class State {
  constructor(initial = {}) {
    this.flags = { ...initial };
    this.inventory = [];
    this.listeners = new Set();
  }
  get(k) { return this.flags[k]; }
  set(k, v) { this.flags[k] = v; this.emit(); return v; }
  has(item) { return this.inventory.includes(item); }
  give(item) { if (!this.has(item)) { this.inventory.push(item); this.emit(); } }
  take(item) {
    const i = this.inventory.indexOf(item);
    if (i >= 0) { this.inventory.splice(i, 1); this.emit(); }
  }
  emit() { for (const fn of this.listeners) fn(this); }
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  // Save is the honest test of whether the game is data or accident: if the
  // whole world is flags, inventory and a position, it round-trips. Anything
  // hiding in a closure does not come back, and this is where you find out.
  serialize(extra = {}) {
    return JSON.stringify({ v: 1, flags: this.flags, inventory: this.inventory, ...extra });
  }
  restore(json) {
    const d = typeof json === 'string' ? JSON.parse(json) : json;
    if (!d || d.v !== 1) return null;
    this.flags = { ...d.flags };
    this.inventory = [...d.inventory];
    this.emit();
    return d;
  }
}

// --- tasks ------------------------------------------------------------------
// A task is { update(dt) -> done }. That is the entire contract.

export const wait = (s) => { let t = s; return { update: (dt) => (t -= dt) <= 0 }; };

export const walk = (actor, area, x, y) => {
  let started = false, done = false;
  return {
    update() {
      if (!started) { started = true; if (!actor.walkTo(area, x, y, () => { done = true; })) done = true; }
      return done;
    },
  };
};

// `towardX` is what a turn means when the requested view does not exist: face
// the thing being used, in profile, rather than a direction the art cannot
// draw. Callers that have a target pass it; the rest do not and the actor
// keeps its current profile.
export const face = (actor, dir, towardX = null) =>
  ({ update() { actor.face(dir, towardX); return true; } });

// Line length drives its own duration when no voice clip has been recorded yet,
// which keeps the writing loop readable long before anyone books a booth. When
// a clip exists its measured length wins — the same trick telenovela/ uses.
export const say = (actor, text, seconds = null, voice = null) => {
  let started = false;
  const dur = seconds ?? Math.max(1.1, Math.min(7, 0.55 + text.length * 0.045));
  return {
    update() {
      if (!started) { started = true; actor.say(text, dur, voice); }
      return actor.line === null;
    },
  };
};

// Set by main.js once the voice manifest is known. say() only carries the id;
// starting the audio is the actor's business, not the task's, so a line that
// gets interrupted stops its clip too.
export function attachVoice(actorList, voice) {
  for (const a of actorList) {
    const say0 = a.say.bind(a);
    a.say = (text, seconds, id) => { if (id) voice.play(id); return say0(text, seconds, id); };
  }
}

// Play a named clip from the actor's atlas.
//
// A looping clip is a STATE — start it and the script moves on, and it keeps
// running until something else changes it. A one-shot is a STEP — the script
// waits it out, then hands the actor back to idle. Which one a clip is comes
// from the manifest, so the script says `play(grout, 'drink')` and does not
// have to know that drinking takes two and a half seconds.
//
// An actor with no atlas — a drawn puppet, or a sheet that failed to load —
// completes instantly rather than hanging the sequencer forever, which is the
// difference between missing art and a stuck game.
export const play = (actor, clip) => {
  let started = false;
  return {
    update() {
      if (!started) {
        started = true;
        if (!actor.body?.hasClip?.(clip)) return true;
        actor.playClip(clip);
      }
      const seconds = actor.body?.clipSeconds?.(clip);
      if (seconds == null) return true;          // a loop: leave it running
      if (actor.clipT < seconds) return false;
      actor.stopClip();
      return true;
    },
  };
};

export const run = (fn) => ({ update() { fn(); return true; } });

export class Sequencer {
  constructor() { this.stack = []; this.task = null; }
  get busy() { return this.stack.length > 0; }

  start(gen) {
    // A new interaction replaces whatever was running: clicking again while a
    // line is playing should interrupt it, not queue behind it.
    this.stack = [gen];
    this.task = null;
    this.step(undefined);
  }

  cancel() { this.stack = []; this.task = null; }

  step(sent) {
    while (this.stack.length) {
      const g = this.stack[this.stack.length - 1];
      const { value, done } = g.next(sent);
      if (done) { this.stack.pop(); sent = value; continue; }
      // Yielding another generator runs it as a sub-routine, so a shared bit of
      // choreography (approach-and-face) is written once and reused.
      if (value && typeof value.next === 'function') { this.stack.push(value); sent = undefined; continue; }
      this.task = value || null;
      if (!this.task) { sent = undefined; continue; }
      return;
    }
    this.task = null;
  }

  update(dt) {
    if (!this.stack.length) return;
    if (!this.task) { this.step(undefined); return; }
    if (this.task.update(dt)) { this.task = null; this.step(undefined); }
  }
}
