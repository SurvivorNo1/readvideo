/**
 * readvideo YouTube 书签小工具
 *
 * 为什么这么干：YouTube 已经改成 SABR 流式传输，播放器里根本没有可下载的音频地址
 * （实测 streamingData 只有 serverAbrStreamingUrl，formats 里没有 url 字段）。
 * 服务端拉字幕又被 PoToken + 机房 IP 双重拦。
 *
 * 但字幕是文本——8 倍速播放不会让它掉质量。所以在页面里把 CC 字幕一条条收下来，
 * 攒齐了交给 readvideo。148 分钟的视频大概 19 分钟收完，一个字不少。
 *
 * 没有 CC 字幕的视频会提示改走「标签页音频」。
 */
(function () {
  var HOME = "https://survivorno1.github.io/readvideo/app/";
  var MIN_RATE = 1;
  var RATE = 8; // 实测 7.6-7.8 倍，缓冲跟得上

  // ── 前置检查 ──
  if (!/youtube\.com/.test(location.hostname)) {
    alert("这个书签要在 YouTube 视频页上用。");
    return;
  }
  var video = document.querySelector("video");
  if (!video) {
    alert("没找到播放器。等页面加载完、视频开始播放后再点。");
    return;
  }
  var vid = (location.search.match(/[?&]v=([\w-]{11})/) || [])[1];
  if (!vid) {
    alert("认不出视频 ID。");
    return;
  }
  if (window.__rvRunning) {
    alert("已经在跑了。要停止的话点右上角的「停止」。");
    return;
  }
  window.__rvRunning = true;

  var title = (document.title || "")
    .replace(/\s*[-–—]\s*YouTube\s*$/, "")
    .trim();

  // ── 打开 readvideo，等它就位 ──
  var win = window.open(
    HOME + "#youtube=" + encodeURIComponent(vid) + "&title=" + encodeURIComponent(title) + "&role=receiver",
    "_blank",
  );
  if (!win) {
    window.__rvRunning = false;
    alert("弹窗被拦了。请允许这个站点弹窗后重试。");
    return;
  }

  // ── 页面内进度浮层 ──
  var box = document.createElement("div");
  box.style.cssText =
    "position:fixed;right:16px;top:16px;z-index:2147483647;background:#16181C;color:#fff;" +
    "font:13px/1.6 system-ui,sans-serif;padding:12px 14px;border-radius:10px;" +
    "box-shadow:0 8px 28px rgba(0,0,0,.32);max-width:280px";
  var label = document.createElement("div");
  label.style.cssText = "font-weight:600;margin-bottom:4px";
  label.textContent = "readvideo 正在收集字幕";
  var detail = document.createElement("div");
  detail.style.cssText = "color:#b9bec6;white-space:pre-line";
  detail.textContent = "准备中…";
  var stop = document.createElement("button");
  stop.textContent = "停止";
  stop.style.cssText =
    "margin-top:8px;padding:4px 12px;border:0;border-radius:6px;background:#CE3F32;" +
    "color:#fff;font:inherit;cursor:pointer";
  box.appendChild(label);
  box.appendChild(detail);
  box.appendChild(stop);
  document.body.appendChild(box);

  function say(text) {
    detail.textContent = text;
  }

  // ── 开 CC ──
  var player = document.getElementById("movie_player");
  var ccOk = false;
  try {
    var tracks = (player && player.getOption("captions", "tracklist")) || [];
    if (tracks.length) {
      player.setOption("captions", "track", { languageCode: tracks[0].languageCode });
      ccOk = true;
    }
  } catch (e) {}

  if (!ccOk) {
    cleanup();
    alert(
      "这个视频没有可用的 CC 字幕。\n\n" +
        "可以在 readvideo 里用「标签页音频授权」录声音转写。",
    );
    return;
  }

  // ── 收字幕：用 MutationObserver，不靠轮询，一条都不漏 ──
  var segments = [];
  var lastText = "";
  var collecting = false;

  function currentText() {
    var nodes = document.querySelectorAll(".ytp-caption-segment");
    if (!nodes.length) return "";
    return Array.prototype.map
      .call(nodes, function (n) { return n.textContent || ""; })
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function push() {
    var text = currentText();
    if (!text || text === lastText) return;
    lastText = text;
    var t = video.currentTime;
    segments.push({ start: Math.max(0, t - 1.2), end: t, text: text });
    say("已收 " + segments.length + " 条\n" + fmt(t) + " / " + fmt(video.duration));
  }

  function fmt(s) {
    s = Math.floor(s || 0);
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(x).padStart(2, "0");
  }

  var observer = new MutationObserver(push);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  // ── 强制倍速 ──
  var resendTimer = null;
  var rateTimer = setInterval(function () {
    if (!collecting) return;
    if (video.playbackRate !== RATE) video.playbackRate = RATE;
    if (video.preservesPitch !== false) video.preservesPitch = false;
  }, 40);

  video.play().catch(function () {});

  // ── 等 readvideo 就绪 ──
  var started = false;
  function onMessage(ev) {
    if (!ev.data || ev.data.type !== "readvideo-ready") return;
    started = true;
    collecting = true;
    say("已收 0 条\n" + fmt(video.currentTime) + " / " + fmt(video.duration));
  }
  addEventListener("message", onMessage);

  // ── 收尾 ──
  function finish(reason) {
    if (!window.__rvRunning) return;
    collecting = false;
    observer.disconnect();
    clearInterval(rateTimer);
    if (resendTimer) clearInterval(resendTimer);
    removeEventListener("message", onMessage);
    video.playbackRate = 1;
    push();

    // 补齐到视频末尾：把最后一条的 end 拉到结尾
    if (segments.length) segments[segments.length - 1].end = video.duration || segments[segments.length - 1].end;

    // 发过去，并且一直重发直到 readvideo 回执。
    // 之前只发一次，如果那边 listener 还没就绪，整批字幕就丢了。
    var payload = {
      type: "readvideo-captions",
      videoId: vid,
      title: title,
      duration: Math.round(video.duration || 0),
      reason: reason,
      segments: segments,
    };
    var acked = false;
    var tries = 0;
    function onAck(ev) {
      if (!ev.data || ev.data.type !== "readvideo-got") return;
      acked = true;
      removeEventListener("message", onAck);
      if (resendTimer) clearInterval(resendTimer);
      label.textContent = "已送达";
      say("readvideo 已收到 " + segments.length + " 条字幕");
    }
    addEventListener("message", onAck);

    function send() {
      if (acked || tries > 40) return;
      tries++;
      try {
        win.postMessage(payload, new URL(HOME).origin);
      } catch (e) {}
    }
    resendTimer = setInterval(send, 1500);
    send();

    label.textContent = "完成";
    say(
      "已收 " + segments.length + " 条，" +
      (reason === "ended" ? "视频播完了" : "已停止") +
      "\n回到 readvideo 看结果",
    );
    stop.textContent = "关闭";
    stop.onclick = cleanup;
    window.__rvRunning = false;
  }

  function cleanup() {
    collecting = false;
    observer.disconnect();
    clearInterval(rateTimer);
    if (resendTimer) clearInterval(resendTimer);
    removeEventListener("message", onMessage);
    video.playbackRate = 1;
    box.remove();
    window.__rvRunning = false;
  }

  video.addEventListener("ended", function () { finish("ended"); }, { once: true });
  stop.onclick = function () { finish("stopped"); };

  // 兜底：如果 readvideo 一直没就绪，30 秒后提示
  setTimeout(function () {
    if (!started) say("readvideo 还没就绪…\n确认那个标签页已经打开");
  }, 30000);
})();
