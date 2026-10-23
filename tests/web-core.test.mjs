import test from 'node:test';
import assert from 'node:assert/strict';
import { resample, windowAudio, mergeTranscript, parseCaptions, buildPrompt, generateArticle, resolveConfig, chatRequest } from '../web/core.mjs';

test('resampling downmix-ready PCM preserves duration at 16kHz',()=>{
 const out=resample(new Float32Array(48000).fill(.5),48000);
 assert.equal(out.length,16000);assert.ok(Math.abs(out[500]-.5)<.001);
 assert.throws(()=>resample(new Float32Array(4),0));
});
test('audio windowing owns every sample and retains the final short chunk',()=>{
 const pcm=new Float32Array(50*16000+7);pcm[pcm.length-1]=.75;
 const windows=windowAudio(pcm,16000,24,2);
 assert.equal(windows.length,3);assert.equal(windows[2].audio.at(-1),.75);
 assert.equal(windows[0].keepFrom,0);assert.equal(windows[1].keepFrom,24);
 assert.equal(windows[2].keepUntil,pcm.length/16000);
 assert.ok(Math.abs(windows.reduce((s,w)=>s+w.keepUntil-w.keepFrom,0)-pcm.length/16000)<1e-9);
});
test('overlap clips timestamps without removing distinct repeated speech',()=>{
 const a=mergeTranscript([], [{timestamp:[0,2],text:'hello'},{timestamp:[23,25],text:'boundary'}], {offset:0,keepFrom:0,keepUntil:24});
 const b=mergeTranscript(a,[{timestamp:[0,1],text:'boundary'},{timestamp:[2,4],text:'hello'}],{offset:22,keepFrom:24,keepUntil:48});
 assert.equal(b.length,3);assert.equal(b.at(-1).text,'hello');assert.equal(b.at(-1).start,24);
});
test('SRT and JSON3 parsing retain final cue and reject empty input',()=>{
 const cues=parseCaptions('1\n00:00:00,000 --> 00:00:01,000\nFirst\n\n2\n00:00:05,000 --> 00:00:06,000\nFinal','srt');
 assert.equal(cues.length,2);assert.equal(cues.at(-1).text,'Final');
 assert.equal(parseCaptions('{"events":[{"tStartMs":2000,"segs":[{"utf8":"Actual"}]}]}','json3')[0].start,2);
 assert.throws(()=>parseCaptions('no captions','srt'));
});
test('four article depths and correction are grounded in captions',()=>{
 const prompts=['short','medium','long','detailed'].map(length=>buildPrompt({mode:'article',length,language:'zh'}));
 assert.equal(new Set(prompts.map(p=>p.instruction)).size,4);
 for(const p of prompts){assert.match(p.system,/转写错误/);assert.match(p.system,/数字/);assert.match(p.system,/存疑/);assert.match(p.instruction,/视频主题/);}
 assert.ok(prompts.at(-1).maxTokens>=10000);
 assert.throws(()=>buildPrompt({mode:'article',length:'huge',language:'zh'}));
});
test('multi-chunk generation visits all source segments and preserves length',async()=>{
 const calls=[];const transcript={title:'Source',segments:Array.from({length:3},(_,i)=>({start:i,text:String(i).repeat(6500)}))};
 const out=await generateArticle(transcript,{model:'m'},{mode:'article',length:'detailed',language:'en'},()=>{},async(c,m,o)=>{calls.push({m,o});return '# Actual content';});
 assert.ok(calls.length>=4);assert.equal(out.length,'detailed');assert.match(calls.at(-1).m[1].content,/2000–3500/);
 assert.match(calls[2].m[1].content,/222222/);assert.ok(!('api_key' in out));
});
test('API config requires own key and rejects URL/key ambiguity',()=>{
 assert.throws(()=>resolveConfig({provider:'deepseek'}));
 assert.throws(()=>resolveConfig({provider:'custom',base_url:'https://user:pw@example.com',model:'m',api_key:'secret'}));
 assert.throws(()=>resolveConfig({provider:'deepseek',api_key:'bad\nkey'}));
 assert.equal(resolveConfig({provider:'deepseek',api_key:'memory-test'}).api_key,'memory-test');
});
test('browser-direct request redacts provider errors and sends only selected endpoint',async()=>{
 let request;
 const config=resolveConfig({provider:'deepseek',api_key:'memory-test'});
 await assert.rejects(()=>chatRequest(config,[],{fetcher:async(url,opts)=>{request={url,opts};return {ok:false,status:401,text:async()=> 'memory-test'};}}),e=>!e.message.includes('memory-test'));
 assert.equal(request.url,'https://api.deepseek.com/chat/completions');
 assert.equal(JSON.parse(request.opts.body).thinking.type,'disabled');
});
