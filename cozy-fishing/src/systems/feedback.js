// DOM feedback: the toast, the hint, the tally, the "!" over the bobber.
// All text, no canvas — cheap to restyle, easy to localize later.

const el = (id) => document.getElementById(id);

export function createFeedback() {
  const toast = el('toast');
  const toastName = el('toast-name');
  const toastSub = el('toast-sub');
  const hint = el('hint');
  const tally = el('tally');
  const bang = el('bang');
  const mute = el('mute');
  let toastTimer = 0;

  return {
    toast(text, sub = '', stars = '') {
      toastName.innerHTML = stars
        ? `${text}<span class="stars">${stars}</span>` : text;
      toastSub.textContent = sub;
      toastSub.hidden = !sub;
      toast.hidden = false;
      requestAnimationFrame(() => toast.classList.add('show'));
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toast.classList.remove('show'), 3000);
    },

    hint(show) { hint.classList.toggle('gone', !show); },

    tally(n) {
      tally.hidden = false;
      tally.textContent = `🐟 × ${n}`;
    },

    bang(show) { bang.hidden = !show; },

    // Project a world position and pin the "!" just above it.
    bangAt(worldPos, camera) {
      const v = worldPos.clone();
      v.y += 0.35;
      v.project(camera);
      if (v.z > 1) { bang.hidden = true; return; }
      bang.style.left = `${((v.x + 1) / 2) * innerWidth}px`;
      bang.style.top = `${((1 - (v.y + 1) / 2)) * innerHeight}px`;
    },

    onMute(cb) {
      mute.addEventListener('click', () => {
        const muted = cb();
        mute.classList.toggle('muted', muted);
      });
    },
  };
}
