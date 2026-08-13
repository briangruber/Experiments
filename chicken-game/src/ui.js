// DOM overlay: ticker feed, counters, hover name tag, mute toggle.

export class UI {
  constructor(audio) {
    this.eggs = 0;
    this.weird = 0;
    this.tickerEl = document.getElementById('ticker');
    this.eggEl = document.getElementById('egg-counter');
    this.weirdEl = document.getElementById('weird-counter');
    this.tagEl = document.getElementById('name-tag');

    const muteBtn = document.getElementById('mute');
    muteBtn.addEventListener('click', () => {
      audio.setMuted(!audio.muted);
      muteBtn.textContent = audio.muted ? '🔇' : '🔊';
      if (!audio.muted) audio.bok();
    });
  }

  tick(text, player = false) {
    const div = document.createElement('div');
    div.className = player ? 'tick player' : 'tick';
    div.textContent = text;
    this.tickerEl.prepend(div);
    while (this.tickerEl.children.length > 6) this.tickerEl.lastChild.remove();
    setTimeout(() => div.remove(), 10000);
  }

  addWeird() {
    this.weird++;
    this.weirdEl.textContent = `👁 ${this.weird}`;
  }

  addEgg() {
    this.eggs++;
    this.eggEl.textContent = `🥚 ${this.eggs}`;
  }

  showTag(text, x, y) {
    this.tagEl.style.display = 'block';
    this.tagEl.style.left = `${x}px`;
    this.tagEl.style.top = `${y}px`;
    this.tagEl.textContent = text;
  }

  hideTag() {
    this.tagEl.style.display = 'none';
  }
}
