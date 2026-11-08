"""
storage_watchdog.py -- auto-recovers containers from transient storage
read corruption.

Root cause this exists for (diagnosed 2026-11-08, see docs/system-panel.md
"Mealie 'bad marshal data' crash loops"): the root filesystem lives on a
USB flash drive (USB ID 346d:5678, "VendorCo ProductCode") that
intermittently returns WRONG BYTES on read without reporting any I/O
error. Scanning every .pyc in the Mealie image twice in a row, with the
page cache dropped in between, flagged a different set of "corrupt" files
on each pass -- the bytes on disk were fine, the reads weren't.

Why that turns into a multi-hour/multi-day crash loop instead of one
failed start: once a bad read lands in the kernel page cache, every
container restart is served the same bad bytes from RAM, never touching
the drive again. Docker's restart policy just replays the same failure
until memory pressure happens to evict that page.

So the recovery is: drop the page cache (forcing a fresh read from the
drive, which is overwhelmingly likely to come back correct), then
restart the container. This does NOT fix the drive -- replacing it with
a reputable SSD/USB drive is the real fix -- it just makes the failure
self-healing instead of needing a human.

Runs as a daemon thread inside trigger_server.py (already root, already
supervised by systemd). Events go to stdout, i.e. the mealie-trigger
journal, visible via the dashboard's service-logs button.
"""
import subprocess
import threading
import time

# Containers whose crash signature we know. Mealie is the only Python app
# server here, which is what makes the corruption show up as a clean,
# recognizable error instead of some vague misbehavior.
CONTAINERS = ("mealie",)

# Error text that can only come from corrupted file bytes, never from a
# config/code bug: a .pyc whose marshal payload doesn't parse, or a .py
# source file with NUL bytes in it.
SIGNATURES = (
    "bad marshal data",
    "source code string cannot contain null bytes",
)

CHECK_INTERVAL = 60       # seconds between checks
HEAL_COOLDOWN = 300       # min seconds between heals for one container
# If healing keeps being needed this often, the corruption is probably
# persistent (a bad write, not just a bad read) and dropping the cache
# can't fix it -- the image needs to be re-pulled.
ESCALATE_AFTER = 3        # heals...
ESCALATE_WINDOW = 3600    # ...within this many seconds

_last_heal = {}           # container -> unix time of last heal
_heal_history = {}        # container -> [unix times]
_started = False


def _log(msg):
    print(f"[storage-watchdog] {msg}", flush=True)


def _container_state(name):
    """Returns (status, restarting) or None if the container doesn't exist."""
    try:
        out = subprocess.run(
            ["docker", "inspect", "-f", "{{.State.Status}} {{.State.Restarting}}", name],
            capture_output=True, text=True, timeout=20,
        )
    except Exception:
        return None
    if out.returncode != 0:
        return None
    status, restarting = (out.stdout.split() + ["", ""])[:2]
    return status, restarting == "true"


def _recent_logs(name, since):
    out = subprocess.run(
        ["docker", "logs", "--since", str(int(since)), name],
        capture_output=True, text=True, timeout=30,
    )
    return out.stdout + out.stderr


def _drop_page_cache():
    # sync first so dirty pages are written out rather than discarded;
    # "1" = page cache only (dentries/inodes are irrelevant here).
    subprocess.run(["sync"], timeout=120)
    with open("/proc/sys/vm/drop_caches", "w") as f:
        f.write("1\n")


def check_once(now=None):
    now = now or time.time()
    for name in CONTAINERS:
        state = _container_state(name)
        if state is None:
            continue
        status, restarting = state
        # A container someone deliberately stopped (dashboard Stop
        # button, `docker compose stop`) stays stopped -- only act on one
        # that's running or being restarted by its restart policy.
        if status not in ("running", "restarting") and not restarting:
            continue

        last = _last_heal.get(name, 0)
        if now - last < HEAL_COOLDOWN:
            continue

        # Only look at logs newer than the last heal, so the errors that
        # triggered the previous heal can't trigger another one.
        since = max(now - CHECK_INTERVAL * 2, last)
        logs = _recent_logs(name, since)
        hit = next((s for s in SIGNATURES if s in logs), None)
        if not hit:
            continue

        _log(f"{name}: found '{hit}' in recent logs -- storage returned "
             f"corrupted bytes. Dropping page cache and restarting {name}.")
        try:
            _drop_page_cache()
        except Exception as e:
            _log(f"failed to drop page cache: {e}")
        try:
            subprocess.run(["docker", "restart", name], check=True,
                           capture_output=True, timeout=60)
        except Exception as e:
            _log(f"failed to restart {name}: {e}")
        _last_heal[name] = now

        history = [t for t in _heal_history.get(name, []) if now - t < ESCALATE_WINDOW]
        history.append(now)
        _heal_history[name] = history
        if len(history) >= ESCALATE_AFTER:
            _log(f"{name}: healed {len(history)} times in the last hour -- the "
                 f"corruption may now be persistent on disk. Re-pull the image "
                 f"(docker compose rm -sf {name} && docker rmi <image> && "
                 f"docker compose up -d {name}) and replace the USB drive.")


def _loop():
    _log(f"started (watching: {', '.join(CONTAINERS)})")
    while True:
        try:
            check_once()
        except Exception as e:
            _log(f"check failed: {e}")
        time.sleep(CHECK_INTERVAL)


def start():
    """Idempotent -- safe to call more than once."""
    global _started
    if _started:
        return
    _started = True
    threading.Thread(target=_loop, name="storage-watchdog", daemon=True).start()
