"""
config.py -- single source of truth for runtime configuration.
Reads .env (path overridable via ENV_FILE) with plain stdlib parsing.
No third-party dependencies.
"""
import os

ENV_FILE = os.environ.get("ENV_FILE", "/root/.env")


def _load_env(path):
    values = {}
    if not os.path.exists(path):
        return values
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            values[key.strip()] = value.strip().strip('"').strip("'")
    return values


_env = _load_env(ENV_FILE)


def get(key, default=None, required=False):
    value = os.environ.get(key, _env.get(key, default))
    if required and value is None:
        raise RuntimeError(f"Missing required config value: {key}")
    return value


HOST_IP = get("HOST_IP", required=True)
TIMEZONE = get("TIMEZONE", "UTC")
TRIGGER_SECRET = get("TRIGGER_SECRET", required=True)
PIHOLE_WEBPASSWORD = get("PIHOLE_WEBPASSWORD", required=True)
MEALIE_TOKEN_FILE = get("MEALIE_TOKEN_FILE", "/root/scripts/mealie_token.txt")
