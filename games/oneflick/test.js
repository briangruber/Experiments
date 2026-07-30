/* ONE FLICK — browser checks. Run: node games/oneflick/test.js
   Needs a chromium with WebGL; software GL is fine. */
const { chromium } = require('playwright');
const path = require('path');
const BASE = 'file://' + path.resolve(__dirname, 'index.html');
const EXE = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? '  ok  ' : '  FAIL') + '  ' + n + (x && !c ? '  [' + x + ']' : '')); };

(async () => {
  const b = await chromium.launch({ executablePath: EXE, args: ARGS });
  const errs = [];
  const open = async (hash, name, vp) => {
    const p = await b.newPage({ viewport: vp || { width: 390, height: 844 } });
    p.on('pageerror', e => errs.push(e.message));
    p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
    await p.addInitScript(n => { try { localStorage.setItem('oneflick.name', n); } catch (e) {} }, name || 'sam');
    await p.goto(BASE + (hash || ''), { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(1400);
    return p;
  };
  const flick = async (p, toX, toY) => {
    await p.mouse.move(195, 620); await p.mouse.down();
    await p.mouse.move(toX, toY, { steps: 8 }); await p.waitForTimeout(120);
    await p.mouse.up();
    await p.waitForFunction(() => !!document.querySelector('#share'), null, { timeout: 30000 });
  };
  const shareOf = async p => {
    await p.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true }); });
    await p.click('#share'); await p.waitForTimeout(150);
    return p.textContent('#msg');
  };

  console.log('\nRendering');
  const p1 = await open('', 'sam');
  ok('webgl canvas is live', await p1.evaluate(() => {
    const c = document.querySelector('#stage canvas'); return !!c && c.width > 0 && c.height > 0;
  }));
  ok('canvas fills the viewport', await p1.evaluate(() => {
    const c = document.querySelector('#stage canvas');
    return Math.abs(c.clientWidth - innerWidth) < 2 && Math.abs(c.clientHeight - innerHeight) < 2;
  }));
  ok('no horizontal scroll', await p1.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));

  console.log('\nSetting the target');
  ok('a cold visit explains the role', /you set the target/i.test(await p1.textContent('#card h2')));
  ok('intro explains the control', /drag/i.test(await p1.textContent('#card')));
  await p1.click('#ok');
  ok('dismissing the intro reveals the prompt', !(await p1.getAttribute('#prompt', 'class')).includes('hide'));
  await flick(p1, 250, 330);
  ok('the flick resolves to a result', /target set/i.test(await p1.textContent('#card h2')));
  const s1 = await shareOf(p1);
  const frag = (s1.match(/#s=[^\s]+/) || [])[0];
  ok('setter share text is produced', /ONE FLICK/.test(s1) && !!frag);
  ok('share link is short', frag && frag.length < 120, frag && frag.length);
  await p1.close();

  console.log('\nChallenging');
  const p2 = await open(frag, 'priya');
  ok('challenger sees the dare', /get closer/i.test(await p2.textContent('#card h2')));
  ok('challenger is told who set it', /sam/.test(await p2.textContent('#card')));
  ok('an empty board says so', /nobody has tried/i.test(await p2.textContent('#card')));
  ok('the setter is not on the leaderboard', await p2.evaluate(() => document.querySelectorAll('.board li').length) === 0);
  await p2.click('#ok');
  await flick(p2, 150, 300);
  const rows = await p2.evaluate(() => [...document.querySelectorAll('.board li')].map(l => l.textContent));
  ok('challenger is scored and listed', rows.length === 1 && /priya/.test(rows[0]));
  ok('score is a distance', /\d+\.\d\d away/.test(await p2.textContent('#card h2')));
  const s2 = await shareOf(p2);
  const frag2 = (s2.match(/#s=[^\s]+/) || [])[0];
  ok('challenger share text carries the board', /priya/.test(s2) && /sam set the target/.test(s2));
  await p2.close();

  console.log('\nThird player sees a real contest');
  const p3 = await open(frag2, 'dan');
  ok('previous challenger is on the board', /closest so far/i.test(await p3.textContent('#card')));
  ok('leader name is shown', /priya/.test(await p3.textContent('#card')));
  const ghosts = await p3.evaluate(() => window.__ghosts === undefined ? null : window.__ghosts);
  await p3.click('#ok');
  await flick(p3, 300, 420);
  ok('board now ranks two challengers', await p3.evaluate(() => document.querySelectorAll('.board li').length) === 2);
  ok('board is sorted by distance', await p3.evaluate(() => {
    const d = [...document.querySelectorAll('.board .ds')].map(x => parseFloat(x.textContent));
    return d.every((v, i) => i === 0 || d[i - 1] <= v);
  }));
  await p3.close();

  console.log('\nRobustness');
  const bad = await open('#s=!!&c=@@@&k=zz', 'x');
  ok('garbage link still starts a playable game', /you set the target/i.test(await bad.textContent('#card h2')));
  await bad.close();
  const tam = await open(frag.replace(/&k=..$/, '&k=zz'), 'x');
  ok('edited link is flagged but still playable', await tam.evaluate(() => !document.getElementById('warn').classList.contains('hide')));
  await tam.close();
  const land = await open('', 'x', { width: 844, height: 390 });
  ok('landscape still fits the arena', await land.evaluate(() => {
    const c = document.querySelector('#stage canvas');
    return c.clientWidth > 800 && document.documentElement.scrollWidth <= document.documentElement.clientWidth;
  }));
  await land.close();
  const narrow = await open('', 'x', { width: 320, height: 640 });
  ok('320px wide has no overflow', await narrow.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
  await narrow.close();

  ok('no JS errors anywhere', errs.length === 0, errs.join(' | '));
  console.log(`\n${pass} passed, ${fail} failed\n`);
  await b.close();
  process.exit(fail ? 1 : 0);
})();
