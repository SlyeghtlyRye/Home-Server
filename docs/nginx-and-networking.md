tags: infra, nginx

# nginx & Networking

nginx is the single entry point (port 80 and 443), reverse-proxying to
every container and to the host-level trigger server.

## HTTPS -- self-signed, regenerated per-device

There's no publicly-resolvable domain for an internal-only hostname like
`home.dashboard`, so a real CA-issued certificate (Let's Encrypt etc.)
isn't possible here -- the cert is self-signed instead.

- `scripts/reset_manager.py`'s `generate_self_signed_cert(host_ip, ...)`
  shells out to `openssl` (already present on every Debian-based image
  this project targets -- no new pip dependency) to write
  `nginx/certs/selfsigned.{crt,key}`, with a `subjectAltName` covering
  `home.dashboard`, `home.dashboard.local`, `home.dashboard.internal`,
  the current `HOST_IP`, and `127.0.0.1`. A cert with only a CN and no
  SAN is rejected outright by modern browsers, so SAN is required, not
  just nice-to-have.
- Wired into both `run_setup()` and `run_reset()`, same as
  `write_js_config()` -- regenerated unconditionally every time rather
  than checked for staleness, so a `HOST_IP` change always lands in the
  cert's IP SAN instead of leaving one that only matches the device's
  old address.
- `nginx/certs/` is gitignored (same category as `.env`, `js/config.js`
  -- machine-specific, generated, never committed) and mounted into the
  nginx container as a **directory**, not individual files -- a
  single-file bind mount can go stale when the host file is replaced
  rather than edited in place (the same issue `updater.py`'s own
  docstring documents for `dashboard.html`), which would matter a lot
  here since the cert gets rewritten whenever `HOST_IP` changes.
- **Self-signed means every browser shows a trust warning on first
  visit**, and iOS Safari in particular can still silently block
  background `fetch()`/XHR calls even after you click through that
  warning in the browser chrome -- this is deliberate browser security
  behavior, not something a server-side trick can bypass. The real fix
  per device: install the cert itself as a trusted profile. `GET
  /selfsigned.crt` (plain HTTP, `alias`'d straight at
  `nginx/certs/selfsigned.crt` -- the public cert only, never the
  private key) exists specifically so a phone can download it through
  Safari without needing SSH/file-transfer at all: open
  `http://home.dashboard/selfsigned.crt` in Safari -> Allow ->
  Settings -> **Profile Downloaded** -> Install -> enter passcode ->
  Settings -> General -> About -> Certificate Trust Settings -> enable
  full trust for it. One-time per device, after which it behaves
  exactly like a real cert.
- Not yet done on any already-set-up device -- a device that was set up
  before this existed needs a one-time manual catch-up (regenerate the
  cert without a full setup/reset, which would also touch other state):
  ```
  python3 -c "
  import sys
  sys.path.insert(0, '/root/scripts')
  import reset_manager
  reset_manager.generate_self_signed_cert(reset_manager.read_current_host_ip(), False, [])
  "
  ```
  followed by a full `docker compose up -d --force-recreate` (needed
  regardless, since `docker-compose.yml` itself changed -- the new 443
  port mapping and the certs volume mount only take effect on
  recreation, not a plain restart).

## Why the trigger server is reached via 172.17.0.1, not a hostname

nginx's `proxy_pass` resolver doesn't read `/etc/hosts`, and using a
variable in `proxy_pass` forces per-request DNS resolution that silently
fails on hostnames. The literal Docker bridge gateway IP sidesteps this
entirely. **This is intentional -- do not "fix" it to use a hostname.**

## Secret injection

`nginx/templates/default.conf.template` uses `${TRIGGER_SECRET}`, filled
in by nginx's built-in `envsubst` templating (via `docker-entrypoint.d/`)
at container startup, using the `TRIGGER_SECRET` environment variable
passed from `.env` through `docker-compose.yml`. The secret is never
written into any committed file.

## MIME types

`nginx.conf` explicitly includes `/etc/nginx/mime.types` -- without this,
`.js` files serve as `text/plain`, which browsers reject for ES modules
with a strict MIME-type error. Easy to lose if `nginx.conf` is ever
regenerated from scratch.
