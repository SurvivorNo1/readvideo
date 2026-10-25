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

async function countCachedFiles() {
  try {
    const dir = await cacheRoot();
    if (!dir) return 0;
    let n = 0;
    for await (const _ of dir.keys()) {
      if (++n >= 4) break; // 只关心"有没有"，不需要精确数字
    }
    return n;
  } catch {
    return 0;
  }
}

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

  // 先看本机缓存里有没有模型文件，决定文案到底是"载入缓存"还是"下载"。
  // 之前无论缓存与否都说"正在下载识别模型"，还会带上 (0.0/0.0 MB) 这种
  // 没意义的数字，用户会以为每次都重新下了一遍。
  const cachedFiles = await countCachedFiles();

  post(id, "stage", {
    message:
      (target === "webgpu" ? "GPU 识别模型" : "CPU 识别模型") +
      `（${modelKey}）` +
      (cachedFiles > 0
        ? " · 正在从本机缓存载入"
        : " · 首次使用，正在下载"),
  });

  // 按文件聚合下载进度。注意：分母会随着新文件加入而变大，
  // 所以前端不显示百分比，只显示"已下载多少 MB"，避免数字倒退。
  const fileState = new Map();
  let lastPost = 0;
  const reportDownload = () => {
    let loaded = 0,
      total = 0;
    for (const s of fileState.values()) {
      loaded += s.loaded || 0;
      total += s.total || 0;
    }
    const now = Date.now();
    if (now - lastPost < 250 && loaded < total) return;
    lastPost = now;
    post(id, "download", {
      loaded,
      total,
      files: fileState.size,
      // 只有真的一字节都没下过，才算"从缓存载入"
      cached: stats.missBytes === 0,
      downloaded: stats.missBytes,
    });
  };

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
      if (!p || !p.file) return;
      const prev = fileState.get(p.file) || { loaded: 0, total: 0 };
      if (p.status === "progress") {
        // 累加式还是绝对值式都兼容：取较大的那个
        fileState.set(p.file, {
          loaded: Math.max(prev.loaded, Number(p.loaded) || 0),
          total: Number(p.total) || prev.total || 0,
        });
        reportDownload();
      } else if (p.status === "ready") {
        const total = prev.total || Number(p.total) || 0;
        fileState.set(p.file, { loaded: total, total });
        reportDownload();
      }
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

    // ★ 不使用 return_timestamps。
    //   whisper 的 quantized 解码器在 WebGPU 上求时间戳会抛
    //   "token_ids must be a non-empty array of integers"，而且这个错误
    //   一旦发生，同一个 session 后续调用也会连带失败（会话状态坏了）。
    //   所以干脆不请求模型时间戳，改由调用方按窗口偏移加标点比例合成。
    const buildOptions = (lang) => ({
      return_timestamps: false,
      task: "transcribe",
      ...(lang ? { language: lang } : {}),
    });

    // 按标点把整段文字按比例摊到窗口时长上。
    // 没有标点时（whisper 偶尔整段不给标点），按字数切成便于阅读的小段。
    const synthChunks = (text, seconds) => {
      const raw = String(text || "").trim();
      if (!raw) return [{ timestamp: [0, seconds], text: "" }];

      let parts = raw
        .split(/(?<=[。！？!?；;])\s*/)
        .map((s) => s.trim())
        .filter(Boolean);

      if (parts.length <= 1) {
        // 无标点：按 42 个字左右硬切，尽量不切断英文单词
        const size = 42;
        parts = [];
        let buf = "";
        for (const ch of raw) {
          buf += ch;
          if (buf.length >= size && !/[A-Za-z0-9]$/.test(ch)) {
            parts.push(buf.trim());
            buf = "";
          }
        }
        if (buf.trim()) parts.push(buf.trim());
      }

      const total = parts.reduce((n, p) => n + p.length, 0) || 1;
      let at = 0;
      return parts.map((p) => {
        const span = (seconds * p.length) / total;
        const chunk = { timestamp: [at, at + span], text: p };
        at += span;
        return chunk;
      });
    };

    post(id, "stage", {
      message:
        (device === "webgpu" ? "GPU 正在识别音频" : "CPU 正在识别音频") +
        ` · ${usedLang}`,
    });

    const samples = new Float32Array(audio);
    const seconds = samples.length / 16000;

    let result;
    try {
      const plain = await pipe(samples, buildOptions(usedLang));
      result = {
        text: plain.text,
        chunks: plain.chunks?.length
          ? plain.chunks
          : synthChunks(plain.text, seconds),
      };
    } catch (error) {
      if (device !== "webgpu") throw error;
      gpuFailed = true;
      post(id, "stage", { message: "GPU 识别失败，保留原音频并切换 CPU 重试" });
      await load(id, "cpu", model);
      const plain = await pipe(samples, buildOptions(usedLang));
      result = {
        text: plain.text,
        chunks: plain.chunks?.length
          ? plain.chunks
          : synthChunks(plain.text, seconds),
      };
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
  } catch (error) {
    // 把真实原因带出去，否则界面上只能看到一句无用的通用文案
    const detail = `${error?.name || "Error"}: ${error?.message || error}`;
    post(id, "error", {
      detail,
      message:
        "浏览器识别失败：" +
        detail.slice(0, 160) +
        "。可用 CPU 重试，或换用更小的模型。",
    });
  }
};
