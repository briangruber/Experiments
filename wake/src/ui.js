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
  kelvin: 'Kelvin waves',
  foamLook: 'Foam texture',
  bubbles: 'Subsurface bubbles',
  foamMotion: 'Foam motion',
  foamMix: 'Foam on water',
  ocean: 'Water & light',
  scene: 'Sky & shore',
  quality: 'Performance',
  field: 'Field & decay',
};

export function buildUI(root, hooks = {}) {
  const rows = [];

  for (const [gname, entries] of Object.entries(PARAMS)) {
    const sec = document.createElement('details');
    sec.open = !['ocean', 'quality'].includes(gname);
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

  // Copying out of an embedded artifact is harder than it looks: the async
  // clipboard API is blocked in a cross-origin iframe, and falling back to
  // console.log is useless when there is no console to reach. So: try the
  // modern API, then the old execCommand path (which is a synchronous
  // user-gesture copy and often survives where the async one does not), and
  // failing both, show the text selected and ready for a manual copy.
  const copyText = async (txt) => {
    try {
      await navigator.clipboard.writeText(txt);
      return 'clipboard';
    } catch { /* blocked in this frame — fall through */ }

    try {
      const ta = document.createElement('textarea');
      ta.value = txt;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, txt.length);
      const ok = document.execCommand('copy');
      ta.remove();
      if (ok) return 'execCommand';
    } catch { /* fall through */ }

    return null;
  };

  const showForManualCopy = (txt) => {
    const back = document.createElement('div');
    back.className = 'sheet-back';
    const box = document.createElement('div');
    box.className = 'sheet';
    box.innerHTML = '<p>Copying is blocked in this frame. The text is selected — '
                  + 'press <b>⌘C</b> or <b>Ctrl+C</b>.</p>';
    const ta = document.createElement('textarea');
    ta.value = txt;
    ta.spellcheck = false;
    const close = document.createElement('button');
    close.textContent = 'Done';
    box.append(ta, close);
    back.appendChild(box);
    document.body.appendChild(back);
    ta.focus();
    ta.select();
    const dismiss = () => back.remove();
    close.onclick = dismiss;
    back.onclick = (e) => { if (e.target === back) dismiss(); };
    addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { dismiss(); removeEventListener('keydown', esc); }
    });
  };

  const asJSON = () => {
    const out = {};
    for (const [g, entries] of Object.entries(PARAMS)) {
      out[g] = {};
      for (const [k, p] of Object.entries(entries)) out[g][k] = +(+p.v).toFixed(4);
    }
    return JSON.stringify(out, null, 2);
  };

  const copy = document.createElement('button');
  copy.textContent = 'Copy params';
  copy.onclick = async () => {
    const txt = asJSON();
    const how = await copyText(txt);
    if (how) {
      copy.textContent = 'Copied ✓';
      setTimeout(() => (copy.textContent = 'Copy params'), 1400);
    } else {
      showForManualCopy(txt);
    }
  };

  const paste = document.createElement('button');
  paste.textContent = 'Paste params';
  paste.onclick = () => {
    // prompt() is blocked in some embedded frames; fall back to the same sheet.
    let txt = null;
    try { txt = prompt('Paste params JSON'); } catch { /* blocked */ }
    if (txt === null) { pasteSheet(); return; }
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

  function pasteSheet() {
    const back = document.createElement('div');
    back.className = 'sheet-back';
    const box = document.createElement('div');
    box.className = 'sheet';
    box.innerHTML = '<p>Paste params JSON here, then apply.</p>';
    const ta = document.createElement('textarea');
    ta.spellcheck = false;
    const apply = document.createElement('button');
    apply.textContent = 'Apply';
    apply.onclick = () => {
      try {
        const o = JSON.parse(ta.value);
        for (const [g, entries] of Object.entries(o))
          for (const [k, v] of Object.entries(entries)) set(`${g}.${k}`, v);
        for (const r of rows) { r.input.value = r.p.v; r.show(); }
        hooks.onChange?.('*');
        back.remove();
      } catch (e) { box.querySelector('p').textContent = 'Could not parse: ' + e.message; }
    };
    box.append(ta, apply);
    back.appendChild(box);
    document.body.appendChild(back);
    ta.focus();
    back.onclick = (e) => { if (e.target === back) back.remove(); };
  }

  bar.append(copy, paste, reset);
  root.appendChild(bar);

  return { rows, refresh: () => { for (const r of rows) { r.input.value = r.p.v; r.show(); } } };
}
