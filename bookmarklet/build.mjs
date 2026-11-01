/**
 * 把 bookmarklet/*.js 转成可拖拽的 javascript: 链接。
 * 生成：
 *   bookmarklet/dist/<name>.txt   —— 纯文本，手动复制用
 *   bookmarklet/dist/install.html —— 拖拽安装页
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const ITEMS = [
  {
    name: "youtube",
    file: "readvideo-youtube.js",
    label: "用 readvideo 读（YouTube）",
    title: "YouTube",
    intro:
      "在 YouTube 视频页点一下，会用 8 倍速把 CC 字幕收下来交给 readvideo。148 分钟的视频大约 19 分钟收完，字幕一个字不少。",
    steps: [
      "在电脑浏览器打开 YouTube 视频页",
      "确认有 CC 字幕（播放器右下角有字幕按钮）",
      "点书签栏上的「用 readvideo 读（YouTube）」",
      "会弹出 readvideo 自动接收；收完就能生成文章",
    ],
    note: "没有 CC 字幕的视频收不到东西。这类可以在 readvideo 里用「标签页音频授权」录声音转写。",
  },
  {
    name: "douyin",
    file: "readvideo-douyin.js",
    label: "用 readvideo 读（抖音）",
    title: "抖音",
    intro:
      "在抖音视频页点一下，把渲染好的视频地址交给 readvideo 直接下载转写。",
    steps: [
      "在电脑浏览器打开抖音视频页",
      "<strong>让视频开始缓冲</strong>（先点一下播放）",
      "点书签栏上的「用 readvideo 读（抖音）」",
      "会自动打开 readvideo 并开始转写",
    ],
    note: "抖音地址带签名、过期很快。提示失效就回抖音页面再点一次。",
  },
];

function minify(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/\s*\n\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

await fs.mkdir(path.join(here, "dist"), { recursive: true });
const built = [];

for (const item of ITEMS) {
  const src = await fs.readFile(path.join(here, item.file), "utf8");
  const href = "javascript:" + encodeURIComponent(minify(src));
  await fs.writeFile(path.join(here, `dist/${item.name}.txt`), href, "utf8");
  built.push({ ...item, href });
  console.log(`  ${item.name.padEnd(8)} ${href.length} 字符`);
}

const cards = built
  .map(
    (b) => `
  <div class="card">
    <h2>${b.title}</h2>
    <p>${b.intro}</p>
    <a class="install" href="${b.href.replace(/"/g, "&quot;")}">${b.label}</a>
    <ol>${b.steps.map((s) => `<li>${s}</li>`).join("")}</ol>
    <p class="note">${b.note}</p>
  </div>`,
  )
  .join("");

const html = `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<title>readvideo · 书签小工具</title>
<style>
  body { margin: 0; padding: 48px 24px; background: #FDFDFC; color: #16181C;
         font: 16px/1.7 "Songti SC", STSong, SimSun, serif; }
  main { max-width: 680px; margin: 0 auto; }
  h1 { font-size: 26px; margin: 0 0 8px; }
  h2 { font-size: 18px; margin: 0 0 8px; }
  p { color: #5a5f66; margin: 0 0 16px; }
  .card { border: 1px solid #E7E8EA; border-radius: 10px; padding: 24px;
          margin: 24px 0; background: #fff; }
  a.install { display: inline-block; padding: 12px 22px; border-radius: 8px;
              background: #CE3F32; color: #fff; text-decoration: none;
              font-weight: 600; cursor: grab; margin-bottom: 16px; }
  a.install:active { cursor: grabbing; }
  ol { padding-left: 22px; color: #3a3f46; margin: 0 0 14px; }
  li { margin: 8px 0; }
  .note { font-size: 14px; color: #767B82; border-left: 3px solid #E7E8EA;
          padding-left: 12px; margin: 0; }
</style>
<main>
  <h1>readvideo 书签小工具</h1>
  <p>把按钮拖到浏览器书签栏。以后在对应网站上点一下就行。</p>
${cards}
  <p class="note">
    手机上用不了（书签栏没有 JS 入口）。拖不动的话：右键书签栏 → 添加网页 →
    名称随便填，网址粘贴 <code>dist/&lt;站点&gt;.txt</code> 里的内容。
  </p>
</main>
</html>
`;

await fs.writeFile(path.join(here, "dist/install.html"), html, "utf8");
console.log("  dist/install.html");
