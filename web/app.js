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

async function api(path, data) {
  const response = await fetch(path, {
    method: data ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      "X-Readvideo-Token": bootstrap?.token || "",
    },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "请求失败，请重试。");
  return payload;
}
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
async function waitJob(job, onProgress = progress) {
  for (let count = 0; count < 900; count++) {
    const state = await api("/api/jobs/" + encodeURIComponent(job.id));
    onProgress(state.stage, state.progress);
    if (state.status === "done") return state.result;
    if (state.status === "error") throw new Error(state.error);
    await new Promise((resolve) => setTimeout(resolve, 600));
  }
  throw new Error("等待时间过长。后端任务可能仍在运行，请稍后重试。");
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
  const duration = transcript.duration ? time(transcript.duration) : "";
  const chars = transcript.segments.reduce((n, s) => n + s.text.length, 0);
  $("#source-meta").textContent = [
    transcript.uploader,
    duration,
    transcript.source === "subtitle-file"
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
      `${result.model} · ${result.mode === "brief" ? "速读摘要" : "完整文章"} · 基于字幕生成`;
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
async function generateCurrent() {
  const mode = document.querySelector("[name=mode]:checked").value;
  const job = await api("/api/generate", {
    transcript_id: transcript.transcript_id,
    mode,
    language: config.output_language,
    config,
  });
  result = await waitJob(job);
  updateReading();
  selectTab("notes");
}
async function run(generate = true) {
  if (busy || !bootstrap) return;
  const url = $("#video-url").value.trim();
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error();
  } catch {
    showError(new Error("请粘贴有效的 HTTP(S) 视频链接，或导入字幕文件。"));
    $("#video-url").focus();
    return;
  }
  $("#error").hidden = true;
  setBusy(true);
  try {
    if (
      !transcript ||
      lastURL !== url ||
      transcript.requested_language !== $("#caption-language").value
    ) {
      progress("正在读取视频信息", 5);
      const job = await api("/api/extract", {
        url,
        language: $("#caption-language").value,
      });
      transcript = await waitJob(job);
      transcript.requested_language = $("#caption-language").value;
      lastURL = url;
      result = null;
      $("#search").value = "";
      updateReading();
    }
    if (generate) {
      await generateCurrent();
    } else {
      selectTab("transcript");
    }
  } catch (error) {
    showError(error);
    if (transcript) updateReading();
  } finally {
    setBusy(false);
  }
}
function exportedMarkdown() {
  if (!transcript) return "";
  const source = transcript.url ? "来源：" + transcript.url + "\n\n" : "";
  return activeTab === "transcript"
    ? "# " +
        transcript.title +
        "\n\n" +
        source +
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
    provider === "deepseek" && bootstrap.server_key_available
      ? "本次服务已在后端内存加载 DeepSeek 调试 Key，可留空。不会回传 Key 或写入文件。"
      : "不会写入浏览器存储、项目文件或导出文章。刷新页面后需重新填写。";
}
function openSettings() {
  for (const [id, key] of [
    ["provider", "provider"],
    ["base-url", "base_url"],
    ["model", "model"],
    ["api-key", "api_key"],
    ["output-language", "output_language"],
  ])
    $("#" + id).value = config[key] || "";
  $("#advanced").open = config.provider === "custom";
  describeProvider();
  $("#connection-result").hidden = true;
  $("#settings").showModal();
}
$("#settings-open").addEventListener("click", () =>
  bootstrap ? openSettings() : toast("正在连接本机服务…"),
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
  config = readDrawer();
  const { provider, base_url, model, output_language } = config;
  try {
    localStorage.setItem(
      "readvideo-preferences",
      JSON.stringify({ provider, base_url, model, output_language }),
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
    const job = await api("/api/test", { config: readDrawer() });
    const response = await waitJob(
      job,
      (message) => (label.textContent = message),
    );
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
    transcript = await api("/api/import", {
      content: await file.text(),
      format,
      title: file.name.replace(/\.[^.]+$/, ""),
    });
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
  bootstrap = await api("/api/bootstrap");
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
  };
  $("#provider-label").textContent = preset.name + " · 自带 API";
}
init().catch(() => {
  showError(
    new Error(
      "无法连接 readvideo 本机服务，请确认 app.py 正在运行，然后刷新页面。",
    ),
  );
  $("#generate").disabled = true;
});
