// DOM overlay: two counters, a hover name tag, and the sound toggle.
// Deliberately no running commentary — what the chickens are doing has to be
// legible from the chickens themselves.

export class UI {
  constructor(audio) {
    this.eggs = 0;
    this.weird = 0;
    this.eggEl = document.getElementById('egg-counter');
    this.weirdEl = document.getElementById('weird-counter');
    this.tagEl = document.getElementById('name-tag');
    this.hintEl = document.getElementById('hint');

    const muteBtn = document.getElementById('mute');
    muteBtn.addEventListener('click', () => {
      audio.setMuted(!audio.muted);
      muteBtn.textContent = audio.muted ? '🔇' : '🔊';
      muteBtn.setAttribute('aria-label', audio.muted ? 'Turn sound on' : 'Turn sound off');
      if (!audio.muted) audio.bok();
    });
  }

  addWeird() {
    this.weird++;
    this.weirdEl.textContent = `👁 ${this.weird}`;
  }

  addEgg(n = 1) {
    this.eggs += n;
    this.eggEl.textContent = `🥚 ${this.eggs}`;
    this.eggEl.classList.remove('pop');
    void this.eggEl.offsetWidth;   // restart the animation
    this.eggEl.classList.add('pop');
  }

  // The controls line has done its job once the player has used them.
  dismissHint() {
    if (this.hintEl) this.hintEl.classList.add('gone');
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
