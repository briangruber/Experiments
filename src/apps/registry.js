/* Everything installed on this machine. The desktop, the Start menu and
   the quick-launch bar all read from here, and each entry loads its
   module the first time it is opened. */

export const APPS = {
  halcyon: {
    title: 'Halcyon Online 3.0', icon: 'halcyon', desktop: 1, start: 1, quick: 1,
    load: () => import('./halcyon/index.js'),
  },
  browser: {
    title: 'NetScrape Navigator', icon: 'browser', desktop: 2, start: 2, quick: 2,
    load: () => import('./browser.js'),
  },
  mycomputer: {
    title: 'My Computer', icon: 'computer', desktop: 0, start: 3,
    load: () => import('./mycomputer.js'),
  },
  minehunt: {
    title: 'Mine Hunt', icon: 'game', desktop: 4, start: 5,
    load: () => import('./minehunt.js'),
  },
  sketchpad: {
    title: 'Sketchpad', icon: 'paint', desktop: 5, start: 6,
    load: () => import('./sketchpad.js'),
  },
  jukebox: {
    title: 'Jukebox 95', icon: 'media', desktop: 6, start: 7, quick: 3,
    load: () => import('./jukebox.js'),
  },
  defrag: {
    title: 'Disk Defragmenter', icon: 'defrag', start: 8,
    load: () => import('./defrag.js'),
  },
  notepad: {
    title: 'Notepad', icon: 'doc', start: 9,
    load: () => import('./notepad.js'),
  },
  recycle: {
    title: 'Recycle Bin', icon: 'trash', desktop: 9,
    load: () => import('./recycle.js'),
  },
  readme: {
    title: 'Read Me First', icon: 'help', desktop: 8, start: 11,
    load: () => import('./readme.js'),
  },
};

const cache = new Map();

/**
 * Opens an app by key. Modules export `open(ctx, args)` and are
 * responsible for their own window.
 */
export async function launch(key, ctx, args) {
  const app = APPS[key];
  if (!app) return null;
  if (!cache.has(key)) cache.set(key, app.load());
  const mod = await cache.get(key);
  return mod.open(ctx, args);
}

export const listBy = field => Object.entries(APPS)
  .filter(([, a]) => a[field])
  .sort((a, b) => a[1][field] - b[1][field])
  .map(([key, a]) => ({ key, ...a }));
