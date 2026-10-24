// No user audio leaves this worker. Only model code/weights are downloaded.
//
// 模型缓存策略（三层，按可用性降级）：
//   1. OPFS（Origin Private File System）——显式落盘，不受 HTTP 缓存淘汰影响
//   2. Cache API —— OPFS 不可用时回退
//   3. 无缓存 —— 每次都下载（隐私模式等）
// 首次下载后会请求 navigator.storage.persist()，尽量避免被浏览器回收。

let pipeline,
  env,
  pipe,
  device,
  gpuFailed = false;
const post = (id, type, data = {}) => self.postMessage({ id, type, ...data });

// ─── 缓存实现 ───────────────────────────────────────────────
const CACHE_DIR = "readvideo-model";
const stats = { hit: 0, miss: 0, hitBytes: 0, missBytes: 0, files: 0 };
let cacheMode = "none";
let rootPromise = null;

function cacheRoot() {
  if (!rootPromise) {
    rootPromise = (async () => {
      const storage = self.navigator?.storage;
      if (!storage?.getDirectory) return null;
      try {
        if (storage.persist) await storage.persist().catch(() => false);
        const root = await storage.getDirectory();
        return await root.getDirectoryHandle(CACHE_DIR, { create: true });
      } catch {
        return null;
      }
    })();
  }
  return rootPromise;
}

async function keyOf(request) {
  const url = typeof request === "string" ? request : request.url;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(url),
  );
  return (
    Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("") + ".bin"
  );
}

const opfsCache = {
  async match(request) {
    const dir = await cacheRoot();
    if (!dir) return undefined;
    try {
      const handle = await dir.getFileHandle(await keyOf(request));
      const file = await handle.getFile();
      if (!file.size) return undefined;
      stats.hit += 1;
      stats.hitBytes += file.size;
      return new Response(file);
    } catch {
      return undefined;
    }
  },
  async put(request, response) {
    const dir = await cacheRoot();
    if (!dir) return;
    try {
      // 复制一份再读，避免消费掉调用方还要用的 response
      const source = typeof response.clone === "function" ? response.clone() : response;
      const buffer = await source.arrayBuffer();
      if (!buffer.byteLength) return;
      const handle = await dir.getFileHandle(await keyOf(request), {
        create: true,
      });
      const writable = await handle.createWritable();
      await writable.write(buffer);
      await writable.close();
      stats.miss += 1;
      stats.missBytes += buffer.byteLength;
      stats.files += 1;
    } catch {
      /* 缓存失败绝不影响识别 */
    }
  },
};

async function cacheReport() {
  let quota = null,
    usage = null;
  try {
    const estimate = await self.navigator?.storage?.estimate?.();
    if (estimate) {
      quota = estimate.quota ?? null;
      usage = estimate.usage ?? null;
    }
  } catch {}
  return {
    mode: cacheMode,
    files: stats.files,
    hitCount: stats.hit,
    hitBytes: stats.hitBytes,
    downloadedBytes: stats.missBytes,
    cached: stats.hit > 0,
    quota,
    usage,
  };
}

async function clearCache() {
  try {
    const dir = await cacheRoot();
    if (!dir) return false;
    // OPFS 没有递归删除 API，逐项删除
    for await (const name of dir.keys()) {
      try {
        await dir.removeEntry(name);
      } catch {}
    }
    stats.hit = 0;
    stats.miss = 0;
    stats.hitBytes = 0;
    stats.missBytes = 0;
    stats.files = 0;
    return true;
  } catch {
    return false;
  }
}

// ─── 模型加载 ───────────────────────────────────────────────
async function load(id, requested = "auto") {
  if (!pipeline) {
    ({ pipeline, env } = await import(
      "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js"
    ));
    env.allowLocalModels = false;

    // 优先 OPFS，回退 Cache API
    const dir = await cacheRoot();
    if (dir) {
      cacheMode = "opfs";
      env.useCustomCache = true;
      env.customCache = opfsCache;
      env.useBrowserCache = false;
    } else {
      cacheMode = "browser";
      env.useCustomCache = false;
      env.useBrowserCache = true;
    }

    // GitHub Pages does not supply cross-origin isolation headers.
    env.backends.onnx.wasm.numThreads = self.crossOriginIsolated
      ? Math.min(4, self.navigator.hardwareConcurrency || 2)
      : 1;
  }

  let target = "wasm";
  if (requested !== "cpu" && !gpuFailed && self.navigator.gpu) {
    try {
      if (await self.navigator.gpu.requestAdapter()) target = "webgpu";
    } catch {}
  }
  if (pipe && target === device) {
    post(id, "cache", await cacheReport());
    return;
  }
  if (pipe) {
    await pipe.dispose();
    pipe = null;
  }
  device = target;

  const before = stats.hitBytes;
  post(id, "stage", {
    message:
      (target === "webgpu" ? "正在准备 GPU 识别模型" : "正在准备 CPU 识别模型") +
      (cacheMode === "opfs" ? " · 本地缓存已启用" : ""),
  });

  const options = {
    device: target,
    dtype:
      target === "webgpu"
        ? { encoder_model: "fp32", decoder_model_merged: "q4" }
        : "q8",
    progress_callback: (p) => {
      if (p.status === "progress")
        post(id, "download", {
          file: p.file,
          progress: p.progress,
          loaded: p.loaded,
          total: p.total,
        });
      else if (p.status === "ready")
        post(id, "download", { file: p.file, progress: 100 });
    },
  };

  try {
    pipe = await pipeline(
      "automatic-speech-recognition",
      "onnx-community/whisper-tiny",
      options,
    );
  } catch (error) {
    if (target === "webgpu") {
      gpuFailed = true;
      post(id, "stage", { message: "GPU 暂不可用，正在切换 CPU" });
      return load(id, "cpu");
    }
    throw error;
  }

  const report = await cacheReport();
  // 这次加载复用缓存了多少：命中字节增加即视为命中
  report.reused = stats.hitBytes > before;
  post(id, "ready", { device });
  post(id, "cache", report);
}

// ─── 消息入口 ───────────────────────────────────────────────
self.onmessage = async ({ data }) => {
  const { id, action, audio, language = "auto", backend = "auto" } = data;

  if (action === "cache-info") {
    post(id, "done", { cache: await cacheReport() });
    return;
  }
  if (action === "cache-clear") {
    const ok = await clearCache();
    post(id, "done", { cleared: ok, cache: await cacheReport() });
    return;
  }

  try {
    if (action === "load") {
      await load(id, backend);
      post(id, "done", { device, cache: await cacheReport() });
      return;
    }
    await load(id, backend);
    const options = {
      return_timestamps: true,
      chunk_length_s: 30,
      stride_length_s: 0,
      task: "transcribe",
      ...(language !== "auto"
        ? { language: language === "zh" ? "chinese" : "english" }
        : {}),
    };
    post(id, "stage", {
      message: device === "webgpu" ? "GPU 正在识别音频" : "CPU 正在识别音频",
    });
    let result;
    try {
      result = await pipe(new Float32Array(audio), options);
    } catch (error) {
      if (device !== "webgpu") throw error;
      gpuFailed = true;
      post(id, "stage", { message: "GPU 识别失败，保留原音频并切换 CPU 重试" });
      await load(id, "cpu");
      result = await pipe(new Float32Array(audio), options);
    }
    post(id, "done", {
      device,
      text: result.text,
      chunks: result.chunks || [
        {
          timestamp: [0, new Float32Array(audio).length / 16000],
          text: result.text,
        },
      ],
      cache: await cacheReport(),
    });
  } catch {
    post(id, "error", {
      message:
        "浏览器识别失败。请检查模型下载网络或可用内存；已保留待处理音频，可用 CPU 重试或下载音频。",
    });
  }
};
