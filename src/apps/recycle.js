/* The Recycle Bin. It has things in it, because everybody's did. */

import { h, clear } from '../core/dom.js';
import { openWindow, dialog } from '../core/wm.js';
import { icon } from '../core/icons.js';
import * as A from '../core/audio.js';

const ITEMS = [
  ['Untitled 1.bmp', 'Bitmap Image', '230 KB', '8/16/97 11:40 PM'],
  ['Untitled 2.bmp', 'Bitmap Image', '230 KB', '8/16/97 11:41 PM'],
  ['Untitled 7.bmp', 'Bitmap Image', '230 KB', '8/16/97 11:52 PM'],
  ['screen names (old).txt', 'Text Document', '1 KB', '8/12/97 6:02 PM'],
  ['setup.exe', 'Application', '4,110 KB', '8/15/97 9:15 AM'],
  ['DO NOT DELETE.txt', 'Text Document', '1 KB', '7/30/97 4:44 PM'],
];

export function open(ctx) {
  let items = ITEMS.slice();

  const win = openWindow({
    id: 'recycle', title: 'Recycle Bin', icon: 'trash',
    width: 460, height: 300, minWidth: 300,
    status: ['', ''],
    menu: [
      { label: 'File', onclick: () => empty() },
      { label: 'Edit' }, { label: 'View' }, { label: 'Help' },
    ],
  });

  const table = h('div.rb.scroll');
  clear(win.body).append(table);

  function draw() {
    clear(table).append(h('div.rb-head', {},
      h('span', {}, 'Name'), h('span', {}, 'Type'), h('span', {}, 'Size'), h('span', {}, 'Deleted')));
    for (const [name, type, size, when] of items) {
      const row = h('div.rb-row', {},
        h('span', {}, name), h('span', {}, type), h('span', {}, size), h('span', {}, when));
      table.append(row);
    }
    if (!items.length) table.append(h('div.rb-empty', {}, 'This folder is empty.'));
    win.setStatus([items.length + ' object(s)', items.length ? '' : 'Nothing to restore']);
  }

  async function empty() {
    if (!items.length) { A.ding(); return; }
    const ok = await dialog({
      title: 'Confirm Multiple File Delete', icon: 'warn',
      message: 'Are you sure you want to delete these ' + items.length + ' items?',
      buttons: ['Yes', 'No'],
    });
    if (ok !== 'Yes') return;
    A.seek(8, 0.7);
    items = [];
    draw();
  }

  draw();
  return win;
}
