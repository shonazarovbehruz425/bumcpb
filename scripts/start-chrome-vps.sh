#!/bin/bash
export DISPLAY=:1

echo "🚀 Starting Chrome profiles with Flow projects in headless mode..."

pkill -9 -f chrome || true
sleep 1

# 1-profil (Default) - Account 1
google-chrome \
  --headless=new \
  --user-data-dir="/home/beka/.config/google-chrome" \
  --profile-directory="Default" \
  --remote-debugging-port=9222 \
  --no-sandbox \
  --disable-dev-shm-usage \
  "https://labs.google/fx/tools/flow/project/7401dff5-f325-4ec2-90e0-4639a6d7d5ff" \
  > /dev/null 2>&1 &

sleep 3

# 2-profil (Profile 1) - Account 2
google-chrome \
  --headless=new \
  --user-data-dir="/home/beka/.config/google-chrome" \
  --profile-directory="Profile 1" \
  --remote-debugging-port=9223 \
  --no-sandbox \
  --disable-dev-shm-usage \
  "https://labs.google/fx/tools/flow/project/7f3bc736-6c4e-4573-a207-6bb887a95317" \
  > /dev/null 2>&1 &

sleep 2
echo "✅ Ikkala profil ham ishga tushdi!"
