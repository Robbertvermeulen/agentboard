# Fly Deploy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agentboard runs on one Fly.io machine with one volume: web UI, API, the runner loop and Claude Code in one container, data on `/data`, passkey auth on at `https://agentboard-app.fly.dev`.

**Architecture:** A Dockerfile on `node:22-bookworm-slim` with git, openssh-client, gosu and Claude Code. `bin/start.sh` runs as root only to fix volume ownership, then drops to `node` via gosu and runs `bin/run.sh`: `init`, a background runner loop (Fly has no cron), `serve` in the foreground. `fly.toml` pins one always-on machine in `ams` with the volume, env and TZ. `docs/deploy.md` is the runbook the owner and the operator follow for the first deploy and the data migration.

**Tech Stack:** Docker, Fly.io (Machines, volumes, secrets), flyctl, gosu.

**Spec:** `docs/superpowers/specs/2026-09-04-auth-deploy-release-update-design.md` — Part 2.

## Global Constraints

- Requires PR 1 (`feat(auth)`) merged: `fly.toml` sets `AGENTBOARD_ORIGIN`, so auth must exist.
- The app runs as `node` (uid 1000). Claude Code refuses `--dangerously-skip-permissions` as root.
- One machine per data dir: `auto_stop_machines = "off"`, `min_machines_running = 1`, never scale to two.
- Secrets never in `fly.toml`: `ANTHROPIC_API_KEY`, `AGENTBOARD_SESSION_SECRET`, `FLY_API_TOKEN`.
- `TZ = "Europe/Amsterdam"`: routines use local machine time.
- Conventional commits on branch `feat/fly-deploy` off `main`.

---

### Task 1: Container image and start scripts

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `bin/start.sh`, `bin/run.sh`

**Interfaces:**
- Produces: an image whose `CMD` is `/app/bin/start.sh`; `agentboard` on `PATH` inside the container; `/data` as the data dir.

- [ ] **Step 1: Branch**

```bash
git checkout main && git pull --ff-only && git checkout -b feat/fly-deploy
```

- [ ] **Step 2: Write the scripts**

`bin/start.sh`:

```sh
#!/bin/sh
# Runs as root for one reason: Fly mounts the volume root-owned and
# Agentboard must run as `node` (Claude Code refuses
# --dangerously-skip-permissions as root). Fix ownership, drop privileges.
set -e
if find /data ! -user node -print -quit 2>/dev/null | grep -q .; then
  chown -R node:node /data
fi
exec gosu node /app/bin/run.sh
```

`bin/run.sh`:

```sh
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
```

```bash
chmod +x bin/start.sh bin/run.sh
sh -n bin/start.sh && sh -n bin/run.sh && echo "scripts parse"
```

Expected: `scripts parse`.

- [ ] **Step 3: Write `.dockerignore`**

```
node_modules
dist
docs
.git
.github
.playwright-mcp
.claude
*.md
!AGENT.md
```

- [ ] **Step 4: Write the `Dockerfile`**

```dockerfile
# Stage 1: build. better-sqlite3 compiles a native module when no prebuilt
# binary matches the platform, so the builder carries the toolchain; the
# runtime image below does not.
FROM node:22-bookworm-slim AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json AGENT.md ./
COPY src ./src
COPY web ./web
RUN npm run build && npm prune --omit=dev

# Stage 2: runtime. git: the context repo (simple-git). openssh-client: the
# agent reaches client servers. gosu: drop root in start.sh. Claude Code:
# the default session command.
FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git openssh-client ca-certificates curl gosu \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @anthropic-ai/claude-code
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/web ./web
COPY --from=build /app/AGENT.md ./AGENT.md
COPY bin ./bin
RUN chmod +x bin/start.sh bin/run.sh \
 && printf '#!/bin/sh\nexec node /app/dist/cli/index.js "$@"\n' > /usr/local/bin/agentboard \
 && chmod +x /usr/local/bin/agentboard \
 && mkdir -p /data /home/node/.claude \
 && chown -R node:node /data /home/node

ENV AGENTBOARD_DATA=/data \
    AGENTBOARD_WORK=/data/work \
    HOME=/home/node \
    NODE_ENV=production

EXPOSE 4666
CMD ["/app/bin/start.sh"]
```

- [ ] **Step 5: Build and smoke-test locally if Docker is available**

```bash
if command -v docker >/dev/null && docker info >/dev/null 2>&1; then
  docker build -t agentboard:local . \
  && docker run --rm -d --name ab-smoke -p 4667:4666 -v ab-smoke-data:/data agentboard:local \
  && for i in $(seq 1 60); do curl -sf -o /dev/null http://127.0.0.1:4667/ && break; sleep 0.5; done \
  && curl -sf http://127.0.0.1:4667/api/boards | grep -q '"boards"' && echo "serve ok (auth off inside container: no origin set)" \
  && docker exec ab-smoke sh -c 'id -u; ls -ld /data; agentboard --help | head -3; claude --version' \
  && docker exec ab-smoke sh -c 'AGENTBOARD_ORIGIN=https://x.example AGENTBOARD_SESSION_SECRET=0123456789012345678901234567890123 agentboard auth enrol --name smoke' \
  && docker rm -f ab-smoke && docker volume rm ab-smoke-data
else
  echo "no docker here — the first fly deploy is the build test (remote builder)"
fi
```

Expected (with Docker): `serve ok`, uid `1000`, `/data` owned by `node`, `claude --version` prints a version, `auth enrol` prints an `https://x.example/#/enrol/…` link. Note the `docker run` above has no origin, so serve binds `127.0.0.1` inside the container and `-p` would not reach it — if `curl` fails for that reason, rerun with `-e AGENTBOARD_ORIGIN=http://localhost:4667 -e AGENTBOARD_SESSION_SECRET=0123456789012345678901234567890123` and expect `401` from `/api/boards` instead. Either outcome proves the image boots.

- [ ] **Step 6: Commit**

```bash
git add Dockerfile .dockerignore bin/start.sh bin/run.sh
git commit -m "feat(deploy): container image with claude code, gosu and the runner loop"
```

---

### Task 2: `fly.toml`

**Files:**
- Create: `fly.toml`

- [ ] **Step 1: Write it**

```toml
# One machine, one volume, never asleep: the runner loop must keep ticking.
app = "agentboard-app"
primary_region = "ams"

[build]
  dockerfile = "Dockerfile"

[env]
  AGENTBOARD_DATA = "/data"
  AGENTBOARD_WORK = "/data/work"
  AGENTBOARD_AUTORUN = "1"
  AGENTBOARD_ORIGIN = "https://agentboard-app.fly.dev"
  AGENTBOARD_SESSION_CMD = "claude -p --output-format stream-json --verbose --dangerously-skip-permissions"
  TZ = "Europe/Amsterdam"

[http_service]
  internal_port = 4666
  force_https = true
  auto_stop_machines = "off"
  auto_start_machines = true
  min_machines_running = 1

[[mounts]]
  source = "agentboard_data"
  destination = "/data"
  initial_size = "3gb"

[[vm]]
  memory = "2gb"
  cpu_kind = "shared"
  cpus = 2
```

- [ ] **Step 2: Validate**

```bash
fly config validate 2>&1 | tail -3
```

Expected: `Configuration is valid` (or the equivalent success line of the installed flyctl). If `fly` is not logged in on the executor's machine, `python3 -c "import tomllib; tomllib.load(open('fly.toml','rb')); print('toml ok')"` is the fallback.

- [ ] **Step 3: Commit**

```bash
git add fly.toml
git commit -m "feat(deploy): fly.toml — one always-on machine in ams with the data volume"
```

---

### Task 3: Runbook and README link

**Files:**
- Create: `docs/deploy.md`
- Modify: `README.md` ("Learn more")

- [ ] **Step 1: Write `docs/deploy.md`**

```markdown
# Deploy on Fly.io

One machine, one volume, one agent. Every command below is real; the
first deploy and the data migration are done once, by hand.

## First deploy

```
fly launch --no-deploy --copy-config --name agentboard-app --region ams
fly volumes create agentboard_data --region ams --size 3
fly secrets set \
  ANTHROPIC_API_KEY=sk-ant-... \
  AGENTBOARD_SESSION_SECRET="$(openssl rand -base64 48)" \
  FLY_API_TOKEN="$(fly tokens deploy)"
fly deploy
fly logs
```

`fly logs` should show `Agentboard on https://agentboard-app.fly.dev`
and, once a minute, `runner: gate: 0 cards, 0 routines`.

`FLY_API_TOKEN` is a deploy token scoped to this app; the in-app update
uses it to swap the machine's image (see the reference, "Updates").

## Enrol your phone

```
fly ssh console -C "agentboard auth enrol --name iPhone"
```

Open the printed link on the phone, confirm with Face ID, and the board
opens. Repeat with another `--name` for a laptop.

## Migrate an existing data dir

Do this before anyone uses the new board. Locally, with the old
`AGENTBOARD_DATA`:

```
agentboard backup --out /tmp/ab-migrate      # prints <archive>.tar.gz
fly sftp shell
  put /tmp/ab-migrate/<archive>.tar.gz /data/migrate.tar.gz
  exit
fly ssh console
  cd /data && mkdir -p /tmp/m && tar xzf migrate.tar.gz -C /tmp/m
  N=$(ls /tmp/m)
  rm -rf board.db board.db-wal board.db-shm secrets.env artifacts uploads context
  mv /tmp/m/$N/* /data/ && rm -rf /tmp/m migrate.tar.gz
  exit
fly apps restart agentboard-app
```

The archive holds `board.db` (a consistent `VACUUM INTO` snapshot),
`secrets.env`, `artifacts/`, `uploads/` and the `context/` repo with its
history. `session.lock`, `sessions/` and `work/` are not in it and must not
be copied. `start.sh` fixes file ownership on the restart.

From now on the old machine only edits the repo. Never run `serve` or
`runner` against the old data dir again: one machine per data dir.

## Day two

- Backups: Fly snapshots the volume daily (5-day retention). Give the
  context repo a remote as a second copy.
- Client servers that whitelist IPs now see Fly's egress address
  (`fly ips list`).
- Logs: `fly logs`. Shell: `fly ssh console`. Restart: `fly apps restart agentboard-app`.
- Updates: the board tells you when a new release exists; `agentboard update`
  or the button in the sidebar swaps the machine image.
```

- [ ] **Step 2: README link**

In `README.md`, "Learn more", add after the Reference line:

```markdown
- [Deploy on Fly](docs/deploy.md): one machine, one volume, phone login.
```

- [ ] **Step 3: Commit, push, PR**

```bash
git add docs/deploy.md README.md
git commit -m "docs(deploy): fly runbook and README link"
git push -u origin feat/fly-deploy
gh pr create --title "feat(deploy): Dockerfile, fly.toml and runbook" --body "$(cat <<'EOF'
Fly.io deployment — spec Part 2 (docs/superpowers/specs/2026-09-04-auth-deploy-release-update-design.md).

- Dockerfile: node 22 slim + git, openssh-client, gosu, Claude Code; runs as node
- bin/start.sh (root: chown volume, gosu) → bin/run.sh (init, runner loop, serve)
- fly.toml: agentboard-app, ams, 2 GB, always-on, volume at /data, TZ Europe/Amsterdam
- docs/deploy.md: first deploy, enrol, migration, day two

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

### Task 4: First deploy (operator, together with the owner — not a subagent task)

Fly actions cost money and need the owner's account; run these with the
owner present, from the repo root on `main` after PR 2 merged.

- [ ] `fly launch --no-deploy --copy-config --name agentboard-app --region ams` — answer "no" to every extra service it offers (Postgres, Redis, Sentry).
- [ ] `fly volumes create agentboard_data --region ams --size 3`
- [ ] `fly secrets set ANTHROPIC_API_KEY=… AGENTBOARD_SESSION_SECRET="$(openssl rand -base64 48)" FLY_API_TOKEN="$(fly tokens deploy)"` — the API key comes from the owner.
- [ ] `fly deploy` → wait for `Agentboard on https://agentboard-app.fly.dev` in `fly logs`.
- [ ] `curl -s -o /dev/null -w "%{http_code}\n" https://agentboard-app.fly.dev/api/boards` → `401`.
- [ ] Migration per `docs/deploy.md` (owner confirms the local runner loop is stopped; it was not running on 2026-09-03).
- [ ] `fly ssh console -C "agentboard auth enrol --name iPhone"` → owner opens the link on the phone → board renders.
- [ ] Owner moves one card from the phone; `fly logs` shows `runner: lock acquired` within seconds (serve-hook) and a session starting with the real `claude -p`.
- [ ] Record in `docs/deploy.md` anything that differed (gosu availability, volume ownership, prompts from `fly launch`), commit as `docs(deploy): notes from the first deploy`.
