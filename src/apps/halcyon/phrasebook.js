/*
 * The phrasebook.
 *
 * Nobody on this service can type a sentence at anybody else. You type
 * whatever you like into the box, and what actually travels is the closest
 * phrase from this file — a fixed, hand-written vocabulary. Your
 * keystrokes never leave the machine.
 *
 * That is a stronger guarantee than screening free text, because it is
 * structural rather than a judgement call: the set of things that can be
 * said is finite, is right here, and can be read end to end in a minute.
 * There is no filter to outwit, no spelling to work around, no new slur to
 * add to a list next year.
 *
 * It is also, happily, more period-accurate than free text. Chat in 1997
 * ran on stock phrases — a/s/l, brb my mom needs the phone, any1 wanna
 * chat — and a menu of them is funnier than anything most people would
 * have typed.
 *
 * `tags` exist only to help the matcher find a phrase from words that are
 * not in it. They are never shown and never sent.
 */

const CAT = (id, name, hint, phrases) => ({ id, name, hint, phrases });
const P = (text, tags = '') => ({ text, tags });

export const CATEGORIES = [

  CAT('hello', 'Hello', 'Walking in', [
    P('hi everyone', 'hey hello greetings all room'),
    P('hey room', 'hi hello greetings'),
    P('hello all', 'hi hey greetings'),
    P('sup', 'hi hey whats up wassup yo'),
    P('yo', 'hi hey sup'),
    P('hi :)', 'hello hey smile happy'),
    P('anyone here?', 'hello empty quiet alone anybody'),
    P('is this thing on?', 'hello test quiet empty'),
    P('first time here', 'new newbie hello lost stranger'),
    P('im back', 'return returned again hello brb'),
    P('long time no see', 'hello again missed you'),
    P('hey again', 'hello back returned'),
  ]),

  CAT('asl', 'A/S/L', 'The only question anybody asked', [
    P('a/s/l?', 'age sex location asl ask'),
    P('a/s/l anyone?', 'age sex location asl'),
    P('where is everyone from?', 'location where from place city state'),
    P('what time is it where you are?', 'time zone late early where'),
    P('anyone else up this late?', 'late night awake insomnia tired'),
    P('how did you find this room?', 'how here found came'),
    P('how long have you been online?', 'how long time member new'),
    P('do you come here a lot?', 'often regular frequent here'),
  ]),

  CAT('talk', 'Small Talk', 'The middle of a conversation', [
    P('what is everyone up to?', 'doing what up to whats happening'),
    P('not much, you?', 'nothing fine same you nm'),
    P('just hanging out', 'nothing chilling relaxing bored'),
    P('i am so bored', 'bored boring nothing dull'),
    P('supposed to be doing homework', 'homework school work avoiding study'),
    P('my parents think im asleep', 'parents sneaking late night secret'),
    P('i should probably go to bed', 'sleep tired bed late'),
    P('this is my first week online', 'new newbie beginner week first'),
    P('the modem keeps dropping', 'modem disconnect drop connection line'),
    P('my mom needs the phone', 'phone mom parents line hang up go'),
    P('someone picked up the phone downstairs', 'phone picked up dropped line'),
    P('i got kicked off again', 'disconnected kicked dropped off booted'),
    P('this room is busy tonight', 'busy full crowded people many'),
    P('it is quiet in here', 'quiet empty slow dead nobody'),
    P('what is everyone listening to?', 'music listening song radio playing'),
    P('anyone seen any good movies?', 'movie film cinema watch seen'),
    P('what is the weather like there?', 'weather rain snow hot cold'),
    P('i just got a new computer', 'computer pc new upgrade machine'),
    P('how fast is your modem?', 'modem speed baud fast 28800 33600 56k'),
    P('i am on a 33.6', 'modem speed baud mine 33600'),
    P('i am saving up for a 56k', 'modem upgrade saving money fast'),
    P('downloading something, it is at 40 percent', 'download downloading slow percent waiting'),
    P('this download has been going for an hour', 'download slow long hour waiting'),
    P('do you have a homepage?', 'homepage website page web geocities'),
    P('i just made a homepage', 'homepage website made built new'),
    P('i am learning html', 'html learning code making page'),
    P('anyone want to be pen pals?', 'pen pals write letters friend email'),
  ]),

  CAT('yes', 'Yes & No', 'Answering', [
    P('yes', 'yeah yep yup ok sure agree'),
    P('yeah', 'yes yep sure'),
    P('no', 'nope nah negative disagree'),
    P('nope', 'no nah'),
    P('maybe', 'perhaps dunno unsure possibly'),
    P('i dont know', 'dunno idk unsure no idea'),
    P('agreed', 'agree yes same exactly true'),
    P('exactly', 'agree yes right correct true'),
    P('good point', 'agree true right fair'),
    P('i disagree', 'no wrong nope dispute'),
    P('same here', 'me too also agree likewise'),
    P('me too', 'same also likewise as well'),
    P('not really', 'no nah kind of not'),
    P('sure, why not', 'yes ok fine alright'),
  ]),

  CAT('react', 'Reactions', 'Something just happened', [
    P('lol', 'laugh funny haha ha'),
    P('haha', 'laugh lol funny'),
    P('that is hilarious', 'funny laugh lol hilarious'),
    P('no way', 'really seriously wow disbelief'),
    P('really?', 'seriously truly no way what'),
    P('wow', 'whoa amazing wow impressive'),
    P('that is so cool', 'cool awesome neat great'),
    P('awesome', 'cool great amazing sweet'),
    P('that is wild', 'crazy wild strange weird'),
    P('weird', 'strange odd weird bizarre'),
    P('oh no', 'bad sorry unfortunate yikes'),
    P('that stinks', 'bad sorry unfortunate rough'),
    P('i am sorry to hear that', 'sorry sympathy sad condolences'),
    P('congratulations!', 'congrats well done nice grats'),
    P('nice one', 'good well done congrats nice'),
    P('thank you', 'thanks thx ty grateful'),
    P('thanks!', 'thank you thx ty'),
    P('you are welcome', 'welcome no problem np sure'),
    P('no problem', 'np fine sure welcome'),
    P('i have no idea what that means', 'confused lost what huh'),
    P('huh?', 'what confused pardon repeat'),
    P('can you say that again?', 'repeat again what pardon missed'),
  ]),

  CAT('feel', 'Feelings', 'How you are', [
    P('i am having a good day', 'happy good great fine day'),
    P('i am tired', 'sleepy exhausted tired bed'),
    P('i am hungry', 'hungry food eat dinner snack'),
    P('i am excited', 'excited happy cant wait thrilled'),
    P('i am nervous', 'nervous scared worried anxious'),
    P('i miss my friends', 'miss lonely friends sad'),
    P('it has been a long week', 'tired long week rough'),
    P('things are looking up', 'better good improving hopeful'),
    P('i needed that today', 'thanks needed grateful better'),
    P('that made my night', 'happy thanks great night made'),
  ]),

  CAT('emote', 'Actions', 'Things you do, not say', [
    P('*waves*', 'wave hello hi greeting emote'),
    P('*waves goodbye*', 'wave bye goodbye leaving emote'),
    P('*laughs*', 'laugh lol haha emote'),
    P('*smiles*', 'smile happy grin emote'),
    P('*nods*', 'nod agree yes emote'),
    P('*shrugs*', 'shrug dunno whatever emote'),
    P('*claps*', 'clap applause well done emote'),
    P('*sighs*', 'sigh tired bored emote'),
    P('*yawns*', 'yawn tired sleepy bored emote'),
    P('*is listening*', 'listening paying attention here emote'),
    P('*is away from the keyboard*', 'afk away brb back gone emote'),
    P('*is back*', 'back returned here again emote'),
    P('*hands out cookies*', 'cookies food share nice emote'),
    P('*does a little dance*', 'dance happy celebrate emote'),
    P('*hides*', 'hide shy embarrassed emote'),
    P('*points at the ceiling*', 'point up look emote'),
  ]),

  CAT('nineties', 'The Nineties', 'Things only sayable in 1997', [
    P('does anyone have any mp3s?', 'mp3 music download songs files'),
    P('this song has been downloading since tuesday', 'download slow mp3 long'),
    P('i taped it off the radio', 'tape radio record cassette music'),
    P('my sister taped over it', 'tape ruined sister vhs recorded over'),
    P('be kind, rewind', 'video vhs rental tape rewind'),
    P('i beat the water temple', 'game zelda beat finished level'),
    P('goldeneye is the greatest game ever made', 'game n64 goldeneye best'),
    P('i have every free trial disk', 'disk cd trial free hours aol'),
    P('i use the disks as coasters', 'disk cd coaster trial junk'),
    P('i have 500 free hours saved up', 'free hours trial disk time'),
    P('my tamagotchi died', 'tamagotchi pet died virtual toy'),
    P('the school computer has the internet now', 'school computer lab internet library'),
    P('i had to book the library computer', 'library computer booking hour wait'),
    P('my dad printed the whole page', 'print printer dad paper page'),
    P('the printer only does the top half', 'printer broken half page ink'),
    P('does anyone else collect pogs?', 'pogs collect toys trade'),
    P('i still have my beanie babies in the box', 'beanie babies collect toys box'),
    P('the comet is visible tonight', 'comet sky stars astronomy night'),
    P('i am recording the season finale', 'record vcr tv show finale tape'),
    P('do not tell me what happens', 'spoiler dont tell secret finale'),
  ]),

  CAT('game', 'Games', 'In the games and the trivia room', [
    P('good game', 'gg well played good game'),
    P('good luck', 'gl luck fortune'),
    P('your turn', 'turn go move you'),
    P('my turn?', 'turn go move me whose'),
    P('nice move', 'good move well played clever'),
    P('i did not see that coming', 'surprise unexpected clever move'),
    P('one more?', 'again another rematch more'),
    P('i have to go after this one', 'last game leaving one more'),
    P('anyone want to play?', 'play game join challenge partner'),
    P('i am not very good at this', 'bad new learning beginner'),
    P('i am just learning', 'new learning beginner teach'),
    P('score?', 'score points standings board'),
    P('what is the question?', 'question repeat missed trivia'),
    P('i knew that one', 'knew easy got it correct'),
    P('no idea', 'dunno idk no clue guess'),
    P('is it my go?', 'turn go move whose'),
  ]),

  CAT('kind', 'Being Kind', 'Worth having in the vocabulary', [
    P('welcome!', 'welcome hello new greeting'),
    P('welcome to the room', 'welcome hello new greeting'),
    P('nice to meet you', 'meet nice pleased greeting'),
    P('glad you are here', 'glad happy welcome nice'),
    P('that is a great screen name', 'name compliment nice screen'),
    P('i like your face', 'compliment avatar nice face looks'),
    P('hope you feel better', 'better sick sorry wish well'),
    P('good luck tomorrow', 'luck tomorrow wish well exam'),
    P('take care', 'care goodbye well wishes'),
    P('come back soon', 'return come back again soon'),
    P('you are alright, you know that?', 'compliment nice kind friend'),
  ]),

  CAT('stop', 'Speak Up', 'When somebody is being unpleasant', [
    P('please stop', 'stop quit enough please cut it out'),
    P('that is not funny', 'stop not funny unkind mean'),
    P('do not talk to me like that', 'stop rude mean unkind'),
    P('i am not comfortable with this', 'uncomfortable stop uneasy no'),
    P('please do not ask me that', 'stop personal private dont ask'),
    P('i do not give out personal information', 'private personal no address phone'),
    P('i am telling a guide', 'guide report staff telling notify'),
    P('a guide should see this', 'guide report staff notify moderator'),
    P('i am leaving this room', 'leave leaving going out'),
  ]),

  CAT('bye', 'Goodbye', 'Signing off', [
    P('brb', 'be right back away moment'),
    P('brb, my mom needs the phone', 'brb phone mom parents line'),
    P('back in a minute', 'brb back minute away'),
    P('gtg', 'got to go leaving bye'),
    P('i have to go', 'leaving go bye gtg'),
    P('bye everyone', 'goodbye bye leaving all'),
    P('night all', 'goodnight night bye sleep'),
    P('see you tomorrow', 'tomorrow bye see you later'),
    P('later', 'bye see you cya later'),
    P('this was fun', 'fun enjoyed nice thanks good time'),
    P('thanks for the chat', 'thanks chat conversation nice bye'),
    P('i will be back later', 'back later return again'),
    P('signing off', 'sign off leaving bye offline'),
  ]),
];

/** Every phrase, flattened, with a stable index. */
export const PHRASES = CATEGORIES.flatMap((c, ci) =>
  c.phrases.map((p, pi) => ({
    id: c.id + ':' + pi, cat: c.id, catName: c.name,
    text: p.text, tags: p.tags, order: ci * 1000 + pi,
  })));

const BY_ID = new Map(PHRASES.map(p => [p.id, p]));

/** Only a phrase that is genuinely in the book can ever be sent. */
export const isPhrase = text => PHRASES.some(p => p.text === text);
export const byId = id => BY_ID.get(id) || null;

/* ── matching ────────────────────────────────────────────────────────── */

const norm = s => String(s).toLowerCase().replace(/[^a-z0-9* ]+/g, ' ')
  .replace(/\s+/g, ' ').trim();

const STOP = new Set(['a', 'an', 'the', 'is', 'are', 'am', 'i', 'you', 'to',
  'of', 'and', 'it', 'that', 'this', 'do', 'does', 'my', 'me']);

/**
 * Scores the whole book against whatever somebody typed and returns the
 * best few. This is the only thing that ever reads your keystrokes; what
 * comes back out is always one of the phrases above.
 */
export function match(input, limit = 7) {
  const q = norm(input);
  if (!q) return [];
  const words = q.split(' ').filter(Boolean);
  const strong = words.filter(w => !STOP.has(w));

  const scored = PHRASES.map(p => {
    const text = norm(p.text);
    const hay = text + ' ' + p.tags;
    let s = 0;

    if (text === q) s += 100;
    else if (text.startsWith(q)) s += 60;
    else if (text.includes(q) && q.length > 2) s += 34;

    for (const w of strong) {
      if (w.length < 2) continue;
      const inText = new RegExp('(^| )' + w).test(text);
      const inTags = new RegExp('(^| )' + w).test(p.tags);
      if (inText) s += 14 + Math.min(w.length, 8);
      else if (inTags) s += 10 + Math.min(w.length, 6);
      else if (w.length > 3 && hay.includes(w.slice(0, Math.max(4, w.length - 2)))) s += 5;
    }

    // A short query should not be beaten by a long phrase that merely
    // happens to contain a common word.
    if (s > 0) s -= Math.min(6, Math.abs(text.split(' ').length - words.length));
    return { p, s };
  }).filter(r => r.s > 6);

  scored.sort((a, b) => b.s - a.s || a.p.order - b.p.order);
  return scored.slice(0, limit).map(r => r.p);
}

/** Something to say when a room has gone quiet and you have nothing. */
export function suggestions(n = 6) {
  const picks = [];
  const cats = ['hello', 'talk', 'react', 'nineties', 'emote', 'bye'];
  for (const c of cats) {
    const pool = PHRASES.filter(p => p.cat === c);
    picks.push(pool[(Math.random() * pool.length) | 0]);
    if (picks.length >= n) break;
  }
  return picks;
}

export const PHRASE_COUNT = PHRASES.length;
