// No user audio leaves this worker. Only model code/weights are downloaded.
let pipeline,
  env,
  pipe,
  device,
  gpuFailed = false;
const post = (id, type, data = {}) => self.postMessage({ id, type, ...data });
async function load(id, requested = "auto") {
  if (!pipeline) {
    ({ pipeline, env } = await import(
      "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js"
    ));
    env.allowLocalModels = false;
    env.useBrowserCache = true;
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
  if (pipe && target === device) return;
  if (pipe) {
    await pipe.dispose();
    pipe = null;
  }
  device = target;
  post(id, "stage", {
    message:
      target === "webgpu" ? "正在准备 GPU 识别模型" : "正在准备 CPU 识别模型",
  });
  const options = {
    device: target,
    dtype:
      target === "webgpu"
        ? { encoder_model: "fp32", decoder_model_merged: "q4" }
        : "q8",
    progress_callback: (p) => {
      if (p.status === "progress")
        post(id, "download", { file: p.file, progress: p.progress });
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
  post(id, "ready", { device });
}
self.onmessage = async ({ data }) => {
  const { id, action, audio, language = "auto", backend = "auto" } = data;
  try {
    if (action === "load") {
      await load(id, backend);
      post(id, "done", { device });
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
    });
  } catch {
    post(id, "error", {
      message:
        "浏览器识别失败。请检查模型下载网络或可用内存；已保留待处理音频，可用 CPU 重试或下载音频。",
    });
  }
};
