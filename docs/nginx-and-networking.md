tags: infra, nginx

# nginx & Networking

nginx is the single entry point (port 80), reverse-proxying to every
container and to the host-level trigger server.

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
