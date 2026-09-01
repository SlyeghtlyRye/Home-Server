"""
check_env_updates.py -- compares .env.example against the real .env and
prompts for any new keys that don't exist yet. Run by update.sh after a
git pull, so a future update that adds a new required setting doesn't
silently crash the backend on an existing install -- it prompts once for
just the new value instead.

Exit code doubles as a signal to update.sh: 2 means new keys were added
(a hint that could matter for the container restart plan, since
docker-compose interpolates .env at "up" time), 0 means nothing changed.
"""
import os
import sys

ROOT = "/root"
ENV_FILE = os.path.join(ROOT, ".env")
ENV_EXAMPLE = os.path.join(ROOT, ".env.example")


def parse_env_file(path):
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


def main():
    example_values = parse_env_file(ENV_EXAMPLE)
    current_values = parse_env_file(ENV_FILE)

    missing_keys = [k for k in example_values if k not in current_values]

    if not missing_keys:
        print("No new config values needed.")
        return False

    print(f"{len(missing_keys)} new config value(s) needed since your last update:")
    new_lines = []
    for key in missing_keys:
        hint = example_values[key]
        value = input(f"  {key} (example: {hint}): ").strip()
        if not value:
            value = hint
        new_lines.append(f"{key}={value}")

    with open(ENV_FILE, "a") as f:
        f.write("\n" + "\n".join(new_lines) + "\n")

    print(f"Added {len(missing_keys)} new value(s) to .env.")
    return True


if __name__ == "__main__":
    sys.exit(2 if main() else 0)
