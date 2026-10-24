import { parseCaptions } from "./core.mjs";

export function bilibiliVideo(value) {
  try {
    const url = new URL(value);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      !["bilibili.com", "www.bilibili.com", "m.bilibili.com"].includes(
        url.hostname,
      )
    )
      return null;
    const id = url.pathname.match(/^\/video\/(BV[\w]{10}|av\d+)(?:\/|$)/)?.[1];
    const part = Number(url.searchParams.get("p") || 1);
    if (!id || !Number.isSafeInteger(part) || part < 1) return null;
    return {
      ...(id.startsWith("av") ? { aid: id.slice(2) } : { bvid: id }),
      part,
    };
  } catch {
    return null;
  }
}

// JSONP is executable code: isolate it from the app, API keys and storage.
export function publicVideoInfo(video, timeout = 4500) {
  const query = new URLSearchParams(
    video.aid ? { aid: video.aid } : { bvid: video.bvid },
  );
  query.set("jsonp", "jsonp");
  query.set("callback", "__readvideoInfo");
  const target = "https://api.bilibili.com/x/web-interface/view?" + query;
  const token = crypto.randomUUID(),
    nonce = token.replaceAll("-", "");
  return new Promise((resolve, reject) => {
    const frame = document.createElement("iframe");
    frame.hidden = true;
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("aria-hidden", "true");
    const cleanup = () => {
      clearTimeout(timer);
      window.removeEventListener("message", receive);
      frame.remove();
    };
    const receive = (event) => {
      if (event.source !== frame.contentWindow || event.data?.token !== token)
        return;
      cleanup();
      if (event.data.error) reject(Error("公开视频信息暂不可读取。"));
      else resolve(event.data.payload);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(Error("读取公开视频信息超时。"));
    }, timeout);
    window.addEventListener("message", receive);
    frame.srcdoc = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' https://api.bilibili.com; base-uri 'none'; form-action 'none'"><script nonce="${nonce}">const token=${JSON.stringify(token)};window.__readvideoInfo=payload=>parent.postMessage({token,payload},'*');const script=document.createElement('script');script.referrerPolicy='no-referrer';script.onerror=()=>parent.postMessage({token,error:true},'*');script.src=${JSON.stringify(target)};document.head.append(script);${"<" + "/script>"}`;
    document.body.append(frame);
  });
}

async function readCaption(response) {
  const reader = response.body.getReader(),
    parts = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 3000000) {
      await reader.cancel();
      throw Error("字幕超过读取上限。");
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return new TextDecoder().decode(bytes);
}

export async function discoverBilibili(
  value,
  language = "auto",
  info = publicVideoInfo,
  fetcher = fetch,
) {
  const video = bilibiliVideo(value);
  if (!video) return null;
  let result;
  try {
    result = await info(video);
  } catch {
    return null;
  }
  if (result?.code !== 0 || !result.data) return null;
  const data = result.data,
    part = data.pages?.[video.part - 1];
  if (!part && video.part !== 1)
    return {
      kind: "capture",
      url: value,
      title: data.title,
      reason: "part-unavailable",
    };
  const title =
    data.title +
    (video.part > 1 ? " · " + (part.part || "P" + video.part) : "");
  const tracks = video.part === 1 ? [...(data.subtitle?.list || [])] : [];
  tracks.sort(
    (a, b) =>
      Number(!(language !== "auto" && a.lan?.startsWith(language))) -
      Number(!(language !== "auto" && b.lan?.startsWith(language))),
  );
  for (const track of tracks) {
    try {
      const url = new URL(track.subtitle_url, "https://www.bilibili.com");
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        !(url.hostname === "hdslb.com" || url.hostname.endsWith(".hdslb.com"))
      )
        continue;
      const response = await fetcher(url.href, {
        mode: "cors",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        redirect: "error",
        signal: AbortSignal.timeout(4500),
      });
      if (!response.ok) continue;
      return {
        kind: "captions",
        url: value,
        title,
        language: track.lan || "unknown",
        source: "bilibili-public-captions",
        automatic: track.lan?.startsWith("ai-") || false,
        segments: parseCaptions(await readCaption(response), "json"),
      };
    } catch {}
  }
  return {
    kind: "capture",
    url: value,
    title,
    reason: "public-captions-unavailable",
  };
}
