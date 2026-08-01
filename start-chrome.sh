#!/bin/bash
# Launch both Chrome profiles automatically
# Account 1: behruzyuldoshev691@gmail.com (Port 9222)
# Account 2: behruzzz406@gmail.com (Port 9223)

export DISPLAY=:1

echo "═══════════════════════════════════════"
echo "  🚀 Chrome Dual Profile Launcher"
echo "═══════════════════════════════════════"
echo ""

# Kill existing Chrome instances
pkill -f "google-chrome.*remote-debugging-port" 2>/dev/null
sleep 2

echo "▶️  Starting Account 1: behruzyuldoshev691@gmail.com (Port 9222)..."
google-chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/home/beka/.config/google-chrome \
  --profile-directory=Default \
  --no-sandbox \
  --no-first-run \
  "https://labs.google/fx/fr/tools/flow/project/66432ae8-910e-4c93-9f36-b4e8f0c39b04" \
  > /dev/null 2>&1 &

sleep 3

echo "▶️  Starting Account 2: behruzzz406@gmail.com (Port 9223)..."
google-chrome \
  --remote-debugging-port=9223 \
  --user-data-dir=/home/beka/.config/google-chrome-acc2 \
  --profile-directory=Default \
  --no-sandbox \
  --no-first-run \
  "https://labs.google/fx/fr/tools/flow/project/7f3bc736-6c4e-4573-a207-6bb887a95317" \
  > /dev/null 2>&1 &

sleep 3

echo ""
echo "✅ Ikkala Chrome ham ishga tushdi!"
echo ""
echo "📍 Account 1: behruzyuldoshev691@gmail.com"
echo "   Project: 66432ae8-910e-4c93-9f36-b4e8f0c39b04"
echo "   CDP Port: 9222"
echo ""
echo "📍 Account 2: behruzzz406@gmail.com"
echo "   Project: 7f3bc736-6c4e-4573-a207-6bb887a95317"
echo "   CDP Port: 9223"
echo ""
echo "🎯 API test qilish: cd ~/bumcpb && ./test-api.sh"
