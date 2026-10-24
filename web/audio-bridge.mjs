import {downloadAudio,openDownloadCache} from './download.mjs';
let started=false;
addEventListener('message',async event=>{
  if(started||event.source!==parent||event.origin!==location.origin||event.data?.type!=='readvideo-download'||!event.ports[0])return;
  started=true;const port=event.ports[0];let cache;
  try{
    try{cache=await openDownloadCache();}catch{}
    const bytes=await downloadAudio(event.data.source,{cache,onProgress:p=>port.postMessage({type:'progress',...p})});
    port.postMessage({type:'complete',bytes},[bytes.buffer]);
  }catch{port.postMessage({type:'error',message:'音轨下载中断，已保存的分块可在重试时继续。请重新读取链接。'});}
  finally{cache?.close();port.close();}
});
