import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build, APP_FILES } from "../tools/build-site.mjs";
test("static package contains only reviewed site/app files with resolvable local links", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "readvideo-site-"));
  try {
    await build(directory);
    const files = [];
    async function list(folder) {
      for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
        const full = path.join(folder, entry.name);
        if (entry.isDirectory()) await list(full);
        else files.push(path.relative(directory, full).replaceAll("\\", "/"));
      }
    }
    await list(directory);
    const expected = [
      ".nojekyll",
      "index.html",
      "en.html",
      "style.css",
      "assets/home.png",
      "assets/article.png",
      "assets/browser-asr.png",
      "assets/icon.svg",
      ...APP_FILES.map((f) => "app/" + f),
    ];
    assert.deepEqual(files.sort(), expected.sort());
    for (const name of ["index.html", "en.html", "app/index.html"]) {
      const html = await fs.readFile(path.join(directory, name), "utf8");
      for (const match of html.matchAll(
        /(?:href|src)="([^"#]+)(?:#[^"]*)?"/g,
      )) {
        const target = match[1];
        if (/^(https?:|data:)/.test(target)) continue;
        // 构建时会给资源和入口脚本加 ?v=<hash> 做缓存穿透，比对文件时要去掉
        const clean = target.split("?")[0];
        const resolved = path.resolve(
          path.dirname(path.join(directory, name)),
          clean,
        );
        assert.ok(resolved.startsWith(directory));
        const info = await fs.stat(resolved);
        assert.ok(info.isFile() || info.isDirectory());
      }
    }
    const app = await fs.readFile(path.join(directory, "app/app.js"), "utf8");
    assert.equal(app.includes("/api/"), false);
    assert.equal(/sk-[a-zA-Z0-9_-]{24,}/.test(app), false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
