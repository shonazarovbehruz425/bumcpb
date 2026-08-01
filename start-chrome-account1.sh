#!/bin/bash
# Auto-start Chrome for Account 1: behruzyuldoshev691@gmail.com
# Opens directly to the project page

export DISPLAY=:1

echo "🚀 Starting Chrome for behruzyuldoshev691@gmail.com..."

google-chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/home/beka/.config/google-chrome \
  --profile-directory=Default \
  --no-sandbox \
  --no-first-run \
  "https://labs.google/fx/fr/tools/flow/project/66432ae8-910e-4c93-9f36-b4e8f0c39b04" \
  > /dev/null 2>&1 &

echo "✅ Chrome ochildi!"
echo "📍 Account: behruzyuldoshev691@gmail.com"
echo "📍 Project: 66432ae8-910e-4c93-9f36-b4e8f0c39b04"
echo "📍 CDP Port: 9222"
