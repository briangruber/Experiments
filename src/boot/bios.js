/* Power-on self test, then the splash. Timed to be quick enough that you
   do not resent it and slow enough that you remember it. */

import { h, clear, sleep, $ } from '../core/dom.js';
import * as A from '../core/audio.js';

const boot = () => $('#boot');

/* #boot is white-space: pre-wrap, so a line is its content plus a newline.
   Wrapping it in a block element as well would double-space the screen. */
function line(...kids) {
  const b = boot();
  for (const k of kids) b.append(k instanceof Node ? k : document.createTextNode(String(k)));
  b.append(document.createTextNode('\n'));
  b.scrollTop = b.scrollHeight;
}

async function type(text, speed = 6) {
  const el = h('span');
  boot().append(el);
  for (let i = 0; i < text.length; i += 2) {
    el.textContent = text.slice(0, i + 2);
    await sleep(speed);
  }
  el.textContent = text;
  boot().append(document.createTextNode('\n'));
}

/** Counts memory the way the real thing did: fast, in 64K steps, visibly. */
async function countMemory(total = 65536) {
  const num = h('span.white', {}, '0K');
  const tail = h('span');
  boot().append(document.createTextNode('Memory Test : '), num, ' ', tail,
    document.createTextNode('\n'));
  const step = 1024;
  for (let k = 0; k <= total; k += step) {
    num.textContent = k + 'K';
    if (k % 8192 === 0) A.seek(1, 0.02);
    await sleep(9);
  }
  num.textContent = total + 'K';
  tail.append(h('span.white', {}, 'OK'));
}

export async function runPost({ fast = false } = {}) {
  const b = boot();
  clear(b);
  b.classList.remove('splash');
  const t = fast ? 0.25 : 1;

  await sleep(320 * t);
  line(h('span.amber', {}, 'PACKARD HILL BIOS v4.51PG'));
  line(h('span.dim', {}, 'Copyright (C) 1985-1997, Award Systems Ltd.'));
  line('');
  await sleep(420 * t);

  line('Legend 4200 Series  BIOS Date 06/12/97-i430TX-2A69KP');
  await sleep(300 * t);
  line('Pentium(R) MMX(TM) CPU at 166MHz');
  await sleep(240 * t);

  if (fast) { line('Memory Test : 65536K OK'); }
  else await countMemory();
  A.postBeep();
  await sleep(500 * t);
  line('');

  line('Detecting IDE Primary Master   ... QUANTUM FIREBALL ST3.2A');
  await sleep(360 * t);
  line('Detecting IDE Primary Slave    ... None');
  await sleep(180 * t);
  line('Detecting IDE Secondary Master ... MITSUMI CD-ROM FX240 8X');
  A.seek(4, 0.5);
  await sleep(420 * t);
  line('');

  line('Plug and Play BIOS Extension v1.0A');
  await sleep(200 * t);
  line(h('span.dim', {}, '  PCI slot 2  ... Multimedia Device (Sound Blaster 16)'));
  await sleep(140 * t);
  line(h('span.dim', {}, '  PCI slot 3  ... Communication Device (Rockwell 33.6 Fax/Modem)'));
  await sleep(140 * t);
  line(h('span.dim', {}, '  ISA         ... Display (Trident 9680 1MB)'));
  await sleep(560 * t);
  line('');

  await type('Verifying DMI Pool Data ...........', fast ? 1 : 7);
  await sleep(700 * t);
  clear(b);
  await sleep(260 * t);

  line('Starting Panes 95...');
  A.seek(10, 1.1);
  boot().append(h('span.cursor'));
  await sleep(1400 * t);

  await splash({ fast });
}

async function splash({ fast = false } = {}) {
  const b = boot();
  clear(b);
  b.classList.add('splash');
  b.append(h('div.splash-inner', {},
    h('div.splash-logo', {}, h('i'), h('i'), h('i'), h('i')),
    h('div.splash-title', {}, 'Panes', h('span', {}, 'NINETY  FIVE')),
    h('div.splash-bar', {}, h('i'), h('i'), h('i'))),
    h('div.splash-note', {}, 'Loading your personal settings...'));
  await sleep(fast ? 700 : 2600);
}

export async function fadeOutBoot() {
  const b = boot();
  b.style.transition = 'opacity .35s';
  b.style.opacity = '0';
  await sleep(360);
  b.hidden = true;
  b.style.opacity = '';
}
