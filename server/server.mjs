/**
 * readvideo 解析服务 —— 单文件实现，零依赖（仅 Node 内置模块）
 *
 * 职责：把 B 站视频链接解析成「字幕」或「音轨直链」，不中转音视频。
 *
 * ── 关键实现要点（经实测确认，勿随意改动）────────────────────────
 * 1. 请求 api.bilibili.com 时【不要发 User-Agent】。
 *    实测：Chrome UA 从本机出口 → HTTP 412 "request was banned"；
 *          空 UA → HTTP 200 正常。这与直觉相反，是本服务能跑通的前提。
 * 2. 【不要发 Origin】头。B 站 API 有 Origin 白名单，带了会 403。
 * 3. 只返回域名在 bilivideo.com / bilivideo.cn 下、且【不带端口】的地址。
 *    前端 audioURL() 会拒绝带端口的地址（如 *.mountaintoys.cn:4483）和非白名单域名。
 * 4. urls 必须是同一音轨的镜像，不能混码率，否则前端的 Range 拼接会损坏文件。
 */

import http from 'node:http';
import { URL } from 'node:url';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// ══════════════════════════════════════════════════════════════
// 配置
// ══════════════════════════════════════════════════════════════
const conf = {
  host: process.env.RV_HOST || '127.0.0.1',
  port: Number(process.env.RV_PORT || 8891),

  // 总时限（含所有上游请求）
  totalTimeoutMs: Number(process.env.RV_TOTAL_TIMEOUT_MS || 15000),
  // 单个上游请求时限
  upstreamTimeoutMs: Number(process.env.RV_UPSTREAM_TIMEOUT_MS || 6000),

  // 并发：同时处理 N 个，排队 M 个
  concurrency: Number(process.env.RV_CONCURRENCY || 4),
  queueMax: Number(process.env.RV_QUEUE_MAX || 8),

  // 限流
  ratePerIp: Number(process.env.RV_RATE_PER_IP || 6),   // 次 / 分钟
  rateGlobal: Number(process.env.RV_RATE_GLOBAL || 60), // 全局 次 / 分钟

  // 缓存
  cacheTtlMs: Number(process.env.RV_CACHE_TTL_MS || 90000), // 90 秒（音频 URL 约 2h 过期）
  cacheMax: Number(process.env.RV_CACHE_MAX || 200),

  // 熔断
  breakerThreshold: Number(process.env.RV_BREAKER_THRESHOLD || 3),
  breakerCooldownMs: Number(process.env.RV_BREAKER_COOLDOWN_MS || 300000), // 5 分钟

  // 请求体
  maxBodyBytes: Number(process.env.RV_MAX_BODY || 8192),

  // 响应体上限
  maxUpstreamBytes: Number(process.env.RV_MAX_UPSTREAM || 2_000_000),

  // CORS
  corsOrigin: (process.env.RV_CORS_ORIGIN || 'https://survivorno1.github.io')
    .split(',').map(s => s.trim()).filter(Boolean),

  // 反代可信来源（只信任这些地址传来的 X-Forwarded-For）
  trustProxy: (process.env.RV_TRUST_PROXY || '127.0.0.1,::1,::ffff:127.0.0.1')
    .split(',').map(s => s.trim()).filter(Boolean),
};

const START_AT = Date.now();

// ══════════════════════════════════════════════════════════════
// 上游请求
// ══════════════════════════════════════════════════════════════
const UPSTREAM_ALLOW = new Set([
  'api.bilibili.com',
  'www.bilibili.com',
  'b23.tv',
]);

// ★ 空 UA：不发 User-Agent，是绕过 412 的关键
const UPSTREAM_HEADERS = {
  'Accept': 'application/json, text/plain, */*',
  'Referer': 'https://www.bilibili.com/',
  'Accept-Language': 'zh-CN,zh;q=0.9',
};

class UpstreamError extends Error {
  constructor(message, status = 502, code = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function upstreamJson(url, { timeoutMs = conf.upstreamTimeoutMs } = {}) {
  const u = new URL(url);
  if (!UPSTREAM_ALLOW.has(u.hostname)) {
    throw new UpstreamError('上游地址不在白名单内', 500);
  }

  let res;
  try {
    res = await fetch(url, {
      headers: UPSTREAM_HEADERS,
      redirect: 'manual',            // ★ 不跟随重定向，防止被导到未知域名
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new UpstreamError(`上游请求失败: ${e.name}`, 504);
  }

  if (res.status === 301 || res.status === 302 || res.status === 303 || res.status === 307 || res.status === 308) {
    throw new UpstreamError('上游返回重定向，已拒绝跟随', 502);
  }
  if (res.status === 412) {
    throw new UpstreamError('平台返回 412（触发风控）', 503, 412);
  }
  if (!res.ok) {
    throw new UpstreamError(`上游 HTTP ${res.status}`, 502);
  }

  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > conf.maxUpstreamBytes) {
    throw new UpstreamError('上游响应过大', 502);
  }
  const text = await res.text();
  if (text.length > conf.maxUpstreamBytes) {
    throw new UpstreamError('上游响应过大', 502);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new UpstreamError('上游返回非 JSON', 502);
  }
}

// ══════════════════════════════════════════════════════════════
// 熔断器
// ══════════════════════════════════════════════════════════════
const breaker = {
  failures: 0,
  openUntil: 0,
  isOpen() { return Date.now() < this.openUntil; },
  success() { this.failures = 0; },
  fail() {
    this.failures += 1;
    if (this.failures >= conf.breakerThreshold) {
      this.openUntil = Date.now() + conf.breakerCooldownMs;
      this.failures = 0;
      log(`熔断开启 ${conf.breakerCooldownMs / 1000}s`);
    }
  },
  snapshot() {
    return { open: this.isOpen(), until: this.openUntil, failures: this.failures };
  },
};

// ══════════════════════════════════════════════════════════════
// 限流
// ══════════════════════════════════════════════════════════════
class SlidingWindow {
  constructor(limit, windowMs) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = [];
  }
  tryTake() {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    while (this.hits.length && this.hits[0] < cutoff) this.hits.shift();
    if (this.hits.length >= this.limit) return false;
    this.hits.push(now);
    return true;
  }
  get size() { return this.hits.length; }
}

const ipWindows = new Map();          // ip -> SlidingWindow
const globalWindow = new SlidingWindow(conf.rateGlobal, 60_000);
let globalWindowRotatedAt = Date.now();

function checkRate(ip) {
  // 每 5 分钟清一次过期 IP 记录，避免 Map 无限增长
  if (Date.now() - globalWindowRotatedAt > 300_000) {
    globalWindowRotatedAt = Date.now();
    for (const [k, w] of ipWindows) {
      if (w.size === 0) ipWindows.delete(k);
    }
    if (ipWindows.size > 5000) ipWindows.clear();
  }
  if (!globalWindow.tryTake()) return { ok: false, reason: 'global' };
  let w = ipWindows.get(ip);
  if (!w) {
    w = new SlidingWindow(conf.ratePerIp, 60_000);
    ipWindows.set(ip, w);
  }
  if (!w.tryTake()) return { ok: false, reason: 'ip' };
  return { ok: true };
}

// ══════════════════════════════════════════════════════════════
// 并发闸门（N 并发 + M 排队）
// ══════════════════════════════════════════════════════════════
const gate = {
  running: 0,
  queue: [],
  acquire() {
    if (this.running < conf.concurrency) {
      this.running++;
      return Promise.resolve();
    }
    if (this.queue.length >= conf.queueMax) {
      return Promise.reject(new UpstreamError('服务繁忙', 503));
    }
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: null };
      entry.timer = setTimeout(() => {
        const i = this.queue.indexOf(entry);
        if (i >= 0) this.queue.splice(i, 1);
        reject(new UpstreamError('排队超时', 503));
      }, conf.totalTimeoutMs);
      this.queue.push(entry);
    });
  },
  release() {
    const next = this.queue.shift();
    if (next) {
      clearTimeout(next.timer);
      next.resolve();
    } else {
      this.running--;
    }
  },
  snapshot() { return { running: this.running, queue: this.queue.length }; },
};

// ══════════════════════════════════════════════════════════════
// 缓存
// ══════════════════════════════════════════════════════════════
const cache = new Map();      // key -> { at, payload }
const inflight = new Map();   // key -> Promise（合并重复请求）

function cacheGet(key) {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() - e.at > conf.cacheTtlMs) {
    cache.delete(key);
    return null;
  }
  return e.payload;
}

function cacheSet(key, payload) {
  if (cache.size >= conf.cacheMax) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) cache.delete(oldest[0]);
  }
  cache.set(key, { at: Date.now(), payload });
}

// ══════════════════════════════════════════════════════════════
// B 站解析
// ══════════════════════════════════════════════════════════════
const RE_BV = /(BV[0-9A-Za-z]{10})/;
const RE_AV = /(?:^|\/|av)(\d{1,12})(?:[/?#]|$)/i;
const RE_P = /[?&]p=(\d{1,4})/;

const AUDIO_HOST_OK = (hostname) => {
  const h = hostname.toLowerCase();
  return (h === 'bilivideo.com' || h.endsWith('.bilivideo.com') ||
          h === 'bilivideo.cn' || h.endsWith('.bilivideo.cn'));
};

/** 只保留：https、无端口、无账号密码、域名在 bilivideo 白名单 */
function sanitizeAudioUrls(candidates) {
  const out = [];
  const seen = new Set();
  for (const raw of candidates) {
    if (typeof raw !== 'string' || !raw) continue;
    let u;
    try { u = new URL(raw); } catch { continue; }
    if (u.protocol !== 'https:') continue;
    if (u.username || u.password) continue;
    if (u.port) continue;                      // ★ 前端会拒绝带端口的地址
    if (!AUDIO_HOST_OK(u.hostname)) continue;  // ★ 只放行 bilivideo.com / .cn
    const href = u.href;
    if (seen.has(href)) continue;
    seen.add(href);
    out.push(href);
    if (out.length >= 4) break;                // 前端上限 4
  }
  return out;
}

function parseVideoId(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (!s || s.length > 2048) return null;

  // b23.tv 短链单独处理（异步，见 resolve 中）
  const bv = RE_BV.exec(s);
  if (bv) {
    const pMatch = RE_P.exec(s);
    return { bvid: bv[1], page: pMatch ? Number(pMatch[1]) : 1, short: null };
  }
  if (/^BV[0-9A-Za-z]{10}$/.test(s)) {
    return { bvid: s, page: 1, short: null };
  }
  const av = RE_AV.exec(s);
  if (av) return { bvid: null, aid: Number(av[1]), page: 1, short: null };
  if (/^b23\.tv\//.test(s) || /^https?:\/\/b23\.tv\//.test(s)) {
    return { bvid: null, aid: null, page: 1, short: s.startsWith('http') ? s : 'https://' + s };
  }
  return null;
}

async function expandShort(shortUrl) {
  const u = new URL(shortUrl);
  if (u.hostname !== 'b23.tv') throw new UpstreamError('短链域名不受支持', 400);
  let res;
  try {
    res = await fetch(u.href, {
      headers: UPSTREAM_HEADERS,
      redirect: 'manual',
      signal: AbortSignal.timeout(conf.upstreamTimeoutMs),
    });
  } catch (e) {
    throw new UpstreamError('短链解析失败', 504);
  }
  const loc = res.headers.get('location');
  if (!loc) throw new UpstreamError('短链无重定向目标', 400);
  const bv = RE_BV.exec(loc);
  if (!bv) throw new UpstreamError('短链未指向有效视频', 400);
  return { bvid: bv[1], page: Number(RE_P.exec(loc)?.[1] || 1), short: null };
}

/** 拉取字幕（多数情况需要登录，无字幕时返回 null） */
async function fetchCaptions(bvid, cid) {
  try {
    const d = await upstreamJson(
      `https://api.bilibili.com/x/player/v2?bvid=${encodeURIComponent(bvid)}&cid=${cid}`,
      { timeoutMs: 4000 },
    );
    if (d?.code !== 0) return null;
    const subs = d?.data?.subtitle?.subtitles || [];
    if (!subs.length) return null;

    // 优先中文，其次 ai-zh，再次第一条
    const pick = subs.find(s => s.lan === 'zh-CN')
      || subs.find(s => /^ai-zh/.test(s.lan || ''))
      || subs[0];
    if (!pick?.subtitle_url) return null;

    let subUrl = pick.subtitle_url;
    if (subUrl.startsWith('//')) subUrl = 'https:' + subUrl;
    if (!/^https:\/\/[a-z0-9.-]*\.(bilibili\.com|hdslb\.com|bilivideo\.com)\//i.test(subUrl)) {
      return null;
    }

    let res;
    try {
      res = await fetch(subUrl, {
        headers: UPSTREAM_HEADERS,
        redirect: 'manual',
        signal: AbortSignal.timeout(4000),
      });
    } catch { return null; }
    if (!res.ok) return null;
    const text = await res.text();
    if (text.length > conf.maxUpstreamBytes) return null;

    let json;
    try { json = JSON.parse(text); } catch { return null; }
    const body = Array.isArray(json?.body) ? json.body : [];
    const segments = body
      .map(b => ({
        start: Number(b.from),
        end: Number(b.to),
        text: String(b.content ?? '').trim(),
      }))
      .filter(s => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start && s.text);

    if (!segments.length) return null;
    return { segments, language: pick.lan || 'zh-CN', automatic: /^ai-/.test(pick.lan || '') };
  } catch {
    return null;
  }
}

/** 主解析流程 */
async function resolveVideo(input) {
  const parsed = parseVideoId(input);
  if (!parsed) throw new UpstreamError('无法识别视频链接', 400);

  let { bvid, aid, page } = parsed;
  if (parsed.short) {
    const expanded = await expandShort(parsed.short);
    bvid = expanded.bvid; page = expanded.page;
  }

  // 1. 元数据
  const viewUrl = bvid
    ? `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`
    : `https://api.bilibili.com/x/web-interface/view?aid=${aid}`;
  const view = await upstreamJson(viewUrl);
  if (view?.code !== 0) {
    const code = view?.code;
    if (code === -404) throw new UpstreamError('视频不存在、已下架，或在服务所在地区不可见', 404, code);
    if (code === -403) throw new UpstreamError('该视频需要登录或更高权限', 403, code);
    // -400 通常表示 BV 号无效/不存在，属于客户端错误
    if (code === -400 || code === -626) {
      throw new UpstreamError('视频 ID 无效或该视频不存在', 400, code);
    }
    if (code === -412) throw new UpstreamError('平台触发风控（412），请稍后再试', 503, code);
    throw new UpstreamError(`平台返回 ${code ?? '未知错误'}：${view?.message ?? ''}`, 502, code);
  }

  const info = view.data;
  const pages = Array.isArray(info.pages) ? info.pages : [];
  const safePage = Math.max(1, Math.min(page || 1, pages.length || 1));
  const cid = pages.length >= safePage ? pages[safePage - 1].cid : info.cid;
  const partTitle = pages.length > 1 ? (pages[safePage - 1]?.part || '') : '';
  const title = (partTitle ? `${info.title} - ${partTitle}` : info.title || 'B站视频').slice(0, 1000);
  const duration = Number(info.duration) || undefined;

  // 2. 字幕（有就直接返回，不碰音轨）
  const caps = await fetchCaptions(bvid || String(info.bvid), cid);
  if (caps) {
    return {
      kind: 'captions',
      title,
      language: caps.language,
      automatic: caps.automatic,
      segments: caps.segments,
    };
  }

  // 3. 音轨
  const playUrl = `https://api.bilibili.com/x/player/playurl`
    + `?bvid=${encodeURIComponent(bvid || info.bvid)}&cid=${cid}&fnval=16&fourk=1`;
  const play = await upstreamJson(playUrl);
  if (play?.code !== 0) {
    throw new UpstreamError(`获取音轨失败：${play?.code} ${play?.message ?? ''}`, 502, play?.code);
  }

  const audios = play?.data?.dash?.audio || [];
  if (!audios.length) {
    throw new UpstreamError('该视频没有可用的独立音轨（可能需要登录或为付费内容）', 404);
  }

  // 取最高码率那一条，只用它的主地址 + 备份镜像（保证同一码率）
  const best = audios.slice().sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0];
  const candidates = [
    best.baseUrl || best.base_url,
    ...(best.backupUrl || best.backup_url || []),
  ];
  const urls = sanitizeAudioUrls(candidates);
  if (!urls.length) {
    throw new UpstreamError('平台返回的音轨地址不在允许的 CDN 域名内', 502);
  }

  const idSource = `${bvid || info.bvid}:${cid}:${best.id}:${best.bandwidth}`;
  const id = 'rv-' + createHash('sha256').update(idSource).digest('hex').slice(0, 32);

  return {
    kind: 'media',
    transport: 'direct-cdn',
    title,
    source_url: input.startsWith('http') ? input : `https://www.bilibili.com/video/${bvid || 'av' + aid}/`,
    id,
    urls,
    duration,
    quality: best.bandwidth || undefined,
    codecs: best.codecs || undefined,
  };
}

// ══════════════════════════════════════════════════════════════
// HTTP 层
// ══════════════════════════════════════════════════════════════
function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function clientIp(req) {
  const remote = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (conf.trustProxy.includes(req.socket.remoteAddress || '') || conf.trustProxy.includes(remote)) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.length < 200) {
      const first = xff.split(',')[0].trim().replace(/^::ffff:/, '');
      if (/^[0-9a-fA-F.:]{3,45}$/.test(first)) return first;
    }
  }
  return remote || 'unknown';
}

function corsHeaders(origin) {
  const allow = origin && conf.corsOrigin.includes(origin) ? origin : null;
  const h = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
  if (allow) h['Access-Control-Allow-Origin'] = allow;
  return h;
}

function send(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(body);
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > conf.maxBodyBytes) {
        reject(new UpstreamError('请求体过大', 413));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleResolve(req, res, ip, origin) {
  // 限流
  const rate = checkRate(ip);
  if (!rate.ok) {
    log(`限流 ${ip} (${rate.reason})`);
    return send(res, 429, { error: 'rate_limited', message: '请求过于频繁，请稍后再试' }, corsHeaders(origin));
  }

  // 熔断
  if (breaker.isOpen()) {
    return send(res, 503, { error: 'circuit_open', message: '解析服务暂时降级，请稍后再试' }, corsHeaders(origin));
  }

  // 请求体
  let raw;
  try {
    raw = await readBody(req);
  } catch (e) {
    return send(res, e.status || 400, { error: 'bad_request', message: e.message }, corsHeaders(origin));
  }

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return send(res, 400, { error: 'bad_request', message: '请求体不是合法 JSON' }, corsHeaders(origin));
  }

  const video = typeof body?.url === 'string' ? body.url : '';
  if (!video) {
    return send(res, 400, { error: 'bad_request', message: '缺少 url 字段' }, corsHeaders(origin));
  }

  // 缓存 / 合并
  const key = createHash('sha256').update(video).digest('hex');
  const cached = cacheGet(key);
  if (cached) {
    return send(res, 200, cached, { ...corsHeaders(origin), 'X-Cache': 'HIT' });
  }

  let task = inflight.get(key);
  if (!task) {
    task = (async () => {
      await gate.acquire();
      try {
        const payload = await withDeadline(resolveVideo(video), conf.totalTimeoutMs);
        cacheSet(key, payload);
        breaker.success();
        return payload;
      } catch (e) {
        if (e instanceof UpstreamError && (e.code === 412 || e.status === 503 || e.status === 504)) {
          breaker.fail();
        }
        throw e;
      } finally {
        gate.release();
      }
    })().finally(() => inflight.delete(key));
    inflight.set(key, task);
  }

  try {
    const payload = await task;
    log(`200 ${ip} ${video.slice(0, 80)} -> ${payload.kind}`);
    return send(res, 200, payload, { ...corsHeaders(origin), 'X-Cache': 'MISS' });
  } catch (e) {
    const status = e.status || 502;
    log(`${status} ${ip} ${video.slice(0, 80)} -> ${e.message}`);
    return send(res, status, {
      error: status === 429 ? 'rate_limited' : (status >= 500 ? 'upstream_error' : 'bad_request'),
      message: e.message || '解析失败',
    }, corsHeaders(origin));
  }
}

function withDeadline(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new UpstreamError('解析超时', 504)), ms)),
  ]);
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const ip = clientIp(req);
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(origin));
    return res.end();
  }

  if (url.pathname === '/health' && req.method === 'GET') {
    return send(res, 200, {
      ok: true,
      uptime: Math.floor((Date.now() - START_AT) / 1000),
      gate: gate.snapshot(),
      breaker: breaker.snapshot(),
      cache: cache.size,
    }, corsHeaders(origin));
  }

  if (url.pathname === '/resolve' && req.method === 'POST') {
    try {
      return await handleResolve(req, res, ip, origin);
    } catch (e) {
      log('未捕获异常', e);
      if (!res.headersSent) {
        return send(res, 500, { error: 'internal', message: '服务内部错误' }, corsHeaders(origin));
      }
      return res.end();
    }
  }

  return send(res, 404, { error: 'not_found' }, corsHeaders(origin));
});

server.headersTimeout = 20000;
server.requestTimeout = 25000;
server.keepAliveTimeout = 5000;

server.listen(conf.port, conf.host, () => {
  log(`readvideo resolve 启动 http://${conf.host}:${conf.port}`);
  log(`  并发 ${conf.concurrency} / 队列 ${conf.queueMax} / 总超时 ${conf.totalTimeoutMs}ms`);
  log(`  限流 ${conf.ratePerIp}/min/IP, 全局 ${conf.rateGlobal}/min`);
  log(`  熔断 ${conf.breakerThreshold} 次失败 -> ${conf.breakerCooldownMs / 1000}s`);
  log(`  CORS ${conf.corsOrigin.join(', ')}`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    log(`收到 ${sig}，关闭中`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

process.on('unhandledRejection', (e) => log('unhandledRejection', e?.message || e));
process.on('uncaughtException', (e) => log('uncaughtException', e?.message || e));
