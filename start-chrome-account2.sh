#!/bin/bash
# Auto-start Chrome for Account 2: behruzzz406@gmail.com
# Opens directly to the project page

export DISPLAY=:1

echo "🚀 Starting Chrome for behruzzz406@gmail.com..."

google-chrome \
  --remote-debugging-port=9223 \
  --user-data-dir=/home/beka/.config/google-chrome-acc2 \
  --profile-directory=Default \
  --no-sandbox \
  --no-first-run \
  "https://labs.google/fx/fr/tools/flow/project/7f3bc736-6c4e-4573-a207-6bb887a95317" \
  > /dev/null 2>&1 &

echo "✅ Chrome ochildi!"
echo "📍 Account: behruzzz406@gmail.com"
echo "📍 Project: 7f3bc736-6c4e-4573-a207-6bb887a95317"
echo "📍 CDP Port: 9223"
