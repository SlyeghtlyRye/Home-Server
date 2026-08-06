"""
reset_manager.py -- shared logic for first-time setup and factory reset.

Both real setup/reset and the dry-run simulator ("Fake Factory Reset") walk
the exact same list of actions below, so the simulator can never drift out
of sync with what a real run actually does. Each action is (description,
function). In dry-run mode, functions are not called -- only descriptions
are printed.
"""
import argparse
import os
import secrets as secrets_module
import shutil
import subprocess

ROOT = "/root"
ENV_FILE = os.path.join(ROOT, ".env")
ENV_EXAMPLE = os.path.join(ROOT, ".env.example")

# Files considered "personal data" -- removed on a real Factory Reset.
RESET_TARGETS = [
    "scripts/mealie_token.txt",
    "scripts/meal_history.json",
    "audiobooks/library.json",
    "audiobooks/profiles.json",
    "audiobooks/config.json",
    "audiobooks/local_progress.json",
    "audiobooks/local_shared.json",
    "audiobooks/state.json",
    "audiobooks/local_files",
    ".env",
]


def generate_secret():
    return secrets_module.token_hex(24)


def write_env(host_ip, timezone, dry_run):
    secret = generate_secret()
    pihole_pw = secrets_module.token_urlsafe(12)
    content = (
        f"HOST_IP={host_ip}\n"
        f"TIMEZONE={timezone}\n"
        f"TRIGGER_SECRET={secret}\n"
        f"PIHOLE_WEBPASSWORD={pihole_pw}\n"
        f"MEALIE_TOKEN_FILE=/root/scripts/mealie_token.txt\n"
    )
    if dry_run:
        print(f"[dry-run] would write {ENV_FILE} with a freshly generated "
              f"TRIGGER_SECRET and PIHOLE_WEBPASSWORD (values hidden)")
        return
    with open(ENV_FILE, "w") as f:
        f.write(content)
    os.chmod(ENV_FILE, 0o600)
    print(f"Wrote {ENV_FILE}")


def remove_personal_data(dry_run):
    for rel_path in RESET_TARGETS:
        full = os.path.join(ROOT, rel_path)
        exists = os.path.exists(full)
        if dry_run:
            state = "would delete" if exists else "would skip (not present)"
            print(f"[dry-run] {state}: {rel_path}")
            continue
        if not exists:
            continue
        if os.path.isdir(full):
            shutil.rmtree(full)
        else:
            os.remove(full)
        print(f"Removed {rel_path}")


def bring_up_stack(dry_run):
    if dry_run:
        print("[dry-run] would run: docker compose up -d --force-recreate")
        return
    subprocess.run(
        ["docker", "compose", "up", "-d", "--force-recreate"],
        cwd=ROOT, check=True,
    )


def restart_trigger_service(dry_run):
    if dry_run:
        print("[dry-run] would run: systemctl restart mealie-trigger.service")
        return
    subprocess.run(
        ["systemctl", "restart", "mealie-trigger.service"], check=True,
    )


def run_setup(host_ip, timezone, dry_run):
    print(f"{'[DRY RUN] ' if dry_run else ''}Setting up...")
    write_env(host_ip, timezone, dry_run)
    bring_up_stack(dry_run)
    restart_trigger_service(dry_run)
    print(f"{'[DRY RUN] ' if dry_run else ''}Setup complete.")


def run_reset(host_ip, timezone, dry_run):
    print(f"{'[DRY RUN] ' if dry_run else ''}Factory reset starting...")
    remove_personal_data(dry_run)
    write_env(host_ip, timezone, dry_run)
    bring_up_stack(dry_run)
    restart_trigger_service(dry_run)
    print(f"{'[DRY RUN] ' if dry_run else ''}Factory reset complete.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Setup / factory reset for the dashboard system.")
    parser.add_argument("--reset", action="store_true", help="Factory reset instead of first-time setup")
    parser.add_argument("--dry-run", action="store_true", help="Simulate only, change nothing")
    parser.add_argument("--host-ip", required=True)
    parser.add_argument("--timezone", required=True)
    args = parser.parse_args()

    if args.reset:
        run_reset(args.host_ip, args.timezone, args.dry_run)
    else:
        run_setup(args.host_ip, args.timezone, args.dry_run)
