const MAX = 128000000;
export function audioURL(value) {
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.username || u.password || u.port ||
      !['bilivideo.com','bilivideo.cn'].some(h=>u.hostname===h||u.hostname.endsWith('.'+h)))
    throw Error('音轨地址来源无效。');
  return u.href;
}
export async function downloadAudio(source, {fetcher=fetch, cache=null, blockSize=1024*1024, concurrency=4, signal, onProgress=()=>{}}={}) {
  const urls=[...new Set(source.urls.map(audioURL))].slice(0,4);
  if (!urls.length || typeof source.id!=='string' || source.id.length>200) throw Error('音轨信息无效。');
  if (!Number.isSafeInteger(blockSize)||blockSize<1024||blockSize>4*1024*1024) throw Error('分块大小无效。');
  const controller=new AbortController();
  const combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
  async function range(start,end,total) {
    for(let attempt=0;attempt<Math.max(3,urls.length);attempt++) {
      combined.throwIfAborted();
      try {
        const r=await fetcher(urls[attempt%urls.length],{mode:'cors',credentials:'omit',referrerPolicy:'unsafe-url',headers:{Range:`bytes=${start}-${end}`},signal:AbortSignal.any([combined,AbortSignal.timeout(20000)])});
        if(r.status===200&&start===0&&end===1023&&!total&&!r.headers.has('Content-Range')&&!/text|html|json/i.test(r.headers.get('Content-Type')||'')) {
          const reader=r.body.getReader(),parts=[];let size=0;
          while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>MAX){await reader.cancel();throw Error('音轨超过大小上限。');}parts.push(value);onProgress({completed:size,total:Number(r.headers.get('Content-Length'))||size,reused:0,bytesPerSecond:0});}
          if(!size)throw Error('音轨为空。');const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}
          return {bytes,total:size,full:true};
        }
        const match=/^bytes (\d+)-(\d+)\/(\d+)$/.exec(r.headers.get('Content-Range')||'');
        if(r.status!==206||!match||+match[1]!==start||+match[2]!==Math.min(end,+match[3]-1)||+match[3]>MAX||+match[3]<=0||(total&&+match[3]!==total)) {
          await r.body?.cancel();throw Error('音轨分片无效，请重新读取链接。');
        }
        const expected=+match[2]-start+1,reader=r.body.getReader(),bytes=new Uint8Array(expected);let at=0;
        while(true){const {value,done}=await reader.read();if(done)break;if(at+value.length>expected){await reader.cancel();throw Error('音轨分片超长。');}bytes.set(value,at);at+=value.length;}
        if(at!==expected)throw Error('音轨分片不完整。');
        return {bytes,total:+match[3]};
      } catch(error){if(combined.aborted||attempt===Math.max(3,urls.length)-1)throw error;}
    }
  }
  const probe=await range(0,1023), total=probe.total;
  if(probe.full)return probe.bytes;
  const tail=await range(Math.max(0,total-1024),total-1,total);
  const fingerprint=new Uint8Array(probe.bytes.length+tail.bytes.length);fingerprint.set(probe.bytes);fingerprint.set(tail.bytes,probe.bytes.length);
  const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',fingerprint)),b=>b.toString(16).padStart(2,'0')).join('');
  const prefix=`${source.id}:${total}:${blockSize}:${digest}:`, output=new Uint8Array(total);
  let next=0,completed=0,reused=0;const started=performance.now();
  const report=()=>onProgress({completed,total,reused,bytesPerSecond:(completed-reused)/Math.max(.001,(performance.now()-started)/1000)});
  let storage=cache;
  const workers=Array.from({length:Math.min(6,Math.max(1,Math.floor(concurrency)||4),Math.ceil(total/blockSize))},async()=>{
    while(next<total) {
      combined.throwIfAborted();const start=next;next+=blockSize;const end=Math.min(total-1,start+blockSize-1),key=prefix+start;
      let bytes;try{bytes=await storage?.get(key);}catch{storage=null;}
      if(bytes instanceof Uint8Array && bytes.length===end-start+1)reused+=bytes.length;
      else {bytes=(await range(start,end,total)).bytes;try{await storage?.put(key,bytes);}catch{storage=null;}}
      output.set(bytes,start);completed+=bytes.length;report();
    }
  });
  try{await Promise.all(workers);}catch(error){controller.abort();await Promise.allSettled(workers);throw error;}
  return output;
}

export async function openDownloadCache() {
  if(!globalThis.indexedDB)return null;
  const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('readvideo-audio',1);r.onupgradeneeded=()=>r.result.createObjectStore('blocks');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  const run=(mode,action)=>new Promise((resolve,reject)=>{const tx=db.transaction('blocks',mode),request=action(tx.objectStore('blocks'));tx.oncomplete=()=>resolve(request.result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});
  // Bound disk use across videos; old jobs are expendable, current ones remain resumable.
  await new Promise((resolve,reject)=>{const tx=db.transaction('blocks','readwrite'),store=tx.objectStore('blocks'),r=store.openCursor();let total=0;
    r.onsuccess=()=>{const cursor=r.result;if(!cursor)return;const v=cursor.value;total+=v.bytes?.byteLength||JSON.stringify(v.bytes||{}).length;
      if(Date.now()-v.at>86400000||total>256000000)cursor.delete();cursor.continue();};tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});
  return {get:async key=>{const v=await run('readonly',s=>s.get(key));return v&&Date.now()-v.at<86400000?v.bytes:undefined;},put:(key,bytes)=>run('readwrite',s=>s.put({at:Date.now(),bytes},key)),close:()=>db.close()};
}
