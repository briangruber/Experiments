/* A small read-only filesystem, so My Computer has somewhere to go and
   Notepad has something to open. Text files are the documentation for
   this prototype, in character. */

export const DRIVES = [
  { id: 'a', label: '3½ Floppy (A:)', icon: 'floppy', empty: true },
  { id: 'c', label: '(C:)', icon: 'computer' },
  { id: 'd', label: 'HALCYON3 (D:)', icon: 'cd' },
];

export const TREE = {
  c: {
    'AUTOEXEC.BAT': `@ECHO OFF
PROMPT $P$G
PATH C:\\PANES;C:\\PANES\\COMMAND;C:\\DOS
SET TEMP=C:\\PANES\\TEMP
C:\\PANES\\COMMAND\\MSCDEX.EXE /D:MSCD001 /L:D
LH C:\\MOUSE\\MOUSE.COM
ECHO Loading...
WIN`,
    'CONFIG.SYS': `DEVICE=C:\\PANES\\HIMEM.SYS
DOS=HIGH,UMB
DEVICE=C:\\PANES\\EMM386.EXE NOEMS
FILES=40
BUFFERS=20
DEVICEHIGH=C:\\CDROM\\MITSUMI.SYS /D:MSCD001
LASTDRIVE=E`,
    'README.TXT': `PANES 95 - READ ME FIRST
========================

Welcome to your new computer.

The blue icon on the desktop is Halcyon Online. Double-click it, sign on
with any name you like, and wait through the modem. The wait is the point.

WHAT IS REAL
  Nothing here talks to the internet. The service, the people in the chat
  rooms, the web pages, the mail and the weather are all running inside
  this browser window.

WHO YOU WILL MEET
  Most of the people in the rooms are small programs. If you open this
  page in a second browser tab, that tab is a real second person, and the
  two of you will see each other.

IF YOU WANT REAL OTHER PEOPLE
  There is a relay in tools/relay.mjs. Run it yourself, tick the box on
  the sign-on screen, and other machines on your own network can join.
  It binds to localhost unless you tell it otherwise, it keeps no logs,
  and it stores nothing.

THINGS TO TRY
  Type SCORE in the Trivia Tavern.
  Double-click somebody's name in a chat room.
  Download the attachment on the message from CoffeeAchiever.
  Leave the machine alone for a minute and a half.
  Open Disk Defragmenter and do not do anything else for a while.`,
    'PANES': {
      'WIN.INI': `[windows]
load=
run=
Beep=yes
NullPort=None
device=HP LaserJet 4L,HPPCL5MS,LPT1:

[Desktop]
Wallpaper=(None)
Pattern=(None)
TileWallpaper=0`,
      'SYSTEM.INI': `[boot]
shell=Explorer.exe
drivers=mmsystem.dll power.drv
[386Enh]
device=*vshare
mouse=*vmouse, msmouse.vxd`,
      'TEMP': {},
    },
    'MY DOCUMENTS': {
      'LETTER.TXT': `Dear Grandma,

I am writing this on the computer. Dad says it costs money every minute
so I will be quick.

School is fine. I got a 94 on the science test about the water cycle.

We got the internet. You can talk to people in other states for free,
except it is not free, it is $2.95 an hour after the first ten.

I will print this at the library because our printer only does the top
half of the page.

Love,
Me`,
      'SCREEN NAMES.TXT': `ideas for a screen name

  SkateOrDie97      taken
  BlueRaven         taken
  BlueRaven2        taken
  BlueRaven_        taken
  TheRealBlueRaven  taken (!!)
  bluravn           available but looks like a typo

give up, use initials + birthday like everyone else`,
    },
    'PROGRAM FILES': {
      'HALCYON': { 'HALCYON.EXE': null, 'WELCOME.WAV': null, 'MODEM.INF': null },
      'NETSCRAPE': { 'NETSCRAPE.EXE': null, 'BOOKMARK.HTM': null },
    },
    'GAMES': { 'MINEHUNT.EXE': null, 'SKETCH.EXE': null },
  },
  d: {
    'INSTALL.EXE': null,
    'READ.ME': `HALCYON ONLINE 3.0 FOR PANES 95
INSTALLATION DISC

500 FREE HOURS. NO OBLIGATION. CANCEL ANY TIME.

This disc arrived in your mailbox. It also arrived in a magazine, in a
cereal box, taped to a videotape, and inside a box of frozen fish.

SYSTEM REQUIREMENTS
  486DX/66 or better
  8 MB RAM (16 MB recommended)
  30 MB free hard disk space
  14400 bps modem or faster
  A telephone line nobody else needs`,
    'HALCYON': { 'SETUP.INI': null, 'ART': {} },
  },
};

/** Walks a path like ['c','MY DOCUMENTS'] and returns the node there. */
export function at(path) {
  let node = TREE[path[0]];
  for (let i = 1; i < path.length && node; i++) node = node[path[i]];
  return node;
}

export const isFolder = v => v !== null && typeof v === 'object';
export const isText = (name, v) => typeof v === 'string';
