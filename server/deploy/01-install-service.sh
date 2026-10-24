#!/usr/bin/env bash
# readvideo resolve —— 安装/升级脚本
# 用法：bash 01-install-service.sh <备份时间戳>
set -euo pipefail

TS="${1:-$(date +%Y%m%d-%H%M%S)}"
BK="/root/backup-rv-${TS}"
DIST="/tmp/rv-dist"
DEST="/opt/readvideo"
PORT="${RV_PORT:-8891}"

echo "==> 备份目录: ${BK}"
mkdir -p "${BK}"
[ -f /etc/nginx/conf.d/survivorno1.conf ] && cp -a /etc/nginx/conf.d/survivorno1.conf "${BK}/"
[ -f /etc/caddy/Caddyfile ] && cp -a /etc/caddy/Caddyfile "${BK}/"
nginx -T > "${BK}/nginx-T.txt" 2>/dev/null || true
ss -lntp > "${BK}/ss-before.txt" 2>/dev/null || true
free -m > "${BK}/mem-before.txt" 2>/dev/null || true
echo "OK"

echo "==> 创建服务用户"
if ! id readvideo >/dev/null 2>&1; then
  useradd --system --home "${DEST}" --shell /sbin/nologin readvideo
fi
id readvideo

echo "==> 部署代码"
mkdir -p "${DEST}" /etc/readvideo
chown root:readvideo /etc/readvideo
chmod 750 /etc/readvideo
install -o root -g readvideo -m 640 "${DIST}/package.json" "${DEST}/package.json"
install -o root -g readvideo -m 640 "${DIST}/server.mjs"   "${DEST}/server.mjs"
chmod 750 "${DEST}"
ls -la "${DEST}"

echo "==> 环境变量文件"
if [ ! -f /etc/readvideo/env ]; then
  install -o root -g readvideo -m 640 "${DIST}/deploy/env.example" /etc/readvideo/env
  echo "  已从模板创建"
else
  echo "  已存在，保留原文件（不覆盖）"
fi
grep -E '^RV_(HOST|PORT|CONCURRENCY|QUEUE_MAX|RATE_PER_IP)=' /etc/readvideo/env || true

echo "==> 检查端口占用"
if ss -lnt | grep -q ":${PORT} "; then
  echo "!! 端口 ${PORT} 已被占用，请先处理"
  ss -lntp | grep ":${PORT} " || true
  exit 1
fi
echo "  端口 ${PORT} 空闲"

echo "==> 安装 systemd 单元"
install -o root -g root -m 644 "${DIST}/deploy/readvideo.service" /etc/systemd/system/readvideo.service
systemctl daemon-reload
systemctl enable readvideo >/dev/null 2>&1
systemctl restart readvideo
sleep 3

echo "==> 服务状态"
systemctl is-active readvideo || true
systemctl status readvideo --no-pager -l | head -15 || true

echo "==> 本地健康检查"
for i in 1 2 3 4 5; do
  if curl -fsS --max-time 5 "http://127.0.0.1:${PORT}/health" 2>/dev/null; then
    echo
    break
  fi
  sleep 2
  [ "$i" = "5" ] && { echo "!! 健康检查失败"; journalctl -u readvideo -n 30 --no-pager; exit 1; }
done

echo "==> 资源限额验证"
PID=$(systemctl show -p MainPID --value readvideo)
echo "  MainPID=${PID}"
if [ "${PID}" != "0" ]; then
  systemctl show readvideo -p MemoryMax -p CPUQuotaPerSecUSec -p TasksMax -p NoNewPrivileges | sed 's/^/  /'
  echo "  实际内存: $(awk '/VmRSS/{print $2" "$3}' /proc/${PID}/status 2>/dev/null || echo '?')"
fi

echo "==> 完成。备份在 ${BK}"
