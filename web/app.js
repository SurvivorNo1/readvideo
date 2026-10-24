import {
  PRESETS,
  parseCaptions,
  generateArticle,
  chatRequest,
  resolveConfig,
  stamp,
} from "./core.mjs";
import { discoverSource, embeddedPlayer } from "./source.mjs";
import { ReadingSession } from "./session.mjs";
import { collectorScript } from "./collector.mjs";
import { bilibiliVideo } from "./bilibili.mjs";
import { resolveThroughEdge, edgeEndpoint } from "./edge.mjs";
import { DEFAULT_EDGE_URL } from "./deployment.mjs";
const $ = (selector) => document.querySelector(selector);
const make = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};
let bootstrap,
  config,
  transcript = null,
  result = null,
  busy = false,
  lastURL = "",
  started = 0,
  elapsedTimer,
  toastTimer,
  activeTab = "notes";

function toast(text) {
  clearTimeout(toastTimer);
  $("#toast").textContent = text;
  $("#toast").hidden = false;
  toastTimer = setTimeout(() => ($("#toast").hidden = true), 3500);
}
function showError(error) {
  $("#error").textContent = error.message || String(error);
  $("#error").hidden = false;
}
function setBusy(value) {
  busy = value;
  $("#generate").disabled = value;
  $("#extract-only").disabled = value;
  $("#summarize-current").disabled = value;
  $("#progress-panel").hidden = !value;
  clearInterval(elapsedTimer);
  if (value) {
    started = Date.now();
    $("#elapsed").textContent = "0s";
    elapsedTimer = setInterval(
      () =>
        ($("#elapsed").textContent =
          Math.round((Date.now() - started) / 1000) + "s"),
      1000,
    );
  }
}
function progress(text, amount) {
  $("#progress-text").textContent = text;
  $("#progress-meter").value = amount;
}
function time(seconds) {
  seconds = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(seconds / 3600),
    minutes = Math.floor((seconds % 3600) / 60),
    rest = seconds % 60;
  return (
    (hours ? String(hours).padStart(2, "0") + ":" : "") +
    String(minutes).padStart(2, "0") +
    ":" +
    String(rest).padStart(2, "0")
  );
}
function sourceAt(stamp) {
  if (!transcript?.url) return null;
  try {
    const url = new URL(transcript.url);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    const seconds = stamp.split(":").reduce((a, n) => a * 60 + Number(n), 0);
    if (url.hostname.endsWith("vimeo.com")) url.hash = "t=" + seconds + "s";
    else url.searchParams.set("t", String(seconds));
    return url.href;
  } catch {
    return null;
  }
}
function appendInline(node, text) {
  const parts = String(text).split(
    /(\[(?:\d{1,3}:)?\d{2}:\d{2}\]|\*\*[^*]+\*\*|`[^`]+`)/g,
  );
  for (const part of parts) {
    if (/^\[(?:\d{1,3}:)?\d{2}:\d{2}\]$/.test(part)) {
      const url = sourceAt(part.slice(1, -1));
      const tag = make(url ? "a" : "span", "time-link", part);
      if (url) {
        tag.href = url;
        tag.target = "_blank";
        tag.rel = "noopener noreferrer";
      }
      node.append(tag);
    } else if (part.startsWith("**") && part.endsWith("**"))
      node.append(make("strong", "", part.slice(2, -2)));
    else if (part.startsWith("`") && part.endsWith("`"))
      node.append(make("code", "", part.slice(1, -1)));
    else node.append(document.createTextNode(part));
  }
}
function renderArticle(markdown) {
  const root = $("#article");
  root.replaceChildren();
  let paragraph = [],
    list = null,
    code = null;
  function flush() {
    if (paragraph.length) {
      const p = make("p");
      appendInline(p, paragraph.join(" "));
      root.append(p);
      paragraph = [];
    }
    list = null;
  }
  for (const line of String(markdown).split("\n")) {
    if (line.startsWith("```")) {
      flush();
      if (code) {
        code = null;
      } else {
        const pre = make("pre");
        code = make("code");
        pre.append(code);
        root.append(pre);
      }
      continue;
    }
    if (code) {
      code.textContent += line + "\n";
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    const bullet = line.match(/^\s*(?:[-*+]\s+|\d+[.)]\s+)(.+)$/);
    if (heading) {
      flush();
      const h = make("h" + heading[1].length);
      appendInline(h, heading[2]);
      root.append(h);
    } else if (bullet) {
      if (paragraph.length) flush();
      if (!list) {
        list = make(/^\s*\d/.test(line) ? "ol" : "ul");
        root.append(list);
      }
      const item = make("li");
      appendInline(item, bullet[1]);
      list.append(item);
    } else if (line.startsWith("> ")) {
      flush();
      const quote = make("blockquote");
      appendInline(quote, line.slice(2));
      root.append(quote);
    } else if (!line.trim()) {
      flush();
    } else {
      if (list) list = null;
      paragraph.push(line);
    }
  }
  flush();
}
function renderTranscript() {
  const root = $("#transcript");
  root.replaceChildren();
  const query = $("#search").value.trim().toLowerCase();
  let matches = 0;
  for (const cue of transcript?.segments || []) {
    if (query && !cue.text.toLowerCase().includes(query)) continue;
    matches++;
    const row = make("div", "cue");
    const stamp = time(cue.start);
    const url = sourceAt(stamp);
    const clock = make(url ? "a" : "span", "time-link", stamp);
    if (url) {
      clock.href = url;
      clock.target = "_blank";
      clock.rel = "noopener noreferrer";
    }
    row.append(clock, make("p", "", cue.text));
    root.append(row);
  }
  if (!matches) root.append(make("p", "cue-empty", "没有找到匹配的字幕。"));
  $("#transcript-status").textContent = transcript?.partial
    ? `转写未完成 · 已识别 ${transcript.segments.length} 条 · 导出会标明未完成`
    : query
      ? `匹配 ${matches} / ${transcript.segments.length} 条 · 复制与导出仍包含完整字幕`
      : `完整字幕 · 共 ${transcript?.segments.length || 0} 条 · 保留时间点，复制与导出包含全文`;
}
function selectTab(tab) {
  activeTab = tab;
  for (const [name, id] of [
    ["notes", "notes"],
    ["transcript", "transcript"],
  ]) {
    $("#" + id + "-tab").classList.toggle("active", tab === name);
    $("#" + id + "-tab").setAttribute("aria-selected", String(tab === name));
    $("#" + id + "-panel").hidden = tab !== name;
  }
  updateExports();
}
function updateExports() {
  const available = activeTab === "transcript" ? !!transcript : !!result;
  $("#copy").disabled = !available;
  $("#download").disabled = !available;
}
function updateReading() {
  $("#empty").hidden = !!transcript;
  $("#reading").hidden = !transcript;
  if (!transcript) return;
  $("#source-title").textContent = transcript.title;
  if (transcript.source === "browser-asr")
    $("#source-title").textContent += transcript.partial
      ? " · 转写未完成"
      : transcript.timeline === "media"
        ? " · 音频已转写"
        : " · 本次采集已转写";
  const duration = transcript.duration ? time(transcript.duration) : "";
  const chars = transcript.segments.reduce((n, s) => n + s.text.length, 0);
  $("#source-meta").textContent = [
    transcript.uploader,
    duration,
    transcript.source === "browser-asr"
      ? "浏览器 ASR · " +
        (transcript.timeline === "capture" ? "采集相对时间" : "音频时间")
      : transcript.source === "subtitle-file"
        ? "导入字幕"
        : (transcript.automatic ? "自动字幕" : "人工字幕") +
          " · " +
          transcript.language,
    chars.toLocaleString() + " 字符",
  ]
    .filter(Boolean)
    .join("  ·  ");
  $("#source-link").hidden = !transcript.url;
  if (transcript.url) $("#source-link").href = sourceAt("00:00");
  $("#cue-count").textContent = transcript.segments.length;
  $("#notes-empty").hidden = !!result;
  if (result) {
    renderArticle(result.markdown);
    $("#result-meta").textContent =
      `${result.model} · ${result.mode === "brief" ? "速读摘要" : { short: "短篇文章", medium: "中篇文章", long: "长篇文章", detailed: "详细文章" }[result.length] || "完整文章"} · 基于字幕校订整理`;
    $("#reading-time").textContent =
      `约 ${Math.max(1, Math.ceil(result.markdown.length / 450))} 分钟阅读`;
  } else {
    $("#article").replaceChildren();
    $("#result-meta").textContent = "内容基于字幕，关键事实建议回看核对。";
    $("#reading-time").textContent = "";
  }
  renderTranscript();
  updateExports();
}
let currentPlayer = null,
  preferOtherTab = false;
function preparePlayer(url) {
  currentPlayer = embeddedPlayer(url);
  preferOtherTab = false;
  $("#inline-player").hidden = !currentPlayer;
  const frame = $("#video-frame");
  if (currentPlayer) {
    if (frame.src !== currentPlayer.url) frame.src = currentPlayer.url;
    frame.title = currentPlayer.platform + " 视频播放器";
    $("#open-video").textContent = "原站播放 ↗";
    $("#capture-start").textContent = "授权本页音频并转写";
  } else {
    frame.removeAttribute("src");
    $("#open-video").textContent = "① 打开原视频 ↗";
    $("#capture-start").textContent = "② 授权音频并开始";
  }
}
$("#open-video").addEventListener("click", () => {
  preferOtherTab = true;
  $("#capture-start").textContent = "② 授权音频并开始";
  $("#capture-help").textContent =
    "在原站准备好视频，再回到这里点击授权。选择原视频标签页并勾选“共享标签页音频”，然后从头播放；结束后点击“停止采集，完成转写”。";
});
let session = null,
  generateAfterCapture = true,
  preparedTitle = "";
async function generateCurrent() {
  if (transcript?.partial)
    throw new Error("转写尚未完成，请处理剩余音频后生成文章。");
  resolveConfig(config);
  const mode = document.querySelector("[name=mode]:checked").value;
  result = await generateArticle(
    transcript,
    config,
    {
      mode,
      length: $("#article-length").value,
      language: config.output_language,
    },
    progress,
  );
  updateReading();
  selectTab("notes");
}
function captionData(source) {
  return {
    ...source,
    uploader: "浏览器直接读取",
    duration: source.segments.at(-1)?.start || 0,
    partial: false,
  };
}
async function afterTranscript() {
  setBusy(true);
  try {
    if (generateAfterCapture) await generateCurrent();
    else selectTab("transcript");
  } catch (error) {
    showError(error);
    if (!config.api_key) openSettings();
  } finally {
    setBusy(false);
  }
}
function configureSession(url) {
  session?.close();
  result = null;
  session = new ReadingSession({
    url,
    sameTab: !!currentPlayer && !preferOtherTab,
    language: $("#caption-language").value,
    backend: $("#asr-backend").value,
    offset: Math.max(0, Number($("#capture-offset").value) || 0),
    onTranscript: (data) => {
      transcript = data;
      lastURL = url;
      updateReading();
      selectTab("transcript");
    },
    onProgress: (p) => {
      progress(
        p.message ||
          (p.type === "download"
            ? "正在下载识别模型 · " + Math.round(p.progress || 0) + "%"
            : "准备浏览器识别"),
        Math.round(p.progress || 10),
      );
    },
    onStatus: (state) => {
      $("#engine-label").textContent =
        state.device === "webgpu"
          ? "WebGPU 加速"
          : state.device === "wasm"
            ? "CPU / WASM"
            : "GPU 可选 · CPU 可用";
      $("#capture-status").textContent =
        (state.message ||
          (state.error ? "识别暂停，音频仍保留。" : "音频在浏览器内处理。")) +
        ` 已采集 ${stamp(state.elapsed)} · 待处理 ${stamp(state.pending)}`;
      $("#recovery-actions").hidden = !state.error;
      if (state.ended) $("#capture-stop").hidden = true;
    },
    onFinished: afterTranscript,
    onError: (error) => {
      showError(error);
      setBusy(false);
      $("#capture-stop").hidden = true;
      $("#capture-start").disabled = false;
      $("#recovery-actions").hidden = !session?.queue.jobs.length;
    },
  });
  transcript = session.transcript;
  if (preparedTitle) transcript.title = preparedTitle;
  lastURL = url;
  updateReading();
  selectTab("transcript");
  return session;
}
async function run(generate = true) {
  if (busy) return;
  const url = $("#video-url").value.trim();
  generateAfterCapture = generate;
  $("#error").hidden = true;
  setBusy(true);
  try {
    if (url) $("#video-url").required = true;
    if (
      !url &&
      transcript?.input === "audio-file" &&
      transcript.requested_language !== $("#caption-language").value
    )
      throw Error("识别语言已更改，请重新导入音频文件。");
    if (
      transcript &&
      lastURL === url &&
      !transcript.partial &&
      transcript.requested_language === $("#caption-language").value
    ) {
      if (generate) await generateCurrent();
      else selectTab("transcript");
      return;
    }
    progress("优先检查可直接读取的字幕", 5);
    let source;
    if (bilibiliVideo(url) && config.edge_url) {
      progress("正在获取字幕或完整音轨，无需播放", 8);
      try {
        source = await resolveThroughEdge(
          url,
          $("#caption-language").value,
          config.edge_url,
        );
      } catch (error) {
        showError(error);
      }
    }
    source ||= await discoverSource(url, $("#caption-language").value);
    preparedTitle = source.title || "";
    if (source.reason === "part-unavailable")
      throw Error("没有找到这个分P，请检查链接中的 p 参数。");
    if (source.kind === "captions") {
      session?.close();
      session = null;
      transcript = captionData(source);
      transcript.requested_language = $("#caption-language").value;
      lastURL = url;
      result = null;
      $("#capture-panel").hidden = true;
      $("#video-frame").removeAttribute("src");
      currentPlayer = null;
      updateReading();
      if (generate) await generateCurrent();
      else selectTab("transcript");
    } else {
      $("#capture-panel").hidden = false;
      $(".capture-heading h2").textContent =
        preparedTitle || "让浏览器，听懂这段视频。";
      $("#recovery-actions").hidden = true;
      $("#open-video").href = url;
      if (source.kind === "media") {
        currentPlayer = null;
        $("#inline-player").hidden = true;
        $("#video-frame").removeAttribute("src");
      } else preparePlayer(url);
      $("#capture-start").disabled = false;
      if (source.kind === "media") {
        $("#capture-start").hidden = true;
        $("#open-video").hidden = true;
        $("#capture-help").textContent =
          "已找到可读取的完整音轨，正在本机快速转写，无需播放或授权。首次使用会先下载识别模型，无 GPU 时自动使用 CPU。";
        const current = configureSession(url);
        try {
          if (source.title) current.transcript.title = source.title;
          await current.startMedia(progress, source.transport === 'direct-cdn' ? source : source.url);
        } catch (error) {
          if (current.queue.jobs.length) throw error;
          current.close();
          preparePlayer(url);
          $("#capture-start").hidden = false;
          $("#open-video").hidden = false;
          $("#capture-help").textContent =
            "此媒体链接无法被网页直接读取。打开原视频，再授权共享播放标签页音频，即可在浏览器转写。";
          $("#capture-status").textContent =
            "直链读取未完成，可以改用标签页音频授权。";
          throw new Error(
            "无法直接读取媒体链接。请检查网络，或改用下方标签页音频授权。",
          );
        }
      } else {
        $("#capture-start").hidden = false;
        $("#open-video").hidden = false;
        $("#capture-help").textContent = currentPlayer
          ? "① 点击授权，选择当前 readvideo 标签页并勾选“共享标签页音频”。② 从头播放下方视频。③ 播放结束，点击“停止采集，完成转写”。播放器无法播放时，使用“原站播放”。"
          : "此链接的字幕无法被网页直接读取。打开原视频，点击授权，选择视频标签页并勾选“共享标签页音频”，再从起点播放。转写随播放进行，音频不上传 ASR 服务。";
        $("#capture-status").textContent =
          "字幕不可直接读取，准备好后授权音频。请完整播放，不中途跳转；不会读取麦克风。";
      }
    }
  } catch (error) {
    showError(error);
  } finally {
    setBusy(false);
  }
}
$("#capture-start").addEventListener("click", async () => {
  if (busy) return;
  $("#error").hidden = true;
  setBusy(true);
  $("#capture-start").disabled = true;
  try {
    const current = configureSession($("#video-url").value.trim());
    $("#capture-stop").hidden = false;
    await current.startCapture();
  } catch (error) {
    showError(error);
    setBusy(false);
    $("#capture-start").disabled = false;
  }
});
$("#capture-stop").addEventListener("click", async () => {
  try {
    await session?.finish();
  } catch {}
});
$("#retry-cpu").addEventListener("click", async () => {
  setBusy(true);
  $("#error").hidden = true;
  try {
    await session?.retryCPU();
  } catch (error) {
    showError(error);
    setBusy(false);
  }
});
$("#save-audio").addEventListener("click", () => {
  for (const file of session?.recoveryFiles() || []) {
    const a = make("a");
    a.href = URL.createObjectURL(file.blob);
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  }
});
window.addEventListener("pagehide", () => session?.close());
function exportedMarkdown() {
  if (!transcript) return "";
  const source = transcript.url ? "来源：" + transcript.url + "\n\n" : "";
  return activeTab === "transcript"
    ? "# " +
        transcript.title +
        "\n\n" +
        source +
        (transcript.source === "browser-asr"
          ? (transcript.partial
              ? "状态：转写未完成，以下仅为已识别部分。\n\n"
              : "状态：本次读取已完成。\n\n") +
            (transcript.timeline === "capture"
              ? "时间点来自音频采集，受播放起点、暂停、跳转和倍速影响。\n\n"
              : "")
          : "") +
        transcript.segments
          .map((cue) => "[" + time(cue.start) + "] " + cue.text)
          .join("\n\n")
    : (result?.markdown || "") +
        "\n\n---\n\n" +
        source +
        "由 readvideo 基于字幕整理 · " +
        (result?.model || "") +
        "\n";
}
function readDrawer() {
  return {
    provider: $("#provider").value,
    base_url: $("#base-url").value.trim(),
    model: $("#model").value.trim(),
    api_key: $("#api-key").value.trim(),
    output_language: $("#output-language").value,
    edge_url: $("#edge-url").value.trim(),
  };
}
function describeProvider() {
  const provider = $("#provider").value;
  const note = $("#provider-note");
  note.replaceChildren();
  if (provider === "custom") $("#advanced").open = true;
  if (provider === "gemini") {
    note.append(
      document.createTextNode(
        "可使用符合条件的免费额度，地区与限额以服务商为准。",
      ),
    );
    const link = make("a", "", "查看官方说明 ↗");
    link.href = "https://ai.google.dev/gemini-api/docs/pricing";
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    note.append(link);
  } else
    note.textContent =
      provider === "deepseek"
        ? "使用 DeepSeek 官方接口，调用费用由你的账户承担。"
        : "填写兼容 Chat Completions 的 HTTPS Base URL，不需要填写完整 /chat/completions 路径。";
  $("#key-note").textContent =
    "Key 仅在当前页面内存使用；浏览器直接请求所选模型服务，刷新后需重新填写。自定义服务需允许跨域（CORS）。";
}
function openSettings() {
  for (const [id, key] of [
    ["provider", "provider"],
    ["base-url", "base_url"],
    ["model", "model"],
    ["api-key", "api_key"],
    ["output-language", "output_language"],
    ["edge-url", "edge_url"],
  ])
    $("#" + id).value = config[key] || "";
  $("#advanced").open = config.provider === "custom";
  describeProvider();
  $("#connection-result").hidden = true;
  $("#settings").showModal();
}
$("#settings-open").addEventListener("click", () =>
  bootstrap ? openSettings() : toast("正在准备页面…"),
);
$("#settings-close").addEventListener("click", () => $("#settings").close());
$("#provider").addEventListener("change", () => {
  const preset = bootstrap.presets[$("#provider").value];
  $("#base-url").value = preset.base_url;
  $("#model").value = preset.model;
  $("#api-key").value = "";
  $("#connection-result").hidden = true;
  describeProvider();
});
$("#settings-form").addEventListener("submit", (event) => {
  event.preventDefault();
  try {
    edgeEndpoint($("#edge-url").value.trim());
  } catch (error) {
    $("#connection-result").hidden = false;
    $("#connection-result").textContent = error.message;
    return;
  }
  config = readDrawer();
  const { provider, base_url, model, output_language, edge_url } = config;
  try {
    localStorage.setItem(
      "readvideo-preferences",
      JSON.stringify({ provider, base_url, model, output_language, edge_url }),
    );
  } catch {}
  $("#provider-label").textContent =
    bootstrap.presets[provider].name + " · 自带 API";
  $("#settings").close();
  toast("配置已更新。Key 只在本次页面内存中使用。");
});
$("#test-connection").addEventListener("click", async () => {
  const button = $("#test-connection"),
    label = $("#connection-result");
  button.disabled = true;
  label.hidden = false;
  label.classList.remove("failed");
  label.textContent = "正在测试连接…";
  try {
    const tested = resolveConfig(readDrawer());
    await chatRequest(
      tested,
      [{ role: "user", content: "Reply with OK only." }],
      { maxTokens: 16 },
    );
    const response = { model: tested.model };
    label.textContent = "连接成功 · " + response.model;
  } catch (error) {
    label.textContent = error.message;
    label.classList.add("failed");
  } finally {
    button.disabled = false;
  }
});
$("#link-form").addEventListener("submit", (event) => {
  event.preventDefault();
  run(true);
});
$("#extract-only").addEventListener("click", () => run(false));
$("#summarize-current").addEventListener("click", async () => {
  if (!transcript || busy) return;
  $("#error").hidden = true;
  setBusy(true);
  try {
    await generateCurrent();
  } catch (error) {
    showError(error);
  } finally {
    setBusy(false);
  }
});
$("#notes-tab").addEventListener("click", () => selectTab("notes"));
$("#transcript-tab").addEventListener("click", () => selectTab("transcript"));
document.querySelectorAll("[role=tab]").forEach((tab) =>
  tab.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const next =
        tab.id === "notes-tab" ? $("#transcript-tab") : $("#notes-tab");
      next.focus();
      next.click();
    }
  }),
);
$("#search").addEventListener("input", renderTranscript);
$("#copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(exportedMarkdown());
    toast("已复制内容。");
  } catch {
    toast("复制被浏览器阻止，请使用导出功能。");
  }
});
$("#download").addEventListener("click", () => {
  const content = exportedMarkdown();
  if (!content) return;
  const url = URL.createObjectURL(
    new Blob([content], { type: "text/markdown;charset=utf-8" }),
  );
  const anchor = make("a");
  anchor.href = url;
  anchor.download =
    (transcript.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, "-").slice(0, 80) ||
      "readvideo") + ".md";
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
});
$("#import-open").addEventListener(
  "click",
  () => !busy && $("#subtitle-file").click(),
);
$("#collector-open").addEventListener("click", () => {
  if (busy) return;
  const url = $("#video-url").value.trim();
  $("#collector-source").href =
    embeddedPlayerSafeBili(url) || "https://www.bilibili.com/";
  $("#collector-code").value = collectorScript();
  $("#collector-guide").showModal();
});
function embeddedPlayerSafeBili(value) {
  try {
    const url = new URL(value);
    if (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      ["bilibili.com", "www.bilibili.com", "m.bilibili.com"].includes(
        url.hostname,
      ) &&
      /^\/video\/(BV[\w]{10}|av\d+)(?:\/|$)/.test(url.pathname)
    )
      return url.href;
  } catch {}
  return null;
}
$("#collector-close").addEventListener("click", () =>
  $("#collector-guide").close(),
);
$("#collector-copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(collectorScript());
    toast("已复制。请在B站原页运行，下载后回到这里导入音频。");
  } catch {
    $("#collector-code").focus();
    $("#collector-code").select();
    toast("请从“查看脚本”中手动复制。");
  }
});
$("#audio-import-open").addEventListener(
  "click",
  () => !busy && $("#audio-file").click(),
);
$("#collector-import").addEventListener("click", () => {
  if (!busy) {
    $("#collector-guide").close();
    $("#audio-file").click();
  }
});
$("#audio-file").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file || busy) return;
  $("#error").hidden = true;
  try {
    if (!file.size || file.size > 128000000)
      throw Error("音频文件需在128 MB以内，且不能为空。");
    if (!/\.(m4a|mp3|wav|ogg|flac|mp4|webm)$/i.test(file.name))
      throw Error("请选择 M4A、MP3、WAV、OGG、FLAC、MP4 或 WebM 文件。");
    setBusy(true);
    generateAfterCapture = false;
    preparedTitle = "";
    $("#video-url").value = "";
    $("#video-url").required = false;
    $("#search").value = "";
    $("#capture-panel").hidden = false;
    $("#inline-player").hidden = true;
    $("#video-frame").removeAttribute("src");
    currentPlayer = null;
    $("#capture-start").hidden = true;
    $("#capture-stop").hidden = true;
    $("#open-video").hidden = true;
    $("#recovery-actions").hidden = true;
    $(".capture-heading h2").textContent = file.name;
    $("#capture-help").textContent =
      "正在本机读取音频，无需播放；转写完成后可根据字幕生成文章。";
    progress("正在读取本地音频", 10);
    const current = configureSession("");
    await current.startFile(file);
  } catch (error) {
    showError(error);
  } finally {
    event.target.value = "";
    setBusy(false);
  }
});
$("#subtitle-file").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file || busy) return;
  $("#error").hidden = true;
  try {
    if (file.size > 3_000_000) throw new Error("字幕文件不能超过 3 MB。");
    const format = file.name.split(".").pop().toLowerCase();
    if (!["srt", "vtt", "json", "json3"].includes(format))
      throw new Error("请选择 SRT、VTT 或 JSON 字幕文件。");
    setBusy(true);
    progress("正在读取字幕文件", 25);
    session?.close();
    session = null;
    $("#capture-panel").hidden = true;
    $("#video-frame").removeAttribute("src");
    currentPlayer = null;
    preferOtherTab = false;
    transcript = {
      segments: parseCaptions(await file.text(), format),
      title: file.name.replace(/\.[^.]+$/, ""),
      url: "",
      source: "subtitle-file",
      partial: false,
      automatic: false,
      language: "unknown",
    };
    lastURL = "";
    result = null;
    $("#search").value = "";
    updateReading();
    selectTab("transcript");
  } catch (error) {
    showError(error);
  } finally {
    event.target.value = "";
    setBusy(false);
  }
});

async function init() {
  bootstrap = { presets: PRESETS };
  let preferences = {};
  try {
    preferences = JSON.parse(
      localStorage.getItem("readvideo-preferences") || "{}",
    );
  } catch {}
  const provider = Object.hasOwn(bootstrap.presets, preferences.provider)
    ? preferences.provider
    : "deepseek";
  const preset = bootstrap.presets[provider];
  config = {
    provider,
    base_url:
      typeof preferences.base_url === "string"
        ? preferences.base_url
        : preset.base_url,
    model:
      typeof preferences.model === "string" ? preferences.model : preset.model,
    output_language: preferences.output_language === "en" ? "en" : "zh",
    api_key: "",
    edge_url:
      typeof preferences.edge_url === "string"
        ? preferences.edge_url
        : DEFAULT_EDGE_URL,
  };
  $("#provider-label").textContent = preset.name + " · 自带 API";
}
init().catch(() => {
  showError(new Error("页面初始化失败，请刷新重试。"));
  $("#generate").disabled = true;
});

for (const choice of document.querySelectorAll("[name=mode]")) {
  choice.addEventListener("change", () => {
    const summary =
      document.querySelector("[name=mode]:checked").value === "brief";
    document.querySelector("#length-control").hidden = summary;
    document.querySelector("#article-length").disabled = summary;
  });
}
