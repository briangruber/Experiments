/* My Computer, and the folder window it opens into. Text files open in
   Notepad; the floppy drive is empty, and says so the way it used to. */

import { h, clear, $$, onDouble } from '../core/dom.js';
import { openWindow, dialog } from '../core/wm.js';
import { icon } from '../core/icons.js';
import * as A from '../core/audio.js';
import { DRIVES, at, isFolder } from '../core/fs.js';

export function open(ctx, args = {}) {
  if (args.path) return folderWindow(ctx, args.path);

  const win = openWindow({
    id: 'mycomputer', title: 'My Computer', icon: 'computer',
    width: 400, height: 280, minWidth: 260,
    status: ['3 object(s)', ''],
    menu: [{ label: 'File' }, { label: 'Edit' }, { label: 'View' }, { label: 'Help' }],
  });

  const grid = h('div.explorer.scroll');
  clear(win.body).append(grid);

  for (const d of DRIVES) {
    const el = h('div.fitem', { tabIndex: 0 }, icon(d.icon, 32), h('span', {}, d.label));
    el.addEventListener('pointerdown', () => sel(grid, el));
    onDouble(el, () => {
      A.seek(4, 0.3);
      if (d.empty) {
        dialog({
          title: d.label, icon: 'error',
          message: 'A:\\ is not accessible.\n\nThe device is not ready.',
        });
        return;
      }
      folderWindow(ctx, [d.id]);
    });
    grid.append(el);
  }
  return win;
}

function sel(root, el) {
  $$('.fitem', root).forEach(x => x.classList.remove('sel'));
  el.classList.add('sel');
}

function pathTitle(path) {
  const drive = DRIVES.find(d => d.id === path[0]);
  return (drive ? drive.id.toUpperCase() + ':\\' : '') + path.slice(1).join('\\');
}

export function folderWindow(ctx, path) {
  const node = at(path);
  if (!isFolder(node)) return null;

  const win = openWindow({
    id: 'folder-' + path.join('/'), title: pathTitle(path), icon: 'folder',
    width: 440, height: 300, minWidth: 260,
    status: ['', ''],
    menu: [{ label: 'File' }, { label: 'Edit' }, { label: 'View' }, { label: 'Help' }],
  });

  const grid = h('div.explorer.scroll');
  clear(win.body).append(grid);

  const entries = Object.entries(node);
  if (path.length > 1) {
    const up = h('div.fitem', { tabIndex: 0 }, icon('folder', 32), h('span', {}, '..'));
    onDouble(up, () => { win.close(); folderWindow(ctx, path.slice(0, -1)); });
    grid.append(up);
  }

  for (const [name, value] of entries) {
    const kind = isFolder(value) ? 'folder' : typeof value === 'string' ? 'doc'
      : /\.exe$/i.test(name) ? 'game' : 'doc';
    const el = h('div.fitem', { tabIndex: 0 }, icon(kind, 32), h('span', {}, name));
    el.addEventListener('pointerdown', () => sel(grid, el));
    onDouble(el, () => {
      A.click();
      if (isFolder(value)) return folderWindow(ctx, [...path, name]);
      if (typeof value === 'string')
        return ctx.launch('notepad', { name, text: value, readOnly: true });
      dialog({
        title: name, icon: 'error',
        message: 'This program requires Panes 95 or later, a 486 processor,\n' +
                 'and, in the end, a decision to leave it in 1997.',
      });
    });
    grid.append(el);
  }

  win.setStatus([entries.length + ' object(s)', pathTitle(path)]);
  return win;
}
