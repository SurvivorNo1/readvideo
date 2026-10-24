// Opt-in Cloudflare network acceptance. No model/API keys, cookies or mocks.
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
const value = process.env.READVIDEO_WORKER_URL || process.argv[2];
const endpoint = new URL(value);
if (
  endpoint.protocol !== "https:" ||
  endpoint.username ||
  endpoint.password ||
  endpoint.pathname !== "/" ||
  !endpoint.hostname.endsWith(".workers.dev")
)
  throw Error("Provide an HTTPS workers.dev root URL.");
const origin = "https://survivorno1.github.io";
const result = {
  testedAt: new Date().toISOString(),
  worker: endpoint.origin,
  sample: "https://www.bilibili.com/video/av728835116/",
  environment: process.env.GITHUB_ACTIONS
    ? "GitHub-hosted runner"
    : "local Node network; not browser",
  verified: false,
};
try {
  const health = await fetch(endpoint.origin + "/health", {
    signal: AbortSignal.timeout(20000),
  });
  result.healthStatus = health.status;
  result.placement = health.headers.get("cf-placement");
  result.ingress = health.headers.get("cf-ray")?.split("-").pop() || null;
  if (!health.ok) throw Error("Health failed");
  const start = Date.now();
  const r = await fetch(endpoint.origin + "/resolve", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ url: result.sample, language: "auto" }),
    signal: AbortSignal.timeout(90000),
  });
  result.resolveStatus = r.status;
  result.resolveMs = Date.now() - start;
  result.cors = r.headers.get("Access-Control-Allow-Origin");
  const source = await r.json();
  if (!r.ok) {
    result.error = source.error;
    throw Error("Resolve failed");
  }
  result.kind = source.kind;
  if (source.kind === "media") {
    const media = new URL(source.url);
    if (media.origin !== endpoint.origin || media.pathname !== "/media")
      throw Error("Unexpected media destination");
    const transferStart = Date.now();
    const response = await fetch(media, {
      headers: { Origin: origin },
      signal: AbortSignal.timeout(90000),
    });
    result.mediaStatus = response.status;
    if (!response.ok) throw Error("Media failed");
    const reader = response.body.getReader(),
      parts = [];
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 32000000) {
        await reader.cancel();
        throw Error("Too large");
      }
      parts.push(value);
    }
    const bytes = Buffer.concat(parts);
    result.mediaBytes = bytes.length;
    result.mediaMs = Date.now() - transferStart;
    result.sha256 = createHash("sha256").update(bytes).digest("hex");
    if (bytes.length < 1024) throw Error("Audio too short");
    const range = await fetch(media, {
      headers: { Origin: origin, Range: "bytes=0-1023" },
      signal: AbortSignal.timeout(30000),
    });
    result.rangeStatus = range.status;
    const prefix = Buffer.from(await range.arrayBuffer());
    result.rangeMatches =
      range.status === 206 && prefix.equals(bytes.subarray(0, 1024));
    if (!result.rangeMatches) throw Error("Range mismatch");
  } else if (source.kind === "captions") result.cues = source.segments.length;
  else throw Error("Unknown source");
  result.verified = true;
} catch (e) {
  result.failure =
    e.name === "TypeError" ? "Network connection failed" : e.message;
  process.exitCode = 1;
}
await fs.mkdir(".qa", { recursive: true });
await fs.writeFile(
  ".qa/worker-live-result.json",
  JSON.stringify(result, null, 2),
);
console.log(JSON.stringify(result, null, 2));
