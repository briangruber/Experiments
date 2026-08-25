// Subtitles. The cast speaks Spanish; these are the translation, and they are
// on screen for exactly as long as the line takes to say — the durations come
// from tools/voices.mjs measuring the rendered audio, not from a guess.
//
// The script itself lives in dialogue.js. This is only the wiring: one cue per
// line that starts the voice, opens the speaker's beak, and puts the English
// on screen, all on the same frame.

import { LINES, SPEAKERS } from './dialogue.js';
import { TIMING } from './dialogue-timing.js';

// A line with no measured clip still gets a subtitle — reading time by word
// count, roughly a slow speaking pace — so a missing recording degrades to the
// silent version rather than to nothing.
function fallbackDur(text) {
  return Math.max(1.4, Math.min(5, text.split(/\s+/).length * 0.42));
}

export const SUBTITLES = LINES.map((l) => ({
  scene: l.scene,
  at: l.at,
  text: l.en,
  dur: TIMING[l.id] ? TIMING[l.id].dur : fallbackDur(l.en),
  clip: l.id,
  who: l.who,
  speaker: SPEAKERS[l.who] || null,
  env: TIMING[l.id] ? TIMING[l.id].env : '',
}));

// Turn the script into cues the director can splice into its scenes, keyed by
// scene id. A subtitle is a single slot: showing one dismisses whatever was on
// screen, so a fast volley of reactions reads as a volley rather than a stack.
export function subtitleCues(sceneId) {
  return SUBTITLES.filter((s) => s.scene === sceneId).map((s) => [
    s.at,
    (c) => {
      c.titles.subtitle(s.text, s.dur, { speaker: s.speaker, narration: !s.speaker });
      c.score.say(s.clip);
      // The narrator has no beak. Everyone else does.
      const actor = c.actors[s.who];
      if (actor && s.env) actor.speak(s.env, s.dur);
    },
  ]);
}
