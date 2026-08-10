// The first thing you see. On a phone especially — nothing on screen otherwise
// says the left thumb drives and the right thumb looks.
//
// Palette and type are the HUD's, not a second design: pale blue-white on a
// dark translucent ground, thin strokes, letterspaced small caps, and orange
// reserved for the one thing that is a call to action. It dismisses on any
// input, after a few seconds on its own, and whenever the capture harness hides
// the HUD.

const CSS = `
#intro { position: fixed; inset: 0; z-index: 70; display: grid; place-items: center;
  background: radial-gradient(115% 85% at 50% 46%, rgba(5,12,26,.62), rgba(3,7,17,.93));
  backdrop-filter: blur(3px); -webkit-backdrop-filter: blur(3px);
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  color: #dceaf7; text-align: center; padding: 6vh 7vw;
  transition: opacity .5s ease; }
#intro.gone { opacity: 0; pointer-events: none; }
#intro .wrap { display: flex; flex-direction: column; align-items: center; gap: 18px;
  max-width: 30rem; }
#intro .eyebrow { font-size: 10px; letter-spacing: .34em; text-transform: uppercase;
  color: rgba(160,196,228,.72); }
#intro h1 { margin: 0; font-size: clamp(30px, 8vw, 52px); font-weight: 600;
  letter-spacing: .06em; text-transform: uppercase; text-wrap: balance;
  text-shadow: 0 2px 24px rgba(0,0,0,.55); }
#intro .rule { width: 62px; height: 1px; background: rgba(190,222,248,.34); }
#intro p { margin: 0; font-size: 14px; line-height: 1.75; color: rgba(220,238,251,.90);
  text-wrap: balance; text-shadow: 0 1px 12px rgba(0,0,0,.6); }
#intro .keys { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px 10px; }
#intro .keys span { border: 1px solid rgba(206,232,255,.22); border-radius: 999px;
  padding: 6px 12px; font-size: 10px; letter-spacing: .14em; text-transform: uppercase;
  color: rgba(214,236,255,.76); background: rgba(9,22,40,.44); }
#intro .backend { font-size: 10px; letter-spacing: .22em; text-transform: uppercase;
  color: rgba(150,190,225,.66); }
#intro .go { margin-top: 6px; font-size: 11px; letter-spacing: .26em;
  text-transform: uppercase; color: #ff9a3c; }
@media (prefers-reduced-motion: reduce) { #intro { transition: none; } }
`;

export function createIntro({ touch = false, backend = null } = {}) {
  if (document.getElementById('intro')) return { dispose() {} };

  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const el = document.createElement('div');
  el.id = 'intro';
  const controls = touch
    ? ['Left thumb &mdash; steer &amp; throttle', 'Right thumb &mdash; look', 'Pinch &mdash; zoom',
      '<b>Fish</b> &mdash; stop and go under']
    : ['W A S D &mdash; helm', 'Drag &mdash; look', '1 2 3 4 &mdash; time of day',
      '<b>F</b> &mdash; stop and go under'];
  el.innerHTML = `
    <div class="wrap">
      <div class="eyebrow">Greenwake Island</div>
      <h1>Salty Fin</h1>
      <div class="rule"></div>
      <p>Clear water over a living reef, a harbour that lights up at dusk,
         and something very large moving underneath it. Stop anywhere to drop
         a line and work it.</p>
      <div class="keys">${controls.map((c) => `<span>${c}</span>`).join('')}</div>
      ${backend ? `<div class="backend">Renderer &mdash; ${backend === 'webgpu' ? 'WebGPU' : 'WebGL'}</div>` : ''}
      <div class="go">${touch ? 'Tap to begin' : 'Click to begin'}</div>
    </div>`;
  document.body.appendChild(el);

  let done = false;
  const dismiss = () => {
    if (done) return;
    done = true;
    el.classList.add('gone');
    setTimeout(() => el.remove(), 600);
    window.removeEventListener('keydown', dismiss);
    window.removeEventListener('pointerdown', dismiss);
    window.removeEventListener('touchstart', dismiss);
  };

  window.addEventListener('keydown', dismiss);
  window.addEventListener('pointerdown', dismiss);
  window.addEventListener('touchstart', dismiss, { passive: true });
  const timer = setTimeout(dismiss, 9000);

  return {
    dismiss,
    dispose() { clearTimeout(timer); dismiss(); style.remove(); },
  };
}
