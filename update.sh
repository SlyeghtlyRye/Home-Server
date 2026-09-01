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
set +e
python3 scripts/check_env_updates.py
env_check_status=$?
set -e
if [ "$env_check_status" != "0" ] && [ "$env_check_status" != "2" ]; then
    echo "ERROR: checking for new config values failed (exit $env_check_status)."
    exit 1
fi
env_added_flag=""
if [ "$env_check_status" = "2" ]; then
    env_added_flag="--env-added"
fi

echo ""
echo "== Regenerating docs index and architecture map =="
python3 scripts/generate_docs_index.py
python3 scripts/generate_architecture_map.py

echo ""
echo "== Restart plan =="
eval "$(python3 scripts/updater.py plan "$LOCAL" "$REMOTE" $env_added_flag)"
if [ "$NEEDS_COMPOSE_FULL" = "1" ]; then
    echo "  - All Docker containers (pihole, kanboard, nginx, mealie)"
elif [ "$NEEDS_NGINX_ONLY" = "1" ]; then
    echo "  - nginx container only"
fi
if [ "$NEEDS_TRIGGER" = "1" ]; then
    echo "  - mealie-trigger.service"
fi
if [ "$NEEDS_COMPOSE_FULL" = "0" ] && [ "$NEEDS_NGINX_ONLY" = "0" ] && [ "$NEEDS_TRIGGER" = "0" ]; then
    echo "  - Nothing -- only static frontend files changed (dashboard.html, js/, docs/)."
    echo "    They're served straight off disk, live on your next browser refresh."
fi

echo ""
read -rp "Restart plan above -- [a]ccept, [c]ustomize, or [s]kip restarting entirely? [a/c/s] " restart_choice

case "$restart_choice" in
    c|C)
        echo ""
        echo "Which containers should be recreated? Space-separated, from:"
        echo "  pihole kanboard nginx mealie"
        echo "(type 'all' for every container, or leave blank for none)"
        read -rp "> " chosen_containers
        read -rp "Restart mealie-trigger.service? [y/N] " restart_trigger_choice

        if [ -n "$chosen_containers" ]; then
            echo ""
            echo "== Restarting containers =="
            if [ "$chosen_containers" = "all" ]; then
                docker compose up -d --force-recreate
            else
                docker compose up -d --force-recreate $chosen_containers
            fi
        fi
        if [[ "$restart_trigger_choice" =~ ^[Yy]$ ]]; then
            echo ""
            echo "== Restarting mealie-trigger.service =="
            systemctl restart mealie-trigger.service
        fi
        ;;
    s|S)
        echo "Skipping restart -- remember to restart the affected service(s) yourself if needed."
        ;;
    *)
        if [ "$NEEDS_COMPOSE_FULL" = "1" ]; then
            echo ""
            echo "== Restarting all containers =="
            docker compose up -d --force-recreate
        elif [ "$NEEDS_NGINX_ONLY" = "1" ]; then
            echo ""
            echo "== Restarting nginx container =="
            docker compose up -d --force-recreate nginx
        fi
        if [ "$NEEDS_TRIGGER" = "1" ]; then
            echo ""
            echo "== Restarting mealie-trigger.service =="
            systemctl restart mealie-trigger.service
        fi
        ;;
esac

echo ""
HOST_IP=$(grep '^HOST_IP=' .env 2>/dev/null | cut -d= -f2)
echo "Update complete. Dashboard: http://${HOST_IP:-<your-device-ip>}/"
