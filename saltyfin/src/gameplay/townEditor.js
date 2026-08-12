// The town layout editor.
//
// Stilt Town is data now -- town.js holds a layout of { k, x, z, ... } items
// and can rebuild itself from one -- and this module is the pair of hands. It
// owns three things and nothing else: an orbit camera over the town, a gold
// selection ring (the only 3D it brings), and two strips of DOM. The town
// itself stays entirely town.js's problem: every edit goes through
// town.rebuild(), which sanitizes whatever it is handed, so this file never
// has to be the one that decides what a legal shop is.
//
// The one rule that shapes everything here is that rebuild() is EXPENSIVE --
// on the order of 100 ms of re-baking geometry -- so it happens only on a
// commit: pointer-up at the end of a drag, a button press, an Apply. While a
// drag is live the only thing that moves is the ring. The building visibly
// stays put until the finger lifts, and that is a deliberate trade: a 100 ms
// stall on every pointermove is an editor nobody can stand to use, and the
// ring gliding to where the building is ABOUT to be reads clearly enough.
//
// Undo is a stack of applied layouts, not of operations. Layouts are small
// (a few dozen items of a handful of numbers), a deep copy is one
// JSON round-trip, and "put the whole town back how it was" cannot have
// edge cases the way "reverse this edit" can.
//
// Persistence is one localStorage key, written on every successful commit
// and read by town.js at boot -- so an edited town survives a reload without
// this module being involved in loading at all.

import * as THREE from 'three';
import { uniform, vec3, sin } from 'three/tsl';
import { LAYER, setLayers } from '../core/layers.js';
import { applyWaterClip } from '../water/clip.js';
import { TOWN_LAYOUT_KEY } from '../world/town.js';
import { LIBRARY } from '../world/assetLibrary.js';
import { THUMBS } from '../world/assetThumbs.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (t) => t * t * (3 - 2 * t);
const deepCopy = (o) => JSON.parse(JSON.stringify(o));

// --- tuning ------------------------------------------------------------------

const EASE_TIME = 0.7;        // seconds, entry glide from wherever the camera was
const ORBIT_GAIN = 0.006;     // rad per px of drag, yaw
const PITCH_GAIN = 0.004;     // rad per px of drag, pitch
const PITCH_MIN = 0.25, PITCH_MAX = 1.35;
const DIST_MIN = 8, DIST_MAX = 70;
// The camera target may wander a little past the editable region so you can
// look at the town edge-on, but not off into open water.
const TARGET_X = 45, TARGET_Z = 48;
// Where items are allowed to BE, in town-local metres. rebuild() clamps too;
// clamping during the drag as well keeps the ring from sailing off the deck
// and snapping back on release, which reads as the editor losing the item.
const EDIT_X = 24, EDIT_Z = 40;
const PICK_SLOP = 0.7;        // metres beyond the footprint a tap still hits
const ROT_STEP = Math.PI / 12;   // 15 degrees
const UNDO_CAP = 25;
const RESET_ARM_MS = 2500;

// --- the DOM -----------------------------------------------------------------
//
// Same visual language as the rest of the overlays: dark glass, thin light
// border, small caps. The root spans the viewport but takes no pointer events
// itself -- only the bars do -- so the canvas underneath stays draggable, the
// same trick oceanPanel plays. `data-sf-ui` on the root keeps any press that
// starts on a bar out of the game's own pointer bookkeeping (see core/input.js).

const CSS = `
#sf-edit { position: fixed; inset: 0; z-index: 72; display: none; pointer-events: none;
  font: 600 10px/1.4 ui-sans-serif, system-ui, sans-serif; color: #dceaf7;
  -webkit-user-select: none; user-select: none; }
#sf-edit.on { display: block; }
#sf-edit .bar { pointer-events: auto; display: flex; align-items: center;
  flex-wrap: wrap; justify-content: center; gap: 6px; max-width: 94vw;
  background: rgba(8,20,36,.86); border: 1px solid rgba(206,232,255,.24);
  border-radius: 10px; padding: 6px 8px;
  backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); }
#sf-edit .bar.top { position: absolute; left: 50%; transform: translateX(-50%);
  top: max(10px, env(safe-area-inset-top)); }
#sf-edit .dock { position: absolute; left: 50%; transform: translateX(-50%);
  bottom: max(12px, env(safe-area-inset-bottom)); display: flex;
  flex-direction: column; align-items: center; gap: 8px; pointer-events: none; }
#sf-edit .lbl { letter-spacing: .18em; text-transform: uppercase; font-size: 9px;
  color: rgba(140,190,235,.72); padding: 0 4px; }
#sf-edit .status { letter-spacing: .14em; text-transform: uppercase; font-size: 9px;
  color: rgba(196,222,244,.72); text-shadow: 0 1px 4px rgba(0,0,0,.6);
  white-space: nowrap; }
#sf-edit button, #sf-edit-io button, #sf-edit-lib button { appearance: none;
  border: 1px solid rgba(206,232,255,.24); background: rgba(12,28,48,.7);
  color: #dceaf7; border-radius: 8px; min-height: 40px; padding: 6px 12px;
  cursor: pointer; font: 600 10px/1 ui-sans-serif, system-ui, sans-serif;
  letter-spacing: .12em; text-transform: uppercase; }
#sf-edit button:active, #sf-edit-io button:active, #sf-edit-lib button:active {
  background: rgba(122,178,232,.34); color: #fff; }
#sf-edit button:disabled { opacity: .35; cursor: default; }
#sf-edit button:disabled:active { background: rgba(12,28,48,.7); color: #dceaf7; }
#sf-edit .sep { width: 1px; align-self: stretch; margin: 2px;
  background: rgba(206,232,255,.18); }
#sf-edit-io { position: fixed; inset: 0; z-index: 80; display: none;
  align-items: center; justify-content: center; background: rgba(4,10,20,.55);
  font: 600 10px/1.4 ui-sans-serif, system-ui, sans-serif; color: #dceaf7; }
#sf-edit-io.on { display: flex; }
#sf-edit-io .card { width: 92vw; max-width: 520px; box-sizing: border-box;
  background: rgba(8,20,36,.92); border: 1px solid rgba(206,232,255,.24);
  border-radius: 10px; padding: 14px;
  backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); }
#sf-edit-io .title { letter-spacing: .18em; text-transform: uppercase;
  font-size: 10px; color: rgba(214,236,255,.82); margin-bottom: 8px; }
#sf-edit-io textarea { display: block; width: 100%; box-sizing: border-box;
  resize: vertical; background: rgba(4,12,24,.8); color: #cfe4f6;
  border: 1px solid rgba(206,232,255,.18); border-radius: 8px; padding: 8px;
  font: 500 11px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }
#sf-edit-io .row { display: flex; gap: 6px; justify-content: flex-end;
  margin-top: 10px; }
#sf-edit-lib { position: fixed; inset: 0; z-index: 80; display: none;
  align-items: center; justify-content: center; background: rgba(4,10,20,.55);
  font: 600 10px/1.4 ui-sans-serif, system-ui, sans-serif; color: #dceaf7; }
#sf-edit-lib.on { display: flex; }
#sf-edit-lib .card { width: 92vw; max-width: 560px; box-sizing: border-box;
  background: rgba(8,20,36,.92); border: 1px solid rgba(206,232,255,.24);
  border-radius: 10px; padding: 14px;
  backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); }
#sf-edit-lib .title { letter-spacing: .18em; text-transform: uppercase;
  font-size: 10px; color: rgba(214,236,255,.82); margin-bottom: 8px; }
#sf-edit-lib input { display: block; width: 100%; box-sizing: border-box;
  background: rgba(4,12,24,.8); color: #cfe4f6; margin-bottom: 10px;
  border: 1px solid rgba(206,232,255,.18); border-radius: 8px; padding: 9px 10px;
  font: 500 13px/1.2 ui-sans-serif, system-ui, sans-serif; }
#sf-edit-lib .grid { display: grid; gap: 8px; overflow-y: auto;
  grid-template-columns: repeat(auto-fill, minmax(92px, 1fr));
  max-height: 52vh; overscroll-behavior: contain; }
#sf-edit-lib .item { display: flex; flex-direction: column; align-items: center;
  gap: 6px; padding: 8px 4px; text-align: center; text-transform: none;
  letter-spacing: .03em; line-height: 1.35; font-size: 11px; }
#sf-edit-lib .item img, #sf-edit-lib .item .sw { width: 68px; height: 68px;
  border-radius: 8px; background: rgba(6,14,26,.9); object-fit: cover;
  display: flex; align-items: center; justify-content: center;
  font-size: 19px; letter-spacing: .04em; color: rgba(170,205,235,.75);
  pointer-events: none; }
#sf-edit-lib .row { display: flex; gap: 6px; justify-content: space-between;
  margin-top: 10px; }
#sf-edit-lib .hint { font-size: 10px; letter-spacing: .02em; line-height: 1.55;
  text-transform: none; font-weight: 500; color: rgba(196,222,244,.8);
  margin-bottom: 10px; }
#sf-edit-lib textarea { display: block; width: 100%; box-sizing: border-box;
  resize: vertical; background: rgba(4,12,24,.8); color: #cfe4f6;
  border: 1px solid rgba(206,232,255,.18); border-radius: 8px; padding: 8px;
  font: 500 13px/1.45 ui-sans-serif, system-ui, sans-serif; }
`;

export function createTownEditor(opts = {}) {
  const { ctx, camera, town } = opts;

  // --- state ----------------------------------------------------------------

  // Two layouts, always. `applied` is what the town is actually built from --
  // it only ever changes when rebuild() succeeds. `working` is the copy the
  // pointer scribbles on during a drag. Keeping them separate means a failed
  // rebuild, or a drag abandoned by a second finger landing, can always fall
  // back to a layout that is known-good because the town is literally made
  // of it.
  let applied = deepCopy(town.layout());
  let working = deepCopy(applied);
  let selected = -1;            // index into working.items, or -1
  const undoStack = [];

  let active = false;
  let easeT = 1;
  let savedTouchAction = '';

  // Orbit pose. Spherical about a point on the deck plane; the initial pose
  // looks down the street the way the shore camera first shows it.
  const target = new THREE.Vector3();
  let yaw = 0, pitch = 0.75, dist = 30;

  // Entry glide endpoints.
  const entryPos = new THREE.Vector3();
  const entryLook = new THREE.Vector3();
  const orbitP = new THREE.Vector3();
  const lookP = new THREE.Vector3();
  const dirTmp = new THREE.Vector3();

  // Which kinds can rotate. KIND_LIST carries the flag for everything the
  // palette can add; the tavern is not addable (there is exactly one) but it
  // is selectable and it does rotate, so it is folded in by hand.
  const yawKinds = new Set(town.KIND_LIST.filter((e) => e.yaw).map((e) => e.k));
  yawKinds.add('tavern');
  yawKinds.add('asset');
  const labels = new Map(town.KIND_LIST.map((e) => [e.k, e.label]));
  const itemLabel = (item) => {
    if (item.k === 'asset') return LIBRARY[item.a]?.label || 'Asset';
    return labels.get(item.k) || (item.k.charAt(0).toUpperCase() + item.k.slice(1));
  };

  // --- the selection ring ---------------------------------------------------
  //
  // Built once, hidden by alpha and never by visibility, so its pipeline is
  // compiled by the boot warm-up instead of on the first tap -- the same
  // argument fireflies.js makes at length. frustumCulled is off for the same
  // reason: 96 triangles drawn invisibly forever is cheaper than one
  // synchronous pipeline build the frame a player first selects a shop.

  const group = new THREE.Group();
  group.name = 'townEditor';

  const uAlpha = uniform(0);
  const uTime = uniform(0);

  const ringGeo = new THREE.RingGeometry(0.82, 1.0, 48);
  const ringMat = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false,
  });
  ringMat.name = 'townEditorRing';
  ringMat.colorNode = vec3(1.0, 0.82, 0.48);
  // A gentle breath rather than a blink: the ring is a cursor, and a cursor
  // that flashes is a cursor shouting.
  ringMat.opacityNode = uAlpha.mul(sin(uTime.mul(3.1)).mul(0.25).add(0.75));

  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.name = 'townEditorRing';
  ring.rotation.x = -Math.PI / 2;
  ring.renderOrder = 12;
  ring.frustumCulled = false;
  ring.castShadow = false;
  ring.receiveShadow = false;
  group.add(ring);

  setLayers(group, LAYER.MAIN);
  applyWaterClip(group);

  function refreshRing() {
    const item = selected >= 0 ? working.items[selected] : null;
    if (!item) return;
    ring.position.set(
      town.worldX(item.x, item.z),
      town.deckY + 0.04,
      town.worldZ(item.x, item.z),
    );
    ring.scale.setScalar(town.footprint(item) + 0.25);
  }

  // --- DOM ------------------------------------------------------------------

  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.id = 'sf-edit';
  root.dataset.sfUi = '';

  root.innerHTML = `
    <div class="bar top"><button id="sf-edit-addbtn">Add to town</button></div>
    <div class="dock">
      <div class="status"></div>
      <div class="bar bottom">
        <button id="sf-edit-rotl" title="Rotate left (R rotates right)">-15</button>
        <button id="sf-edit-rotr" title="Rotate right (R)">+15</button>
        <button id="sf-edit-dup" title="Duplicate">Dup</button>
        <button id="sf-edit-del" title="Delete (Del)">Del</button>
        <span class="sep"></span>
        <button id="sf-edit-undo" title="Undo last change">Undo</button>
        <button id="sf-edit-reset" title="Back to the shipped town">Reset</button>
        <button id="sf-edit-export" title="View, copy or paste the layout JSON">Export</button>
        <button id="sf-edit-done" title="Leave the editor (Esc)">Done</button>
      </div>
    </div>`;
  document.body.appendChild(root);

  const statusEl = root.querySelector('.status');
  const btnRotL = root.querySelector('#sf-edit-rotl');
  const btnRotR = root.querySelector('#sf-edit-rotr');
  const btnDup = root.querySelector('#sf-edit-dup');
  const btnDel = root.querySelector('#sf-edit-del');
  const btnUndo = root.querySelector('#sf-edit-undo');
  const btnReset = root.querySelector('#sf-edit-reset');
  const btnExport = root.querySelector('#sf-edit-export');
  const btnDone = root.querySelector('#sf-edit-done');

  const io = document.createElement('div');
  io.id = 'sf-edit-io';
  io.dataset.sfUi = '';
  io.innerHTML = `
    <div class="card">
      <div class="title">Town layout</div>
      <textarea id="sf-edit-json" rows="12" spellcheck="false"></textarea>
      <div class="row">
        <button id="sf-edit-copy">Copy</button>
        <button id="sf-edit-apply">Apply</button>
        <button id="sf-edit-close">Close</button>
      </div>
    </div>`;
  document.body.appendChild(io);

  const ta = io.querySelector('#sf-edit-json');
  const btnCopy = io.querySelector('#sf-edit-copy');
  const btnApply = io.querySelector('#sf-edit-apply');
  const btnClose = io.querySelector('#sf-edit-close');

  // --- the library ----------------------------------------------------------
  //
  // One overlay, two faces. The BROWSE face is a searchable grid: the
  // procedural kinds first (a lettered swatch each), then every generated
  // prop from assetLibrary.js with its rendered thumbnail. The COMMISSION
  // face is the honest version of "type text, get a model": the page itself
  // cannot reach the generator -- it is a sealed offline artifact, and the
  // API key must never ship inside it -- so the wish is written here, copied,
  // and pasted to Claude in the chat, where the real pipeline runs and ships
  // the asset back in the next update of this page.

  const lib = document.createElement('div');
  lib.id = 'sf-edit-lib';
  lib.dataset.sfUi = '';
  const kindCards = town.KIND_LIST.map((e) =>
    `<button class="item" data-addk="${e.k}" data-search="${e.label.toLowerCase()} ${e.k}">
      <span class="sw">${e.label.slice(0, 2)}</span><span>${e.label}</span></button>`).join('');
  const assetCards = Object.entries(LIBRARY).map(([name, def]) => {
    const face = THUMBS[name]
      ? `<img src="${THUMBS[name]}" alt="">`
      : `<span class="sw">${def.label.slice(0, 2)}</span>`;
    const search = (def.label + ' ' + def.tags + ' ' + name).toLowerCase();
    return `<button class="item" data-adda="${name}" data-search="${search}">${face}<span>${def.label}</span></button>`;
  }).join('');
  lib.innerHTML = `
    <div class="card" data-face="browse">
      <div class="title">Add to the town</div>
      <input id="sf-edit-search" type="search" placeholder="Search props..." autocomplete="off">
      <div class="grid" id="sf-edit-grid">${kindCards}${assetCards}</div>
      <div class="row">
        <button id="sf-edit-new">Describe a new asset</button>
        <button id="sf-edit-libclose">Close</button>
      </div>
    </div>
    <div class="card" data-face="wish" style="display:none">
      <div class="title">Commission an asset</div>
      <div class="hint">Describe the prop you want and copy the request below,
        then paste it to Claude in the chat that builds this game. A reference
        image pasted straight into that chat works too. The generated asset
        arrives in the library with the next update of this page.</div>
      <textarea id="sf-edit-wishtext" rows="3"
        placeholder="e.g. a weathered wooden mermaid figurehead"></textarea>
      <div class="row">
        <button id="sf-edit-wishcopy">Copy request</button>
        <button id="sf-edit-wishback">Back</button>
      </div>
    </div>`;
  document.body.appendChild(lib);

  const libBrowse = lib.querySelector('[data-face="browse"]');
  const libWish = lib.querySelector('[data-face="wish"]');
  const searchEl = lib.querySelector('#sf-edit-search');
  const gridEl = lib.querySelector('#sf-edit-grid');
  const wishText = lib.querySelector('#sf-edit-wishtext');
  const btnWishCopy = lib.querySelector('#sf-edit-wishcopy');

  // A button that answers with its own label for a moment -- Copied, Invalid --
  // then goes back to being itself. One timer per button so a double-tap
  // cannot strand the temporary text.
  const flashTimers = new Map();
  function flash(btn, text) {
    if (!flashTimers.has(btn)) btn.dataset.label = btn.textContent;
    else clearTimeout(flashTimers.get(btn));
    btn.textContent = text;
    flashTimers.set(btn, setTimeout(() => {
      btn.textContent = btn.dataset.label;
      flashTimers.delete(btn);
    }, 1200));
  }

  function updateUi() {
    const item = selected >= 0 ? working.items[selected] : null;
    const canRotate = !!(item && yawKinds.has(item.k));
    btnRotL.disabled = !canRotate;
    btnRotR.disabled = !canRotate;
    // No duplicating the tavern: sanitize keeps at most one, so the copy
    // would be silently dropped, the ring would jump to whatever item is
    // last, and an undo slot would be burned on nothing.
    btnDup.disabled = !item || item.k === 'tavern';
    btnDel.disabled = !item;
    statusEl.textContent = item
      ? itemLabel(item) + ' selected'
      : 'Tap a building to select it - drag to move';
  }

  function select(i) {
    selected = i;
    refreshRing();
    updateUi();
  }

  // --- the commit pipeline --------------------------------------------------
  //
  // Every path that changes the town funnels through here: drag release, add,
  // rotate, duplicate, delete, reset, Apply. Snapshot what the town IS, ask it
  // to become what `working` says, and either adopt the sanitized result or
  // put everything back. rebuild() returning null means the input was beyond
  // sanitizing (Apply with garbage, mostly); in that case the snapshot comes
  // back off the stack too, because an undo step that undoes nothing is a
  // button press that appears to do nothing.

  function save() {
    try {
      localStorage.setItem(TOWN_LAYOUT_KEY, JSON.stringify(applied));
    } catch { /* storage may be sandboxed; the edit still lives until reload */ }
  }

  function afterApply() {
    // rebuild() may have dropped items it could not save, so the selection
    // index has to be re-checked against the survivors.
    if (selected >= working.items.length) selected = working.items.length - 1;
    refreshRing();
    updateUi();
    if (io.classList.contains('on')) ta.value = JSON.stringify(applied, null, 1);
  }

  function commit() {
    undoStack.push(deepCopy(applied));
    if (undoStack.length > UNDO_CAP) undoStack.shift();
    const result = town.rebuild(working);
    if (!result) {
      undoStack.pop();
      working = deepCopy(applied);
      afterApply();
      return false;
    }
    applied = result;
    working = deepCopy(applied);
    save();
    afterApply();
    return true;
  }

  function undo() {
    if (!undoStack.length) return;
    const snap = undoStack.pop();
    const result = town.rebuild(snap);
    if (!result) return;      // a snapshot was once applied; this should not happen
    applied = result;
    working = deepCopy(applied);
    save();
    if (selected >= working.items.length) selected = -1;
    afterApply();
  }

  // --- edit operations ------------------------------------------------------

  function addItem(k) {
    const def = town.KIND_LIST.find((e) => e.k === k);
    if (!def) return;
    // New things land at the camera target -- the point the player is orbiting
    // around IS the point they are looking at, so that is where a new crate
    // belongs. Clamped into the editable region in case the view has wandered.
    const lx = clamp(town.localX(target.x, target.z), -EDIT_X, EDIT_X);
    const lz = clamp(town.localZ(target.x, target.z), -EDIT_Z, EDIT_Z);
    const item = { k, x: lx, z: lz };
    if (def.yaw) item.yaw = 0;
    // A fresh seed for EVERY added item, taken at tap time — the seed is what
    // varies a barrel's height and a planter's foliage, so seedless additions
    // all sanitized to seed 1 and came out identical clones.
    item.seed = (Math.random() * 1e9) | 0;
    if (k === 'shop') { item.w = 6.4; item.d = 5.0; item.h = 3.4; }
    working.items.push(item);
    selected = working.items.length - 1;
    commit();
  }

  // A generated prop from the library: same landing spot, but the item names
  // its assetLibrary entry and the town does the cloning.
  function addAsset(name) {
    if (!Object.prototype.hasOwnProperty.call(LIBRARY, name)) return;
    const lx = clamp(town.localX(target.x, target.z), -EDIT_X, EDIT_X);
    const lz = clamp(town.localZ(target.x, target.z), -EDIT_Z, EDIT_Z);
    working.items.push({ k: 'asset', a: name, x: lx, z: lz, yaw: 0, seed: (Math.random() * 1e9) | 0 });
    selected = working.items.length - 1;
    commit();
  }

  function rotate(sign) {
    const item = selected >= 0 ? working.items[selected] : null;
    if (!item || !yawKinds.has(item.k)) return;
    item.yaw = (item.yaw || 0) + sign * ROT_STEP;
    commit();
  }

  function duplicate() {
    const item = selected >= 0 ? working.items[selected] : null;
    if (!item || item.k === 'tavern') return;
    const copy = deepCopy(item);
    copy.x = clamp(copy.x + 1.5, -EDIT_X, EDIT_X);
    if (copy.k === 'shop') copy.seed = (Math.random() * 1e9) | 0;
    working.items.push(copy);
    selected = working.items.length - 1;
    commit();
  }

  function removeSelected() {
    if (selected < 0 || !working.items[selected]) return;
    working.items.splice(selected, 1);
    selected = -1;
    commit();
  }

  // Reset is the one destructive act with no undo pressure valve people
  // expect (it IS undoable, but nobody believes that in the moment), so it
  // asks twice. The armed state disarms itself so a stale "Really?" cannot
  // sit there waiting to ambush a tap five minutes later.
  let resetArmed = false;
  let resetTimer = 0;
  function disarmReset() {
    resetArmed = false;
    clearTimeout(resetTimer);
    btnReset.textContent = 'Reset';
  }
  function onReset() {
    if (!resetArmed) {
      resetArmed = true;
      btnReset.textContent = 'Really?';
      resetTimer = setTimeout(disarmReset, RESET_ARM_MS);
      return;
    }
    disarmReset();
    working = deepCopy(town.defaultLayout());
    selected = -1;
    commit();
  }

  // --- the IO overlay -------------------------------------------------------

  function openIo() {
    ta.value = JSON.stringify(applied, null, 1);
    io.classList.add('on');
  }
  function closeIo() { io.classList.remove('on'); }

  // Copy `text` and flash `btn`; on clipboard-API refusal fall back to
  // selecting `el` (whose raw content is close enough to the wrapped text).
  function copyText(text, el, btn) {
    const legacy = () => {
      try {
        el.select();
        document.execCommand('copy');
        flash(btn, 'Copied');
      } catch { /* nothing left to fall back to */ }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => flash(btn, 'Copied'), legacy);
    } else legacy();
  }
  function doCopy() { copyText(ta.value, ta, btnCopy); }

  function doApply() {
    let parsed;
    try {
      parsed = JSON.parse(ta.value);
    } catch {
      flash(btnApply, 'Invalid');
      return;
    }
    working = parsed;
    selected = -1;
    // Same pipeline as everything else, so a pasted layout is undoable and
    // saved exactly like a dragged one. rebuild() is the judge of validity.
    if (!commit()) flash(btnApply, 'Invalid');
  }

  function openLib() {
    libBrowse.style.display = '';
    libWish.style.display = 'none';
    searchEl.value = '';
    filterGrid('');
    lib.classList.add('on');
  }
  function closeLib() { lib.classList.remove('on'); }

  function filterGrid(q) {
    const needle = q.trim().toLowerCase();
    for (const card of gridEl.children) {
      card.style.display = !needle || card.dataset.search.includes(needle) ? '' : 'none';
    }
  }

  root.querySelector('#sf-edit-addbtn').addEventListener('click', openLib);
  lib.querySelector('#sf-edit-libclose').addEventListener('click', closeLib);
  searchEl.addEventListener('input', () => filterGrid(searchEl.value));
  gridEl.addEventListener('click', (e) => {
    const card = e.target?.closest?.('[data-addk],[data-adda]');
    if (!card) return;
    closeLib();
    if (card.dataset.addk) addItem(card.dataset.addk);
    else addAsset(card.dataset.adda);
  });
  lib.querySelector('#sf-edit-new').addEventListener('click', () => {
    libBrowse.style.display = 'none';
    libWish.style.display = '';
    wishText.focus();
  });
  lib.querySelector('#sf-edit-wishback').addEventListener('click', () => {
    libWish.style.display = 'none';
    libBrowse.style.display = '';
  });
  btnWishCopy.addEventListener('click', () => {
    const desc = wishText.value.trim();
    if (!desc) { flash(btnWishCopy, 'Describe it'); return; }
    copyText('Salty Fin asset request: ' + desc, wishText, btnWishCopy);
  });
  btnRotL.addEventListener('click', () => rotate(-1));
  btnRotR.addEventListener('click', () => rotate(1));
  btnDup.addEventListener('click', duplicate);
  btnDel.addEventListener('click', removeSelected);
  btnUndo.addEventListener('click', undo);
  btnReset.addEventListener('click', onReset);
  btnExport.addEventListener('click', openIo);
  btnDone.addEventListener('click', () => exit());
  btnCopy.addEventListener('click', doCopy);
  btnApply.addEventListener('click', doApply);
  btnClose.addEventListener('click', closeIo);

  // --- picking and the pointer ---------------------------------------------
  //
  // All listeners live on window and only exist while the editor is active.
  // Anything that starts on UI is ignored -- `[data-sf-ui]` covers this
  // module's own bars and overlay AND the fps badge, which stays on screen in
  // the editor and must not start an orbit when tapped.

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  // plane: normal . p + constant = 0, so y = deckY needs constant = -deckY.
  const deckPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -town.deckY);
  const hitP = new THREE.Vector3();

  const onUi = (e) => {
    const t = e.target;
    return !!(t && typeof t.closest === 'function' && t.closest('[data-sf-ui]'));
  };

  /** Screen point -> town-local coordinates on the deck plane, or null. */
  function planeLocal(cx, cy) {
    ndc.set((cx / window.innerWidth) * 2 - 1, -(cy / window.innerHeight) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    if (!raycaster.ray.intersectPlane(deckPlane, hitP)) return null;
    return { x: town.localX(hitP.x, hitP.z), z: town.localZ(hitP.x, hitP.z) };
  }

  /** Nearest item under a local point, generously: footprint plus slop. */
  function pickItem(p) {
    let best = -1, bestD = Infinity;
    for (let i = 0; i < working.items.length; i++) {
      const it = working.items[i];
      const d = Math.hypot(it.x - p.x, it.z - p.z);
      if (d < town.footprint(it) + PICK_SLOP && d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  function clampTarget() {
    const lx = clamp(town.localX(target.x, target.z), -TARGET_X, TARGET_X);
    const lz = clamp(town.localZ(target.x, target.z), -TARGET_Z, TARGET_Z);
    target.set(town.worldX(lx, lz), town.deckY, town.worldZ(lx, lz));
  }

  // Pan by projecting both screen points onto the deck plane and shifting the
  // target by the world-space difference, so the ground tracks the finger
  // exactly at any pitch -- a screen-space gain would pan too little looking
  // down and too much looking flat.
  function panScreen(x0, y0, x1, y1) {
    const a = planeLocal(x0, y0);
    const b = planeLocal(x1, y1);
    if (!a || !b) return;
    target.x += town.worldX(a.x, a.z) - town.worldX(b.x, b.z);
    target.z += town.worldZ(a.x, a.z) - town.worldZ(b.x, b.z);
    clampTarget();
  }

  const pointers = new Map();   // pointerId -> { x, y }
  let mode = 'idle';            // idle | orbit | pan | drag | pinch
  let dragId = -1;
  let dragOffX = 0, dragOffZ = 0;   // grab point relative to the item's centre

  const spread = () => {
    const [a, b] = [...pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  const centroid = () => {
    let x = 0, y = 0;
    for (const p of pointers.values()) { x += p.x; y += p.y; }
    return { x: x / pointers.size, y: y / pointers.size };
  };
  let pinchDist = 0;

  // A second finger landing mid-drag abandons the move rather than committing
  // half of it: put the working item back where the applied layout has it.
  // The selection survives -- the player grabbed the thing on purpose.
  function cancelDrag() {
    const src = applied.items[selected];
    const dst = working.items[selected];
    if (src && dst) { dst.x = src.x; dst.z = src.z; }
    refreshRing();
  }

  const onPointerDown = (e) => {
    if (!active || onUi(e)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      if (mode === 'drag') cancelDrag();
      mode = 'pinch';
      pinchDist = spread();
      return;
    }
    if (pointers.size > 2) return;
    if (e.button === 1 || e.button === 2) { mode = 'pan'; return; }
    const p = planeLocal(e.clientX, e.clientY);
    const hit = p ? pickItem(p) : -1;
    if (hit >= 0) {
      select(hit);
      mode = 'drag';
      dragId = e.pointerId;
      // Hold the grab offset so the item does not jump to centre itself under
      // the finger on the first move.
      dragOffX = working.items[hit].x - p.x;
      dragOffZ = working.items[hit].z - p.z;
    } else {
      mode = 'orbit';
    }
  };

  const onPointerMove = (e) => {
    if (!active) return;
    const rec = pointers.get(e.pointerId);
    if (!rec) return;

    if (mode === 'pinch' && pointers.size >= 2) {
      // Old centroid and spread from the map, new ones after this pointer's
      // record is refreshed; ratio zooms, centroid delta pans.
      const c0 = centroid();
      const d0 = spread();
      rec.x = e.clientX; rec.y = e.clientY;
      const c1 = centroid();
      const d1 = spread();
      if (d0 > 1e-3 && d1 > 1e-3) dist = clamp(dist / (d1 / d0), DIST_MIN, DIST_MAX);
      pinchDist = d1;
      panScreen(c0.x, c0.y, c1.x, c1.y);
      return;
    }

    const px = rec.x, py = rec.y;
    rec.x = e.clientX; rec.y = e.clientY;
    const dx = e.clientX - px, dy = e.clientY - py;

    if (mode === 'orbit') {
      yaw += dx * ORBIT_GAIN;
      pitch = clamp(pitch + dy * PITCH_GAIN, PITCH_MIN, PITCH_MAX);
    } else if (mode === 'pan') {
      panScreen(px, py, e.clientX, e.clientY);
    } else if (mode === 'drag' && e.pointerId === dragId) {
      const p = planeLocal(e.clientX, e.clientY);
      const item = selected >= 0 ? working.items[selected] : null;
      if (p && item) {
        item.x = clamp(p.x + dragOffX, -EDIT_X, EDIT_X);
        item.z = clamp(p.z + dragOffZ, -EDIT_Z, EDIT_Z);
        // The ring is the live feedback; the building itself only moves on
        // the commit below. See the header for why.
        refreshRing();
      }
    }
  };

  const onPointerUp = (e) => {
    if (!pointers.delete(e.pointerId)) return;
    if (mode === 'drag' && e.pointerId === dragId) {
      dragId = -1;
      mode = 'idle';
      // A tap that never moved the item is a SELECTION, not an edit: without
      // this check every tap paid the ~100 ms rebuild and pushed a no-op onto
      // the undo stack, so five selections made Undo appear dead five times.
      const a = applied.items[selected];
      const w = working.items[selected];
      if (a && w && Math.abs(a.x - w.x) < 1e-4 && Math.abs(a.z - w.z) < 1e-4) return;
      commit();
      return;
    }
    if (mode === 'pinch') {
      // Two or more fingers still down keep pinching (lifting one of THREE
      // was stranding mode at idle with two live pointers); one finger left
      // keeps working as an orbit -- lifting one of two fingers and dragging
      // on is a gesture people make without thinking.
      if (pointers.size >= 2) { pinchDist = spread(); return; }
      pinchDist = 0;
      mode = pointers.size === 1 ? 'orbit' : 'idle';
      return;
    }
    if (pointers.size === 0) mode = 'idle';
  };

  const onWheel = (e) => {
    if (!active || onUi(e)) return;
    e.preventDefault();
    dist = clamp(dist * Math.pow(0.92, -e.deltaY / 53), DIST_MIN, DIST_MAX);
  };

  // Right-drag is pan, so the browser menu has to go -- except over the IO
  // overlay, where right-click on the textarea is how paste happens on a
  // machine without a keyboard shortcut in muscle memory.
  const onContextMenu = (e) => {
    if (active && !onUi(e)) e.preventDefault();
  };

  const onKeyDown = (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    if (e.code === 'Escape') {
      // Layers of "get me out": whichever overlay is open first, then the
      // editor itself.
      if (lib.classList.contains('on')) closeLib();
      else if (io.classList.contains('on')) closeIo();
      else exit();
    } else if (e.code === 'Delete' || e.code === 'Backspace') {
      e.preventDefault();
      removeSelected();
    } else if (e.code === 'KeyR') {
      rotate(1);
    }
  };

  // A pointerup can simply never arrive -- release outside the window, an OS
  // gesture stealing the touch, alt-tab mid-drag. Losing focus resets the
  // whole pointer machine; an in-flight drag is abandoned, not committed.
  const onWindowBlur = () => {
    if (mode === 'drag') cancelDrag();
    pointers.clear();
    dragId = -1;
    mode = 'idle';
  };

  function addListeners() {
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    window.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('contextmenu', onContextMenu);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('blur', onWindowBlur);
  }
  function removeListeners() {
    window.removeEventListener('pointerdown', onPointerDown);
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerUp);
    window.removeEventListener('wheel', onWheel);
    window.removeEventListener('contextmenu', onContextMenu);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('blur', onWindowBlur);
  }

  // --- enter / exit ---------------------------------------------------------

  function enter() {
    if (active) return;
    active = true;
    // The boat and shore controllers read this and stand down; the lead wires
    // that side. The chase camera is gated on `.active` in main.
    if (ctx) ctx.editorHold = true;

    document.getElementById('touch')?.classList.add('hidden');
    document.getElementById('hud')?.classList.add('hidden');
    // The fishing call-to-action and the shore prompt pill live outside #hud
    // (they survive hideHud for captures) and would float over the editor
    // otherwise. dock()/board() are also hard-gated on editorHold — hiding
    // the pill is cosmetics, the gate is the safety.
    const fishGo = document.getElementById('sf-fish-go');
    if (fishGo) fishGo.style.display = 'none';
    const shorePill = document.getElementById('sf-shore');
    if (shorePill) shorePill.style.display = 'none';

    // The canvas normally allows the browser's own pan/zoom outside the touch
    // zones; while editing, every gesture belongs to the editor.
    const gl = document.getElementById('gl');
    if (gl) {
      savedTouchAction = gl.style.touchAction;
      gl.style.touchAction = 'none';
    }

    // Re-read the town rather than trusting the copies from construction --
    // someone may have driven town.rebuild() from the console since.
    applied = deepCopy(town.layout());
    working = deepCopy(applied);
    selected = -1;
    updateUi();

    // The glide: remember where the camera is and roughly what it is looking
    // at, then ease both toward the orbit pose. A hard cut from the chase
    // camera to a high oblique is disorienting in exactly the way a 0.7 s
    // swing is not.
    entryPos.copy(camera.position);
    camera.getWorldDirection(dirTmp);
    entryLook.copy(entryPos).addScaledVector(dirTmp, 30);
    easeT = 0;

    target.set(town.worldX(0, 4), town.deckY, town.worldZ(0, 4));
    yaw = town.yaw + Math.PI;
    pitch = 0.75;
    dist = 30;

    pointers.clear();
    mode = 'idle';
    root.classList.add('on');
    addListeners();
  }

  function exit() {
    if (!active) return;
    active = false;
    if (ctx) ctx.editorHold = false;

    document.getElementById('touch')?.classList.remove('hidden');
    document.getElementById('hud')?.classList.remove('hidden');
    const fishGo = document.getElementById('sf-fish-go');
    if (fishGo) fishGo.style.display = '';
    const shorePill = document.getElementById('sf-shore');
    if (shorePill) shorePill.style.display = '';

    const gl = document.getElementById('gl');
    if (gl) gl.style.touchAction = savedTouchAction;

    select(-1);
    disarmReset();
    closeIo();
    closeLib();
    root.classList.remove('on');
    pointers.clear();
    mode = 'idle';
    removeListeners();
  }

  function toggle() { (active ? exit : enter)(); }

  // --- per frame ------------------------------------------------------------

  function update(uctx) {
    uTime.value = uctx.time;

    // The ring hides by alpha, with a short fade so selection changes do not
    // pop. Zero alpha is the hidden state; `visible` is never touched.
    const goal = active && selected >= 0 ? 1 : 0;
    uAlpha.value += (goal - uAlpha.value) * Math.min(1, (uctx.dt || 0) * 12);
    if (Math.abs(goal - uAlpha.value) < 1e-3) uAlpha.value = goal;

    if (!active) return;

    // This runs after every other camera writer, so a full write of position
    // and orientation wins the frame outright -- no lerp fights, no residue
    // from whoever owned the camera before.
    easeT = Math.min(1, easeT + uctx.dt / EASE_TIME);
    const cp = Math.cos(pitch);
    orbitP.set(
      target.x + Math.sin(yaw) * cp * dist,
      target.y + Math.sin(pitch) * dist,
      target.z + Math.cos(yaw) * cp * dist,
    );
    camera.up.set(0, 1, 0);
    if (easeT < 1) {
      const s = smooth(easeT);
      camera.position.lerpVectors(entryPos, orbitP, s);
      lookP.lerpVectors(entryLook, target, s);
      camera.lookAt(lookP);
    } else {
      camera.position.copy(orbitP);
      camera.lookAt(target);
    }
  }

  // --- teardown -------------------------------------------------------------

  function dispose() {
    exit();                       // restores the HUD, listeners, editorHold
    for (const t of flashTimers.values()) clearTimeout(t);
    flashTimers.clear();
    root.remove();
    io.remove();
    lib.remove();
    style.remove();
    ringGeo.dispose();
    ringMat.dispose();
  }

  return {
    group,
    get active() { return active; },
    enter,
    exit,
    toggle,
    update,
    dispose,
  };
}
