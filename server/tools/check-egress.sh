#!/usr/bin/env bash
# B站可达性测试（curl 版，无需 Node）
# 关键：-H "User-Agent:" 会彻底移除 UA 头，这是能通的前提
BV="BV1QAnB67EL3"
CID="42918086045"
REF="Referer: https://www.bilibili.com/"

probe() {
  local url="$1"
  curl -s -o /tmp/_eg.txt -w "%{http_code}" --max-time 20 \
    -H "$REF" -H "User-Agent:" "$url" 2>/dev/null
}

code_of() {
  head -c 400 /tmp/_eg.txt | grep -o '"code":-\?[0-9]*' | head -1 | cut -d: -f2
}

echo "======================================================================"
echo "  B站可达性测试"
echo "======================================================================"

EG=$(curl -s --max-time 15 https://ipinfo.io/json 2>/dev/null)
IP=$(echo "$EG" | grep -o '"ip": *"[^"]*"' | cut -d'"' -f4)
CITY=$(echo "$EG" | grep -o '"city": *"[^"]*"' | cut -d'"' -f4)
COUNTRY=$(echo "$EG" | grep -o '"country": *"[^"]*"' | cut -d'"' -f4)
ORG=$(echo "$EG" | grep -o '"org": *"[^"]*"' | cut -d'"' -f4)
echo "  出口: ${IP:-?}  ${CITY:-?} ${COUNTRY:-?}  ${ORG:-?}"
echo ""

S1=$(probe "https://api.bilibili.com/x/web-interface/view?bvid=$BV"); C1=$(code_of); B1=$(head -c 60 /tmp/_eg.txt | tr -d '\n')
if [ "$S1" = "200" ] && [ "$C1" = "0" ]; then echo "  ✅ view      HTTP $S1  code=$C1"; else echo "  ❌ view      HTTP $S1  code=${C1:-?}  ${B1:0:50}"; fi

S2=$(probe "https://api.bilibili.com/x/player/playurl?bvid=$BV&cid=$CID&fnval=16&fourk=1"); C2=$(code_of)
A2=$(head -c 2000 /tmp/_eg.txt | grep -o '"baseUrl"\|"base_url"' | wc -l)
if [ "$S2" = "200" ] && [ "$C2" = "0" ]; then echo "  ✅ playurl   HTTP $S2  code=$C2  音轨字段=$A2"; else echo "  ❌ playurl   HTTP $S2  code=${C2:-?}"; fi

S3=$(probe "https://www.bilibili.com/")
T3=$(head -c 800 /tmp/_eg.txt | grep -o '<title>[^<]*</title>' | head -1)
if [ "$S3" = "412" ] || [ "$S3" = "403" ] || [ "$S3" = "000" ]; then echo "  ❌ 主页      HTTP $S3  $T3"; else echo "  ✅ 主页      HTTP $S3  $T3"; fi

S4=$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 https://api.github.com/ 2>/dev/null)
if [ "$S4" = "200" ]; then echo "  ✅ 对照      HTTP $S4 (github)"; else echo "  ⚠ 对照      HTTP $S4 (github) —— 网络本身可能有问题"; fi

echo ""
if [ "$S1" = "200" ] && [ "$C1" = "0" ] && [ "$S2" = "200" ] && [ "$C2" = "0" ]; then
  echo "  ✅✅ 这台机器可用作 readvideo 解析服务"
  RESULT=PASS
else
  echo "  ❌ 这台机器不可用"
  [ "$S1" = "412" ] && echo "      412 = 该 IP 段被 B站整段封禁"
  RESULT=FAIL
fi
echo "======================================================================"
[ "$RESULT" = "PASS" ] && exit 0 || exit 1
