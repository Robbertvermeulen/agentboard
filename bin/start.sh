#!/bin/sh
# Runs as root for one reason: Fly mounts the volume root-owned and
# Agentboard must run as `node` (Claude Code refuses
# --dangerously-skip-permissions as root). Fix ownership, drop privileges.
set -e
if find /data ! -user node -print -quit 2>/dev/null | grep -q .; then
  chown -R node:node /data
fi
exec gosu node /app/bin/run.sh
