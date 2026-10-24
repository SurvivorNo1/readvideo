// Opt-in actual local-file decode and CPU Whisper inference; no test adapters.
// Usage: node tests/asr-file-live.mjs /absolute/path/to/audio.m4a
import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { serve } from "./static-server.mjs";
const file = path.resolve(
  process.argv[2] || ".qa/bilibili-manual-reference.m4a",
);
await fs.access(file);
const site = await serve(path.resolve("web"));
const browser = await chromium.launch({
  channel: process.env.READVIDEO_BROWSER_CHANNEL || "chrome",
  headless: true,
});
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(site.url);
  await page.locator("#audio-file").waitFor({ state: "attached" });
  await page.evaluate(
    () => (document.querySelector("#asr-backend").value = "cpu"),
  );
  const started = Date.now();
  await page.locator("#audio-file").setInputFiles(file);
  const poll = setInterval(async () => {
    try {
      console.log(await page.locator("#progress-text").textContent());
    } catch {}
  }, 15000);
  try {
    await page.waitForFunction(
      () => !document.querySelector("#generate").disabled,
      undefined,
      { timeout: 300000 },
    );
  } finally {
    clearInterval(poll);
  }
  const error = await page
    .locator("#error")
    .evaluate((e) => (e.hidden ? "" : e.textContent));
  if (error) throw Error(error);
  const text = await page.locator("#transcript").textContent();
  assert.ok(
    text.length > 100,
    "Expected actual speech, not only an empty file",
  );
  assert.ok((await page.locator(".cue").count()) >= 3);
  assert.match(await page.locator("#engine-label").textContent(), /CPU/);
  assert.deepEqual(errors, []);
  const result = {
    kind: "actual local M4A import and CPU/WASM Whisper tiny; no adapters or LLM",
    testedAt: new Date().toISOString(),
    inputBytes: (await fs.stat(file)).size,
    totalProcessingMs: Date.now() - started,
    cues: await page.locator(".cue").count(),
    characters: text.length,
    topicWordsObserved: /sound|ear|hear|brain/i.test(text),
    engine: "wasm/cpu",
    note: "Total includes model fetching/initialization, decode and inference. Accuracy not scored. Separate from native browser Save completion.",
  };
  await fs.writeFile(
    ".qa/asr-file-live-result.json",
    JSON.stringify(result, null, 2),
  );
  await fs.writeFile(".qa/asr-file-live-transcript.txt", text);
  await page.locator("#reading").scrollIntoViewIfNeeded();
  await page.screenshot({ path: ".qa/bilibili-local-asr.png" });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
  await site.close();
}
