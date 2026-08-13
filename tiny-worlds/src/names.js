// Name generation. Each theme picks a "voice": worlds near the surface sound
// pastoral, the quantum ones sound like lab equipment, the post-Planck ones
// barely sound like anything at all.
(function () {
  'use strict';
  const TW = (window.TW = window.TW || {});

  const VOICES = {
    soft: {
      onset: ['m', 'l', 'n', 'w', 'f', 's', 'br', 'th', 'el', 'v', 'r'],
      vowel: ['a', 'e', 'i', 'o', 'ee', 'ia', 'oo', 'ae'],
      coda: ['n', 'l', 'm', 'wen', 'lin', 'mer', 'ry', 'della', 'th', ''],
    },
    hard: {
      onset: ['k', 'g', 'dr', 'br', 'z', 't', 'kr', 'v', 'gr', 'sk'],
      vowel: ['a', 'o', 'u', 'ar', 'or', 'au'],
      coda: ['k', 'g', 'rn', 'x', 'th', 'gar', 'dun', 'rok', ''],
    },
    fluid: {
      onset: ['s', 'sh', 'm', 'n', 'l', 'pl', 'gl', 'y', 'w'],
      vowel: ['a', 'e', 'o', 'u', 'oa', 'ei', 'ou', 'ua'],
      coda: ['l', 'n', 'sh', 'mar', 'lune', 'ros', 'ne', ''],
    },
    techy: {
      onset: ['x', 'z', 'q', 'v', 'k', 'ps', 'tr', 'n'],
      vowel: ['a', 'e', 'i', 'o', 'y', 'io', 'ei'],
      coda: ['x', 'n', 'r', 'on', 'ium', 'on', 'ex', ''],
    },
    whisper: {
      onset: ['h', 'wh', 'sh', 's', 'f', 'th', '', 'l'],
      vowel: ['u', 'o', 'a', 'oo', 'uu', 'ah', 'eh'],
      coda: ['sh', 'h', 'm', 'hm', 'sso', '', ''],
    },
  };

  function makeName(rng, voice) {
    const v = VOICES[voice] || VOICES.soft;
    const syllables = rng.int(2, 3);
    let name = '';
    for (let i = 0; i < syllables; i++) {
      name += rng.pick(v.onset) + rng.pick(v.vowel);
    }
    name += rng.pick(v.coda);
    name = name.charAt(0).toUpperCase() + name.slice(1);
    if (voice === 'techy' && rng.chance(0.4)) name += '-' + rng.int(2, 99);
    if (voice === 'whisper' && rng.chance(0.3)) name = name.toLowerCase();
    return name;
  }

  TW.makeName = makeName;
})();
