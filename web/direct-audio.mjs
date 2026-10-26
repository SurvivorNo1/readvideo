/**
 * 通过同源 iframe 代理读取音轨。
 *
 * 为什么需要：B 站 CDN 会校验 Referer，而 Referer 是浏览器禁止 JS 修改的请求头。
 * 这个模块建一个指向 ./audio-bridge.html?r=https://www.bilibili.com 的 iframe，
 * 让它以自己的名义发请求，Referer 就天然正确。
 */

function createBridgeFrame() {
  const frame = document.createElement("iframe");
  frame.hidden = true;
  // 同源 module 脚本；allow-same-origin 是为了 iframe 能正常 fetch 和使用 IndexedDB
  frame.sandbox = "allow-scripts allow-same-origin";
  frame.src = new URL(
    "./audio-bridge.html?r=https://www.bilibili.com",
    import.meta.url,
  ).href;
  return frame;
}

/** 一次性下载整条音轨（旧路径，保留）。 */
export function fetchDirectAudio(source, progress = () => {}, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const frame = createBridgeFrame(),
      channel = new MessageChannel();
    let finished = false;
    const abort = () => finish(signal.reason || Error("下载已取消。"));
    const finish = (error, bytes) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      channel.port1.close();
      channel.port2.close();
      frame.remove();
      error ? reject(error) : resolve(bytes);
    };
    let timer = setTimeout(
      () => finish(Error("音轨下载超时，请重试继续。")),
      180000,
    );
    signal?.addEventListener("abort", abort, { once: true });
    channel.port1.onmessage = ({ data }) => {
      clearTimeout(timer);
      timer = setTimeout(
        () => finish(Error("音轨下载超时，请重试继续。")),
        180000,
      );
      if (data.type === "complete") finish(null, data.bytes);
      else if (data.type === "error") finish(Error(data.message));
      else if (data.type === "progress")
        progress(
          `正在加速读取 · ${(data.completed / 1e6).toFixed(1)} / ${(data.total / 1e6).toFixed(1)} MB · ${(data.bytesPerSecond / 1e6).toFixed(1)} MB/s${data.reused ? " · 已恢复下载" : ""}`,
          Math.round(10 + (15 * data.completed) / data.total),
        );
    };
    frame.onload = () =>
      frame.contentWindow.postMessage(
        { type: "readvideo-download", source: { id: source.id, urls: source.urls } },
        location.origin,
        [channel.port2],
      );
    frame.onerror = () => finish(Error("无法启动音轨下载。"));
    document.body.append(frame);
  });
}

/**
 * 打开常驻的音轨读取通道，按字节区间反复取数据。
 * 分段转录用它：每次只取当前需要的那一段，用完就丢。
 *
 * @param {AbortSignal} [signal]
 * @returns {Promise<{read:(url:string,start:number,end:number)=>Promise<Uint8Array>,close:()=>void}>}
 */
export function openAudioBridge(signal) {
  return new Promise((resolve, reject) => {
    const frame = createBridgeFrame(),
      channel = new MessageChannel();
    const port = channel.port1;
    const pending = new Map();
    let seq = 0;
    let closed = false;

    const close = (reason) => {
      if (closed) return;
      closed = true;
      signal?.removeEventListener("abort", onAbort);
      for (const [, entry] of pending)
        entry.reject(reason || Error("音轨读取已关闭。"));
      pending.clear();
      try {
        port.close();
        channel.port2.close();
      } catch {}
      frame.remove();
    };
    const onAbort = () => close(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });

    port.onmessage = ({ data }) => {
      if (!data || data.id === "ready") return;
      const entry = pending.get(data.id);
      if (!entry) return;
      pending.delete(data.id);
      if (data.type === "bytes") entry.resolve(data.bytes);
      else entry.reject(Error(data.message || "音轨分片读取失败"));
    };

    frame.onload = () => {
      frame.contentWindow.postMessage({ type: "readvideo-bridge" }, location.origin, [
        channel.port2,
      ]);
      resolve({
        read(url, start, end) {
          if (closed) return Promise.reject(Error("音轨读取已关闭。"));
          const id = ++seq;
          return new Promise((res, rej) => {
            pending.set(id, { resolve: res, reject: rej });
            port.postMessage({ type: "range", id, url, start, end });
          });
        },
        close,
      });
    };
    frame.onerror = () => {
      close();
      reject(Error("无法建立音轨读取通道。"));
    };
    document.body.append(frame);
  });
}
