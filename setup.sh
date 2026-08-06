#!/bin/bash
# setup.sh -- first-time installer for the home dashboard system.
# Safe to re-run: use --reset for a real factory reset, or
# --reset --dry-run to simulate a reset without changing anything.
set -e

REPO_ROOT="/root"
cd "$REPO_ROOT"

RESET=false
DRY_RUN=false
for arg in "$@"; do
    case "$arg" in
        --reset) RESET=true ;;
        --dry-run) DRY_RUN=true ;;
        *) echo "Unknown option: $arg"; exit 1 ;;
    esac
done

echo "== Home Dashboard Setup =="

# --- Prerequisite checks ---
if ! command -v docker >/dev/null 2>&1; then
    echo "ERROR: Docker is not installed. Install Docker first, then re-run this script."
    exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
    echo "ERROR: 'docker compose' (v2 plugin) not found. Install the Docker Compose plugin."
    exit 1
fi

ARCH=$(uname -m)
echo "Detected architecture: $ARCH"

AVAILABLE_KB=$(df -k "$REPO_ROOT" | tail -1 | awk '{print $4}')
AVAILABLE_GB=$((AVAILABLE_KB / 1024 / 1024))
if [ "$AVAILABLE_GB" -lt 2 ]; then
    echo "WARNING: Less than 2GB free disk space detected ($AVAILABLE_GB GB). Continuing anyway."
fi

# --- Collect the values that genuinely differ per install ---
if [ "$DRY_RUN" = false ]; then
    read -rp "Enter this machine's LAN IP address [e.g. 192.168.0.201]: " HOST_IP
    read -rp "Enter your timezone [e.g. America/Edmonton]: " TIMEZONE
else
    # Dry run doesn't need real answers -- use placeholders just to walk the flow
    HOST_IP="192.168.0.201"
    TIMEZONE="America/Edmonton"
    echo "(dry run: using placeholder values $HOST_IP / $TIMEZONE)"
fi

# --- Hand off to reset_manager.py for the actual work ---
CMD="python3 $REPO_ROOT/scripts/reset_manager.py --host-ip $HOST_IP --timezone $TIMEZONE"
if [ "$RESET" = true ]; then
    CMD="$CMD --reset"
fi
if [ "$DRY_RUN" = true ]; then
    CMD="$CMD --dry-run"
fi

echo "Running: $CMD"
$CMD

if [ "$DRY_RUN" = false ]; then
    echo ""
    echo "Setup complete. Dashboard should be reachable at http://$HOST_IP/"
fi
