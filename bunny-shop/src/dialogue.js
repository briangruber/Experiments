// Everything the rabbits say.
//
// Lines are drawn without repeats until a bank is exhausted, which matters more
// than the size of the bank — the same joke twice in thirty seconds is what
// makes a game like this feel small.

const FIRST = [
  'Bartholomew', 'Deborah', 'Greg', 'Miffy', 'Clementine', 'Kevin', 'Nigel', 'Prudence',
  'Todd', 'Winifred', 'Casper', 'Moira', 'Bernard', 'Tuppence', 'Rodney', 'Agnes',
  'Sir Hops', 'Big Susan', 'Little Susan', 'Doctor Nibbles', 'Janet', 'Horace',
];

const LAST = [
  'Fluffington', 'Thump', 'Bramblewick', 'the Unemployed', 'Esq.', 'Wigglesworth',
  'Two-Carrots', 'of the Ditch', 'Hazelbottom', 'Jr.', 'the Elder', 'Pockets',
  'Longshanks', 'the Reasonable', 'McTwitch', 'from Accounting',
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
];

const IMPATIENT = [
  'I am being extremely patient, in a visible way.',
  'No rush! There is a rush.',
  'I have somewhere to be. It is a field. But still.',
  'Tapping my foot. Just so we are all aware.',
  'I could have grown these by now.',
  'Hello? Still a rabbit. Still here.',
];

const RAGE = [
  'I am telling the entire warren about this.',
  'One star. It is a nice star. But it is one.',
  'I am going to the shop across the meadow, and they are RUDE there.',
  'Unbelievable. I brought a bag and everything.',
  'Good day. I said GOOD DAY.',
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
];

const THANKS_SLOW = [
  'Thank you. That took a while, but thank you.',
  'Got there in the end. We both did.',
  'Four stars. The missing one is time-related.',
  'I aged during that, but I am pleased with the produce.',
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
];

// Special customers, each with their own bit.
export const SPECIALS = {
  trenchcoat: {
    weight: 0.1,
    minDay: 2,
    name: () => 'A Normal Adult Rabbit',
    greet: [
      'Hello. I am one rabbit. The usual amount of rabbit.',
      'Good day. I require groceries, as one rabbit.',
      'Do not look at my middle. My middle is fine.',
    ],
    order: [
      '{order}. That is a normal amount for one rabbit. Do not count it.',
      '{order}. I am very hungry, in the singular.',
      '{order}. It is for me. All of it. Just the one of me.',
    ],
    thanks: [
      'Excellent. We— I. I will be going now.',
      'Thank you. This is for me, the one rabbit who I am.',
      'A pleasure. Come on, lads— I mean. Goodbye.',
    ],
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
const WORDS = ['no', 'a', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];

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
  return pick(['Fine. It is fine. I said what I said.', 'I have had better. I have had worse. I have had better though.']);
}
