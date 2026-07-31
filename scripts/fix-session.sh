#!/bin/bash
# VNC orqali login qilgandan keyin API'ni qayta ishga tushirish uchun script

set -e

echo "=== Google Flow Session Fix ==="
echo "Bu script VNC login'dan keyin API'ni qayta ishga tushiradi"
echo ""

# 1. API to'xtatish
echo "1. API to'xtatilmoqda..."
pm2 stop flow-api || true
pm2 delete flow-api || true
sleep 2

# 2. Headless Chrome process'larni to'xtatish
echo "2. Chrome process'lar tozalanmoqda..."
pkill -f "chrome.*remote-debugging-port=9222" || true
sleep 2

# 3. Temp profile'larni tozalash
echo "3. Temp profile'lar o'chirilmoqda..."
rm -rf /tmp/chrome-kiara-cdp-* || true

# 4. Cookie'lar mavjudligini tekshirish
echo "4. Desktop Chrome cookie'lari tekshirilmoqda..."
COOKIE_FILE="$HOME/.config/google-chrome/Default/Cookies"
if [ -f "$COOKIE_FILE" ]; then
    SIZE=$(stat -f%z "$COOKIE_FILE" 2>/dev/null || stat -c%s "$COOKIE_FILE" 2>/dev/null)
    echo "   ✓ Cookie fayl mavjud: $SIZE bytes"
else
    echo "   ✗ OGOHLANTIRISH: Cookie fayl topilmadi!"
    echo "   VNC orqali Chrome'da https://labs.google/fx/fr/tools/flow sahifasiga kiring"
    exit 1
fi

# 5. API qayta ishga tushirish
echo "5. API qayta ishga tushirilmoqda..."
cd ~/bumcpb
pm2 start ecosystem.config.cjs --name flow-api

echo ""
echo "=== Tugadi ==="
echo "API qayta ishga tushirildi!"
echo ""
echo "Test uchun:"
echo "  curl http://localhost:8080/health"
echo ""
echo "15 soniya kuting, keyin test qiling..."
sleep 5

# 6. Log ko'rsatish
pm2 logs flow-api --lines 20
