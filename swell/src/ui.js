import { SCHEMA, defaults } from './knobs.js';
import { SCENES, SCENE_IDS } from './scenes.js';
import { SLOTS, VARIANTS, slotSchema, slotKnobs } from './slots/index.js';

const hex = (rgb) => '#' + rgb.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');
const unhex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);

export function buildUI(app, root, hud) {
  let rows = [];

  function baseFor(key) {
    const merged = Object.assign({}, defaults, slotKnobs(app.selection), SCENES[app.sceneId].knobs);
    return merged[key];
  }

  function render() {
    root.innerHTML = '';
    rows = [];

    root.insertAdjacentHTML('beforeend',
      `<h1>swell</h1><p class="sub">A shared Three.js ocean. Nudge it, then hand the diff to your agent.</p>`);

    // ---- scenes ----
    const scenes = document.createElement('div');
    scenes.className = 'scenes';
    for (const id of SCENE_IDS) {
      const b = document.createElement('button');
      b.textContent = SCENES[id].label;
      b.className = id === app.sceneId ? 'on' : '';
      b.onclick = () => { app.setScene(id); render(); };
      scenes.appendChild(b);
    }
    root.appendChild(scenes);
    root.insertAdjacentHTML('beforeend', `<p class="note">${SCENES[app.sceneId].note}</p>`);

    // ---- slots ----
    const slotSec = section('Slots', true);
    for (const slot of SLOTS) {
      const wrap = document.createElement('div');
      wrap.className = 'slotrow';
      const sel = document.createElement('select');
      for (const v of VARIANTS[slot]) {
        const o = document.createElement('option');
        o.value = v.meta.id;
        o.textContent = v.meta.title;
        o.selected = app.selection[slot] === v.meta.id;
        sel.appendChild(o);
      }
      const why = document.createElement('p');
      why.className = 'why';
      const cur = () => VARIANTS[slot].find((v) => v.meta.id === sel.value);
      why.textContent = cur().meta.summary;
      sel.onchange = () => { app.setVariants({ [slot]: sel.value }); render(); };
      wrap.innerHTML = `<span>${slot}</span>`;
      wrap.appendChild(sel);
      wrap.appendChild(why);
      slotSec.body.appendChild(wrap);
    }
    root.appendChild(slotSec.el);

    // ---- knobs ----
    for (const group of [...SCHEMA, ...slotSchema(app.selection)]) {
      const sec = section(group.group, false);
      for (const entry of group.keys) {
        const [key] = entry;
        if (!(key in app.knobs)) continue;
        sec.body.appendChild(entry[1] === 'color' ? colorRow(key) : sliderRow(key, entry));
      }
      if (sec.body.children.length) root.appendChild(sec.el);
    }

    // ---- actions ----
    const actions = document.createElement('div');
    actions.className = 'actions';
    actions.appendChild(button('Copy tuning as JSON', async () => {
      const payload = JSON.stringify({
        scene: app.sceneId,
        variants: app.selection,
        knobs: app.tuning(),
        camera: app.cameraState(),
      }, null, 2);
      try { await navigator.clipboard.writeText(payload); } catch { /* fall through to the log */ }
      console.log(payload);
      flash('copied — paste it to your agent');
    }));
    actions.appendChild(button('Reset to scene', () => { app.resetKnobs(); render(); }, true));
    actions.appendChild(button('Reset camera', () => app.applyCamera(), true));
    root.appendChild(actions);
    root.insertAdjacentHTML('beforeend',
      `<p class="note">Changed knobs are highlighted. "Copy tuning" emits only what you changed —
       hand that to your agent along with what you were trying to fix, and it can turn a
       slider drag into a submitted variant. See AGENTS.md.</p>`);
    refresh();
  }

  function section(title, open) {
    const el = document.createElement('section');
    if (open) el.className = 'open';
    const h = document.createElement('h2');
    h.textContent = title;
    const body = document.createElement('div');
    body.className = 'body';
    h.onclick = () => el.classList.toggle('open');
    el.append(h, body);
    return { el, body };
  }

  function button(label, fn, ghost) {
    const b = document.createElement('button');
    b.textContent = label;
    if (ghost) b.className = 'ghost';
    b.onclick = fn;
    return b;
  }

  function sliderRow(key, [, min, max, step]) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<label title="${key}">${key}</label>`;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = min; input.max = max; input.step = step;
    input.value = app.knobs[key];
    const val = document.createElement('span');
    val.className = 'val';
    input.oninput = () => { app.setKnobs({ [key]: +input.value }); refresh(); };
    row.append(input, val);
    rows.push({ key, row, input, val, kind: 'num' });
    return row;
  }

  function colorRow(key) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<label title="${key}">${key}</label>`;
    const input = document.createElement('input');
    input.type = 'color';
    input.value = hex(app.knobs[key]);
    const val = document.createElement('span');
    val.className = 'val';
    input.oninput = () => { app.setKnobs({ [key]: unhex(input.value) }); refresh(); };
    row.append(input, val);
    rows.push({ key, row, input, val, kind: 'color' });
    return row;
  }

  function refresh() {
    for (const r of rows) {
      const v = app.knobs[r.key];
      const base = baseFor(r.key);
      if (r.kind === 'num') {
        r.input.value = v;
        r.val.textContent = Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(Math.abs(v) < 1 ? 3 : 2);
        r.row.classList.toggle('changed', Math.abs(v - base) > 1e-9);
      } else {
        r.input.value = hex(v);
        r.val.textContent = '';
        r.row.classList.toggle('changed', v.some((c, i) => Math.abs(c - base[i]) > 1e-6));
      }
    }
  }

  let flashUntil = 0, flashMsg = '';
  function flash(msg) { flashMsg = msg; flashUntil = performance.now() + 2400; }

  function updateHud() {
    const s = app.stats();
    const n = Object.keys(app.tuning()).length;
    hud.textContent =
      `${s.fps.toFixed(0)} fps   ${s.medianMs.toFixed(1)} ms (p95 ${s.p95Ms.toFixed(1)})\n` +
      `t=${app.getTime().toFixed(1)}s   ${n} knob${n === 1 ? '' : 's'} changed` +
      (performance.now() < flashUntil ? `\n${flashMsg}` : '');
  }

  render();
  return { render, refresh, updateHud };
}
