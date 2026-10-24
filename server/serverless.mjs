/**
 * readvideo 解析服务 —— 万能 Serverless 适配器
 *
 * 同一份代码可部署到：
 *   · 阿里云函数计算 FC（Node.js 运行时，处理程序填 `serverless.handler`）
 *   · 腾讯云云函数 SCF（处理程序填 `serverless.main_handler`）
 *   · Vercel / Netlify（default export）
 *   · Deno Deploy / Cloudflare Workers（default export 的 fetch）
 *
 * ⚠ 部署前务必先用 check-egress.mjs 验证该平台出口 IP 能访问 B 站。
 *   实测 Cloudflare Workers 全站 412（IP 段被封），不可用。
 *
 * 路由：
 *   GET  /health   健康检查
 *   POST /resolve  {url, language?, transport?}
 *   OPTIONS *      CORS 预检
 */

import { resolveVideo, ResolveError } from "./resolve-core.mjs";

const CORS_ORIGIN = (globalThis.process?.env?.RV_CORS_ORIGIN
  ?? "https://survivorno1.github.io,http://localhost:4186,http://127.0.0.1:4186")
  .split(",").map((s) => s.trim()).filter(Boolean);

const TOTAL_TIMEOUT_MS = Number(globalThis.process?.env?.RV_TOTAL_TIMEOUT_MS ?? 15000);
const MAX_BODY = Number(globalThis.process?.env?.RV_MAX_BODY ?? 8192);
const START_AT = Date.now();

// 单实例内的简易限流（Serverless 实例会被回收，不能当作全局限流）
const hits = new Map();
const RATE_PER_MIN = Number(globalThis.process?.env?.RV_RATE_PER_IP ?? 20);

function rateLimited(ip) {
  const now = Date.now();
  const key = ip || "unknown";
  const arr = (hits.get(key) || []).filter((t) => now - t < 60_000);
  if (arr.length >= RATE_PER_MIN) {
    hits.set(key, arr);
    return true;
  }
  arr.push(now);
  hits.set(key, arr);
  if (hits.size > 2000) hits.clear();
  return false;
}

function cors(origin) {
  const allow = origin && CORS_ORIGIN.includes(origin) ? origin : null;
  const h = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (allow) h["Access-Control-Allow-Origin"] = allow;
  return h;
}

function json(status, payload, extra = {}) {
  return {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra },
    body: JSON.stringify(payload),
  };
}

function withDeadline(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new ResolveError("解析超时", 504)), ms)),
  ]);
}

/**
 * 平台无关的核心：输入 {method, path, headers, body}，输出 {status, headers, body}
 */
export async function handle(request) {
  const origin = request.headers?.origin || request.headers?.Origin;
  const corsHeaders = cors(origin);
  const method = (request.method || "GET").toUpperCase();
  const path = (request.path || "/").replace(/\/+$/, "") || "/";

  if (method === "OPTIONS") return { status: 204, headers: corsHeaders, body: "" };

  if (path === "/health" || path.endsWith("/health")) {
    return json(200, { ok: true, uptime: Math.floor((Date.now() - START_AT) / 1000) }, corsHeaders);
  }

  if (!path.endsWith("/resolve")) {
    return json(404, { error: "not_found" }, corsHeaders);
  }

  if (method !== "POST") {
    return json(405, { error: "method_not_allowed", message: "请用 POST" }, corsHeaders);
  }

  const ip =
    request.headers?.["x-forwarded-for"]?.split(",")[0]?.trim() ||
    request.headers?.["X-Forwarded-For"]?.split(",")[0]?.trim() ||
    request.ip ||
    "unknown";

  if (rateLimited(ip)) {
    return json(429, { error: "rate_limited", message: "请求过于频繁，请稍后再试" }, corsHeaders);
  }

  const raw = request.body || "";
  if (raw.length > MAX_BODY) {
    return json(413, { error: "bad_request", message: "请求体过大" }, corsHeaders);
  }

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(400, { error: "bad_request", message: "请求体不是合法 JSON" }, corsHeaders);
  }

  const video = typeof body?.url === "string" ? body.url : "";
  if (!video) {
    return json(400, { error: "bad_request", message: "缺少 url 字段" }, corsHeaders);
  }

  try {
    const payload = await withDeadline(resolveVideo(video), TOTAL_TIMEOUT_MS);
    return json(200, payload, corsHeaders);
  } catch (e) {
    const status = e.status || 502;
    return json(
      status,
      {
        error: status === 429 ? "rate_limited" : status >= 500 ? "upstream_error" : "bad_request",
        message: e.message || "解析失败",
      },
      corsHeaders,
    );
  }
}

// ─────────────────────────────────────────────────────────────
// 平台适配层
// ─────────────────────────────────────────────────────────────

/** 阿里云函数计算 FC —— 处理程序填 `serverless.handler` */
export async function handler(event, context) {
  const raw = event?.isBase64Encoded
    ? Buffer.from(event.body || "", "base64").toString("utf8")
    : event?.body ?? "";
  const headers = {};
  for (const [k, v] of Object.entries(event?.headers || {})) headers[k.toLowerCase()] = v;
  const result = await handle({
    method: event?.httpMethod,
    path: event?.path || event?.rawPath || "/",
    headers,
    body: raw,
  });
  return {
    statusCode: result.status,
    headers: result.headers,
    body: result.body,
    isBase64Encoded: false,
  };
}

/** 腾讯云云函数 SCF —— 处理程序填 `serverless.main_handler` */
export async function main_handler(event, context) {
  const raw = event?.isBase64Encoded
    ? Buffer.from(event.body || "", "base64").toString("utf8")
    : event?.body ?? "";
  const headers = {};
  for (const [k, v] of Object.entries(event?.headers || {})) headers[k.toLowerCase()] = v;
  const result = await handle({
    method: event?.httpMethod,
    path: event?.path || "/",
    headers,
    body: raw,
  });
  return {
    statusCode: result.status,
    headers: result.headers,
    body: result.body,
    isBase64Encoded: false,
  };
}

/** Deno Deploy / Cloudflare Workers / Netlify Edge */
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const headers = {};
    for (const [k, v] of request.headers.entries()) headers[k.toLowerCase()] = v;
    const result = await handle({
      method: request.method,
      path: url.pathname,
      headers,
      body: request.method === "POST" ? await request.text() : "",
    });
    return new Response(result.body, { status: result.status, headers: result.headers });
  },
};

/** Vercel / Node 风格 (req, res) */
export async function vercelHandler(req, res) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers || {})) headers[k.toLowerCase()] = v;
  let raw = "";
  if (req.method === "POST") {
    if (typeof req.body === "string") raw = req.body;
    else if (req.body && typeof req.body === "object") raw = JSON.stringify(req.body);
    else {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      raw = Buffer.concat(chunks).toString("utf8");
    }
  }
  const result = await handle({ method: req.method, path: req.url || "/", headers, body: raw });
  res.writeHead(result.status, result.headers);
  res.end(result.body);
}
