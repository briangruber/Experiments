/* The part people actually came for.
   The UI is scheduled off the same clock as the audio, so the words on
   screen change exactly when the sound does. */

import { h, clear, sleep } from '../../core/dom.js';
import { openWindow } from '../../core/wm.js';
import * as A from '../../core/audio.js';

const NUMBER = '5550199';

/** @returns {'connected'|'cancelled'} */
export function runDialer({ name, mode }) {
  return new Promise(resolve => {
    let done = false, timers = [];
    const at = (ms, fn) => timers.push(setTimeout(fn, ms));
    const finish = how => {
      if (done) return;
      done = true;
      timers.forEach(clearTimeout);
      if (how === 'cancelled') A.panic();
      win.onClose = null;
      win.close();
      resolve(how);
    };

    const status = h('div.dial-status', {}, 'Preparing to dial...');
    const detail = h('div.dial-detail', {}, ' ');
    const bar = h('i');
    const stage = h('div.dial-stage', {},
      h('div.dial-node.phone', {}, h('b', {}, 'MODEM'), h('span', {}, 'COM2 33.6')),
      h('div.dial-wire', {}, h('u'), h('u'), h('u'), h('u'), h('u')),
      h('div.dial-node.host', {}, h('b', {}, 'HALCYON'), h('span', {}, NUMBER.replace(/(\d{3})(\d{4})/, '$1-$2'))));

    const cancel = h('button.btn', { type: 'button', onclick: () => finish('cancelled') }, 'Cancel');
    const skip = h('button.btn.small.dial-skip', {
      type: 'button', title: 'Jump to the end of the handshake',
      onclick: () => { A.panic(); connectNow(); },
    }, 'Skip the noise');

    const win = openWindow({
      id: 'halcyon-dialer', title: 'Halcyon Online 3.0', icon: 'phone',
      width: 400, height: 250, resizable: false,
      onClose: () => { finish('cancelled'); return true; },
    });

    clear(win.body).append(h('div.dial', {},
      stage,
      status, detail,
      h('div.dial-bar', {}, bar),
      h('div.dial-btns', {}, skip, cancel)));

    /* ── schedule sound and picture together ─────────────────────────── */

    const ctx = A.unlock();
    const t0 = ctx.currentTime + 0.25;
    let t = t0;

    t = A.offHook(t);
    const tDial = t;
    t = A.dialDigits(NUMBER, t);
    const tRing = t + 0.25;
    t = A.ringback(tRing, 1);
    const tShake = t - 1.2;
    const tEnd = A.handshake(tShake);

    const ms = when => Math.max(0, (when - ctx.currentTime) * 1000);
    const setBar = pct => { bar.style.width = pct + '%'; };

    at(ms(t0), () => { status.textContent = 'Picking up the line...'; detail.textContent = 'Please hang up any other telephone.'; setBar(6); });
    at(ms(tDial), () => { status.textContent = 'Dialing ' + NUMBER.replace(/(\d{3})(\d{4})/, '$1-$2') + '...'; detail.textContent = 'Local access number'; setBar(16); stage.classList.add('live'); });
    at(ms(tRing), () => { status.textContent = 'Ringing...'; detail.textContent = ' '; setBar(28); });
    at(ms(tShake + 0.2), () => { status.textContent = 'Connecting...'; detail.textContent = 'Answer tone detected'; setBar(40); });
    at(ms(tShake + 2.0), () => { detail.textContent = 'Negotiating protocol  V.34'; setBar(52); });
    at(ms(tShake + 3.4), () => { detail.textContent = 'Training equalizer'; setBar(64); });
    at(ms(tShake + 5.6), () => { detail.textContent = 'Retraining  line quality is fair'; setBar(74); });
    at(ms(tShake + 7.2), () => { detail.textContent = 'Carrier established'; setBar(84); });
    at(ms(tEnd), () => {
      status.textContent = 'Connected at 33,600 bps';
      detail.textContent = 'Verifying screen name and password...';
      setBar(92);
      stage.classList.add('linked');
    });
    at(ms(tEnd) + 1500, () => { detail.textContent = 'Checking for new mail...'; setBar(97); });
    at(ms(tEnd) + 2600, connectNow);

    function connectNow() {
      if (done) return;
      status.textContent = 'You are now connected.';
      detail.textContent = mode === 'relay' ? 'Relay session' : 'Local session';
      setBar(100);
      stage.classList.add('linked');
      A.buddyIn();
      setTimeout(() => finish('connected'), 600);
    }
  });
}

/** Used by the "You have been disconnected" set piece. */
export async function dropLine() {
  A.busySignal(A.audioCtx() ? A.audioCtx().currentTime : 0, 2);
  await sleep(600);
}
