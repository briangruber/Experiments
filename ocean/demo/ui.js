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

/** The legacy copy path, on a throwaway off-screen field. Deprecated, but
 * still allowed in some sandboxes that refuse the modern Clipboard API
 * outright - worth trying before giving up and showing the manual dialog. */
function execCommandCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  ta.style.top = '0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
  document.body.removeChild(ta);
  return ok;
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
    // This panel's OWN close control, not a duplicate of the HUD's settings
    // button. That one (#settings-btn) lives inside #hud, and collapsing the
    // small HUD - unrelated, its own toggle - hides everything in it but the
    // header row, taking the only way to close this panel with it. No
    // keyboard on a phone and no backdrop-tap-to-dismiss, so that stranded
    // this panel open over the sea with nothing to get it back. Living here
    // instead, inside #ui, means collapsing #hud can never take it away.
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'close';
    closeBtn.setAttribute('aria-label', 'Close settings');
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', () => this.onChange({ type: 'closePanel' }));
    brand.appendChild(closeBtn);
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

    const actions = document.createElement('details');
    actions.className = 'chrome-fold';
    const actionsSum = document.createElement('summary');
    const actionsTitle = document.createElement('span');
    actionsTitle.className = 'summary-title';
    actionsTitle.textContent = 'Actions';
    actionsSum.appendChild(actionsTitle);
    actions.appendChild(actionsSum);
    const actionsBody = document.createElement('div');
    actionsBody.className = 'body';
    const grid = document.createElement('div');
    grid.className = 'btns three';
    const mk = (text, type) => {
      const b = document.createElement('button');
      b.textContent = text;
      b.addEventListener('click', () => this.onChange({ type }));
      return b;
    };
    // Hides every control not in schema.js's KEY_PARAMS. The panel is ~420
    // sliders deep and most of them are the fine tuning behind a master; this
    // is how you find the master.
    this.essentialsBtn = mk('Essentials only', 'essentials');
    this.quietBtn = mk('Quiet mode', 'quiet');
    this.rideBtn = mk('Ride', 'ride');
    // The view switch has to be reachable without a keyboard - V is not a control
    // on a phone - and it belongs next to Ride rather than buried in a slider
    // group. It names the view it will switch *to*, and only appears while riding.
    this.viewBtn = mk('Rider view', 'view');
    this.viewBtn.style.display = 'none';
    grid.append(this.rideBtn, mk('New sea', 'reseed'), mk('Photo', 'photo'));
    actionsBody.appendChild(grid);
    const viewRow = document.createElement('div');
    viewRow.className = 'btns';
    viewRow.style.marginTop = '6px';
    viewRow.append(this.quietBtn, this.viewBtn);
    actionsBody.appendChild(viewRow);
    const grid2 = document.createElement('div');
    grid2.className = 'btns three';
    grid2.style.marginTop = '6px';
    grid2.append(mk('Save PNG', 'save'), mk('Copy all settings', 'copy'), mk('Profile', 'profile'));
    actionsBody.appendChild(grid2);
    const grid3 = document.createElement('div');
    grid3.className = 'btns';
    grid3.style.marginTop = '6px';
    grid3.append(this.essentialsBtn, mk('Reset', 'reset'));
    actionsBody.appendChild(grid3);
    actions.appendChild(actionsBody);
    root.appendChild(actions);

    for (const section of SCHEMA) {
      const d = document.createElement('details');
      if (section.open) d.open = true;
      const s = document.createElement('summary');
      const title = document.createElement('span');
      title.className = 'summary-title';
      title.textContent = section.group;
      s.appendChild(title);
      // One category at a time, so a slider that needs tuning can be copied
      // and handed back without the other 400-odd params drowning it out.
      const copyGroup = document.createElement('button');
      copyGroup.type = 'button';
      copyGroup.className = 'copy-group';
      copyGroup.textContent = 'Copy';
      copyGroup.title = `Copy the ${section.group} settings`;
      copyGroup.addEventListener('click', (e) => {
        // A <summary>'s default click toggles its <details> open/closed even
        // for a click that landed on a child button - preventDefault stops
        // that so Copy doesn't also fold the section shut.
        e.preventDefault();
        e.stopPropagation();
        this._copyKeys(section.items.map((it) => it.key), `${section.group} settings`);
      });
      s.appendChild(copyGroup);
      d.appendChild(s);
      const body = document.createElement('div');
      body.className = 'body';
      for (const item of section.items) body.appendChild(this._control(item));
      d.appendChild(body);
      root.appendChild(d);
    }
  }

  /** Used by the per-group Copy buttons below. */
  _copyKeys(keys, label) {
    const clean = {};
    for (const k of keys) clean[k] = this.params[k];
    this.copyText(JSON.stringify(clean, null, 2), label);
  }

  /**
   * Copies text via execCommand('copy'), and only if that fails, falls back
   * to a visible dialog with the text pre-selected so a person can press
   * Ctrl/Cmd+C themselves.
   *
   * Deliberately NOT using navigator.clipboard.writeText() to decide
   * success, even though it is the modern API. Its promise is exactly what
   * an embedding host's Permissions Policy gates - no `clipboard-write`
   * delegated to this iframe is the ordinary case for a published page, not
   * an edge one - and in at least this environment it plainly RESOLVES
   * having done nothing rather than rejecting: the toast said "copied" and
   * the clipboard stayed empty. Reported live: "I press copy but nothing is
   * in my clipboard, where does it go?" console.log used to be the last
   * resort before the dialog, and that was invisible too - nobody looking
   * at a published page is going to open its devtools to find their
   * settings.
   *
   * execCommand's return value has no such failure mode: it is a plain
   * synchronous boolean tied straight to whether the browser's own copy
   * command actually ran, so "true" here is trustworthy in a way an async
   * Promise's mere resolution was not.
   */
  copyText(text, label) {
    if (execCommandCopy(text)) { this.toast(`${label} copied`); return; }
    this._showCopyDialog(text, label);
  }

  _showCopyDialog(text, label) {
    document.querySelector('.copy-dialog-overlay')?.remove();
    const overlay = document.createElement('div');
    overlay.className = 'copy-dialog-overlay';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    const box = document.createElement('div');
    box.className = 'copy-dialog';
    const h = document.createElement('div');
    h.className = 'copy-dialog-title';
    h.textContent = `${label} - clipboard is blocked here`;
    const hint = document.createElement('p');
    hint.className = 'copy-dialog-hint';
    hint.textContent = 'The text below is already selected - press Ctrl+C (Cmd+C on a Mac), or copy it by hand.';
    const ta = document.createElement('textarea');
    ta.readOnly = true;
    ta.value = text;
    ta.className = 'copy-dialog-text';
    const close = document.createElement('button');
    close.textContent = 'Close';
    close.addEventListener('click', () => overlay.remove());

    box.append(h, hint, ta, close);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    // A visible, focused field is what some sandboxes actually require for
    // execCommand('copy') to work at all - the earlier attempt ran on an
    // off-screen textarea and could fail purely for being off-screen, so
    // this tries again on THIS one, already on screen and focused, before
    // settling for "select it by hand".
    ta.focus();
    ta.select();
    let copied = false;
    try { copied = document.execCommand('copy'); } catch (e) { copied = false; }
    if (copied) { overlay.remove(); this.toast(`${label} copied`); }
  }

  _control(item) {
    const wrap = document.createElement('div');
    wrap.className = 'ctrl';
    // The whole control is the hover target, not just the label text - the
    // slider and swatch are at least as much of what a thumb or a mouse
    // actually lands on. Plain title attribute, not a custom popover: it
    // needs no positioning logic, no z-index fight with a scrolling panel,
    // and works identically on every one of the ~400 controls this covers.
    if (item.hint) wrap.title = item.hint;
    // Marked so the Essentials filter can keep it while hiding the rest.
    if (item.essential) wrap.classList.add('is-key');
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
    if (this.essentialsBtn) {
      const on = this.root.classList.contains('essentials');
      this.essentialsBtn.textContent = on ? 'Show all settings' : 'Essentials only';
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
