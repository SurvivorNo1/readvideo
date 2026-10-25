// No user audio leaves this worker. Only model code/weights are downloaded.
//
// 模型缓存策略（三层，按可用性降级）：
//   1. OPFS（Origin Private File System）——显式落盘，不受 HTTP 缓存淘汰影响
//   2. Cache API —— OPFS 不可用时回退
//   3. 无缓存 —— 每次都下载（隐私模式等）
// 首次下载后会请求 navigator.storage.persist()，尽量避免被浏览器回收。

// 可选模型。whisper-tiny 只有 39M 参数，中文识别和语种判断都偏弱，
// 默认改用 whisper-small（244M），中英文都稳。
const MODELS = {
  tiny: "onnx-community/whisper-tiny",
  base: "onnx-community/whisper-base",
  small: "onnx-community/whisper-small",
};
const DEFAULT_MODEL = "small";

// 语言代码 → Whisper 的 language 参数
const LANGS = { zh: "chinese", en: "english", ja: "japanese", ko: "korean" };

let pipeline,
  env,
  pipe,
  device,
  gpuFailed = false;
let pipeModel = null;
 // 自动模式下来记住第一次判断出的语种

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
async function load(id, requested = "auto", modelKey = DEFAULT_MODEL) {
  const modelId = MODELS[modelKey] || MODELS[DEFAULT_MODEL];

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
  // 设备或模型没变，直接复用
  if (pipe && target === device && pipeModel === modelId) {
    post(id, "cache", await cacheReport());
    return;
  }
  if (pipe) {
    await pipe.dispose();
    pipe = null;
    pipeModel = null;
  }
  device = target;

  const before = stats.hitBytes;
  post(id, "stage", {
    message:
      (target === "webgpu" ? "正在准备 GPU 识别模型" : "正在准备 CPU 识别模型") +
      `（${modelKey}）` +
      (cacheMode === "opfs" ? " · 本地缓存已启用" : ""),
  });

  const options = {
    device: target,
    // 小模型在 WebGPU 上可以用 fp32；small 及以上用 q8 编码器，
    // 否则显存占用会到 900MB 量级
    dtype:
      target === "webgpu"
        ? modelKey === "tiny"
          ? { encoder_model: "fp32", decoder_model_merged: "q4" }
          : { encoder_model: "q4", decoder_model_merged: "q4" }
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
      modelId,
      options,
    );
    pipeModel = modelId;
  } catch (error) {
    if (target === "webgpu") {
      gpuFailed = true;
      post(id, "stage", { message: "GPU 暂不可用，正在切换 CPU" });
      return load(id, "cpu", modelKey);
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
  const { id, action, audio, language = "auto", backend = "auto", model = DEFAULT_MODEL } = data;

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
      await load(id, backend, model);
      post(id, "done", { device, model, cache: await cacheReport() });
      return;
    }
    await load(id, backend, model);

    // ★ 关键：transformers.js 的 Whisper 不做语种检测。
    //   模型的 generation_config 把语言 token 写死成 <|en|>，
    //   不传 language 就会把中文音频硬转成英文。
    //   传 null 无效，传字符串 auto 直接报错。所以语种必须由调用方明确指定。
    const forced = LANGS[language];
    const usedLang = forced || "chinese";

    const buildOptions = (lang) => ({
      return_timestamps: true,
      chunk_length_s: 30,
      stride_length_s: 0,
      task: "transcribe",
      ...(lang ? { language: lang } : {}),
    });

    post(id, "stage", {
      message:
        (device === "webgpu" ? "GPU 正在识别音频" : "CPU 正在识别音频") +
        ` · ${usedLang}`,
    });

    let result;
    try {
      result = await pipe(new Float32Array(audio), buildOptions(usedLang));
    } catch (error) {
      if (device !== "webgpu") throw error;
      gpuFailed = true;
      post(id, "stage", { message: "GPU 识别失败，保留原音频并切换 CPU 重试" });
      await load(id, "cpu", model);
      result = await pipe(new Float32Array(audio), buildOptions(usedLang));
    }

    post(id, "done", {
      device,
      language: usedLang,
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
