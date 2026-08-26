/* The mailbox.
 *
 * The one beat worth getting right here is the attachment: a picture that
 * arrives a few scanlines at a time while a progress bar crawls, because
 * that is what a photograph cost over a 33.6 modem. */

import { h, clear, $$ } from '../../core/dom.js';
import { openWindow, dialog, getWindow } from '../../core/wm.js';
import { icon } from '../../core/icons.js';
import * as A from '../../core/audio.js';
import { screen } from '../../core/safety.js';

const READ = 'halcyon.mail.read';

function readSet() {
  try { return new Set(JSON.parse(localStorage.getItem(READ)) || []); } catch { return new Set(); }
}
function markRead(id) {
  const s = readSet(); s.add(id);
  try { localStorage.setItem(READ, JSON.stringify([...s])); } catch {}
}

/* ── the mail itself ─────────────────────────────────────────────────── */

export const MESSAGES = [
  {
    id: 'welcome',
    from: 'Halcyon Online',
    subject: 'Welcome to Halcyon!',
    date: 'Fri, Aug 15, 1997  9:02 AM',
    body:
`Dear Member,

Welcome to Halcyon Online. Your first 500 hours are free, which sounds
like a lot until you try it.

A few things worth knowing on your first night:

  KEYWORD    Type a keyword into the box on the Welcome screen and press
             Enter to jump straight to a part of the service. Try CHAT,
             WEB, TRIVIA or HELP.

  CHAT       Rooms hold about a dozen people. Double-click anybody's name
             to send them an instant message, or to stop seeing them.

  GUIDES     Guides keep the rooms civil. They wear a red screen name.
             A Guide will never ask you for your password. Neither will
             anybody at Halcyon, ever, for any reason.

  PRIVACY    Do not type your telephone number, your address, or your real
             full name into a chat room. If you do, we will take it out
             for you, but it is better not to need us to.

Have a wonderful time. Hang up the phone when you are done.

  -- The Halcyon Team`,
  },
  {
    id: 'homepage',
    from: 'DrWebmaster',
    subject: 'my homepage is DONE (finally)',
    date: 'Sat, Aug 16, 1997  11:47 PM',
    body:
`ok it took me three weekends but it is up

http://www.geocitadel.com/silicon_alley/4412/

it has frames AND a hit counter. i know i said frames were a design
mistake. i contain multitudes.

let me know if it renders wrong in Netscape 3, my friend says the
background tiles funny for him but he is running a Mac so who knows

- Dr.W`,
    link: 'http://www.geocitadel.com/silicon_alley/4412/',
  },
  {
    id: 'photo',
    from: 'CoffeeAchiever',
    subject: 'the sunset from the office roof',
    date: 'Sun, Aug 17, 1997  4:18 AM',
    body:
`Took this on the way out last night. It is 640x480 so it is going to take
a minute to come down. Put the kettle on.

Do not open it if your mother needs the phone.`,
    attachment: { name: 'SUNSET.JPG', size: 47318 },
  },
  {
    id: 'chain',
    from: 'xXAngelBabyXx',
    subject: 'FWD: FWD: FWD: READ THIS DO NOT DELETE!!!!',
    date: 'Sun, Aug 17, 1997  6:55 PM',
    body:
`>>> FORWARD THIS TO 10 PEOPLE IN THE NEXT HOUR
>>> A GIRL NAMED AMY NEEDS YOUR HELP
>>> MICROSOFT IS TRACKING THIS EMAIL AND WILL PAY YOU $245 PER FORWARD
>>> MY COUSIN DID NOT FORWARD IT AND HIS DOG RAN AWAY. THIS IS TRUE.
>>>
>>> DO NOT BREAK THE CHAIN!!!!!!!

sorry i know these are annoying but what if it IS true

:)`,
  },
  {
    id: 'billing',
    from: 'HaIcyon Billing',
    subject: 'URGENT: ACCOUNT VERIFICATION REQUIRED',
    date: 'Mon, Aug 18, 1997  2:11 AM',
    suspicious: true,
    body:
`DEAR VALUED MEMBER,

OUR BILLING SYSTEM HAS LOST YOUR ACCOUNT RECORD. TO AVOID PERMANENT
DELETION OF YOUR SCREEN NAME YOU MUST REPLY TO THIS MESSAGE WITHIN 24
HOURS WITH THE FOLLOWING:

  - YOUR SCREEN NAME
  - YOUR PASSWORD
  - YOUR CREDIT CARD NUMBER

THIS IS AN OFFICIAL MESSAGE FROM HALCYON BILLING DEPARTMENT.`,
  },
  {
    id: 'recipe',
    from: 'MoM2Three',
    subject: 'the casserole, as promised',
    date: 'Mon, Aug 18, 1997  7:30 PM',
    body:
`It is not fancy but nobody has ever left any.

  1 lb ground beef
  1 can cream of mushroom
  1 bag frozen tater tots
  2 cups cheddar
  salt, pepper

Brown the beef, stir in the soup, tip it into a 9x13. Cheese, then tots on
top in rows because it matters. 375 for 40 minutes.

My youngest showed me how to attach a picture but I have not managed it
yet. Next time.

Say hello to everyone in the Coffee House for me.`,
  },
];

export function unreadCount() {
  const r = readSet();
  return MESSAGES.filter(m => !r.has(m.id)).length;
}

/* ── the window ──────────────────────────────────────────────────────── */

export function openMailbox(session) {
  const existing = getWindow('halcyon-mail');
  if (existing) { existing.focus(); return existing; }

  const win = openWindow({
    id: 'halcyon-mail', title: 'Halcyon Mail Center', icon: 'mail',
    width: 640, height: 440, minWidth: 460, minHeight: 280,
    status: ['', 'Halcyon Online'],
  });

  const list = h('div.mail-list.scroll');
  const view = h('div.mail-view.scroll');
  let selected = null;

  clear(win.body).append(h('div.mail', {},
    h('div.mail-tabs', {},
      h('button.mail-tab.on', { type: 'button' }, 'New Mail'),
      h('button.mail-tab', { type: 'button', onclick: () => dialog({
        title: 'Old Mail', icon: 'mail',
        message: 'Old mail is kept on the Halcyon computers for 27 days.\n' +
                 'Yours is empty. You only signed up on Friday.' }) }, 'Old Mail'),
      h('button.mail-tab', { type: 'button', onclick: () => dialog({
        title: 'Sent Mail', icon: 'mail',
        message: 'Nothing sent yet.' }) }, 'Sent Mail')),
    h('div.mail-cols', {},
      h('div.mail-left', {},
        h('div.mail-head', {}, h('span', {}, 'From'), h('span', {}, 'Subject')),
        list),
      view),
    h('div.mail-btns', {},
      h('button.btn.small', { type: 'button', onclick: () => selected && reply(session, selected) }, 'Reply'),
      h('button.btn.small', { type: 'button', onclick: () => compose(session) }, 'Write'),
      h('button.btn.small', { type: 'button', onclick: () => selected && del(selected) }, 'Delete'),
      h('button.btn.small', { type: 'button', onclick: () => keepAsNew() }, 'Keep As New'))));

  function drawList() {
    const r = readSet();
    clear(list);
    for (const m of MESSAGES) {
      if (m.deleted) continue;
      const unread = !r.has(m.id);
      const row = h('div.mail-row', { class: unread ? 'unread' : '' },
        icon(unread ? 'mail' : 'doc', 16),
        h('span.mail-from', {}, m.from),
        h('span.mail-subj', {}, m.subject),
        m.attachment ? h('span.mail-clip', { title: 'Has an attachment' }, '■') : null);
      row.querySelector('svg').classList.remove('glyph');
      row.addEventListener('pointerdown', () => {
        $$('.mail-row', list).forEach(x => x.classList.remove('sel'));
        row.classList.add('sel');
        show(m);
      });
      list.append(row);
    }
    win.setStatus([unreadCount() + ' unread', 'Halcyon Online']);
  }

  function show(m) {
    selected = m;
    markRead(m.id);
    clear(view).append(
      m.suspicious ? h('div.mail-warn', {},
        'This message is not from Halcyon. Look at the sender: that is a ' +
        'capital i, not an l. Nobody legitimate will ever ask you for your ' +
        'password or your card number by e-mail. Delete it.') : null,
      h('div.mail-hdr', {},
        h('div', {}, h('b', {}, 'From: '), m.from),
        h('div', {}, h('b', {}, 'Subj: '), m.subject),
        h('div', {}, h('b', {}, 'Date: '), m.date)),
      h('pre.mail-body.selectable', {}, m.body),
      m.link ? h('div.mail-link', {},
        h('button.btn.small', {
          type: 'button',
          onclick: () => session.ctx.launch('browser', { url: m.link }),
        }, 'Go to this address')) : null,
      m.attachment ? attachmentRow(m) : null);
    drawList();
  }

  function attachmentRow(m) {
    return h('div.mail-attach', {},
      icon('doc', 16),
      h('b', {}, m.attachment.name),
      h('span', {}, ' (' + m.attachment.size.toLocaleString() + ' bytes, about 4 minutes)'),
      h('button.btn.small', {
        type: 'button', onclick: () => downloadPicture(m.attachment),
      }, 'Download Now'));
  }

  function del(m) {
    m.deleted = true; markRead(m.id); selected = null;
    clear(view); drawList(); A.click();
  }
  function keepAsNew() {
    try { localStorage.removeItem(READ); } catch {}
    drawList(); A.beep();
  }

  drawList();
  return win;
}

/* ── compose ─────────────────────────────────────────────────────────── */

function compose(session, to = '', subject = '', quoted = '') {
  const toF = h('input.field', { type: 'text', value: to, spellcheck: false });
  const subF = h('input.field', { type: 'text', value: subject, spellcheck: false });
  const bodyF = h('textarea.field', { rows: 10, spellcheck: false, value: quoted });

  const win = openWindow({
    id: 'halcyon-compose-' + Date.now(), title: 'Write Mail', icon: 'mail',
    width: 480, height: 380,
  });

  clear(win.body).append(h('div.compose', {},
    h('label', {}, 'To:'), toF,
    h('label', {}, 'Subject:'), subF,
    bodyF,
    h('div.compose-btns', {},
      h('button.btn', {
        type: 'button',
        onclick: () => {
          const res = screen(bodyF.value, null, { max: 4000 });
          if (!res.ok) { A.ding(); return; }
          win.close();
          A.mailFanfare();
          dialog({
            title: 'Halcyon Mail', icon: 'mail',
            message: 'Your mail has been sent.' +
              (res.notices.length ? '\n\n' + res.notices.join('\n') : ''),
          });
        },
      }, 'Send Now'),
      h('button.btn', { type: 'button', onclick: () => win.close() }, 'Cancel'))));

  setTimeout(() => (to ? bodyF : toF).focus(), 60);
  return win;
}

function reply(session, m) {
  const quoted = '\n\n' + m.body.split('\n').map(l => '> ' + l).join('\n');
  compose(session, m.from, m.subject.startsWith('Re:') ? m.subject : 'Re: ' + m.subject, quoted);
}

/* ── the picture, arriving slowly ────────────────────────────────────── */

export function downloadPicture(att) {
  const W = 320, H = 240;
  const canvas = h('canvas', { width: W, height: H, class: 'dl-canvas' });
  const bar = h('i');
  const pct = h('span', {}, '0%');
  const eta = h('span', {}, 'estimating...');

  const win = openWindow({
    id: 'halcyon-download', title: 'Downloading ' + att.name, icon: 'doc',
    width: 380, height: 396, resizable: false,
  });

  clear(win.body).append(h('div.dl', {},
    h('div.dl-frame', {}, canvas),
    h('div.dl-bar', {}, bar),
    h('div.dl-stats', {}, pct, h('span', {}, '2,913 bytes/sec'), eta),
    h('div.dl-btns', {},
      h('button.btn.small', { type: 'button', onclick: () => { stop = true; win.close(); } }, 'Cancel'))));

  const g = canvas.getContext('2d');
  g.fillStyle = '#101018'; g.fillRect(0, 0, W, H);

  const full = renderSunset(W, H);
  let row = 0, stop = false;
  const total = H;
  const t0 = performance.now();

  const step = () => {
    if (stop) return;
    // Interlaced, two passes, the way a progressive JPEG teased you.
    const chunk = 3;
    for (let i = 0; i < chunk && row < total; i++, row++) {
      g.putImageData(full, 0, 0, 0, row, W, 1);
    }
    const p = row / total;
    bar.style.width = (p * 100).toFixed(0) + '%';
    pct.textContent = (p * 100).toFixed(0) + '%';
    const spent = (performance.now() - t0) / 1000;
    eta.textContent = row >= total ? 'complete'
      : Math.max(1, Math.round(spent / Math.max(p, 0.01) - spent)) + ' sec remaining';
    if (row < total) { setTimeout(step, 42); if (row % 30 === 0) A.seek(1, 0.02); }
    else { A.mailFanfare(); win.setTitle(att.name + ' - complete'); }
  };
  setTimeout(step, 400);

  win.onClose = () => { stop = true; return true; };
  return win;
}

/** A procedural 320x240 sunset, dithered down to something 8-bit-ish. */
function renderSunset(W, H) {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');

  const sky = g.createLinearGradient(0, 0, 0, H * 0.72);
  sky.addColorStop(0, '#1b2a5e');
  sky.addColorStop(0.45, '#8c4a6e');
  sky.addColorStop(0.75, '#e2794a');
  sky.addColorStop(1, '#ffd071');
  g.fillStyle = sky; g.fillRect(0, 0, W, H * 0.72);

  g.fillStyle = '#fff3c4';
  g.beginPath(); g.arc(W * 0.68, H * 0.60, 26, 0, 6.284); g.fill();

  // Two ridges and a foreground roofline.
  const ridge = (y, amp, color, seed) => {
    g.fillStyle = color;
    g.beginPath(); g.moveTo(0, H);
    for (let x = 0; x <= W; x += 4) {
      const n = Math.sin((x + seed) * 0.021) * amp + Math.sin((x + seed) * 0.061) * amp * 0.4;
      g.lineTo(x, y + n);
    }
    g.lineTo(W, H); g.closePath(); g.fill();
  };
  ridge(H * 0.66, 14, '#5b3f63', 40);
  ridge(H * 0.74, 9, '#33253f', 190);

  g.fillStyle = '#161020';
  g.fillRect(0, H * 0.82, W, H * 0.18);
  for (let i = 0; i < 9; i++) {
    const bw = 18 + (i * 7) % 26, bh = 14 + (i * 11) % 34;
    g.fillRect(i * 37 - 6, H * 0.82 - bh, bw, bh);
  }
  g.fillStyle = '#ffd071';
  for (let i = 0; i < 26; i++)
    g.fillRect(9 + (i * 53) % (W - 14), H * 0.84 + (i * 17) % 22, 2, 3);

  // Ordered dither, so it looks like it came off a 256-colour card.
  const img = g.getImageData(0, 0, W, H);
  const d = img.data;
  const M = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const t = (M[y & 3][x & 3] / 16 - 0.5) * 26;
      for (let k = 0; k < 3; k++) {
        const v = d[i + k] + t;
        d[i + k] = Math.max(0, Math.min(255, Math.round(v / 32) * 32));
      }
    }
  }
  return img;
}
