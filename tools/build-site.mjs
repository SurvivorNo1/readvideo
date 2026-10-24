import fs from "node:fs/promises";
import path from "node:path";
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
  await fs.writeFile(path.join(destination, ".nojekyll"), "");
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await build(path.resolve(process.argv[2] || ".qa/pages"));
