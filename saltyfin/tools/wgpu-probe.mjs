import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
const ROOT='/home/user/Experiments/saltyfin', PAGE='/tmp/claude-0/-home-user-Experiments/f2ccb81e-d555-5956-b6b9-4f92dd7fd808/scratchpad/wgpu/index.html';
const MIME={'.js':'text/javascript','.html':'text/html'};
const s=createServer(async(req,res)=>{try{
  if(req.url==='/'){res.writeHead(200,{'content-type':'text/html'});return res.end(await readFile(PAGE));}
  const p=join(ROOT,req.url.split('?')[0]);
  res.writeHead(200,{'content-type':MIME[extname(p)]||'application/octet-stream'});res.end(await readFile(p));
}catch(e){ if(!res.headersSent) res.writeHead(404); res.end(); }});
await new Promise(r=>s.listen(0,'127.0.0.1',r));
const {chromium}=await import('/opt/node22/lib/node_modules/playwright/index.mjs').catch(()=>import('playwright'));
const b=await chromium.launch({args:['--enable-unsafe-swiftshader','--use-angle=swiftshader','--disable-dev-shm-usage']});
const pg=await b.newPage({viewport:{width:420,height:260}});
const errs=[];pg.on('pageerror',e=>errs.push(String(e.message).slice(0,300)));
pg.on('console',m=>{if(m.type()==='error')errs.push(m.text().slice(0,300));});
await pg.goto(`http://127.0.0.1:${s.address().port}/`,{waitUntil:'load'});
await pg.waitForFunction(()=>window.__r&&(window.__r.ok||window.__r.error),null,{timeout:60000}).catch(()=>{});
console.log(JSON.stringify(await pg.evaluate(()=>window.__r),null,1));
if(errs.length)console.log('ERRORS:\n'+errs.slice(0,4).join('\n'));
await pg.screenshot({path:'/home/user/Experiments/saltyfin/shots/wgpu-probe.png'});
await b.close();s.close();
