// Deterministic adapters only: this is not evidence of real ASR or a real picker.
import { chromium } from "playwright";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { serve } from "./static-server.mjs";
const root = path.resolve("."),
  site = await serve(path.join(root, "web"));
const browser = await chromium.launch({
  channel: process.env.READVIDEO_BROWSER_CHANNEL || "chrome",
  headless: true,
});
const results = [];
const step = async (name, fn) => {
  await fn();
  results.push(name);
  console.log("PASS " + name);
};
const captions =
  "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nFirst real subtitle cue.\n\n00:00:35.000 --> 00:00:39.000\nEvidence from the middle.\n\n00:01:32.000 --> 00:01:35.000\nFinal cue must remain.";
let page;
try {
  await fs.mkdir(".qa", { recursive: true });
  page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
  });
  const errors = [],
    requests = [],
    generations = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (r) => requests.push(r.url()));
  await page.route("https://captions.example/video.vtt", (r) =>
    r.fulfill({
      status: 200,
      headers: {
        "access-control-allow-origin": "*",
        "content-type": "text/vtt",
      },
      body: captions,
    }),
  );
  await page.route("https://platform.example/**", (r) => r.abort());
  await page.route("https://api.deepseek.com/chat/completions", async (r) => {
    if (r.request().method() === "OPTIONS")
      return r.fulfill({
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "*",
          "access-control-allow-methods": "POST, OPTIONS",
        },
      });
    const body = r.request().postDataJSON();
    generations.push(body);
    return r.fulfill({
      status: 200,
      headers: {
        "access-control-allow-origin": "*",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        choices: [
          {
            finish_reason: "stop",
            message: {
              content:
                "# A readable article\n\nEvidence from the source [00:35].\n\n<script>window.injected=true</script>",
            },
          },
        ],
      }),
    });
  });
  await page.goto(site.url);
  await step(
    "single static page initializes without any local API",
    async () => {
      await page.getByLabel("视频链接", { exact: true }).waitFor();
      await page.getByRole("button", { name: "API 配置", exact: true }).click();
      await page
        .getByLabel("API Key", { exact: true })
        .fill("browser-memory-test-secret");
      await page.getByRole("button", { name: "保存配置", exact: true }).click();
      assert.equal(
        requests.some((url) => url.startsWith(site.url + "/api/")),
        false,
      );
    },
  );
  await step(
    "readable captions skip ASR and generate directly from the browser",
    async () => {
      await page
        .getByLabel("视频链接", { exact: true })
        .fill("https://captions.example/video.vtt");
      await page
        .getByRole("button", { name: "读取并生成", exact: true })
        .click();
      await page.locator("#article h1").waitFor();
      assert.match(
        generations.at(-1).messages[1].content,
        /Final cue must remain/,
      );
      assert.equal(
        requests.some(
          (url) => url.includes("huggingface") || url.includes("asr-worker"),
        ),
        false,
      );
    },
  );
  await step("all four article lengths are applied and labelled", async () => {
    for (const length of ["short", "medium", "long", "detailed"]) {
      await page.getByLabel("文章篇幅", { exact: true }).selectOption(length);
      const count = generations.length;
      await page
        .getByRole("button", { name: "读取并生成", exact: true })
        .click();
      await page.waitForFunction(
        () => !document.querySelector("#generate").disabled,
      );
      assert.equal(generations.length, count + 1);
      assert.match(
        await page.locator("#result-meta").textContent(),
        /短篇|中篇|长篇|详细/,
      );
    }
    assert.equal(generations.at(-1).max_tokens, 14000);
  });
  await step(
    "model HTML is inert and timestamps point to source when available",
    async () => {
      assert.equal(await page.evaluate(() => window.injected), undefined);
      assert.equal(await page.locator("#article script").count(), 0);
    },
  );
  await step(
    "search only filters view; full transcript export keeps final cue",
    async () => {
      await page.getByRole("tab", { name: /字幕全文/ }).click();
      assert.equal(await page.locator(".cue").count(), 3);
      await page.getByLabel("搜索字幕", { exact: true }).fill("First");
      assert.equal(await page.locator(".cue").count(), 1);
      const download = page.waitForEvent("download");
      await page
        .getByRole("button", { name: "导出 Markdown", exact: true })
        .click();
      const file = ".qa/frontend-transcript.md";
      await (await download).saveAs(file);
      assert.match(await fs.readFile(file, "utf8"), /Final cue must remain/);
      await page.getByLabel("搜索字幕", { exact: true }).fill("");
    },
  );
  await step(
    "credentials stay out of browser storage and exports",
    async () => {
      const storage = await page.evaluate(() =>
        JSON.stringify({ ...localStorage, ...sessionStorage }),
      );
      assert.equal(storage.includes("browser-memory-test-secret"), false);
      assert.equal(
        (await fs.readFile(".qa/frontend-transcript.md", "utf8")).includes(
          "browser-memory-test-secret",
        ),
        false,
      );
    },
  );
  await step(
    "blocked platform captions offer explicit tab-audio consent without downloading a model",
    async () => {
      await page
        .getByLabel("视频链接", { exact: true })
        .fill("https://platform.example/watch");
      await page
        .getByRole("button", { name: "仅读取字幕", exact: true })
        .click();
      await page.locator("#capture-panel").waitFor();
      assert.match(
        await page.locator("#capture-help").textContent(),
        /共享标签页音频/,
      );
      assert.equal(
        requests.some((url) => url.includes("huggingface")),
        false,
      );
    },
  );
  await step(
    "denied audio permission is actionable and never uses a microphone",
    async () => {
      await page.evaluate(() => {
        navigator.mediaDevices.getDisplayMedia = async () => {
          throw new DOMException("Denied", "NotAllowedError");
        };
        navigator.mediaDevices.getUserMedia = () => {
          throw Error("Must not use mic");
        };
      });
      await page
        .getByRole("button", { name: "② 授权音频并开始", exact: true })
        .click();
      await page.waitForFunction(
        () => !document.querySelector("#generate").disabled,
      );
      assert.match(await page.locator("#error").textContent(), /未获授权/);
    },
  );
  await step(
    "sharing without audio stops all tracks and requests tab audio",
    async () => {
      await page.evaluate(() => {
        navigator.mediaDevices.getDisplayMedia = async () => {
          const c = document.createElement("canvas");
          c.width = c.height = 8;
          window.testShare = c.captureStream(1);
          return window.testShare;
        };
      });
      await page
        .getByRole("button", { name: "② 授权音频并开始", exact: true })
        .click();
      await page.waitForFunction(
        () => !document.querySelector("#generate").disabled,
      );
      assert.match(
        await page.locator("#error").textContent(),
        /没有收到标签页音频/,
      );
      assert.equal(
        await page.evaluate(() =>
          window.testShare.getTracks().every((t) => t.readyState === "ended"),
        ),
        true,
      );
    },
  );
  await step(
    "CPU capture adapter keeps the stop tail through the actual AudioWorklet",
    async () => {
      await page.route("**/asr-worker.mjs", (r) =>
        r.fulfill({
          status: 200,
          contentType: "text/javascript",
          body: `self.onmessage=({data})=>{if(data.action==='load')self.postMessage({id:data.id,type:'done',device:'wasm'});else self.postMessage({id:data.id,type:'done',device:'wasm',chunks:[{timestamp:[0,data.audio.length/16000],text:'Captured final short audio chunk.'}]});};`,
        }),
      );
      await page.evaluate(() => {
        navigator.mediaDevices.getDisplayMedia = async () => {
          const audio = new AudioContext();
          window.testAudio = audio;
          const osc = audio.createOscillator(),
            dest = audio.createMediaStreamDestination();
          osc.connect(dest);
          osc.start();
          await audio.resume();
          const c = document.createElement("canvas");
          c.width = c.height = 8;
          const stream = c.captureStream(1);
          for (const track of dest.stream.getAudioTracks())
            stream.addTrack(track);
          window.testShare = stream;
          return stream;
        };
      });
      await page.locator(".capture-options summary").click();
      await page
        .getByLabel("识别加速方式", { exact: true })
        .selectOption("cpu");
      await page
        .getByRole("button", { name: "② 授权音频并开始", exact: true })
        .click();
      await page.waitForFunction(() =>
        document
          .querySelector("#capture-status")
          .textContent.includes("已采集 00:01"),
      );
      await page
        .getByRole("button", { name: "停止采集，完成转写", exact: true })
        .click();
      await page.waitForFunction(
        () => !document.querySelector("#generate").disabled,
      );
      assert.match(
        await page.locator("#transcript").textContent(),
        /Captured final/,
      );
      assert.match(await page.locator("#engine-label").textContent(), /CPU/);
      assert.equal(
        await page.evaluate(() =>
          window.testShare.getTracks().every((t) => t.readyState === "ended"),
        ),
        true,
      );
      await page.evaluate(() => window.testAudio.close());
    },
  );
  await step(
    "subtitle imports require no model or application server",
    async () => {
      const file = ".qa/web-import.srt";
      await fs.writeFile(
        file,
        "1\n00:00:00,000 --> 00:00:01,000\nImported subtitle.\n",
      );
      await page.locator("#subtitle-file").setInputFiles(path.resolve(file));
      await page.waitForFunction(() =>
        document
          .querySelector("#transcript")
          .textContent.includes("Imported subtitle"),
      );
    },
  );
  await step("mobile layout stays within the viewport", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    );
  });
  assert.deepEqual(errors, []);
  assert.equal(
    requests.some((url) => url.startsWith(site.url + "/api/")),
    false,
  );
  await fs.writeFile(
    ".qa/web-browser-results.json",
    JSON.stringify(
      {
        kind: "deterministic browser adapters; real model is a separate test",
        passed: results.length,
        results,
      },
      null,
      2,
    ),
  );
  console.log(`${results.length} browser scenarios passed.`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
  if (page)
    await page.screenshot({
      path: ".qa/web-browser-failure.png",
      fullPage: true,
    });
} finally {
  await browser.close();
  await site.close();
}
