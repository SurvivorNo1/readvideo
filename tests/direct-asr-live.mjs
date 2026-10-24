import {chromium} from 'playwright';
import {serve} from '../tests/static-server.mjs';
import fs from 'node:fs/promises';
const headers={Referer:'https://www.bilibili.com/','User-Agent':'Mozilla/5.0'},bvid='BV1VS4y1t7st';
const v=await(await fetch('https://api.bilibili.com/x/web-interface/view?bvid='+bvid,{headers})).json();
const p=await(await fetch('https://api.bilibili.com/x/player/playurl?bvid='+bvid+'&cid='+v.data.cid+'&fnval=16&qn=16',{headers})).json();
const a=[...p.data.dash.audio].sort((a,b)=>a.bandwidth-b.bandwidth)[0];
const urls=[a.baseUrl,...a.backupUrl||[]].filter(s=>{try{return new URL(s).hostname.endsWith('.bilivideo.com')}catch{return false}});
const server=await serve('web'),browser=await chromium.launch({channel:'chrome',headless:true});
try{
const page=await browser.newPage();await page.goto(server.url);
await page.exposeFunction('phase',s=>console.log(s));
const source={id:`bilibili:${bvid}:${v.data.cid}:1:${a.id}:${a.bandwidth}`,urls};
const result=await page.evaluate(async source=>{
 const {ReadingSession}=await import('./session.mjs');
 const run=async()=>{const start=performance.now();const session=new ReadingSession({url:'https://www.bilibili.com/video/BV1VS4y1t7st/',language:'en',backend:'cpu',onStatus:s=>{if(s.message)window.phase(s.message);}});
  let calls=0;const recognize=session.asr.recognize.bind(session.asr);session.asr.recognize=(...args)=>{calls++;return recognize(...args)};
  await session.startMedia(()=>{},source);return {ms:Math.round(performance.now()-start),inferenceCalls:calls,cues:session.transcript.segments.length,duration:session.elapsed,characters:session.transcript.segments.map(c=>c.text).join('').length,partial:session.transcript.partial};};
 return {cold:await run(),resumed:await run()};
},source);
const report={testedAt:new Date().toISOString(),sample:bvid,environment:'real Chrome, CPU Whisper, direct CDN downloader; metadata resolved by Node; no adapters, no LLM',...result};
await fs.writeFile('.qa/direct-asr-live-result.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await browser.close();await server.close();}
