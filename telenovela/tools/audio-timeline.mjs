#!/usr/bin/env node
// Every sound the episode makes, in the order it makes it, with real times.
//
//   node tools/audio-timeline.mjs            # the whole episode
//   node tools/audio-timeline.mjs --scene 3
//
// Grepping the screenplay for score.play() misses cues fired from tweens,
// gestures and event callbacks, and it cannot tell you when a cue in a
// slow-motion passage actually lands. So this drives the real page instead:
// it wraps the soundtrack, steps each scene at a fixed frame rate, and records
// what got asked for and when — including the clip's own length, which is what
// decides whether one sound is still going when the next one starts.
//
// It flags:
//   SPEECH OVER SPEECH  two lines sounding at once
//   OVER A LINE         an effect loud enough to bury dialogue that is running

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const ONLY = args.indexOf('--scene') >= 0 ? +args[args.indexOf('--scene') + 1] : null;

// An effect at or above this share of a dialogue line's level will be heard
// over it rather than under it. Effects duck to SFX_DUCK while someone is
// speaking (see Soundtrack.say), so that is what an overlapping effect is
// actually worth — comparing raw levels reported problems the mix already
// solves.
const MASKS = 0.75;
const SFX_DUCK = 0.5;

async function loadPlaywright() {
  for (const c of ['playwright', '/opt/node22/lib/node_modules/playwright/index.mjs',
    '/usr/lib/node_modules/playwright/index.mjs', process.env.PLAYWRIGHT_PATH].filter(Boolean)) {
    try { return await import(c); } catch { /* next */ }
  }
  throw new Error('playwright not found');
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.mp3': 'audio/mpeg', '.glb': 'model/gltf-binary' };
const server = createServer(async (req, res) => {
  try {
    const p = join(ROOT, decodeURIComponent(req.url.split('?')[0]) === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
    if (!p.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' });
    res.end(await readFile(p));
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist',
    '--enable-webgl', '--disable-gpu-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__telenovela, null, { timeout: 30000 });
await page.evaluate(() => window.__telenovela.dressed);

const scenes = await page.evaluate((only) => {
  const T = window.__telenovela;
  const out = [];
  const list = only === null ? T.dir.scenes.map((_, i) => i) : [only];

  for (const i of list) {
    const scene = T.dir.scenes[i];
    const log = [];
    // Wrap the soundtrack rather than the synth: this is what actually plays.
    const real = T.dir.ctx.score;
    let clock = 0;
    const spy = Object.create(real);
    spy.play = (name, o = {}) => { log.push({ t: clock + (o.delay || 0), name, gain: o.gain ?? 1, kind: 'sfx' }); return { duration: 0 }; };
    spy.say = (name, delay = 0) => { log.push({ t: clock + delay, name, gain: 1, kind: 'vox' }); };
    for (const m of ['sting', 'thunder', 'slap', 'heartbeat', 'crow', 'squawk', 'cluck', 'flap', 'eggCrack', 'peep']) {
      spy[m] = (...a) => { log.push({ t: clock, name: `(${m})`, call: m, args: a, kind: 'sfx' }); };
    }
    spy.setMood = () => {}; spy.setRain = () => {}; spy.setAmbience = () => {};
    spy.harpRun = () => {}; spy.scheduling = true;
    T.dir.ctx.score = spy;

    T.dir.goTo(i);
    const step = 1 / 60;
    // dir.update rolls into the next scene by itself when the clock runs out,
    // so watch the index rather than the clock — comparing t to the duration
    // just runs the guard out in whatever scene it landed in.
    for (let guard = 0; guard < 60000; guard++) {
      const sdt = T.dir.update(step);
      if (T.dir.index !== i) break;
      clock += step;                       // real seconds since the scene began
      if (sdt > 0) {
        for (const k in T.actors) T.actors[k].update(sdt, clock, step);
      }
    }
    T.dir.ctx.score = real;
    out.push({ index: i, name: scene.name, real: clock, log });
  }
  return out;
}, ONLY);

await browser.close();
server.close();

const { CLIP } = await import(new URL('../src/audio-timing.js', import.meta.url));
const { LINES } = await import(new URL('../src/dialogue.js', import.meta.url));
const REF_LOUD = 0.18;
const speakerOf = Object.fromEntries(LINES.map((l) => [l.id, l.who]));

// What a cue actually sounds like: the clip it resolves to, and its level
// relative to a dialogue line at gain 1.
function asClip(e) {
  if (!e.call) return { name: e.name, gain: e.gain };
  const p = e.args[0] ?? 1;
  switch (e.call) {
    case 'sting': {
      const m = { shock: ['sfx-sting', 1.35], reveal: ['sfx-sting-reveal', 1.55], rise: ['sfx-sting-reveal', 1.35], small: ['sfx-sting', 0.55] };
      const [n, g] = m[e.args[0]] || m.shock;
      return { name: n, gain: g };
    }
    case 'thunder': return { name: 'sfx-thunder', gain: 0.9 + p * 0.75 };
    case 'slap': return { name: 'sfx-slap', gain: 1.65 };
    case 'heartbeat': return { name: 'sfx-heartbeat', gain: 0.72 * p };
    case 'crow': return { name: 'sfx-crow', gain: 1.15 };
    case 'squawk': return { name: 'sfx-squawk', gain: 0.78 };
    case 'cluck': return { name: 'sfx-cluck', gain: 0.4 };
    case 'flap': return { name: 'sfx-flap', gain: 0.55 };
    case 'eggCrack': return { name: 'sfx-egg-crack', gain: 0.9 };
    case 'peep': return { name: 'sfx-peep', gain: 0.9 };
    default: return { name: e.name, gain: 1 };
  }
}

let problems = 0;
for (const s of scenes) {
  console.log(`\n${s.index}. ${s.name}   ${s.real.toFixed(1)}s real`);
  const events = s.log.map((e) => {
    const r = asClip(e);
    const c = CLIP[r.name];
    return { ...e, ...r, dur: c ? c.dur : 0, level: r.gain * REF_LOUD };
  }).sort((a, b) => a.t - b.t);

  const speech = events.filter((e) => e.kind === 'vox');
  for (const e of events) {
    const end = e.t + e.dur;
    const label = e.kind === 'vox'
      ? `${(speakerOf[e.name] || 'announcer').padEnd(10)} ${e.name}`
      : `${''.padEnd(10)} ${e.name}${e.call ? '' : ''}`;
    const notes = [];
    if (e.kind === 'vox') {
      for (const o of speech) {
        if (o === e) continue;
        if (o.t > e.t && o.t < end - 0.05) { notes.push(`SPEECH OVER SPEECH (${o.name} at ${o.t.toFixed(1)})`); problems++; }
      }
    } else {
      for (const line of speech) {
        const lineEnd = line.t + line.dur;
        // An effect that starts before the line ducks with everything else;
        // one that starts on top of it gets the same treatment a beat later.
        const heard = e.level * SFX_DUCK;
        if (e.t > line.t - 0.15 && e.t < lineEnd - 0.1 && heard >= REF_LOUD * MASKS) {
          notes.push(`OVER A LINE (${line.name}, ${(heard / REF_LOUD).toFixed(2)}x ducked)`);
          problems++;
        }
      }
    }
    console.log(`  ${e.t.toFixed(2).padStart(6)}s  ${label.padEnd(26)} ${e.dur.toFixed(2)}s  ${(e.level / REF_LOUD).toFixed(2)}x${notes.length ? '   <-- ' + notes.join('; ') : ''}`);
  }
}

console.log(problems ? `\n${problems} problem(s)` : '\nnothing masked, nothing doubled');
process.exit(problems ? 1 : 0);
