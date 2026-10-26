import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
export const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const APP_FILES = [
  "index.html",
  "style.css",
  "icon.svg",
  "app.js",
  "core.mjs",
  "audio.mjs",
  "session.mjs",
  "source.mjs",
  "bilibili.mjs",
  "collector.mjs",
  "edge.mjs",
  "download.mjs",
  "direct-audio.mjs",
  "mp4-segment.mjs",
  "audio-bridge.html",
  "audio-bridge.mjs",
  "deployment.mjs",
  "asr-worker.mjs",
  "audio-worklet.js",
];
export async function build(destination = path.join(ROOT, ".qa/pages")) {
  await fs.mkdir(path.join(destination, "assets"), { recursive: true });
  await fs.mkdir(path.join(destination, "app"), { recursive: true });
  for (const name of ["index.html", "en.html", "style.css"])
    await fs.copyFile(
      path.join(ROOT, "site", name),
      path.join(destination, name),
    );
  for (const name of ["home.png", "article.png", "browser-asr.png"])
    await fs.copyFile(
      path.join(ROOT, "docs/images", name),
      path.join(destination, "assets", name),
    );
  await fs.copyFile(
    path.join(ROOT, "web/icon.svg"),
    path.join(destination, "assets/icon.svg"),
  );
  for (const name of APP_FILES)
    await fs.copyFile(
      path.join(ROOT, "web", name),
      path.join(destination, "app", name),
    );

  // GitHub Pages 给所有文件都发 Cache-Control: max-age=600，发布后用户最多会
  // 跑十分钟旧代码。这里给入口脚本和样式加上内容哈希，只要 index.html 刷新过，
  // 引用的资源就一定是新的，不会出现"改了代码但浏览器还在跑旧版"。
  const hash = createHash("sha256");
  for (const name of ["app.js", "style.css"])
    hash.update(await fs.readFile(path.join(ROOT, "web", name)));
  const version = hash.digest("hex").slice(0, 10);

  const appIndex = path.join(destination, "app", "index.html");
  let html = await fs.readFile(appIndex, "utf8");
  html = html
    .replace(/(["'])app\.js(["'])/g, `$1app.js?v=${version}$2`)
    .replace(/(["'])style\.css(["'])/g, `$1style.css?v=${version}$2`);
  await fs.writeFile(appIndex, html);

  await fs.writeFile(path.join(destination, ".nojekyll"), "");
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await build(path.resolve(process.argv[2] || ".qa/pages"));
