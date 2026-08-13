// The theme table. A theme is a biome: palettes, what grows on the surface,
// what orbits, and what the place calls itself. `band` is the range of scales
// (log10 of the world's diameter in metres) where the theme can appear, so the
// journey stays physically coherent: meadows up top, cells in the middle,
// quantum foam near the bottom — and below the Planck length, anything goes.
(function () {
  'use strict';
  const TW = (window.TW = window.TW || {});

  const T = {
    meadow: {
      band: [0.5, 8], voice: 'soft',
      palettes: [
        { space: ['#0e1a2f', '#26385e'], nebula: ['#4a7fb5', '#7fb069'], planet: ['#aede7d', '#69b45e', '#3a7449'], accents: ['#f4d35e', '#ef8354', '#f9f5e3', '#c76d9e'], dark: '#2c4a35', glow: '#ffe9a0' },
        { space: ['#1a1430', '#3c2a55'], nebula: ['#8a5fb5', '#e8a0c7'], planet: ['#cede8a', '#8fb45e', '#54744c'], accents: ['#ffb7d9', '#f4d35e', '#f9f5e3', '#9ecfff'], dark: '#3a4a35', glow: '#ffd9f0' },
      ],
      features: [['tree', 3], ['flower', 5], ['grass', 5], ['rock', 1], ['hut', 0.5]],
      creatures: [['butterfly', 2, 4], ['bird', 1, 3]],
      nouns: ['Meadow', 'Vale', 'Prairie', 'Garden', 'Commons', 'Pasture'],
      adjs: ['Whispering', 'Sunlit', 'Gentle', 'Blooming', 'Honeyed', 'Drowsy'],
      flavor: [
        'The grass here practices waving all day, in case someone looks up.',
        'Every flower is convinced it is the tallest thing that has ever lived.',
        'The bees keep maps of the whole world. It fits on one petal.',
      ],
    },
    forest: {
      band: [0.5, 8], voice: 'soft',
      palettes: [
        { space: ['#0a141f', '#153542'], nebula: ['#2c6e5e', '#7fb069'], planet: ['#4e8f66', '#2c5e46', '#1d4034'], accents: ['#8fd694', '#e3f2b5', '#f2c14e', '#a1e8d8'], dark: '#16281f', glow: '#b7ffd8' },
        { space: ['#141020', '#2a2440'], nebula: ['#4a5fb5', '#2c8f6e'], planet: ['#5e9f6e', '#3a6e50', '#254536'], accents: ['#cfe89a', '#8fd6c4', '#e8b45e', '#dff2e3'], dark: '#1c332a', glow: '#cfffdf' },
      ],
      features: [['pine', 5], ['tree', 2], ['mushroom', 1.5], ['rock', 1], ['grass', 2]],
      creatures: [['firefly', 4, 7], ['bird', 1, 2]],
      nouns: ['Forest', 'Grove', 'Thicket', 'Wildwood', 'Hollow', 'Understory'],
      adjs: ['Deep', 'Mossy', 'Sleeping', 'Ancient', 'Murmuring', 'Evergreen'],
      flavor: [
        'The trees trade rumours through their roots. Most are about you.',
        'It is always almost-evening here, which the owls find convenient.',
        'Somewhere in this forest is a clearing no one has ever needed.',
      ],
    },
    desert: {
      band: [0, 8], voice: 'hard',
      palettes: [
        { space: ['#160f1e', '#43263a'], nebula: ['#b5654a', '#e8a05f'], planet: ['#eec98a', '#cf9354', '#96603a'], accents: ['#7da87b', '#e86f51', '#f9ead0', '#b4552d'], dark: '#6e4226', glow: '#ffcf87' },
        { space: ['#100c1c', '#2c1c44'], nebula: ['#8a4a7f', '#cf7a54'], planet: ['#e8b490', '#b57a5e', '#7a4a3c'], accents: ['#9ecf8a', '#f2c14e', '#ffe9d0', '#d86f51'], dark: '#5e3a2c', glow: '#ffd9a0' },
      ],
      features: [['cactus', 4], ['rock', 3], ['grass', 1], ['spike', 0.6], ['hut', 0.4]],
      creatures: [['wisp', 2, 4], ['bird', 0, 2]],
      nouns: ['Desert', 'Dune Sea', 'Waste', 'Expanse', 'Flats', 'Badlands'],
      adjs: ['Patient', 'Singing', 'Amber', 'Shimmering', 'Bone-Dry', 'Endless'],
      flavor: [
        'Each grain of sand remembers being a mountain. None of them are bitter.',
        'The wind comes through twice a day to rearrange everything, gently.',
        'The cacti have been holding the same pose for nine hundred years.',
      ],
    },
    ocean: {
      band: [-1, 8], voice: 'fluid',
      palettes: [
        { space: ['#061223', '#0d2c4a'], nebula: ['#2c6e9e', '#4acfcf'], planet: ['#54b4d4', '#2d7bab', '#1c4f7c'], accents: ['#ff8b6b', '#ffd97a', '#9ff0e0', '#e86fa0'], dark: '#143c5e', glow: '#9ff0ff' },
        { space: ['#0a0f2a', '#1c2c5e'], nebula: ['#4a5fcf', '#2c9e8f'], planet: ['#4a9ec4', '#2c6e9e', '#1a3f6e'], accents: ['#ffb76b', '#ff8fa0', '#a0ffe8', '#ffe97a'], dark: '#12365a', glow: '#a0e8ff' },
      ],
      features: [['coral', 4], ['kelp', 4], ['rock', 1.5]],
      creatures: [['fish', 3, 6], ['bubble', 3, 5]],
      nouns: ['Reef', 'Shallows', 'Sea', 'Lagoon', 'Tidepool', 'Deep'],
      adjs: ['Glittering', 'Drowned', 'Rolling', 'Salt-Sweet', 'Moonpulled', 'Quiet'],
      flavor: [
        'The fish here school into shapes they saw once in a dream.',
        'Every seventh wave is just showing off.',
        'The coral builds cathedrals and charges no admission.',
      ],
    },
    ice: {
      band: [-1, 8], voice: 'fluid',
      palettes: [
        { space: ['#0a1026', '#1c2c4e'], nebula: ['#4a7fb5', '#8fe8d8'], planet: ['#e4f2fb', '#a8cbe8', '#6f92c4'], accents: ['#ffffff', '#bfe8ff', '#8fb5ff', '#e8f4ff'], dark: '#4a6e9e', glow: '#cfeaff' },
        { space: ['#0c0a20', '#242046'], nebula: ['#6f5fb5', '#4acfcf'], planet: ['#d4e4f4', '#94b4dc', '#5e7ab0'], accents: ['#e8f4ff', '#a0d8ff', '#cfb5ff', '#ffffff'], dark: '#3e5a8a', glow: '#dfe8ff' },
      ],
      features: [['shard', 4], ['pine', 2], ['rock', 2]],
      creatures: [['flake', 4, 7], ['bird', 0, 1]],
      nouns: ['Glacier', 'Tundra', 'Frost', 'Floe', 'Snowfield', 'Stillness'],
      adjs: ['Silent', 'Pale', 'Glassy', 'Northern', 'Sleeping', 'Diamond'],
      flavor: [
        'Sound freezes here too. Spring is deafening.',
        'The ice keeps every footprint ever made, filed by softness.',
        'The auroras rehearse over this world when the big skies are booked.',
      ],
    },
    volcano: {
      band: [-1, 8], voice: 'hard',
      palettes: [
        { space: ['#140a0e', '#331017'], nebula: ['#8a2c2c', '#e86f39'], planet: ['#54383e', '#33222b', '#1e141e'], accents: ['#ff7b39', '#ffb347', '#ff4f4f', '#ffd9a0'], dark: '#241318', glow: '#ff9d5c' },
        { space: ['#100a16', '#2c1024'], nebula: ['#b53a5e', '#ff8f4f'], planet: ['#4a3244', '#2e1f30', '#1a1220'], accents: ['#ff5f6b', '#ff9d47', '#ffdf8f', '#e83a5a'], dark: '#20101c', glow: '#ff7f7f' },
      ],
      features: [['spike', 4], ['rock', 3], ['crystal', 1]],
      creatures: [['ember', 4, 8], ['wisp', 1, 2]],
      nouns: ['Caldera', 'Forge', 'Furnace', 'Cinderland', 'Vent', 'Emberfield'],
      adjs: ['Smouldering', 'Red-Hearted', 'Restless', 'Glowering', 'Molten', 'Char-Black'],
      flavor: [
        'The ground here purrs. Loudly. It likes visitors.',
        'Every stone is a former firework, in comfortable retirement.',
        'The embers rise all night, trying to get back to the sky.',
      ],
    },
    mushroom: {
      band: [-3, 5], voice: 'soft',
      palettes: [
        { space: ['#150f26', '#2c1c44'], nebula: ['#8a4fb5', '#4acf9e'], planet: ['#8a6fae', '#5a4478', '#382a52'], accents: ['#ff9ecf', '#8fe8d8', '#ffe9a0', '#c78fff'], dark: '#2e2044', glow: '#ff9ecf' },
        { space: ['#0f1420', '#1e3040'], nebula: ['#2c8f8f', '#8a5fb5'], planet: ['#5e7a9e', '#40546e', '#283446'], accents: ['#8fffd8', '#ffcf8f', '#ff9ecf', '#cfe8ff'], dark: '#243040', glow: '#a0ffe0' },
      ],
      features: [['mushroom', 6], ['grass', 2], ['flower', 1]],
      creatures: [['spore', 4, 7], ['firefly', 2, 4]],
      nouns: ['Sporewood', 'Mycelium', 'Cap Country', 'Fungal Court', 'Gilllands'],
      adjs: ['Luminous', 'Spotted', 'Velvet', 'Damp', 'Dreaming', 'Umbrella'],
      flavor: [
        'Everything here is one organism, and it is delighted to meet you.',
        'The mushrooms glow brighter when you say something kind.',
        'Spores drift up like slow applause.',
      ],
    },
    crystal: {
      band: [-7, 4], voice: 'techy',
      palettes: [
        { space: ['#0c0c1e', '#1c1440'], nebula: ['#4a3ab5', '#cf4a9e'], planet: ['#4a4682', '#2e2c5e', '#1c1a3c'], accents: ['#8ff0ff', '#ff8fe8', '#a0ffcf', '#fff3a0'], dark: '#222050', glow: '#a0f0ff' },
        { space: ['#140a1c', '#301446'], nebula: ['#b53a8f', '#4a8fcf'], planet: ['#5e3a74', '#3e2652', '#241634'], accents: ['#ffb7f0', '#8fd8ff', '#e8ffa0', '#ff8fb7'], dark: '#301c44', glow: '#ffb7f0' },
      ],
      features: [['crystal', 6], ['shard', 2], ['rock', 1]],
      creatures: [['wisp', 2, 4], ['firefly', 2, 3]],
      nouns: ['Geode', 'Prismfield', 'Latticelands', 'Facet Sea', 'Shardgarden'],
      adjs: ['Refracted', 'Chiming', 'Six-Sided', 'Glinting', 'Hollow', 'Resonant'],
      flavor: [
        'Light comes here to be taken apart and reassembled wrong, beautifully.',
        'Tap any crystal and the whole world hums the same perfect note.',
        'The facets have been growing toward something for a million years.',
      ],
    },
    dew: {
      band: [-4, 1.5], voice: 'soft',
      palettes: [
        { space: ['#0d1f16', '#1c3c2c'], nebula: ['#2c8f5e', '#8fd8a0'], planet: ['#66bf7a', '#3d8a54', '#2a5e3e'], accents: ['#dfffe8', '#bfe8ff', '#fff3a0', '#ffb7d9'], dark: '#1e4430', glow: '#dfffef' },
        { space: ['#101c22', '#20404a'], nebula: ['#2c8f9e', '#a0d88f'], planet: ['#74c48f', '#4a9468', '#2f6448'], accents: ['#e8fff0', '#a0e8ff', '#ffe9b7', '#cfa0ff'], dark: '#224838', glow: '#cffff0' },
      ],
      features: [['grass', 6], ['droplet', 4], ['flower', 2]],
      creatures: [['bubble', 2, 4], ['butterfly', 1, 3]],
      nouns: ['Dewfield', 'Blade Forest', 'Morning', 'Droplet Grove', 'Greenshade'],
      adjs: ['Glistening', 'Early', 'Trembling', 'Freshly-Watered', 'Miniature', 'Soft'],
      flavor: [
        'To the dwellers here, a single dewdrop is an inland sea.',
        'Each blade of grass is a skyscraper with excellent views.',
        'It rained once, generations ago. They still talk about it.',
      ],
    },
    microbe: {
      band: [-7.5, -2.5], voice: 'fluid',
      palettes: [
        { space: ['#0c1a1c', '#1e3c38'], nebula: ['#2c8f6e', '#8fcf4a'], planet: ['#84c496', '#4e8f6e', '#2f5f4c'], accents: ['#c7f0a0', '#8fd8c7', '#f0e8a0', '#d8a0f0'], dark: '#2a5244', glow: '#c7ffa0' },
        { space: ['#141c0c', '#32401c'], nebula: ['#8fb52c', '#4acf9e'], planet: ['#a4c47a', '#6e944e', '#465f30'], accents: ['#e8ffa0', '#a0f0d8', '#ffd8a0', '#cfa0e8'], dark: '#3a4c28', glow: '#e0ffb0' },
      ],
      features: [['blob', 4], ['kelp', 2], ['droplet', 2]],
      creatures: [['ciliate', 3, 6], ['bubble', 2, 4]],
      nouns: ['Pond Drop', 'Culture', 'Broth', 'Wriggling Commons', 'Slide'],
      adjs: ['Squirming', 'Single-Celled', 'Busy', 'Translucent', 'Teeming', 'Jolly'],
      flavor: [
        'Everyone here reproduces by waving goodbye to half of themselves.',
        'The paramecia commute in circles and consider it a rich full life.',
        'This entire civilisation fits under a fingernail, comfortably.',
      ],
    },
    cell: {
      band: [-9.5, -4.5], voice: 'fluid',
      palettes: [
        { space: ['#1c0f1a', '#3a1c34'], nebula: ['#b53a6e', '#e88fa0'], planet: ['#cf7f9e', '#9e4a70', '#6e2f52'], accents: ['#ffb7cf', '#ffe8a0', '#8fd8ff', '#c78fff'], dark: '#5e2844', glow: '#ffb7cf' },
        { space: ['#160f22', '#2e1c44'], nebula: ['#6f3ab5', '#e86f9e'], planet: ['#b06f9e', '#7c4478', '#4e2a52'], accents: ['#ff9ecf', '#a0e8d8', '#ffe9a0', '#a0b7ff'], dark: '#442050', glow: '#ff9ee0' },
      ],
      features: [['blob', 6], ['spike', 2], ['droplet', 1]],
      creatures: [['ciliate', 2, 4], ['spore', 3, 5]],
      nouns: ['Cytoplasm', 'Organelle Garden', 'Nucleus District', 'Membrane', 'Vesicle'],
      adjs: ['Mitochondrial', 'Warm', 'Dividing', 'Jellied', 'Industrious', 'Plump'],
      flavor: [
        'The mitochondria is the powerhouse of this entire world. It knows.',
        'Proteins fold themselves here, origami with a deadline.',
        'The nucleus keeps the recipe for everything, including you, probably.',
      ],
    },
    molecule: {
      band: [-13, -8], voice: 'techy',
      palettes: [
        { space: ['#0c141c', '#16283c'], nebula: ['#2c6e9e', '#8f4acf'], planet: ['#547aa0', '#33506e', '#20344c'], accents: ['#8fd8ff', '#ffe8a0', '#ff8f8f', '#a0ffc7'], dark: '#243c54', glow: '#8fd8ff' },
        { space: ['#101020', '#242444'], nebula: ['#4a4acf', '#2c9e8f'], planet: ['#6a6aa0', '#46466e', '#2c2c48'], accents: ['#a0cfff', '#ffcf8f', '#8fffd8', '#ff9eb7'], dark: '#30304e', glow: '#b0cfff' },
      ],
      features: [['crystal', 3], ['spike', 3], ['shard', 2]],
      creatures: [['electron', 2, 4], ['wisp', 2, 3]],
      nouns: ['Bond', 'Lattice', 'Ring', 'Chain', 'Polymer Plain', 'Isomer'],
      adjs: ['Covalent', 'Spinning', 'Symmetric', 'Sticky', 'Aromatic', 'Perfectly-Ordered'],
      flavor: [
        'Everything here is holding hands with everything else, permanently.',
        'The bonds hum at frequencies only chemists pretend to hear.',
        'Twice a second, the whole world flexes and calls it breathing.',
      ],
    },
    atom: {
      band: [-17, -9.5], voice: 'techy',
      palettes: [
        { space: ['#080814', '#141430'], nebula: ['#2c4a9e', '#cf8f2c'], planet: ['#ffc46b', '#e8873c', '#a0522c'], accents: ['#8fd8ff', '#ff8fe8', '#ffffff', '#ffe8a0'], dark: '#8a4a24', glow: '#ffd88f' },
        { space: ['#0a0818', '#1c1438'], nebula: ['#6f2ccf', '#2c9ecf'], planet: ['#7fd8ff', '#3c9ee8', '#2456a0'], accents: ['#ffe8a0', '#ff9ecf', '#ffffff', '#a0ffe8'], dark: '#1c4a7c', glow: '#a0e8ff' },
      ],
      features: [['spike', 2], ['crystal', 2]],
      creatures: [['electron', 4, 8], ['wisp', 1, 2]],
      nouns: ['Nucleus', 'Shell', 'Orbital', 'Valence', 'Isotope', 'Charge'],
      adjs: ['Excited', 'Unstable', 'Positively-Charmed', 'Spinning', 'Half-Full', 'Noble'],
      flavor: [
        'The electrons are everywhere at once and still manage to look busy.',
        'This world is 99.9999% empty space. The decorating is minimalist.',
        'Physicists said this was the bottom, once. Keep going.',
      ],
    },
    quantum: {
      band: [-36, -15], voice: 'whisper',
      palettes: [
        { space: ['#050510', '#12102a'], nebula: ['#4a2c9e', '#2c9e8f'], planet: ['#463282', '#2e1f5e', '#1a1238'], accents: ['#8fffe8', '#ff8fff', '#8f8fff', '#ffff8f'], dark: '#241a4a', glow: '#c7a0ff' },
        { space: ['#080510', '#180f2e'], nebula: ['#8f2c8f', '#2c8fcf'], planet: ['#38386e', '#242450', '#141432'], accents: ['#a0ffff', '#ffa0e8', '#cfcfff', '#e8ffa0'], dark: '#1e1e44', glow: '#a0cfff' },
      ],
      features: [['blob', 3], ['spike', 2], ['crystal', 2], ['eye', 0.6]],
      creatures: [['wisp', 3, 6], ['firefly', 3, 5]],
      nouns: ['Foam', 'Probability', 'Superposition', 'Fluctuation', 'Uncertainty', 'Field'],
      adjs: ['Undecided', 'Flickering', 'Entangled', 'Borrowed', 'Virtual', 'Maybe'],
      flavor: [
        'This world exists mainly when observed. Thank you for your service.',
        'Particles borrow energy here and always, always pay it back.',
        'Nothing is anywhere exactly, and everyone has made peace with it.',
      ],
    },
    dream: {
      band: [-9999, -24], voice: 'whisper',
      palettes: [
        { space: ['#1a1028', '#34204e'], nebula: ['#8f4a9e', '#e8a06f'], planet: ['#e8aacb', '#b77aa8', '#7a5488'], accents: ['#fff3cf', '#a0e8ff', '#ffb7a0', '#d8cfff'], dark: '#6e4470', glow: '#ffd9f0' },
        { space: ['#100f2a', '#2c2050'], nebula: ['#4a6fcf', '#cf8fa0'], planet: ['#a0a0d8', '#7070ae', '#48487c'], accents: ['#ffe8cf', '#cfa0ff', '#a0ffd8', '#ffcfe8'], dark: '#4c4c84', glow: '#e0d0ff' },
      ],
      features: [['door', 2], ['eye', 1.5], ['candle', 2], ['flower', 2], ['mushroom', 1]],
      creatures: [['wisp', 2, 4], ['butterfly', 2, 4]],
      nouns: ['Dream', 'Lullaby', 'Reverie', 'Half-Thought', 'Sleep', 'Wish'],
      adjs: ['Half-Remembered', 'Impossible', 'Familiar', 'Backwards', 'Tender', 'Unfinished'],
      flavor: [
        'You are below physics now. The worlds here are made of maybes.',
        'The doors lead to rooms that miss you.',
        'Someone dreamed this place and forgot it. It kept going anyway.',
      ],
    },
    echo: {
      band: [-9999, -30], voice: 'whisper',
      palettes: [
        { space: ['#0a0f14', '#182028'], nebula: ['#2c4a5e', '#5e7a8f'], planet: ['#687a86', '#42525e', '#2a3640'], accents: ['#a0c7d8', '#d8e8f0', '#8fa0b7', '#e8f0d8'], dark: '#303e48', glow: '#cfe8f0' },
        { space: ['#0f0c14', '#201c2c'], nebula: ['#4a3a5e', '#8f8fa0'], planet: ['#7a7086', '#524a5e', '#342e40'], accents: ['#cfc7d8', '#e8e0f0', '#a0a0b7', '#f0e8d8'], dark: '#3c3448', glow: '#e0e0f0' },
      ],
      features: [['door', 1], ['rock', 3], ['spike', 2], ['candle', 1]],
      creatures: [['wisp', 3, 5], ['spore', 2, 4]],
      nouns: ['Echo', 'Afterthought', 'Remainder', 'Margin', 'Pause', 'Footnote'],
      adjs: ['Faded', 'Patient', 'Grey-Lit', 'Almost-Silent', 'Leftover', 'Barely'],
      flavor: [
        'This is what is left when a world finishes happening.',
        'Speak softly. The echoes here are older than the sounds.',
        'Even the light arrives second-hand, and grateful.',
      ],
    },
  };

  // Pick a theme legal at this scale, avoiding an immediate repeat.
  // Below the Planck length the physical ladder has run out, so every biome
  // is fair game again — a sunlit meadow at 10^-73 m is exactly the kind of
  // thing that should be down there.
  function pickThemeKey(rng, logSize, excludeKey) {
    let keys = Object.keys(T).filter((k) => {
      const b = T[k].band;
      return logSize >= b[0] && logSize <= b[1];
    });
    if (logSize < -36) keys = Object.keys(T);
    if (keys.length > 1 && excludeKey) keys = keys.filter((k) => k !== excludeKey);
    if (!keys.length) keys = Object.keys(T);
    return rng.pick(keys);
  }

  TW.THEMES = T;
  TW.pickThemeKey = pickThemeKey;
})();
