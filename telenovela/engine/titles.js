// Title cards. The only words in the episode, and none of them are dialogue.
// Driven off the director's clock, not the browser's, so scrubbing and pausing
// keep the cards in sync.
//
// Cards are pure state — text, kind, alpha, progress — and nothing here
// touches the DOM. The drawing lives in cards.js, and the same drawCards()
// paints this state onto the live page's overlay canvas, the export mixing
// canvas and the offline renderer's frames alike. The page used to build DOM
// cards instead, which meant every export re-implemented ui.css by hand and
// repeatedly got it subtly wrong; one renderer ended that.

export class Titles {
  constructor() {
    this.cards = [];
    this.live = null;      // the subtitle currently holding the bottom slot
  }

  clear() {
    this.cards.length = 0;
    this.live = null;
  }

  // Subtitles occupy one slot at the bottom of the frame: a new line replaces
  // whatever is there rather than piling on top of it, which is what makes a
  // three-line reaction volley readable.
  // `speaker` puts a name plate beside the line; `narration` styles it as the
  // announcer rather than as somebody in the courtyard.
  subtitle(text, dur = 3, opts = {}) {
    if (this.live && this.cards.includes(this.live)) this.dismiss(this.live);
    this.live = this.show(text, {
      kind: 'subtitle', dur, fadeIn: 0.25, fadeOut: 0.3, drift: 0,
      speaker: opts.speaker || null, narration: !!opts.narration,
    });
    return this.live;
  }

  // kind: 'main' | 'act' | 'end' | 'stinger' | 'subtitle'
  show(text, opts = {}) {
    const card = {
      t: 0,
      text, sub: opts.sub || null, kicker: opts.kicker || null,
      kind: opts.kind || 'act', rule: !!opts.rule,
      speaker: opts.speaker || null, narration: !!opts.narration,
      alpha: 0, progress: 0,
      dur: opts.dur ?? 3.4,
      fadeIn: opts.fadeIn ?? 0.9,
      fadeOut: opts.fadeOut ?? 1.1,
      drift: opts.drift ?? 1,
      hold: opts.hold ?? false,
    };
    this.cards.push(card);
    return card;
  }

  dismiss(card) { if (card) { card.hold = false; card.t = Math.max(card.t, card.dur - card.fadeOut); } }
  dismissAll() { for (const c of this.cards) this.dismiss(c); }

  update(dt) {
    for (let i = this.cards.length - 1; i >= 0; i--) {
      const c = this.cards[i];
      c.t += dt;
      const inA = Math.min(1, c.t / c.fadeIn);
      const outA = c.hold ? 1 : 1 - Math.max(0, (c.t - (c.dur - c.fadeOut)) / c.fadeOut);
      const a = Math.max(0, Math.min(inA, outA));
      c.alpha = a * a * (3 - 2 * a);
      // Drives the slow drift in the renderer, so the card feels optically
      // printed rather than pasted on.
      c.progress = Math.min(1, c.t / Math.max(0.01, c.dur));
      if (!c.hold && c.t >= c.dur) {
        this.cards.splice(i, 1);
        if (c === this.live) this.live = null;
      }
    }
  }
}
