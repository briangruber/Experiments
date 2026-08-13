// The control panel. Built from SCHEMA, so adding a parameter is a one-line
// change in params.js and nothing here needs to know about it.

import { SCHEMA, PRESETS, VIEWS } from './params.js';

const toHex = (c) => '#' + c
  .map((v) => Math.round(Math.min(Math.max(v, 0), 1) ** (1 / 2.2) * 255).toString(16).padStart(2, '0'))
  .join('');
const fromHex = (h) => [1, 3, 5].map((i) => (parseInt(h.slice(i, i + 2), 16) / 255) ** 2.2);

function fmt(v, item) {
  if (item.integer) return String(Math.round(v));
  const span = item.max - item.min;
  if (span >= 100) return v.toFixed(0);
  if (span >= 4) return v.toFixed(2);
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
    brand.innerHTML = '<h1>LAGOON</h1><p>stylised shallow water · three.js webgpu</p>';
    root.appendChild(brand);

    const presetRow = document.createElement('div');
    presetRow.className = 'row';
    presetRow.innerHTML = '<label>Preset</label>';
    const sel = document.createElement('select');
    sel.innerHTML = Object.keys(PRESETS).map((k) => `<option>${k}</option>`).join('');
    sel.addEventListener('change', () => this.onChange({ type: 'preset', name: sel.value }));
    presetRow.appendChild(sel);
    this.presetSelect = sel;
    root.appendChild(presetRow);

    const viewRow = document.createElement('div');
    viewRow.className = 'row';
    viewRow.innerHTML = '<label>View</label>';
    const views = document.createElement('div');
    views.className = 'btns';
    for (const name of Object.keys(VIEWS)) {
      const b = document.createElement('button');
      b.textContent = name;
      b.addEventListener('click', () => this.onChange({ type: 'view', name }));
      views.appendChild(b);
    }
    viewRow.appendChild(views);
    root.appendChild(viewRow);

    let section = root;
    for (const item of SCHEMA) {
      if (item.group) {
        const det = document.createElement('details');
        det.open = true;
        det.innerHTML = `<summary>${item.group}</summary>`;
        root.appendChild(det);
        section = det;
        continue;
      }
      section.appendChild(this._widget(item));
    }
  }

  _widget(item) {
    const row = document.createElement('div');
    row.className = 'row';
    const label = document.createElement('label');
    label.textContent = item.label;
    row.appendChild(label);

    if (item.type === 'color') {
      const input = document.createElement('input');
      input.type = 'color';
      input.value = toHex(this.params[item.key]);
      input.addEventListener('input', () => {
        this.onChange({ type: 'set', key: item.key, value: fromHex(input.value) });
      });
      row.appendChild(input);
      this.widgets.set(item.key, { item, sync: () => { input.value = toHex(this.params[item.key]); } });
      return row;
    }

    const input = document.createElement('input');
    input.type = 'range';
    input.min = item.min; input.max = item.max; input.step = item.step;
    input.value = this.params[item.key];
    const value = document.createElement('span');
    value.className = 'val';
    value.textContent = fmt(this.params[item.key], item);
    input.addEventListener('input', () => {
      const v = +input.value;
      value.textContent = fmt(v, item);
      this.onChange({ type: 'set', key: item.key, value: v });
    });
    row.append(input, value);
    this.widgets.set(item.key, {
      item,
      sync: () => {
        input.value = this.params[item.key];
        value.textContent = fmt(this.params[item.key], item);
      },
    });
    return row;
  }

  syncAll() {
    for (const w of this.widgets.values()) w.sync();
  }
}
