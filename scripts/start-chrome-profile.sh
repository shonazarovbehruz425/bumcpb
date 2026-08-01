#!/bin/bash

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${BLUE}=== Chrome Profile Launcher ===${NC}\n"

# Available profiles
echo "Available profiles:"
echo "1) behruzyuldoshev691@gmail.com (Port 9222)"
echo "2) behruzzz406@gmail.com (Port 9223)"
echo "3) Both profiles"
echo "4) Cancel"
echo ""

read -p "Select profile (1-4): " choice

case $choice in
  1)
    echo -e "${YELLOW}Starting Chrome for behruzyuldoshev691@gmail.com on port 9222...${NC}"
    DISPLAY=:1 google-chrome \
      --remote-debugging-port=9222 \
      --user-data-dir=/home/beka/.config/google-chrome \
      --profile-directory=Default &
    echo -e "${GREEN}✓ Chrome started on port 9222${NC}"
    echo "PID: $!"
    ;;
  2)
    echo -e "${YELLOW}Starting Chrome for behruzzz406@gmail.com on port 9223...${NC}"
    DISPLAY=:1 google-chrome \
      --remote-debugging-port=9223 \
      --user-data-dir=/home/beka/.config/google-chrome-acc2 \
      --profile-directory=Default &
    echo -e "${GREEN}✓ Chrome started on port 9223${NC}"
    echo "PID: $!"
    ;;
  3)
    echo -e "${YELLOW}Starting both Chrome profiles...${NC}"
    
    DISPLAY=:1 google-chrome \
      --remote-debugging-port=9222 \
      --user-data-dir=/home/beka/.config/google-chrome \
      --profile-directory=Default &
    PID1=$!
    
    sleep 2
    
    DISPLAY=:1 google-chrome \
      --remote-debugging-port=9223 \
      --user-data-dir=/home/beka/.config/google-chrome-acc2 \
      --profile-directory=Default &
    PID2=$!
    
    echo -e "${GREEN}✓ Chrome #1 started on port 9222 (PID: $PID1)${NC}"
    echo -e "${GREEN}✓ Chrome #2 started on port 9223 (PID: $PID2)${NC}"
    ;;
  4)
    echo "Cancelled"
    exit 0
    ;;
  *)
    echo "Invalid choice"
    exit 1
    ;;
esac

echo ""
echo -e "${BLUE}Done! Connect via VNC and login to Google Flow.${NC}"
echo "VNC: localhost:5901 (via SSH tunnel)"
