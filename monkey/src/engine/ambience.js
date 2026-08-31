// The room you are standing in, heard rather than seen.
//
// Three channels, because they behave differently and a player treats them
// differently:
//
//   BED    the room's own continuous tone, looping forever, swapped when you
//          change room. Cross-faded on the swap, because a hard cut between
//          two room tones is the most obvious edit in the whole game — the
//          picture changes at a door and nobody minds, but the sound stopping
//          dead announces that none of it is real.
//   SHOTS  occasional events on top of the bed, at unpredictable intervals.
//          A bed alone is wallpaper. What makes a place sound inhabited is
//          that something happens in it and you cannot predict when.
//   MUSIC  one theme, quietly, on its own channel and its own volume, because
//          it is the first thing anyone turns off.
//
// Everything degrades to silence. No manifest, no files, or a browser that
// refuses to autoplay all leave the game working exactly as before.

// Autoplay is refused until the page has been interacted with, and a game that
// starts silent and stays silent because the very first click was consumed by
// the title screen is a bug people report as "no sound". So every channel is
// armed on load and started on the first gesture of any kind.
const GESTURES = ['pointerdown', 'keydown', 'touchstart'];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export class Ambience {
  constructor(base = './assets/sound/') {
    this.base = base;
    this.manifest = null;
    this.bedVolume = 0.5;
    this.musicVolume = 0.28;
    this.shotVolume = 0.42;
    this.muted = false;
    this.room = null;
    this.bed = null;          // the element currently playing the bed
    this.music = null;
    this.shots = new Map();
    this.timer = null;
    this.started = false;
    this.wanted = null;       // room asked for before the first gesture
  }

  async load() {
    const inline = globalThis.window?.__ASSETS?.sound;
    if (inline) { this.manifest = inline.manifest; this.clips = inline.clips; }
    else {
      try {
        const res = await fetch(this.base + 'manifest.json');
        if (!res.ok) return false;
        this.manifest = await res.json();
      } catch { return false; }
    }
    // Arm now, play at the first touch. Attached even when a gesture has
    // already happened, since `once` handlers that never fire cost nothing.
    const go = () => { this.started = true; this.begin(); };
    for (const g of GESTURES) addEventListener(g, go, { once: true });
    return true;
  }

  src(id) { return this.clips ? this.clips[id] : `${this.base}${id}.mp3`; }
  has(id) { return !!this.manifest?.sounds?.[id]; }
  idsFor(room, kind) {
    const s = this.manifest?.sounds ?? {};
    return Object.keys(s).filter((id) => s[id].kind === kind && (kind === 'music' || s[id].room === room));
  }

  element(id, volume, loop) {
    const a = new Audio(this.src(id));
    a.loop = loop;
    a.volume = this.muted ? 0 : volume;
    a.preload = 'auto';
    return a;
  }

  // Called by the game whenever the room changes, including the first time.
  enter(room) {
    this.wanted = room;
    if (!this.started || !this.manifest) return;
    this.begin();
  }

  begin() {
    if (!this.manifest || this.wanted === null) return;
    if (this.room !== this.wanted) {
      this.room = this.wanted;
      this.swapBed(this.idsFor(this.room, 'bed')[0] ?? null);
      this.scheduleShot();
    }
    this.startMusic();
  }

  startMusic() {
    if (this.music || this.muted) return;
    const id = this.idsFor(null, 'music')[0];
    if (!id) return;
    this.music = this.element(id, this.musicVolume, true);
    this.music.play().catch(() => {});
  }

  // Cross-fade rather than cut. Two elements briefly, the old one fading out
  // while the new one comes up, then the old one is dropped.
  swapBed(id, seconds = 1.2) {
    const old = this.bed;
    if (!id) { this.bed = null; if (old) this.fadeOut(old, seconds); return; }
    const next = this.element(id, 0, true);
    this.bed = next;
    next.play().catch(() => {});
    const target = this.muted ? 0 : this.bedVolume;
    const t0 = performance.now();
    const step = () => {
      const k = clamp((performance.now() - t0) / (seconds * 1000), 0, 1);
      next.volume = target * k;
      if (old) old.volume = clamp(old.volume, 0, 1) * 0 + (this.muted ? 0 : this.bedVolume) * (1 - k);
      if (k < 1) requestAnimationFrame(step);
      else if (old) { old.pause(); old.src = ''; }
    };
    requestAnimationFrame(step);
  }

  fadeOut(el, seconds = 1.2) {
    const from = el.volume, t0 = performance.now();
    const step = () => {
      const k = clamp((performance.now() - t0) / (seconds * 1000), 0, 1);
      el.volume = from * (1 - k);
      if (k < 1) requestAnimationFrame(step);
      else { el.pause(); el.src = ''; }
    };
    requestAnimationFrame(step);
  }

  // The next one-shot, at a random time. The gap is long and the spread is
  // wide on purpose: a bell every twelve seconds is a metronome, and a
  // metronome is the opposite of atmosphere.
  scheduleShot(min = 9000, max = 26000) {
    clearTimeout(this.timer);
    const ids = this.idsFor(this.room, 'shot');
    if (!ids.length) return;
    this.timer = setTimeout(() => {
      this.fire(ids[Math.floor(Math.random() * ids.length)]);
      this.scheduleShot(min, max);
    }, min + Math.random() * (max - min));
  }

  // Fire one now. Also the hook the game uses for a sound tied to an action.
  fire(id) {
    if (this.muted || !this.has(id)) return null;
    let a = this.shots.get(id);
    // One element per sound, rewound: two of the same gull overlapping is
    // never what was wanted, and it keeps the element count bounded.
    if (!a) { a = this.element(id, this.shotVolume, false); this.shots.set(id, a); }
    a.volume = this.shotVolume;
    try { a.currentTime = 0; } catch { /* not ready yet */ }
    a.play().catch(() => {});
    return a;
  }

  setMuted(on) {
    this.muted = on;
    if (this.bed) this.bed.volume = on ? 0 : this.bedVolume;
    if (this.music) this.music.volume = on ? 0 : this.musicVolume;
    for (const a of this.shots.values()) a.volume = on ? 0 : this.shotVolume;
    if (!on) this.startMusic();
  }

  setMusic(on) {
    if (on) { this.startMusic(); return; }
    if (this.music) { this.fadeOut(this.music, 0.8); this.music = null; }
  }
}
