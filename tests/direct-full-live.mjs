import {chromium} from 'playwright';
import {serve} from '../tests/static-server.mjs';
import fs from 'node:fs/promises';
const headers={Referer:'https://www.bilibili.com/','User-Agent':'Mozilla/5.0'};
const bvid=process.env.READVIDEO_SAMPLE||'BV1QAnB67EL3';
const v=await(await fetch('https://api.bilibili.com/x/web-interface/view?bvid='+bvid,{headers})).json();
const p=await(await fetch('https://api.bilibili.com/x/player/playurl?bvid='+bvid+'&cid='+v.data.cid+'&fnval=16&qn=16',{headers})).json();
const a=[...p.data.dash.audio].sort((a,b)=>a.bandwidth-b.bandwidth)[0];
const urls=[a.baseUrl,...a.backupUrl||[]].filter(s=>{try{return new URL(s).hostname.endsWith('.bilivideo.com')}catch{return false}});
const server=await serve('web'),browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const page=await browser.newPage();await page.goto(server.url);
 const source={id:`bilibili:${bvid}:${v.data.cid}:1:${a.id}:${a.bandwidth}`,urls};
 const result=await page.evaluate(async source=>{
  const {fetchDirectAudio}=await import('./direct-audio.mjs');const {decodeAudioBytes}=await import('./source.mjs');
  const start=performance.now();const bytes=await fetchDirectAudio(source);const downloadMs=performance.now()-start;
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
  const size=bytes.length;const decodeStart=performance.now();const jobs=await decodeAudioBytes(bytes);
  const decodeMs=performance.now()-decodeStart,duration=jobs.at(-1).keepUntil;
  const warm=performance.now();const resumed=await fetchDirectAudio(source);
  const resumedHash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',resumed)),x=>x.toString(16).padStart(2,'0')).join('');
  return {bytes:size,downloadMs:Math.round(downloadMs),decodeMs:Math.round(decodeMs),decodedDuration:duration,windows:jobs.length,sha256:hash,cachedDownloadMs:Math.round(performance.now()-warm),cacheMatches:hash===resumedHash};
 },source);
 const report={testedAt:new Date().toISOString(),sample:bvid,metadataDuration:v.data.duration,environment:'real clean-profile Chrome, local static page and production downloader iframe; Node metadata resolution only; no mocked CDN',...result};
 await fs.writeFile('.qa/direct-full-live-result.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}catch(e){console.log(JSON.stringify({error:e.message.split('\n')[0]}));process.exitCode=1;}
finally{await browser.close();await server.close();}
