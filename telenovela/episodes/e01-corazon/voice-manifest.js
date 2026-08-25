// This episode's voice track: every spoken line, named by the dialogue script
// and recorded by tools/voices.mjs into voice/ next to this file. Paths are
// relative to index.html at the project root, same as the library manifest.

import { LINES } from './dialogue.js';

export const VOICE = Object.fromEntries(
  LINES.map((l) => [l.id, `./episodes/e01-corazon/voice/${l.id}.mp3`]),
);
