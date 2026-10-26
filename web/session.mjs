import {
  BrowserASR,
  TabCapture,
  SerialQueue,
  mergeTranscript,
  wavBlob,
} from "./audio.mjs";
import { decodeMedia, decodeAudioBytes, openSegmentStream, WINDOW_SECONDS, WINDOW_OVERLAP } from "./source.mjs";
import { fetchDirectAudio } from "./direct-audio.mjs";
import { openDownloadCache, openTranscriptCache, transcriptKey } from "./download.mjs";
export class ReadingSession {
  constructor({
    url,
    language = "auto",
    model = "small",
    backend = "auto",
    offset = 0,
    sameTab = false,
    onTranscript = () => {},
    onStatus = () => {},
    onProgress = () => {},
    onFinished = () => {},
    onError = () => {},
  }) {
    this.url = url;
    this.language = language;
    this.offset = offset;
    this.sameTab = sameTab;
    this.onStatus = onStatus;
    this.onTranscript = onTranscript;
    this.onFinished = onFinished;
    this.onError = onError;
    this.onProgress = onProgress;
    this.elapsed = 0;
    this.startedAt = 0;
    this.closed = false;
    this.downloadController = new AbortController();
    this.ended = false;
    this.modelReady = Promise.resolve();
    this.transcript = {
      title: url ? new URL(url).hostname + " · 浏览器转写" : "本地音频",
      url,
      segments: [],
      source: "browser-asr",
      automatic: true,
      language,
      requested_language: language,
      partial: true,
      timeline: "capture",
      uploader: "本机浏览器推理",
    };
    this.asr = new BrowserASR((p) => onProgress(p));
    this.asr.backend = backend;
    this.asr.model = model;
    this.model = model;
    this.queue = new SerialQueue(
      async (job) => {
        // 文字缓存：同一个视频、同一个窗口，转过就不再重跑。
        const meta = this.cacheMeta;
        const key = meta
          ? transcriptKey({ ...meta, windowStart: job.offset })
          : null;
        let saved;
        if (key) {
          try {
            saved = await this.checkpoints?.get(key);
          } catch {}
        }

        await this.modelReady;
        let power = 0;
        for (const sample of job.audio) power += sample * sample;
        if (power === 0) return;

        let result;
        if (saved && Array.isArray(saved.chunks) && saved.chunks.length) {
          result = saved;
          this.cacheHits = (this.cacheHits || 0) + 1;
        } else {
          result = await this.asr.recognize(job, this.language);
          if (key && (result.text || "").trim()) {
            try {
              await this.checkpoints?.put(key, {
                text: result.text,
                chunks: result.chunks,
                start: job.offset,
                end: job.keepUntil,
                ...meta,
              });
            } catch {}
          }
        }

        const shifted = {
          offset: job.offset + this.offset,
          keepFrom: job.keepFrom + this.offset,
          keepUntil: job.keepUntil + this.offset,
        };
        this.transcript.segments = mergeTranscript(
          this.transcript.segments,
          result.chunks,
          shifted,
        );
        this.transcript.duration = this.elapsed;
        this.onTranscript(this.transcript);
        this.status();
      },
      () => {
        this.status();
        if (this.queue.error && !this.ended) {
          this.finish().catch(() => {});
        }
      },
    );
  }
  status(extra = "") {
    const now = Date.now();
    const pending = this.queue.pendingSeconds;
    // 用实测吞吐推算剩余时间，比固定倍率靠谱（不同设备差很多）
    const done = Math.max(0, this.elapsed - pending);
    const spent = (now - (this.startedAt || now)) / 1000;
    const eta =
      done > 5 && spent > 5 && pending > 0
        ? Math.round((pending / (done / spent)))
        : null;
    this.onStatus({
      elapsed: this.elapsed,
      pending,
      eta,
      device: this.asr.device,
      error: this.queue.error,
      ended: this.ended,
      ...(extra ? { message: extra } : {}),
    });
  }
  add(job) {
    if (this.closed) return;
    this.queue.add(job);
    if (this.queue.pendingSeconds >= 1200 && this.capture && !this.ended) {
      this.status(
        "待处理音频达到 20 分钟，已停止继续采集，现有音频会全部处理。",
      );
      this.finish().catch(() => {});
    }
  }
  async startCapture() {
    this.capture = new TabCapture(
      (job) => this.add(job),
      (elapsed) => {
        this.elapsed = elapsed;
        this.status();
      },
    );
    this.capture.onEnded = () => this.finish().catch(() => {});
    try {
      await this.capture.start(undefined, this.sameTab);
      this.modelReady = this.asr.load();
      this.modelReady.catch(() => {});
      this.status("正在准备模型，可以开始播放视频。采集中的音频会排队保留。");
      await this.modelReady;
      this.status(
        this.ended
          ? "模型已准备好，正在处理已采集音频。"
          : "模型已准备好，正在采集视频标签页音频。",
      );
    } catch (error) {
      await this.capture.stop();
      this.ended = true;
      this.onError(error);
      throw error;
    }
  }
  async startMedia(progress, mediaURL = this.url) {
    this.transcript.timeline = "media";
    this.modelReady = this.asr.load();
    this.modelReady.catch(() => {});
    this.startedAt = Date.now();
    this.ended = true;

    // 直链音轨：优先走分段流式（内存与视频长度无关）。
    // 不是 fMP4 或解析不出 sidx 时退回整段路径。
    if (typeof mediaURL === "object") {
      // 缓存键用人类可读的视频 ID（BV 号），拿不到就退回解析服务给的稳定哈希
      const vid = (String(this.url).match(/BV[\w]{10}/) || [])[0] || mediaURL.id;
      this.cacheMeta = {
        platform: "bilibili",
        videoId: vid,
        model: this.model || "small",
        language: this.language,
        title: this.transcript.title || "",
        durationSec: 0,
      };
      try {
        this.checkpoints = await openTranscriptCache();
      } catch {}

      const stream = await openSegmentStream(
        mediaURL,
        progress,
        this.downloadController.signal,
      );
      if (stream) {
        this.cacheMeta.durationSec = Math.round(stream.totalSeconds);
        this.transcript.duration = stream.totalSeconds;
        this.status(`音频分 ${stream.groups} 段处理，内存占用恒定。`);
        for await (const batch of stream) {
          this.elapsed = batch.total;
          for (const job of batch.jobs) this.add(job);
        }
        await this.finish();
        return;
      }

      const bytes = await fetchDirectAudio(
        mediaURL,
        progress,
        this.downloadController.signal,
      );
      progress("音轨已完整下载 · 正在本机解码", 26);
      const jobs = await decodeAudioBytes(bytes);
      this.elapsed = jobs.at(-1)?.keepUntil || 0;
      for (const job of jobs) this.add(job);
      await this.finish();
      return;
    }

    const jobs = await decodeMedia(mediaURL, progress);
    this.elapsed = jobs.at(-1)?.keepUntil || 0;
    for (const job of jobs) this.add(job);
    await this.finish();
  }
  async startFile(file) {
    if (!file.size || file.size > 128000000)
      throw Error("音频文件需在 128 MB 以内，且不能为空。");
    this.transcript.timeline = "media";
    this.transcript.title = file.name.replace(/\.[^.]+$/, "");
    this.transcript.input = "audio-file";
    const jobs = await decodeAudioBytes(
      new Uint8Array(await file.arrayBuffer()),
    );
    this.modelReady = this.asr.load();
    this.modelReady.catch(() => {});
    this.elapsed = jobs.at(-1)?.keepUntil || 0;
    this.ended = true;
    for (const job of jobs) this.add(job);
    await this.finish();
  }
  finish() {
    if (this.finishing) return this.finishing;
    this.finishing = (async () => {
      this.ended = true;
      await this.capture?.stop();
      this.status(this.transcript.timeline==='media'?'完整音轨已就绪，正在本机转写。':'采集已停止，正在处理剩余音频。');
      try {
        await this.modelReady;
        await this.queue.drain();
        if (!this.transcript.segments.length)
          throw Error(
            "没有识别到可用语音。请确认共享了视频标签页音频，并在采集期间播放了视频。",
          );
        this.transcript.partial = false;
        this.onTranscript(this.transcript);
        this.asr.dispose();
        this.checkpoints?.close();
        await this.onFinished(this.transcript);
      } catch (error) {
        this.status();
        this.onError(error);
        throw error;
      }
    })();
    return this.finishing;
  }
  async retryCPU() {
    if (this.asr.failed) {
      this.asr.dispose();
      this.asr = new BrowserASR(this.onProgress);
    }
    this.asr.backend = "cpu";
    this.modelReady = this.asr.load();
    await this.modelReady;
    await this.queue.retry();
    this.finishing = null;
    return this.finish();
  }
  recoveryFiles() {
    if (!this.queue.jobs.length) return [];
    const pieces = this.queue.jobs.map((job) =>
      job.audio.subarray(
        Math.round((job.keepFrom - job.offset) * 16000),
        Math.round((job.keepUntil - job.offset) * 16000),
      ),
    );
    const audio = new Float32Array(pieces.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const piece of pieces) {
      audio.set(piece, at);
      at += piece.length;
    }
    return [{ name: "readvideo-pending-audio.wav", blob: wavBlob(audio) }];
  }
  close() {
    this.closed = true;
    this.downloadController.abort();
    this.capture?.stop();
    this.asr.dispose();
    this.checkpoints?.close();
  }
}
