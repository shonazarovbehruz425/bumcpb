#!/bin/bash
export DISPLAY=:1
google-chrome --profile-picker --no-sandbox > /dev/null 2>&1 &
echo "Chrome profil tanlash ekrani VNC'da ochildi!"
