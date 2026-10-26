# 方案 2：YouTube 与抖音支持

> 状态：**待讨论，未开发**
> 前置：建议先落地方案 1（分段转录 + 文字缓存），方案 2 复用它的缓存和分段能力。
> 说明：本文档只写方案和探测线索，**没有动任何代码**。

---

## 1. 要解决什么

现在只支持 B 站：

| 平台 | 现状 | 说明 |
|---|---|---|
| B 站 | ✅ 完整支持 | 解析、字幕、直链音轨、分段转录 |
| **YouTube** | ⚠️ 只有半条路 | 能从页面 DOM 里读字幕轨；音频只能靠「标签页音频授权」 |
| **抖音** | ❌ 完全不支持 | `embeddedPlayer()` 里没有抖音的分支 |

目标：

- YouTube：给链接就能出字幕或文章，不用开标签页授权
- 抖音：给分享链接就能出字幕或文章

---

## 2. 已验证的探测结果

以下全部是实测，不是推测。探测环境：服务器（腾讯云 IP）+ 浏览器（住宅 IP）。

### 2.1 YouTube

| 探测 | 结果 |
|---|---|
| `youtubei/v1/player` + **ANDROID** 客户端 | ❌ HTTP 400，`adaptiveFormats: 0` |
| `youtubei/v1/player` + **WEB** 客户端 | ⚠️ HTTP 200，但 `playabilityStatus: UNPLAYABLE`，`adaptiveFormats: 0` |
| 同上，能否拿到元信息 | ✅ 标题、`lengthSeconds` 正常 |
| watch 页 HTML（1.4 MB） | ✅ 里面带 `captionTracks`，6 条轨道 |
| 直接请求 `api/timedtext`（**8 种参数组合全试过**） | ❌ **全部 HTTP 200 但 0 字节**，`content-type: text/html` |
| 浏览器页面内（同源、带 cookie）请求 timedtext | ❌ HTTP **429**（限流），拿不到内容 |
| **服务器上 `yt-dlp`** | ✅ **完全成功** |

**重要更正：** 一开始看到 `timedtext` 返回 HTTP 200 就以为通了，实际是 **0 字节空响应**。
YouTube 现在普遍要求 PoToken，裸调 `timedtext` 拿不到内容。参数组合全部试过：

```
原样 / fmt=json3 / fmt=srv3 / fmt=vtt / fmt=json3&c=WEB
fmt=json3&c=ANDROID / fmt=json3&potc=1 / fmt=json3&xorb=2&xobt=3&xovt=3
裸接口 v+lang+fmt
→ 全部 200 + 0 字节
```

**走 `yt-dlp` 就通了**（服务器上实测，yt-dlp 2026.10.21）：

```
$ yt-dlp --skip-download --write-subs --write-auto-subs \
    --sub-langs "en.*" --sub-format json3 -o "/tmp/sub.%(ext)s" <url>

[info] Available automatic captions: en / de-DE / ja / pt-BR / es-419 / +160 种翻译轨
[info] Writing video subtitles to: /tmp/sub.en.json3    8325 字节  ✅
[info] Writing video subtitles to: /tmp/sub.en-orig.json3  32623 字节  ✅
```

**解析 json3 的结果（实测）：**

```
events=61  有文字的=61
  00:01  [♪♪♪]
  00:18  ♪ We're no strangers to love ♪
  03:27  ♪ Never gonna tell a lie and hurt you ♪
全文 2029 字
```

`--skip-download -J` 还能一次拿到元信息：

```
title: Rick Astley - Never Gonna Give You Up
duration: 213
人工字幕轨: 5   ['en','de-DE','ja','pt-BR','es-419']
自动字幕轨: 160
```

**音频直链也能拿到，但是 IP 绑定的：**

```
$ yt-dlp -g -f bestaudio
https://rr2---sn-xxx.googlevideo.com/videoplayback?expire=...&ip=67.209.191.89&...
                                                          ^^^^^^^^^^^^^^ 绑服务器 IP
Range 请求: HTTP 206, 1024 字节, audio/mp4   ✅（从服务器发）
```

`ip=` 参数把地址锁在服务器 IP 上，**浏览器换个 IP 就用不了**。
所以 YouTube 的音频只能由服务器代理，不能像 B 站那样让浏览器直连。


### 2.2 抖音

| 探测 | 结果 |
|---|---|
| 短链 `v.douyin.com/xxx` | ✅ 302 → `iesdouyin.com/share/video/<id>?...&share_sign=...` |
| 分享页 + **桌面 UA** | ❌ 302 → `www.douyin.com/video/<id>`，72 KB 的 SPA 壳，**0 处 `douyinvod`** |
| 分享页 + **移动 UA** | ⚠️ 200，32 KB HTML，有 `_ROUTER_DATA`，但**解出来只有 1399 字节**，里面只有 `abParams` / `commonContext`，**没有任何视频数据** |
| **浏览器渲染后的页面** | ✅ **63 处 `douyinvod`，3 个唯一 CDN 地址** |
| `douyinvod.com` 跨域取（从 `survivorno1.github.io` 发起） | ✅ **206，1024 字节，有效 MP4**（`00 00 00 20 66 74 79 70 69 73 6f 6d` = `ftypisom`） |
| 同一页面的另一个 CDN 主机 | ❌ 403（签名/过期差异） |

**结论：抖音的视频地址只在浏览器渲染后才存在；但一旦拿到，CDN 允许浏览器跨域直读。**

> 附注：`Access-Control-Allow-Origin` 在 JS 里读出来是 `null` 属于正常现象——CORS 响应头本身就不对页面脚本暴露。判断依据是 fetch 没抛异常且读到了 1024 字节有效 MP4 头。

---

## 3. 能力矩阵（全部实测）

| 能力 | B 站 | YouTube | 抖音 |
|---|---|---|---|
| 服务端拿元信息 | ✅ | ✅ yt-dlp | ❌ |
| 服务端拿字幕 | ✅ | ✅ **yt-dlp（裸 timedtext 已废）** | ❌ 无字幕 |
| 服务端拿音频直链 | ✅ | ⚠️ 能拿，但 **IP 绑服务器** | ❌ |
| 浏览器直读音频 | ✅ | ❌ | ✅ **有 CORS** |
| 需要服务器跑可执行文件 | ❌ 纯 HTTP | ✅ **必须 yt-dlp** | ❌ |
| 需要浏览器渲染 | ❌ | ❌ | ✅ **必须** |
| 典型时长 | 分钟~小时级 | 分钟~小时级 | **15 秒~5 分钟** |
| 推荐主路径 | 直链 + 浏览器 ASR | **yt-dlp 字幕** | **书签工具给直链** |
| 无字幕时 | 浏览器 ASR | 标签页音频授权 | — |

**这张表决定了两条完全不同的路线：**

- **YouTube → 服务器**（yt-dlp 拿字幕，不需要浏览器参与）
- **抖音 → 浏览器**（书签工具拿直链，不需要服务器参与）


---

## 4. YouTube 方案

### 4.1 主路径：服务器上的 yt-dlp 抓字幕

**这是唯一验证可行的路。** 裸调 timedtext 已经拿不到内容了。

```
用户贴链接
  ↓
服务端调用 yt-dlp（子进程）
  yt-dlp -J --skip-download <url>            → 元信息 + 字幕轨清单
  yt-dlp --skip-download --write-subs --write-auto-subs \
         --sub-langs "<目标语种>" --sub-format json3 -o /tmp/x <url>
  ↓
读 /tmp/x.<lang>.json3
  ↓
复用现有 parseCaptions(json3)  → segments
  ↓
进入方案 1 的「有字幕，直接生成文章」路径
```

**实测产物：** 8325 字节 json3 → 61 条事件 → 2029 字，时间码正常。

**改动点（全部在服务端）：**

| 文件 | 改动 |
|---|---|
| 新增 `server/ytdlp.mjs` | 调 yt-dlp 子进程，返回 `{title, duration, tracks, subtitles}` |
| `server/resolve-core.mjs` | 新增 YouTube 分支，`UPSTREAM_ALLOW` 加 `www.youtube.com` |
| `server/serverless.mjs` | 返回 `kind: "captions"` + `segments[]` |
| 部署环境 | **需要能装 yt-dlp 的机器**。Vercel 函数跑不了子进程装二进制，这一条决定了要回到 VPS 或一台常驻服务器 |

> **这条很重要：** yt-dlp 是个 Python/二进制可执行文件，需要真实文件系统。
> Vercel 的 serverless 函数做不到。**YouTube 支持 = 必须有一台服务器。**

**前端**：`source.mjs` 已有 `parseCaptions` 和 YouTube 的 `embeddedPlayer`，几乎不用改。

### 4.2 兜底：没有字幕的视频

| 选项 | 说明 |
|---|---|
| **标签页音频授权**（推荐，已实现） | 用户在浏览器里播，App 采集本页音频，零服务器成本 |
| 服务器代理音频 | yt-dlp 拿到的地址带 `ip=<服务器IP>`，**浏览器换了 IP 就用不了**，只能服务器下载再转发。一个 20 分钟视频约 20-40 MB 流量 |

**建议：兜底只做标签页授权。** 代理音频费流量且 YT 音频地址过期很快（`expire=` 参数）。


### 4.3 要不要做音频代理

| 选项 | 好处 | 代价 |
|---|---|---|
| 不做（推荐） | 零流量成本 | 无字幕的视频需要开标签页授权 |
| 服务端代理音频 | 全自动 | Vercel 免费版 100 GB/月；B 站链路本来就不用它，只有 YouTube 无字幕视频会消耗 |

**建议先不做。** 等真的有很多无字幕 YouTube 视频再说。

---

## 5. 抖音方案

抖音的核心矛盾：**地址只在渲染后才有，而我们读不到别的页面的 DOM。**

### 5.1 三个可选路径

| 路径 | 可行性 | 说明 |
|---|---|---|
| **A. 用户脚本 / 书签小工具** | ✅ 最现实 | 在抖音页面上一键把地址送到 readvideo |
| B. 服务端无头浏览器 | ⚠️ 贵 | Vercel 免费版跑不了 Chrome，要单独一台机器 |
| C. 逆向 `a_bogus` 签名直接调 API | ⚠️ 能通但脆 | 签名算法常变，维护成本高 |

### 5.2 路径 A：书签小工具（推荐）

**流程：**

```
用户在抖音视频页
  ↓ 点浏览器书签栏上的「用 readvideo 读」
书签里的一段 JS 在当前页面上下文执行：
  - 从 <script id="RENDER_DATA"> 或 window 上的状态里找带 douyinvod 的地址
  - 从页面标题拿视频标题
  ↓
location.href = "https://survivorno1.github.io/readvideo/app/#douyin="
                + encodeURIComponent(直接地址)
                + "&title=" + encodeURIComponent(标题)
  ↓
readvideo 读取 location.hash，走「已经有直链」的路径
  - 不经过解析服务（省一跳，也避开抖音的反爬）
  - 直接 fetch 音频（已验证 CDN 有 CORS）
  ↓
抖音视频通常 15 秒~5 分钟，一段就够，不需要分段
```

**为什么这条路最稳：**

- 地址是浏览器用真实身份、真实 cookie 渲染出来的，**天然带正确签名**
- 不碰抖音的反爬（不做签名、不伪造请求）
- 不需要服务器参与，零流量成本
- 抖音改版最多影响「从页面里找地址」那几行选择器

**代价：**

- 用户要装一次书签小工具（拖一个链接到书签栏，或者装 Tampermonkey）
- 多一步点击

### 5.3 书签小工具要抓什么（探测线索）

浏览器渲染后的抖音页面里，`douyinvod` 出现 **63 次，3 个唯一地址**，形态是：

```
https://v96-web.douyinvod.com/<32位签名>/<8位时间戳>/video/tos/cn/tos-cn-ve-15/<资源ID>/?a=6383...
https://v26-web.douyinvod.com/<32位签名>/<8位时间戳>/video/tos/cn/...       ← 实测这个 403
```

抓取策略（按优先级）：

1. `script#RENDER_DATA` 的 URL-decode 后的 JSON → `video.play_addr.url_list`
2. `window.__INIT_PROPS__` / SPA 状态对象里的 `playAddr`
3. 兜底：正则扫 `document.documentElement.innerHTML` 里的 `douyinvod` 地址（本次探测就是这么拿到的）

**多地址要全部保留**，按顺序试，因为实测不同 CDN 主机有的 206 有的 403。

### 5.4 路径 C 的线索（逆向方向，留档）

如果以后要做全自动（用户只贴短链）：

- 抖音 web 端接口 `aweme/v1/web/aweme/detail/?aweme_id=<id>` 需要 `a_bogus`（新）或 `X-Bogus`（旧）签名
- 签名由 `webmssdk.js`（混淆过的）生成，输入是 query string + UA + 时间戳
- 关键是找到那个 `sign` 函数，用 Node 复刻
- **风险**：算法随版本变；`v.douyin.com` 短链还有额外的风控参数
- **建议**：除非真的要做成产品，否则不要碰

### 5.5 抖音的特殊性

| 点 | 说明 |
|---|---|
| 时长 | 15 秒 ~ 5 分钟，**基本不会触发分段** |
| 容器 | MP4（`ftypisom`），`decodeAudioData` 直接能解 |
| 音轨 | 通常只有一条 AAC |
| 字幕 | **没有官方字幕**，必然走 ASR |
| 地址有效期 | 带时间戳和签名，**很快就会过期**，必须拿到就用 |

---

## 6. 与方案 1 的关系

方案 2 复用方案 1 的所有基础设施：

| 方案 1 的组件 | 方案 2 怎么用 |
|---|---|
| `transcripts` 文字缓存 | 键里的 `platform` 字段区分 `bilibili` / `youtube` / `douyin` |
| 分段下载 | 抖音用不上（太短）；YouTube 只在「代理音频」时才需要 |
| 30 秒窗口 + 合成时间码 | YouTube 字幕走 `parseCaptions`，不需要 ASR；抖音必然要 ASR |
| 进度与 ETA | 抖音一次跑完，不需要 |

**缓存键示例：**

```
bilibili|BV1Sj2aB9EXf|small|chinese|v1|1234.5
youtube|dQw4w9WgXcQ|||captions|v1|0            ← 字幕轨，不涉及模型
douyin|7298145681699622182|small|chinese|v1|0
```

注意 YouTube 和抖音的字幕/转录**不含模型名**（YouTube 字幕是平台给的，抖音用默认模型），
所以换模型不会让它们的缓存失效——这是对的，字幕跟模型无关。

---

## 7. 界面变化

### 7.1 平台自动识别

`embeddedPlayer()` 加抖音分支；`sourceURL()` 加抖音域名白名单：

```
douyin.com / www.douyin.com / v.douyin.com / iesdouyin.com
```

### 7.2 抖音的引导

贴了抖音链接但只有分享短链时：

```
这是抖音分享链接。
抖音的视频地址需要先在浏览器里渲染出来，点下面的按钮，
在你的浏览器里打开它，然后一键把地址送回来。

     [ 打开抖音原页 ]        ← 新标签打开
     [ 我已经装好书签工具 ]   ← 首次使用显示安装引导
```

### 7.3 YouTube 的提示

```
已找到 6 条字幕轨（英语人工轨、英语自动轨、德语、日语…）
将使用：英语（人工轨）
```

没有字幕时：

```
这个视频没有可用字幕。可以打开原页并授权本页音频来转写。
     [ 打开 YouTube 原页 ]
```

---

## 8. 边界情况

| 情况 | 处理 |
|---|---|
| YouTube 视频被限区 | `playabilityStatus` 不是 OK，但 watch 页可能仍有字幕；抓不到就提示 |
| YouTube 只登录可见 | 服务端拿不到，走标签页授权 |
| 抖音短链过期 | 引导用户重新复制 |
| 抖音地址 403 | 换下一个 CDN 主机重试；全失败就提示重新抓 |
| 抖音是图文不是视频 | 没有音轨，直接报「这不是视频」 |
| 抖音直播回放 | 无 `play_addr`，不支持 |
| 用户直接贴 `douyinvod.com` 地址 | 当作「已有直链」处理，直接下载 |

---

## 9. 留给后续的线索

**服务端要改的地方（等你说上服务器再动）：**

| 文件 | 要加什么 |
|---|---|
| `server/resolve-core.mjs` | `UPSTREAM_ALLOW` 加 `www.youtube.com`、`youtube.com` |
| 新增 `server/youtube.mjs` | watch 页 → `captionTracks` → `timedtext` |
| `server/serverless.mjs` | 返回 `kind: "captions"`，带 `tracks[]` |

**前端要改的地方：**

| 文件 | 要加什么 |
|---|---|
| `web/source.mjs` | 抖音域名识别；读取 `location.hash` 里的 `#douyin=<url>` |
| `web/deployment.mjs` | 不用改 |
| `web/index.html` | 抖音书签工具的安装引导 |
| 新增 `bookmarklet/` | 一段可拖到书签栏的 JS（不参与构建，单独分发） |

**探测用的脚本（已写好，在 `readvideo-deploy/`）：**

```
probe-platforms.sh   抖音分享页 / 短链 / YouTube innertube
probe-platforms2.sh  抖音跟随重定向 / YouTube WEB 客户端
probe-platforms3.sh  抖音移动 UA SSR / YouTube watch 页 captionTracks
parse-probe.py       解 _ROUTER_DATA 和 captionTracks
douyin-cors.js       浏览器里测抖音 CDN 的 CORS
```

这些是留给你复现探测结论用的，**不属于产品代码**。

---

## 10. 待讨论

1. **抖音走书签小工具，还是先只做 YouTube？**
   书签工具需要用户装一次，是个体验门槛。要不要先只做 YouTube 字幕，抖音放后面？

2. **书签小工具的分发方式？**
   - 拖拽式书签（零安装，但移动端用不了）
   - Tampermonkey 用户脚本（要装扩展）
   - 两者都提供

3. **YouTube 要不要做音频代理？**
   不做的话，无字幕视频要开标签页授权。做了要承担流量成本。

4. **抖音要不要支持「图文」？**
   抖音现在很多内容是图文，没有音轨，转不了。

5. **平台优先级？**
   如果只能先做一个，是 YouTube（覆盖广、字幕路径干净）还是抖音（你更常用）？

---

## 11. 验证计划

| 用例 | 期望 |
|---|---|
| 有字幕的 YouTube 视频 | 服务端拿到字幕，直接出文章，不下载音频 |
| 只有自动字幕的 YouTube | 用 `kind:"asr"` 的轨道 |
| 无字幕的 YouTube | 提示走标签页授权，不报错 |
| 抖音分享短链 | 引导用户走书签工具 |
| 抖音直链（`douyinvod.com`） | 直接下载 + 转录，秒出 |
| 抖音 CDN 多主机 | 第一个 403 时自动试下一个 |
| 三个平台的缓存互不串 | 键里的 `platform` 生效 |
| 同一个 YouTube 视频看两次 | 第二次全命中文字缓存 |
