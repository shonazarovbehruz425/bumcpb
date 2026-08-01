#!/bin/bash
export DISPLAY=:1

# 1-profil (Default)
google-chrome --profile-directory="Default" --no-sandbox > /dev/null 2>&1 &

# 2-profil (Profile 1)
google-chrome --profile-directory="Profile 1" --no-sandbox > /dev/null 2>&1 &

echo "Ikkala profil ham VNC ekranida ishga tushdi!"
