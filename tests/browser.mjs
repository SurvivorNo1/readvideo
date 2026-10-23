import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const { chromium } = require(
  process.env.READVIDEO_PLAYWRIGHT_PATH || "playwright",
);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
await fs.mkdir(path.join(root, ".qa"), { recursive: true });
const server = spawn(
  process.env.READVIDEO_PYTHON || "python",
  ["tests/browser_server.py"],
  { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
);
let browser;
const results = [];
const step = async (name, fn) => {
  await fn();
  results.push(name);
  console.log("PASS " + name);
};
try {
  await Promise.race([
    once(server.stdout, "data"),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("Fixture server timeout")),
        6000,
      ).unref(),
    ),
  ]);
  browser = await chromium.launch({
    headless: true,
    ...(process.env.READVIDEO_BROWSER_CHANNEL
      ? { channel: process.env.READVIDEO_BROWSER_CHANNEL }
      : {}),
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(process.env.READVIDEO_RED ? 1500 : 10000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("http://127.0.0.1:4184");
  await step("article length offers four choices and is sent to generation", async () => {
    await page.getByRole('radio', {name:'完整文章', exact:true}).check();
    const length = page.getByLabel('文章篇幅', {exact:true});
    assert.equal(await length.locator('option').count(),4);
    for (const value of ['short','medium','long','detailed']) {
      await length.selectOption(value);
      await page.getByLabel('视频链接',{exact:true}).fill('https://www.youtube.com/watch?v=fixture');
      const sent = page.waitForRequest(r => r.url().endsWith('/api/generate'));
      await page.getByRole('button',{name:'提取并生成',exact:true}).click();
      const body = (await sent).postDataJSON();
      assert.equal(body.length,value);
      await page.waitForFunction(() => !document.querySelector('#generate').disabled);
      assert.match(await page.locator('#result-meta').textContent(), /短篇|中篇|长篇|详细/);
    }
  });
  await step(
    "single-page interface has a link entry, two modes and a configuration drawer",
    async () => {
      await page.getByLabel("视频链接", { exact: true }).waitFor();
      assert.equal(await page.locator("main").count(), 1);
      await page.getByRole("button", { name: "API 配置", exact: true }).click();
      assert.equal(
        await page.locator("#settings").evaluate((d) => d.open),
        true,
      );
      await page.getByRole("button", { name: "关闭配置", exact: true }).click();
    },
  );
  await step(
    "extract and generate produces readable content plus the source transcript",
    async () => {
      await page
        .getByLabel("视频链接", { exact: true })
        .fill("https://www.youtube.com/watch?v=fixture");
      await page
        .getByRole("button", { name: "提取并生成", exact: true })
        .click();
      await page.locator("#article h1").waitFor();
      assert.match(await page.locator("#article").textContent(), /论文阅读/);
      await page.getByRole("tab", { name: /原字幕/ }).click();
      assert.equal(await page.locator(".cue").count(), 3);
      await page.getByRole("tab", { name: "阅读笔记", exact: true }).click();
    },
  );
  await step("untrusted model HTML is never executed", async () => {
    assert.equal(await page.evaluate(() => window.fixtureInjection), undefined);
    assert.equal(await page.locator("#article script").count(), 0);
  });
  await step("timestamps point back to the original source", async () => {
    const anchor = page.locator("#article a.time-link").first();
    assert.match(await anchor.getAttribute("href"), /t=35/);
    assert.equal(await anchor.getAttribute("target"), "_blank");
  });
  await step(
    "Markdown download contains the article and source, but no credential",
    async () => {
      const waiting = page.waitForEvent("download");
      await page
        .getByRole("button", { name: "导出 Markdown", exact: true })
        .click();
      const file = path.join(root, ".qa/export.md");
      await (await waiting).saveAs(file);
      const text = await fs.readFile(file, "utf8");
      assert.match(text, /youtube.com/);
      assert.ok(!text.includes("fixture-key-not-real"));
    },
  );
  await step(
    "API keys never enter localStorage or sessionStorage",
    async () => {
      await page.getByRole("button", { name: "API 配置", exact: true }).click();
      await page
        .getByLabel("API Key", { exact: true })
        .fill("browser-memory-secret");
      await page.getByRole("button", { name: "保存配置", exact: true }).click();
      const storage = await page.evaluate(() =>
        JSON.stringify({
          local: { ...localStorage },
          session: { ...sessionStorage },
        }),
      );
      assert.ok(!storage.includes("browser-memory-secret"));
    },
  );
  await step("only extracting captions does not call generation", async () => {
    let generated = false;
    const listener = (request) => {
      if (request.url().endsWith("/api/generate")) generated = true;
    };
    page.on("request", listener);
    await page.getByRole("button", { name: "仅提取字幕", exact: true }).click();
    await page.getByRole("tab", { name: /原字幕/ }).waitFor();
    await page.waitForFunction(
      () => !document.querySelector("#generate").disabled,
    );
    page.off("request", listener);
    assert.equal(generated, false);
  });
  await step("search filters only the view; caption export preserves first and final cues", async () => {
    await page.getByRole('tab',{name:/原字幕/}).click();
    await page.getByLabel('搜索字幕',{exact:true}).fill('先明确');
    assert.equal(await page.locator('.cue').count(),1);
    const waiting=page.waitForEvent('download');
    await page.getByRole('button',{name:'导出 Markdown',exact:true}).click();
    const file=path.join(root,'.qa/full-transcript.md');
    await (await waiting).saveAs(file);
    const content=await fs.readFile(file,'utf8');
    assert.match(content,/先明确/);
    assert.match(content,/不要只记住结论/);
    assert.match(content,/01:32/);
    await page.getByLabel('搜索字幕',{exact:true}).fill('');
    assert.equal(await page.locator('.cue').count(),3);
  });
  await step(
    "missing captions are displayed as an error, not invented text",
    async () => {
      await page
        .getByLabel("视频链接", { exact: true })
        .fill("https://example.com/no-captions");
      await page
        .getByRole("button", { name: "仅提取字幕", exact: true })
        .click();
      await page.locator("#error").waitFor();
      assert.match(await page.locator("#error").textContent(), /没有可提取/);
    },
  );
  await step(
    "SRT imports remain usable when a platform blocks extraction",
    async () => {
      const file = path.join(root, ".qa/test.srt");
      await fs.writeFile(
        file,
        "1\n00:00:05,000 --> 00:00:08,000\nLocal subtitle input.\n",
      );
      await page.locator("#subtitle-file").setInputFiles(file);
      await page.waitForFunction(
        () => document.querySelectorAll(".cue").length === 1,
      );
      assert.match(await page.locator(".cue").textContent(), /Local subtitle/);
    },
  );
  await step(
    "mobile layout keeps the input and reading area within the viewport",
    async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
      );
    },
  );
  assert.deepEqual(errors, []);
  await fs.writeFile(
    path.join(root, ".qa/browser-results.json"),
    JSON.stringify(
      {
        kind: "deterministic browser fixtures, not a live API claim",
        passed: results.length,
        results,
      },
      null,
      2,
    ),
  );
  console.log(`${results.length} browser scenarios passed.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
  if (browser) {
    const pages = browser.contexts().flatMap((c) => c.pages());
    if (pages[0])
      await pages[0].screenshot({
        path: path.join(root, ".qa/browser-failure.png"),
        fullPage: true,
      });
  }
} finally {
  if (browser) await browser.close();
  server.kill();
}
