"""
syncthing_client.py -- talks to one or more Syncthing instances' REST
APIs. Supports multiple simultaneous instances: a permanent "host" slot
(the Syncthing container in this repo's own docker-compose stack, always
listed even before it's configured) plus any number of externally-added
instances (e.g. a phone/handheld running Syncthing elsewhere on the
network). Powers the dashboard's Syncthing panel: connection status per
instance, sync completion, pause/resume, and add/rename/remove devices
and folders.

Connection details (base URL + API key) per instance live in a separate
gitignored file rather than .env, same reasoning as scripts/mealie_token.txt:
.env is wholesale-rewritten by reset_manager.py's write_env() on every
setup/reset, which would silently wipe anything else added to it.
"""
import json
import os
import re
import requests
from config import HOST_IP

CONFIG_FILE = "/root/scripts/syncthing_config.json"
HOST_INSTANCE_ID = "host"


def _load_raw():
    if not os.path.exists(CONFIG_FILE):
        return {"instances": {}}
    with open(CONFIG_FILE) as f:
        data = json.load(f)
    data.setdefault("instances", {})
    return data


def _save_raw(data):
    with open(CONFIG_FILE, "w") as f:
        json.dump(data, f)
    os.chmod(CONFIG_FILE, 0o600)


def default_host_url():
    return f"http://{HOST_IP}:8384"


def list_instances():
    """Always includes the pinned "host" slot, even before it's ever been
    configured -- the dashboard can show a placeholder + Connect prompt
    for it rather than the user needing to know it exists and add it
    themselves. Other instances only appear once explicitly added."""
    data = _load_raw()
    stored = data["instances"]
    result = []

    host = stored.get(HOST_INSTANCE_ID)
    result.append({
        "id": HOST_INSTANCE_ID,
        "label": "Host",
        "isHost": True,
        "configured": bool(host and host.get("url") and host.get("apiKey")),
        "url": (host or {}).get("url") or default_host_url(),
    })

    for instance_id, inst in stored.items():
        if instance_id == HOST_INSTANCE_ID:
            continue
        result.append({
            "id": instance_id,
            "label": inst.get("label", instance_id),
            "isHost": False,
            "configured": bool(inst.get("url") and inst.get("apiKey")),
            "url": inst.get("url"),
        })

    return result


def get_instance_config(instance_id):
    data = _load_raw()
    return data["instances"].get(instance_id)


def is_instance_configured(instance_id):
    config = get_instance_config(instance_id)
    return bool(config and config.get("url") and config.get("apiKey"))


def _slugify(label):
    slug = re.sub(r"[^a-z0-9]+", "-", label.strip().lower()).strip("-")
    return slug or "instance"


def add_instance(label, url, api_key):
    """Creates a new externally-added instance with an auto-generated ID
    (a slug of its label, de-duplicated if it collides). Returns the ID."""
    data = _load_raw()
    base_slug = _slugify(label)
    slug = base_slug
    n = 2
    while slug in data["instances"]:
        slug = f"{base_slug}-{n}"
        n += 1
    data["instances"][slug] = {"label": label, "url": url.rstrip("/"), "apiKey": api_key}
    _save_raw(data)
    return slug


def save_instance_config(instance_id, url, api_key, label=None):
    """Creates or updates an instance's saved connection -- used both for
    the host slot (instance_id="host") and for editing an already-added
    external instance."""
    data = _load_raw()
    existing = data["instances"].get(instance_id, {})
    default_label = "Host" if instance_id == HOST_INSTANCE_ID else instance_id
    data["instances"][instance_id] = {
        "label": label if label is not None else existing.get("label", default_label),
        "url": url.rstrip("/"),
        "apiKey": api_key,
    }
    _save_raw(data)


def clear_instance_config(instance_id):
    """Drops an instance's saved url/key. For the host slot this reverts
    it to the not-yet-connected placeholder (list_instances() still
    synthesizes it) -- the host can never be fully removed from the list,
    only disconnected. For an externally-added instance, this is what
    makes its tab disappear entirely, since those only exist in the
    stored config to begin with."""
    data = _load_raw()
    if instance_id in data["instances"]:
        del data["instances"][instance_id]
        _save_raw(data)


def _require_instance_config(instance_id):
    config = get_instance_config(instance_id)
    if not config or not config.get("url") or not config.get("apiKey"):
        raise RuntimeError("This Syncthing instance isn't configured yet -- add its URL and API key first.")
    return config


def get_headers(config):
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


def _post(path, config, params=None, body=None):
    resp = requests.post(f"{config['url']}{path}", headers=get_headers(config), params=params, json=body, timeout=10)
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


def get_devices(instance_id):
    """Combines several Syncthing endpoints into one flat list the
    dashboard can render directly: identity + config from
    /rest/config/devices, live connection state from
    /rest/system/connections, last-seen from /rest/stats/device, and
    aggregate sync completion from /rest/db/completion -- Syncthing
    doesn't expose any single endpoint with all of this already joined."""
    config = _require_instance_config(instance_id)

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


def pause_device(instance_id, device_id):
    config = _require_instance_config(instance_id)
    _post("/rest/system/pause", config, params={"device": device_id})


def resume_device(instance_id, device_id):
    config = _require_instance_config(instance_id)
    _post("/rest/system/resume", config, params={"device": device_id})


def add_device(instance_id, device_id, name):
    config = _require_instance_config(instance_id)
    body = {"deviceID": device_id, "name": name or device_id[:7], "addresses": ["dynamic"]}
    _put(f"/rest/config/devices/{device_id}", config, body)


def rename_device(instance_id, device_id, name):
    config = _require_instance_config(instance_id)
    device = _get(f"/rest/config/devices/{device_id}", config)
    device["name"] = name
    _put(f"/rest/config/devices/{device_id}", config, device)


def remove_device(instance_id, device_id):
    config = _require_instance_config(instance_id)
    _delete(f"/rest/config/devices/{device_id}", config)


def pause_all_devices(instance_id):
    """Omitting the `device` param on /rest/system/pause (or /resume)
    applies it to every device at once -- this is Syncthing's own
    documented behavior, not a loop we have to do ourselves."""
    config = _require_instance_config(instance_id)
    _post("/rest/system/pause", config)


def resume_all_devices(instance_id):
    config = _require_instance_config(instance_id)
    _post("/rest/system/resume", config)


def get_folders(instance_id):
    """Folder list + live sync state, joined the same way get_devices()
    joins device state: /rest/config/folders has the identity/paused
    config, /rest/db/status has the live state/byte counts Syncthing
    doesn't include in the config response."""
    config = _require_instance_config(instance_id)
    folders = _get("/rest/config/folders", config)

    result = []
    for f in folders:
        folder_id = f["id"]
        try:
            status = _get("/rest/db/status", config, params={"folder": folder_id})
        except (requests.RequestException, RuntimeError):
            status = {}
        global_bytes = status.get("globalBytes") or 0
        in_sync_bytes = status.get("inSyncBytes") or 0
        completion_pct = round((in_sync_bytes / global_bytes) * 100, 1) if global_bytes else 100.0
        result.append({
            "id": folder_id,
            "label": f.get("label") or folder_id,
            "paused": f.get("paused", False),
            "state": status.get("state", "unknown"),
            "completion": completion_pct,
            "errors": status.get("errors", 0),
        })

    result.sort(key=lambda x: x["label"].lower())
    return result


def set_folder_paused(instance_id, folder_id, paused):
    config = _require_instance_config(instance_id)
    folder = _get(f"/rest/config/folders/{folder_id}", config)
    folder["paused"] = paused
    _put(f"/rest/config/folders/{folder_id}", config, folder)


def rescan_folder(instance_id, folder_id):
    config = _require_instance_config(instance_id)
    _post("/rest/db/scan", config, params={"folder": folder_id})


def browse_folder(instance_id, folder_id, prefix=None):
    """Full recursive file tree for a folder (Syncthing's own "Browse"
    feature) -- omitting `levels` returns everything at once rather than
    one directory level at a time, which keeps the selective-sync UI
    simple (fetch once, render a nested tree with native <details>
    expand/collapse) at the cost of one bigger request. Fine for
    ROM-library-sized folders; would need lazy per-level fetching
    (Syncthing supports it via `prefix`) if this is ever used on folders
    with hundreds of thousands of files."""
    config = _require_instance_config(instance_id)
    params = {"folder": folder_id}
    if prefix:
        params["prefix"] = prefix
    return _get("/rest/db/browse", config, params=params)


def get_rate_limits(instance_id):
    """Global bandwidth caps in KiB/s (0 = unlimited, Syncthing's own
    convention). Lives under /rest/config/options alongside a lot of
    unrelated global settings -- we only ever read/write the two rate
    fields, read-modify-write same as set_folder_paused()."""
    config = _require_instance_config(instance_id)
    options = _get("/rest/config/options", config)
    return {
        "maxSendKbps": options.get("maxSendKbps", 0),
        "maxRecvKbps": options.get("maxRecvKbps", 0),
    }


def set_rate_limits(instance_id, max_send_kbps, max_recv_kbps):
    config = _require_instance_config(instance_id)
    options = _get("/rest/config/options", config)
    options["maxSendKbps"] = max_send_kbps
    options["maxRecvKbps"] = max_recv_kbps
    _put("/rest/config/options", config, options)


def get_folder_ignores(instance_id, folder_id):
    config = _require_instance_config(instance_id)
    data = _get("/rest/db/ignores", config, params={"folder": folder_id})
    return data.get("ignore") or []


def set_folder_ignores(instance_id, folder_id, patterns):
    config = _require_instance_config(instance_id)
    _post("/rest/db/ignores", config, params={"folder": folder_id}, body={"ignore": patterns})
