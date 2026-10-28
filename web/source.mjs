import { parseCaptions, windowAudio } from "./core.mjs";
import { bilibiliVideo, discoverBilibili } from "./bilibili.mjs";
import { openAudioBridge } from "./direct-audio.mjs";
import { parseSegmentIndex, groupFragments } from "./mp4-segment.mjs";
export function embeddedPlayer(value) {
  const url = sourceURL(value),
    host = url.hostname.toLowerCase();
  if (
    [
      "youtube.com",
      "www.youtube.com",
      "m.youtube.com",
      "youtu.be",
      "www.youtu.be",
    ].includes(host)
  ) {
    const id = host.endsWith("youtu.be")
      ? url.pathname.slice(1).split("/")[0]
      : url.searchParams.get("v") ||
        url.pathname.match(/^\/(?:embed|shorts)\/([^/]+)/)?.[1];
    if (!/^[\w-]{11}$/.test(id || "")) return null;
    return {
      platform: "YouTube",
      url:
        "https://www.youtube-nocookie.com/embed/" +
        id +
        "?playsinline=1&autoplay=0",
    };
  }
  if (["bilibili.com", "www.bilibili.com", "m.bilibili.com"].includes(host)) {
    const id = url.pathname.match(/^\/video\/(BV[\w]{10}|av\d+)(?:\/|$)/)?.[1];
    if (!id) return null;
    return {
      platform: "Bilibili",
      url:
        "https://player.bilibili.com/player.html?" +
        (id.startsWith("av") ? "aid=" + id.slice(2) : "bvid=" + id) +
        (Number(url.searchParams.get("p")) > 1 &&
        Number.isSafeInteger(Number(url.searchParams.get("p")))
          ? "&page=" + Number(url.searchParams.get("p"))
          : "") +
        "&autoplay=0",
    };
  }
  return null;
}
export function sourceURL(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw Error("请粘贴有效的视频或音频链接。");
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw Error("只支持不包含账号密码的 HTTP(S) 链接。");
  return url;
}
async function readText(response, max = 3000000) {
  const reader = response.body.getReader(),
    parts = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      throw Error("内容超过字幕读取上限。");
    }
    parts.push(value);
  }
  const data = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    data.set(part, at);
    at += part.length;
  }
  return new TextDecoder().decode(data);
}
function playerJSON(html) {
  const marker = /ytInitialPlayerResponse\s*=\s*/g,
    match = marker.exec(html);
  if (!match) return null;
  const start = html.indexOf("{", match.index + match[0].length);
  let depth = 0,
    string = false,
    escape = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (string) {
      if (escape) escape = false;
      else if (c === "\\") escape = true;
      else if (c === '"') string = false;
    } else if (c === '"') string = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try {
        return JSON.parse(html.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}
export async function discoverSource(
  value,
  language = "auto",
  fetcher = fetch,
) {
  const url = sourceURL(value),
    ext = url.pathname.split(".").pop().toLowerCase();
  if (typeof document !== "undefined" && bilibiliVideo(value)) {
    const publicSource = await discoverBilibili(
      value,
      language,
      undefined,
      fetcher,
    );
    if (publicSource) return publicSource;
  }
  if (["wav", "mp3", "ogg", "m4a", "mp4", "webm", "flac"].includes(ext))
    return { kind: "media", url: url.href };
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), 6000);
  const request = (target) =>
    fetcher(target, {
      mode: "cors",
      credentials: "omit",
      signal: controller.signal,
      redirect: "follow",
    });
  try {
    const response = await request(url.href);
    if (!response.ok) throw Error();
    const type = response.headers.get("content-type") || "";
    if (/^(audio|video)\//i.test(type)) return { kind: "media", url: url.href };
    const text = await readText(response);
    if (
      ["srt", "vtt", "json", "json3"].includes(ext) ||
      /text\/vtt|application\/json/.test(type)
    ) {
      const format =
        ext === "json3"
          ? "json3"
          : ext === "srt"
            ? "srt"
            : type.includes("json") || ext === "json"
              ? "json"
              : "vtt";
      return {
        kind: "captions",
        title: decodeURIComponent(url.pathname.split("/").pop()) || "字幕链接",
        url: "",
        segments: parseCaptions(text, format),
        language,
        source: "direct-captions",
        automatic: false,
      };
    }
    const pageURL = response.url ? sourceURL(response.url) : url;
    const document = new DOMParser().parseFromString(text, "text/html");
    let tracks = [...document.querySelectorAll("track[src]")]
      .filter((t) => ["captions", "subtitles"].includes(t.kind || "subtitles"))
      .map((t) => ({
        url: new URL(t.getAttribute("src"), pageURL).href,
        language: t.srclang,
        ext: "vtt",
      }));
    const player = playerJSON(text),
      youtubeTracks =
        player?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    tracks.push(
      ...youtubeTracks.map((t) => ({
        url: t.baseUrl + "&fmt=json3",
        language: t.languageCode,
        ext: "json3",
      })),
    );
    tracks.sort(
      (a, b) =>
        Number(!(language !== "auto" && a.language?.startsWith(language))) -
        Number(!(language !== "auto" && b.language?.startsWith(language))),
    );
    for (const track of tracks) {
      try {
        const r = await request(sourceURL(track.url).href);
        if (r.ok) {
          const segments = parseCaptions(await readText(r), track.ext);
          return {
            kind: "captions",
            title: player?.videoDetails?.title || document.title || "视频字幕",
            url: url.href,
            segments,
            language: track.language || "unknown",
            source: "direct-captions",
            automatic: !!track.automatic,
          };
        }
      } catch {}
    }
    // HTML is parsed inertly. Only explicit, CORS-readable media is eligible.
    const candidates = [
      ...document.querySelectorAll("audio[src], audio source[src]"),
      ...document.querySelectorAll("video[src], video source[src]"),
    ];
    const seen = new Set();
    for (const element of candidates) {
      try {
        const target = sourceURL(
          new URL(element.getAttribute("src"), pageURL).href,
        ).href;
        if (seen.has(target)) continue;
        seen.add(target);
        const media = await request(target);
        const readable =
          media.ok &&
          /^(audio|video)\//i.test(media.headers.get("content-type") || "");
        await media.body?.cancel();
        if (readable)
          return {
            kind: "media",
            url: target,
            source_url: url.href,
            title: document.title || "视频转写",
          };
      } catch {}
    }
  } catch {
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return { kind: "capture", url: url.href };
}
export async function decodeMedia(value, progress = () => {}, fetcher = fetch) {
  const url = sourceURL(value),
    response = await fetcher(url.href, {
      mode: "cors",
      credentials: "omit",
      signal: AbortSignal.timeout(120000),
    });
  if (!response.ok)
    throw Error("无法读取音频直链。平台页面请改用标签页音频授权。");
  const reader = response.body.getReader(),
    parts = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 128000000) {
      await reader.cancel();
      throw Error("音频文件超过 128 MB，请分段处理或使用标签页采集。");
    }
    parts.push(value);
    progress(`正在读取音频 · ${(size / 1000000).toFixed(1)} MB`, 10);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return decodeAudioBytes(bytes);
}
export async function decodeAudioBytes(bytes) {
  if (!bytes.byteLength || bytes.byteLength > 128000000)
    throw Error("音频文件需在 128 MB 以内，且不能为空。");
  const context = new AudioContext({sampleRate:16000});
  try {
    const buffer=bytes.byteOffset===0&&bytes.byteLength===bytes.buffer.byteLength?bytes.buffer:bytes.slice().buffer;
    const decoded = await context.decodeAudioData(buffer);
    if (decoded.duration > 7200)
      throw Error(
        `音频 ${Math.round(decoded.duration / 60)} 分钟，超过 2 小时上限。` +
          "浏览器需要把整段音频放进内存解码，更长的内容请先裁剪。没有截断原音频。",
      );
    const mono = new Float32Array(decoded.length);
    for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
      const data = decoded.getChannelData(ch);
      for (let i = 0; i < mono.length; i++)
        mono[i] += data[i] / decoded.numberOfChannels;
    }
    if(decoded.sampleRate===16000)return windowAudio(mono,16000);
    return windowAudio(mono, decoded.sampleRate).map((job) => ({
      ...job,
      audio: resampleMedia(job.audio, decoded.sampleRate),
    }));
  } finally {
    await context.close();
  }
}
function resampleMedia(input, from) {
  const length = Math.round((input.length * 16000) / from),
    out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const pos = (i * from) / 16000,
      lo = Math.floor(pos),
      hi = Math.min(lo + 1, input.length - 1);
    out[i] = input[lo] * (1 - pos + lo) + input[hi] * (pos - lo);
  }
  return out;
}

// ───────────────────────── 分段转录 ─────────────────────────

/** 窗口长度。Whisper 编码器输入固定 30 秒，用 30 秒窗口不浪费算力。 */
export const WINDOW_SECONDS = 30;
export const WINDOW_OVERLAP = 2;
/** 每段音频多少秒。5 分钟 ≈ 3 MB 文件 + 57 MB 内存。 */
export const CHUNK_SECONDS = 300;

function mixdown(decoded) {
  const mono = new Float32Array(decoded.length);
  const channels = decoded.numberOfChannels;
  for (let ch = 0; ch < channels; ch++) {
    const data = decoded.getChannelData(ch);
    for (let i = 0; i < mono.length; i++) mono[i] += data[i] / channels;
  }
  return mono;
}

/** 把一个已解码的 AudioBuffer 切成窗口任务，时间偏移到全局时间轴上。 */
function bufferToJobs(decoded, baseSeconds) {
  const mono = mixdown(decoded);
  const rate = decoded.sampleRate;
  let jobs = windowAudio(mono, rate, WINDOW_SECONDS, WINDOW_OVERLAP);
  if (rate !== 16000)
    jobs = jobs.map((job) => ({ ...job, audio: resampleMedia(job.audio, rate) }));
  return jobs.map((job) => ({
    ...job,
    offset: job.offset + baseSeconds,
    keepFrom: job.keepFrom + baseSeconds,
    keepUntil: job.keepUntil + baseSeconds,
  }));
}

/** 解码一段独立的 MP4（初始化段 + 若干片段），不设时长上限。 */
async function decodeChunk(bytes) {
  const context = new AudioContext({ sampleRate: 16000 });
  try {
    const buffer =
      bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
        ? bytes.buffer
        : bytes.slice().buffer;
    return await context.decodeAudioData(buffer);
  } finally {
    await context.close();
  }
}

/**
 * 分段流式读取 + 解码。产出的每一批窗口任务对应一段音频，
 * 消费方处理完这一批之后，这一段的 PCM 就可以回收。
 *
 * 不是 fMP4 或没有 sidx 时返回 null，调用方退回整段路径。
 *
 * @param {{url:string, urls:string[], id:string}} source
 * @param {(text:string, percent:number)=>void} progress
 * @param {AbortSignal} [signal]
 * @returns {AsyncGenerator<{jobs:Array, seconds:number, done:number, total:number}>|null}
 */
export async function openSegmentStream(source, progress = () => {}, signal) {
  // 解析服务返回的是 { urls: [...] }，没有单数 url 字段。
  // 多个地址按顺序轮换，某一个 CDN 主机抽风时能自动换下一个。
  const urls = (source.urls?.length ? source.urls : [source.url]).filter(Boolean);
  if (!urls.length) throw Error("音轨地址为空。");
  let active = 0;

  const bridge = await openAudioBridge(signal);
  let closed = false;

  /** 带轮换的区间读取：失败一次就换下一个地址重试。 */
  const read = async (start, end) => {
    let lastError;
    for (let attempt = 0; attempt < Math.max(2, urls.length); attempt++) {
      try {
        return await bridge.read(urls[active % urls.length], start, end);
      } catch (error) {
        lastError = error;
        active++; // 下次换一个 CDN 主机
      }
    }
    throw lastError;
  };

  const release = () => {
    if (closed) return;
    closed = true;
    bridge.close();
  };
  signal?.addEventListener("abort", release, { once: true });

  try {
    progress("正在读取音频索引", 8);
    const head = await read(0, 262143);
    const index = parseSegmentIndex(head);
    if (!index) {
      release();
      return null;
    }

    const groups = groupFragments(index.fragments, CHUNK_SECONDS);
    const totalSeconds = groups.reduce((n, g) => n + g.seconds, 0);
    const init = head.slice(0, index.initBytes);
    let done = 0;

    return {
      groups: groups.length,
      totalSeconds,
      close: release,
      async *[Symbol.asyncIterator]() {
        try {
          for (let i = 0; i < groups.length; i++) {
            if (signal?.aborted) throw signal.reason || Error("已取消。");
            const group = groups[i];
            progress(
              `正在读取第 ${i + 1} / ${groups.length} 段`,
              10 + Math.round((20 * done) / totalSeconds),
            );

            const body = await read(group.startByte, group.endByte - 1);
            const merged = new Uint8Array(init.length + body.length);
            merged.set(init, 0);
            merged.set(body, init.length);

            const decoded = await decodeChunk(merged);
            // 预期时长来自 sidx；对不上说明片段边界算错了
            const drift = Math.abs(decoded.duration - group.seconds);
            if (drift > 2)
              throw Error(
                `第 ${i + 1} 段解码时长 ${decoded.duration.toFixed(1)}s 与索引 ${group.seconds.toFixed(1)}s 不符，已停止。`,
              );

            const jobs = bufferToJobs(decoded, group.offset);
            done += group.seconds;
            yield { jobs, seconds: decoded.duration, done, total: totalSeconds };
          }
        } finally {
          release();
        }
      },
    };
  } catch (error) {
    release();
    throw error;
  }
}
