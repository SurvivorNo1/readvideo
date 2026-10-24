import { createHash } from "node:crypto";
const MAX_AUDIO = 32_000_000;
// Extract JSON data only; never execute source-page JavaScript.
export function pageJSON(html, name) {
  const marker = new RegExp(`(?:window\\.)?${name}\\s*=\\s*`).exec(html);
  if (!marker) return null;
  const start = marker.index + marker[0].length;
  if (html[start] !== "{") return null;
  let depth = 0,
    quoted = false,
    escaped = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
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
class Failure extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export function videoIdentity(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Failure(400, "请提供有效的B站视频链接。");
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    !["www.bilibili.com", "bilibili.com", "m.bilibili.com"].includes(
      url.hostname,
    )
  )
    throw new Failure(400, "当前解析服务只支持B站视频链接。");
  const id = url.pathname.match(/^\/video\/(BV[\w]{10}|av\d+)(?:\/|$)/)?.[1],
    part = Number(url.searchParams.get("p") || 1);
  if (!id || !Number.isSafeInteger(part) || part < 1)
    throw new Failure(400, "视频编号或分P无效。");
  return {
    ...(id.startsWith("av") ? { aid: id.slice(2) } : { bvid: id }),
    part,
  };
}
export function mediaTarget(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Failure(502, "音轨地址无效。");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !["bilivideo.com", "bilivideo.cn"].some(
      (host) => url.hostname === host || url.hostname.endsWith("." + host),
    )
  )
    throw new Failure(502, "音轨来源不在支持范围。");
  return url;
}
function subtitleTarget(value) {
  const url = new URL(value, "https://www.bilibili.com");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !(url.hostname === "hdslb.com" || url.hostname.endsWith(".hdslb.com"))
  )
    throw new Failure(502, "字幕来源不在支持范围。");
  return url;
}
export function parseRange(value) {
  if (!value) return null;
  const m = /^bytes=(\d+)-(\d+)$/.exec(value);
  if (!m) throw new Failure(416, "只支持单个明确的音频字节范围。");
  const start = Number(m[1]),
    end = Number(m[2]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    end >= MAX_AUDIO
  )
    throw new Failure(416, "音频字节范围超出限制。");
  return { start, end };
}
const encode = (bytes) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
const decode = (value) =>
  Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (c) =>
    c.charCodeAt(0),
  );
async function hmacKey(secret) {
  if (!secret || secret.length < 32)
    throw new Failure(503, "视频解析服务尚未配置完成。");
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}
export async function signTicket(payload, secret) {
  const body = encode(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    new TextEncoder().encode(body),
  );
  return body + "." + encode(new Uint8Array(signature));
}
export async function verifyTicket(token, secret, now = Date.now()) {
  try {
    if (typeof token !== "string" || token.length > 18000) throw Error();
    const [body, signature, extra] = token.split(".");
    if (!body || !signature || extra) throw Error();
    const valid = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret),
      decode(signature),
      new TextEncoder().encode(body),
    );
    if (!valid) throw Error();
    const payload = JSON.parse(new TextDecoder().decode(decode(body)));
    if (!Number.isFinite(payload.exp) || payload.exp <= now) throw Error();
    mediaTarget(payload.url);
    return payload;
  } catch {
    throw new Failure(403, "音轨凭证无效或已过期，请重新读取链接。");
  }
}
async function limitedText(response, maximum = 3_000_000) {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Failure(502, "平台暂时拒绝读取，请稍后重试。");
  }
  const reader = response.body.getReader(),
    parts = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maximum) {
      await reader.cancel();
      throw new Failure(502, "平台返回内容超过读取上限。");
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return new TextDecoder().decode(out);
}
const platformHeaders = () =>
  new Headers({
    Referer: "https://www.bilibili.com/",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
  });
// Protocol signature reconstructed from the public WBI parameter format.
function wbi(params, img, sub) {
  const order = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
    33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
    61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
    36, 20, 34, 44, 52,
  ];
  const source = img + sub;
  if (source.length < 64) throw new Failure(502, "平台签名信息暂不可用。");
  const key = order
    .map((i) => source[i])
    .join("")
    .slice(0, 32);
  const query = new URLSearchParams();
  for (const name of Object.keys(params).sort())
    query.set(name, String(params[name]).replace(/[!'()*]/g, ""));
  const text = query.toString();
  query.set(
    "w_rid",
    createHash("md5")
      .update(text + key)
      .digest("hex"),
  );
  return query;
}
export function createWorker({ fetcher = fetch, now = () => Date.now() } = {}) {
  async function api(path, params, anonymousCookie = "") {
    const url = new URL("https://api.bilibili.com" + path);
    url.search = new URLSearchParams(params);
    const jsonp = ["/x/web-interface/view", "/x/web-interface/nav"].includes(
      path,
    );
    if (jsonp) {
      url.searchParams.set("jsonp", "jsonp");
      url.searchParams.set("callback", "__readvideoPublic");
    }
    const headers = platformHeaders();
    if (anonymousCookie) headers.set("Cookie", anonymousCookie);
    const response = await fetcher(url.href, {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Failure(
        502,
        `平台接口 ${path.split("/").pop()} 拒绝读取（HTTP ${response.status}），请稍后重试。`,
      );
    }
    try {
      const text = (await limitedText(response)).trim();
      const wrapped = jsonp && /^__readvideoPublic\(([\s\S]*)\);?$/.exec(text);
      return JSON.parse(wrapped ? wrapped[1] : text);
    } catch (e) {
      if (e instanceof Failure) throw e;
      throw new Failure(502, "平台响应暂不可解析。");
    }
  }
  async function safeFetch(value, validator, range) {
    let target = validator(value);
    for (let attempt = 0; attempt < 3; attempt++) {
      const headers = platformHeaders();
      if (range) headers.set("Range", `bytes=${range.start}-${range.end}`);
      const response = await fetcher(target.href, {
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(20000),
      });
      if (response.status >= 300 && response.status < 400) {
        const next = response.headers.get("Location");
        await response.body?.cancel();
        if (!next) break;
        target = validator(new URL(next, target).href);
        continue;
      }
      return response;
    }
    throw new Failure(502, "平台重定向次数超出限制。");
  }
  async function resolve(input, request, env) {
    const identity = videoIdentity(input.url),
      query = identity.aid ? { aid: identity.aid } : { bvid: identity.bvid };
    let view,
      embeddedPlay,
      anonymousCookie = "",
      initializationError;
    const readApi = (path, params) => api(path, params, anonymousCookie);
    let wbiKeys;
    const signedApi = async (path, params) => {
      if (!wbiKeys) {
        const nav = await readApi("/x/web-interface/nav", {});
        const keys = nav.data?.wbi_img;
        const extract = (value) =>
          new URL(value).pathname.split("/").pop().split(".")[0];
        if (!keys?.img_url || !keys?.sub_url)
          throw new Failure(502, "平台签名信息暂不可用。");
        wbiKeys = [extract(keys.img_url), extract(keys.sub_url)];
      }
      return readApi(
        path,
        Object.fromEntries(
          wbi({ ...params, wts: Math.round(now() / 1000) }, ...wbiKeys),
        ),
      );
    };
    try {
      view = await readApi("/x/web-interface/view", query);
    } catch (apiFailure) {
      // A platform-issued anonymous session is independent of the visitor's account.
      try {
        const session = await api("/x/frontend/finger/spi", {});
        const id = session.data?.b_3;
        if (typeof id === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(id)) {
          anonymousCookie = "buvid3=" + id;
          view = await readApi("/x/web-interface/view", query);
        }
      } catch (error) {
        initializationError = error;
      }
      if (!view?.data) {
        try {
          const detail = await signedApi(
            "/x/web-interface/wbi/view/detail",
            query,
          );
          if (detail.code === 0 && detail.data?.View)
            view = { code: 0, data: detail.data.View };
        } catch (error) {
          initializationError = error;
        }
      }
      if (!view?.data) {
        const video = new URL(
          `https://www.bilibili.com/video/${identity.bvid || "av" + identity.aid}/`,
        );
        if (identity.part > 1) video.searchParams.set("p", identity.part);
        const response = await fetcher(video.href, {
          headers: platformHeaders(),
          redirect: "manual",
          signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Failure(
            502,
            `${apiFailure.message} 视频页读取亦被拒绝（HTTP ${response.status}）。${initializationError ? " 匿名初始化：" + initializationError.message : ""}`,
          );
        }
        const html = await limitedText(response);
        const state = pageJSON(html, "__INITIAL_STATE__");
        const data = state?.videoData;
        if (!data?.bvid || !data?.cid) throw apiFailure;
        view = { code: 0, data };
        // The page's selected cid must match before its embedded audio is used.
        const page = data.pages?.[identity.part - 1];
        if (
          (identity.part === 1 && (!page || page.cid === data.cid)) ||
          page?.cid === state.cid
        )
          embeddedPlay = pageJSON(html, "__playinfo__");
      }
    }
    const data = view?.data;
    if (view.code !== 0 || !data)
      throw new Failure(422, "无法读取该视频；可能已下架或存在访问限制。");
    const page =
      data.pages?.[identity.part - 1] ||
      (identity.part === 1 && data.cid ? { cid: data.cid } : null);
    if (!page?.cid) throw new Failure(422, "没有找到指定分P。");
    if (Number(page.duration || data.duration) > 3600)
      throw new Failure(422, "暂支持一小时以内的视频，请选择较短分P。");
    const bvid = data.bvid,
      title =
        (data.title || "B站视频") +
        (identity.part > 1 ? " · " + (page.part || "P" + identity.part) : "");
    let tracks = identity.part === 1 ? data.subtitle?.list || [] : [];
    if (!tracks.length) {
      try {
        const player = await readApi("/x/player/v2", { bvid, cid: page.cid });
        tracks = player.data?.subtitle?.subtitles || [];
      } catch {}
    }
    tracks = [...tracks].sort(
      (a, b) =>
        Number(
          !(
            input.language &&
            input.language !== "auto" &&
            a.lan?.startsWith(input.language)
          ),
        ) -
        Number(
          !(
            input.language &&
            input.language !== "auto" &&
            b.lan?.startsWith(input.language)
          ),
        ),
    );
    for (const track of tracks.slice(0, 2)) {
      try {
        const response = await safeFetch(track.subtitle_url, subtitleTarget),
          json = JSON.parse(await limitedText(response));
        const segments = (json.body || [])
          .map((c) => ({
            start: Number(c.from),
            end: Number(c.to),
            text: String(c.content || ""),
          }))
          .filter(
            (c) =>
              Number.isFinite(c.start) &&
              Number.isFinite(c.end) &&
              c.start >= 0 &&
              c.end >= c.start &&
              c.text.trim(),
          );
        if (segments.length)
          return {
            kind: "captions",
            url: input.url,
            title,
            segments,
            language: track.lan || "unknown",
            automatic: track.lan?.startsWith("ai-") || false,
            source: "cloudflare-captions",
          };
      } catch {}
    }
    const params = {
      bvid,
      cid: page.cid,
      fnval: "16",
      fnver: "0",
      qn: "16",
      fourk: "0",
    };
    let play = embeddedPlay;
    if (!play?.data?.dash?.audio?.length)
      try {
        play = await readApi("/x/player/playurl", params);
      } catch {}
    if (play?.code !== 0 || !play.data?.dash?.audio?.length) {
      play = await signedApi("/x/player/wbi/playurl", params);
    }
    const audios = (play?.data?.dash?.audio || [])
      .filter((a) => !a.mimeType || a.mimeType.startsWith("audio/mp4"))
      .sort((a, b) => (a.bandwidth || 0) - (b.bandwidth || 0));
    const urls = audios
      .flatMap((a) => [
        a.baseUrl || a.base_url,
        ...(a.backupUrl || a.backup_url || []),
      ])
      .filter(Boolean);
    let selected;
    for (const url of urls.slice(0, 4)) {
      try {
        const target = mediaTarget(url),
          r = await safeFetch(target.href, mediaTarget, {
            start: 0,
            end: 1023,
          });
        const size = r.headers.get("Content-Range")?.match(/\/(\d+)$/)?.[1];
        const type = r.headers.get("Content-Type") || "";
        const ok =
          r.ok &&
          !/text|json|html/i.test(type) &&
          (!size || Number(size) <= MAX_AUDIO);
        await r.body?.cancel();
        if (ok) {
          selected = target.href;
          break;
        }
      } catch {}
    }
    if (!selected)
      throw new Failure(
        422,
        "Cloudflare 当前无法读取此视频音轨，可能受节点、地区或平台限制。",
      );
    const token = await signTicket(
      { url: selected, exp: now() + 15 * 60 * 1000, bvid, cid: page.cid },
      env.MEDIA_SECRET,
    );
    const media = new URL("/media", request.url);
    media.searchParams.set("ticket", token);
    return {
      kind: "media",
      url: media.href,
      title,
      source_url: input.url,
      transport: "cloudflare",
      maximum_bytes: MAX_AUDIO,
    };
  }
  return {
    async fetch(request, env) {
      const url = new URL(request.url),
        origin = request.headers.get("Origin");
      const allowed = (env.ALLOWED_ORIGINS || "https://survivorno1.github.io")
        .split(",")
        .map((x) => x.trim());
      const headers = new Headers({
        "Cache-Control": "no-store",
        Vary: "Origin",
        "Access-Control-Expose-Headers":
          "Content-Length,Content-Range,Accept-Ranges",
        "X-Content-Type-Options": "nosniff",
      });
      if (origin && allowed.includes(origin))
        headers.set("Access-Control-Allow-Origin", origin);
      const json = (body, status = 200) =>
        Response.json(body, { status, headers });
      if (url.pathname === "/health")
        return json({
          service: "readvideo-bilibili",
          configured: !!env.MEDIA_SECRET,
          max_audio_bytes: MAX_AUDIO,
        });
      if (!origin || !allowed.includes(origin))
        return json({ error: "此网页未获准使用视频解析服务。" }, 403);
      if (request.method === "OPTIONS") {
        headers.set("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
        headers.set("Access-Control-Allow-Headers", "Content-Type, Range");
        return new Response(null, { status: 204, headers });
      }
      try {
        await hmacKey(env.MEDIA_SECRET);
        if (!env.BILI_LIMIT)
          throw new Failure(503, "视频解析服务的访问限制尚未配置。");
        if (
          !(
            await env.BILI_LIMIT.limit({
              key: request.headers.get("CF-Connecting-IP") || "unknown",
            })
          ).success
        )
          throw new Failure(429, "请求较频繁，请稍后重试。");
        if (url.pathname === "/resolve" && request.method === "POST") {
          if (
            !request.headers.get("Content-Type")?.startsWith("application/json")
          )
            throw new Failure(415, "请求格式无效。");
          const input = JSON.parse(
            await limitedText(new Response(request.body), 8192),
          );
          return json(await resolve(input, request, env));
        }
        if (url.pathname === "/media" && request.method === "GET") {
          const ticket = await verifyTicket(
              url.searchParams.get("ticket"),
              env.MEDIA_SECRET,
              now(),
            ),
            range = parseRange(request.headers.get("Range"));
          const upstream = await safeFetch(ticket.url, mediaTarget, range);
          if (!upstream.ok) {
            await upstream.body?.cancel();
            throw new Failure(502, "平台拒绝音轨下载，请重新读取链接。");
          }
          if (
            !range &&
            (upstream.status !== 200 || upstream.headers.has("Content-Range"))
          ) {
            await upstream.body?.cancel();
            throw new Failure(502, "平台未提供完整音轨，请重新读取链接。");
          }
          const length = Number(upstream.headers.get("Content-Length"));
          const type = upstream.headers.get("Content-Type") || "";
          if (length > MAX_AUDIO || /text|html|json/i.test(type)) {
            await upstream.body?.cancel();
            throw new Failure(413, "音轨过大或返回内容不是音频。");
          }
          if (range) {
            const expected = `bytes ${range.start}-${range.end}/`;
            if (
              upstream.status !== 206 ||
              !upstream.headers.get("Content-Range")?.startsWith(expected)
            ) {
              await upstream.body?.cancel();
              throw new Failure(502, "平台未按请求提供音轨分片。");
            }
          }
          const reader = upstream.body.getReader();
          let count = 0;
          const body = new ReadableStream({
            async pull(controller) {
              try {
                const { value, done } = await reader.read();
                if (done) {
                  controller.close();
                  return;
                }
                count += value.byteLength;
                if (count > MAX_AUDIO) {
                  await reader.cancel();
                  controller.error(Error("音轨超过传输上限。"));
                  return;
                }
                controller.enqueue(value);
              } catch {
                controller.error(Error("音轨传输中断，请重试。"));
              }
            },
            cancel(reason) {
              return reader.cancel(reason);
            },
          });
          headers.set("Content-Type", "audio/mp4");
          headers.set("Accept-Ranges", "bytes");
          if (length) headers.set("Content-Length", String(length));
          const contentRange = upstream.headers.get("Content-Range");
          if (contentRange) headers.set("Content-Range", contentRange);
          return new Response(body, { status: upstream.status, headers });
        }
        return json({ error: "接口不存在。" }, 404);
      } catch (error) {
        return json(
          {
            error:
              error instanceof Failure
                ? error.message
                : "视频服务暂不可用，请稍后重试。",
          },
          error instanceof Failure ? error.status : 502,
        );
      }
    },
  };
}
export default createWorker();
