import { audioURL } from './download.mjs';
export function edgeEndpoint(value) {
  if (!value) return "";
  let url;
  try {
    url = new URL(value);
  } catch {
    throw Error("视频解析服务地址无效。");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["127.0.0.1", "localhost"].includes(url.hostname)
      ))
  )
    throw Error("视频解析服务需使用不含账号密码的 HTTPS 地址。");
  // 允许挂载在子路径下（例如 https://example.com/rv-resolve）。
  // 规范化：去掉尾部斜杠；根路径仍返回纯 origin，保持既有行为不变。
  const path = url.pathname.replace(/\/+$/, "");
  if (path && !/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/.test(path))
    throw Error("视频解析服务路径无效。");
  return url.origin + path;
}
export async function resolveThroughEdge(
  video,
  language,
  endpoint,
  fetcher = fetch,
) {
  const base = edgeEndpoint(endpoint);
  if (!base) throw Error("尚未配置视频解析服务。");
  const response = await fetcher(base + "/resolve", {
    method: "POST",
    mode: "cors",
    credentials: "omit",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: video, language, transport: 'direct-cdn' }),
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok)
    throw Error(
      response.status === 429
        ? "视频解析请求较频繁，请稍后再试。"
        : "视频解析服务暂时无法读取该链接，可重试或使用下方备用方式。",
    );
  const text = await response.text();
  if (text.length > 3_000_000) throw Error("视频解析响应超过上限。");
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw Error("视频解析响应无效。");
  }
  const title =
    typeof data.title === "string" ? data.title.slice(0, 1000) : "B站视频";
  if (data.kind === "captions" && Array.isArray(data.segments)) {
    const segments = data.segments.map((c) => ({
      start: Number(c.start),
      end: Number(c.end),
      text: typeof c.text === "string" ? c.text : "",
    }));
    if (
      !segments.length ||
      segments.some(
        (c) =>
          !Number.isFinite(c.start) ||
          !Number.isFinite(c.end) ||
          c.start < 0 ||
          c.end < c.start ||
          !c.text.trim(),
      )
    )
      throw Error("视频字幕响应无效。");
    return {
      kind: "captions",
      url: video,
      title,
      segments,
      language: data.language || "unknown",
      automatic: !!data.automatic,
      source: "cloudflare-captions",
    };
  }
  if (data.kind === "media") {
    if (data.transport === 'direct-cdn') {
      if(typeof data.id!=='string'||data.id.length>200||!Array.isArray(data.urls)||!data.urls.length||data.urls.length>4)throw Error('音轨响应无效。');
      return {kind:'media',transport:'direct-cdn',title,source_url:video,id:data.id,urls:data.urls.map(audioURL)};
    }
    let url;
    try {
      url = new URL(data.url);
    } catch {
      throw Error("音轨响应无效。");
    }
    if (
      url.origin !== base ||
      url.pathname !== "/media" ||
      !url.searchParams.get("ticket") ||
      url.username ||
      url.password
    )
      throw Error("音轨响应来源无效。");
    return {
      kind: "media",
      url: url.href,
      title,
      source_url: video,
      transport: "cloudflare",
    };
  }
  throw Error("视频解析响应无效。");
}
