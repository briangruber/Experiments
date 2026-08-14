// Title cards. The only words in the episode, and none of them are dialogue.
// Driven off the director's clock, not the browser's, so scrubbing and pausing
// keep the cards in sync.

export class Titles {
  constructor(root) {
    this.root = root;
    this.cards = [];
    this.el = document.createElement('div');
    this.el.className = 'cards';
    root.appendChild(this.el);
  }

  clear() {
    for (const c of this.cards) c.node.remove();
    this.cards.length = 0;
  }

  // kind: 'main' | 'act' | 'end' | 'stinger'
  show(text, opts = {}) {
    const node = document.createElement('div');
    node.className = `card card-${opts.kind || 'act'}`;
    if (opts.kicker) {
      const k = document.createElement('div');
      k.className = 'card-kicker';
      k.textContent = opts.kicker;
      node.appendChild(k);
    }
    const t = document.createElement('div');
    t.className = 'card-title';
    t.textContent = text;
    node.appendChild(t);
    if (opts.sub) {
      const s = document.createElement('div');
      s.className = 'card-sub';
      s.textContent = opts.sub;
      node.appendChild(s);
    }
    if (opts.rule) {
      const r = document.createElement('div');
      r.className = 'card-rule';
      node.insertBefore(r, t.nextSibling);
    }
    node.style.opacity = '0';
    this.el.appendChild(node);
    const card = {
      node, t: 0,
      text, sub: opts.sub || null, kicker: opts.kicker || null,
      kind: opts.kind || 'act', rule: !!opts.rule,
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
      c.node.style.opacity = String(c.alpha);
      // A slow drift, so the card feels optically printed rather than pasted on.
      const k = Math.min(1, c.t / Math.max(0.01, c.dur));
      c.progress = k;
      c.node.style.transform = `translateX(-50%) translateY(${(0.5 - k) * 6 * c.drift}px) scale(${1 + k * 0.012 * c.drift})`;
      c.node.style.letterSpacing = `${0.22 + k * 0.06}em`;
      if (!c.hold && c.t >= c.dur) { c.node.remove(); this.cards.splice(i, 1); }
    }
  }
}
