import { downloadAudio, openDownloadCache } from "./download.mjs";

/**
 * 音轨代理页。存在的原因：B 站 CDN 会校验 Referer，而 JS 改不了 Referer。
 * 这个页面靠 URL 里的 `?r=` 参数把自己地址做成含 bilibili 的样子，
 * 于是它发出的请求天然带正确的 Referer。
 *
 * 两种用法：
 *   1. readvideo-download —— 一次性下载整条音轨（旧路径，保留）
 *   2. readvideo-bridge   —— 常驻，按字节区间反复读取（分段转录用）
 */

let busy = false;

async function readRange(url, start, end) {
  const res = await fetch(url, {
    headers: { Range: `bytes=${start}-${end}` },
    mode: "cors",
    credentials: "omit",
    referrerPolicy: "unsafe-url",
  });
  if (res.status !== 206 && res.status !== 200)
    throw Error(`音轨分片读取失败（HTTP ${res.status}）`);
  const buf = await res.arrayBuffer();
  const want = end - start + 1;
  if (res.status === 206 && buf.byteLength < want)
    throw Error(`音轨分片不完整（${buf.byteLength}/${want} 字节）`);
  return new Uint8Array(buf);
}

addEventListener("message", async (event) => {
  if (event.source !== parent || event.origin !== location.origin) return;
  const data = event.data || {};

  // ---- 常驻：按区间反复读取 ----
  if (data.type === "readvideo-bridge" && event.ports[0]) {
    const port = event.ports[0];
    port.onmessage = async ({ data: req }) => {
      if (!req || req.type !== "range") return;
      const { id, url, start, end } = req;
      try {
        const bytes = await readRange(url, start, end);
        port.postMessage({ id, type: "bytes", bytes }, [bytes.buffer]);
      } catch (error) {
        port.postMessage({
          id,
          type: "error",
          message: error?.message || "音轨分片读取失败",
        });
      }
    };
    port.postMessage({ id: "ready", type: "ready" });
    return;
  }

  // ---- 一次性整条下载（旧路径）----
  if (busy || data.type !== "readvideo-download" || !event.ports[0]) return;
  busy = true;
  const port = event.ports[0];
  let cache;
  try {
    try {
      cache = await openDownloadCache();
    } catch {}
    const bytes = await downloadAudio(data.source, {
      cache,
      onProgress: (p) => port.postMessage({ type: "progress", ...p }),
    });
    port.postMessage({ type: "complete", bytes }, [bytes.buffer]);
  } catch {
    port.postMessage({
      type: "error",
      message: "音轨下载中断，请重新读取链接。",
    });
  } finally {
    cache?.close();
    port.close();
  }
});
