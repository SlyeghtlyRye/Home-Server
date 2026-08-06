tags: config, setup, infra

# Configuration & Setup System

Every machine-specific value (IP, secrets, timezone, passwords) lives in
`.env`, read by `scripts/config.py` (backend) and `js/config.js`
(frontend placeholder -- see TODO below). Nothing is hardcoded in
committed files.

## First-time setup

`setup.sh` checks prerequisites, prompts for the two values that genuinely
differ per install (IP, timezone), generates fresh secrets, and hands off
to `scripts/reset_manager.py` to write `.env` and bring up the stack.

## Factory reset / dry-run

`scripts/reset_manager.py` is the single source of truth for both setup
and reset -- one list of actions, executed for real or only printed
(`--dry-run`). This means the dry-run simulator can never drift out of
sync with what a real reset actually does, since they're the same code
path.

- `./setup.sh --reset --dry-run` -- safe to run anytime, changes nothing
- `./setup.sh --reset` -- real reset, deletes personal data and
  regenerates secrets

## Known TODO

`js/config.js` currently has `HOST_IP` hand-edited rather than generated
from `.env` like the backend config is. `setup.sh` should generate this
file during install rather than requiring a manual edit -- not yet
implemented.
