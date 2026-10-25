import { resample, mergeTranscript } from "./core.mjs";

export class AudioChunker {
  constructor(rate = 16000, seconds = 24, overlap = 2) {
    this.rate = rate;
    this.seconds = seconds;
    this.overlap = overlap;
    this.buffer = new Float32Array(0);
    this.base = 0;
    this.own = 0;
  }
  push(pcm, final = false) {
    const all = new Float32Array(this.buffer.length + pcm.length);
    all.set(this.buffer);
    all.set(pcm, this.buffer.length);
    this.buffer = all;
    const jobs = [],
      end = this.base + all.length;
    while (
      this.own < end &&
      (final || end >= this.own + (this.seconds + this.overlap) * this.rate)
    ) {
      const from = Math.max(0, this.own - this.overlap * this.rate),
        to = Math.min(
          end,
          this.own + (this.seconds + this.overlap) * this.rate,
        ),
        until = Math.min(end, this.own + this.seconds * this.rate);
      jobs.push({
        audio: resample(
          this.buffer.slice(from - this.base, to - this.base),
          this.rate,
        ),
        offset: from / this.rate,
        keepFrom: this.own / this.rate,
        keepUntil: until / this.rate,
      });
      this.own = until;
    }
    const discard = Math.max(this.base, this.own - this.overlap * this.rate);
    this.buffer = this.buffer.slice(discard - this.base);
    this.base = discard;
    return jobs;
  }
}
export class SerialQueue {
  constructor(run, onChange = () => {}) {
    this.run = run;
    this.onChange = onChange;
    this.jobs = [];
    this.running = false;
    this.error = null;
    this.waiters = [];
  }
  get pendingSeconds() {
    return this.jobs.reduce((n, j) => n + j.keepUntil - j.keepFrom, 0);
  }
  add(job) {
    this.jobs.push(job);
    this.onChange(this);
    this.pump();
  }
  async pump() {
    if (this.running || this.error) return;
    this.running = true;
    while (this.jobs.length && !this.error) {
      try {
        await this.run(this.jobs[0]);
        this.jobs.shift();
      } catch (error) {
        this.error = error;
      }
      this.onChange(this);
    }
    this.running = false;
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters)
      this.error ? waiter.reject(this.error) : waiter.resolve();
  }
  drain() {
    if (this.error) return Promise.reject(this.error);
    if (!this.running && !this.jobs.length) return Promise.resolve();
    return new Promise((resolve, reject) =>
      this.waiters.push({ resolve, reject }),
    );
  }
  retry() {
    this.error = null;
    this.pump();
    return this.drain();
  }
}
export class BrowserASR {
  constructor(
    progress = () => {},
    factory = () =>
      // 带版本号：GitHub Pages 对 .mjs 有缓存，改了 worker 之后不带版本号
      // 用户那边还会跑旧代码。改 worker 时把这个数字加一。
      new Worker(new URL("./asr-worker.mjs?v=3", import.meta.url), {
        type: "module",
      }),
  ) {
    this.worker = factory();
    this.progress = progress;
    this.sequence = 0;
    this.pending = new Map();
    this.backend = "auto";
    this.model = "small";
    this.device = "";
    this.worker.onmessage = ({ data }) => {
      const task = this.pending.get(data.id);
      if (!task) return;
      if (data.type === "done") {
        this.pending.delete(data.id);
        this.device = data.device;
        task.resolve(data);
      } else if (data.type === "error") {
        this.pending.delete(data.id);
        task.reject(Error(data.message));
      } else this.progress(data);
    };
    this.worker.onerror = () => {
      this.failed = true;
      for (const task of this.pending.values())
        task.reject(Error("识别 Worker 已停止；音频仍在队列中，可下载恢复。"));
      this.pending.clear();
    };
  }
  send(action, payload = {}) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({
        id,
        action,
        backend: this.backend,
        model: this.model,
        ...payload,
      });
    });
  }
  load() {
    return this.send("load");
  }
  async recognize(job, language) {
    // Copy, not transfer ownership: the queue retains recoverable audio on errors.
    const result = await this.send("transcribe", {
      audio: job.audio.slice(),
      language,
    });
    return result;
  }
  dispose() {
    this.worker.terminate();
    for (const task of this.pending.values())
      task.reject(Error("识别已结束。"));
    this.pending.clear();
  }
}
export function captureOptions(sameTab = false) {
  return {
    video: true,
    audio: { suppressLocalAudioPlayback: false, restrictOwnAudio: false },
    preferCurrentTab: sameTab,
    selfBrowserSurface: sameTab ? "include" : "exclude",
    systemAudio: "exclude",
  };
}
export class TabCapture {
  constructor(onWindow, onElapsed = () => {}) {
    this.onWindow = onWindow;
    this.onElapsed = onElapsed;
    this.stream = null;
    this.stopping = null;
    this.samples = 0;
  }
  async start(
    getDisplayMedia = (options) =>
      navigator.mediaDevices.getDisplayMedia(options),
    sameTab = false,
  ) {
    if (!navigator.mediaDevices?.getDisplayMedia)
      throw Error(
        "此浏览器不支持标签页音频共享。请使用桌面 Chrome / Edge，或读取可跨域的音频链接。",
      );
    // This must happen directly inside the user's click, before model loading.
    try {
      this.stream = await getDisplayMedia(captureOptions(sameTab));
    } catch {
      throw Error(
        "音频共享未获授权。未开始采集，可以重新点击并选择视频标签页。",
      );
    }
    if (!this.stream.getAudioTracks().length) {
      this.stream.getTracks().forEach((t) => t.stop());
      throw Error(
        "没有收到标签页音频。请重试，选择视频标签页并勾选“共享标签页音频”。",
      );
    }
    try {
      this.context = new AudioContext({ sampleRate: 16000 });
      await this.context.audioWorklet.addModule(
        new URL("./audio-worklet.js", import.meta.url),
      );
      this.chunker = new AudioChunker(this.context.sampleRate);
      this.node = new AudioWorkletNode(this.context, "readvideo-pcm");
      this.silent = this.context.createGain();
      this.silent.gain.value = 0;
      this.source = this.context.createMediaStreamSource(
        new MediaStream(this.stream.getAudioTracks()),
      );
      this.node.port.onmessage = ({ data }) => {
        if (data.flushed) {
          this.flushDone?.();
          return;
        }
        if (!data.pcm) return;
        this.samples += data.pcm.length;
        for (const job of this.chunker.push(data.pcm)) this.onWindow(job);
        this.onElapsed(this.samples / this.context.sampleRate);
      };
      this.source.connect(this.node);
      this.node.connect(this.silent);
      this.silent.connect(this.context.destination);
      await this.context.resume();
      for (const track of this.stream.getTracks())
        track.addEventListener("ended", () => this.onEnded?.(), { once: true });
    } catch (error) {
      await this.stop();
      throw error;
    }
  }
  stop() {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      if (this.node && this.context?.state !== "closed") {
        await Promise.race([
          new Promise((resolve) => {
            this.flushDone = resolve;
            this.node.port.postMessage("flush");
          }),
          new Promise((resolve) => setTimeout(resolve, 300)),
        ]);
      }
      this.stream?.getTracks().forEach((t) => t.stop());
      this.source?.disconnect();
      this.node?.disconnect();
      this.silent?.disconnect();
      if (this.context && this.context.state !== "closed")
        await this.context.close();
      if (this.chunker)
        for (const job of this.chunker.push(new Float32Array(0), true))
          this.onWindow(job);
    })();
    return this.stopping;
  }
}
export function wavBlob(audio, rate = 16000) {
  const data = new ArrayBuffer(44 + audio.length * 2),
    view = new DataView(data),
    word = (at, text) => {
      for (let i = 0; i < text.length; i++)
        view.setUint8(at + i, text.charCodeAt(i));
    };
  word(0, "RIFF");
  view.setUint32(4, 36 + audio.length * 2, true);
  word(8, "WAVE");
  word(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  word(36, "data");
  view.setUint32(40, audio.length * 2, true);
  for (let i = 0; i < audio.length; i++)
    view.setInt16(
      44 + i * 2,
      Math.max(-1, Math.min(1, audio[i])) * 32767,
      true,
    );
  return new Blob([data], { type: "audio/wav" });
}
export { mergeTranscript };
