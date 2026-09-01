#!/usr/bin/env node
// A page for looking at the cast: every clip, playing, and every transition
// between them.
//
//   node tools/cast-page.mjs
//
// The game shows you an animation when the game decides to. This shows you all
// of them at once, at the frame rate the atlas actually declares, with the
// numbers that were measured off the sheet next to them — because most of the
// faults in this project have been things that are correct in one clip and
// wrong between two, and there was no way to look at "between two".
//
// Self-contained: the atlases go in as data URIs, so the page is one file that
// can be published or opened from disk.

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT } from './harness.mjs';

const CAST = [
  { key: 'bonny', name: 'Bonny Quinn', role: 'the player' },
  { key: 'grout', name: 'Grout', role: 'harbourmaster, the dock' },
  { key: 'pike', name: 'Mervyn Pike', role: 'the cook, the galley' },
  { key: 'cat', name: "the ship's cat", role: 'the galley' },
];

const out = [];
for (const c of CAST) {
  const sheet = join(ROOT, `assets/cast/${c.key}-sheet.png`);
  const man = join(ROOT, `assets/cast/${c.key}-sheet.json`);
  try { await stat(sheet); } catch { console.log(`  (no ${c.key} sheet — skipped)`); continue; }
  const manifest = JSON.parse(await readFile(man, 'utf8'));
  const uri = 'data:image/png;base64,' + (await readFile(sheet)).toString('base64');
  out.push({ ...c, manifest, uri, bytes: (await stat(sheet)).size });
}

const DATA = JSON.stringify(out.map(({ uri, ...rest }) => rest));
const URIS = JSON.stringify(Object.fromEntries(out.map((o) => [o.key, o.uri])));

const html = `<meta charset="utf-8">
<title>The Errant Kipper — Cast</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IM+Fell+English+SC&family=Alegreya+Sans:wght@400;500;700&display=swap">
<style>
/* Same committed night palette as the game's own page: this is a companion to
   it, and a light tool around dark sprites would misjudge every edge. */
:root {
  --pitch:#0a0907; --plank:#16120e; --brass:#c9a86a; --lamp:#f6d78a;
  --fog:#6b6152; --rule:#251d15; --ink:#8a7d68;
}
*{box-sizing:border-box}
body{margin:0;background:var(--pitch);color:var(--fog);
  font:400 15px/1.6 "Alegreya Sans","Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:1180px;margin:0 auto;padding:36px 24px 64px}
h1{margin:0 0 6px;font-family:"IM Fell English SC",Georgia,serif;font-weight:400;
  font-size:clamp(28px,4.6vw,42px);line-height:1.05;color:var(--lamp)}
.standfirst{margin:0 0 26px;max-width:64ch}
.standfirst em{color:var(--brass);font-style:normal}
.who{border-top:1px solid var(--rule);padding:22px 0 6px}
.who h2{margin:0;font-family:"IM Fell English SC",Georgia,serif;font-weight:400;
  font-size:24px;color:var(--lamp)}
.who .role{color:var(--ink);font-size:13px;letter-spacing:.04em;text-transform:uppercase}
.clips{display:flex;flex-wrap:wrap;gap:14px;margin:16px 0 4px}
.clip{background:var(--plank);border:1px solid var(--rule);padding:10px;border-radius:3px;
  cursor:pointer;transition:border-color .12s}
.clip:hover{border-color:var(--brass)}
.clip.a{border-color:var(--lamp);box-shadow:0 0 0 1px var(--lamp) inset}
.clip.b{border-color:var(--brass);box-shadow:0 0 0 1px var(--brass) inset}
.clip canvas{display:block;image-rendering:pixelated;background:
  repeating-conic-gradient(#1d1913 0 25%,#151109 0 50%) 0 0/16px 16px}
.clip .n{margin-top:7px;font-size:13px;color:var(--lamp)}
.clip .m{font-size:11.5px;color:var(--ink);font-family:ui-monospace,Menlo,monospace}
.pair{display:flex;gap:18px;align-items:flex-start;flex-wrap:wrap;
  background:var(--plank);border:1px solid var(--rule);border-radius:3px;padding:14px;margin:6px 0 10px}
.pair canvas{image-rendering:pixelated;background:
  repeating-conic-gradient(#1d1913 0 25%,#151109 0 50%) 0 0/16px 16px}
.pair .say{max-width:46ch}
button{font:inherit;color:var(--pitch);background:var(--lamp);border:0;border-radius:3px;
  padding:7px 14px;cursor:pointer}
button.ghost{background:transparent;color:var(--brass);border:1px solid var(--rule)}
kbd{font:12px ui-monospace,Menlo,monospace;color:var(--lamp);border:1px solid var(--rule);
  border-radius:3px;padding:1px 5px}
.foot{margin-top:34px;border-top:1px solid var(--rule);padding-top:16px;font-size:13.5px}
</style>
<div class="wrap">
<header>
  <h1>The Errant Kipper — Cast</h1>
  <p class="standfirst">Every animation each character has, playing at the frame rate its
  atlas declares, with what was measured off the sheet underneath it. Click two clips to see
  the <em>transition</em> between them — the game cross-dissolves over a tenth of a second, and
  the join is where most of the faults in this cast have lived.</p>
</header>
<div id="cast"></div>
<div class="foot">
  <p><strong>stride</strong> is how far one cycle of the clip carries the character across the
  ground, in sheet pixels; the engine scales it by how tall the character is drawn, so one cycle
  of animation covers one stride of ground at any size and any depth. A still clip should read
  <em>0</em> — anything else is a walk wearing an idle's name.</p>
  <p><strong>feet</strong> is where the clip puts the character's feet inside the cell. Two clips
  that disagree make the character jump sideways when they swap, which is what used to happen
  the instant anybody started talking.</p>
</div>
</div>
<script>
const CAST = ${DATA};
const URIS = ${URIS};
const imgs = {};
const sel = {};   // per character: { a, b }

function cellOf(m, f) {
  return { sx: (f % m.cols) * m.cellW, sy: ((f / m.cols) | 0) * m.cellH, w: m.cellW, h: m.cellH };
}

// Where a clip puts its feet, measured on the page rather than trusted from
// the manifest: this page exists to show what the sheet really contains.
function feetOf(img, m, clip) {
  const c = document.createElement('canvas');
  c.width = m.cellW; c.height = m.cellH;
  const g = c.getContext('2d', { willReadFrequently: true });
  const band = Math.max(3, Math.round(m.figureH * 0.04));
  let sum = 0, n = 0;
  for (let k = 0; k < clip.count; k++) {
    const q = cellOf(m, clip.start + k);
    g.clearRect(0, 0, m.cellW, m.cellH);
    g.drawImage(img, q.sx, q.sy, q.w, q.h, 0, 0, q.w, q.h);
    const d = g.getImageData(0, m.feetY - band, m.cellW, band).data;
    let lo = 1e9, hi = -1;
    for (let y = 0; y < band; y++) for (let x = 0; x < m.cellW; x++) {
      if (d[(y * m.cellW + x) * 4 + 3] < 128) continue;
      if (x < lo) lo = x; if (x > hi) hi = x;
    }
    if (hi > lo) { sum += (lo + hi) / 2; n++; }
  }
  return n ? sum / n : null;
}

function play(canvas, img, m, clip, opts = {}) {
  const g = canvas.getContext('2d');
  const scale = opts.scale || 1;
  canvas.width = Math.round(m.cellW * scale);
  canvas.height = Math.round(m.cellH * scale);
  g.imageSmoothingEnabled = false;
  const fps = clip.fps || 12;
  const per = clip.framesPerCycle || clip.count;
  let stop = false;
  (function step() {
    if (stop) return;
    const t = performance.now() / 1000;
    const i = clip.loop === false
      ? Math.min(clip.count - 1, Math.floor((t % (clip.count / fps + 0.8)) * fps))
      : Math.floor(t * fps) % per;
    const q = cellOf(m, clip.start + (i % clip.count));
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.drawImage(img, q.sx, q.sy, q.w, q.h, 0, 0, canvas.width, canvas.height);
    requestAnimationFrame(step);
  })();
  return () => { stop = true; };
}

// The transition, run the way the game runs it: the outgoing pose underneath
// at full strength and the incoming one over it, rising to full over FADE.
const FADE = 0.11;
function playPair(canvas, img, m, from, to, hold = 1.1) {
  const g = canvas.getContext('2d');
  canvas.width = m.cellW * 2; canvas.height = m.cellH * 2;
  g.imageSmoothingEnabled = false;
  const t0 = performance.now() / 1000;
  const frameAt = (clip, t) => {
    const fps = clip.fps || 12, per = clip.framesPerCycle || clip.count;
    const i = clip.loop === false ? Math.min(clip.count - 1, Math.floor(t * fps))
      : Math.floor(t * fps) % per;
    return clip.start + (i % clip.count);
  };
  (function step() {
    const t = performance.now() / 1000 - t0;
    const cycle = hold * 2 + FADE * 2;
    const u = t % cycle;
    let a = from, b = to, fade;
    if (u < hold) { fade = 0; }
    else if (u < hold + FADE) { fade = (u - hold) / FADE; }
    else if (u < hold * 2 + FADE) { fade = 1; }
    else { a = to; b = from; fade = (u - hold * 2 - FADE) / FADE; }
    g.clearRect(0, 0, canvas.width, canvas.height);
    const draw = (clip, alpha) => {
      if (alpha <= 0) return;
      g.globalAlpha = alpha;
      const q = cellOf(m, frameAt(clip, t));
      g.drawImage(img, q.sx, q.sy, q.w, q.h, 0, 0, canvas.width, canvas.height);
      g.globalAlpha = 1;
    };
    if (fade < 1) draw(a, 1);
    draw(b, fade);
    requestAnimationFrame(step);
  })();
}

const root = document.getElementById('cast');
for (const c of CAST) {
  const img = new Image();
  img.src = URIS[c.key];
  imgs[c.key] = img;
  const m = c.manifest;
  const sec = document.createElement('section');
  sec.className = 'who';
  const clips = Object.entries(m.clips);
  sec.innerHTML = \`<h2>\${c.name}</h2><div class="role">\${c.role} — \${clips.length} clips,
    \${m.cellW}x\${m.cellH} cells, figure \${m.figureH}px</div>
    <div class="clips"></div>
    <div class="pair"><canvas></canvas><div class="say">
      <p id="say-\${c.key}">Click one clip, then another, to watch the change between them.</p>
      <button class="ghost" data-clear="\${c.key}">clear</button></div></div>\`;
  root.appendChild(sec);
  const strip = sec.querySelector('.clips');
  const pairBox = sec.querySelector('.pair');
  pairBox.style.display = 'none';

  img.onload = () => {
    const feet = {};
    for (const [name, clip] of clips) feet[name] = feetOf(img, m, clip);
    const base = feet.idle;
    for (const [name, clip] of clips) {
      const card = document.createElement('div');
      card.className = 'clip';
      const dx = base != null && feet[name] != null ? (feet[name] - base) : null;
      card.innerHTML = \`<canvas></canvas><div class="n">\${name}</div>
        <div class="m">\${clip.count}f · \${clip.fps || 12}fps · cycle \${clip.framesPerCycle || clip.count}
        \${clip.loop === false ? ' · once' : ''}<br>stride \${clip.stride ?? 0}px · feet
        \${dx == null ? '?' : (dx >= 0 ? '+' : '') + dx.toFixed(1) + 'px'}</div>\`;
      strip.appendChild(card);
      play(card.querySelector('canvas'), img, m, clip, { scale: 1 });
      card.onclick = () => {
        const s = sel[c.key] || (sel[c.key] = {});
        if (!s.a) s.a = name;
        else if (s.a === name) { s.a = null; }
        else s.b = name;
        if (s.a && s.b) {
          pairBox.style.display = 'flex';
          playPair(pairBox.querySelector('canvas'), img, m, m.clips[s.a], m.clips[s.b]);
          document.getElementById('say-' + c.key).innerHTML =
            \`<strong>\${s.a} &harr; \${s.b}</strong><br>Cross-dissolved over \${FADE}s, as the game does it,
             holding each pose between. If the feet shift as it changes, the two clips disagree about
             where the character stands.\`;
          s.a = s.b; s.b = null;
        }
        for (const el of strip.children) el.className = 'clip';
        const s2 = sel[c.key];
        [...strip.children].forEach((el, i) => {
          if (clips[i][0] === s2.a) el.classList.add('a');
        });
      };
    }
  };
  sec.querySelector('[data-clear]').onclick = () => {
    sel[c.key] = {};
    pairBox.style.display = 'none';
    for (const el of strip.children) el.className = 'clip';
  };
}
</script>
`;

await mkdir(join(ROOT, 'dist'), { recursive: true });
const path = join(ROOT, 'dist/cast.html');
await writeFile(path, html);
const mb = ((await stat(path)).size / 1024 / 1024).toFixed(2);
console.log(`  ${out.length} characters, ${out.reduce((a, o) => a + Object.keys(o.manifest.clips).length, 0)} clips`);
console.log(`  cast page -> dist/cast.html  ${mb} MB`);
if (+mb > 15) console.error('  WARNING: over the artifact size ceiling');
