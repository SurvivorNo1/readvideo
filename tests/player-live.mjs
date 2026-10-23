// Real embedded platform pages. No model adapters or permission automation.
import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
import { serve } from "./static-server.mjs";
const site = await serve(path.resolve("web"));
const browser = await chromium.launch({ channel: "chrome", headless: true });
const results = [];
try {
  for (const [platform, url, title] of [
    [
      "YouTube",
      "https://www.youtube.com/watch?v=V74AxCqOTvg",
      "YouTube 视频播放器",
    ],
    [
      "Bilibili",
      "https://www.bilibili.com/video/av728835116/",
      "Bilibili 视频播放器",
    ],
  ]) {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    await page.goto(site.url);
    await page.getByLabel("视频链接", { exact: true }).fill(url);
    await page.getByRole("button", { name: "仅读取字幕", exact: true }).click();
    const iframe = page.getByTitle(title, { exact: true });
    const result = {
      platform,
      url,
      testedAt: new Date().toISOString(),
      permissionGranted: false,
      captureTranscribed: false,
    };
    try {
      await iframe.waitFor({ timeout: 15000 });
      result.embeddedURL = await iframe.getAttribute("src");
      const player = page.frameLocator("#video-frame");
      try {
        await player.locator("video").waitFor({ timeout: 30000 });
      } catch {}
      result.hasVideoElement = await player.locator("video").count();
      if (result.hasVideoElement) {
        const play = player
          .getByRole("button", { name: /^(Play|播放|开始播放)/i })
          .first();
        try {
          if (await play.count()) await play.click({ timeout: 5000 });
          else
            await player
              .locator("video")
              .first()
              .click({ timeout: 5000, force: true });
        } catch {}
        result.playRequest = await player
          .locator("video")
          .first()
          .evaluate((v) =>
            Promise.race([
              v.play().then(
                () => "accepted",
                (e) => e.name,
              ),
              new Promise((r) =>
                setTimeout(() => r("playback-start-timeout"), 10000),
              ),
            ]),
          )
          .catch((e) => String(e.message).slice(0, 120));
        result.media = await player
          .locator("video")
          .first()
          .evaluate(async (v) => {
            const before = v.currentTime;
            await new Promise((r) => setTimeout(r, 3000));
            return {
              duration: Number.isFinite(v.duration) ? v.duration : null,
              readyState: v.readyState,
              paused: v.paused,
              error: v.error?.code || null,
              clockAdvanced: v.currentTime > before,
            };
          });
      }
      result.playerText = (
        await player.locator("body").innerText({ timeout: 10000 })
      ).slice(0, 700);
      result.status = result.media?.clockAdvanced
        ? "embedded-playback-clock-advanced-no-capture-claim"
        : "embedded-page-loaded-playback-unverified";
    } catch (error) {
      result.status = "blocked-or-unavailable-in-this-environment";
      result.error = String(error.message).slice(0, 180);
    }
    await page
      .locator("#capture-panel")
      .scrollIntoViewIfNeeded()
      .catch(() => {});
    await page.screenshot({
      path: `.qa/${platform.toLowerCase()}-embedded-live.png`,
      fullPage: true,
    });
    results.push(result);
    console.log(JSON.stringify(result));
    await page.close();
  }
  await fs.writeFile(
    ".qa/player-live-results.json",
    JSON.stringify(results, null, 2),
  );
} finally {
  await browser.close();
  await site.close();
}
