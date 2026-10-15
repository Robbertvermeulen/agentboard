#!/bin/bash
# Everything Agentboard does happens here, as `node`. Fly has no cron, so
# the runner loop lives next to serve; its output goes to the container's
# stderr (fly logs). If serve dies, the container exits and Fly restarts it.
set -e
agentboard init
rm -f "$AGENTBOARD_DATA"/session.lock*   # a fresh boot has no live session; stale locks (any slot) would block the runner for up to two hours
agentboard sessions recover || echo "sessions recover failed; continuing (dead claims read as free)" >&2   # rows and claims a restart left behind (the runner's finally never ran)
(
  pids=()
  while true; do
    agentboard runner --trigger cron &
    pids+=("$!")
    sleep 60
    # Reap ticks that already finished without blocking on ones still
    # running — AGENTBOARD_MAX_SESSIONS>1 relies on this loop never waiting
    # on a slow tick before firing the next one.
    alive=()
    for pid in "${pids[@]}"; do
      if kill -0 "$pid" 2>/dev/null; then
        alive+=("$pid")
      else
        wait "$pid" 2>/dev/null || true
      fi
    done
    pids=("${alive[@]}")
  done
) &
exec agentboard serve --port 4666
