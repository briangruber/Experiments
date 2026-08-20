import { SCHEMA, defaults } from './knobs.js';
import { SCENES, SCENE_IDS } from './scenes.js';
import { SLOTS, VARIANTS, slotSchema, slotKnobs } from './slots/index.js';

const hex = (rgb) => '#' + rgb.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');
const unhex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);

export function buildUI(app, root, hud) {
  let rows = [];
  let quality = null;

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

    // ---- display ----
    const disp = section('Display', false);
    const adaptRow = document.createElement('div');
    adaptRow.className = 'row';
    adaptRow.innerHTML = '<label title="Track a 60 Hz budget by trading resolution">adaptive</label>';
    const adapt = document.createElement('input');
    adapt.type = 'checkbox';
    adapt.checked = app.adaptive;
    const scaleVal = document.createElement('span');
    scaleVal.className = 'val';
    adapt.onchange = () => app.setAdaptive(adapt.checked);
    adaptRow.append(adapt, scaleVal);
    disp.body.appendChild(adaptRow);

    const scaleRow = document.createElement('div');
    scaleRow.className = 'row';
    scaleRow.innerHTML = '<label title="Fraction of the window actually rasterised">render scale</label>';
    const scale = document.createElement('input');
    scale.type = 'range';
    scale.min = 0.25; scale.max = 1; scale.step = 0.05;
    scale.value = app.renderScale;
    const sv = document.createElement('span');
    sv.className = 'val';
    scale.oninput = () => { app.setAdaptive(false); adapt.checked = false; app.setRenderScale(+scale.value); };
    scaleRow.append(scale, sv);
    disp.body.appendChild(scaleRow);
    disp.body.insertAdjacentHTML('beforeend',
      '<p class="note">Wave count and foam history taps are the two knobs that cost the most. ' +
      'Dropping render scale widens the wave filter as well, so a half-resolution sea is softer ' +
      'rather than noisier.</p>');
    root.appendChild(disp.el);
    quality = { adapt, scale, sv, scaleVal };

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
      // Sandboxed frames refuse the clipboard, and a silent failure here loses
      // the one artefact a human tuner actually produces. Show it instead.
      let copied = false;
      try { await navigator.clipboard.writeText(payload); copied = true; } catch { /* shown below */ }
      console.log(payload);
      if (copied) flash('copied — paste it to your agent');
      else showTuning(payload);
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

  function showTuning(text) {
    document.getElementById('tuning-out')?.remove();
    const box = document.createElement('div');
    box.id = 'tuning-out';
    box.className = 'tuning-out';
    const ta = document.createElement('textarea');
    ta.readOnly = true;
    ta.value = text;
    const close = document.createElement('button');
    close.textContent = 'Close';
    close.onclick = () => box.remove();
    box.insertAdjacentHTML('beforeend', '<p>Select and copy — this frame cannot reach the clipboard.</p>');
    box.append(ta, close);
    document.body.appendChild(box);
    ta.focus(); ta.select();
  }

  let flashUntil = 0, flashMsg = '';
  function flash(msg) { flashMsg = msg; flashUntil = performance.now() + 2400; }

  function updateHud() {
    const s = app.stats();
    const n = Object.keys(app.tuning()).length;
    const pctScale = Math.round(app.renderScale * 100);
    hud.textContent =
      `${s.fps.toFixed(0)} fps   ${s.medianMs.toFixed(1)} ms (p95 ${s.p95Ms.toFixed(1)})\n` +
      `${pctScale}% scale   t=${app.getTime().toFixed(1)}s   ${n} knob${n === 1 ? '' : 's'} changed` +
      (performance.now() < flashUntil ? `\n${flashMsg}` : '');
    if (quality) {
      quality.scale.value = app.renderScale;
      quality.sv.textContent = `${pctScale}%`;
      quality.scaleVal.textContent = app.adaptive ? 'auto' : 'fixed';
      quality.adapt.checked = app.adaptive;
    }
  }

  render();
  return { render, refresh, updateHud };
}
