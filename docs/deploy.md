# Deploy on Fly.io

One machine, one volume, one agent. Every command below is real; the
first deploy and the data migration are done once, by hand.

## First deploy

```
fly apps create agentboard-app
fly volumes create agentboard_data --region ams --size 3
fly secrets set \
  ANTHROPIC_API_KEY=sk-ant-... \
  AGENTBOARD_SESSION_SECRET="$(openssl rand -base64 48)" \
  FLY_API_TOKEN="$(fly tokens deploy)"
fly deploy --ha=false
fly machine list
fly volumes list
fly logs
```

`fly machine list` and `fly volumes list` should each show exactly one
machine and one volume, attached.

`fly logs` should show `Agentboard on https://agentboard-app.fly.dev`
and, once a minute, `runner: gate: 0 cards, 0 routines`.

`FLY_API_TOKEN` is a deploy token scoped to this app; the in-app update
uses it to swap the machine's image (see the reference, "Updates")
(lands with the update PR).

## Migrate an existing data dir

Do this before anyone uses the new board.

Stop the local board first: kill `agentboard serve` and the runner loop
(`pgrep -fl agentboard` shows both), confirm `~/.agentboard/session.lock`
is absent, then back up. From here on the old machine must never run
`serve` or `runner` again — one machine per data dir.

Locally, with the old `AGENTBOARD_DATA`:

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

## Enrol your phone

Enrol after the migration — passkeys live in `board.db`, which the
migration replaces.

```
fly ssh console -u node -C "agentboard auth enrol --name iPhone"
```

Open the printed link on the phone, confirm with Face ID, and the board
opens. Repeat with another `--name` for a laptop.

## Day two

- Backups: Fly snapshots the volume daily (5-day retention). Give the
  context repo a remote as a second copy.
- Client servers that whitelist IPs now see Fly's egress address
  (`fly ips list`).
- Logs: `fly logs`. Shell: `fly ssh console`. Restart: `fly apps restart agentboard-app`.
- Updates: the board tells you when a new release exists; `agentboard update`
  or the button in the sidebar swaps the machine image (lands with the
  update PR).
