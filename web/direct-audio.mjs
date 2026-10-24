export function fetchDirectAudio(source,progress=()=>{},signal) {
  return new Promise((resolve,reject)=>{
    if(signal?.aborted){reject(signal.reason);return;}
    const frame=document.createElement('iframe'),channel=new MessageChannel();
    frame.hidden=true;
    // Trusted static, same-origin module only; origin is required for CDN CORS and IndexedDB.
    frame.sandbox='allow-scripts allow-same-origin';
    frame.src=new URL('./audio-bridge.html?r=https://www.bilibili.com',import.meta.url).href;
    let finished=false;
    const abort=()=>finish(signal.reason||Error('下载已取消。'));
    const finish=(error,bytes)=>{if(finished)return;finished=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);channel.port1.close();channel.port2.close();frame.remove();error?reject(error):resolve(bytes);};
    let timer=setTimeout(()=>finish(Error('音轨下载超时，请重试继续。')),180000);
    signal?.addEventListener('abort',abort,{once:true});
    channel.port1.onmessage=({data})=>{
      clearTimeout(timer);timer=setTimeout(()=>finish(Error('音轨下载超时，请重试继续。')),180000);
      if(data.type==='complete')finish(null,data.bytes);
      else if(data.type==='error')finish(Error(data.message));
      else if(data.type==='progress')progress(`正在加速读取 · ${(data.completed/1e6).toFixed(1)} / ${(data.total/1e6).toFixed(1)} MB · ${(data.bytesPerSecond/1e6).toFixed(1)} MB/s${data.reused?' · 已恢复下载':''}`,Math.round(10+15*data.completed/data.total));
    };
    frame.onload=()=>frame.contentWindow.postMessage({type:'readvideo-download',source:{id:source.id,urls:source.urls}},location.origin,[channel.port2]);
    frame.onerror=()=>finish(Error('无法启动音轨下载。'));
    document.body.append(frame);
  });
}
