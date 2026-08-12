import { SCHEMA } from './schema.js';
import { PRESETS, defaults, applyPreset, isHandheld } from '../src/presets.js';

const toHex = (c) => '#' + c.map((v) => Math.round(Math.min(Math.max(v, 0), 1) ** (1 / 2.2) * 255).toString(16).padStart(2, '0')).join('');
const fromHex = (h) => [1, 3, 5].map((i) => (parseInt(h.slice(i, i + 2), 16) / 255) ** 2.2);

function fmt(v, item) {
  if (item.integer) return String(Math.round(v));
  const span = item.max - item.min;
  if (span >= 1000) return v.toFixed(0);
  if (span >= 20) return v.toFixed(1);
  if (span >= 2) return v.toFixed(2);
  return v.toFixed(3);
}

export class UI {
  constructor(root, params, onChange) {
    this.root = root;
    this.params = params;
    this.onChange = onChange;
    this.widgets = new Map();
    this._build();
  }

  _build() {
    const root = this.root;
    root.innerHTML = '';

    const brand = document.createElement('div');
    brand.className = 'brand';
    brand.innerHTML = '<h1>ABYSSAL</h1><p>spectral ocean · cinematic renderer</p>';
    root.appendChild(brand);

    const presetRow = document.createElement('div');
    presetRow.className = 'row';
    const sel = document.createElement('select');
    sel.innerHTML = Object.keys(PRESETS).map((k) => `<option>${k}</option>`).join('');
    presetRow.innerHTML = '<label>Preset</label>';
    presetRow.appendChild(sel);
    sel.addEventListener('change', () => this.onChange({ type: 'preset', name: sel.value }));
    this.presetSelect = sel;
    root.appendChild(presetRow);

    const actions = document.createElement('div');
    actions.className = 'row';
    actions.innerHTML = '<label>Actions</label>';
    const grid = document.createElement('div');
    grid.className = 'btns three';
    const mk = (text, type) => {
      const b = document.createElement('button');
      b.textContent = text;
      b.addEventListener('click', () => this.onChange({ type }));
      return b;
    };
    this.quietBtn = mk('Quiet mode', 'quiet');
    this.rideBtn = mk('Ride', 'ride');
    // The view switch has to be reachable without a keyboard - V is not a control
    // on a phone - and it belongs next to Ride rather than buried in a slider
    // group. It names the view it will switch *to*, and only appears while riding.
    this.viewBtn = mk('Rider view', 'view');
    this.viewBtn.style.display = 'none';
    grid.append(this.rideBtn, mk('New sea', 'reseed'), mk('Photo', 'photo'));
    actions.appendChild(grid);
    const viewRow = document.createElement('div');
    viewRow.className = 'btns';
    viewRow.style.marginTop = '6px';
    viewRow.className = 'btns';
    viewRow.append(this.quietBtn, this.viewBtn);
    actions.appendChild(viewRow);
    const grid2 = document.createElement('div');
    grid2.className = 'btns';
    grid2.style.marginTop = '6px';
    grid2.append(mk('Save PNG', 'save'), mk('Copy settings', 'copy'), mk('Profile', 'profile'));
    grid2.className = 'btns three';
    actions.appendChild(grid2);
    const grid3 = document.createElement('div');
    grid3.className = 'btns';
    grid3.style.marginTop = '6px';
    grid3.append(mk('Reset', 'reset'));
    actions.appendChild(grid3);
    root.appendChild(actions);

    for (const section of SCHEMA) {
      const d = document.createElement('details');
      if (section.open) d.open = true;
      const s = document.createElement('summary');
      s.textContent = section.group;
      d.appendChild(s);
      const body = document.createElement('div');
      body.className = 'body';
      for (const item of section.items) body.appendChild(this._control(item));
      d.appendChild(body);
      root.appendChild(d);
    }
  }

  _control(item) {
    const wrap = document.createElement('div');
    wrap.className = 'ctrl';
    const p = this.params;

    if (item.type === 'color') {
      const top = document.createElement('div');
      top.className = 'top';
      top.innerHTML = `<span class="name">${item.label}</span>`;
      wrap.appendChild(top);
      const inp = document.createElement('input');
      inp.type = 'color';
      inp.value = toHex(p[item.key]);
      inp.addEventListener('input', () => {
        p[item.key] = fromHex(inp.value);
        this.onChange({ type: 'param', item });
      });
      wrap.appendChild(inp);
      this.widgets.set(item.key, { item, set: (v) => { inp.value = toHex(v); } });
      return wrap;
    }

    if (item.type === 'enum') {
      const top = document.createElement('div');
      top.className = 'top';
      top.innerHTML = `<span class="name">${item.label}</span>`;
      wrap.appendChild(top);
      const sel = document.createElement('select');
      sel.innerHTML = item.options.map((o, i) => `<option value="${i}">${o}</option>`).join('');
      const cur = item.options.indexOf(p[item.key]);
      sel.value = String(Math.max(cur, 0));
      sel.addEventListener('change', () => {
        // Store the option itself. Storing the index worked only because every
        // enum happened to be numeric; a string one would have stored 0, 1, 2.
        p[item.key] = item.options[+sel.value];
        this.onChange({ type: 'param', item });
      });
      wrap.appendChild(sel);
      this.widgets.set(item.key, {
        item,
        set: (v) => { const i = item.options.indexOf(v); sel.value = String(i >= 0 ? i : v); },
      });
      return wrap;
    }

    const top = document.createElement('div');
    top.className = 'top';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = item.label;
    const val = document.createElement('span');
    val.className = 'val';
    val.textContent = fmt(p[item.key], item);
    top.append(name, val);
    wrap.appendChild(top);

    const inp = document.createElement('input');
    inp.type = 'range';
    inp.min = item.min; inp.max = item.max; inp.step = item.step;
    inp.value = p[item.key];
    inp.addEventListener('input', () => {
      p[item.key] = item.integer ? Math.round(+inp.value) : +inp.value;
      val.textContent = fmt(p[item.key], item);
      this.onChange({ type: 'param', item });
    });
    wrap.appendChild(inp);
    this.widgets.set(item.key, { item, set: (v) => { inp.value = v; val.textContent = fmt(v, item); } });
    return wrap;
  }

  syncAll() {
    for (const [key, w] of this.widgets) w.set(this.params[key]);
    if (this.viewBtn) {
      const riding = document.body.classList.contains('riding');
      this.viewBtn.style.display = riding ? '' : 'none';
      this.viewBtn.textContent = this.params.wrView >= 0.5 ? 'Rider view' : 'Chase view';
    }
    if (this.quietBtn) {
      this.quietBtn.textContent = this.params.fpsCap > 0 && this.params.fpsCap <= 30
        ? 'Full quality' : 'Quiet mode';
    }
    if (this.rideBtn) {
      this.rideBtn.textContent = document.body.classList.contains('riding') ? 'Exit ride' : 'Ride';
    }
  }

  // A result worth reading needs longer on screen than a confirmation does.
  toast(msg, ms = 1600) {
    let el = document.querySelector('.toast');
    if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el); }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(this._t);
    this._t = setTimeout(() => el.classList.remove('show'), ms);
  }
}

// A phone runs the same shaders at three times the pixel density. Left on the
