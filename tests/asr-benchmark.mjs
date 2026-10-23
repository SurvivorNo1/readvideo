// Real browser CPU timing. No adapters, no capture-permission shortcuts, no API key.
import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { serve } from "./static-server.mjs";
const site = await serve(path.resolve("web"));
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage();
  await page.goto(site.url);
  const result = await page.evaluate(async () => {
    const { BrowserASR } = await import("./audio.mjs");
    const { resample } = await import("./core.mjs");
    const url = "https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/jfk.wav";
    const response = await fetch(url);
    if (!response.ok) throw Error("Sample unavailable");
    const context = new AudioContext();
    const decoded = await context.decodeAudioData(await response.arrayBuffer());
    const audio = resample(decoded.getChannelData(0), decoded.sampleRate);
    const duration = decoded.duration;
    await context.close();
    const asr = new BrowserASR();
    asr.backend = "cpu";
    try {
      const setupStart = performance.now();
      await asr.load();
      const modelSetupMs = performance.now() - setupStart;
      const firstStart = performance.now();
      const first = await asr.recognize({ audio }, "en");
      const firstInferenceMs = performance.now() - firstStart;
      const warmStart = performance.now();
      const warm = await asr.recognize({ audio }, "en");
      const warmInferenceMs = performance.now() - warmStart;
      return {
        kind: "real CPU/WASM inference; same public sample twice, no platform-capture claim",
        testedAt: new Date().toISOString(),
        userAgent: navigator.userAgent,
        logicalCores: navigator.hardwareConcurrency,
        device: asr.device,
        audioSeconds: duration,
        modelSetupMs,
        firstInferenceMs,
        warmInferenceMs,
        firstInferenceSpeed: duration / (firstInferenceMs / 1000),
        warmInferenceSpeed: duration / (warmInferenceMs / 1000),
        firstText: first.text,
        warmText: warm.text,
      };
    } finally { asr.dispose(); }
  });
  assert.equal(result.device, "wasm");
  assert.match(result.firstText, /country/i);
  assert.match(result.warmText, /country/i);
  await fs.writeFile(".qa/asr-benchmark.json", JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); await site.close(); }
