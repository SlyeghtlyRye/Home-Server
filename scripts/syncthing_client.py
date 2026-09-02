"""
syncthing_client.py -- talks to an existing Syncthing instance's REST API.
Syncthing itself is NOT part of this repo's docker-compose stack -- it's
assumed to already be running elsewhere on the network. Powers the
dashboard's Syncthing devices panel: connection status, sync completion,
pause/resume, and add/rename/remove devices.

Connection details (base URL + API key) live in a separate gitignored file
rather than .env, same reasoning as scripts/mealie_token.txt: .env is
wholesale-rewritten by reset_manager.py's write_env() on every setup/reset,
which would silently wipe anything else added to it.
"""
import json
import os
import requests

CONFIG_FILE = "/root/scripts/syncthing_config.json"


def get_config():
    if not os.path.exists(CONFIG_FILE):
        return None
    with open(CONFIG_FILE) as f:
        return json.load(f)


def save_config(url, api_key):
    config = {"url": url.rstrip("/"), "apiKey": api_key}
    with open(CONFIG_FILE, "w") as f:
        json.dump(config, f)
    os.chmod(CONFIG_FILE, 0o600)
    return config


def is_configured():
    config = get_config()
    return bool(config and config.get("url") and config.get("apiKey"))


def _require_config():
    config = get_config()
    if not config or not config.get("url") or not config.get("apiKey"):
        raise RuntimeError("Syncthing isn't configured yet -- add its URL and API key first.")
    return config


def get_headers(config=None):
    config = config or _require_config()
    return {"X-API-Key": config["apiKey"], "Content-Type": "application/json"}


def _check(resp):
    if not resp.ok:
        raise RuntimeError(f"Syncthing API error {resp.status_code}: {resp.text[:300]}")
    return resp


def _get(path, config, params=None):
    resp = requests.get(f"{config['url']}{path}", headers=get_headers(config), params=params, timeout=10)
    return _check(resp).json()


def _put(path, config, body):
    resp = requests.put(f"{config['url']}{path}", headers=get_headers(config), json=body, timeout=10)
    _check(resp)


def _post(path, config, params=None):
    resp = requests.post(f"{config['url']}{path}", headers=get_headers(config), params=params, timeout=10)
    _check(resp)


def _delete(path, config):
    resp = requests.delete(f"{config['url']}{path}", headers=get_headers(config), timeout=10)
    _check(resp)


def test_connection(url, api_key):
    """Used when saving new connection details -- fails loudly (via
    _check's RuntimeError) if the URL/key don't actually work, same
    validate-on-save pattern as the Mealie token."""
    config = {"url": url.rstrip("/"), "apiKey": api_key}
    return _get("/rest/system/status", config)


def get_devices():
    """Combines several Syncthing endpoints into one flat list the
    dashboard can render directly: identity + config from
    /rest/config/devices, live connection state from
    /rest/system/connections, last-seen from /rest/stats/device, and
    aggregate sync completion from /rest/db/completion -- Syncthing
    doesn't expose any single endpoint with all of this already joined."""
    config = _require_config()

    status = _get("/rest/system/status", config)
    my_id = status.get("myID")

    devices = _get("/rest/config/devices", config)
    connections = _get("/rest/system/connections", config).get("connections", {})
    stats = _get("/rest/stats/device", config)
    folders = _get("/rest/config/folders", config)

    folder_names_by_device = {}
    for f in folders:
        label = f.get("label") or f.get("id")
        for d in f.get("devices", []):
            folder_names_by_device.setdefault(d["deviceID"], []).append(label)

    result = []
    for d in devices:
        device_id = d["deviceID"]
        conn = connections.get(device_id, {})
        stat = stats.get(device_id, {})
        connected = bool(conn.get("connected"))

        completion_pct = None
        if connected:
            try:
                comp = _get("/rest/db/completion", config, params={"device": device_id})
                completion_pct = comp.get("completion")
            except (requests.RequestException, RuntimeError):
                completion_pct = None

        result.append({
            "id": device_id,
            "name": d.get("name") or device_id[:7],
            "isSelf": device_id == my_id,
            "paused": d.get("paused", False),
            "connected": connected,
            "address": conn.get("address"),
            "completion": completion_pct,
            "lastSeen": stat.get("lastSeen"),
            "folders": folder_names_by_device.get(device_id, []),
        })

    result.sort(key=lambda x: (not x["isSelf"], x["name"].lower()))
    return result


def pause_device(device_id):
    config = _require_config()
    _post("/rest/system/pause", config, params={"device": device_id})


def resume_device(device_id):
    config = _require_config()
    _post("/rest/system/resume", config, params={"device": device_id})


def add_device(device_id, name):
    config = _require_config()
    body = {"deviceID": device_id, "name": name or device_id[:7], "addresses": ["dynamic"]}
    _put(f"/rest/config/devices/{device_id}", config, body)


def rename_device(device_id, name):
    config = _require_config()
    device = _get(f"/rest/config/devices/{device_id}", config)
    device["name"] = name
    _put(f"/rest/config/devices/{device_id}", config, device)


def remove_device(device_id):
    config = _require_config()
    _delete(f"/rest/config/devices/{device_id}", config)
