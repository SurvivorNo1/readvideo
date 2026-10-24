// This function is deliberately self-contained so its readable source can be
// copied into the source page without loading code from another server.
export async function collectBilibiliAudio({ save = true } = {}) {
  if (
    location.protocol !== "https:" ||
    !["www.bilibili.com", "bilibili.com", "m.bilibili.com"].includes(
      location.hostname,
    )
  )
    throw Error("请在B站视频原页面运行。");
  const id = location.pathname.match(
    /^\/video\/(BV[\w]{10}|av\d+)(?:\/|$)/,
  )?.[1];
  if (!id) throw Error("请先打开具体的视频页面。");
  const cap = 128000000,
    step = 512 * 1024;
  const audios = window.__playinfo__?.data?.dash?.audio || [];
  const candidates = audios
    .filter((a) => a.baseUrl || a.base_url)
    .sort((a, b) => (a.bandwidth || 0) - (b.bandwidth || 0));
  if (!candidates.length)
    throw Error(
      "播放器没有可读取的独立音轨。请等视频加载后再试；受限内容不保证可用。",
    );
  const url = new URL(candidates[0].baseUrl || candidates[0].base_url);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !(
      url.hostname === "bilivideo.com" ||
      url.hostname.endsWith(".bilivideo.com") ||
      url.hostname.endsWith(".bilivideo.cn")
    )
  )
    throw Error("音轨来源不在支持范围。");
  const panel = save ? document.createElement("div") : null;
  const report = (message) => {
    if (panel) panel.textContent = "readvideo · " + message;
  };
  if (panel) {
    panel.style.cssText =
      "position:fixed;right:20px;bottom:20px;z-index:2147483647;padding:16px 20px;background:#fff;color:#1d1d1f;border:1px solid #ddd;border-radius:14px;box-shadow:0 8px 30px #0002;font:14px system-ui;max-width:340px;";
    document.body.append(panel);
  }
  async function bounded(response) {
    if (!response.ok) throw Error("音轨请求失败：HTTP " + response.status);
    const reader = response.body.getReader(),
      parts = [];
    let count = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      count += value.length;
      if (count > cap) {
        await reader.cancel();
        throw Error("音轨超过128 MB上限。");
      }
      parts.push(value);
      report("正在获取音轨 · " + (count / 1000000).toFixed(1) + " MB");
    }
    const out = new Uint8Array(count);
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }
  try {
    report("正在读取完整音轨，无需播放。");
    const response = await fetch(url.href, {
      credentials: "omit",
      signal: AbortSignal.timeout(25000),
    });
    if (!response.ok) throw Error("音轨请求失败：HTTP " + response.status);
    const total = Number(response.headers.get("content-length"));
    if (total > cap) {
      await response.body?.cancel();
      throw Error("音轨超过128 MB上限。");
    }
    let bytes,
      parallel = false;
    if (Number.isSafeInteger(total) && total > step) {
      await response.body?.cancel();
      const controller = new AbortController();
      bytes = new Uint8Array(total);
      let next = 0,
        completed = 0;
      const work = async () => {
        while (next < total) {
          const start = next;
          next += step;
          const end = Math.min(total, start + step) - 1;
          let piece;
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              const r = await fetch(url.href, {
                credentials: "omit",
                headers: { Range: `bytes=${start}-${end}` },
                signal: AbortSignal.any([
                  controller.signal,
                  AbortSignal.timeout(25000),
                ]),
              });
              if (r.status !== 206) {
                await r.body?.cancel();
                throw Error("服务器未接受分段下载。");
              }
              const range = r.headers.get("content-range");
              if (range && range !== `bytes ${start}-${end}/${total}`) {
                await r.body?.cancel();
                throw Error("分段位置校验失败。");
              }
              piece = await bounded(r);
              if (piece.length !== end - start + 1)
                throw Error("分段长度校验失败。");
              break;
            } catch (e) {
              if (attempt === 1 || controller.signal.aborted) throw e;
            }
          }
          bytes.set(piece, start);
          completed += piece.length;
          report(
            "并发下载音轨 · " + Math.round((completed / total) * 100) + "%",
          );
        }
      };
      const workers = Array.from(
        { length: Math.min(4, Math.ceil(total / step)) },
        () => work(),
      );
      try {
        await Promise.all(workers);
        parallel = true;
      } catch {
        controller.abort();
        await Promise.allSettled(workers);
        report("正在改用兼容下载。");
        bytes = await bounded(
          await fetch(url.href, {
            credentials: "omit",
            signal: AbortSignal.timeout(120000),
          }),
        );
      }
    } else bytes = await bounded(response);
    if (!bytes.length) throw Error("没有收到音频内容。");
    const part = Number(new URL(location.href).searchParams.get("p") || 1);
    const filename =
      "readvideo-" +
      id +
      "-p" +
      (Number.isSafeInteger(part) && part > 0 ? part : 1) +
      ".m4a";
    const blob = new Blob([bytes], { type: "audio/mp4" });
    if (save) {
      const link = document.createElement("a"),
        objectURL = URL.createObjectURL(blob);
      link.href = objectURL;
      link.download = filename;
      link.id = "readvideo-download-audio";
      link.textContent =
        "保存音轨 · " + (bytes.length / 1000000).toFixed(2) + " MB";
      link.style.cssText =
        "display:block;margin-top:10px;color:#0071e3;font-weight:600;";
      report("音轨已准备好。保存后回到 readvideo，选择“导入音频”。");
      panel.append(link);
      link.addEventListener(
        "click",
        () =>
          setTimeout(() => {
            URL.revokeObjectURL(objectURL);
            panel.remove();
          }, 60000),
        { once: true },
      );
    }
    return { blob, filename, parallel, bytes: bytes.length };
  } catch (error) {
    report(error.message);
    if (panel) setTimeout(() => panel.remove(), 30000);
    throw error;
  }
}
export function collectorScript() {
  return (
    "(" +
    collectBilibiliAudio.toString() +
    ')().then(r=>console.info("readvideo: audio ready",r.filename)).catch(e=>console.error("readvideo:",e.message));'
  );
}
