"""
updater.py -- shared logic for checking and applying updates from GitHub.
Used by both a future CLI flow and the dashboard's Check/Install buttons,
so they can never drift out of sync.

Design note: applying an update deliberately never restarts anything
synchronously inside the request that served it -- doing that from inside
a request being served BY nginx is fragile (the connection would likely
drop mid-restart). Instead it diffs the pulled commit range and schedules
only the restart(s) that diff actually requires, fully detached in the
background:
  - static files (dashboard.html, js/, docs/) need nothing -- nginx serves
    them straight off disk via bind mount, live on next browser refresh.
  - scripts/ or audiobooks/ changes restart mealie-trigger.service only.
  - nginx.conf / nginx/templates changes recreate just the nginx container.
  - docker-compose.yml changes (or anything unrecognized) fall back to
    recreating every container plus the trigger service, same as before
    this file could tell the difference.
See _classify_restart() for the actual rules.
"""
import os
import subprocess

ROOT = "/root"


def _run(cmd, check=True):
    return subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, check=check)


def get_local_commit():
    result = _run(["git", "rev-parse", "HEAD"])
    return result.stdout.strip()


def get_remote_commit():
    _run(["git", "fetch", "origin"])
    result = _run(["git", "rev-parse", "@{u}"])
    return result.stdout.strip()


def get_commit_log(local, remote):
    if local == remote:
        return []
    result = _run(["git", "log", "--oneline", f"{local}..{remote}"])
    return [line for line in result.stdout.strip().split("\n") if line]


def get_changed_files(local, remote):
    if local == remote:
        return []
    result = _run(["git", "diff", "--name-only", f"{local}..{remote}"])
    return [line for line in result.stdout.strip().split("\n") if line]


def has_local_changes():
    result = _run(["git", "status", "--porcelain", "--untracked-files=no"])
    return bool(result.stdout.strip())


def check_for_update():
    local = get_local_commit()
    remote = get_remote_commit()
    commits = get_commit_log(local, remote)
    return {
        "update_available": local != remote,
        "current_commit": local[:8],
        "remote_commit": remote[:8],
        "commits": commits,
        "has_local_changes": has_local_changes(),
    }


def _auto_fill_new_env_values(log_lines):
    """Non-interactive counterpart to check_env_updates.py -- used when
    applying from the dashboard, where there's no terminal to prompt.
    Any newly-added config key gets its .env.example default value
    written directly, with a clear note in the log so the person knows
    to review it."""
    env_file = os.path.join(ROOT, ".env")
    example_file = os.path.join(ROOT, ".env.example")

    def parse(path):
        values = {}
        if not os.path.exists(path):
            return values
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                values[key.strip()] = value.strip()
        return values

    example_values = parse(example_file)
    current_values = parse(env_file)
    missing = [k for k in example_values if k not in current_values]

    if not missing:
        log_lines.append("No new config values needed.")
        return False

    new_lines = [f"{k}={example_values[k]}" for k in missing]
    with open(env_file, "a") as f:
        f.write("\n" + "\n".join(new_lines) + "\n")
    log_lines.append(
        f"Added {len(missing)} new config value(s) using defaults: "
        f"{', '.join(missing)} -- review .env and adjust if needed."
    )
    return True


# Path prefixes/exact names that nginx serves straight off disk via bind
# mount (see docker-compose.yml) -- these need no restart at all, the
# change is live on the next browser refresh.
_STATIC_FILES = {"dashboard.html"}
_STATIC_PREFIXES = ("js/", "docs/")

# Anything trigger_server.py imports, directly or transitively, lives under
# one of these two directories -- a change here needs mealie-trigger.service
# restarted, but never touches Docker at all (the containers run pinned
# images, not code from this repo).
_BACKEND_PREFIXES = ("scripts/", "audiobooks/")

# nginx.conf and nginx/templates/* are bind-mounted into the nginx container
# read-only -- it doesn't hot-reload them, so only that one container needs
# recreating, not the other three.
_NGINX_FILES = {"nginx.conf"}
_NGINX_PREFIXES = ("nginx/",)

# docker-compose.yml itself can change any service's image/env/ports, so a
# change here can't be scoped -- recreate everything, same as before.
_COMPOSE_FILES = {"docker-compose.yml"}


def _classify_restart(changed_files, env_keys_added):
    """Figures out the smallest restart that actually covers a given diff,
    instead of always force-recreating every container plus the trigger
    service. Any path this doesn't recognize (README.md, setup.sh, a brand
    new top-level file/dir, etc.) falls back to restarting everything --
    this can only ever be as safe as the old blanket restart, never less."""
    needs_trigger = False
    needs_compose_full = False
    needs_nginx_only = False

    if env_keys_added:
        # docker-compose interpolates .env values at "up" time, and any
        # container could be the one consuming a newly-added key -- don't
        # try to guess which.
        needs_compose_full = True
        needs_trigger = True

    for path in changed_files:
        if path in _STATIC_FILES or path.startswith(_STATIC_PREFIXES):
            continue
        if path.startswith(_BACKEND_PREFIXES):
            needs_trigger = True
        elif path in _COMPOSE_FILES:
            needs_compose_full = True
        elif path in _NGINX_FILES or path.startswith(_NGINX_PREFIXES):
            needs_nginx_only = True
        else:
            needs_compose_full = True
            needs_trigger = True

    return {
        "trigger": needs_trigger,
        "compose_full": needs_compose_full,
        "nginx_only": needs_nginx_only and not needs_compose_full,
    }


def _describe_restart_plan(plan):
    if not plan["trigger"] and not plan["compose_full"] and not plan["nginx_only"]:
        return ("Only static frontend files changed -- nothing to restart. "
                "Refresh the dashboard to see the update.")
    parts = []
    if plan["compose_full"]:
        parts.append("all containers")
    elif plan["nginx_only"]:
        parts.append("the nginx container")
    if plan["trigger"]:
        parts.append("the trigger service")
    return (
        f"Restarting {' and '.join(parts)} in the background -- give it "
        "about 15 seconds, then refresh the dashboard."
    )


def apply_update():
    log_lines = []

    if has_local_changes():
        return {
            "status": "error",
            "message": "There are uncommitted local changes -- resolve those "
                       "first (commit or discard them) before updating.",
        }

    local_before = get_local_commit()
    remote = get_remote_commit()

    if local_before == remote:
        return {"status": "ok", "message": "Already up to date.", "log": ["Already up to date."]}

    changed_files = get_changed_files(local_before, remote)

    log_lines.append(f"Pulling changes ({local_before[:8]} -> {remote[:8]})...")
    _run(["git", "pull", "--ff-only", "origin", "main"])
    log_lines.append("Pulled successfully.")

    env_keys_added = _auto_fill_new_env_values(log_lines)

    log_lines.append("Regenerating docs index and architecture map...")
    _run(["python3", "scripts/generate_docs_index.py"])
    _run(["python3", "scripts/generate_architecture_map.py"])
    log_lines.append("Regenerated.")

    restart_plan = _classify_restart(changed_files, env_keys_added)
    log_lines.append(_describe_restart_plan(restart_plan))
    _schedule_background_restart(restart_plan)

    return {"status": "ok", "message": "Update applied.", "log": log_lines}


def _schedule_background_restart(plan):
    """Restarts only what `plan` says needs it, a few seconds after this
    function returns, fully detached from the current request. This lets
    the browser get its response first, so the connection isn't cut off
    mid-restart -- the same risk we avoid everywhere else nginx/the trigger
    service would otherwise be asked to restart themselves mid-request."""
    if not plan["trigger"] and not plan["compose_full"] and not plan["nginx_only"]:
        return

    steps = []
    if plan["compose_full"]:
        steps.append("docker compose up -d --force-recreate")
    elif plan["nginx_only"]:
        steps.append("docker compose up -d --force-recreate nginx")
    if plan["trigger"]:
        steps.append("systemctl restart mealie-trigger.service")

    restart_script = "sleep 5 && cd /root && " + " && ".join(steps)
    subprocess.Popen(
        ["setsid", "bash", "-c", restart_script],
        cwd=ROOT,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        stdin=subprocess.DEVNULL,
        start_new_session=True,
    )


if __name__ == "__main__":
    import sys

    # `python3 scripts/updater.py plan <local> <remote> [--env-added]` --
    # exposes _classify_restart() to update.sh (bash) as NAME=0/1 lines it
    # can `eval` directly, so the CLI's recommended restart plan can never
    # drift from what the dashboard's Install Update button computes.
    if len(sys.argv) >= 4 and sys.argv[1] == "plan":
        local_arg, remote_arg = sys.argv[2], sys.argv[3]
        env_added_arg = "--env-added" in sys.argv[4:]
        plan = _classify_restart(get_changed_files(local_arg, remote_arg), env_added_arg)
        print(f"NEEDS_TRIGGER={'1' if plan['trigger'] else '0'}")
        print(f"NEEDS_COMPOSE_FULL={'1' if plan['compose_full'] else '0'}")
        print(f"NEEDS_NGINX_ONLY={'1' if plan['nginx_only'] else '0'}")
    else:
        print("Usage: updater.py plan <local-commit> <remote-commit> [--env-added]", file=sys.stderr)
        sys.exit(1)
