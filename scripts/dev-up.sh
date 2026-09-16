#!/bin/bash
# dev-up.sh -- LOCAL TEST ONLY, for a real Linux machine. One command:
#   sudo bash scripts/dev-up.sh
# Bind-mounts this working copy to /root (only on the very first run),
# starts trigger_server.py, brings up docker compose, waits for nginx to
# actually answer, then opens the dashboard in the default browser.
#
# Why this needs real Linux, not plain Windows: system_status.py shells
# out to uptime/free/df/systemctl/journalctl (Linux-only), and
# trigger_server.py, syncthing_client.py, updater.py, and setup.sh all
# hardcode /root as the install path (sys.path.insert(0, "/root/scripts"),
# etc.) -- see updater.py's module docstring for the fullest explanation
# of why. A genuine Linux Docker install gives you a real Docker bridge
# (172.17.0.1, same as nginx's template already hardcodes) and real
# systemd/journalctl, so nothing in docker-compose.yml or the nginx
# config needs touching. (WSL2 can technically work the same way -- a
# real Linux kernel underneath -- but getting a clean WSL2 distro set up
# has enough of its own unrelated Windows-side friction that it's not
# assumed here as the primary path; this script itself doesn't care
# which kind of Linux it's running on.)
#
# The bind mount (rather than a separate clone) means there's one working
# copy to edit -- edit here, test there, push when happy. It only needs
# redoing after a reboot (bind mounts don't survive that); re-running
# this same script detects it's already mounted and just skips straight
# to starting things up.
#
# What won't match a real deployment, and why that's OK for testing app
# behavior:
#   - Host Services (mealie-trigger/icecast2/tailscaled) will show
#     inactive/unknown -- none of them are installed as real systemd
#     units here. trigger_server.py itself is still genuinely running
#     (started below, not via systemd) and every actual API call works;
#     only that one status card's display is cosmetically wrong.
#   - No real CPU temp sensor (/sys/class/thermal/... won't exist), so
#     that field will just be blank -- collect_basics() already handles
#     a missing sensor gracefully.
#   - Syncthing/Mealie/Kanboard/Pi-hole all run for real (they're plain
#     Docker images with no host-specific assumptions), so those panels
#     behave identically to production.
set -e

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ "$SOURCE_DIR" != "/root" ]; then
    if ! mountpoint -q /root 2>/dev/null; then
        echo "Bind-mounting $SOURCE_DIR to /root (every script here hardcodes /root as the install path)..."
        sudo mount --bind "$SOURCE_DIR" /root
    fi
    # Continue as if invoked from /root, in this same run -- /root is now
    # this exact directory, so its copy of this script is identical.
    exec sudo bash /root/scripts/dev-up.sh
fi

cd /root

if [ ! -f .env ]; then
    echo "No .env found -- generating one from .env.example with local-only placeholder values."
    echo "(This is a throwaway dev instance reachable only from this machine, not a secret worth protecting.)"
    cp .env.example .env
    sed -i 's/^HOST_IP=.*/HOST_IP=127.0.0.1/' .env
    sed -i 's/^TRIGGER_SECRET=.*/TRIGGER_SECRET=dev-local-only/' .env
fi

echo "Stopping any previous dev trigger_server.py..."
pkill -f "python3 .*trigger_server.py" 2>/dev/null || true

echo "Starting trigger_server.py in the background (log: /root/dev-trigger.log)..."
nohup python3 scripts/trigger_server.py > dev-trigger.log 2>&1 &
disown
echo "trigger_server.py PID: $!"

echo "Bringing up the Docker stack..."
docker compose up -d

echo "Waiting for the dashboard to actually respond..."
if command -v curl >/dev/null 2>&1; then
    for i in $(seq 1 30); do
        if curl -sf -o /dev/null http://localhost/; then
            echo "Up after ~${i}s."
            break
        fi
        sleep 1
    done
else
    sleep 8 # no curl to poll with -- a fixed wait is a reasonable fallback
fi

echo ""
echo "== Dashboard: http://localhost/ =="
echo "Logs: tail -f /root/dev-trigger.log"
echo "Stop everything: docker compose down && pkill -f trigger_server.py"

# xdg-open is the standard way to open a URL in the desktop's default
# browser on Linux -- a no-op (harmlessly failing, caught below) on a
# headless box with no desktop environment, where there's nothing to pop
# up anyway and the URL printed above is all that's actually needed.
if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "http://localhost/" >/dev/null 2>&1 || true
fi
