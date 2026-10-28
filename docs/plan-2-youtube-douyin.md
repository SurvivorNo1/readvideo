# 方案 2：YouTube 与抖音支持

> 状态：**方案已定，未开发**
> 前置：建议先落地方案 1（分段转录 + 文字缓存），方案 2 复用它的缓存。
> 硬约束（用户明确）：**没有服务器，不花钱，可以用开源。**

## ⚠️ 基础设施红线

**这套方案不依赖任何自有服务器。** 唯一的后端是**已经存在的那个免费 Vercel 函数**
（`readvideo-resolve.vercel.app`），只是多一个 YouTube 分支。

抖音那条路连后端都不用——浏览器自己下载。

文中出现的任何 `ip=...` 参数都是「请求方 IP」，说明的是「音频地址不可跨机器复用」，
不是指某个固定服务器。**方案里没有任何地方需要那台机器。**


---

## 1. 结论先行

| 平台 | 结论 | 要不要服务器 |
|---|---|---|
| **B 站** | ✅ 已支持 | 不需要（现有 Vercel 免费函数够） |
| **YouTube** | ❌ **免费出口全部被 Google 拦** | **要么有服务器，要么放弃自动** |
| **抖音** | ✅ **可行**：书签小工具拿直链，CDN 有 CORS | 不需要，浏览器自己下载 |

---

## 1.5 YouTube 的实测结论（2026-10 复核）

配方本身是对的，但**出口 IP 决定成败**。同一套代码、同一时刻的结果：

| 出口 | `M7lc1UVf-VE` | `jNQXAC9IVRw` | `dQw4w9WgXcQ` |
|---|---|---|---|
| 腾讯云 VPS | ✅ OK · 65,976 字节 | ✅ OK · 918 字节 | ✅ OK · 8,079 字节 |
| **Vercel（AWS）** | ❌ ERROR | ❌ ERROR | ✅ 侥幸通过 |
| **Cloudflare Workers** | ❌ `LOGIN_REQUIRED` | ❌ `LOGIN_REQUIRED` | ❌ `LOGIN_REQUIRED` |
| **浏览器跨域** | ❌ CORS | ❌ CORS | ❌ CORS |
| **浏览器同源**（站在 youtube.com 上） | ❌ 字幕 **0 字节** | — | — |

逐步排除的过程：

| 尝试 | 结果 |
|---|---|
| IOS 客户端 ＋ 多客户端轮换 ＋ visitorData（部署在 Vercel） | ❌ 只有极少数视频能过，其余 `playabilityStatus: ERROR` |
| 同上，部署到 Cloudflare Worker（`--temporary` 免登录） | ❌ `LOGIN_REQUIRED: Sign in to confirm you're not a bot` |
| **完整 PoToken（BotGuard 逆向）** | ✅ 链路跑通了，❌ **但救不了 Vercel** |
| 浏览器直接 fetch innertube | ❌ `TypeError: Failed to fetch`（无 ACAO） |
| 浏览器在 youtube.com 页面内 fetch `baseUrl` | ❌ HTTP 200 但 **0 字节** |
| `get_transcript` ＋ 自造 params | ❌ HTTP 400 |
| `get_transcript` ＋ 页面里真实的 `getTranscriptEndpoint.params` | ❌ **`FAILED_PRECONDITION`**（缺 PoToken） |
| 点「Show transcript」后读 DOM | ❌ 面板未渲染，`ytd-transcript-segment-renderer` 为 0 |

### PoToken 的完整记录（走到底了）

按 YouTube 播放器的真实流程逆向复刻，用开源的 `bgutils-js` ＋ `jsdom`：

```
1. 取 visitorData                                ✅ 464 字符
2. 向 WAA 要 BotGuard challenge                   ✅ 解释器 63,755 字节 / 字节码 10,031 字节
3. 在 jsdom 里执行解释器，加载 BotGuard VM         ✅ 成功
4. snapshot                                      ✅ 1,248 字符
5. 换 WAA integrity token                        ✅ 92 字符
6. mint PoToken                                  ✅ 728 字符
7. 带 &pot= 取字幕                                ✅ 65,976 字节 / 466 事件
```

**在腾讯云的机器上，这一整套全部成功。**

但部署到 Vercel 后，卡在**第 7 步之前**——连 `playabilityStatus` 都是 `ERROR`，
根本走不到字幕那一步。同一个视频在腾讯云上是 `OK`。

**所以不是 PoToken 的问题，是 AWS 的 IP 在 player 接口就被拒了。**
PoToken 能证明"运行环境像真浏览器"，证明不了"IP 不是机房"。

代码已写好并随函数部署（依赖可选加载，没装就自动降级）。哪天换到不被拦的出口，
这套 PoToken 立刻就能起作用。

**根本原因：** YouTube 对数据中心 IP 的 player 接口本身就有额外限制，
字幕接口又强制 PoToken。两重叠加，免费 serverless 全灭。

**所以 YouTube 只有三条路：**

| 方案 | 成本 | 体验 |
|---|---|---|
| **A. 保持现状：标签页音频授权** | 0 | 要播放视频，转写耗时≈视频时长 |
| B. 搞一台自己的服务器（VPS / 树莓派 / 家宽） | 要钱或要设备 | 全自动，秒级拿字幕 |
| C. 书签工具让用户手动开字幕稿再抓 DOM | 0 | 每次点两下，且面板不一定渲染 |

**建议：YouTube 保持方案 A（现有功能），把精力放在抖音上。**
哪天有了稳定出口（自建或租一台便宜机器），把 `resolve-core.mjs` 里的
YouTube 分支打开就能用——代码已经写好并验证过配方。


---

## 2. YouTube 的完整验证过程

### 2.1 走过的弯路（都验证过，都失败）

| 方案 | 结果 |
|---|---|
| 裸调 `api/timedtext`（8 种参数组合） | ❌ 全部 **HTTP 200 + 0 字节** |
| 在浏览器页面内（同源、带 cookie）调 timedtext | ❌ HTTP 429 |
| `youtubei/v1/player` + **ANDROID** 客户端 | ❌ HTTP 400 |
| `youtubei/v1/player` + **WEB** 客户端 | ❌ `playabilityStatus: UNPLAYABLE` |
| `youtubei.js`（WEB 客户端） | ❌ 拿到 baseUrl，内容仍 0 字节 |
| `youtubei.js` 其他客户端 | ❌ 解析器只认 WEB 形状，报 `Cannot read properties of null` |
| 公共 Piped 实例 `api.piped.private.coffee` | ⚠️ 有元信息，它的代理返回 **502** |
| 公共 Invidious `inv.nadeko.net` | ⚠️ 字幕列表正常、**CORS `*`**，但内容 0 字节 |
| `youtubetranscript.com` | ❌ "YouTube is currently blocking" |
| `api.allorigins.win` + watch 页 | ❌ HTTP 522 |
| `r.jina.ai` + watch 页 | ❌ 只返回文字摘要，没有时间码 |
| 服务器上 `yt-dlp` | ✅ 能拿到，但**需要真实服务器**（用户没有） |

**根本原因：** YouTube 现在要求 PoToken，裸 timedtext 一律返回空 body。

### 2.2 最终可行的配方

**换客户端就绕过去了 —— 用 Innertube 的 `IOS` 客户端。**

```
① POST https://www.youtube.com/youtubei/v1/player?key=<公开key>&prettyPrint=false
   Content-Type: application/json
   ★★ 绝对不能发 Origin 头，发了会被 Google 判为自动化请求直接 403
   body: {
     "videoId": "<id>",
     "context": { "client": {
       "clientName": "IOS",
       "clientVersion": "20.10.4",
       "deviceMake": "Apple",
       "deviceModel": "iPhone16,2",
       "osName": "iPhone",
       "osVersion": "18.3.2.22D82",
       "hl": "en"
     }},
     "contentCheckOk": true,
     "racyCheckOk": true
   }
        ↓
② playabilityStatus = OK
   captions.playerCaptionsTracklistRenderer.captionTracks[]   ← 字幕轨
   streamingData.adaptiveFormats[]                            ← 音频流（IP 绑定，见 2.4）
        ↓
③ GET <baseUrl>&fmt=json3          ← 不需要 PoToken，不需要特殊 UA
        ↓
④ events[].tStartMs + segs[].utf8  → {start, end, text}[]
```

### 2.3 实测结果（4 个视频，全部成功）

| 视频 | 状态 | 字幕轨 | 字幕段 | 总耗时 |
|---|---|---|---|---|
| `dQw4w9WgXcQ` | 200 | 6 | 61 | 302 ms |
| `M7lc1UVf-VE` | 200 | 2 | 466 | 316 ms |
| `jNQXAC9IVRw` | 200 | 2 | 6 | 192 ms |
| `9bZkp7q19f0` | 200 | 1 | 133 | — |

真实输出：

```
M7lc1UVf-VE   0:10  JEFF POSNICK: Hey, everybody.
              0:11  Welcome to this week's show of YouTube Developers Live.

dQw4w9WgXcQ   0:18  ♪ We're no strangers to love ♪

jNQXAC9IVRw   0:01  All right, so here we are, in front of the elephants
```

字幕轨清单也能拿到：

```
en     | manual | English
en     | asr    | English (auto-generated)
de-DE  | manual | German (Germany)
ja     | manual | Japanese
...
```

### 2.4 音频为什么不做

IOS 客户端返回的音频地址带 `ip=<发起请求那台机器的IP>`（**绑请求方 IP**）：

```
https://rr2---sn-xxx.googlevideo.com/videoplayback?expire=...&ip=<请求方IP>&...
```

我验证时是从一台临时机器发的请求，地址就绑在那台机器上；生产环境里请求会从
**Vercel 的免费函数**发出，地址就绑 Vercel 的出口 IP。

无论绑在谁身上，浏览器换个 IP 都用不了，而且 `googlevideo.com` 没有 CORS。

所以：**YouTube 只做字幕，不做音频。** 没有字幕的视频退回现有的「标签页音频授权」。

**这不是将就**——绝大多数有价值的 YouTube 内容（讲座、访谈、教程）都有自动生成的字幕。

### 2.5 架构

```
用户贴 YouTube 链接
  ↓
前端 → 现有的 Vercel 函数 /api/resolve
  ↓
函数里发 IOS 客户端的 player 请求（纯 fetch，无子进程、无二进制）
  ↓
拿到 captionTracks → 再 GET 一次 json3 → 解析成 segments
  ↓
返回 kind: "captions" + segments[]（和 B 站字幕同一个形状）
  ↓
前端复用现有解析路径，直接生成文章
```

**零新增基础设施**：还是那个免费的 Vercel 函数，只是多一个分支。

---

## 3. 抖音

### 3.1 已验证的事实

| 探测 | 结果 |
|---|---|
| 短链 `v.douyin.com/xxx` | ✅ 302 → `iesdouyin.com/share/video/<id>?...&share_sign=...` |
| 分享页 + 桌面 UA | ❌ 302 → `www.douyin.com/video/<id>`，72 KB 的 SPA 壳，**0 处 `douyinvod`** |
| 分享页 + 移动 UA | ⚠️ 200，有 `_ROUTER_DATA` 但只有 **1399 字节**，里面没有任何视频数据 |
| **浏览器渲染后的页面** | ✅ **63 处 `douyinvod`，3 个唯一 CDN 地址** |
| **CDN 跨域取**（从 `survivorno1.github.io`） | ✅ **206 + 1024 字节有效 MP4**（`ftypisom`） |
| 同一页面的第二个 CDN 主机 | ❌ 403（签名差异） |

> `Access-Control-Allow-Origin` 在 JS 里读出来是 `null` 属于正常——CORS 响应头本身不对页面脚本暴露。
> 判断依据是 fetch 没抛异常且读到了有效 MP4 头。

**矛盾点：地址要浏览器渲染才有，但我们读不到别的页面的 DOM。**

### 3.2 方案：书签小工具

```
用户在抖音视频页
  ↓ 点书签栏上的「用 readvideo 读」
书签里的一段 JS 在当前页面上下文执行：
  ① script#RENDER_DATA 的 URL-decode JSON → video.play_addr.url_list
  ② window 上的 SPA 状态 → playAddr
  ③ 兜底：正则扫 innerHTML 里的 douyinvod 地址
  全部保留，按顺序试（实测有的主机 206、有的 403）
  ↓
location.href = "https://survivorno1.github.io/readvideo/app/#douyin="
                + encodeURIComponent(地址)
                + "&title=" + encodeURIComponent(标题)
  ↓
readvideo 读 location.hash → 走「已有直链」路径
  → 不经过解析服务，避开抖音的反爬
  → 直接 fetch 音频（已验证 CDN 有 CORS）
  ↓
抖音通常 15 秒~5 分钟，一段就够，不需要分段
```

**为什么这条路最稳：**

- 地址是浏览器用真实身份、真实 cookie 渲染出来的，天然带正确签名
- 不碰反爬（不做签名、不伪造请求）
- 不经过服务器，零流量成本
- 抖音改版最多影响「从页面里找地址」那几行

**代价：** 用户要装一次书签小工具，多一步点击。

### 3.3 不做的事

| 方向 | 为什么不做 |
|---|---|
| 服务端无头浏览器 | 要一台机器，违反硬约束 |
| 逆向 `a_bogus` / `X-Bogus` 签名 | 能通但极脆，算法随版本变；而且抖音 web 端还有设备指纹 |
| 服务端抓分享页 | 实测拿不到（SPA 壳 / `_ROUTER_DATA` 里没数据） |

---

## 4. 能力矩阵（全部实测）

| 能力 | B 站 | YouTube | 抖音 |
|---|---|---|---|
| 服务端拿元信息 | ✅ | ✅ IOS 客户端 | ❌ |
| 服务端拿字幕 | ✅ | ✅ **IOS 客户端** | ❌ 无字幕 |
| 服务端拿音频直链 | ✅ | ⚠️ 能拿但 **IP 绑定** | ❌ |
| 浏览器直读音频 | ✅ | ❌ 无 CORS | ✅ **有 CORS** |
| 需要服务器跑可执行文件 | ❌ | ❌ **不需要** | ❌ |
| 需要浏览器渲染 | ❌ | ❌ | ✅ **必须** |
| 典型时长 | 分钟~小时级 | 分钟~小时级 | **15 秒~5 分钟** |
| 推荐主路径 | 直链 + 浏览器 ASR | **IOS 客户端拿字幕** | **书签工具给直链** |
| 无字幕时 | 浏览器 ASR | 标签页音频授权 | — |

---

## 5. 与方案 1 的关系

复用方案 1 的基础设施：

| 方案 1 的组件 | 方案 2 怎么用 |
|---|---|
| `transcripts` 文字缓存 | 键里的 `platform` 区分 `bilibili` / `youtube` / `douyin` |
| 分段下载 | 抖音用不上（太短）；YouTube 不做音频 |
| 30 秒窗口 + 合成时间码 | YouTube 字幕走 `parseCaptions`，不需要 ASR；抖音必然要 ASR |
| 进度与 ETA | 抖音一次跑完，不需要 |

**缓存键示例：**

```
bilibili|BV1Sj2aB9EXf|small|chinese|v1|1234.5
youtube|dQw4w9WgXcQ|||captions|v1|0        ← 字幕轨，不含模型名
douyin|7298145681699622182|small|chinese|v1|0
```

YouTube 字幕不含模型名是对的——字幕跟模型无关，换模型不该让缓存失效。

---

## 6. 界面变化

### 6.1 平台识别

`embeddedPlayer()` 加抖音分支；域名白名单加：

```
youtube.com / www.youtube.com / m.youtube.com / youtu.be
douyin.com / www.douyin.com / v.douyin.com / iesdouyin.com
```

### 6.2 YouTube

有字幕：

```
已找到 2 条字幕轨（英语人工轨、英语自动轨）
将使用：英语（人工轨）
```

没字幕：

```
这个视频没有可用字幕。可以打开原页并授权本页音频来转写。
     [ 打开 YouTube 原页 ]
```

### 6.3 抖音

贴了分享短链时：

```
这是抖音分享链接。
抖音的视频地址需要先在浏览器里渲染出来。点下面的按钮，
在你的浏览器里打开它，然后一键把地址送回来。

     [ 打开抖音原页 ]
     [ 首次使用？安装书签工具 ]   ← 展开安装说明
```

用了书签小工具跳回来时：

```
已接收抖音直链：<标题>
直接开始转写。
```

---

## 7. 边界情况

| 情况 | 处理 |
|---|---|
| YouTube 视频被限区 | `playabilityStatus` 不是 OK → 提示走标签页授权 |
| YouTube 只登录可见 | 同上 |
| YouTube 完全没有字幕 | 提示走标签页授权，不报错 |
| YouTube 需要登录的视频（成人/私享） | 拿不到，明确提示 |
| 抖音短链过期 | 引导重新复制 |
| 抖音地址 403 | 换下一个 CDN 主机重试；全失败就提示重新抓 |
| 抖音是图文不是视频 | 没有音轨，直接报「这不是视频」 |
| 抖音直播回放 | 无 `play_addr`，不支持 |
| 用户直接贴 `douyinvod.com` 地址 | 当作「已有直链」处理，直接下载 |
| 用户直接贴 `googlevideo.com` 地址 | 拒绝（IP 绑定 + 无 CORS） |

---

## 8. 改动清单

### 服务端（现有的 Vercel 免费函数，不新增基础设施）

| 文件 | 改动 |
|---|---|
| 新增 `resolve-core.mjs` 里的 YouTube 分支 | IOS 客户端 player 请求 + captionTracks + timedtext |
| `resolve-core.mjs` 的 `UPSTREAM_ALLOW` | 加 `www.youtube.com`、`youtube.com` |
| `resolve-core.mjs` 的 `CORS_ORIGIN` | 不用改（本来就允许 github.io） |

**关键实现约束（踩过的坑，必须写进代码注释）：**

1. **绝不发 `Origin` 头** —— 发了 Google 直接 403「We're sorry... automated queries」
2. **绝不发 `User-Agent`** —— 和 B 站一样的教训；IOS 客户端的 UA 只在请求音频时用
3. 客户端必须是 `IOS`，`WEB` / `ANDROID` / `VISIONOS` 都不行
4. `key` 用公开的那个（`AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8`），不需要 API key

### 前端

| 文件 | 改动 |
|---|---|
| `web/source.mjs` | 抖音域名识别；读取 `location.hash` 的 `#douyin=<url>`；YouTube 走 `kind: "captions"` |
| `web/index.html` | 抖音书签工具的安装引导 |
| 新增 `bookmarklet/readvideo-douyin.js` | 可拖到书签栏的一段 JS（不参与构建，单独分发） |

### 不需要改

- `web/edge.mjs` —— 已经有 `kind: "captions"` 的分支
- `web/core.mjs` 的 `parseCaptions` —— json3 格式已经支持
- 方案 1 的分段转录 —— YouTube 用不上（靠字幕），抖音太短

---

## 9. 留给后续的线索

**探测脚本（已写好，在 `readvideo-deploy/`）：**

```
probe-noserver.sh          公共 Piped / Invidious / 第三方站 / CORS 代理
probe-invidious-piped.sh   两家的字幕内容 + CORS 头
probe-piped-proxy.sh       Piped 代理重试 + 多实例
probe-platforms*.sh        抖音分享页 / 短链 / yt-dlp
yt-test/test5.mjs          裸 Innertube 各客户端对比（★ 发现 IOS 可用）
yt-test/test6.mjs          多视频 + 音频流 + 无 UA 测试
yt-test/test8.mjs          最终干净配方
douyin-cors.js             浏览器里测抖音 CDN 的 CORS
```

这些是复现探测结论用的，**不属于产品代码**。

**服务端要跑验证的话，直接跑 `yt-test/test8.mjs`** —— 它是最小可复现的配方。

---

## 10. 待讨论

1. **抖音走书签小工具，还是先只做 YouTube？**
   书签工具需要用户装一次，是个门槛。YouTube 那条路是纯后端，改完就能用。

2. **书签小工具的分发方式？**
   - 拖拽式书签（零安装，移动端用不了）
   - Tampermonkey 用户脚本（要装扩展）
   - 两者都提供

3. **YouTube 字幕要不要做语种选择？**
   有的视频有 6 条轨（含中文翻译轨）。要不要让用户在界面上选，还是自动挑（人工轨优先 → 目标语种 → 第一条）？

4. **抖音要不要支持「图文」？**
   抖音现在很多内容是图文，没有音轨，转不了。

5. **平台优先级？**
   如果只能先做一个：YouTube（纯后端，一次改完）还是抖音（要用户装东西）？

---

## 11. 验证计划

| 用例 | 期望 |
|---|---|
| 有字幕的 YouTube 视频 | 拿到字幕，直接出文章，不下载音频 |
| 只有自动字幕的 YouTube | 用 `kind:"asr"` 的轨道 |
| 多语种 YouTube 视频 | 按目标语种挑轨道，挑不到用第一条 |
| 无字幕的 YouTube | 提示走标签页授权，不报错 |
| 限区 / 私享 YouTube | 明确提示，不静默失败 |
| 抖音分享短链 | 引导走书签工具 |
| 抖音直链（`douyinvod.com`） | 直接下载 + 转录 |
| 抖音 CDN 多主机 | 第一个 403 时自动试下一个 |
| 三个平台的缓存互不串 | 键里的 `platform` 生效 |
| 同一个 YouTube 视频看两次 | 第二次全命中文字缓存 |
