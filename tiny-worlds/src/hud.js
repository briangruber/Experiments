// All DOM. The 3D side never touches the document except through here.

const $ = (id) => document.getElementById(id);

export class Hud {
  constructor() {
    this.el = {
      loading: $('loading'),
      loadingBar: $('loading-bar'),
      hud: $('hud'),
      worldName: $('world-name'),
      worldEpithet: $('world-epithet'),
      pips: $('pips'),
      counter: $('counter'),
      prompt: $('prompt'),
      toast: $('toast'),
      card: $('card'),
      cardTitle: $('card-title'),
      cardSub: $('card-sub'),
      cardBody: $('card-body'),
      cardButton: $('card-button'),
      fps: $('fps'),
      hint: $('hint'),
      progress: $('progress'),
    };
    this.cardResolve = null;
    this.el.cardButton.addEventListener('click', () => this.resolveCard());
    this.el.card.addEventListener('click', (e) => { if (e.target === this.el.card) this.resolveCard(); });
  }

  resolveCard() {
    if (!this.cardResolve) return;
    const done = this.cardResolve;
    this.cardResolve = null;
    this.hideCard();
    done();
  }

  setLoading(p) {
    this.el.loadingBar.style.transform = `scaleX(${Math.max(0.02, p)})`;
  }

  hideLoading() { this.el.loading.classList.add('gone'); }

  setWorld(def, index, total) {
    this.el.worldName.textContent = def.name;
    this.el.worldEpithet.textContent = def.epithet;
    this.el.progress.textContent = `world ${index + 1} / ${total}`;
    this.el.hint.textContent = def.hint || '';
    this.el.hint.classList.toggle('visible', !!def.hint);
    if (def.hint) {
      clearTimeout(this._hintTimer);
      this._hintTimer = setTimeout(() => this.el.hint.classList.remove('visible'), 9000);
    }
  }

  setSparks(got, total) {
    if (this._pipTotal !== total) {
      this.el.pips.innerHTML = '';
      for (let i = 0; i < total; i++) {
        const d = document.createElement('i');
        this.el.pips.appendChild(d);
      }
      this._pipTotal = total;
    }
    [...this.el.pips.children].forEach((d, i) => d.classList.toggle('on', i < got));
    this.el.counter.textContent = total ? `${got} / ${total}` : '';
    if (got > 0) {
      this.el.pips.classList.remove('pop');
      void this.el.pips.offsetWidth;
      this.el.pips.classList.add('pop');
    }
  }

  showPrompt(text) {
    if (this._prompt === text) return;
    this._prompt = text;
    this.el.prompt.innerHTML = text;
    this.el.prompt.classList.add('visible');
  }

  hidePrompt() {
    if (this._prompt === null) return;
    this._prompt = null;
    this.el.prompt.classList.remove('visible');
  }

  toast(text, ms = 3200) {
    this.el.toast.textContent = text;
    this.el.toast.classList.add('visible');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => this.el.toast.classList.remove('visible'), ms);
  }

  // Returns a promise that resolves when the card is dismissed.
  showCard({ title, sub = '', body = '', button = 'Continue', dim = true }) {
    this.el.cardTitle.textContent = title;
    this.el.cardSub.textContent = sub;
    this.el.cardBody.innerHTML = body;
    this.el.cardButton.textContent = button;
    this.el.card.classList.toggle('dim', dim);
    this.el.card.classList.add('visible');
    return new Promise((resolve) => { this.cardResolve = resolve; });
  }

  hideCard() { this.el.card.classList.remove('visible'); }

  setFps(v) { this.el.fps.textContent = `${v} fps`; }

  toggleChrome(hidden) { document.body.classList.toggle('no-chrome', hidden); }
}
