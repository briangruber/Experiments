/*
 * Reverie is part of Halcyon the way the graphical services were part of
 * the phone company: it will happily run on its own.
 *
 * If you are signed on, it borrows that session, so the same name and the
 * same connection carry across and you are one person on the network. If
 * you are not, it makes its own — a name, a rate limiter and a transport —
 * and never mentions the service at all.
 */

import { createNet } from '../../core/net.js';
import { createBucket, screenName } from '../../core/safety.js';
import { dialog } from '../../core/wm.js';

const NAME = 'reverie.name';
let solo = null;

const savedName = () => {
  try { return localStorage.getItem(NAME) || ''; } catch { return ''; }
};
const rememberName = n => { try { localStorage.setItem(NAME, n); } catch {} };

export async function open() {
  const halcyon = await import('../halcyon/index.js');
  const joined = halcyon.currentSession();
  const session = joined || solo || (solo = await standalone());
  if (!session) return null;

  const { openReverie } = await import('./index.js');
  return openReverie(session);
}

/** A session of its own: everything Reverie actually asks a session for. */
async function standalone() {
  const name = await askName(savedName());
  if (!name) return null;
  rememberName(name);

  const net = createNet({ mode: 'local', screenName: name });
  await net.connect();
  return {
    name, net, mode: 'local', solo: true,
    since: Date.now(),
    bucket: createBucket(),
    rooms: new Map(),
    /* Changing your name means being a different person on the network,
       so the transport is rebuilt rather than relabelled. */
    rename: async () => {
      const next = await askName(solo.name);
      if (!next || next === solo.name) return solo.name;
      solo.net.disconnect();
      rememberName(next);
      solo.name = next;
      solo.net = createNet({ mode: 'local', screenName: next });
      await solo.net.connect();
      return next;
    },
  };
}

async function askName(current) {
  while (true) {
    const got = await dialog({
      title: 'The Reverie Network', icon: 'globe',
      message: 'What should everybody call you in Reverie?\n\n' +
               'This never leaves your computer unless you run the relay yourself.',
      input: { value: current || 'Guest', maxLength: 16 },
      buttons: ['Enter Reverie', 'Cancel'],
    });
    if (!got || !got.button || got.button === 'Cancel') return null;
    const check = screenName(String(got.value || '').trim());
    if (check.ok) return check.name;
    await dialog({ title: 'The Reverie Network', icon: 'warn', message: check.reason });
    current = String(got.value || '');
  }
}
