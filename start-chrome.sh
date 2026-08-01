#!/bin/bash

# Launch terminal with Chrome command
# This script opens a terminal showing the Chrome command for manual execution

export DISPLAY=:1

# Open terminal with the Chrome command
xfce4-terminal --title="Chrome Launcher" --geometry=100x30 -e "bash -c '
echo \"═══════════════════════════════════════════════════════════\"
echo \"  🚀 Chrome CDP Launcher - Profile 1\"
echo \"═══════════════════════════════════════════════════════════\"
echo \"\"
echo \"Quyidagi buyruqni terminalga ko'chiring va Enter bosing:\"
echo \"\"
echo \"---------------------------------------------------------------\"
echo \"DISPLAY=:1 google-chrome --remote-debugging-port=9222 --user-data-dir=/home/beka/.config/google-chrome --profile-directory=Default\"
echo \"---------------------------------------------------------------\"
echo \"\"
echo \"Yoki qisqaroq:\"
echo \"\"
echo \"google-chrome\"
echo \"\"
echo \"Keyin Chrome oynasida profile tanlab CDP port qo\'shing.\"
echo \"\"
echo \"Terminal yopilmasligi uchun Enter bosing...\"
read
'"
