// What makes a rendered voice clip current. A clip is a pure function of the
// Spanish text, the voice it was cast with, and the delivery settings sent to
// the API — nothing else in dialogue.js changes the sound. Moving a cue,
// re-homing it to another scene or rewording the English caption costs
// nothing; touching one word of Spanish, or recasting a voice, re-records
// exactly the lines it changed.
//
// The pipeline stores this hash in a sidecar next to each mp3
// (voice/<id>.mp3.hash, committed with the clip), and treats a clip as stale
// only when the sidecar is missing or no longer matches. voices.mjs writes the
// sidecar whenever it records, so the two can only disagree when the script
// really did change out from under a recording.

import { createHash } from 'node:crypto';

// The exact voice_settings voices.mjs sends, built in one place so the
// recorder and the staleness check cannot drift apart. If one of the constants
// below ever changes, every hash changes with it, and every clip correctly
// reads as stale — which is the truth: the API would render them differently.
export function voiceSettings(v) {
  return {
    stability: v.stability,
    similarity_boost: 0.75,
    style: v.style,
    use_speaker_boost: true,
    speed: v.speed,
  };
}

export function lineHash(line, VOICES) {
  const v = VOICES[line.who];
  if (!v) throw new Error(`${line.id}: no voice cast for "${line.who}"`);
  return createHash('sha256')
    .update(line.es + v.voice + JSON.stringify(voiceSettings(v)))
    .digest('hex');
}
