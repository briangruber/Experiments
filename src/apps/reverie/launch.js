/* Reverie is part of the service, so it needs a signed-on session. The
   desktop icon therefore either opens it or points you at the sign-on.
   Halcyon is reached by dynamic import so the two modules do not form a
   static cycle. */

export async function open(ctx) {
  const halcyon = await import('../halcyon/index.js');
  const session = halcyon.currentSession();
  if (session) {
    const { openReverie } = await import('./index.js');
    return openReverie(session);
  }

  const { dialog } = await import('../../core/wm.js');
  const go = await dialog({
    title: 'The Reverie Network', icon: 'globe', aol: true,
    message:
      'Reverie is part of Halcyon Online.\n\n' +
      'Sign on first and it is a keyword away — or press Sign On here and\n' +
      'this will be waiting on the other side.',
    buttons: ['Sign On', 'Cancel'],
  });
  if (go === 'Sign On') return halcyon.open(ctx);
  return null;
}
