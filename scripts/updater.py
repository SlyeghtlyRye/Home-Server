"""
updater.py -- shared logic for checking and applying updates from GitHub.
Used by both a future CLI flow and the dashboard's Check/Install buttons,
so they can never drift out of sync.

Design note: applying an update deliberately does NOT restart nginx or
Docker containers itself -- doing that from inside a request being served
BY nginx is fragile (the connection would likely drop mid-restart). Static
files (js/, docs/) take effect immediately on next browser refresh since
nginx serves them straight from disk. Backend code and container changes
need a manual restart, same pattern as Factory Reset.
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
        return

    new_lines = [f"{k}={example_values[k]}" for k in missing]
    with open(env_file, "a") as f:
        f.write("\n" + "\n".join(new_lines) + "\n")
    log_lines.append(
        f"Added {len(missing)} new config value(s) using defaults: "
        f"{', '.join(missing)} -- review .env and adjust if needed."
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

    log_lines.append(f"Pulling changes ({local_before[:8]} -> {remote[:8]})...")
    _run(["git", "pull", "--ff-only", "origin", "main"])
    log_lines.append("Pulled successfully.")

    _auto_fill_new_env_values(log_lines)

    log_lines.append("Regenerating docs index and architecture map...")
    _run(["python3", "scripts/generate_docs_index.py"])
    _run(["python3", "scripts/generate_architecture_map.py"])
    log_lines.append("Regenerated.")

    log_lines.append(
        "Restarting services in the background -- give it about 15 seconds, "
        "then refresh the dashboard."
    )
    _schedule_background_restart()

    return {"status": "ok", "message": "Update applied.", "log": log_lines}


def _schedule_background_restart():
    """Restarts containers and the trigger service a few seconds after this
    function returns, fully detached from the current request. This lets
    the browser get its response first, so the connection isn't cut off
    mid-restart -- the same risk we avoid everywhere else nginx/the trigger
    service would otherwise be asked to restart themselves mid-request."""
    restart_script = (
        "sleep 5 && "
        "cd /root && docker compose up -d --force-recreate && "
        "systemctl restart mealie-trigger.service"
    )
    subprocess.Popen(
        ["setsid", "bash", "-c", restart_script],
        cwd=ROOT,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        stdin=subprocess.DEVNULL,
        start_new_session=True,
    )
