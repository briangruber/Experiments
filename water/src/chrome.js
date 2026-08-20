// Shared UI chrome: hide-the-interface and fullscreen, wired the same way for
// both the WebGL2 and WebGPU apps.
//
// When the interface is hidden every panel goes away and only #peek remains —
// a nearly invisible corner button, so pointer- and touch-only users can get
// the controls back without a keyboard. Adding `no-chrome` to <body> removes
// even that, for clean captures.

export function initChrome() {
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

  hideBtn.addEventListener('click', toggleHide);
  fsBtn.addEventListener('click', toggleFullscreen);
  peek.addEventListener('click', () => setHidden(false));

  window.addEventListener('keydown', (e) => {
    if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code === 'KeyH') toggleHide();
    else if (e.code === 'KeyF') toggleFullscreen();
  });

  return { toggleHide, toggleFullscreen, setHidden };
}
