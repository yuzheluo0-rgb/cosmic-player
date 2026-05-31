#!/bin/bash
# 歌者空间 — Public URL Launcher
# One command: bash start-public.sh
# Starts the server + Cloudflare tunnel with auto-reconnect
# URL saved to public-url.txt, accessible at /api/public-url

cd "$(dirname "$0")"

echo "╔══════════════════════════════════════════╗"
echo "║  🎵 歌者空间  —  PUBLIC LAUNCHER  ║"
echo "╚══════════════════════════════════════════╝"

# Start server in background if not running
if ! curl -s http://localhost:3000/ > /dev/null 2>&1; then
  echo "[1/2] Starting server..."
  node server.js &
  sleep 2
else
  echo "[1/2] Server already running on :3000"
fi

echo "[2/2] Starting Cloudflare tunnel (auto-reconnect)..."
echo ""
node tunnel-daemon.js
