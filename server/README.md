# readvideo resolve server

Bilibili **轻量解析服务**。只解析，不中转音视频、不跑 ASR、不代理模型。

## 它做什么

```
GitHub Pages 前端
      │  POST /resolve {url, transport:"direct-cdn"}
      ▼
本服务（VPS, 127.0.0.1:8891）
      │  请求 api.bilibili.com（不带 Origin、不带 User-Agent）
      ▼
返回 {kind:"media", urls:[…]}  ──► 前端直连 B 站 CDN 下载
```

后端**不产生音视频流量**，只返回地址。

## 关键实现约束（改代码前必读）

| # | 约束 | 原因 |
|---|---|---|
| 1 | 请求 B 站 API 时**不发 `User-Agent`** | 实测：Chrome UA 从本机出口返回 `412 request was banned`；空 UA 返回 200 |
| 2 | **不发 `Origin` 头** | B 站 API 有 Origin 白名单，带了直接 403 |
| 3 | 只返回 `bilivideo.com` / `bilivideo.cn` 且**不带端口**的地址 | 前端 `audioURL()` 会拒绝其他域名与带端口的地址；`*.mountaintoys.cn:4483`、`akamaized.net` 都会被拒 |
| 4 | `urls` 必须是**同一音轨的镜像**，不能混码率 | 前端按 Range 分块拼接，混码率会损坏文件 |
| 5 | 前端下载页 CSP 只放行 `*.bilivideo.com` / `.cn` | 与第 3 条一致 |

## 目录

```
server/
├── server.mjs            主程序（单文件，零依赖）
├── package.json
└── deploy/
    ├── readvideo.service systemd 单元（含资源限额与安全加固）
    ├── env.example       环境变量模板
    ├── 01-install-service.sh
    ├── 02-nginx-route.sh
    └── 99-uninstall.sh
```

## 接口

### `POST /resolve`

请求：

```json
{"url": "https://www.bilibili.com/video/BV1QAnB67EL3/", "language": "auto", "transport": "direct-cdn"}
```

有字幕：

```json
{"kind": "captions", "title": "…", "language": "zh-CN", "automatic": false,
 "segments": [{"start": 0.0, "end": 2.5, "text": "…"}]}
```

无字幕：

```json
{"kind": "media", "transport": "direct-cdn", "title": "…", "source_url": "…",
 "id": "rv-…", "urls": ["https://…bilivideo.com/…"], "duration": 2512,
 "quality": 152000, "codecs": "mp4a.40.2"}
```

错误响应：

| HTTP | error | 含义 |
|---|---|---|
| 400 | `bad_request` | 链接无法识别 / 请求体非法 / 视频 ID 无效 |
| 403 | `bad_request` | 需要登录或更高权限 |
| 404 | `bad_request` | 视频不存在、已下架，或在服务所在地区不可见 |
| 429 | `rate_limited` | 触发限流 |
| 503 | `circuit_open` / `upstream_error` | 熔断中 / 平台触发风控 |
| 504 | `upstream_error` | 上游超时 |

### `GET /health`

```json
{"ok": true, "uptime": 123, "gate": {"running": 0, "queue": 0},
 "breaker": {"open": false, "until": 0, "failures": 0}, "cache": 3}
```

## 防护设计

| 项 | 默认值 | 环境变量 |
|---|---|---|
| 监听 | `127.0.0.1:8891`（仅 loopback） | `RV_HOST` / `RV_PORT` |
| 总超时（含所有上游） | 15s | `RV_TOTAL_TIMEOUT_MS` |
| 单上游超时 | 6s | `RV_UPSTREAM_TIMEOUT_MS` |
| 并发 / 排队 | 4 / 8（超出返回 503） | `RV_CONCURRENCY` / `RV_QUEUE_MAX` |
| 限流 | 6 次/分钟/IP + 60 次/分钟全局 | `RV_RATE_PER_IP` / `RV_RATE_GLOBAL` |
| 缓存 | 90 秒（音轨 URL 约 2h 过期） | `RV_CACHE_TTL_MS` |
| 熔断 | 连续 3 次失败 → 退避 5 分钟 | `RV_BREAKER_THRESHOLD` / `RV_BREAKER_COOLDOWN_MS` |
| 请求体上限 | 8 KB | `RV_MAX_BODY` |
| 上游响应上限 | 2 MB | `RV_MAX_UPSTREAM` |
| CORS 白名单 | 见 `env.example` | `RV_CORS_ORIGIN` |
| 可信代理 | 只信任 127.0.0.1 传来的 `X-Forwarded-For` | `RV_TRUST_PROXY` |
| 上游域名白名单 | `api.bilibili.com` / `www.bilibili.com` / `b23.tv` | 代码内常量 |
| 重定向 | **不跟随**，直接报错 | — |

systemd 层再加：`MemoryMax=256M`、`CPUQuota=50%`、`TasksMax=64`、`NoNewPrivileges`、`ProtectSystem=strict`、`ProtectHome`、`PrivateTmp`。

## 部署

前提：VPS 上已有 Node ≥ 20、nginx 监听 127.0.0.1:8080、Caddy 在前面做 TLS。

```bash
# 1. 上传
scp -r server/ user@host:/tmp/rv-dist

# 2. 装服务
ssh user@host 'bash /tmp/rv-dist/deploy/01-install-service.sh'

# 3. 加 nginx 路由
ssh user@host 'bash /tmp/rv-dist/deploy/02-nginx-route.sh'

# 4. 验证
curl -sS https://你的域名/rv-resolve/health
```

前端 `web/deployment.mjs`：

```js
export const DEFAULT_EDGE_URL = "https://你的域名/rv-resolve";
```

## 升级

```bash
scp server/server.mjs user@host:/tmp/rv-dist/
ssh user@host 'install -o root -g readvideo -m 640 /tmp/rv-dist/server.mjs /opt/readvideo/server.mjs && systemctl restart readvideo'
```

## 回滚 / 卸载

```bash
ssh user@host 'bash /tmp/rv-dist/deploy/99-uninstall.sh 20261025-002521'
```

备份目录：`/root/backup-rv-<时间戳>/`（含 `survivorno1.conf.pre-route`、`nginx-T.txt`、`ss-before.txt`）。

## 已知限制

- **地区限制**：VPS 在洛杉矶。部分视频（实测音乐 MV 类）对海外 IP 返回 `-404`，服务会返回 404 并说明原因。这是平台侧限制，不是服务问题。
- **不保证不被封**：B 站风控策略随时可能调整（UA 规则、IP 段）。熔断器会保护服务器，但解析成功率不保证。
- **无登录态**：不接收用户 Cookie，因此番剧、大会员内容无法解析。
- **镜像数不稳定**：平台有时只返回 1 个可用镜像（主地址），此时前端没有回退源。

## 迁移

服务本身无状态（缓存只在内存），迁移只需：

1. 新机器装 Node + nginx + 证书
2. 跑 `01-install-service.sh` + `02-nginx-route.sh`
3. 改前端 `DEFAULT_EDGE_URL` 并重新发布 Pages
