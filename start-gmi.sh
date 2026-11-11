#!/usr/bin/env bash
# Starts Meetble on a cloud server. Browser steps (Luma, LinkedIn, X sign-in) need your own Chrome, so they are off here.
cd "$(dirname "$0")"
export HOST=0.0.0.0
export PORT="${PORT:-8787}"
export PYTHON=python3
export MEETBLE_BROWSER=0
MEETBLE_TOKEN="$(cat .meetble_token)"
export MEETBLE_TOKEN
IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
echo "Open this in your browser: http://$IP:$PORT/?token=$MEETBLE_TOKEN"
exec node server.mjs
