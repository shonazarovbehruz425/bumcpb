#!/bin/bash
export DISPLAY=:1

echo "🚀 Starting Chrome profiles with Flow projects..."

# 1-profil (Default) - Account 1
google-chrome \
  --profile-directory="Default" \
  --remote-debugging-port=9222 \
  "https://labs.google/fx/tools/flow/project/7401dff5-f325-4ec2-90e0-4639a6d7d5ff" \
  > /dev/null 2>&1 &

sleep 3

# 2-profil (Profile 1) - Account 2
google-chrome \
  --profile-directory="Profile 1" \
  --remote-debugging-port=9223 \
  "https://labs.google/fx/tools/flow/project/7f3bc736-6c4e-4573-a207-6bb887a95317" \
  > /dev/null 2>&1 &

echo "✅ Ikkala profil ham ishga tushdi!"
echo ""
echo "📍 Account 1: behruzyuldoshev691@gmail.com"
echo "   CDP Port: 9222"
echo "   Project: 7401dff5-f325-4ec2-90e0-4639a6d7d5ff"
echo ""
echo "📍 Account 2: behruzzz406@gmail.com"
echo "   CDP Port: 9223"
echo "   Project: 7f3bc736-6c4e-4573-a207-6bb887a95317"
