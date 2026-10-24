#!/usr/bin/env node
/**
 * 出口 IP 能否访问 B站 —— 一票否决测试
 *
 * 用法：把本文件拷到任何候选服务器 / 云函数上，运行：
 *     node check-egress.mjs
 * 或者用 curl 版（无需 Node）：
 *     bash check-egress.sh
 *
 * 判据（三条全过才算可用）：
 *   1. view 接口 200 + code=0
 *   2. playurl 接口 200 + code=0 + 有音频流
 *   3. 主页 www.bilibili.com 不是 412
 *
 * 关键：请求时【不发 User-Agent】。实测 Chrome UA 会触发 412，空 UA 才放行。
 */

const BV = "BV1QAnB67EL3";
const CID = "42918086045";
const H = { Referer: "https://www.bilibili.com/" }; // 只有 Referer，没有 UA

async function probe(url, headers = H) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { headers, redirect: "manual" });
    const text = await r.text();
    let code = null;
    let title = null;
    try {
      code = JSON.parse(text).code;
    } catch {
      const m = /<title>([^<]{0,60})<\/title>/i.exec(text);
      title = m ? m[1].trim() : null;
    }
    return { status: r.status, code, title, ms: Date.now() - t0 };
  } catch (e) {
    return { status: 0, error: `${e.name}: ${e.message}`, ms: Date.now() - t0 };
  }
}

const pad = (s, n) => String(s).padEnd(n);
const mark = (ok) => (ok ? "\x1b[32m✅\x1b[0m" : "\x1b[31m❌\x1b[0m");

console.log("=".repeat(70));
console.log("  B站可达性测试（出口 IP 一票否决）");
console.log("=".repeat(70));

// 出口信息
let egress = "未知";
try {
  const r = await fetch("https://ipinfo.io/json");
  const d = await r.json();
  egress = `${d.ip}  ${d.city ?? ""} ${d.country ?? ""}  ${d.org ?? ""}`;
} catch {}
console.log(`  出口: ${egress}\n`);

// 1. view
const view = await probe(`https://api.bilibili.com/x/web-interface/view?bvid=${BV}`);
const okView = view.status === 200 && view.code === 0;
console.log(`  ${mark(okView)} ${pad("view 接口", 12)} HTTP ${pad(view.status, 3)} code=${view.code ?? "-"}  ${view.ms}ms`);

// 2. playurl
const play = await probe(
  `https://api.bilibili.com/x/player/playurl?bvid=${BV}&cid=${CID}&fnval=16&fourk=1`,
);
const okPlay = play.status === 200 && play.code === 0;
console.log(`  ${mark(okPlay)} ${pad("playurl", 12)} HTTP ${pad(play.status, 3)} code=${play.code ?? "-"}  ${play.ms}ms`);

// 3. 主页
const home = await probe("https://www.bilibili.com/");
const okHome = home.status !== 412 && home.status !== 403 && home.status !== 0;
console.log(`  ${mark(okHome)} ${pad("主页", 12)} HTTP ${pad(home.status, 3)} ${home.title ? "「" + home.title + "」" : ""}  ${home.ms}ms`);

// 4. 对照：非 B站
const other = await probe("https://api.github.com/", {});
console.log(`  ${mark(other.status === 200)} ${pad("对照 github", 12)} HTTP ${pad(other.status, 3)}  ${other.ms}ms`);

console.log("\n" + "=".repeat(70));
const pass = okView && okPlay && okHome;
if (pass) {
  console.log("  ✅ 这台机器可以用作 readvideo 解析服务");
} else {
  console.log("  ❌ 这台机器不可用");
  if (!okView && view.status === 412) console.log("     412 = 该 IP 段被 B站整段封禁");
  if (view.status === 0) console.log("     连不上 = 网络无法到达 B站");
  if (other.status !== 200) console.log("     注意：连对照站点都不通，可能是网络本身有问题");
}
console.log("=".repeat(70));
process.exit(pass ? 0 : 1);
