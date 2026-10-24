#!/usr/bin/env node
/**
 * 本地验证 serverless 适配器：用 Node 内置 http 包一层，跑真实请求
 * 同时验证三种平台的事件格式转换
 */
import http from "node:http";
import { handle, handler, main_handler } from "../serverless.mjs";

const PORT = 8892;

// 1. 起一个本地 HTTP 服务，走 handle()
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = v;
  const result = await handle({
    method: req.method,
    path: req.url.split("?")[0],
    headers,
    body: Buffer.concat(chunks).toString("utf8"),
  });
  res.writeHead(result.status, result.headers);
  res.end(result.body);
});

await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = "https://survivorno1.github.io";

let pass = 0, fail = 0;
function check(name, ok, detail = "") {
  console.log(`  ${ok ? "✅" : "❌"} ${name}${detail ? "  " + detail : ""}`);
  ok ? pass++ : fail++;
}

async function post(body, origin = ORIGIN) {
  const r = await fetch(`${BASE}/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
    body: JSON.stringify(body),
  });
  return { status: r.status, headers: r.headers, json: await r.json().catch(() => null) };
}

console.log("=".repeat(70));
console.log("  serverless 适配器验证");
console.log("=".repeat(70));

// /health
const h = await fetch(`${BASE}/health`).then((r) => r.json()).catch(() => null);
check("GET /health", h?.ok === true);

// OPTIONS
const pre = await fetch(`${BASE}/resolve`, {
  method: "OPTIONS",
  headers: { Origin: ORIGIN, "Access-Control-Request-Method": "POST" },
});
check("OPTIONS 预检", pre.status === 204, `ACAO=${pre.headers.get("access-control-allow-origin")}`);

// 非法 JSON
const bad = await fetch(`${BASE}/resolve`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: "{oops",
});
check("非法 JSON → 400", bad.status === 400);

// 缺 url
const noUrl = await post({});
check("缺 url → 400", noUrl.status === 400, noUrl.json?.message ?? "");

// 无法识别
const junk = await post({ url: "hello" });
check("无法识别 → 400", junk.status === 400, junk.json?.message ?? "");

// 真实解析
const real = await post({ url: "https://www.bilibili.com/video/BV1VS4y1t7st/", transport: "direct-cdn" });
const okReal = real.status === 200 && real.json?.kind === "media" && real.json.urls?.length > 0;
check("真实解析 BV1VS4y1t7st", okReal,
  okReal ? `${real.json.title} · ${real.json.urls.length} 个地址` : JSON.stringify(real.json).slice(0, 100));

// 地址白名单
if (okReal) {
  const allOk = real.json.urls.every((u) => {
    const p = new URL(u);
    return p.protocol === "https:" && !p.port &&
      (p.hostname === "bilivideo.com" || p.hostname.endsWith(".bilivideo.com") ||
       p.hostname === "bilivideo.cn" || p.hostname.endsWith(".bilivideo.cn"));
  });
  check("音轨地址全部合规", allOk, real.json.urls.map((u) => new URL(u).hostname).join(", "));
}

// CORS 拒绝未授权来源
const evil = await post({ url: "BV1VS4y1t7st" }, "https://evil.example.com");
check("未授权 Origin 不回显 ACAO", evil.headers.get("access-control-allow-origin") === null);

// 不存在的 BV
const invalid = await post({ url: "BV1zzzzzzzzz" });
check("不存在的 BV → 400", invalid.status === 400, invalid.json?.message ?? "");

// 地区限制：从国内出口可访问，从海外出口可能 404；两种都算正确行为
const geo = await post({ url: "BV1GJ411x7h7" });
check(
  "地区敏感视频返回明确结果",
  geo.status === 200 || geo.status === 404,
  geo.status === 404 ? "海外 IP 被地区限制 → 404" : "本出口可访问 → 200",
);

// ── 平台事件格式 ──
console.log("\n  平台事件格式转换：");
const fcEvent = {
  httpMethod: "POST",
  path: "/resolve",
  headers: { "content-type": "application/json", origin: ORIGIN },
  body: JSON.stringify({ url: "BV1VS4y1t7st" }),
  isBase64Encoded: false,
};
const fcRes = await handler(fcEvent, {});
check("阿里云 FC handler", fcRes.statusCode === 200 && JSON.parse(fcRes.body).kind === "media",
  `statusCode=${fcRes.statusCode}`);

const scfEvent = { ...fcEvent };
const scfRes = await main_handler(scfEvent, {});
check("腾讯云 SCF main_handler", scfRes.statusCode === 200 && JSON.parse(scfRes.body).kind === "media",
  `statusCode=${scfRes.statusCode}`);

console.log("\n" + "=".repeat(70));
console.log(`  通过 ${pass} / ${pass + fail}`);
console.log("=".repeat(70));

server.close();
process.exit(fail === 0 ? 0 : 1);
