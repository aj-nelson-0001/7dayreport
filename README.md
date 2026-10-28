# 7dayreport

A dashboard that summarises Freebuff activity over the past 7 days. Zero npm
dependencies — Node's built-in `http` + `fetch` (Node ≥ 18).

## The data honesty note (read this first)

The Freebuff API exposes **no per-day history endpoint** — only two live
snapshots (`/session`, `/streak`). So a day-by-day spend breakdown cannot be
back-filled for the past.

What *can* be derived truthfully:

- **Days active** — from the current streak. Your streak run proves every day
  within the streak window was active, so the last 7 days show correctly as
  active even before any logging.
- **Streak bonus earned** — `days active × daily bonus`.
- **Rolling free-window usage** — the live `day / week / month` aggregates.
- **Current position** — balance, daily pool, wallet, model prices.

**Per-day spend/balance numbers only appear for days that were logged** — they
are `null` for unlogged days, never invented. Run the daily logger (below) and
those cells fill with real figures as history accumulates; after a week every
day in the window has real numbers.

## Usage

```bash
node server.js            # dashboard at http://127.0.0.1:4177
PORT=8080 node server.js  # custom port
node server.js --print    # 7-day report as text to stdout, then exit
node snapshot.js          # capture today's snapshot into data/history.jsonl
                          # (also records a compact projects row into
                          #  data/projects-history.jsonl)
node snapshot.js --quiet  # same, silent
node export-projects.js  # write public/projects.html — a static snapshot of
                          # the project list (served at /projects.html)
./7dayreport.sh          # one-shot: snapshot today, start the server if
                          # it isn't running, open the dashboard
```

npm shortcuts: `npm start`, `npm run log`, `npm run print`.

## Build real history (the point of the project)

Run `snapshot.js` once a day. It **upserts by calendar day**, so re-running
never duplicates a row — one snapshot per day. The same run also records a
compact projects-scan row (per-project commits/files/docs-done + counts),
which powers the dashboard's "since snapshot" progress deltas.

### cron

```bash
crontab -e
```

```cron
# Log Freebuff state once a day at 09:15.
# DBUS_SESSION_BUS_ADDRESS is required: cron runs outside your login session,
# so `secret-tool` cannot reach the keychain without it and the logger fails
# with "Cannot autolaunch D-Bus without X11 $DISPLAY". Replace 1000 with your
# uid if different (`id -u`).
15 9 * * * DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus /usr/bin/node /home/andy/Projects/7dayreport/snapshot.js --quiet >> /home/andy/Projects/7dayreport/data/cron.log 2>&1
```

### systemd user timer (no cron daemon needed)

`~/.config/systemd/user/7dayreport-log.service`:

```ini
[Unit]
Description=Freebuff 7-day snapshot logger

[Service]
Type=oneshot
ExecStart=/usr/bin/node /home/andy/Projects/7dayreport/snapshot.js --quiet
```

`~/.config/systemd/user/7dayreport-log.timer`:

```ini
[Unit]
Description=Daily Freebuff snapshot

[Timer]
OnCalendar=*-*-* 09:15:00
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now 7dayreport-log.timer
```

## Auth

The logger and server read the same auth token the freebuff CLI stores in the
OS keychain (`secret-tool`, service `freebuff-cli`). Overrides:

- `FREEBUFF_TOKEN` — bearer token directly (skips keychain)
- `FREEBUFF_CREDENTIALS_PATH` — credentials.json path used as the keychain account
- `FREEBUFF_API_BASE` — default `https://www.codebuff.com`
- `SEVEN_DAY_HISTORY_FILE` — override history path
- `SEVEN_DAY_PROJECTS_HISTORY_FILE` — override projects history path
- `PORT` / `HOST` — server bind (default `127.0.0.1:4177`)

## Routes

| Route | Method | Returns |
|---|---|---|
| `/` | GET | dashboard UI |
| `/api/report` | GET | `{ report }` — 7-day summary (live + history) |
| `/api/log` | POST | capture snapshot now, returns updated `{ report }` |
| `/api/history` | GET | raw history rows (inspection) |
| `/api/projects` | GET | `{ projects }` — progress across `~/Projects` (git facts + doc summaries, cached ~60s; `?force=1` rescans) |
| `/api/projects/history` | GET | `{ rows }` — daily projects snapshots (progress over time) |
| `/projects.html` | GET | static export of the project list (regenerate with `node export-projects.js`) |

## Files

- `freebuff.js` — shared lib: token, API, JSONL history, `buildReport()`
- `projects.js` — project progress scanner: git/filesystem facts + progress-doc
  summaries for every directory under `PROJECTS_ROOT` (default `~/Projects`),
  plus the daily projects snapshot (JSONL, upsert by day)
- `server.js` — HTTP server + `--print` text mode
- `export-projects.js` — writes `public/projects.html`, a standalone HTML
  export of the current project list (same scanner as `/api/projects`)
- `snapshot.js` — daily logger CLI (Freebuff state + projects progress row)
- `7dayreport.sh` — one-shot launcher (snapshot → server if needed → open browser)
- `public/index.html` — dashboard UI (projects panel: filter chips, sort,
  text search, detail modal, snapshot deltas)
- `public/projects.html` — generated static export of the project list
- `data/history.jsonl` — your local per-day history (gitignored, created at
  first log)
- `data/projects-history.jsonl` — daily projects snapshots (gitignored,
  created at first log)
