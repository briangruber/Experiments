// The going-ashore interface: one prompt and one button.
//
// It is deliberately the smallest HUD in the project. Mooring is not a
// minigame — it is a door — and a door needs a handle, not a dashboard. The
// prompt only exists when the action does, so the button is never a lie.

const CSS = `
#sf-shore { position: fixed; inset: 0; z-index: 45; pointer-events: none;
  font: 600 13px/1.2 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  letter-spacing: .08em; text-transform: uppercase; }

/* The prompt sits low-centre, where the eye already is when the boat is
   coasting in — not in a corner it would have to be hunted for. */
#sf-shore .act { position: absolute; left: 50%; transform: translateX(-50%);
  bottom: calc(112px + env(safe-area-inset-bottom));
  pointer-events: auto; cursor: pointer; display: flex; align-items: center; gap: 9px;
  padding: 11px 18px; border-radius: 999px;
  background: rgba(14,26,38,.72); color: #EAF4FF;
  border: 1px solid rgba(226,242,255,.26);
  backdrop-filter: blur(7px); -webkit-backdrop-filter: blur(7px);
  box-shadow: 0 6px 22px rgba(0,0,0,.32);
  opacity: 0; transition: opacity .22s ease, transform .22s ease;
  transform: translateX(-50%) translateY(7px); }
#sf-shore .act.on { opacity: 1; transform: translateX(-50%) translateY(0); }
#sf-shore .act:active { background: rgba(30,52,72,.86); }
#sf-shore .act .k { font-size: 11px; opacity: .72; padding: 2px 6px; border-radius: 5px;
  border: 1px solid rgba(226,242,255,.3); }

/* The walking hint, shown for a few seconds after you step off. */
#sf-shore .hint { position: absolute; left: 50%; transform: translateX(-50%);
  bottom: calc(70px + env(safe-area-inset-bottom));
  padding: 7px 13px; border-radius: 999px; font-size: 11px;
  background: rgba(10,20,30,.5); color: rgba(234,244,255,.82);
  opacity: 0; transition: opacity .3s ease; white-space: nowrap; }
#sf-shore .hint.on { opacity: 1; }

/* Ashore, the sailing HUD is for a helm that is not answering. */
body.sf-ashore #hud { opacity: 0; pointer-events: none; transition: opacity .3s ease; }
body.sf-ashore #sf-fish-go { display: none; }
body.sf-ashore #touch .times { display: none; }
`;

export function createShoreHud({ shore, ctx }) {
  if (typeof document === 'undefined') return { update() {}, dispose() {} };

  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.id = 'sf-shore';
  root.setAttribute('data-sf-ui', '');
  root.innerHTML = `
    <div class="act"><span class="t">Tie up</span><span class="k">E</span></div>
    <div class="hint"></div>`;
  document.body.appendChild(root);

  const act = root.querySelector('.act');
  const actT = root.querySelector('.act .t');
  const actK = root.querySelector('.act .k');
  const hint = root.querySelector('.hint');

  const touch = typeof matchMedia === 'function'
    && (matchMedia('(pointer: coarse)').matches || (navigator.maxTouchPoints || 0) > 0);
  if (touch) actK.style.display = 'none';

  const fire = (e) => { e.preventDefault(); shore.toggle(); };
  act.addEventListener('click', fire);
  act.addEventListener('touchstart', fire, { passive: false });

  const onKey = (e) => {
    if (e.repeat) return;
    if (e.code !== 'KeyE') return;
    if (!shore.state.canDock) return;
    shore.toggle();
  };
  window.addEventListener('keydown', onKey);

  // Every write is guarded, same as the fishing HUD: update() runs per frame
  // and a style write that changes nothing still costs a recalculation.
  const prev = {};
  const set = (key, v, fn) => { if (prev[key] !== v) { prev[key] = v; fn(v); } };

  let hintUntil = 0;

  function update() {
    const s = shore.state;
    set('ashore', s.mode !== 'afloat', (v) => {
      document.body.classList.toggle('sf-ashore', v);
    });

    // The prompt is offered only during the two states where it means
    // something — never mid-transition, when pressing it would fight the tween.
    const on = !!s.prompt && (s.mode === 'afloat' || s.mode === 'ashore');
    set('on', on, (v) => act.classList.toggle('on', v));
    set('label', s.prompt || '', (v) => { actT.textContent = v; });

    if (s.mode === 'ashore' && s.hint && !prev.hintShown) {
      prev.hintShown = true;
      hintUntil = (ctx?.time || 0) + 7;
    }
    if (s.mode === 'afloat') prev.hintShown = false;
    const showHint = s.mode === 'ashore' && (ctx?.time || 0) < hintUntil;
    set('hint', showHint ? s.hint : '', (v) => {
      hint.textContent = v;
      hint.classList.toggle('on', !!v);
    });
  }

  return {
    update,
    dispose() {
      window.removeEventListener('keydown', onKey);
      root.remove();
      style.remove();
    },
  };
}
