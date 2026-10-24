# 部署到 Serverless（不用 VPS）

`serverless.mjs` + `resolve-core.mjs` 是一份可移植的解析服务，同一套代码能跑在多个平台。

## ⚠️ 部署前必须先验证出口 IP

**B 站按 IP 段封禁，不是按厂商。** 实测结论：

| 出口 | 结果 |
|---|---|
| Cloudflare Workers（AS13335，SEA/US） | ❌ **412**，连 `www.bilibili.com` 主页都是 412 |
| IT7 Networks 洛杉矶小机房 VPS | ✅ 200 |
| 国内校园网 | ✅ 200 |

**所以：任何候选平台，先跑 `check-egress.mjs`，三条全绿再部署。**

```bash
# 把文件拷到目标机器 / 在云函数的测试环境中运行
node check-egress.mjs
```

判据：
1. `view` 接口 200 且 `code=0`
2. `playurl` 接口 200 且 `code=0`
3. 主页不是 412/403

**Cloudflare Workers 已实测不可用，不要再试。**

---

## 阿里云函数计算 FC

1. 新建函数，运行环境选 **Node.js 18** 或 **20**
2. 上传 `serverless.mjs` + `resolve-core.mjs`（放在同一目录）
3. **处理程序**填：

   ```
   serverless.handler
   ```

4. 触发器：**HTTP 触发器**，认证方式选「无需认证」
5. 环境变量（可选）：

   | 变量 | 默认 | 说明 |
   |---|---|---|
   | `RV_CORS_ORIGIN` | `https://survivorno1.github.io,...` | 允许的前端来源，逗号分隔 |
   | `RV_TOTAL_TIMEOUT_MS` | `15000` | 单次解析总超时 |
   | `RV_MAX_BODY` | `8192` | 请求体上限 |
   | `RV_RATE_PER_IP` | `20` | 单实例内每 IP 每分钟次数 |

6. 拿到 HTTP 触发器域名后，验证：

   ```bash
   curl https://<你的域名>/health
   curl -X POST https://<你的域名>/resolve \
     -H 'Content-Type: application/json' \
     -d '{"url":"BV1VS4y1t7st"}'
   ```

7. 前端 `web/deployment.mjs` 改成该域名（或带路径，前端已支持子路径）。

> 函数计算 FC 的 HTTP 触发器路径可能是 `/2016-08-15/proxy/<服务>/<函数>/`，
> 前端 `edgeEndpoint()` 会保留路径，直接填完整前缀即可。

---

## 腾讯云云函数 SCF

1. 新建函数，运行环境 **Node.js 18**
2. 上传 `serverless.mjs` + `resolve-core.mjs`
3. **执行方法**填：

   ```
   serverless.main_handler
   ```

4. 触发器：**API 网关触发器**，开启 CORS（或让函数自己处理，本代码已带 CORS 头）
5. 其余同上。

---

## Vercel / Netlify

把两个文件放进 `api/resolve/`，并按平台要求导出。本文件同时提供：

- `default`（Deno / CF / Netlify Edge 的 `{ fetch }` 形态）
- `vercelHandler`（Node `(req, res)` 形态）

Vercel Node 函数示例 `api/resolve.js`：

```js
export { vercelHandler as default } from "../../serverless.mjs";
export const config = { runtime: "nodejs20.x" };
```

> ⚠️ Vercel / Netlify 跑在 AWS 机房 IP 上，**很可能和 Cloudflare 一样被 412**。
> 部署前先验证。

---

## Deno Deploy

```ts
import app from "./serverless.mjs";
Deno.serve(app.fetch);
```

---

## 为什么云函数上的限流不可靠

Serverless 实例会被回收、会横向扩容，单实例内的计数器不共享。所以：

- `RV_RATE_PER_IP` 只能防单实例被打爆
- **真正的全局限流要用平台的 API 网关配额，或接 KV/Redis**
- B 站的 412 才是最大的实际约束——被风控时整个出口都不可用，和限流无关

---

## 迁移检查清单

```
[ ] check-egress.mjs 三条全绿
[ ] /health 返回 {"ok":true}
[ ] /resolve 能解析 BV1VS4y1t7st
[ ] 返回的 urls 全是 bilivideo.com / .cn 且无端口
[ ] 浏览器打开 Pages，粘贴链接能出字幕
[ ] 旧服务保留至少 24 小时再下掉
```
