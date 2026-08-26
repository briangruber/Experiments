/* Notepad. Word wrap off by default, because that was the joke. */

import { h, clear } from '../core/dom.js';
import { openWindow, dialog } from '../core/wm.js';
import * as A from '../core/audio.js';

let n = 0;

export function open(ctx, args = {}) {
  const name = args.name || 'Untitled';
  const win = openWindow({
    id: 'notepad-' + (args.name || ++n), title: name + ' - Notepad', icon: 'doc',
    width: 480, height: 360, minWidth: 260, minHeight: 160,
    menu: [
      { label: 'File', onclick: () => dialog({
        title: 'Notepad', icon: 'doc',
        message: 'There is no disk to save to.\n\nThe text stays here as long as ' +
                 'the window is open, which is more than some word processors managed.' }) },
      { label: 'Edit', onclick: () => { area.select(); } },
      { label: 'Search', onclick: () => find() },
      { label: 'Help', onclick: () => dialog({
        title: 'Notepad', icon: 'help',
        message: 'Type. That is the whole program.' }) },
    ],
  });

  const area = h('textarea.np', {
    spellcheck: false, wrap: 'off', value: args.text || '',
    readOnly: !!args.readOnly,
  });
  clear(win.body).append(area);
  setTimeout(() => area.focus(), 60);

  async function find() {
    const r = await dialog({
      title: 'Find', icon: 'doc', message: 'Find what:',
      buttons: ['Find Next', 'Cancel'], input: { value: '' },
    });
    if (!r || r.button !== 'Find Next' || !r.value) return;
    const i = area.value.toLowerCase().indexOf(r.value.toLowerCase(), area.selectionEnd);
    if (i < 0) { A.ding(); dialog({ title: 'Notepad', icon: 'info', message: 'Cannot find "' + r.value + '"' }); return; }
    area.focus();
    area.setSelectionRange(i, i + r.value.length);
  }

  return win;
}
