#!/usr/bin/env bash
# readvideo resolve —— 卸载/回滚脚本
# 用法：bash 99-uninstall.sh [备份时间戳]
set -uo pipefail

TS="${1:-}"
CONF=/etc/nginx/conf.d/survivorno1.conf

echo "==> 停止并禁用服务"
systemctl disable --now readvideo 2>/dev/null || true
rm -f /etc/systemd/system/readvideo.service
systemctl daemon-reload
echo "  OK"

echo "==> 移除 nginx 路由"
if [ -n "${TS}" ] && [ -f "/root/backup-rv-${TS}/survivorno1.conf.pre-route" ]; then
  cp -a "/root/backup-rv-${TS}/survivorno1.conf.pre-route" "${CONF}"
  echo "  已从备份还原: /root/backup-rv-${TS}/survivorno1.conf.pre-route"
elif grep -q "rv-resolve" "${CONF}" 2>/dev/null; then
  cp -a "${CONF}" "${CONF}.remove-$(date +%s)"
  python3 - "${CONF}" <<'PYEOF'
import sys, re
path = sys.argv[1]
src = open(path, encoding='utf-8').read()
# 删除从注释行到对应 location 块结束
pattern = re.compile(
    r'\n\s*# =+ readvideo 解析服务.*?\n\s*location /rv-resolve/ \{.*?\n\s*\}',
    re.S)
new, n = pattern.subn('', src)
open(path, 'w', encoding='utf-8').write(new)
print(f'  已移除 {n} 个 location 块')
PYEOF
else
  echo "  未发现 rv-resolve 路由，跳过"
fi

echo "==> 校验并重载 nginx"
if nginx -t 2>&1; then
  systemctl reload nginx
  echo "  OK"
else
  echo "  !! 校验失败，请手动检查 ${CONF}"
  exit 1
fi

echo "==> 保留数据（确认无误后可手动删除）"
echo "  代码:   /opt/readvideo"
echo "  配置:   /etc/readvideo"
echo "  用户:   readvideo"
echo ""
echo "彻底清理（谨慎）："
echo "  rm -rf /opt/readvideo /etc/readvideo"
echo "  userdel readvideo"

echo "==> 完成"
