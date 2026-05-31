#!/bin/bash
# Cosmic Player 公网隧道 — 自动重连
# 每次断连自动重试，URL 会打印到 cosmic-url.txt

cd /c/Users/21046/cosmic-player
node server.js &
SERVER_PID=$!
echo "Server PID: $SERVER_PID"

while true; do
  echo "=== $(date) Connecting tunnel ==="
  ssh -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -R 0:localhost:3000 -p 443 a.pinggy.io 2>&1 | while read line; do
    echo "$line"
    if echo "$line" | grep -q "https://.*\.run\.pinggy-free\.link"; then
      echo "$line" | grep -o 'https://[^ ]*\.run\.pinggy-free\.link' > /c/Users/21046/cosmic-url.txt
      echo "URL saved to cosmic-url.txt"
    fi
  done
  echo "Tunnel disconnected, reconnecting in 5s..."
  sleep 5
done
