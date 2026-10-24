import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadAudio } from '../web/download.mjs';
const source={id:'bili:1:2:1:30216',urls:['https://a.bilivideo.com/a']};
const data=Uint8Array.from({length:10000},(_,i)=>i%251);
function mock({fail=false,bad=false}={}) {
  const calls=[]; let active=0,peak=0;
  return {calls,get peak(){return peak},fetcher:async(url,options)=>{
    const [,a,b]=options.headers.Range.match(/bytes=(\d+)-(\d+)/); const start=+a,end=Math.min(+b,data.length-1);
    calls.push(start); active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,2));active--;
    if(fail&&start>=4096&&end-start+1>1024)throw Error('disconnected');
    return new Response(data.slice(start,end+1),{status:206,headers:{'Content-Range':`bytes ${bad?start+1:start}-${end}/${data.length}`}});
  }};
}
test('bounded parallel ranges reassemble exact bytes',async()=>{
 const m=mock();const result=await downloadAudio(source,{fetcher:m.fetcher,blockSize:2048,cache:null});
 assert.deepEqual(result,data);assert.ok(m.peak>1&&m.peak<=4);
});
test('resume keeps successful blocks and rejects malformed ranges',async()=>{
 const entries=new Map(),cache={get:async k=>entries.get(k),put:async(k,v)=>entries.set(k,v)};
 const broken=mock({fail:true});await assert.rejects(downloadAudio(source,{fetcher:broken.fetcher,blockSize:2048,cache}));
 const next=mock();assert.deepEqual(await downloadAudio(source,{fetcher:next.fetcher,blockSize:2048,cache}),data);
 assert.ok(!next.calls.includes(2048));
 await assert.rejects(downloadAudio(source,{fetcher:mock({bad:true}).fetcher,cache:null}));
});
test('sources without ranges use one bounded complete response',async()=>{
 let calls=0;
 const bytes=await downloadAudio(source,{fetcher:async()=>{calls++;return new Response(data,{headers:{'Content-Type':'audio/mp4'}})}});
 assert.deepEqual(bytes,data);assert.equal(calls,1);
});
test('untrusted hosts and an aborted download never start requests',async()=>{
 let calls=0;const fetcher=async()=>{calls++;throw Error()};
 await assert.rejects(downloadAudio({...source,urls:['https://bilivideo.com.evil.test/audio']},{fetcher}));
 await assert.rejects(downloadAudio(source,{fetcher,signal:AbortSignal.abort()}));assert.equal(calls,0);
});
