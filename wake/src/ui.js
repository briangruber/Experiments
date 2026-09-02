// Live control panel, generated from params.js.
//
// Two things matter for iterating fast: every slider takes effect on the very
// next frame (the wake is re-baked from scratch each frame, so there is no
// "wait for it to settle"), and "Copy params" puts the whole tuned state on the
// clipboard as JSON to paste back into a conversation.

import { PARAMS, set } from './params.js';

// Titles, and the ORDER the panel lists them in.
//
// The old order was the order things happened to be built in, which put the
// nine wake-internals groups between the boat and the sea -- so getting from
// "how fast is she going" to "what does the water look like" meant scrolling
// past every knob on the foam. The panel now reads outward from what you are
// most likely to be looking at: the boat, then the sea it is in, then the sky
// and the bottom, then the wake's own machinery, then cost.
//
// A group's position here is its position on the panel. buildPanel walks this
// map first and then anything in PARAMS it does not name, so a new group shows
// up looking unfinished rather than not showing up at all.
// Titles, and the ORDER the panel lists them in.
//
// These are SECTIONS, not storage groups, and the difference is the whole point.
// A param lives in params.js under whatever key the code reads it by -- moving
// it between groups would mean touching every get() that names it -- but where
// it APPEARS is a separate question, answered by a `ui:` tag on the param. So
// 'Sea & light' could be split into the sea and the light without renaming a
// single key: wave height stays ocean.waveHeight and simply shows up under Sea
// state, while sun elevation shows up under Sun & sky.
//
// The sections read outward from what you are most likely to be looking at, and
// each one answers a single question rather than a family of them.
const GROUP_TITLES = {
  boat:       'Boat',
  seaState:   'Sea state',                 // how the water moves
  sunSky:     'Sun & sky',                 // where the light comes from
  waterLook:  'Water look & colour',       // what the water does with it
  mirror:     'Reflections & shadows',
  bed:        'Sea bed',
  shore:      'Rocks & their spray',
  spray:      'Spray (airborne)',
  arms:       'Wake: the V',
  kelvin:     'Wake: Kelvin waves',
  feather:    'Wake: feathering / comb',
  inner:      'Wake: inside the V',
  wash:       'Wake: prop wash',
  // TWO BUBBLE SYSTEMS, and until now they sat in adjacent sections with
  // near-identical control names -- 'Bubble life', 'Rise speed' and a depth
  // control in each. Anyone tuning one was as likely to be turning the other.
  //
  // They are genuinely different things, so the titles now say which is which:
  // one is PAINTED into the wake's top-down field (no vertical extent, cannot
  // show a bubble rising), the other is real particles in the water column.
  bubbles:    'Wake: bubble haze (painted)',
  propBubbles: 'Prop bubbles (real particles)',
  foamLook:   'Foam: texture',
  foamMotion: 'Foam: motion',
  foamMix:    'Sea foam & surf (not the wake)',
  // ONE place for the boat's foam: what makes it, how it lives, how it looks.
  foam:       'Foam',
  field:      'Field & decay',
  render:     'Renderer & debug',
  quality:    'Performance',
  // The pre-abyssal lake scene, kept together and kept last. Its terrain is not
  // what you are looking at unless you have switched the abyssal sea off, and
  // scattering its controls through the sections above put a dozen sliders that
  // do nothing in the middle of ones that do.
  oldLake:    'Legacy lake scene',
};

/**
 * A row of named boats, rather than a numbered slider.
 *
 * "Boat model: 3" tells you nothing about which boat you are about to get.
 * This is one of the few controls here whose value is a NAME and not a
 * quantity -- every other row is a number with a meaningful in-between, which
 * is what a slider is for. This one has no in-between at all.
 */
export function buildBoatPicker(root, boats, { onPick, initial = 0, title: heading = 'Boat' } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'boats';
  const title = document.createElement('div');
  title.className = 'boats-title';
  title.textContent = heading;
  wrap.appendChild(title);

  const row = document.createElement('div');
  row.className = 'boats-row';
  const buttons = [];

  const select = (i, fire = true) => {
    for (const [j, b] of buttons.entries()) {
      const on = j === i;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    }
    if (fire) onPick?.(i);
  };

  boats.forEach((b, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'boat';
    btn.textContent = b.label;
    btn.title = b.label;
    btn.onclick = () => select(i);
    row.appendChild(btn);
    buttons.push(btn);
  });

  wrap.appendChild(row);
  root.appendChild(wrap);
  select(initial, false);
  return { select: (i) => select(i, false) };
}

export function buildUI(root, hooks = {}) {
  const rows = [];

  // Panel order comes from GROUP_TITLES, not from the order the groups happen
  // to be declared in params.js -- that order is a build order and reads like
  // one. Anything in PARAMS without a title still gets listed, at the end,
  // under its raw name: a new group should show up looking unfinished rather
  // than not show up at all.
  // Bucket every param into its SECTION -- its `ui:` tag if it has one, else
  // the group it is stored under. This is what lets the panel be organised by
  // subject while the keys stay where the code expects them.
  const sections = new Map();
  for (const [gname, entries] of Object.entries(PARAMS)) {
    for (const [key, p] of Object.entries(entries)) {
      const sec = p.ui || gname;
      if (!sections.has(sec)) sections.set(sec, []);
      sections.get(sec).push([key, p, gname]);
    }
  }
  const titled = Object.keys(GROUP_TITLES).filter((g) => sections.has(g));
  const untitled = [...sections.keys()].filter((g) => !GROUP_TITLES[g]);

  // FIND. A few hundred sliders in sixteen shut groups is a filing cabinet,
  // and the way into a filing cabinet is by name. Type a word or two and only
  // the rows whose label mentions all of them stay, with their
  // groups opened; clear it and the panel goes back to how you had it.
  const find = document.createElement('input');
  find.type = 'search';
  find.className = 'find';
  find.placeholder = 'Find a setting…  (/)';
  find.setAttribute('aria-label', 'Find a setting');
  find.autocomplete = 'off';
  root.appendChild(find);
  const built = [];   // { sec, title, wasOpen, rows: [{ row, text }] }
  const applyFind = () => {
    const words = find.value.toLowerCase().split(/\s+/).filter(Boolean);
    const on = words.length > 0;
    let any = 0;
    for (const b of built) {
      if (on && b.wasOpen === null) b.wasOpen = b.sec.open;
      let n = 0;
      for (const r of b.rows) {
        const hit = !on || words.every((w) => r.text.includes(w));
        r.row.hidden = !hit;
        if (hit) n ++;
      }
      b.sec.hidden = on && n === 0;
      if (on) b.sec.open = n > 0;
      else if (b.wasOpen !== null) { b.sec.open = b.wasOpen; b.wasOpen = null; }
      any += n;
    }
    find.classList.toggle('none', on && any === 0);
  };
  find.addEventListener('input', applyFind);
  find.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { find.value = ''; applyFind(); find.blur(); }
    // Arrow keys steer the boat; typing in here must not.
    e.stopPropagation();
  });
  find.addEventListener('keyup', (e) => e.stopPropagation());
  window.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== find &&
        !/input|textarea|select/i.test(document.activeElement?.tagName || '')) {
      e.preventDefault(); find.focus(); find.select();
    }
  });

  for (const gname of [...titled, ...untitled]) {
    // The array, not an object keyed by name: two storage groups can hold the
    // same key (ocean.tint and scene.waterTint both end up under Water look),
    // and collapsing them into an object would silently drop one of them.
    const entries = sections.get(gname).slice().sort((a, b) => (a[1].o || 0) - (b[1].o || 0));
    const sec = document.createElement('details');
    // Shut by default. Sixteen open groups is a wall of sliders between you
    // and the water, and the two controls anyone actually reaches for first --
    // which boat, which weather -- are pickers above this, not sliders in it.
    sec.open = false;
    const sum = document.createElement('summary');
    sum.textContent = GROUP_TITLES[gname] || gname;
    sec.appendChild(sum);
    const entry = { sec, title: sum.textContent.toLowerCase(), wasOpen: null, rows: [] };

    let shown = 0;
    for (const [key, p, storedIn] of entries) {
      // The STORAGE path, not the section's. gname is now where the row is
      // shown; storedIn is the group the value actually lives under, and it is
      // what get()/set() and every hook key on.
      const path = `${storedIn}.${key}`;
      // Controls for the analytic fallback ocean, which is hidden whenever the
      // Abyssal sea is on. Showing a slider that cannot move anything visible
      // is worse than not showing it: it costs a round of "is this broken?"
      // every time. The parameter stays -- the fallback still reads it.
      if (p.lab && hooks.hideLab !== false) continue;
      // Retired from the rail: the old recipe's foam controls. The values
      // stay (the shaders still read them) but there is one foam now.
      if (p.hide) continue;
      shown ++;
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
      // The LABEL only. Matching the group title too meant 'foam' listed every
      // row of every foam group, which is the wall of sliders the finder is
      // there to get past.
      entry.rows.push({ row, text: p.label.toLowerCase() });
      show();
      rows.push({ path, input, show, p, defaults: p.v });
    }
    if (shown) { root.appendChild(sec); built.push(entry); }
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
