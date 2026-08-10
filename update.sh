#!/bin/bash
# update.sh -- pulls the latest version of this repo and applies it safely.
# Personal data and secrets are gitignored, so a plain "git pull" is safe
# on its own -- this script adds the parts that aren't automatic: checking
# for new required config values, regenerating generated files, and
# restarting the right services.
set -e

REPO_ROOT="/root"
cd "$REPO_ROOT"

echo "== Checking for updates =="

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "ERROR: /root is not a git repository."
    exit 1
fi

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    echo "WARNING: You have local changes to tracked files:"
    git status --short --untracked-files=no
    read -rp "Continue anyway? Local changes could conflict with the update. [y/N] " confirm
    if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
        echo "Aborted."
        exit 1
    fi
fi

git fetch origin

LOCAL=$(git rev-parse @)
REMOTE=$(git rev-parse @{u})

if [ "$LOCAL" = "$REMOTE" ]; then
    echo "Already up to date."
    exit 0
fi

echo ""
echo "Changes since your last update:"
git log --oneline "$LOCAL..$REMOTE"
echo ""
read -rp "Pull and apply these changes? [y/N] " confirm
if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
    echo "Aborted -- nothing changed."
    exit 0
fi

echo ""
echo "== Pulling =="
git pull --ff-only origin main

echo ""
echo "== Checking for new required config values =="
python3 scripts/check_env_updates.py

echo ""
echo "== Regenerating docs index and architecture map =="
python3 scripts/generate_docs_index.py
python3 scripts/generate_architecture_map.py

echo ""
echo "== Restarting services =="
docker compose up -d --force-recreate
systemctl restart mealie-trigger.service

echo ""
HOST_IP=$(grep '^HOST_IP=' .env 2>/dev/null | cut -d= -f2)
echo "Update complete. Dashboard: http://${HOST_IP:-<your-device-ip>}/"
