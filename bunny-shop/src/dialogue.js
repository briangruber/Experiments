// Everything the rabbits say.
//
// Lines are drawn without repeats until a bank is exhausted, which matters more
// than the size of the bank — the same joke twice in thirty seconds is what
// makes a game like this feel small.

const FIRST = [
  'Bartholomew', 'Deborah', 'Greg', 'Miffy', 'Clementine', 'Kevin', 'Nigel', 'Prudence',
  'Todd', 'Winifred', 'Casper', 'Moira', 'Bernard', 'Tuppence', 'Rodney', 'Agnes',
  'Sir Hops', 'Big Susan', 'Little Susan', 'Doctor Nibbles', 'Janet', 'Horace',
  'Mildred', 'Pip', 'Barnaby', 'Sheila', 'Gordon', 'Nunzio', 'Beatrix', 'Dave',
  'Lady Thistle', 'Young Colin', 'Old Colin', 'Marjorie', 'Fennel', 'Otto',
];

const LAST = [
  'Fluffington', 'Thump', 'Bramblewick', 'the Unemployed', 'Esq.', 'Wigglesworth',
  'Two-Carrots', 'of the Ditch', 'Hazelbottom', 'Jr.', 'the Elder', 'Pockets',
  'Longshanks', 'the Reasonable', 'McTwitch', 'from Accounting',
  'the Third', 'No-Nonsense', 'of No Fixed Burrow', 'Bunbury', 'the Damp',
  'who Owes Me Money', 'Cottontail-Smythe', 'the Ambitious', 'PhD',
];

// Muttered while browsing the shelves. Nothing depends on these; they exist
// purely so the shop floor is never quiet.
const BROWSE = [
  'I could buy a cabbage. I could also lie down.',
  'Everything in here is technically a vegetable.',
  'I have four coins and a dream. The dream is corn.',
  'My therapist said to treat myself. I do not think she meant this.',
  'If I buy nine radishes, am I a radish person?',
  'That muffin has been looking at me.',
  'I am not going to think about the fox thing right now.',
  'Do carrots know?',
  'Just browsing. I am always just browsing.',
  'Big day today. Enormous. I am buying produce.',
  'I told everyone I was going to the gym.',
  'Back again. Fourth time. Nobody say anything.',
  'A strawberry is just a very confident radish.',
  'I am going to make a soup and it is going to change things.',
  'They have rearranged the shelves. I have no idea who I am.',
  'One of these is going to fix my life.',
  'I am allowed to be here. I have money and everything.',
  'Ooh. Oh no. Ooh.',
  'My cousin runs a shop like this. His is worse. Do not tell him I said better.',
  'Should I get the muffin? Yes. Was that a question? No.',
  'I have been standing here for some time and I regret none of it.',
  'What if I bought all of it. What then.',
  'The corn is judging me. The corn is right.',
  'I am the kind of rabbit who buys cabbage now, apparently.',
  'There are eleven of me at home and none of them can cook.',
  'I dreamt about this shelf. I will not elaborate.',
  'Nothing here is going to solve it, but something here will help.',
  'I am pretending to read the label. There is no label.',
  'Everyone else seems to know what they are doing.',
  'Hold on. Hold on. No. Hold on.',
  'I came in for one thing. I have forgotten the thing.',
  'My burrow has no room for this. Buying it anyway.',
  'Is it weird to be emotional about a radish? Do not answer.',
  'I have decided. I have not decided.',
  'Statistically one of these vegetables is the best one.',
];

// Said on arriving at the counter, before the order itself is read out.
const GREET = [
  'Right. Yes. Hello. Shopping.',
  'Hi! Sorry. Hi.',
  'I know exactly what I want and I will not be talked out of it.',
  'Good afternoon. I have prepared remarks.',
  'Do not judge me for this order.',
  'Hello. I am a normal customer with normal needs.',
  'Big order. Brace yourself. Emotionally.',
  'I am in a rush, but pleasantly.',
  'Hello. I have been rehearsing this in the queue.',
  'Before I begin: no, I do not want a bag. I have brought my mouth.',
  'You look busy. I am about to make that worse.',
  'I would like to place an order and then leave immediately.',
  'Hello! I have money. That is the main thing.',
  'Right, listen. This is going to sound like a lot.',
];

// Wrapped around the item list. `{order}` is replaced with "three carrots and a
// muffin" and so on.
const ORDER = [
  '{order}. My mother-in-law is visiting and I need something to gnaw angrily.',
  '{order}. It is for a friend. I do not have friends.',
  '{order}, please. One of them is a gift. I will not say which.',
  'I need {order}. Do not make it weird.',
  '{order}. I am going through something.',
  '{order}. Yes, all of it. Yes, today.',
  'Just {order}. Famous last words, I know.',
  '{order}, and no follow-up questions.',
  '{order}. My doctor is thrilled. My doctor is a rabbit.',
  '{order}. I am hosting. It is going badly already.',
  '{order} — no, wait. Yes. That. What I said.',
  '{order}, and I would like to be out of here before I think about it more.',
  '{order}. This is a perfectly reasonable amount of food for one rabbit.',
  '{order}. Look me in the eye while you bag it.',
  '{order}. I have costed this out and I cannot afford it.',
  '{order}, in whatever order feels right to you spiritually.',
  '{order}. My nephew is coming. He eats like a horse. He is a rabbit.',
  '{order}. And whatever you would order. No, forget that, {order}.',
  '{order}. I want to be very clear that this is a normal weeknight.',
  '{order}. It has been a long month and it is the fourth.',
  '{order}. Quickly, before the part of me that budgets wakes up.',
  '{order}. Do not weigh it. I do not want to know.',
];

const WRONG = [
  'That is... not that.',
  'Sir. Madam. Shopkeep. No.',
  'We were doing so well.',
  'I want you to look at that, and then look at me.',
  'Bold. Wrong, but bold.',
  'In what world.',
  'I will pretend I did not see that.',
  'That is the opposite of what I said, which is impressive.',
  'Interesting choice. Interesting for you. Bad for me.',
  'Take it back. Take it back gently, but take it back.',
  'I am going to count to one.',
  'Nope. Nope nope nope. Nope.',
  'You have invented a new thing I did not ask for.',
  'Was that a guess? That felt like a guess.',
  'My hearing is excellent. My ears are enormous. You saw them.',
];

const IMPATIENT = [
  'I am being extremely patient, in a visible way.',
  'No rush! There is a rush.',
  'I have somewhere to be. It is a field. But still.',
  'Tapping my foot. Just so we are all aware.',
  'I could have grown these by now.',
  'Hello? Still a rabbit. Still here.',
  'I am not sighing. That was the building.',
  'Time is passing. For both of us. Mostly for me.',
  'I have started composing the review in my head.',
  'Do not worry about me. Worry a normal amount about me.',
  'I have named the muffin. That is how long it has been.',
];

const RAGE = [
  'I am telling the entire warren about this.',
  'One star. It is a nice star. But it is one.',
  'I am going to the shop across the meadow, and they are RUDE there.',
  'Unbelievable. I brought a bag and everything.',
  'Good day. I said GOOD DAY.',
  'I will be writing. At length. In pencil.',
  'I hope your cabbages are fine. I hope they are merely fine.',
  'This is going in my diary and my diary is read aloud on Sundays.',
];

const THANKS = [
  'This is the best thing that has happened to me today, and I got married today.',
  'You have changed me. Mildly.',
  'I will be back in eleven minutes.',
  'Five stars. I do not know what that means, but five of them.',
  'Perfect. Flawless. I am going to eat this in the car park.',
  'You are the only shop that understands me.',
  'I am going to tell people about you. Good things, mostly.',
  'Exactly right. Suspiciously right. Are you a rabbit?',
  'Thank you! I am going to ruin this immediately.',
  'Nailed it. Now I have to go home and be a person.',
  'You did that from memory. I watched you. Incredible.',
  'I feel seen, and I only came in for a radish.',
  'Ten out of ten. I am not going to explain the scale.',
  'I would like to speak to the manager, to compliment you.',
  'That was so smooth I forgot to be anxious.',
];

const THANKS_SLOW = [
  'Thank you. That took a while, but thank you.',
  'Got there in the end. We both did.',
  'Four stars. The missing one is time-related.',
  'I aged during that, but I am pleased with the produce.',
  'Slow, but correct. Like a good pie.',
  'Right. Yes. Lovely. I have missed the bus.',
];

const PET = [
  'oh. OH. okay yes.',
  'This is deeply unprofessional. Continue.',
  'I am going to think about this for weeks.',
  'Do not stop. I mean, do stop, I have things to do. But do not.',
  'Right between the ears. You are a professional.',
  'I came in for a cabbage and I am leaving a changed rabbit.',
  'If you tell anyone about this, I will deny it.',
  '*makes a noise no rabbit has ever admitted to making*',
  'I have forgotten what I was angry about. It was you. Not any more.',
  'Well now I have to be nice to you. Thanks a lot.',
  'This is a food shop. This is not a food service. I am not complaining.',
  'My whole spine did something just then.',
];

// Escalating praise for consecutive flawless orders.
export const STREAK_LINES = {
  3: ['Three in a row', 'The queue has noticed.'],
  5: ['Five clean', 'Someone in the queue is filming you.'],
  8: ['Eight!', 'A rabbit outside just told another rabbit.'],
  12: ['Twelve straight', 'You are a local story now.'],
  16: ['Sixteen', 'There is talk of a plaque. Small. Wooden.'],
  20: ['Twenty', 'The warren has run out of ways to describe you.'],
};

// How a day gets summed up on the banner. Written as functions so the joke can
// use what actually happened.
export const DAY_REVIEWS = [
  (s) => `Reviewed: "Served ${s.served}. Petted ${s.petted}. Priorities unclear."`,
  (s) => (s.lost ? `${s.lost} rabbit${s.lost > 1 ? 's' : ''} left in a huff. They will be back.` : 'Nobody left angry. Suspicious.'),
  (s) => `${s.coins} coins. A rabbit counted them. Out loud. Slowly.`,
  () => 'The bunting held. That is not nothing.',
  (s) => (s.petted > 3 ? 'Word is out that you pet people. The queue is longer now.' : 'Word is out. Rabbits are coming.'),
  () => 'Someone left a review. It was mostly kind.',
  () => 'A rabbit asked if you were hiring. You said no. They start Monday.',
  () => 'The corn is running low. The corn is always running low.',
];

// ---------------------------------------------------------------- specials

// Customers with their own rules and their own bit. `apply` runs when the order
// is paid for and can hand back a bonus.
export const SPECIALS = {
  // Three rabbits, stacked, in a coat. Nobody suspects a thing.
  trenchcoat: {
    weight: 0.08,
    minDay: 2,
    build: 'stack',
    name: () => 'A Normal Adult Rabbit',
    greet: [
      'Hello. I am one rabbit. The usual amount of rabbit.',
      'Good day. I require groceries, as one rabbit.',
      'Do not look at my middle. My middle is fine.',
      'I am of ordinary height for a rabbit of my height.',
    ],
    order: [
      '{order}. That is a normal amount for one rabbit. Do not count it.',
      '{order}. I am very hungry, in the singular.',
      '{order}. It is for me. All of it. Just the one of me.',
      '{order}. We— I. I have a large appetite.',
    ],
    thanks: [
      'Excellent. We— I. I will be going now.',
      'Thank you. This is for me, the one rabbit who I am.',
      'A pleasure. Come on, lads— I mean. Goodbye.',
    ],
    wrong: [
      'That is wrong, and all of me is disappointed.',
      'No. And I speak for myself. Only myself.',
    ],
  },

  // Very small, very slow to anger, tips in buttons.
  tiny: {
    weight: 0.1,
    minDay: 2,
    scale: 0.58,
    patienceScale: 2.2,
    tipScale: 0.25,
    name: () => 'A Very Small Rabbit',
    greet: [
      'hello. i am here for shopping.',
      'excuse me. i am down here. hello.',
      'i have brought my own coin. it is one coin.',
    ],
    order: [
      '{order}. that is the whole order. i planned it.',
      '{order}, please. i can carry it. probably.',
      '{order}. i have thought about this all week.',
    ],
    thanks: [
      'this is the best day. i will remember it always.',
      'thank you!! i am going to run home very fast.',
      'i am going to tell my mum about you.',
    ],
    wrong: ['that is not it. but it is okay. we can try again.', 'oh. hm. no.'],
  },

  // Upside-only pressure: get it perfect and the warren forgives you a mistake.
  inspector: {
    weight: 0.07,
    minDay: 3,
    body: 'bunny_lanky',
    patienceScale: 0.72,
    tipScale: 0,
    name: () => 'Warren Health Inspector',
    greet: [
      'I am not a customer. I am an assessment.',
      'Do not be nervous. Being nervous is noted.',
      'Good day. This is unannounced, which is the point.',
    ],
    order: [
      'I will require {order}. This is a test and I am telling you that.',
      '{order}. Bag it as though someone were watching, because someone is.',
      '{order}. Take your time. I am timing you.',
    ],
    thanks: [
      'Satisfactory. That is the highest grade. I do not give it often.',
      'Clean, correct, quick. The warren will hear of it. Favourably.',
      'I came here to find a problem. I have failed. Well done.',
    ],
    wrong: [
      'Noted. Written down. Underlined.',
      'That is going in the report, and the report has a cover.',
      'I have a pencil and I am not afraid to lick it.',
    ],
    // A flawless inspection buys back a heart.
    reward: { hearts: 1, banner: ['Passed', 'The inspector found nothing. A star returns.'] },
    failLine: 'I will be back. Unannounced. Again. That is the whole job.',
  },
};

// ---------------------------------------------------------------- drawing

// A bank you can draw from without repeats; it reshuffles once emptied.
function deck(items) {
  let pool = [];
  return () => {
    if (!pool.length) pool = shuffle([...items]);
    return pool.pop();
  };
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export const pick = (a) => a[Math.floor(Math.random() * a.length)];

export const say = {
  browse: deck(BROWSE),
  greet: deck(GREET),
  order: deck(ORDER),
  wrong: deck(WRONG),
  impatient: deck(IMPATIENT),
  rage: deck(RAGE),
  thanks: deck(THANKS),
  pet: deck(PET),
};

const nameDeck = deck(FIRST);
export function bunnyName() {
  const first = nameDeck();
  return Math.random() < 0.55 ? `${first} ${pick(LAST)}` : first;
}

// "three carrots, a muffin and two radishes"
const WORDS = ['no', 'a', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];

export function describeOrder(items, stockById) {
  const parts = items.map(({ id, count }) => {
    const s = stockById[id];
    const noun = count === 1 ? s.label.toLowerCase() : s.plural.toLowerCase();
    return `${WORDS[count] ?? count} ${noun}`;
  });
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

// The one-line review that pops when an order is paid for.
export function review(stars) {
  if (stars >= 5) return pick(THANKS);
  if (stars >= 4) return pick(THANKS_SLOW);
  return pick([
    'Fine. It is fine. I said what I said.',
    'I have had better. I have had worse. I have had better though.',
    'Three stars, and one of those is for the bunting.',
  ]);
}
