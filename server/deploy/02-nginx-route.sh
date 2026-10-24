#!/usr/bin/env bash
# 给 survivorno1.xyz 的 nginx server 块追加 readvideo 解析服务路由
# 做法：在文件的最后一个 } 之前插入 location
set -euo pipefail

TS="${1:-$(date +%Y%m%d-%H%M%S)}"
CONF=/etc/nginx/conf.d/survivorno1.conf
BK="/root/backup-rv-${TS}"

echo "==> 备份"
mkdir -p "${BK}"
cp -a "${CONF}" "${BK}/survivorno1.conf.pre-route"
echo "  ${BK}/survivorno1.conf.pre-route"

if grep -q "rv-resolve" "${CONF}"; then
  echo "==> 已存在 /rv-resolve 路由，跳过插入"
else
  echo "==> 插入 location /rv-resolve/"
  python3 - "${CONF}" <<'PYEOF'
import sys

path = sys.argv[1]
lines = open(path, encoding='utf-8').read().split('\n')

# 找到最后一个非空行是 '}' 的位置
idx = len(lines) - 1
while idx >= 0 and lines[idx].strip() == '':
    idx -= 1
if lines[idx].strip() != '}':
    raise SystemExit('未找到结尾的 }，中止')

block = '''
    # ===== readvideo 解析服务（只解析地址，不中转音视频）=====
    location /rv-resolve/ {
        limit_except GET POST OPTIONS HEAD { deny all; }
        client_max_body_size 16k;
        proxy_pass http://127.0.0.1:8891/;
        proxy_http_version 1.1;
        proxy_set_header Host               $host;
        proxy_set_header X-Real-IP          $remote_addr;
        proxy_set_header X-Forwarded-For    $remote_addr;
        proxy_set_header X-Forwarded-Proto  https;
        proxy_connect_timeout 5s;
        proxy_read_timeout 25s;
        proxy_send_timeout 25s;
        add_header Strict-Transport-Security "max-age=31536000" always;
        add_header X-Robots-Tag "noindex, nofollow, noarchive" always;
    }
'''.split('\n')

lines[idx:idx] = block
open(path, 'w', encoding='utf-8').write('\n'.join(lines))
print('  已插入，共', len(lines), '行')
PYEOF
fi

echo "==> nginx 语法校验"
if ! nginx -t 2>&1; then
  echo "!! 校验失败，回滚"
  cp -a "${BK}/survivorno1.conf.pre-route" "${CONF}"
  nginx -t
  exit 1
fi

echo "==> 平滑重载"
systemctl reload nginx
sleep 1
systemctl is-active nginx

echo "==> 本地直连验证（经 nginx）"
curl -sS --max-time 8 http://127.0.0.1:8080/rv-resolve/health 2>&1 || echo "  (health 失败)"
echo
curl -sS --max-time 8 -X POST http://127.0.0.1:8080/rv-resolve/resolve \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://www.bilibili.com/video/BV1QAnB67EL3/","transport":"direct-cdn"}' 2>&1 | head -c 400
echo

echo "==> 现有站点未受影响验证"
curl -sS -o /dev/null -w "  首页 HTTP %{http_code}\n" --max-time 8 http://127.0.0.1:8080/ 2>&1
echo "==> 完成"
