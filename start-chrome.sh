#!/bin/bash
export DISPLAY=:1

# 1-profil (Default)
google-chrome --profile-directory="Default" > /dev/null 2>&1 &

sleep 2

# 2-profil (Profile 1)
google-chrome --profile-directory="Profile 1" > /dev/null 2>&1 &

echo "Ikkala profil ham VNC ekranida ishga tushdi!"
