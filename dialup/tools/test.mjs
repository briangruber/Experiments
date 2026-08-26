/*
 * Behaviour tests that do not need a browser.
 *
 * Two things are worth testing here and they are both the safety layer:
 * the pure screening functions in src/core/safety.js, and the relay, which
 * is the only part of this prototype that ever listens on a socket.
 *
 * Run: node tools/test.mjs
 */

import { spawn } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  screen, screenName, scrubPrivate, screenConduct,
  createBucket, createStrikes, configureWordlists, LIMITS,
} from '../src/core/safety.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
let group = '';

const describe = name => { group = name; console.log('\n' + name); };
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (cond || !detail ? '' : '\n         ' + detail));
  if (!cond) failures.push(group + ' / ' + name);
};

/* ── privacy ─────────────────────────────────────────────────────────── */

describe('the privacy pass');

for (const [input, label] of [
  ['call me at 555-123-4567', 'phone number'],
  ['my number is (216) 555 0100', 'phone number'],
  ['write to me at someone@example.com', 'e-mail address'],
  ['I live at 1428 Elm Street', 'street address'],
  ['card is 4111 1111 1111 1111', 'card number'],
  ['ssn 123-45-6789', 'government number'],
]) {
  const r = scrubPrivate(input);
  check('removes a ' + label + ' from: ' + input,
    r.found.includes(label) && !r.text.includes(input.split(' ').pop()),
    'got: ' + r.text);
}

for (const safe of [
  'I got a 94 on the test',
  'my modem is 33600 baud',
  'see you in 1997',
  'the score was 3-2 in overtime',
  'version 4.00.950 B',
]) {
  const r = scrubPrivate(safe);
  check('leaves ordinary text alone: ' + safe, r.found.length === 0, 'got: ' + r.text);
}

/* ── conduct ─────────────────────────────────────────────────────────── */

describe('the conduct pass');

const masked = screenConduct('what the hell is this');
check('masks a mild word', masked.masked === 1 && masked.text.includes('h***'), masked.text);
check('does not block by default', masked.blocked === false);

const leet = screenConduct('what the h3ll');
check('sees through simple letter substitution', leet.masked === 1, leet.text);

const clean = screenConduct('hello everyone, what a nice room');
check('leaves clean text untouched', clean.masked === 0 && clean.text === 'hello everyone, what a nice room');

const scunthorpe = screenConduct(
  'shell hello bass classic assistant assess passage cockpit dickens grass Scunthorpe');
check('does not mask words that merely contain a masked word',
  scunthorpe.masked === 0, scunthorpe.text);

const stretched = screenConduct('what the heeellll');
check('sees through stretched-out spelling', stretched.masked === 1, stretched.text);

const punct = screenConduct('what the hell!!!');
check('trailing punctuation does not hide a word', punct.masked === 1, punct.text);

const suffix = screenConduct('stop damning it');
check('ordinary suffixes still match', suffix.masked === 1, suffix.text);

configureWordlists({ block: ['zzblockedzz'] });
const blocked = screenConduct('this contains zzblockedzz here');
check('an operator blocklist blocks rather than masks', blocked.blocked === true);
configureWordlists({});

/* ── rate limiting ───────────────────────────────────────────────────── */

describe('the rate limiter');

{
  const bucket = createBucket();
  let t = 1_000_000;
  let sent = 0, rejected = 0;
  for (let i = 0; i < 20; i++) {
    t += LIMITS.minGapMs + 10;                 // typing fast but not instantly
    const r = screen('message ' + i, bucket, { now: t });
    r.ok ? sent++ : rejected++;
  }
  check('a sustained burst is throttled', rejected > 0, sent + ' sent, ' + rejected + ' rejected');
  check('but not silenced entirely', sent >= LIMITS.burst);
}

{
  const bucket = createBucket();
  let t = 2_000_000;
  const a = screen('first', bucket, { now: t });
  const b = screen('second', bucket, { now: t + 20 });
  check('two messages in the same instant: the second is refused',
    a.ok && !b.ok && b.reason === 'slow');
}

{
  const bucket = createBucket();
  let t = 3_000_000, sent = 0;
  for (let i = 0; i < 10; i++) {
    t += 2500;                                  // a normal conversational pace
    if (screen('line ' + i, bucket, { now: t }).ok) sent++;
  }
  check('normal conversation is never throttled', sent === 10, sent + '/10 got through');
}

/* ── the whole pipeline ──────────────────────────────────────────────── */

describe('the send pipeline');

{
  // Varied text, so the repeat-collapse pass does not shorten it first.
  const long = Array.from({ length: 400 }, (_, i) => 'word' + i).join(' ');
  const r = screen(long, null);
  check('long messages are cut to the limit',
    r.ok && r.text.length === LIMITS.maxChars, r.ok ? r.text.length + ' chars' : r.reason);
  check('and the sender is told', r.notices.some(n => n.includes('shortened')));
}

{
  const r = screen('aaaa' + 'b'.repeat(80), null);
  check('a held-down key is collapsed', r.ok && r.text.length < 40, r.text);
}

{
  // A privacy substitution is longer than what it replaces; the cap still holds.
  const r = screen('x'.repeat(LIMITS.maxChars - 20) + ' call 555-123-4567', null);
  check('the cap holds even after a substitution grows the text',
    r.ok && r.text.length <= LIMITS.maxChars, r.ok ? r.text.length + ' chars' : r.reason);
}

{
  const r = screen('hi call me on 555-123-4567 ok', null);
  check('a phone number never reaches the wire', r.ok && !/555/.test(r.text), r.text);
  check('and the notice explains why',
    r.notices.some(n => n.includes('Never give out personal information')));
}

{
  const r = screen('one\ntwo\nthree\nfour\nfive\nsix', null);
  check('a pasted block is cut to ' + LIMITS.maxLines + ' lines',
    r.ok && r.text.split('\n').length === LIMITS.maxLines, JSON.stringify(r.text));
}

check('empty input is refused', screen('   ', null).reason === 'empty');

/* ── screen names ────────────────────────────────────────────────────── */

describe('screen names');

check('a normal name is accepted', screenName('BlueRaven97').ok);
check('a name with a space is accepted', screenName('Coffee Achiever').ok);
check('too short is refused', !screenName('ab').ok);
check('too long is refused', !screenName('a'.repeat(LIMITS.nameMax + 1)).ok);
check('must start with a letter', !screenName('4realz').ok);
check('no punctuation', !screenName('who?').ok);
check('staff names are reserved', !screenName('GuideMike').ok);
check('and so is the service name', !screenName('HalcyonBob').ok);

/* ── strikes ─────────────────────────────────────────────────────────── */

describe('the warning ladder');

{
  const warns = [];
  let booted = 0;
  const s = createStrikes((r, n) => warns.push(n), () => booted++);
  check('first offence warns', s.add('x') === 'warn');
  check('second offence warns', s.add('x') === 'warn');
  check('third offence removes you', s.add('x') === 'boot' && booted === 1);
  check('and the count resets afterwards', s.count === 0);
  check('warnings are numbered', warns.join(',') === '1,2');
}

/* ── the relay ───────────────────────────────────────────────────────── */

describe('the relay');

const PORT = 8793;
const relay = spawn(process.execPath, [join(root, 'tools/relay.mjs'), '--port', String(PORT)],
  { stdio: ['ignore', 'pipe', 'pipe'] });
let relayOut = '';
relay.stdout.on('data', d => { relayOut += d; });
relay.stderr.on('data', d => { relayOut += d; });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const connect = () => new Promise((res, rej) => {
  const ws = new WebSocket('ws://127.0.0.1:' + PORT);
  ws.rx = [];
  ws.onmessage = e => { try { ws.rx.push(JSON.parse(e.data)); } catch {} };
  ws.onopen = () => res(ws);
  ws.onerror = rej;
});

try {
  await sleep(700);
  const a = await connect();
  const b = await connect();
  await sleep(150);

  const say = (ws, extra) => ws.send(JSON.stringify(
    { t: 'chat', peer: 'peer-a', from: 'Alice', room: 'lobby', ...extra }));

  say(a, { text: 'hello room' });
  await sleep(200);
  check('a message reaches the other client',
    b.rx.some(m => m.t === 'chat' && m.text === 'hello room'));
  check('and is not echoed to the sender', !a.rx.some(m => m.text === 'hello room'));

  b.rx.length = 0;
  a.send(JSON.stringify({ t: 'somethingElse', peer: 'peer-a', text: 'nope' }));
  await sleep(1300);
  say(a, { text: 'x'.repeat(1200) });
  await sleep(1300);
  say(a, { text: 'y'.repeat(9000) });
  await sleep(1300);
  say(a, { text: 'hi', danger: '<script>alert(1)</script>', __proto__: undefined });
  await sleep(250);

  check('unknown message types are dropped', !b.rx.some(m => m.t === 'somethingElse'));
  const long = b.rx.find(m => m.text && m.text.startsWith('xxxx'));
  check('over-long text is truncated', !!long && long.text.length === 500,
    long ? long.text.length + ' chars' : 'never arrived');
  check('a frame past the cap is discarded, not fatal',
    !b.rx.some(m => m.text && m.text.startsWith('yyyy')) && b.rx.some(m => m.text === 'hi'));
  const extra = b.rx.find(m => m.text === 'hi');
  check('unknown fields never travel', !!extra && extra.danger === undefined);

  b.rx.length = 0;
  say(a, { text: 'ctrl' + String.fromCharCode(7) + 'bell' });
  await sleep(250);
  const ctrl = b.rx.find(m => m.text && m.text.includes('bell'));
  check('control characters are stripped', !!ctrl && ctrl.text === 'ctrlbell',
    ctrl ? JSON.stringify(ctrl.text) : 'never arrived');

  b.rx.length = 0;
  for (let i = 0; i < 30; i++) say(a, { text: 'flood ' + i });
  await sleep(400);
  check('a flood is rate-limited', b.rx.length > 0 && b.rx.length <= 12,
    b.rx.length + ' of 30 relayed');

  check('the relay logs no message contents',
    !/hello room|flood|ctrlbell/.test(relayOut), relayOut.slice(0, 200));

  a.close(); b.close();
  await sleep(150);
} catch (e) {
  check('relay tests ran', false, String(e));
} finally {
  relay.kill('SIGTERM');
}

/* ── verdict ─────────────────────────────────────────────────────────── */

await sleep(200);
if (failures.length) {
  console.error('\n' + failures.length + ' failure(s):');
  for (const f of failures) console.error('  ' + f);
  process.exit(1);
}
console.log('\nall behaviour checks passed');
process.exit(0);
