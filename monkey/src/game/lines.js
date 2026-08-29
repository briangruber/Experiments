// The voiced script, as a table.
//
// Pulling the dialogue out of the choreography is what makes voice recording
// possible at all. A line needs a stable id so the clip on disk can be matched
// to it, a speaker so it can be cast, and text that can change without
// invalidating everything around it. Inline strings have none of those.
//
// It is also the file a writer can work in without reading a line of engine
// code, and the file tools/voices.mjs reads. The same table drives the
// subtitle, the clip filename and the measured duration.

export const VOICE_CAST = {
  // A harbourmaster should sound like the last obstacle before the sea, and a
  // protagonist should sound like she has already decided how this ends.
  // Cast from what the account actually holds — voice ids are per-library, and
  // a hard-coded id from a docs page 404s. `node tools/voices.mjs --voices`
  // lists what is available.
  player: { voice: 'pFZP5JQG7iQjIQuC4Bku', stability: 0.4, style: 0.55, speed: 1.02 },  // Lily, velvety
  grout:  { voice: 'pqHfZKP75CvOlQylNhV4', stability: 0.5, style: 0.35, speed: 0.92 },  // Bill, old and crisp
};

export const LINES = {
  'intro-1': { who: 'player', text: "Evening. I'd like to board that ship." },
  'intro-2': { who: 'grout',  text: "No." },
  'intro-3': { who: 'player', text: "You haven't heard my reasons." },
  'intro-4': { who: 'grout',  text: "I've heard everyone's reasons. Yours will be about destiny." },
  'intro-5': { who: 'player', text: "...It's partly about destiny." },
  'intro-6': { who: 'grout',  text: "It always is." },

  'why-1': { who: 'player', text: "On whose authority?" },
  'why-2': { who: 'grout',  text: "Mine. I'm the harbourmaster." },
  'why-3': { who: 'player', text: "And who appointed the harbourmaster?" },
  'why-4': { who: 'grout',  text: "The previous harbourmaster. Who was me. It was a short meeting." },

  'thirst-1': { who: 'player', text: "You look parched, if I may say so." },
  'thirst-2': { who: 'grout',  text: "Eleven hours on this plank and not a drop." },
  'thirst-3': { who: 'grout',  text: "There's a barrel forty feet that way and I cannot leave my post to reach it." },
  'thirst-4': { who: 'player', text: "That sounds like a design flaw." },
  'thirst-5': { who: 'grout',  text: "It sounds like the job." },

  'offer-1': { who: 'player', text: "Perhaps this would help." },
  'offer-2': { who: 'grout',  text: "...You are a genuinely good person." },
  'offer-3': { who: 'player', text: "I'm really not." },
  'offer-4': { who: 'grout',  text: "Right. That's the — mmh. That's the —" },
  'offer-5': { who: 'player', text: "Sleep well, harbourmaster." },
  'offer-6': { who: 'player', text: "I'll tell them you fought bravely." },

  'bye-1': { who: 'player', text: "Never mind." },
};

// Which lines make up each choice in the tree. Effects (taking the grog,
// putting Grout to sleep) stay in dock.js — this file is words only.
export const EXCHANGES = {
  intro: ['intro-1', 'intro-2', 'intro-3', 'intro-4', 'intro-5', 'intro-6'],
  again: ['intro-1', 'intro-2', 'intro-6'],
  why: ['why-1', 'why-2', 'why-3', 'why-4'],
  thirst: ['thirst-1', 'thirst-2', 'thirst-3', 'thirst-4', 'thirst-5'],
  bye: ['bye-1'],
};
