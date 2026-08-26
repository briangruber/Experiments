/*
 * The part that keeps a nostalgia toy from turning into an unmoderated
 * chat server.
 *
 * Three layers, applied in this order to everything a human types before
 * it reaches any other participant:
 *
 *   1. shape   — length, line count, rate. Stops flooding and pasting.
 *   2. privacy — scrubs things a 1997 parent told you never to type into
 *                a chat room: phone numbers, street addresses, e-mail,
 *                anything that looks like a card number. This is the one
 *                that matters most and it is also perfectly in period.
 *   3. conduct — a small masked-word pass, plus an escalating warning
 *                system that ends in being removed from the room.
 *
 * The conduct list here is deliberately short and mild. An operator who
 * runs the relay for other people is expected to supply their own list
 * (tools/relay.mjs --blocklist words.txt); this file does not try to
 * enumerate slurs, and the product does not depend on it having done so.
 *
 * The strongest control is not in this file at all: the default transport
 * is local-only, so out of the box there is nobody to be unsafe towards.
 */

export const LIMITS = {
  maxChars: 240,
  maxLines: 4,
  maxRepeatChars: 12,      // "aaaaaaaaaaaaaaaaaa"
  burst: 5,                // messages allowed back to back
  refillMs: 1800,          // one message credit per this long
  minGapMs: 450,           // hard floor between two sends
  imMaxChars: 400,
  nameMax: 16,
  nameMin: 3,
};

/* ── 1. shape ────────────────────────────────────────────────────────── */

export function createBucket({ burst = LIMITS.burst, refillMs = LIMITS.refillMs } = {}) {
  let credits = burst, last = 0, lastSend = 0;
  return {
    /** @returns {null | string} null when allowed, else why not. */
    check(now = Date.now()) {
      if (last) credits = Math.min(burst, credits + (now - last) / refillMs);
      last = now;
      if (now - lastSend < LIMITS.minGapMs) return 'slow';
      if (credits < 1) return 'flood';
      return null;
    },
    spend(now = Date.now()) { credits -= 1; lastSend = now; },
    get credits() { return credits; },
  };
}

/* ── 2. privacy ──────────────────────────────────────────────────────── */

const PRIVACY = [
  // e-mail addresses
  [/\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b/gi, 'e-mail address'],
  // north-american-ish phone numbers, with or without punctuation
  [/(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, 'phone number'],
  // 13-19 digit runs: card-shaped
  [/\b(?:\d[ -]?){13,19}\b/g, 'card number'],
  // street addresses
  [/\b\d{1,5}\s+[A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*)*\s+(?:st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|boulevard|ct|court|way|pl|place|ter|terrace)\b\.?/gi, 'street address'],
  // US-style SSN
  [/\b\d{3}-\d{2}-\d{4}\b/g, 'government number'],
];

/**
 * Replaces anything that looks like personal information with a redaction
 * mark. Returns the cleaned text plus the list of what it caught, so the
 * UI can say something in-period about it.
 */
export function scrubPrivate(text) {
  const found = [];
  let out = text;
  for (const [re, label] of PRIVACY) {
    out = out.replace(re, m => {
      // Bare years, scores and version numbers are not card numbers.
      if (label === 'card number' && m.replace(/\D/g, '').length < 13) return m;
      found.push(label);
      return '[' + label + ' removed]';
    });
  }
  return { text: out, found: [...new Set(found)] };
}

/* ── 3. conduct ──────────────────────────────────────────────────────── */

/* Mild, and masked rather than blocked — the asterisks were themselves a
   part of the experience. Operators extend this at runtime. */
const MASK = [
  'damn', 'hell', 'crap', 'ass', 'arse', 'bastard', 'bitch', 'bollocks',
  'bugger', 'shit', 'piss', 'dick', 'prick', 'wank', 'twat', 'slut', 'whore',
  'fuck', 'cunt',
];
let extraMask = [];
let extraBlock = [];

export function configureWordlists({ mask = [], block = [] } = {}) {
  extraMask = mask.map(w => String(w).toLowerCase()).filter(Boolean);
  extraBlock = block.map(w => String(w).toLowerCase()).filter(Boolean);
}

/*
 * Word matching is whole-word only, deliberately.
 *
 * The obvious implementation - does this word contain a bad word - is the
 * one that masks "hello", "bass", "Scunthorpe" and "assistant", and it is
 * the reason chat filters have been a punchline since about 1996. So:
 * normalise a word (undo the common letter-for-symbol swaps, drop the
 * rest), then require an exact match against the list, allowing only
 * ordinary suffixes and stretched-out spelling.
 */

const SUFFIX = ['', 's', 'es', 'ed', 'd', 'ing', 'in', 'er', 'ers', 'y', 'ies'];

const normalise = s => String(s)
  .replace(/[!*.\-_]+$/, '')          // "hell!!!" is still one word
  .toLowerCase()
  .replace(/[@4]/g, 'a').replace(/3/g, 'e').replace(/[1!|]/g, 'i')
  .replace(/0/g, 'o').replace(/[$5]/g, 's').replace(/7/g, 't')
  .replace(/[^a-z]/g, '');

/** Reduces any run of a repeated letter to one, so "fuuuck" meets "fuck". */
const squeeze = s => s.replace(/(.)\1+/g, '$1');

function wordHit(word, list) {
  const n = normalise(word);
  if (n.length < 3) return false;
  // The squeezed comparison is only for words somebody actually stretched
  // out. Applying it unconditionally makes "assess" match "asses".
  const stretched = /(.)\1\1/.test(n) ? squeeze(n) : null;
  for (const w of list) {
    for (const suf of SUFFIX) {
      const target = w + suf;
      if (n === target) return true;
      if (stretched && stretched === squeeze(target)) return true;
    }
  }
  return false;
}

/**
 * @returns {{ text, masked:number, blocked:boolean }}
 *   `blocked` means do not deliver at all and count a strike.
 */
export function screenConduct(text) {
  let masked = 0, blocked = false;
  const out = text.replace(/[\w@$!|*]+/g, word => {
    if (extraBlock.length && wordHit(word, extraBlock)) { blocked = true; return word; }
    if (wordHit(word, MASK) || (extraMask.length && wordHit(word, extraMask))) {
      masked++;
      return word[0] + '*'.repeat(Math.max(word.length - 1, 1));
    }
    return word;
  });
  return { text: out, masked, blocked };
}

/* ── the whole pipeline ──────────────────────────────────────────────── */

/**
 * Screens one outgoing chat line.
 * @returns {{ ok:boolean, text?:string, reason?:string, notices:string[] }}
 */
export function screen(raw, bucket, { max = LIMITS.maxChars, now = Date.now() } = {}) {
  const notices = [];
  let text = String(raw).replace(/\r/g, '').replace(/\t/g, '  ');

  text = text.split('\n').slice(0, LIMITS.maxLines).join('\n').trim();
  if (!text) return { ok: false, reason: 'empty', notices };

  const rate = bucket && bucket.check(now);
  if (rate === 'slow')  return { ok: false, reason: 'slow', notices };
  if (rate === 'flood') return { ok: false, reason: 'flood', notices };

  // Collapse held-down keys before anything measures the length.
  text = text.replace(
    new RegExp('(.)\\1{' + LIMITS.maxRepeatChars + ',}', 'g'),
    (m, c) => c.repeat(LIMITS.maxRepeatChars));

  const priv = scrubPrivate(text);
  if (priv.found.length) {
    text = priv.text;
    notices.push('Halcyon removed your ' + priv.found.join(' and ') +
      '. Never give out personal information online.');
  }

  const cond = screenConduct(text);
  if (cond.blocked) return { ok: false, reason: 'conduct', notices };
  text = cond.text;
  if (cond.masked) notices.push('Some language was filtered.');

  // Last, so that whatever the earlier passes did, the result fits.
  if (text.length > max) {
    text = text.slice(0, max);
    notices.push('Your message was shortened to ' + max + ' characters.');
  }

  if (bucket) bucket.spend(now);
  return { ok: true, text, notices, masked: cond.masked };
}

/** Screen-name rules, in the spirit of the sign-up screen. */
export function screenName(name) {
  const n = String(name).trim().replace(/\s+/g, '');
  if (n.length < LIMITS.nameMin) return { ok: false, reason: 'Screen names must be at least ' + LIMITS.nameMin + ' characters.' };
  if (n.length > LIMITS.nameMax) return { ok: false, reason: 'Screen names may be at most ' + LIMITS.nameMax + ' characters.' };
  if (!/^[A-Za-z][A-Za-z0-9 ]*$/.test(name.trim()))
    return { ok: false, reason: 'Screen names must begin with a letter and use only letters, numbers and spaces.' };
  const c = screenConduct(n);
  if (c.blocked || c.masked) return { ok: false, reason: 'That screen name is not available.' };
  if (/^(guide|host|staff|admin|halcyon|sysop|billing)/i.test(n))
    return { ok: false, reason: 'That screen name is reserved for Halcyon staff.' };
  return { ok: true, name: name.trim().replace(/\s+/g, ' ') };
}

/* ── strikes ─────────────────────────────────────────────────────────── */

/** Three strikes and you are out of the room — the classic TOS ladder. */
export function createStrikes(onWarn, onBoot) {
  let n = 0, decay = 0;
  return {
    add(reason) {
      const now = Date.now();
      if (now - decay > 120000) n = 0;      // strikes cool off after 2 min
      decay = now; n++;
      if (n >= 3) { n = 0; onBoot && onBoot(reason); return 'boot'; }
      onWarn && onWarn(reason, n);
      return 'warn';
    },
    get count() { return n; },
    reset() { n = 0; },
  };
}
