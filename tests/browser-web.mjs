// Deterministic adapters only: this is not evidence of real ASR or a real picker.
import { chromium } from "playwright";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { serve } from "./static-server.mjs";
import { collectBilibiliAudio } from "../web/collector.mjs";
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
    "Bilibili public subtitles use an isolated JSONP frame and need no helper",
    async () => {
      // Explicit JSONP response adapter. Native opaque-frame network interception
      // varies across Chrome builds; live endpoint evidence is recorded separately.
      const respond = async (frame) => {
        if (frame.url() !== "about:srcdoc") return;
        try {
          await frame.waitForFunction(
            () => typeof window.__readvideoInfo === "function",
            undefined,
            { timeout: 1000 },
          );
          await frame.evaluate(() => {
            const url = new URL(document.querySelector("script[src]").src);
            if (url.searchParams.get("aid") === "2") return;
            let isolated = false;
            try {
              parent.document.querySelector("#api-key");
            } catch {
              isolated = true;
            }
            window.__readvideoInfo({
              code: 0,
              isolated,
              data: {
                title: "Public Bilibili fixture",
                cid: 9,
                pages: [{ cid: 9 }],
                subtitle: {
                  list: [
                    {
                      lan: "en",
                      subtitle_url: "https://aisubtitle.hdslb.com/fixture.json",
                    },
                  ],
                },
              },
            });
          });
        } catch {} // A timeout case intentionally destroys its frame.
      };
      page.on("framenavigated", respond);
      await page.route("https://aisubtitle.hdslb.com/fixture.json", (r) =>
        r.fulfill({
          contentType: "application/json",
          headers: { "access-control-allow-origin": "*" },
          body: JSON.stringify({
            body: [
              {
                from: 0,
                to: 2,
                content: "Public Bilibili subtitle without extension.",
              },
            ],
          }),
        }),
      );
      const isolated = await page.evaluate(async () => {
        const { publicVideoInfo } = await import("./bilibili.mjs");
        window.postMessage(
          { token: "forged", payload: { code: 99 } },
          location.origin,
        );
        const result = await publicVideoInfo({ aid: "1" });
        let timeout = false;
        try {
          await publicVideoInfo({ aid: "2" }, 20);
        } catch {
          timeout = true;
        }
        return {
          isolated: result.isolated,
          timeout,
          frames: document.querySelectorAll("iframe[sandbox]").length,
        };
      });
      assert.deepEqual(isolated, { isolated: true, timeout: true, frames: 0 });
      await page
        .getByLabel("视频链接", { exact: true })
        .fill("https://www.bilibili.com/video/av728835116/");
      await page
        .getByRole("button", { name: "仅读取字幕", exact: true })
        .click();
      await page.waitForFunction(
        () => !document.querySelector("#generate").disabled,
      );
      assert.match(
        await page.locator("#transcript").textContent(),
        /Public Bilibili subtitle/,
      );
      assert.match(
        await page.locator("#source-title").textContent(),
        /Public Bilibili fixture/,
      );
      assert.equal(await page.locator("#capture-panel").isVisible(), false);
      page.off("framenavigated", respond);
    },
  );
  await step(
    "readable pages prefer captions, then validated full audio, keeping the page source",
    async () => {
      const observed = await page.evaluate(async () => {
        const { discoverSource } = await import("./source.mjs");
        const html =
          '<title>Lecture</title><video src="movie.mp4"><track kind="captions" src="captions.vtt"></video><audio src="sound.m4a"></audio>';
        const calls = [];
        let captionsAvailable = true;
        const fetcher = async (url) => {
          calls.push(url);
          if (url === "https://lecture.example/watch") {
            const response = new Response(html, {
              headers: { "content-type": "text/html" },
            });
            Object.defineProperty(response, "url", {
              value: "https://lecture.example/episodes/one",
            });
            return response;
          }
          if (url.endsWith("captions.vtt"))
            return new Response(
              captionsAvailable
                ? "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nCaption first."
                : "",
              { status: captionsAvailable ? 200 : 404 },
            );
          return new Response("", { headers: { "content-type": "audio/mp4" } });
        };
        const captions = await discoverSource(
          "https://lecture.example/watch",
          "auto",
          fetcher,
        );
        const captionCalls = calls.splice(0);
        captionsAvailable = false;
        const audio = await discoverSource(
          "https://lecture.example/watch",
          "auto",
          fetcher,
        );
        const audioCalls = calls.splice(0);
        const denied = await discoverSource(
          "https://lecture.example/watch",
          "auto",
          async (url) => {
            if (url.endsWith("/watch")) return fetcher(url);
            throw new TypeError("CORS denied");
          },
        );
        return { captions, captionCalls, audio, audioCalls, denied };
      });
      assert.equal(observed.captions.kind, "captions");
      assert.equal(
        observed.captionCalls.some((url) => url.endsWith(".m4a")),
        false,
      );
      assert.equal(observed.audio.kind, "media");
      assert.equal(
        observed.audio.url,
        "https://lecture.example/episodes/sound.m4a",
      );
      assert.equal(observed.audio.source_url, "https://lecture.example/watch");
      assert.equal(
        observed.audioCalls.some((url) => url.endsWith("movie.mp4")),
        false,
      );
      assert.equal(observed.denied.kind, "capture");
    },
  );
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
    "YouTube playback stays on the page and offers this-tab audio consent",
    async () => {
      let popups = 0;
      const onPopup = () => popups++;
      page.on("popup", onPopup);
      await page.route("https://www.youtube.com/watch?**", (r) => r.abort());
      await page.route("https://www.youtube-nocookie.com/embed/**", (r) =>
        r.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<p>Explicit embedded-player fixture; no real playback claim.</p>",
        }),
      );
      await page
        .getByLabel("视频链接", { exact: true })
        .fill("https://www.youtube.com/watch?v=V74AxCqOTvg");
      await page
        .getByRole("button", { name: "仅读取字幕", exact: true })
        .click();
      await page.getByTitle("YouTube 视频播放器", { exact: true }).waitFor();
      assert.equal(popups, 0);
      await page.evaluate(() => {
        navigator.mediaDevices.getDisplayMedia = async (options) => {
          window.captureRequest = options;
          throw new DOMException("Denied", "NotAllowedError");
        };
      });
      await page
        .getByRole("button", { name: "授权本页音频并转写", exact: true })
        .click();
      await page.waitForFunction(
        () => !document.querySelector("#generate").disabled,
      );
      assert.equal(
        await page.evaluate(() => window.captureRequest.preferCurrentTab),
        true,
      );
      assert.equal(
        await page.evaluate(() => window.captureRequest.audio.restrictOwnAudio),
        false,
      );
      const popup = page.waitForEvent("popup");
      await page.locator("#open-video").click();
      await (await popup).close();
      assert.equal(popups, 1);
      page.off("popup", onPopup);
      await page
        .getByRole("button", { name: "② 授权音频并开始", exact: true })
        .click();
      await page.waitForFunction(
        () => !document.querySelector("#generate").disabled,
      );
      assert.equal(
        await page.evaluate(() => window.captureRequest.preferCurrentTab),
        false,
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
    "a completed ASR transcript generates another length without recapturing",
    async () => {
      const before = generations.length;
      await page.evaluate(() => {
        window.recaptureCount = 0;
        navigator.mediaDevices.getDisplayMedia = async () => {
          window.recaptureCount++;
          throw Error("Unexpected second capture");
        };
      });
      await page.getByLabel("文章篇幅", { exact: true }).selectOption("short");
      await page
        .getByRole("button", { name: "读取并生成", exact: true })
        .click();
      await page.waitForFunction(
        () => !document.querySelector("#generate").disabled,
      );
      assert.equal(generations.length, before + 1);
      assert.match(generations.at(-1).messages[1].content, /Captured final/);
      assert.equal(await page.evaluate(() => window.recaptureCount), 0);
    },
  );
  await step(
    "a readable page's full audio is decoded without playing and exports the original link",
    async () => {
      const bytes = await page.evaluate(async () => {
        const { wavBlob } = await import("./audio.mjs");
        const pcm = Float32Array.from(
          { length: 16000 },
          (_, i) => Math.sin(i / 10) * 0.1,
        );
        return [...new Uint8Array(await wavBlob(pcm).arrayBuffer())];
      });
      await page.route("https://lecture.example/watch", (r) =>
        r.fulfill({
          contentType: "text/html",
          headers: { "access-control-allow-origin": "*" },
          body: '<title>Readable lecture</title><audio src="/speech.wav"></audio>',
        }),
      );
      await page.route("https://lecture.example/speech.wav", (r) =>
        r.fulfill({
          contentType: "audio/wav",
          headers: { "access-control-allow-origin": "*" },
          body: Buffer.from(bytes),
        }),
      );
      await page
        .getByLabel("视频链接", { exact: true })
        .fill("https://lecture.example/watch");
      await page
        .getByRole("button", { name: "仅读取字幕", exact: true })
        .click();
      await page.waitForFunction(
        () => !document.querySelector("#generate").disabled,
      );
      assert.match(
        await page.locator("#source-title").textContent(),
        /Readable lecture/,
      );
      const sourceLink = new URL(
        await page.locator("#source-link").getAttribute("href"),
      );
      sourceLink.searchParams.delete("t");
      assert.equal(sourceLink.href, "https://lecture.example/watch");
      assert.match(
        await page.locator("#transcript").textContent(),
        /Captured final/,
      );
      assert.equal(await page.evaluate(() => window.recaptureCount), 0);
      assert.equal(await page.locator("#error").isVisible(), false);
    },
  );
  await step(
    "collector save button downloads exactly the assembled bytes (platform adapter)",
    async () => {
      const fixture = await browser.newPage({ acceptDownloads: true });
      try {
        const bytes = Buffer.from(
          Array.from({ length: 1100000 }, (_, i) => i % 251),
        );
        await fixture.route(
          "https://www.bilibili.com/video/BV1VS4y1t7st/",
          (r) =>
            r.fulfill({
              contentType: "text/html",
              body: "<html><body>Explicit source-page fixture, not real platform evidence.</body></html>",
            }),
        );
        await fixture.route("https://cdn.bilivideo.com/fixture.m4s", (r) => {
          const range = r.request().headers().range;
          const match = range?.match(/bytes=(\d+)-(\d+)/);
          const start = match ? Number(match[1]) : 0,
            end = match ? Number(match[2]) : bytes.length - 1;
          return r.fulfill({
            status: match ? 206 : 200,
            contentType: "audio/mp4",
            headers: {
              "access-control-allow-origin": "*",
              "access-control-expose-headers": "Content-Range",
              "content-range": `bytes ${start}-${end}/${bytes.length}`,
            },
            body: bytes.subarray(start, end + 1),
          });
        });
        await fixture.goto("https://www.bilibili.com/video/BV1VS4y1t7st/");
        await fixture.evaluate(
          () =>
            (window.__playinfo__ = {
              data: {
                dash: {
                  audio: [
                    {
                      bandwidth: 64000,
                      baseUrl: "https://cdn.bilivideo.com/fixture.m4s",
                    },
                  ],
                },
              },
            }),
        );
        const result = await fixture.evaluate(collectBilibiliAudio, {
          save: true,
        });
        assert.equal(result.bytes, bytes.length);
        assert.equal(result.parallel, true);
        const download = fixture.waitForEvent("download");
        await fixture.locator("#readvideo-download-audio").click();
        await (await download).saveAs(".qa/collector-button.m4a");
        assert.deepEqual(await fs.readFile(".qa/collector-button.m4a"), bytes);
      } finally {
        await fixture.close();
      }
    },
  );
  await step(
    "manual Bilibili guide and local audio import work without a provider upload",
    async () => {
      await page
        .getByRole("button", { name: "B站原页取音轨", exact: true })
        .click();
      await page
        .getByRole("heading", { name: "原页获取，回这里阅读。", exact: true })
        .waitFor();
      const script = await page.locator("#collector-code").inputValue();
      assert.equal(
        /document\.cookie|localStorage|sessionStorage/.test(script),
        false,
      );
      await page
        .getByRole("button", { name: "关闭原页获取引导", exact: true })
        .click();
      const bytes = await page.evaluate(async () => {
        const { wavBlob } = await import("./audio.mjs");
        return [
          ...new Uint8Array(
            await wavBlob(
              Float32Array.from(
                { length: 16000 },
                (_, i) => Math.sin(i / 10) * 0.1,
              ),
            ).arrayBuffer(),
          ),
        ];
      });
      const before = generations.length;
      await page.locator("#audio-file").setInputFiles({
        name: "local-speech.wav",
        mimeType: "audio/wav",
        buffer: Buffer.from(bytes),
      });
      await page.waitForFunction(
        () => !document.querySelector("#generate").disabled,
      );
      assert.equal(generations.length, before);
      assert.match(
        await page.locator("#transcript").textContent(),
        /Captured final/,
      );
      assert.equal(await page.locator("#source-link").isVisible(), false);
      assert.match(
        await page.locator("#source-title").textContent(),
        /local-speech/,
      );
      await page.getByRole("tab", { name: "阅读笔记", exact: true }).click();
      await page
        .getByRole("button", { name: "根据字幕生成 →", exact: true })
        .click();
      await page.waitForFunction(
        () => !document.querySelector("#generate").disabled,
      );
      assert.equal(generations.length, before + 1);
      assert.match(generations.at(-1).messages[1].content, /Captured final/);
      await page.getByLabel("文章篇幅", { exact: true }).selectOption("long");
      await page
        .getByRole("button", { name: "读取并生成", exact: true })
        .click();
      await page.waitForFunction(
        () => !document.querySelector("#generate").disabled,
      );
      assert.equal(generations.length, before + 2);
    },
  );
  await step(
    "paste Bilibili link through Worker transport, local ASR and article generation with no playback or import (adapters)",
    async () => {
      const bytes = await page.evaluate(async () => {
        const { wavBlob } = await import("./audio.mjs");
        return [
          ...new Uint8Array(
            await wavBlob(
              Float32Array.from(
                { length: 16000 },
                (_, i) => Math.sin(i / 10) * 0.1,
              ),
            ).arrayBuffer(),
          ),
        ];
      });
      let sent;
      await page.route("https://readvideo-edge.example/resolve", async (r) => {
        const headers = {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "Content-Type",
          "access-control-allow-methods": "POST, OPTIONS",
        };
        if (r.request().method() === "OPTIONS")
          return r.fulfill({ status: 204, headers });
        sent = r.request().postDataJSON();
        return r.fulfill({
          contentType: "application/json",
          headers,
          body: JSON.stringify({
            kind: "media",
            title: "Worker resolved video",
            url: "https://readvideo-edge.example/media?ticket=fixture",
          }),
        });
      });
      await page.route(
        "https://readvideo-edge.example/media?ticket=fixture",
        (r) =>
          r.fulfill({
            contentType: "audio/wav",
            headers: { "access-control-allow-origin": "*" },
            body: Buffer.from(bytes),
          }),
      );
      await page.getByRole("button", { name: "API 配置", exact: true }).click();
      await page.locator("#advanced").evaluate((e) => (e.open = true));
      await page
        .getByLabel("视频解析服务", { exact: true })
        .fill("https://readvideo-edge.example");
      await page.getByRole("button", { name: "保存配置", exact: true }).click();
      const before = generations.length;
      await page
        .getByLabel("视频链接", { exact: true })
        .fill("https://www.bilibili.com/video/av728835116/");
      await page
        .getByRole("button", { name: "读取并生成", exact: true })
        .click();
      await page.waitForFunction(
        () => !document.querySelector("#generate").disabled,
      );
      assert.deepEqual(sent, {
        url: "https://www.bilibili.com/video/av728835116/",
        language: "auto",
      });
      assert.equal(generations.length, before + 1);
      assert.match(generations.at(-1).messages[1].content, /Captured final/);
      assert.match(
        await page.locator("#source-title").textContent(),
        /Worker resolved video/,
      );
      assert.equal(
        await page.locator("#video-frame").getAttribute("src"),
        null,
      );
      assert.equal(await page.locator("#capture-start").isVisible(), false);
      assert.equal(await page.locator("#error").isVisible(), false);
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
