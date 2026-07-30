/* PEEKED — headless checks. Run: node games/peeked/test.js
   Needs playwright (devDependency) and a local chromium. */
const { chromium } = require('playwright');
const path = require('path');
const BASE = 'file://' + path.resolve(__dirname, 'index.html');
const EXE = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { cond ? pass++ : fail++; console.log((cond?'  ok  ':'  FAIL') + '  ' + name + (extra&&!cond?'  ['+extra+']':'')); };

(async () => {
  const b = await chromium.launch({ executablePath: EXE });
  const errs = [];
  const page = async (hash, opts) => {
    const p = await b.newPage(Object.assign({ viewport:{width:390,height:844} }, opts||{}));
    p.on('pageerror', e => errs.push(e.message));
    p.on('console', m => { if (m.type()==='error') errs.push(m.text()); });
    await p.addInitScript(() => { try{ localStorage.clear(); }catch(e){} });
    await p.goto(BASE + (hash||''));
    return p;
  };

  console.log('\nURL round trip');
  const pg = await page();
  const rt = await pg.evaluate(() => {
    const names=['sam','priya','dan','mia','jo','a','zzzzzzzzzzzz','nate99'];
    const kind=()=>{const r=Math.random();
      return r<.5?{kind:'solved',n:1+Math.floor(Math.random()*6)}:r<.65?{kind:'failed'}:{kind:'peeked',secs:Math.floor(Math.random()*1000)};};
    let bad=0;
    for(let t=0;t<300;t++){
      const chain=Array.from({length:Math.floor(Math.random()*24)},()=>Object.assign({name:names[Math.floor(Math.random()*names.length)]},kind()));
      const day=Math.floor(Math.random()*5000), x=Math.floor(Math.random()*5);
      const tr=trimChain(chain,x), url=buildURL(day,tr.chain,tr.x);
      const raw=url.slice(url.indexOf('#')+1), q={};
      for(const p of raw.split('&')){const i=p.indexOf('=');if(i>0)q[p.slice(0,i)]=p.slice(i+1);}
      const got=(q.c||'')?q.c.split('~').map(parseEntry).filter(Boolean):[];
      if(parseInt(q.d,36)!==day) bad++;
      if(checksum(q.d,q.c||'',q.x||'')!==q.k) bad++;
      if(got.length!==tr.chain.length||tr.chain.length>20) bad++;
      if((parseInt(q.x||'0',10)||0)!==tr.x) bad++;
      for(let i=0;i<got.length;i++){
        const a=tr.chain[i],g=got[i];
        if(a.name!==g.name||a.kind!==g.kind) bad++;
        if(a.kind==='peeked'&&Math.min(999,a.secs)!==g.secs) bad++;
      }
    }
    return bad;
  });
  ok('300 random chains round-trip exactly', rt === 0, rt + ' defects');

  console.log('\nDaily secret');
  const sec = await pg.evaluate(() => {
    let repeats=0; const c={};
    for(let d=0;d<400;d++){const s=secretFor(d); if(new Set(s).size!==5)repeats++; s.forEach(e=>c[e]=(c[e]||0)+1);}
    const v=Object.values(c);
    return {repeats, det:secretFor(210).join('')===secretFor(210).join(''), spread:Math.max(...v)-Math.min(...v)};
  });
  ok('no repeated emoji in any secret', sec.repeats === 0);
  ok('deterministic across calls', sec.det);
  ok('even distribution over 400 days', sec.spread < 60, 'spread ' + sec.spread);

  console.log('\nBoard mechanics');
  const p2 = await page();
  await p2.click('.key:has-text("🍎")');
  ok('tapped emoji disables for the row', await p2.evaluate(()=>[...palette.children].find(k=>k.textContent==='🍎').disabled));
  await p2.click('#delBtn');
  ok('DELETE re-enables it', await p2.evaluate(()=>![...palette.children].find(k=>k.textContent==='🍎').disabled));
  const sc = await p2.evaluate(()=>score(['🍎','🌙','🔥','🐙','💎'],['🌙','🍎','🧊','🐙','🌵']).join(''));
  ok('per-slot feedback G/Y/B', sc === 'YYBGB', sc);

  console.log('\nOutcomes');
  const p3 = await page();
  const secret = await p3.evaluate(()=>SECRET);
  for (const e of secret) await p3.click(`.key:has-text("${e}")`);
  await p3.click('#entBtn'); await p3.waitForTimeout(800);
  ok('solving reaches the result screen', await p3.isVisible('#result'));
  ok('outcome recorded as solved', await p3.evaluate(()=>S.outcome)==='solved');

  // deliberately NOT using page() here: its init script clears storage on every
  // navigation, which would wipe the very persistence this asserts.
  const p4 = await b.newPage({ viewport:{width:390,height:844} });
  p4.on('pageerror', e => errs.push(e.message));
  await p4.goto(BASE);
  await p4.evaluate(()=>localStorage.clear());
  await p4.goto(BASE);
  await p4.click('.key:has-text("🍎")'); await p4.waitForTimeout(1100);
  await p4.click('#peekBtn');
  ok('peek is terminal', await p4.evaluate(()=>S.done && S.outcome==='peeked'));
  ok('peek records elapsed seconds', await p4.evaluate(()=>S.peekSecs) >= 1);
  await p4.reload(); await p4.waitForTimeout(250);
  ok('a peek survives refresh', await p4.evaluate(()=>S.outcome)==='peeked');
  ok('refresh lands on the result, not a fresh board', await p4.isVisible('#result'));

  // mid-game guesses must also survive
  const p5 = await b.newPage({ viewport:{width:390,height:844} });
  await p5.goto(BASE); await p5.evaluate(()=>localStorage.clear()); await p5.goto(BASE);
  const g5 = await p5.evaluate(()=>POOL.slice(0,5));
  for (const e of g5) await p5.click(`.key:has-text("${e}")`);
  await p5.click('#entBtn'); await p5.waitForTimeout(800);
  await p5.reload(); await p5.waitForTimeout(250);
  ok('mid-game guesses survive refresh', await p5.evaluate(()=>S.guesses.length)===1);

  console.log('\nContagion gradient');
  const sign = await page();
  const day = await sign.evaluate(()=>todayIndex());
  const mk = e => sign.evaluate(({day,e})=>buildURL(day,e.map(parseEntry),0),{day,e});
  const cases = [
    ['clean',   ['sam.c4','priya.c5','dan.c4'],                        {above:false, banner:true}],
    ['half',    ['sam.c4','priya.p12','dan.c4','jo.p47'],              {above:true,  banner:false}],
    ['all',     ['sam.p9','priya.p12','dan.p4','jo.p47'],              {above:true,  banner:false}],
  ];
  let prev = 0;
  for (const [label, entries, exp] of cases){
    const u = await mk(entries);
    const p = await page(u.slice(u.indexOf('#')));
    await p.click('#playBtn'); await p.waitForTimeout(150);
    const i = await p.evaluate(()=>{
      const btn=document.getElementById('peekBtn');
      return { size:parseFloat(getComputedStyle(btn).fontSize),
               above:document.getElementById('peekSlotTop').contains(btn),
               banner:!document.getElementById('cleanBanner').classList.contains('hidden') };
    });
    ok(`${label}: placement`, i.above === exp.above);
    ok(`${label}: clean banner`, i.banner === exp.banner);
    ok(`${label}: button larger than previous`, i.size > prev, i.size+' vs '+prev);
    prev = i.size;
  }

  console.log('\nRobustness');
  const bad1 = await page('#d=zz&c=garbage!!!&k=00');
  ok('malformed fragment falls back to a playable board', await bad1.isVisible('#game') || await bad1.isVisible('#landing'));
  const u2 = await mk(['sam.c4','priya.c5']);
  const tam = await page(u2.slice(u2.indexOf('#')).replace(/&k=..$/, '&k=zz'));
  ok('tampered chain is flagged, not blocked', await tam.evaluate(()=>TAMPERED) && await tam.isVisible('#playBtn'));
  ok('tampered chain exerts no peek pressure', await tam.evaluate(()=>R)===0);
  const fut = await page('#d=' + (day+50).toString(36) + '&c=sam.c4&k=00');
  ok('future-dated link clamps to today', await fut.evaluate(()=>DAY) === day);

  console.log('\nLayout & theme');
  const nar = await page(null, {viewport:{width:320,height:700}});
  const of = await nar.evaluate(()=>({s:document.documentElement.scrollWidth,c:document.documentElement.clientWidth}));
  ok('no horizontal scroll at 320px', of.s <= of.c, of.s+'>'+of.c);
  const th = await page(null, {colorScheme:'light'});
  await th.evaluate(()=>document.documentElement.setAttribute('data-theme','dark'));
  ok('data-theme overrides OS preference', await th.evaluate(()=>getComputedStyle(document.body).backgroundColor)==='rgb(15, 17, 20)');

  ok('no JS errors anywhere', errs.length === 0, errs.join(' | '));
  console.log(`\n${pass} passed, ${fail} failed\n`);
  await b.close();
  process.exit(fail ? 1 : 0);
})();
