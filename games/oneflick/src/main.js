import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import * as G from './game.js';

const $ = id => document.getElementById(id);
const CY = 0x36e0d0, HOT = 0xff4d6d, WARM = 0xffc857;

/* ================= state ================= */
const inc = G.parseFragment(location.hash);
const SEED = inc.seed === null ? Math.floor(Math.random() * 1679616) : inc.seed;
const COURSE = G.courseFor(SEED);
const TARGET = inc.target;              // null => you are the one setting it
const CHAIN = inc.chain;
const TAMPERED = inc.tampered;
const SETTING = !TARGET;

let shot = null, flying = false, done = false, myResult = null;

/* ================= three ================= */
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05070b);
scene.fog = new THREE.Fog(0x05070b, 45, 110);

const camera = new THREE.PerspectiveCamera(46, 1, 0.1, 300);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
$('stage').appendChild(renderer.domElement);

let composer = null;
try {
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(1, 1), 0.85, 0.65, 0.22));
} catch (e) { composer = null; }

scene.add(new THREE.AmbientLight(0x4a5a7a, 1.15));
const key = new THREE.DirectionalLight(0xbfd4ff, 1.5);
key.position.set(6, 22, 10); scene.add(key);

/* floor + grid, clipped to the arena */
const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(G.ARENA.w, G.ARENA.d),
  new THREE.MeshStandardMaterial({ color: 0x0a0f18, roughness: 0.85, metalness: 0.1 })
);
floor.rotation.x = -Math.PI / 2; scene.add(floor);

const grid = new THREE.GridHelper(G.ARENA.d, 18, CY, 0x11303f);
grid.material.transparent = true; grid.material.opacity = 0.15; grid.position.y = 0.012;
scene.add(grid);
// the GridHelper is square, so mask everything outside the arena rectangle.
// Derived from ARENA so it cannot drift out of sync with the play area again.
{
  const gh = G.ARENA.d, M = 60;
  for (const [w, d, x, z] of [
    [M, M, 0, -(G.ARENA.d / 2 + M / 2)], [M, M, 0, G.ARENA.d / 2 + M / 2],
    [M, gh + 2 * M, -(G.ARENA.w / 2 + M / 2), 0], [M, gh + 2 * M, G.ARENA.w / 2 + M / 2, 0]
  ]) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshBasicMaterial({ color: 0x05070b }));
    m.rotation.x = -Math.PI / 2; m.position.set(x, 0.02, z); scene.add(m);
  }
}

/* walls */
const wallMat = new THREE.MeshStandardMaterial({
  color: 0x0d1622, roughness: 0.6, metalness: 0.3,
  emissive: new THREE.Color(CY), emissiveIntensity: 0.16
});
const HW = G.ARENA.w / 2, HD = G.ARENA.d / 2, WH = 1.1;
for (const [w, d, x, z] of [
  [G.ARENA.w + 0.6, 0.6, 0, -HD], [G.ARENA.w + 0.6, 0.6, 0, HD],
  [0.6, G.ARENA.d, -HW, 0], [0.6, G.ARENA.d, HW, 0]
]) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, WH, d), wallMat);
  m.position.set(x, WH / 2, z); scene.add(m);
}

/* pillars */
for (const p of COURSE.pillars) {
  const h = 1.5 + p.r * 0.7;
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(p.r, p.r, h, 28),
    new THREE.MeshStandardMaterial({ color: 0x101a26, roughness: 0.45, metalness: 0.5 })
  );
  body.position.set(p.x, h / 2, p.z); scene.add(body);
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(p.r + 0.02, 0.045, 8, 40),
    new THREE.MeshBasicMaterial({ color: CY })
  );
  ring.rotation.x = Math.PI / 2; ring.position.set(p.x, h, p.z); scene.add(ring);
}

/* ball */
const ball = new THREE.Mesh(
  new THREE.SphereGeometry(G.BALL_R, 32, 24),
  new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.9, roughness: 0.25 })
);
ball.position.set(G.START.x, G.BALL_R, G.START.z); scene.add(ball);
const ballGlow = new THREE.PointLight(0xffffff, 14, 16);
ballGlow.position.copy(ball.position); scene.add(ballGlow);

/* live trail */
const TRAIL_MAX = 3000;
const trailGeo = new THREE.BufferGeometry();
trailGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRAIL_MAX * 3), 3));
trailGeo.setDrawRange(0, 0);
scene.add(new THREE.Line(trailGeo, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 })));

/* target beam */
let beam = null;
function makeTarget(x, z) {
  const g = new THREE.Group();
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.92, 0.07, 10, 48), new THREE.MeshBasicMaterial({ color: HOT }));
  ring.rotation.x = Math.PI / 2; ring.position.y = 0.05; g.add(ring);
  const inner = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.045, 8, 32), new THREE.MeshBasicMaterial({ color: HOT }));
  inner.rotation.x = Math.PI / 2; inner.position.y = 0.05; g.add(inner);
  // short, soft column — tall enough to spot from across the arena, not so tall
  // it becomes a wall across the play area
  const col = new THREE.Mesh(
    new THREE.CylinderGeometry(0.62, 0.62, 9, 24, 1, true),
    new THREE.MeshBasicMaterial({
      color: HOT, transparent: true, opacity: 0.075, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending, depthWrite: false
    })
  );
  col.position.y = 4.5; g.add(col);
  g.position.set(x, 0, z); scene.add(g);
  return g;
}
if (TARGET) beam = makeTarget(TARGET.x, TARGET.z);

/* Everyone who already tried: dim path + resting marker.
   CHAIN[0] is skipped on purpose — the setter's ball IS the target, so drawing
   their trajectory would hand every challenger the exact line to copy. You get
   to see the near-misses, never the answer. */
for (const e of CHAIN.slice(1)) {
  const r = G.simulate(COURSE, Math.sin(e.angle), -Math.cos(e.angle), G.powerToSpeed(e.power));
  const pts = r.path.map(p => new THREE.Vector3(p.x, G.BALL_R, p.z));
  pts.push(new THREE.Vector3(e.x, G.BALL_R, e.z));   // always end on the recorded rest
  scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color: WARM, transparent: true, opacity: 0.3 })));
  const dot = new THREE.Mesh(new THREE.SphereGeometry(G.BALL_R * 0.6, 16, 12),
    new THREE.MeshBasicMaterial({ color: WARM, transparent: true, opacity: 0.55 }));
  dot.position.set(e.x, G.BALL_R * 0.6, e.z); scene.add(dot);
}

/* aim */
const aimGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
const aim = new THREE.Line(aimGeo, new THREE.LineBasicMaterial({ color: CY, transparent: true, opacity: 0.95 }));
aim.visible = false; scene.add(aim);
const aimHead = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.9, 16), new THREE.MeshBasicMaterial({ color: CY }));
aimHead.visible = false; scene.add(aimHead);

/* ================= camera ================= */
function fit() {
  const el = $('stage'), w = el.clientWidth, h = el.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  if (composer) composer.setSize(w, h);
  camera.aspect = w / h;
  const vFov = camera.fov * Math.PI / 180;
  const t = Math.tan(vFov / 2);
  const need = Math.max(
    (G.ARENA.d * 0.455) / t,                   // fit the length
    (G.ARENA.w * 0.60) / t / camera.aspect     // fit the width
  );
  camera.position.set(0, need * 0.66, need * 0.62);
  camera.lookAt(0, 0, -0.5);
  camera.updateProjectionMatrix();
}
addEventListener('resize', fit);

/* ================= aiming ================= */
const ray = new THREE.Raycaster();
const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const hitPt = new THREE.Vector3();
let dragging = false;

function pointerWorld(ev) {
  const r = renderer.domElement.getBoundingClientRect();
  const nx = ((ev.clientX - r.left) / r.width) * 2 - 1;
  const ny = -((ev.clientY - r.top) / r.height) * 2 + 1;
  ray.setFromCamera({ x: nx, y: ny }, camera);
  return ray.ray.intersectPlane(plane, hitPt) ? hitPt.clone() : null;
}
function updateAim(ev) {
  const p = pointerWorld(ev);
  if (!p) return;
  let dx = p.x - G.START.x, dz = p.z - G.START.z;
  const len = Math.sqrt(dx * dx + dz * dz);
  if (len < 0.001) return;
  dx /= len; dz /= len;
  const power = Math.max(0.06, Math.min(1, len / 15));
  shot = { dx, dz, power };
  const L = 1.6 + power * 9;
  aimGeo.setFromPoints([
    new THREE.Vector3(G.START.x, 0.35, G.START.z),
    new THREE.Vector3(G.START.x + dx * L, 0.35, G.START.z + dz * L)
  ]);
  aim.visible = aimHead.visible = true;
  aimHead.position.set(G.START.x + dx * (L + 0.42), 0.35, G.START.z + dz * (L + 0.42));
  aimHead.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(dx, 0, dz).normalize());
  const c = power > 0.85 ? HOT : CY;
  aim.material.color.setHex(c); aimHead.material.color.setHex(c);
  $('power').style.width = (power * 100) + '%';
  $('powerWrap').classList.remove('hide');
}
function endAim() {
  if (!dragging) return;
  dragging = false;
  aim.visible = aimHead.visible = false;
  $('powerWrap').classList.add('hide');
  if (shot) launch();
}
const cv = renderer.domElement;
cv.addEventListener('pointerdown', e => {
  if (flying || done || $('overlay').classList.contains('show')) return;
  dragging = true;
  try { cv.setPointerCapture(e.pointerId); } catch (err) {}
  updateAim(e);
});
cv.addEventListener('pointermove', e => { if (dragging) updateAim(e); });
cv.addEventListener('pointerup', endAim);
cv.addEventListener('pointercancel', endAim);

/* ================= the flick ================= */
let anim = null;
function launch() {
  flying = true;
  $('prompt').classList.add('hide');
  const res = G.simulate(COURSE, shot.dx, shot.dz, G.powerToSpeed(shot.power));
  myResult = { angle: Math.atan2(shot.dx, -shot.dz), power: shot.power, x: res.x, z: res.z };
  // A path point is 1/80s of simulated time, so 80/s is real speed. Play a little
  // faster than life, and compress long rolls so no shot outstays its welcome.
  const rate = Math.max(105, res.path.length / 3.4);
  anim = { path: res.path, rate, start: performance.now() };
}
// Driven by elapsed wall-clock rather than accumulated frame deltas, so a slow
// or throttled device plays the shot at the same speed instead of stretching it.
function stepAnim() {
  if (!anim) return;
  const last = anim.path.length - 1;
  const f = Math.min(last, (performance.now() - anim.start) / 1000 * anim.rate);
  const i = Math.floor(f), t = f - i;
  const a = anim.path[i], b = anim.path[Math.min(i + 1, last)];
  ball.position.set(a.x + (b.x - a.x) * t, G.BALL_R, a.z + (b.z - a.z) * t);
  ballGlow.position.copy(ball.position);
  const pos = trailGeo.attributes.position.array;
  const n = Math.min(i + 1, TRAIL_MAX);
  for (let j = 0; j < n; j++) {
    pos[j * 3] = anim.path[j].x; pos[j * 3 + 1] = G.BALL_R; pos[j * 3 + 2] = anim.path[j].z;
  }
  trailGeo.setDrawRange(0, n);
  trailGeo.attributes.position.needsUpdate = true;
  if (f >= last) { anim = null; settle(); }
}
function settle() {
  flying = false; done = true;
  ball.position.set(myResult.x, G.BALL_R, myResult.z);
  ballGlow.position.copy(ball.position);
  if (SETTING) beam = makeTarget(myResult.x, myResult.z);
  setTimeout(showResult, 480);
}

/* ================= loop ================= */
let last = performance.now();
function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  stepAnim();
  if (beam) beam.rotation.y += dt * 0.7;
  composer ? composer.render() : renderer.render(scene, camera);
}
fit(); requestAnimationFrame(loop);

/* ================= ui ================= */
const getName = () => { try { return G.cleanName(localStorage.getItem('oneflick.name')); } catch (e) { return ''; } };
const setName = n => { try { localStorage.setItem('oneflick.name', n); } catch (e) {} };
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// CHAIN[0] is the setter: their ball *is* the target, so they'd sit at 0.00
// forever and nobody could ever win. They author the course; only the
// challengers after them are ranked.
const setter = () => (CHAIN[0] ? CHAIN[0].name : 'someone');
function board() {
  const rows = CHAIN.slice(1).map(e => ({ name: e.name, d: G.dist(e.x, e.z, TARGET.x, TARGET.z), me: false }));
  if (myResult && !SETTING) rows.push({ name: getName() || 'you', d: G.dist(myResult.x, myResult.z, TARGET.x, TARGET.z), me: true });
  rows.sort((a, b) => a.d - b.d);
  return rows;
}
const boardHTML = () => board().map((r, i) =>
  `<li class="${r.me ? 'me' : ''}"><span class="rk">${i + 1}</span><span class="nm">${esc(r.name)}</span><span class="ds">${r.d.toFixed(2)}</span></li>`
).join('');

function show(html, cls) {
  $('card').innerHTML = html;
  $('overlay').className = 'overlay show' + (cls ? ' ' + cls : '');
}
const hide = () => { $('overlay').className = 'overlay'; };

function intro() {
  if (SETTING) {
    show(`<h2>you set the target</h2>
      <p><b>drag</b> on the floor to aim. <b>release</b> to flick. you get <b>one</b>.</p>
      <p class="dim">wherever your ball stops becomes the <span class="hot">target</span> — then everyone
      you send this to gets one flick to land closer to it than you did.</p>
      <button class="go" id="ok">FLICK IT</button>`);
  } else {
    const lead = board()[0];
    show(`<h2>one flick. get closer.</h2>
      <p><b>${esc(setter())}</b> flicked a ball and it stopped
      <span class="hot">there</span>. that's the target.</p>
      ${lead
        ? `<p class="dim">closest so far — <b>${esc(lead.name)}</b>, <b>${lead.d.toFixed(2)}</b> away. beat it.</p>`
        : `<p class="dim">nobody has tried yet. you're first.</p>`}
      <p class="dim"><b>drag</b> to aim, <b>release</b> to flick. you get one.</p>
      <button class="go" id="ok">MY TURN</button>`);
  }
  $('ok').onclick = () => { hide(); $('prompt').classList.remove('hide'); };
}

function showResult() {
  const nm = esc(getName());
  if (SETTING) {
    show(`<h2>target set</h2>
      <p class="big hot">course #${SEED.toString(36)}</p>
      <p class="dim">now dare someone. whoever lands closest to your ball wins.</p>
      <label for="nm">your name</label><input id="nm" maxlength="12" value="${nm}" placeholder="you">
      <button class="go" id="share">COPY THE DARE</button>
      <button class="alt" id="re">NEW COURSE</button>
      <div class="tiny" id="msg"></div>`, 'wide');
  } else {
    const rows = board(), mine = rows.find(r => r.me), rank = rows.indexOf(mine) + 1;
    const crown = rank === 1 && rows.length > 1 ? 'closest so far 🏆'
                : rank === 1 ? 'first on the board'
                : '#' + rank + ' of ' + rows.length;
    show(`<h2>${mine.d.toFixed(2)} away</h2>
      <p class="big ${rank === 1 ? 'hot' : ''}">${crown}</p>
      <ol class="board">${boardHTML()}</ol>
      <label for="nm">your name</label><input id="nm" maxlength="12" value="${nm}" placeholder="you">
      <button class="go" id="share">COPY &amp; PASS IT ON</button>
      <button class="alt" id="re">NEW COURSE</button>
      <div class="tiny" id="msg"></div>`, 'wide');
  }
  const inp = $('nm');
  inp.oninput = () => { inp.value = G.cleanName(inp.value); setName(inp.value); };
  $('re').onclick = () => { location.hash = ''; location.reload(); };
  $('share').onclick = () => {
    setName(G.cleanName(inp.value));
    const t = shareText();
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(t).then(
        () => { $('msg').textContent = 'copied — paste it to a friend'; },
        () => { $('msg').textContent = t; }
      );
    } else { $('msg').textContent = t; }
  };
}

function shareText() {
  const me = { name: getName() || 'someone', angle: myResult.angle, power: myResult.power, x: myResult.x, z: myResult.z };
  const tgt = SETTING ? { x: myResult.x, z: myResult.z } : TARGET;
  const chain = SETTING ? [me] : CHAIN.concat([me]);
  const url = location.origin + location.pathname + G.buildFragment(SEED, tgt, chain);
  if (SETTING) {
    return `🎯 ONE FLICK — course #${SEED.toString(36)}\n` +
      `i flicked once. where it stopped is the target.\n` +
      `you get one flick. get closer.\n${url}`;
  }
  const rows = board().map((r, i) => `${i + 1}. ${r.name.padEnd(10)}${r.d.toFixed(2)}`).join('\n');
  return `🎯 ONE FLICK — course #${SEED.toString(36)}\n${setter()} set the target. one flick each.\n\n${rows}\n\nyour turn:\n${url}`;
}

if (TAMPERED && CHAIN.length) $('warn').classList.remove('hide');
intro();
