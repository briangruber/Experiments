/* Boot. The power button is the only thing on screen until you press it,
   which is also what gives the AudioContext permission to make noise for
   the rest of the session. */

import { $, sleep } from './core/dom.js';
import * as A from './core/audio.js';
import { runPost, fadeOutBoot } from './boot/bios.js';
import { initDesktop } from './boot/desktop.js';
import { launch } from './apps/registry.js';
import { closeAll } from './core/wm.js';
import { stopSaver } from './apps/screensaver.js';
import { initAssistant, stopAssistant } from './apps/assistant.js';

const ctx = {
  launch: (key, args) => launch(key, ctx, args),
  shutdown,
};

let booted = false;

$('#power').addEventListener('click', () => {
  if (booted) return;
  booted = true;
  bootUp({ fast: new URLSearchParams(location.search).has('fast') });
});

async function bootUp({ fast = false } = {}) {
  A.unlock();
  A.powerClunk();
  $('#room').classList.add('off');
  $('#hdd-led').classList.add('on');
  await sleep(340);
  $('#room').hidden = true;

  const crt = $('#crt');
  crt.hidden = false;
  crt.classList.add('warming');
  await sleep(900);
  crt.classList.remove('warming');

  await runPost({ fast });
  await fadeOutBoot();

  $('#desktop').hidden = false;
  A.startupChime();
  initDesktop(ctx);
  initAssistant();

  // The disk light settles down once the desktop has finished loading.
  setTimeout(() => $('#hdd-led').classList.remove('on'), 1600);

  if (!localStorage.getItem('panes.seen')) {
    try { localStorage.setItem('panes.seen', '1'); } catch {}
    setTimeout(() => launch('readme', ctx), 1200);
  }
}

async function shutdown(restart = false) {
  stopSaver();
  stopAssistant();
  closeAll();
  A.shutdownChime();

  const boot = $('#boot');
  boot.hidden = false;
  boot.className = 'layer';
  boot.style.opacity = '1';
  boot.textContent = '';
  boot.style.display = 'grid';
  boot.style.placeItems = 'center';
  boot.style.background = '#c8931f';
  boot.style.color = '#3a2a00';
  boot.style.font = '700 22px Tahoma, sans-serif';
  boot.style.textAlign = 'center';
  boot.textContent = "It's now safe to turn off\nyour computer.";
  boot.style.whiteSpace = 'pre-line';
  $('#desktop').hidden = true;

  await sleep(restart ? 1500 : 2600);

  if (restart) {
    boot.removeAttribute('style');
    boot.className = 'layer';
    booted = false;
    $('#hdd-led').classList.add('on');
    await runPost({ fast: true });
    await fadeOutBoot();
    $('#desktop').hidden = false;
    A.startupChime();
    booted = true;
    setTimeout(() => $('#hdd-led').classList.remove('on'), 1200);
    return;
  }

  $('#hdd-led').classList.remove('on');
  await sleep(400);
  $('#crt').hidden = true;
  $('#room').hidden = false;
  $('#room').classList.remove('off');
  booted = false;
}
