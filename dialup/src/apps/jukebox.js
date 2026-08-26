/* Jukebox 95 — a CD-player-shaped thing that plays five short synthesised
   tracks, with the bar visualiser every media player of the era had. */

import { h, clear } from '../core/dom.js';
import { openWindow } from '../core/wm.js';
import * as A from '../core/audio.js';

const TRACKS = [
  { name: 'Startup Theme', len: '0:16', bpm: 118, voices: [
    { type: 'square', gain: 1, step: .5,
      notes: ['C5','E5','G5','C6','B5','G5','E5','G5','A5','F5','D5','F5','E5','C5','-','-'] },
    { type: 'triangle', gain: .8, step: 1, notes: ['C3','G2','A2','F2','C3','G2','G2','C3'] },
  ] },
  { name: 'Hold Music', len: '0:20', bpm: 92, voices: [
    { type: 'sine', gain: 1, step: .5,
      notes: ['E4','G4','B4','D5','C5','B4','A4','G4','F4','A4','C5','E5','D5','C5','B4','-'] },
    { type: 'triangle', gain: .6, step: 2, notes: ['E2','A2','F2','G2'] },
  ] },
  { name: 'Screensaver', len: '0:24', bpm: 78, voices: [
    { type: 'triangle', gain: 1, step: 1,
      notes: ['A4','C5','E5','D5','C5','A4','G4','A4'] },
    { type: 'sine', gain: .5, step: 4, notes: ['A2','F2'] },
  ] },
  { name: 'Download Complete', len: '0:12', bpm: 140, voices: [
    { type: 'square', gain: 1, step: .25,
      notes: ['G4','B4','D5','G5','D5','B4','G4','B4','A4','C5','E5','A5','E5','C5','A4','C5'] },
    { type: 'sawtooth', gain: .35, step: 1, notes: ['G2','G2','A2','A2'] },
  ] },
  { name: 'Sign Off', len: '0:18', bpm: 84, voices: [
    { type: 'triangle', gain: 1, step: 1,
      notes: ['C5','B4','A4','G4','F4','E4','D4','C4'] },
    { type: 'sine', gain: .6, step: 2, notes: ['C3','G2','F2','C2'] },
  ] },
];

export function open(ctx) {
  let idx = 0, playing = null, raf = 0, elapsed = 0, t0 = 0;

  const win = openWindow({
    id: 'jukebox', title: 'Jukebox 95', icon: 'media',
    width: 320, height: 300, resizable: false,
    onClose: () => { stop(); return true; },
  });

  const lcdTrack = h('div.jb-track', {}, '-- no disc --');
  const lcdTime = h('div.jb-time', {}, '00:00');
  const bars = h('div.jb-bars', {}, Array.from({ length: 22 }, () => h('i')));
  const list = h('div.jb-list.scroll');

  const btn = (label, title, onclick) =>
    h('button.jb-btn', { type: 'button', title, onclick }, label);

  clear(win.body).append(h('div.jb', {},
    h('div.jb-display.sunken', {}, lcdTrack, lcdTime, bars),
    h('div.jb-transport', {},
      btn('|<', 'Previous', () => select(idx - 1)),
      btn('>', 'Play', () => play()),
      btn('||', 'Pause', () => stop()),
      btn('>|', 'Next', () => select(idx + 1))),
    list));

  function drawList() {
    clear(list);
    TRACKS.forEach((t, i) => {
      const row = h('button.jb-row', { type: 'button', class: i === idx ? 'on' : '' },
        h('span', {}, String(i + 1).padStart(2, '0')),
        h('b', {}, t.name), h('em', {}, t.len));
      row.addEventListener('click', () => { select(i); play(); });
      list.append(row);
    });
  }

  function select(i) {
    idx = (i + TRACKS.length) % TRACKS.length;
    const was = !!playing;
    stop();
    lcdTrack.textContent = String(idx + 1).padStart(2, '0') + '  ' + TRACKS[idx].name;
    drawList();
    if (was) play();
  }

  function play() {
    if (playing) return;
    A.unlock();
    playing = A.playTune(TRACKS[idx], { bpm: TRACKS[idx].bpm, gain: 0.05 });
    t0 = performance.now() - elapsed;
    lcdTrack.textContent = String(idx + 1).padStart(2, '0') + '  ' + TRACKS[idx].name;
    win.setTitle('Jukebox 95 - ' + TRACKS[idx].name);
    tick();
  }

  function stop() {
    if (playing) { playing.stop(); playing = null; }
    cancelAnimationFrame(raf);
    [...bars.children].forEach(b => (b.style.height = '4%'));
  }

  function tick() {
    if (!playing) return;
    elapsed = performance.now() - t0;
    const s = Math.floor(elapsed / 1000);
    lcdTime.textContent = String((s / 60) | 0).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
    // The visualiser is honest about being decorative: it dances to the
    // tempo of the track rather than to any real analysis.
    const beat = elapsed / (60000 / TRACKS[idx].bpm);
    [...bars.children].forEach((b, i) => {
      const v = Math.abs(Math.sin(beat * 3.1 + i * 0.6)) * (1 - i / 40) +
                Math.random() * 0.14;
      b.style.height = (6 + v * 88).toFixed(0) + '%';
    });
    raf = requestAnimationFrame(tick);
  }

  select(0);
  return win;
}
