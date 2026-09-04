# Auth, Fly deploy, release pipeline, in-app update — design

Date: 2026-09-04. Status: approved in brainstorm, awaiting spec review.
Frame: the vision document (`2026-08-24-agentboard-vision.md`) still governs
the board; this spec adds the layer that makes Agentboard a product one
person can run on a server and use from a phone.

## Goal

By tonight: Agentboard runs on Fly.io at `https://agentboard-app.fly.dev`,
the owner logs in with a passkey from the phone, the existing data dir has
moved over, and the agent keeps working there. Right after: merges to main
produce versioned releases and a Docker image, and a running Agentboard can
see and pull the newest release from the CLI and the UI.

Four parts, four PRs, in this order: **1 auth → 2 deploy → 3 release → 4
update**. 1 and 2 are needed for tonight. 3 and 4 are independent of each
other; 4's Fly path is only testable end-to-end once 3 has published an
image.

## Decisions (from the brainstorm)

- Passkeys (WebAuthn) are the only credential. No passwords, no magic
  links, no OAuth. One user for now; `user.email` exists but stays null.
- Domain `agentboard-app.fly.dev` (`agentboard.fly.dev` is taken). Passkeys
  bind to the hostname; a later custom domain means re-enrolling devices.
- First release from the pipeline is `0.2.0`: tag `v0.1.0` goes on the
  current main before the release workflow exists.
- Releases never deploy. A release is a GitHub release plus a Docker image
  on GHCR; the running Agentboard notices and pulls it on request.
- The local data dir migrates to Fly; one machine per data dir, so the
  local runner stays off afterwards.
- The agent needs no HTTP auth: it uses the CLI on the same machine.

## Non-goals

Multi-user, organisations, invitations, session listing/revocation UI,
SSO, rate limiting, account recovery by email, auto-deploy, in-app update
for plain Docker (notice only), forks pulling their own image name.

---

## Part 1 — Auth: passkeys

### Configuration

- `AGENTBOARD_ORIGIN` (e.g. `https://agentboard-app.fly.dev`). Auth is on
  iff this is set. The WebAuthn RP ID is its hostname; the expected origin
  is the value itself.
- `AGENTBOARD_SESSION_SECRET`: ≥ 32 bytes, signs cookies. Origin set
  without a secret → `serve` refuses to start with a clear message.
- **Without `AGENTBOARD_ORIGIN`, `serve` binds `127.0.0.1` only** and logs
  "auth off — listening on localhost only". Today it listens on all
  interfaces with no auth; that footgun goes away in this change. Local
  development keeps working unchanged (`http://localhost:4666`).

### Schema (additive, `src/core/db.ts`)

```
user          id TEXT PK, name TEXT NOT NULL, email TEXT NULL, created_at TEXT
credential    id TEXT PK (base64url credential id), user_id TEXT FK,
              public_key BLOB, counter INTEGER, transports TEXT (JSON array),
              device_type TEXT, backed_up INTEGER, name TEXT,
              created_at TEXT, last_used_at TEXT NULL
auth_session  id TEXT PK (32 random bytes base64url), user_id TEXT FK,
              created_at TEXT, expires_at TEXT, last_seen_at TEXT,
              user_agent TEXT NULL
enrol_token   token_hash TEXT PK (sha256 of the token), user_id TEXT FK,
              name TEXT (device label), expires_at TEXT, used_at TEXT NULL
```

`session` already exists for agent sessions, hence `auth_session`.
Challenges are not stored: they travel in a signed cookie (below).

### Core (`src/core/auth.ts`)

Wraps `@simplewebauthn/server` ^13. Functions, all synchronous SQLite
except the WebAuthn verifies:

- `ensureOwner()` → the single user row, created as `name: 'owner'` on
  first use.
- `createEnrolToken(name)` → `{ token, expiresAt }`; 32 random bytes
  base64url, 15 minutes, stored as sha256. `lookupEnrolToken(token)`
  rejects unknown, expired or used tokens; `consumeEnrolToken` marks used.
- `registrationOptions(user)` → `generateRegistrationOptions` with
  `rpName: 'Agentboard'`, `rpID`, `userName: user.name`,
  `attestationType: 'none'`, `authenticatorSelection: { residentKey:
  'required', userVerification: 'preferred' }`, `excludeCredentials` = the
  user's existing credential ids.
- `verifyRegistration(user, response, challenge, name)` →
  `verifyRegistrationResponse({ expectedChallenge, expectedOrigin,
  expectedRPID })`; on success inserts `credential` from
  `registrationInfo.credential` (`id`, `publicKey`, `counter`,
  `transports`) plus `credentialDeviceType`/`credentialBackedUp`.
- `authenticationOptions()` → `generateAuthenticationOptions({ rpID,
  userVerification: 'preferred' })` with **no** `allowCredentials`
  (discoverable credentials: login is one button, no username).
- `verifyAuthentication(response, challenge)` → looks the credential up by
  `response.id`, `verifyAuthenticationResponse({ ..., credential,
  requireUserVerification: false })`, updates `counter` and
  `last_used_at`, returns the user.
- Sessions: `createSession(userId, userAgent)`, `getSession(id)` (null if
  expired), `touchSession(id)` (extends `expires_at` to now + 30 days, at
  most once per day to limit writes), `deleteSession(id)`,
  `pruneAuth()` (expired sessions, used/expired tokens; called at `serve`
  start).
- `listCredentials()` for the CLI.

### CLI (`src/cli/index.ts`)

- `agentboard auth enrol --name <label>` → prints
  `${AGENTBOARD_ORIGIN}/#/enrol/<token>` and the expiry. The token sits in
  the URL fragment, so it never reaches server logs. Requires
  `AGENTBOARD_ORIGIN`; without it prints why. Run again for a second
  device.
- `agentboard auth list` → table of credentials: name, device type, backed
  up, created, last used. `--json` on both, like every command.

### HTTP (`src/api/server.ts`)

Routes, all JSON, all return `{ error }` with 4xx on failure:

- `POST /auth/register/options` `{ token, name? }` → validates the token,
  builds options, sets challenge cookie, returns the options JSON.
- `POST /auth/register/verify` `{ token, response }` → verifies against the
  challenge cookie, consumes the token, stores the credential, creates a
  session, sets the session cookie, clears the challenge cookie → `{ ok }`.
- `POST /auth/login/options` → options + challenge cookie.
- `POST /auth/login/verify` `{ response }` → verifies, creates session,
  sets cookie → `{ ok }`.
- `POST /auth/logout` → deletes the session, clears the cookie → `{ ok }`.
- `GET /auth/state` (public) → `{ auth: false }` when auth is off, else
  `{ auth: true, user: { name } | null }`. The UI calls it once at boot to
  decide whether to show "Sign out".

Cookies (via `hono/cookie` signed helpers, HMAC with the secret):

- `ab_session`: session id. `HttpOnly`, `Secure` when the origin is https,
  `SameSite=Lax`, `Path=/`, `Max-Age` 30 days. Rolling: `touchSession`
  extends `expires_at` at most once a day and, when it does, the
  middleware re-issues the cookie with a fresh `Max-Age` (a fixed
  `Max-Age` would make the browser drop the cookie 30 days after login
  regardless of use).
- `ab_chal`: `{ purpose: 'register'|'login', challenge, tokenHash? }`,
  `Max-Age` 300, same flags. Cleared after use.

Middleware, only when auth is on:

- Every `/api/*` request requires a valid `ab_session`; otherwise
  `401 { error: 'unauthenticated' }`. `/auth/*` and the static UI (`/`,
  `/style.css`, `/js/*`) stay public: the shell carries no data.
- Every `POST/PUT/PATCH/DELETE` under `/api/*` and `/auth/*` must carry an
  `Origin` header equal to `AGENTBOARD_ORIGIN`; missing or different →
  `403 { error: 'bad origin' }`. This replaces CSRF tokens. The CLI never
  uses HTTP, so nothing else is affected.
- The serve-hook (`AGENTBOARD_AUTORUN`) and `/api/changes` polling are
  untouched: same cookie, same rules.

### UI (`web/`)

- `web/js/vendor/simplewebauthn-browser.js`: the UMD bundle of
  `@simplewebauthn/browser` ^13 (the package ships no single-file ESM
  bundle), installed as a devDependency and copied from `node_modules` by
  `npm run vendor` (a one-line script), MIT header and version kept in the
  file. `web/index.html` loads it with a classic script tag before `app.js`;
  the views read `window.SimpleWebAuthnBrowser`. No build step for `web/`.
- `api.js`: `req()` throws an error with `status = 401` on 401. `app.js`
  catches it in `route()`: remembers the intended hash, renders the login
  view instead of the error view.
- Login view (`views/login.js`): the Agentboard mark, one button "Sign in
  with passkey", an error line. Flow: options → `startAuthentication({
  optionsJSON })` → verify → navigate to the remembered hash (default
  `#/`).
- Enrol view (`views/enrol.js`, route `#/enrol/<token>`): device-name
  field prefilled from the token's label, one button "Register this
  device". Flow: options → `startRegistration({ optionsJSON })` → verify →
  `#/`. Expired/used token → message telling the user to run `auth enrol`
  again.
- "Sign out" as a small link at the bottom of the sidebar and as a row in
  the mobile More-sheet; hidden when auth is off. Calls logout, then
  reloads to the login view.
- Mobile: both views are single-column and work in Safari on iOS (Face
  ID). Nothing else changes.

### Docs

`docs/reference.md` gets an "Auth" section (config, enrol, cookie rules,
localhost-only when off). README unchanged except that "Try it" stays
valid: without an origin it is localhost-only, as before.

### Verification (`docs/superpowers/plans/verify-auth.sh`)

Fresh scratch data dir, `serve` on a free port with
`AGENTBOARD_ORIGIN=http://localhost:<port>` (WebAuthn allows `localhost`).

1. curl: `GET /api/boards` → 401. `POST /api/boards` with wrong Origin →
   403. `GET /` → 200.
2. curl: `POST /auth/register/options` with a bogus token → 4xx; with a
   token from `auth enrol --json` → 200 and a challenge.
3. Playwright (devDependency `playwright`, chromium) with a CDP virtual
   authenticator (`WebAuthn.enable`, `addVirtualAuthenticator` with
   `hasResidentKey`, `hasUserVerification`, `isUserVerified`): open the
   enrol URL, register, land on the board; `GET /api/boards` with the
   session cookie → 200; log out → 401 again; log in with one click →
   200. `auth list` shows one credential with `last_used_at` set.
4. Without `AGENTBOARD_ORIGIN`: `serve` binds 127.0.0.1 and `GET
   /api/boards` works without a cookie.

---

## Part 2 — Fly: one machine, one volume

### Image (`Dockerfile`, `.dockerignore`)

- Two stages on `node:22-bookworm-slim`. Build stage: `python3 make g++`
  (better-sqlite3 compiles its native module when no prebuilt binary
  matches), `npm ci`, `npm run build`, `npm prune --omit=dev`. Runtime
  stage: `git`, `openssh-client`, `ca-certificates`, `curl`, `gosu`,
  `npm i -g @anthropic-ai/claude-code`, and `COPY --from=build` of
  `node_modules`, `dist`, `web`, `AGENT.md`, `package*.json`.
- Copy `package*.json`, `npm ci`; copy `src/`, `web/`, `tsconfig.json`,
  `AGENT.md`; `npm run build`; `npm prune --omit=dev`.
- `/usr/local/bin/agentboard` is a two-line wrapper around
  `node /app/dist/cli/index.js` (no `npm link`).
- Claude Code refuses `--dangerously-skip-permissions` as root, and Fly
  mounts volumes root-owned. So: the image installs `gosu`, `CMD` runs
  `bin/start.sh` **as root**, which `chown -R node:node /data` when needed
  and then `exec gosu node bin/run.sh`. Everything Agentboard does runs as
  `node` (uid 1000) with `HOME=/home/node` (writable, for Claude Code's
  own config).
- `ENV AGENTBOARD_DATA=/data AGENTBOARD_WORK=/data/work`.
- `.dockerignore`: `node_modules`, `dist`, `docs`, `.git`, `.github`,
  `.playwright-mcp`, `.claude`.
- `CMD ["/app/bin/start.sh"]`.

### `bin/start.sh` and `bin/run.sh`

`start.sh` (root): fix `/data` ownership, then `exec gosu node /app/bin/run.sh`.

`run.sh` (node):

```
agentboard init                      # idempotent: creates only what is missing
( while true; do agentboard runner --trigger cron; sleep 60; done ) &
exec agentboard serve --port 4666
```

Runner output goes to the container's stderr (Fly logs). If `serve` dies
the container exits and Fly restarts the machine.

### `fly.toml`

```
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
  TZ = "Europe/Amsterdam"          # routines use local machine time

[http_service]
  internal_port = 4666
  force_https = true
  auto_stop_machines = "off"       # the runner loop must keep running
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

Secrets (never in the file): `ANTHROPIC_API_KEY`,
`AGENTBOARD_SESSION_SECRET`, `FLY_API_TOKEN` (deploy token, used by Part 4).

### Runbook (`docs/deploy.md`)

Executed together with the owner on first deploy; every command listed:

1. `fly apps create agentboard-app`
   (creates the app; the region comes from `fly.toml` at deploy).
2. `fly volumes create agentboard_data --region ams --size 3`.
3. `fly secrets set ANTHROPIC_API_KEY=… AGENTBOARD_SESSION_SECRET=$(openssl rand -base64 48) FLY_API_TOKEN="$(fly tokens deploy)"`.
4. `fly deploy --ha=false` (remote builder; no local Docker needed).
5. Migration: locally `agentboard backup --out /tmp/ab-migrate` → one
   `tar.gz` containing `<name>/board.db`, `secrets.env`, `artifacts/`,
   `uploads/`, `context/`. Upload with `fly sftp shell` (`put`), then
   `fly ssh console`: `tar xzf` into `/tmp`, move the five entries into
   `/data` (replacing the empty ones `init` made), restart the machine
   (`fly machine restart`; `start.sh` fixes ownership on boot). Never copy `session.lock`, `sessions/` or
   `work/` (not in the backup anyway).
6. `fly ssh console -u node -C "agentboard auth enrol --name iPhone"` → open the
   printed URL on the phone → Face ID → board.
7. Check `fly logs` for a runner tick and `Agentboard on http://…`.
8. From now on the local machine only edits the repo, never runs `serve`
   or `runner` against the old data dir (one machine per data dir).

README "Learn more" gains one line: "[Deploy on Fly](docs/deploy.md)".

Notes for the runbook: Fly takes daily volume snapshots (5-day
retention), which is the backup baseline until an off-box `agentboard
backup` target exists. Client servers that whitelist IPs will now see a Fly
egress address. Outbound SSH from the container is fine.

### Verification

- If Docker is available locally: `docker build` and a smoke run with a
  scratch volume (`serve` answers, `auth enrol` prints a URL). Otherwise
  the first `fly deploy` is the build test.
- On Fly: `fly logs` shows `runner: gate: …` once a minute; the phone logs
  in; a card moved from the phone pokes the runner (`AGENTBOARD_AUTORUN`).

---

## Part 3 — Release pipeline

### Conventions

Conventional commits (already the practice). PR titles follow the same
format because squash-merge turns the title into the commit on main. A
five-line `CONTRIBUTING.md` says exactly that plus "small PRs, build must
pass". Angular preset: `feat` → minor, `fix`/`perf` → patch, `BREAKING
CHANGE:` footer → major; `docs`, `chore`, `ci`, `refactor` → no release.

### Tag first

`git tag -a v0.1.0 -m "v0.1.0" && git push origin v0.1.0` on the current
main **before** the release workflow lands. Without a tag semantic-release
would start at 1.0.0.

### Repo settings (via `gh`)

Squash merge only (merge commits and rebase merges disabled), squash commit
title = PR title, body = PR body, delete branch on merge. No branch
protection yet: the owner still pushes directly sometimes, and the release
commit needs to land on main.

### Workflows

`.github/workflows/ci.yml` (replaces `build.yml`; the README badge URL
changes accordingly):

- on `pull_request` and `push` to `main`: `npm ci && npm run build`.
- on `pull_request` only: `amannn/action-semantic-pull-request@v5`
  validates the PR title.

`.github/workflows/release.yml`, on `push` to `main`, `concurrency:
release`, permissions `contents: write`, `issues: write`, `pull-requests:
write`, `packages: write`:

- job `release`: checkout (`fetch-depth: 0`, `persist-credentials:
  false`), Node 22, `npm ci`, `cycjimmy/semantic-release-action@v4` with
  `extra_plugins: @semantic-release/changelog @semantic-release/git` and
  `GITHUB_TOKEN`. Outputs `new_release_published`, `new_release_version`.
- job `image`, `needs: release`, `if: new_release_published == 'true'`:
  checkout `v${version}`, `docker/login-action` to GHCR with
  `GITHUB_TOKEN`, `docker/build-push-action` for `linux/amd64` with tags
  `ghcr.io/robbertvermeulen/agentboard:${version}` and `:latest`.

`.releaserc.json`:

```
branches: ["main"]
plugins:
  @semantic-release/commit-analyzer
  @semantic-release/release-notes-generator
  [@semantic-release/changelog, { changelogFile: "CHANGELOG.md" }]
  [@semantic-release/npm, { npmPublish: false }]        # bumps package.json only
  [@semantic-release/git, { assets: ["package.json", "package-lock.json", "CHANGELOG.md"],
                            message: "chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}" }]
  @semantic-release/github
```

`[skip ci]` keeps the release commit from re-triggering the workflows.

### GHCR visibility

The first image push creates a **private** package. Runbook step: make
`ghcr.io/robbertvermeulen/agentboard` public in the package settings so Fly
and self-hosters can pull it without credentials.

### Verification

YAML parses (ruby `YAML.load_file`). The PR that adds the pipeline is a
`ci:` commit and must not release. The next `feat`/`fix` merge releases
`0.2.0` with a GitHub release, a `CHANGELOG.md` commit, and an image on
GHCR. Checked by hand on that first merge.

---

## Part 4 — Update in Agentboard

### Core (`src/core/update.ts`)

- `currentVersion()`: `version` from the package.json next to `dist/`.
- `latestRelease()`: `GET https://api.github.com/repos/Robbertvermeulen/agentboard/releases/latest`
  (overridable with `AGENTBOARD_RELEASES_URL`, used by the probe)
  with `Accept: application/vnd.github+json`, 5 s timeout. Returns
  `{ version, url, publishedAt }` or `null` on any failure. In-memory cache
  of one hour inside the `serve` process; the CLI always fetches.
- `updateAvailable(current, latest)`: semver compare (a small inline
  compare of `major.minor.patch`; no dependency).
- `strategy()`:
  - `'fly'` when `FLY_APP_NAME`, `FLY_MACHINE_ID` and `FLY_API_TOKEN` are
    all set;
  - `'git'` when `<app root>/.git` exists;
  - `'image'` otherwise.
- `performUpdate(version)`:
  - **fly**: refuse with `409 agent session running` when
    `sessionStatus().running` (a reboot mid-session would kill it). Base
    URL `http://${FLY_API_HOSTNAME ?? '_api.internal:4280'}`. `GET
    /v1/apps/${app}/machines/${id}` → take `config`, set `config.image =
    'ghcr.io/robbertvermeulen/agentboard:' + version`, `POST` the same path
    with `{ config }`. Fly reboots the machine on the new image; the volume
    persists. Returns `{ mode: 'fly', restarting: true }`.
  - **git**: refuse when the working tree is dirty. `git fetch --tags`,
    `git checkout v${version}`, `npm ci`, `npm run build`. Returns
    `{ mode: 'git', restartRequired: true }`; the process does not restart
    itself.
  - **image**: returns `{ mode: 'image', command: 'docker pull
    ghcr.io/robbertvermeulen/agentboard:' + version }` and changes nothing.

### HTTP

- `GET /api/version` → `{ version, latest, strategy, updateAvailable }`.
  Behind auth like every `/api` route.
- `POST /api/update` → `performUpdate(latest.version)`; `409` when nothing
  newer, when a session runs, or when the tree is dirty. Origin-checked
  like every mutating route.

### CLI

- `agentboard version` → running version, latest, strategy, one line.
- `agentboard update` → performs the update for the detected strategy and
  prints what happened; `--check` only reports. `--json` on both.

### UI

- Sidebar footer and the mobile More-sheet show `v0.2.0`. When
  `updateAvailable`: `v0.3.0 available` as a button.
- Button → the existing dialog pattern: "Update to 0.3.0?", link to the
  release notes, one line per strategy ("The board restarts; about a
  minute." / "Installs, then restart `agentboard serve`." / the `docker
  pull` line). Confirm → `POST /api/update`.
- Fly: after the POST (or a network error right after it, which is
  expected: the machine is rebooting) the UI shows "Updating…" and polls
  `GET /api/version` every 3 s; when the returned version equals the target
  it shows "Updated to 0.3.0" and reloads. Give up after 5 minutes with a
  message.
- `/api/version` is fetched once at boot and once an hour.

### Docs

`docs/reference.md` gets an "Updates" section (strategies, the Fly token,
the image name).

### Verification (`docs/superpowers/plans/verify-update.sh`)

1. `agentboard version --json` reports the package version and a
   strategy of `git` in the repo checkout.
2. With `FLY_APP_NAME`, `FLY_MACHINE_ID`, `FLY_API_TOKEN` and
   `FLY_API_HOSTNAME=127.0.0.1:<stub port>` set, a tiny Node stub serving
   the two Machines API routes: `agentboard update` (with
   `AGENTBOARD_RELEASES_URL` pointing at the same stub) performs GET then POST, and the POST body carries the new
   image tag. The stub records both calls.
3. With a running fake session (lock held), `update` refuses with the
   session message.
4. `GET /api/version` behind auth returns the fields; `POST /api/update`
   with nothing newer returns 409.

---

## Sequencing and PRs

| PR | Title | Depends on | Builds |
|---|---|---|---|
| 1 | `feat(auth): passkey login` | — | Part 1 |
| 2 | `feat(deploy): Dockerfile, fly.toml, runbook` | 1 (origin/auth on in fly.toml) | Part 2 |
| 3 | `ci: release pipeline with semantic-release and GHCR image` | tag `v0.1.0` pushed first | Part 3 |
| 4 | `feat(update): release notice and in-app update` | 3 for the end-to-end Fly test | Part 4 |

After PR 2 merges: run the runbook with the owner (Fly account actions
are theirs), migrate, enrol the phone. After PR 3 merges nothing releases
(`ci:`); PR 4's merge releases `0.2.0` and publishes the first image, which
is also the first real test of the Fly update path.

## Risks and open points

- Volume ownership is handled by `start.sh` (root, chown, gosu). If Fly's
  remote builder lacks `gosu` in apt for the base image, fall back to
  `su-exec` or `setpriv`; the runbook records what was used.
- Claude Code inside the container needs a working `HOME` and the API key;
  if `claude -p` fails headless for another reason, `fly logs` shows it and
  the board keeps working (only sessions stall).
- Fly egress IPs vs. client firewalls — owner checks per client.
- The Fly update path can only be exercised for real after the first image
  exists (PR 3 + a releasing merge); the stub probe covers the logic.
