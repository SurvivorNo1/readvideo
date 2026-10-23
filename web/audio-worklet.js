class PCMCollector extends AudioWorkletProcessor{
 constructor(){super();this.parts=[];this.length=0;this.stopped=false;this.port.onmessage=e=>{if(e.data==='flush'){this.stopped=true;this.flush();this.port.postMessage({flushed:true});}};}
 flush(){if(!this.length)return;const pcm=new Float32Array(this.length);let at=0;for(const part of this.parts){pcm.set(part,at);at+=part.length;}this.parts=[];this.length=0;this.port.postMessage({pcm},[pcm.buffer]);}
 process(inputs){if(this.stopped)return false;const channels=inputs[0];if(!channels?.length)return true;const mono=new Float32Array(channels[0].length);for(const channel of channels)for(let i=0;i<mono.length;i++)mono[i]+=channel[i]/channels.length;this.parts.push(mono);this.length+=mono.length;if(this.length>=4096)this.flush();return true;}
}
registerProcessor('readvideo-pcm',PCMCollector);
