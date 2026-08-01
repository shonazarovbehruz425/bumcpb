#!/bin/bash
# Start Chrome Profile 1: behruzyuldoshev691@gmail.com (Port 9222)

echo "Starting Chrome for behruzyuldoshev691@gmail.com on port 9222..."

DISPLAY=:1 google-chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/home/beka/.config/google-chrome \
  --profile-directory=Default > /dev/null 2>&1 &

sleep 2

if curl -s http://127.0.0.1:9222/json/version > /dev/null 2>&1; then
  echo "✓ Chrome started successfully on port 9222"
  echo "PID: $!"
  echo ""
  echo "Next steps:"
  echo "1. Connect via VNC (localhost:5901)"
  echo "2. Login to Google Flow"
  echo "3. Open your project"
else
  echo "✗ Failed to start Chrome"
  exit 1
fi
