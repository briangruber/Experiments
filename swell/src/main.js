import { createApp } from './app.js';
import { buildUI } from './ui.js';

const canvas = document.getElementById('view');
const panel = document.getElementById('panel');
const hud = document.getElementById('hud');
const toggle = document.getElementById('toggle');

const params = new URLSearchParams(location.search);
const headless = params.has('headless');

const app = createApp(canvas, {
  scene: params.get('scene') || undefined,
  controls: !headless,
});

// The harness API. Everything the capture and evaluation tools drive lives
// here, so a fixture render never depends on the UI existing.
window.__swell = app;
window.__swellReady = false;

function fit() {
  const w = Math.max(1, Math.round(window.innerWidth));
  const h = Math.max(1, Math.round(window.innerHeight));
  app.setSize(w, h);
}
window.addEventListener('resize', fit);
fit();

if (headless) {
  panel.style.display = 'none';
  toggle.style.display = 'none';
  hud.style.display = 'none';
  app.renderFrame();
} else {
  const ui = buildUI(app, panel, hud);
  toggle.onclick = () => {
    panel.classList.toggle('hidden');
    toggle.classList.toggle('shifted');
  };
  // Exposed so a harness (or a debugging session) can stop the animation and
  // hold a frame still. Under a software rasteriser a 2 s frame otherwise
  // occupies the main thread permanently and nothing else can happen.
  window.__swellStop = app.startLoop(() => ui.updateHud());
}

window.__swellReady = true;
