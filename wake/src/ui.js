// Live control panel, generated from params.js.
//
// Two things matter for iterating fast: every slider takes effect on the very
// next frame (the wake is re-baked from scratch each frame, so there is no
// "wait for it to settle"), and "Copy params" puts the whole tuned state on the
// clipboard as JSON to paste back into a conversation.

import { PARAMS, set } from './params.js';

const GROUP_TITLES = {
  boat: 'Boat',
  arms: 'Spray arms (the V)',
  feather: 'Feathering / comb',
  wash: 'Prop wash',
  inner: 'Inside the V',
  foamLook: 'Foam look',
  ocean: 'Water & light',
  quality: 'Performance',
  field: 'Field',
};

export function buildUI(root, hooks = {}) {
  const rows = [];

  for (const [gname, entries] of Object.entries(PARAMS)) {
    const sec = document.createElement('details');
    sec.open = !['ocean', 'field', 'quality'].includes(gname);
    const sum = document.createElement('summary');
    sum.textContent = GROUP_TITLES[gname] || gname;
    sec.appendChild(sum);

    for (const [key, p] of Object.entries(entries)) {
      const path = `${gname}.${key}`;
      const row = document.createElement('label');
      row.className = 'row';
      row.innerHTML = `<span class="lbl">${p.label}</span><span class="val"></span>`;
      const input = document.createElement('input');
      input.type = 'range';
      input.min = p.min; input.max = p.max; input.step = p.step; input.value = p.v;
      const val = row.querySelector('.val');
      const show = () => { val.textContent = (+p.v).toFixed(p.step < 0.01 ? 3 : p.step < 1 ? 2 : 0); };
      input.addEventListener('input', () => { set(path, input.value); show(); hooks.onChange?.(path); });
      row.appendChild(input);
      sec.appendChild(row);
      show();
      rows.push({ path, input, show, p, defaults: p.v });
    }
    root.appendChild(sec);
  }

  const bar = document.createElement('div');
  bar.className = 'bar';

  const copy = document.createElement('button');
  copy.textContent = 'Copy params';
  copy.onclick = async () => {
    const out = {};
    for (const [g, entries] of Object.entries(PARAMS)) {
      out[g] = {};
      for (const [k, p] of Object.entries(entries)) out[g][k] = +(+p.v).toFixed(4);
    }
    const txt = JSON.stringify(out, null, 2);
    try { await navigator.clipboard.writeText(txt); copy.textContent = 'Copied ✓'; }
    catch { console.log(txt); copy.textContent = 'See console'; }
    setTimeout(() => (copy.textContent = 'Copy params'), 1400);
  };

  const paste = document.createElement('button');
  paste.textContent = 'Paste params';
  paste.onclick = () => {
    const txt = prompt('Paste params JSON');
    if (!txt) return;
    try {
      const o = JSON.parse(txt);
      for (const [g, entries] of Object.entries(o))
        for (const [k, v] of Object.entries(entries)) set(`${g}.${k}`, v);
      for (const r of rows) { r.input.value = r.p.v; r.show(); }
      hooks.onChange?.('*');
    } catch (e) { alert('Could not parse: ' + e.message); }
  };

  const reset = document.createElement('button');
  reset.textContent = 'Reset';
  reset.onclick = () => {
    for (const r of rows) { r.p.v = r.defaults; r.input.value = r.p.v; r.show(); }
    hooks.onChange?.('*');
  };

  bar.append(copy, paste, reset);
  root.appendChild(bar);

  return { rows, refresh: () => { for (const r of rows) { r.input.value = r.p.v; r.show(); } } };
}
