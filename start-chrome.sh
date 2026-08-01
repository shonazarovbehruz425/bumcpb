#!/bin/bash

# Start Chrome with CDP for API automation
# Usage: ./start-chrome.sh

export DISPLAY=:1

# Kill existing Chrome instances first
pkill -f "google-chrome.*remote-debugging-port" 2>/dev/null
sleep 1

echo "🚀 Starting Chrome with debugging port..."

# Start Chrome with CDP port 9222
google-chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/home/beka/.config/google-chrome \
  --profile-directory=Default \
  --no-first-run \
  --no-default-browser-check > /dev/null 2>&1 &

CHROME_PID=$!
sleep 3

# Check if Chrome started successfully
if curl -s http://127.0.0.1:9222/json/version > /dev/null 2>&1; then
  echo "✅ Chrome ishga tushdi! (PID: $CHROME_PID)"
  echo "📍 CDP Port: 9222"
  echo "👤 Profile: behruzyuldoshev691@gmail.com"
  echo ""
  echo "Keyingi qadamlar:"
  echo "1. Google Flow ga kiring: https://labs.google/fx/fr/tools/flow"
  echo "2. Login qiling"
  echo "3. Projectingizni oching"
  echo "4. API test qiling: cd ~/bumcpb && ./test-api.sh"
else
  echo "❌ Chrome ishga tushmadi!"
  exit 1
fi
