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

// ─────────────────────── 转录文字缓存 ───────────────────────
//
// 只存文字，不存音频。键里带视频 ID，方便「这个视频转过没有」和按视频清理。
// 不设时间上限，按总量做 LRU，淘汰时整条视频一起删，不拆散。

const TRANSCRIPT_BUDGET = 200 * 1024 * 1024; // 200 MB

export function transcriptKey({ platform, videoId, model, language, windowStart }) {
  return [
    platform,
    videoId,
    model || "",
    language || "",
    "v1",
    Math.round(windowStart * 10) / 10,
  ].join("|");
}

export async function openTranscriptCache() {
  if (!globalThis.indexedDB) return null;

  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open("readvideo-transcripts", 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore("transcripts");
      store.createIndex("byVideo", ["platform", "videoId"]);
      store.createIndex("byAt", "at");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  const run = (mode, action) =>
    new Promise((resolve, reject) => {
      const tx = db.transaction("transcripts", mode);
      const request = action(tx.objectStore("transcripts"));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });

  const getAll = () =>
    new Promise((resolve, reject) => {
      const tx = db.transaction("transcripts", "readonly");
      const request = tx.objectStore("transcripts").getAll();
      tx.oncomplete = () => resolve(request.result || []);
      tx.onerror = () => reject(tx.error);
    });

  /** 整条视频一起淘汰，避免留下半截字幕。 */
  const prune = async (budget = TRANSCRIPT_BUDGET) => {
    const all = await getAll();
    let total = all.reduce((n, r) => n + (r.bytes || 0), 0);
    if (total <= budget) return { removed: 0, freed: 0 };

    const videos = new Map();
    for (const r of all) {
      const id = `${r.platform}|${r.videoId}`;
      const entry = videos.get(id) || { keys: [], bytes: 0, at: 0 };
      entry.keys.push(r.key);
      entry.bytes += r.bytes || 0;
      entry.at = Math.max(entry.at, r.at || 0);
      videos.set(id, entry);
    }

    const order = [...videos.values()].sort((a, b) => a.at - b.at);
    let removed = 0,
      freed = 0;
    for (const v of order) {
      if (total <= budget) break;
      await run("readwrite", (s) => {
        for (const k of v.keys) s.delete(k);
      });
      total -= v.bytes;
      freed += v.bytes;
      removed += v.keys.length;
    }
    return { removed, freed };
  };

  return {
    /** 命中返回 { text, chunks }，未命中返回 undefined */
    get: (key) =>
      run("readonly", (s) => s.get(key)).then((v) =>
        v ? { text: v.text, chunks: v.chunks } : undefined,
      ),
    /** 一次问一批键，返回命中的键集合 */
    has: async (keys) => {
      if (!keys.length) return new Set();
      const found = await run("readonly", (s) => {
        const out = [];
        for (const k of keys) {
          const req = s.get(k);
          req.onsuccess = () => {
            if (req.result) out.push(k);
          };
        }
        return out;
      }).catch(() => []);
      return new Set(found || []);
    },
    put: (key, record) => {
      const text = String(record.text ?? "");
      const chunks = Array.isArray(record.chunks) ? record.chunks : [];
      return run("readwrite", (s) =>
        s.put(
          {
            key,
            text,
            chunks,
            start: record.start,
            end: record.end,
            platform: record.platform,
            videoId: record.videoId,
            model: record.model || "",
            language: record.language || "",
            title: record.title || "",
            durationSec: record.durationSec || 0,
            at: Date.now(),
            bytes:
              text.length * 2 +
              chunks.reduce((n, c) => n + String(c.text || "").length * 2 + 40, 0) +
              160,
          },
          key,
        ),
      );
    },
    /** 取整条视频的所有窗口，按时间排序 */
    byVideo: async (platform, videoId) => {
      const rows = await run("readonly", (s) =>
        s.index("byVideo").getAll([platform, videoId]),
      );
      return (rows || [])
        .map((r) => ({ start: r.start, end: r.end, text: r.text }))
        .sort((a, b) => a.start - b.start);
    },
    clear: () => run("readwrite", (s) => s.clear()),
    prune,
    close: () => db.close(),
  };
}
