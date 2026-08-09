#!/bin/bash
set -e

DISPLAY="${DISPLAY:-:99}"
SCREEN="${SCREEN_RESOLUTION:-1920x1080x24}"
VNC_PORT="${VNC_PORT:-5900}"
NOVNC_PORT="${NOVNC_PORT:-6080}"

export DISPLAY

# Remove stale lock file from a previous crash
rm -f "/tmp/.X${DISPLAY#:}-lock" /tmp/.X11-unix/X"${DISPLAY#:}" 2>/dev/null || true

echo "[entrypoint] Starting Xvfb on display $DISPLAY ($SCREEN)..."
Xvfb "$DISPLAY" -screen 0 "$SCREEN" -ac +extension GLX +render -noreset &
XVFB_PID=$!

# Wait for Xvfb to be ready
sleep 1

echo "[entrypoint] Starting x11vnc on port $VNC_PORT..."
x11vnc \
  -display "$DISPLAY" \
  -nopw \
  -rfbport "$VNC_PORT" \
  -shared \
  -forever \
  -quiet \
  -noxdamage \
  2>/dev/null &

echo "[entrypoint] Starting noVNC on port $NOVNC_PORT..."
websockify \
  --web /usr/share/novnc \
  "$NOVNC_PORT" \
  "localhost:$VNC_PORT" \
  2>/dev/null &

echo "[entrypoint] Starting sidecar on port ${PORT:-3003}..."
exec node src/server.js
