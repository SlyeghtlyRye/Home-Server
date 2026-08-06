# Setup Guide

This guide walks through setting up your own instance of this home dashboard
system on a lightweight ARM single-board computer (SBC). It assumes no prior
experience with this project.

## What you're setting up

A self-hosted dashboard combining:
- **Pi-hole** — network-wide ad blocking / DNS
- **Mealie** — meal planning, with automated weekly plan generation
- **Kanboard** — a task/kanban board
- **Streams** — a custom multi-profile media player (YouTube links + local
  file uploads, with resume tracking)
- **nginx** — reverse proxy tying it all together behind one dashboard page

Everything runs in Docker except two lightweight host-level Python services.

## Prerequisites

- An ARM (or x86_64) single-board computer or small server running a Debian-
  or Ubuntu-based Linux distribution, with **at least 1GB RAM** (this was
  built and tested on 1GB — it works, but there's no headroom to spare)
- Docker and the Docker Compose v2 plugin installed
  (`docker compose version` should work, not just `docker-compose`)
- Root or sudo access
- The machine should have a **static local IP** on your network — DHCP
  reservations work fine, it just needs to not change after setup

## Step 1 — Install Docker (if not already installed)

```bash
curl -fsSL https://get.docker.com | sh
```

Verify:
```bash
docker compose version
```

## Step 2 — Clone this repository

```bash
cd /root
git clone https://github.com/SlyeghtlyRye/Home-Server.git .
```

**Important:** clone directly into `/root` (note the trailing `.`), not into
a subfolder. This repo *is* the live working directory — every path in the
config, Docker Compose file, and systemd service assumes it lives at
`/root`.

## Step 3 — Run the installer

```bash
chmod +x setup.sh
./setup.sh
```

You'll be prompted for two things:
- **This machine's LAN IP address** — used to build URLs the dashboard and
  backend use to reach each other and Mealie
- **Your timezone** (e.g. `America/Edmonton`) — used by Mealie and Pi-hole
  for correct scheduling/logging

The installer will then:
1. Generate a fresh random secret key and Pi-hole admin password (nothing
   from the original developer's instance is reused)
2. Write these into a local `.env` file (never committed to git, never
   shared)
3. Bring up all Docker containers
4. Restart the host-level trigger service

## Step 4 — Set up the host-level trigger service

The installer brings up Docker containers, but one small Python service runs
directly on the host (not in Docker) so it can access things Docker
containers can't easily reach. Set it up as a systemd service:

```bash
cat > /etc/systemd/system/mealie-trigger.service << 'SERVICE'
[Unit]
Description=Mealie Meal Plan Trigger
After=network.target

[Service]
ExecStart=/usr/bin/python3 /root/scripts/trigger_server.py
Restart=always
WorkingDirectory=/root/scripts

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable --now mealie-trigger.service
systemctl status mealie-trigger.service
```

You should see `active (running)`.

## Step 5 — Get a Mealie API token

1. Visit `http://<your-ip>:9000`, create an account through Mealie's own
   setup flow
2. In Mealie: **Settings → API Tokens → Create Token**
3. Copy the token and save it on the server:
```bash
   echo "paste-your-token-here" > /root/scripts/mealie_token.txt
```

## Step 6 — Verify everything is connected

```bash
curl "http://<your-ip>/data/status"
```

Should return `{"running": false}` or similar JSON — not a connection error
or empty response. This confirms the full chain (nginx → trigger server →
Mealie) is wired correctly.

Visit `http://<your-ip>/` in a browser — you should see the dashboard.

## Testing setup without affecting a real install

Two flags on `setup.sh` let you rehearse the reset/setup flow safely:

- `./setup.sh --reset --dry-run` — walks through exactly what a factory
  reset would do (delete personal data, regenerate secrets, restart
  services) **without changing anything on disk**. Safe to run any time,
  as often as you like.
- `./setup.sh --reset` — a **real** factory reset. Deletes all personal
  data (Mealie token, meal history, Streams library/profiles/uploaded
  files) and regenerates fresh secrets. Only run this if you actually mean
  to wipe the instance back to a blank state.

## Known issues / troubleshooting

These are real problems hit during development — included here so you don't
have to rediscover them.

**`apt` fails with `getaddrinfo (16: Device or resource busy)`**
Usually means `/etc/resolv.conf` is a dangling symlink to
`systemd-resolved`'s stub file while that service is masked or inactive.
Fix: point `/etc/resolv.conf` at a real resolver directly (e.g. `127.0.0.1`
if Pi-hole is already up, with a public DNS server as fallback).

**Pulling the Mealie image fails with TLS/certificate or `httpReadSeeker`
errors**
This has been an intermittent issue with GitHub Container Registry's CDN
edge, not your setup. Workaround: pull from the community Docker Hub
mirror instead:
```bash
docker pull hkotel/mealie
```

**`docker pull` intermittently fails on small blobs (e.g. image config),
especially on slow connections**
Can be a containerd race condition with signed CDN URLs expiring before
small layers get fetched, especially while larger layers are also
downloading. Mitigate by limiting concurrent downloads in
`/etc/docker/daemon.json`:
```json
{ "max-concurrent-downloads": 1 }
```
Then `systemctl restart docker`.

**YouTube links in Streams stop fetching metadata**
YouTube changes its extraction methods periodically (an ongoing
cat-and-mouse process). If `yt-dlp` starts failing, the distro-packaged
version is likely stale. Install the self-updating standalone binary
instead of relying on `apt`:
```bash
curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
chmod +x /usr/local/bin/yt-dlp
```

**Large file pastes over SSH corrupt files (wrong indentation, dropped
lines)**
This affects both `nano` (auto-indent mangles pasted tabs/spaces) and
sometimes terminal-buffered `cat` heredocs on large pastes. For anything
non-trivial, prefer `scp`-ing a file from a local machine over pasting
directly into a remote terminal. If you do paste, verify the result with
`wc -l` and a content spot-check (e.g. `grep` for expected lines) rather
than assuming it landed intact.

**nginx can't reach the host-level trigger service**
`host.docker.internal` and other hostnames won't resolve in `proxy_pass`
directives — nginx's resolver doesn't read `/etc/hosts`, and any
`proxy_pass` containing a variable forces per-request DNS resolution that
silently fails on hostnames. This is why `nginx.conf`'s template uses the
literal Docker bridge gateway IP (`172.17.0.1`) instead — this is
intentional, not a placeholder to change.

## Getting help

If something in this guide doesn't match what you're seeing, check:
1. `docker compose ps` — are all containers `Up`/`healthy`?
2. `systemctl status mealie-trigger.service` — is the host service running?
3. `docker compose logs <service>` — for container-specific errors
4. `journalctl -u mealie-trigger.service -n 50 --no-pager` — for host
   service errors
