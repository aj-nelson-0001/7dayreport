#!/usr/bin/env bash
# One-shot launcher for the 7dayreport dashboard:
#   1. capture today's snapshot (Freebuff state + projects progress row)
#   2. start the dashboard server if it isn't already answering
#   3. open the dashboard in your browser
#
# Usage:  ./7dayreport.sh            (PORT=8080 ./7dayreport.sh for a custom port)
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-4177}"
URL="http://127.0.0.1:$PORT"

echo "· capturing today's snapshot..."
node snapshot.js

if curl -sf "$URL/api/projects/history" >/dev/null 2>&1; then
  echo "· server already running on :$PORT"
else
  echo "· starting server on :$PORT..."
  # setsid: detached so it survives this script (and its parent shell) exiting
  setsid node server.js >/tmp/7dayreport.log 2>&1 </dev/null &
  for _ in $(seq 1 40); do
    curl -sf "$URL/" >/dev/null 2>&1 && break
    sleep 0.25
  done
  if ! curl -sf "$URL/" >/dev/null 2>&1; then
    echo "server failed to start — see /tmp/7dayreport.log" >&2
    exit 1
  fi
fi

echo "· opening $URL"
if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$URL" >/dev/null 2>&1 &   # backgrounded: never block on the browser
else
  echo "  (no xdg-open found — open $URL in your browser manually)"
fi
echo "done: $URL"
