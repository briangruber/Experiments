// Everything this episode can play: the shared sound library plus its own
// voice track, in one map. This is the module the Soundtrack loads from, and
// the one the bundler swaps for a generated version holding base64 data URIs
// so the single-file build carries its own audio.

import { LIBRARY } from '../../company/library/manifest.js';
import { VOICE } from './voice-manifest.js';

export const AUDIO = { ...LIBRARY, ...VOICE };
export const AUDIO_NAMES = Object.keys(AUDIO);
