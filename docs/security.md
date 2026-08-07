tags: security, network, infra

# Security

An honest account of how this system is secured, and where its real
limits are -- written for someone deciding whether to trust it, not to
make it sound more locked-down than it is.

## What protects it

- **Every backend request requires a secret.** `trigger_server.py`
  rejects any request without a matching `TRIGGER_SECRET` -- a fresh
  random value generated per install, never shared, never committed.
- **Secrets never enter git.** `.env`, `mealie_token.txt`, and every
  personal data file are excluded via `.gitignore` from the very first
  commit -- verified, not just assumed (see `docs/config-and-setup.md`).
- **nginx is the only ingress point.** Every container and host service
  sits behind it; nothing else is directly reachable from outside the
  device except through nginx's routing.
- **Remote access goes through Tailscale**, a real WireGuard-based VPN
  mesh -- not an exposed port forward. Nothing on this device is meant to
  be reachable from the open internet directly.
- **No cloud dependency.** Meal plans, Streams history, DNS logs -- all of
  it stays on the device. Nothing is sent to a third-party service as
  part of normal operation.

## Known limitation: no TLS on the LAN-facing side

Traffic between your browser and nginx is plain HTTP, not HTTPS, on the
local network. This is a real gap, not an oversight glossed over: for a
single-household LAN behind your own router, the practical risk is low,
but it does mean the `TRIGGER_SECRET` and any data in transit are visible
to anything else that can see LAN traffic (e.g. a compromised device on
the same network). Adding TLS (even a self-signed cert) is a reasonable
future improvement, not yet implemented.

## Factory Reset and secrets

A real Factory Reset (via the System panel or `setup.sh --reset`)
generates entirely new secrets -- the old `TRIGGER_SECRET` and Pi-hole
password stop working immediately once `.env` is rewritten. This is
useful both for periodic rotation and for handing the device to someone
else with confidence nothing from the previous owner still works.

## What this setup does *not* protect against

- A compromised device already on your LAN can reach everything nginx
  exposes -- there's no additional per-device authentication beyond the
  shared secret.
- This isn't hardened against a sophisticated attacker with LAN access;
  it's designed for a trusted home network, not a hostile one.
