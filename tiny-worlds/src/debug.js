// A panel for driving the game from the outside: jump to any world, force the
// events that are otherwise minutes apart, and watch the numbers that decide
// whether something is broken or just slow.
//
// Toggled with ` (backquote), or opened at load with ?debug=1. It is built
// from the same handle the capture harness uses, so anything the panel can do
// is also scriptable.

const ROWS = [
  ['world', (g) => g.planets[g.state.worldIndex].def.name],
  ['mode', (g) => g.state.mode],
  ['sparks', (g) => `${g.state.sparks} / ${g.planets[g.state.worldIndex].moteTotal ?? 0}`],
  ['bloomed', (g) => (g.planets[g.state.worldIndex].bloomed ? 'yes' : 'no')],
  ['portal', (g) => (g.planets[g.state.worldIndex].portal ? 'open' : '—')],
  ['gloom', (g) => {
    const gl = g.planets[g.state.worldIndex].gloom;
    return gl ? `${gl.mobs.filter((m) => m.root.visible).length} / ${gl.mobs.length}` : '—';
  }],
  ['meteors', (g) => g.planets[g.state.worldIndex].meteors?.live.length ?? '—'],
  ['altitude', (g) => {
    const p = g.planets[g.state.worldIndex];
    return (g.player.local.length() - p.groundRadius(g.player.up)).toFixed(2);
  }],
  ['speed', (g) => g.player.speed.toFixed(2)],
  ['grounded', (g) => (g.player.grounded ? 'yes' : 'no')],
];

export class Debug {
  constructor(game, { open = false } = {}) {
    this.game = game;
    this.el = document.createElement('div');
    this.el.id = 'debug';
    this.el.innerHTML = `
      <div class="dbg-title">debug <span class="dbg-key">\`</span></div>
      <div class="dbg-section">worlds</div>
      <div class="dbg-worlds"></div>
      <div class="dbg-section">this world</div>
      <div class="dbg-actions"></div>
      <div class="dbg-section">state</div>
      <table class="dbg-stats"></table>`;
    document.body.appendChild(this.el);

    const worlds = this.el.querySelector('.dbg-worlds');
    game.planets.forEach((p, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = `${i + 1}. ${p.def.name}`;
      b.addEventListener('click', () => game.goto(i));
      worlds.appendChild(b);
    });

    const actions = this.el.querySelector('.dbg-actions');
    const act = (label, fn) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.addEventListener('click', fn);
      actions.appendChild(b);
    };
    act('bloom now', () => game.bloom());
    act('+1 spark', () => game.giveSpark());
    act('drop meteor', () => game.dropMeteor());
    act('clear gloom', () => game.clearGloom());
    act('open portal', () => game.openPortal());
    act('hide UI', () => game.hud.toggleChrome(!document.body.classList.contains('no-chrome')));

    this.stats = this.el.querySelector('.dbg-stats');
    this.cells = ROWS.map(([label]) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<th>${label}</th><td>—</td>`;
      this.stats.appendChild(tr);
      return tr.lastChild;
    });

    this.visible = false;
    this.setVisible(open);
    this.acc = 0;
  }

  setVisible(v) {
    this.visible = v;
    this.el.classList.toggle('open', v);
  }

  toggle() { this.setVisible(!this.visible); }

  // Refreshed a few times a second, not every frame: this is DOM, and the
  // numbers are unreadable at 60Hz anyway.
  update(dt) {
    // Read the class rather than a private flag: the harness (and the panel's
    // own screenshots) open it by adding the class directly, and a private
    // flag would leave every readout stuck on an em dash.
    if (!this.el.classList.contains('open')) return;
    this.acc += dt;
    if (this.acc < 0.2) return;
    this.acc = 0;
    ROWS.forEach(([, read], i) => {
      let value = '—';
      try { value = String(read(this.game)); } catch { /* mid-transition */ }
      if (this.cells[i].textContent !== value) this.cells[i].textContent = value;
    });
  }
}
