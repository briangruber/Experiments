// Shared UI chrome: hide-the-interface and fullscreen, wired the same way for
// both the WebGL2 and WebGPU apps.
//
// When the interface is hidden every panel goes away and only #peek remains —
// a nearly invisible corner button, so pointer- and touch-only users can get
// the controls back without a keyboard. Adding `no-chrome` to <body> removes
// even that, for clean captures.

export function initChrome({ backend } = {}) {
  const body = document.body;
  const hideBtn = document.getElementById('hide-btn');
  const fsBtn = document.getElementById('fs-btn');
  const peek = document.getElementById('peek');

  const hidden = () => body.classList.contains('ui-hidden');
  function setHidden(v) {
    body.classList.toggle('ui-hidden', v);
    hideBtn.setAttribute('aria-pressed', String(v));
  }
  const toggleHide = () => setHidden(!hidden());

  const canFullscreen = !!(document.documentElement.requestFullscreen
    || document.documentElement.webkitRequestFullscreen);
  const inFullscreen = () => !!(document.fullscreenElement || document.webkitFullscreenElement);

  async function toggleFullscreen() {
    try {
      if (inFullscreen()) {
        await (document.exitFullscreen?.() ?? document.webkitExitFullscreen?.());
      } else {
        const el = document.documentElement;
        await (el.requestFullscreen?.({ navigationUI: 'hide' }) ?? el.webkitRequestFullscreen?.());
      }
    } catch {
      // denied (no user gesture) or unsupported: the button just stays put
    }
    syncFullscreen(); // some browsers don't fire fullscreenchange promptly
  }

  function syncFullscreen() {
    const on = inFullscreen();
    // label stays fixed (the lit state says it's on): swapping in a longer
    // string would reflow the two-button row
    fsBtn.classList.toggle('active', on);
    fsBtn.setAttribute('aria-pressed', String(on));
  }
  if (!canFullscreen) fsBtn.hidden = true;
  document.addEventListener('fullscreenchange', syncFullscreen);
  document.addEventListener('webkitfullscreenchange', syncFullscreen);
  syncFullscreen();

  // Backend switch. The two renderers can't be swapped in place, so this
  // reloads with ?gpu= flipped, keeping every other parameter.
  const backendBtn = document.getElementById('backend-btn');
  if (backendBtn) {
    const other = backend === 'WebGPU' ? 'WebGL2' : 'WebGPU';
    if (navigator.gpu) {
      backendBtn.hidden = false;
      const label = backendBtn.querySelector('span');
      if (label) label.textContent = `Switch to ${other}`;
      else backendBtn.textContent = `Switch to ${other}`;
      backendBtn.title = `Currently running ${backend || 'WebGL2'}`;
      backendBtn.addEventListener('click', () => {
        const q = new URLSearchParams(location.search);
        q.set('gpu', backend === 'WebGPU' ? '0' : '1');
        location.search = `?${q}`;
      });
    }
  }

  hideBtn.addEventListener('click', toggleHide);
  fsBtn.addEventListener('click', toggleFullscreen);
  peek.addEventListener('click', () => setHidden(false));

  // The shortcut sheet, and the Renderer disclosure. Both are markup-only —
  // nothing builds their contents — so they are wired here rather than in the
  // panel builders, and both apps get them from the one place.
  const helpBtn = document.getElementById('help-btn');
  const keys = document.getElementById('keys');
  if (helpBtn && keys) {
    helpBtn.addEventListener('click', () => {
      const open = keys.hasAttribute('hidden');
      keys.toggleAttribute('hidden', !open);
      helpBtn.classList.toggle('active', open);
      helpBtn.setAttribute('aria-expanded', String(open));
    });
  }
  // The Settings door. Everything that is not one of the four actions lives
  // behind it, so the panel at rest is four buttons and this.
  const moreBtn = document.getElementById('more-btn');
  const more = document.getElementById('more');
  if (moreBtn && more) {
    moreBtn.addEventListener('click', () => {
      const open = more.hasAttribute('hidden');
      more.toggleAttribute('hidden', !open);
      moreBtn.classList.toggle('active', open);
      moreBtn.setAttribute('aria-expanded', String(open));
    });
  }
  // The paddle's own settings, in a drawer under the paddle row — the same
  // shape the diffuser's tab has. Whether the paddle is in the tank and how it
  // moves are two different questions, and they now sit one above the other
  // rather than one on top and the other three levels down under Settings.
  const padTab = document.getElementById('paddle-tweak-btn');
  const padPanel = document.getElementById('paddle-settings');
  if (padTab && padPanel) {
    padTab.addEventListener('click', () => {
      const open = padPanel.hasAttribute('hidden');
      padPanel.toggleAttribute('hidden', !open);
      padTab.classList.toggle('active', open);
      padTab.setAttribute('aria-expanded', String(open));
    });
  }

  window.addEventListener('keydown', (e) => {
    if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code === 'KeyH') toggleHide();
    else if (e.code === 'KeyF') toggleFullscreen();
  });

  return { toggleHide, toggleFullscreen, setHidden };
}
