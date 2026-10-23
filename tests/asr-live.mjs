// Explicit real model test. Downloads public model weights and a spoken sample.
// No model adapters and no LLM key. Never enabled in ordinary CI.
import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { serve } from "./static-server.mjs";
const site = await serve(path.resolve("web"));
const browser = await chromium.launch({
  channel: process.env.READVIDEO_BROWSER_CHANNEL || "chrome",
  headless: true,
});
try {
  await fs.mkdir(".qa", { recursive: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") console.log("Browser:", m.text().slice(0, 300));
  });
  await page.goto(site.url);
  await page.locator("#video-url").waitFor();
  await page.screenshot({ path: "docs/images/home.png", fullPage: true });
  // Force CPU to verify the no-GPU route, not just capability detection.
  await page.evaluate(() => {
    document.querySelector("#asr-backend").value = "cpu";
  });
  await page
    .getByLabel("视频链接", { exact: true })
    .fill(
      "https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/jfk.wav",
    );
  await page.getByRole("button", { name: "仅读取字幕", exact: true }).click();
  let last = "";
  const poll = setInterval(async () => {
    try {
      const status = await page.locator("#progress-text").textContent();
      if (status !== last) {
        last = status;
        console.log(status);
      }
    } catch {}
  }, 5000);
  try {
    await page.waitForFunction(
      () => !document.querySelector("#generate").disabled,
      null,
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
  assert.match(text, /country/i);
  assert.match(await page.locator("#engine-label").textContent(), /CPU/);
  assert.deepEqual(errors, []);
  await page.locator("#reading").scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "docs/images/browser-asr.png",
    fullPage: true,
  });
  const result = {
    kind: "real browser WASM Whisper tiny inference, no mock, no application backend",
    testedAt: new Date().toISOString(),
    device: "wasm/cpu",
    source: "public JFK spoken sample",
    cues: await page.locator(".cue").count(),
    characters: text.length,
    text,
  };
  await fs.writeFile(
    ".qa/asr-live-result.json",
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
  await site.close();
}
