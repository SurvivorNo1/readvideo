/**
 * readvideo 抖音书签小工具
 *
 * 用法：在抖音视频页点一下书签，它把渲染好的视频直链交给 readvideo。
 *
 * 为什么要这么做：抖音的视频地址只在浏览器渲染之后才存在，
 * 服务器抓分享页拿不到（实测桌面 UA 返回 SPA 壳、移动 UA 的 _ROUTER_DATA 里没有视频数据）。
 * 而一旦拿到地址，抖音 CDN 是允许跨域直读的（实测 206 + 有效 MP4）。
 *
 * 所以：让浏览器自己把地址找出来，交给 readvideo 下载。
 * 不碰反爬、不做签名、不经过任何服务器。
 */
(function () {
  var readvideo = "https://survivorno1.github.io/readvideo/app/";

  // 1. 从页面里找所有 douyinvod 地址（实测一个页面会有 3 个不同主机/签名）
  var html = document.documentElement.innerHTML;
  var found = html.match(/https?:\/\/[^"'\\\s]*douyinvod\.com[^"'\\\s]*/g) || [];

  // 2. 也翻一下页面里的内联 JSON，有些版本地址藏在这里
  try {
    document.querySelectorAll("script").forEach(function (s) {
      if (!s.textContent) return;
      var m = s.textContent.match(/https?:\/\/[^"'\\\s]*douyinvod\.com[^"'\\\s]*/g);
      if (m) found = found.concat(m);
    });
  } catch (e) {}

  var urls = [];
  for (var i = 0; i < found.length; i++) {
    // 去掉尾部可能粘上的转义和标点
    var u = found[i].replace(/[\\",)\]}]+$/, "");
    if (urls.indexOf(u) < 0) urls.push(u);
  }

  if (!urls.length) {
    alert(
      "没找到视频地址。\n\n请先点一下播放让视频开始缓冲，再点这个书签。",
    );
    return;
  }

  var title = (document.title || "")
    .replace(/\s*[-–—]\s*抖音.*$/, "")
    .replace(/\s*[-–—]\s*Douyin.*$/i, "")
    .trim();

  // 多个地址都带上，readvideo 会按顺序试——实测有的主机 206、有的 403
  var target =
    readvideo +
    "#douyin=" +
    encodeURIComponent(urls.slice(0, 4).join("|")) +
    "&title=" +
    encodeURIComponent(title);

  window.open(target, "_blank");
})();
