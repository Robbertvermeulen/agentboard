#!/bin/sh
# Everything Agentboard does happens here, as `node`. Fly has no cron, so
# the runner loop lives next to serve; its output goes to the container's
# stderr (fly logs). If serve dies, the container exits and Fly restarts it.
set -e
agentboard init
(
  while true; do
    agentboard runner --trigger cron || true
    sleep 60
  done
) &
exec agentboard serve --port 4666
