tags: architecture, infra, network, security

# Architecture Map

A full picture of how every real piece of this system connects — client,
network, containers, host scripts, and frontend modules.

![Architecture diagram](docs/architecture-map.svg)

## How this stays accurate

This diagram is **generated**, not hand-drawn. The real source of truth is
`docs/architecture-map.py` -- a small structured list of components and
connections. `scripts/generate_architecture_map.py` reads that file and:

1. Renders it into the SVG shown above
2. Cross-checks it against the actual codebase (`docker-compose.yml`
   services, every file in `js/`, every file in `scripts/`) and **warns
   you if something real has no entry in the map** -- so a forgotten
   update doesn't silently go unnoticed.

## Updating this after adding a feature

1. Add your new component to `docs/architecture-map.py` (one small
   dictionary entry, plus an edge showing what it talks to)
2. Run:
```bash
   python3 scripts/generate_architecture_map.py
```
3. If it prints a warning listing anything else missing, add those too --
   it means something in this checklist has quietly fallen out of sync,
   and this is the moment to catch it.

## Layers, top to bottom

- **Client** -- the browser
- **Network / Proxy** -- nginx, the single entry point for everything
- **Docker Containers** -- Pi-hole, Mealie, Kanboard, nginx itself
- **Host Scripts** -- `trigger_server.py` and everything it calls, running
  directly on the Pi (not in Docker)
- **Frontend Modules** -- the `js/` ES modules that make up the dashboard
