import { parseCaptions, windowAudio } from "./core.mjs";
import { bilibiliVideo, discoverBilibili } from "./bilibili.mjs";
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
