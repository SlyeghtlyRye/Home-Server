import http.server
import subprocess
import urllib.parse
import json
import sys
import re
import os
import uuid
import mimetypes
import time
from datetime import date, timedelta

sys.path.insert(0, "/root/scripts")
import mealie_weekly_plan as mwp
import syncthing_client as stc

sys.path.insert(0, "/root/audiobooks")
import audiobook_lib as alib

from config import TRIGGER_SECRET as SECRET, MEALIE_TOKEN_FILE as MEALIE_TOKEN_FILE_PATH
DOCS_DIR = "/root/docs"
import system_status
import reset_manager
import updater

current_process = None


class Handler(http.server.BaseHTTPRequestHandler):
    def _send_json(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_json_body(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b"{}"
        return json.loads(raw or b"{}")

    def _check_key(self, params):
        return params.get("key", [None])[0] == SECRET

    def _fetch_list_detail(self, list_id, recipe_name_map):
        resp = mwp.requests.get(
            f"{mwp.MEALIE_URL}/api/households/shopping/lists/{list_id}",
            headers=mwp.get_headers(),
        )
        resp.raise_for_status()
        data = resp.json()
        items = []
        for it in data.get("listItems", []):
            recipe_ids = []
            for ref in (it.get("recipeReferences") or []):
                rid = ref.get("recipeId")
                if rid and rid not in recipe_ids:
                    recipe_ids.append(rid)
            items.append({
                "id": it.get("id"),
                "display": it.get("display") or it.get("note") or (it.get("food", {}).get("name") if isinstance(it.get("food"), dict) else None) or "(item)",
                "checked": it.get("checked", False),
                "recipeIds": recipe_ids,
            })

        # Group items by the meal(s) they came from, so the dashboard can default
        # to a "by meal" shopping view. An item merged across multiple recipes
        # (same ingredient needed by two meals) appears in every relevant group;
        # items with no recipe reference (freeform additions) fall into "other".
        groups_by_id = {}
        other_items = []
        for it in items:
            if not it["recipeIds"]:
                other_items.append(it)
                continue
            for rid in it["recipeIds"]:
                group = groups_by_id.setdefault(rid, {
                    "recipeId": rid,
                    "recipeName": recipe_name_map.get(rid, "(unknown recipe)"),
                    "items": [],
                })
                group["items"].append(it)
        groups = sorted(groups_by_id.values(), key=lambda g: g["recipeName"].lower())

        return {"id": list_id, "name": data.get("name"), "items": items, "groups": groups, "otherItems": other_items}

    def do_GET(self):
        global current_process
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)
        if not self._check_key(params):
            self.send_response(403)
            self.end_headers()
            return

        if parsed.path == "/status":
            running = current_process is not None and current_process.poll() is None
            self._send_json(200, {"running": running})
            return
        if parsed.path == "/data/docs-list":
            docs = []
            for filename in sorted(os.listdir(DOCS_DIR)):
                if not filename.endswith(".md") or filename == "index.md":
                    continue
                filepath = os.path.join(DOCS_DIR, filename)
                title = filename
                tags = []
                with open(filepath) as f:
                    for line in f:
                        stripped = line.strip()
                        if stripped.startswith("tags:"):
                            tags = [t.strip() for t in stripped[len("tags:"):].split(",") if t.strip()]
                        elif stripped.startswith("# "):
                            title = stripped[2:].strip()
                            break
                docs.append({"filename": filename, "title": title, "tags": tags})
            self._send_json(200, {"docs": docs})
            return
        if parsed.path == "/data/docs-content":
            filename = params.get("filename", [None])[0]
            if not filename or "/" in filename or ".." in filename:
                self._send_json(400, {"error": "invalid filename"})
                return
            filepath = os.path.join(DOCS_DIR, filename)
            if not os.path.exists(filepath) or not filename.endswith(".md"):
                self._send_json(404, {"error": "not found"})
                return
            with open(filepath) as f:
                content = f.read()
            self._send_json(200, {"filename": filename, "content": content})
            return
        if parsed.path == "/data/system-status":
            try:
                self._send_json(200, system_status.collect_status())
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return
        if parsed.path == "/api/reset-preview":
            host_ip = reset_manager.read_current_host_ip()
            timezone = reset_manager.read_current_timezone()
            log_lines = reset_manager.run_reset(host_ip, timezone, dry_run=True, return_log=True)
            self._send_json(200, {"log": log_lines})
            return
        if parsed.path == "/data/setup-status":
            token_exists = os.path.exists(MEALIE_TOKEN_FILE_PATH)
            mealie_ok = False
            if token_exists:
                try:
                    mwp.get_recipe_ids()
                    mealie_ok = True
                except Exception:
                    mealie_ok = False
            try:
                has_profile = len(alib.load_profiles()) > 0
            except Exception:
                has_profile = False
            self._send_json(200, {
                "mealie_token_exists": token_exists,
                "mealie_token_valid": mealie_ok,
                "has_streams_profile": has_profile,
                "setup_complete": mealie_ok and has_profile,
            })
            return
        if parsed.path == "/api/check-update":
            try:
                self._send_json(200, updater.check_for_update())
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        if parsed.path == "/data/local-audio":
            book_id = params.get("id", [None])[0]
            shared = alib.find_local_shared(book_id)
            if not shared:
                self.send_response(404)
                self.end_headers()
                return
            filepath = os.path.join(alib.LOCAL_FILES_DIR, shared["local_filename"])
            if not os.path.exists(filepath):
                self.send_response(404)
                self.end_headers()
                return
            file_size = os.path.getsize(filepath)
            content_type = mimetypes.guess_type(filepath)[0] or "application/octet-stream"
            range_header = self.headers.get("Range")
            if range_header:
                m = re.match(r"bytes=(\d+)-(\d*)", range_header)
                start = int(m.group(1))
                end = int(m.group(2)) if m.group(2) else file_size - 1
                end = min(end, file_size - 1)
                length = end - start + 1
                self.send_response(206)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Content-Length", str(length))
                self.end_headers()
                with open(filepath, "rb") as f:
                    f.seek(start)
                    remaining = length
                    while remaining > 0:
                        chunk = f.read(min(65536, remaining))
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        remaining -= len(chunk)
            else:
                self.send_response(200)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(file_size))
                self.send_header("Accept-Ranges", "bytes")
                self.end_headers()
                with open(filepath, "rb") as f:
                    while True:
                        chunk = f.read(65536)
                        if not chunk:
                            break
                        self.wfile.write(chunk)
            return

        if parsed.path == "/data/range-mealplan":
            start_s = params.get("start", [None])[0]
            end_s = params.get("end", [None])[0]
            if not start_s or not end_s:
                self._send_json(400, {"error": "missing start/end"})
                return
            last_exc = None
            for _ in range(3):
                try:
                    start = date.fromisoformat(start_s)
                    end = date.fromisoformat(end_s)
                    entries = mwp.get_mealplan_entries(start, end)
                    result = [
                        {
                            "date": e["date"],
                            "recipe": (e.get("recipe") or {}).get("name", "(none)"),
                            "recipeId": (e.get("recipe") or {}).get("id"),
                        }
                        for e in entries
                    ]
                    self._send_json(200, {"entries": result})
                    return
                except Exception as e:
                    last_exc = e
                    time.sleep(0.5)
            self._send_json(500, {"error": str(last_exc)})
            return

        if parsed.path == "/data/available-weeks":
            try:
                weeks = mwp.get_available_weeks()
                today_week = mwp.canonical_week_start(date.today())
                result = [
                    {"start": w.isoformat(), "label": f"Week of {w.isoformat()}", "isCurrent": w == today_week}
                    for w in weeks
                ]
                self._send_json(200, {"weeks": result})
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        if parsed.path == "/data/week-mealplan":
            start_s = params.get("start", [None])[0]
            if not start_s:
                self._send_json(400, {"error": "missing start"})
                return
            try:
                start = date.fromisoformat(start_s)
                self._send_json(200, {"days": mwp.get_week_meals(start)})
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        if parsed.path == "/data/recipe-detail":
            recipe_id = params.get("id", [None])[0]
            if not recipe_id:
                self._send_json(400, {"error": "missing id"})
                return
            try:
                self._send_json(200, mwp.get_recipe_detail(recipe_id))
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        if parsed.path == "/data/recipes":
            last_exc = None
            for _ in range(3):
                try:
                    recipes = mwp.get_recipe_ids()
                    self._send_json(200, {"recipes": [{"id": r[0], "name": r[1]} for r in recipes]})
                    return
                except Exception as e:
                    last_exc = e
                    time.sleep(0.5)
            self._send_json(500, {"error": str(last_exc)})
            return

        if parsed.path == "/data/shopping-lists-for-range":
            start_s = params.get("start", [None])[0]
            end_s = params.get("end", [None])[0]
            if not start_s or not end_s:
                self._send_json(400, {"error": "missing start/end"})
                return
            last_exc = None
            for _ in range(3):
                try:
                    start = date.fromisoformat(start_s)
                    end = date.fromisoformat(end_s)
                    sundays = []
                    d = start
                    while d.weekday() != 6:
                        d += timedelta(days=1)
                    while d <= end:
                        sundays.append(d)
                        d += timedelta(days=7)
                    recipe_name_map = {r[0]: r[1] for r in mwp.get_recipe_ids()}
                    results = []
                    for sunday in sundays:
                        name = mwp.list_name_for(sunday)
                        list_id = mwp.find_shopping_list(name)
                        if list_id:
                            detail = self._fetch_list_detail(list_id, recipe_name_map)
                            wk_end = sunday + timedelta(days=6)
                            detail["week_label"] = f"{sunday.isoformat()} to {wk_end.isoformat()}"
                            results.append(detail)
                    self._send_json(200, {"lists": results})
                    return
                except Exception as e:
                    last_exc = e
                    time.sleep(0.5)
            self._send_json(500, {"error": str(last_exc)})
            return

        if parsed.path == "/data/audiobook-profiles":
            try:
                self._send_json(200, {"profiles": alib.load_profiles()})
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return


        if parsed.path == "/data/audiobook-library":
            profile = params.get("profile", [None])[0]
            if not profile:
                self._send_json(400, {"error": "missing profile"})
                return
            try:
                youtube_library = alib.library_for_profile(profile)
                local_library = alib.local_shared_for_profile(profile)
                recent = alib.recently_played(profile)
                self._send_json(200, {"library": youtube_library, "local": local_library, "recent": recent})
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        if parsed.path == "/data/syncthing-instances":
            self._send_json(200, {"instances": stc.list_instances()})
            return

        if parsed.path == "/data/syncthing-devices":
            instance_id = params.get("instance", [None])[0]
            if not instance_id:
                self._send_json(400, {"error": "missing instance"})
                return
            if not stc.is_instance_configured(instance_id):
                self._send_json(200, {"configured": False, "devices": [], "baseUrl": None})
                return
            try:
                devices = stc.get_devices(instance_id)
                base_url = (stc.get_instance_config(instance_id) or {}).get("url")
                self._send_json(200, {"configured": True, "devices": devices, "baseUrl": base_url})
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        if parsed.path == "/data/syncthing-folders":
            instance_id = params.get("instance", [None])[0]
            if not instance_id:
                self._send_json(400, {"error": "missing instance"})
                return
            if not stc.is_instance_configured(instance_id):
                self._send_json(200, {"configured": False, "folders": []})
                return
            try:
                folders = stc.get_folders(instance_id)
                self._send_json(200, {"configured": True, "folders": folders})
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        if parsed.path == "/data/syncthing-folder-browse":
            instance_id = params.get("instance", [None])[0]
            folder_id = params.get("folder", [None])[0]
            prefix = params.get("prefix", [None])[0]
            if not instance_id or not folder_id:
                self._send_json(400, {"error": "missing instance or folder"})
                return
            try:
                tree = stc.browse_folder(instance_id, folder_id, prefix)
                self._send_json(200, {"tree": tree})
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        if parsed.path == "/data/syncthing-rate-limits":
            instance_id = params.get("instance", [None])[0]
            if not instance_id:
                self._send_json(400, {"error": "missing instance"})
                return
            try:
                limits = stc.get_rate_limits(instance_id)
                self._send_json(200, limits)
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        if parsed.path == "/data/syncthing-folder-ignores":
            instance_id = params.get("instance", [None])[0]
            folder_id = params.get("folder", [None])[0]
            if not instance_id or not folder_id:
                self._send_json(400, {"error": "missing instance or folder"})
                return
            try:
                ignore = stc.get_folder_ignores(instance_id, folder_id)
                self._send_json(200, {"ignore": ignore})
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        global current_process
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)
        if not self._check_key(params):
            self.send_response(403)
            self.end_headers()
            return
        if parsed.path == "/api/reset-execute":
            body = self._read_json_body()
            confirm_text = body.get("confirm", "")
            if confirm_text != "RESET":
                self._send_json(400, {"error": "confirmation text did not match"})
                return
            host_ip = reset_manager.read_current_host_ip()
            timezone = reset_manager.read_current_timezone()
            try:
                reset_manager.run_reset(host_ip, timezone, dry_run=False, skip_service_restart=True)
                self._send_json(200, {
                    "status": "ok",
                    "message": "Personal data cleared and new secrets generated. "
                               "SSH in and run: docker compose up -d --force-recreate "
                               "(or reboot the device) to finish applying the reset."
                })
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return
        if parsed.path == "/api/apply-update":
            try:
                self._send_json(200, updater.apply_update())
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return
        if parsed.path == "/api/save-mealie-token":
            body = self._read_json_body()
            token = (body.get("token") or "").strip()
            if not token:
                self._send_json(400, {"error": "missing token"})
                return
            with open(MEALIE_TOKEN_FILE_PATH, "w") as f:
                f.write(token)
            try:
                mwp.get_recipe_ids()
                self._send_json(200, {"status": "ok", "valid": True})
            except Exception as e:
                self._send_json(200, {"status": "ok", "valid": False, "error": str(e)})
            return

        if parsed.path == "/api/save-syncthing-instance":
            body = self._read_json_body()
            instance_id = body.get("instanceId")
            url = (body.get("url") or "").strip()
            api_key = (body.get("apiKey") or "").strip()
            label = body.get("label")
            if not instance_id or not url:
                self._send_json(400, {"error": "missing instanceId or url"})
                return
            if not api_key:
                # Editing with the API key field left blank means "keep
                # the existing key" -- only meaningful if one is already
                # saved, since first-time connect always requires it.
                existing = stc.get_instance_config(instance_id)
                if not existing or not existing.get("apiKey"):
                    self._send_json(400, {"error": "missing apiKey"})
                    return
                api_key = existing["apiKey"]
            try:
                stc.test_connection(url, api_key)
            except Exception as e:
                self._send_json(200, {"status": "ok", "valid": False, "error": str(e)})
                return
            stc.save_instance_config(instance_id, url, api_key, label)
            self._send_json(200, {"status": "ok", "valid": True})
            return

        if parsed.path == "/api/add-syncthing-instance":
            body = self._read_json_body()
            label = (body.get("label") or "").strip()
            url = (body.get("url") or "").strip()
            api_key = (body.get("apiKey") or "").strip()
            if not label or not url or not api_key:
                self._send_json(400, {"error": "missing label, url, or apiKey"})
                return
            try:
                stc.test_connection(url, api_key)
            except Exception as e:
                self._send_json(200, {"status": "ok", "valid": False, "error": str(e)})
                return
            instance_id = stc.add_instance(label, url, api_key)
            self._send_json(200, {"status": "ok", "valid": True, "instanceId": instance_id})
            return

        if parsed.path == "/api/clear-syncthing-instance":
            body = self._read_json_body()
            instance_id = body.get("instanceId")
            if not instance_id:
                self._send_json(400, {"error": "missing instanceId"})
                return
            stc.clear_instance_config(instance_id)
            self._send_json(200, {"status": "ok"})
            return

        if parsed.path == "/api/syncthing-pause-all":
            body = self._read_json_body()
            instance_id = body.get("instanceId")
            if not instance_id:
                self._send_json(400, {"error": "missing instanceId"})
                return
            try:
                stc.pause_all_devices(instance_id)
                self._send_json(200, {"status": "ok"})
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        if parsed.path == "/api/syncthing-resume-all":
            body = self._read_json_body()
            instance_id = body.get("instanceId")
            if not instance_id:
                self._send_json(400, {"error": "missing instanceId"})
                return
            try:
                stc.resume_all_devices(instance_id)
                self._send_json(200, {"status": "ok"})
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        if parsed.path == "/api/syncthing-folder-pause":
            body = self._read_json_body()
            instance_id = body.get("instanceId")
            folder_id = body.get("folderId")
            if not instance_id or not folder_id:
                self._send_json(400, {"error": "missing instanceId or folderId"})
                return
            try:
                stc.set_folder_paused(instance_id, folder_id, True)
                self._send_json(200, {"status": "ok"})
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        if parsed.path == "/api/syncthing-folder-resume":
            body = self._read_json_body()
            instance_id = body.get("instanceId")
            folder_id = body.get("folderId")
            if not instance_id or not folder_id:
                self._send_json(400, {"error": "missing instanceId or folderId"})
                return
            try:
                stc.set_folder_paused(instance_id, folder_id, False)
                self._send_json(200, {"status": "ok"})
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        if parsed.path == "/api/syncthing-folder-rescan":
            body = self._read_json_body()
            instance_id = body.get("instanceId")
            folder_id = body.get("folderId")
            if not instance_id or not folder_id:
                self._send_json(400, {"error": "missing instanceId or folderId"})
                return
            try:
                stc.rescan_folder(instance_id, folder_id)
                self._send_json(200, {"status": "ok"})
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        if parsed.path == "/api/syncthing-rate-limits":
            body = self._read_json_body()
            instance_id = body.get("instanceId")
            max_send_kbps = body.get("maxSendKbps")
            max_recv_kbps = body.get("maxRecvKbps")
            if not instance_id or max_send_kbps is None or max_recv_kbps is None:
                self._send_json(400, {"error": "missing instanceId, maxSendKbps, or maxRecvKbps"})
                return
            try:
                stc.set_rate_limits(instance_id, int(max_send_kbps), int(max_recv_kbps))
                self._send_json(200, {"status": "ok"})
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        if parsed.path == "/api/syncthing-folder-delete-files":
            body = self._read_json_body()
            instance_id = body.get("instanceId")
            folder_id = body.get("folderId")
            paths = body.get("paths")
            if not instance_id or not folder_id or not paths:
                self._send_json(400, {"error": "missing instanceId, folderId, or paths"})
                return
            try:
                stc.delete_folder_files(instance_id, folder_id, paths)
                self._send_json(200, {"status": "ok"})
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        if parsed.path == "/api/syncthing-folder-ignores":
            body = self._read_json_body()
            instance_id = body.get("instanceId")
            folder_id = body.get("folderId")
            patterns = body.get("ignore")
            if not instance_id or not folder_id or patterns is None:
                self._send_json(400, {"error": "missing instanceId, folderId, or ignore"})
                return
            try:
                stc.set_folder_ignores(instance_id, folder_id, patterns)
                self._send_json(200, {"status": "ok"})
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        if parsed.path == "/api/syncthing-device-pause":
            body = self._read_json_body()
            instance_id = body.get("instanceId")
            device_id = body.get("deviceId")
            if not instance_id or not device_id:
                self._send_json(400, {"error": "missing instanceId or deviceId"})
                return
            try:
                stc.pause_device(instance_id, device_id)
                self._send_json(200, {"status": "ok"})
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        if parsed.path == "/api/syncthing-device-resume":
            body = self._read_json_body()
            instance_id = body.get("instanceId")
            device_id = body.get("deviceId")
            if not instance_id or not device_id:
                self._send_json(400, {"error": "missing instanceId or deviceId"})
                return
            try:
                stc.resume_device(instance_id, device_id)
                self._send_json(200, {"status": "ok"})
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        if parsed.path == "/api/syncthing-device-add":
            body = self._read_json_body()
            instance_id = body.get("instanceId")
            device_id = (body.get("deviceId") or "").strip()
            name = (body.get("name") or "").strip()
            if not instance_id or not device_id:
                self._send_json(400, {"error": "missing instanceId or deviceId"})
                return
            try:
                stc.add_device(instance_id, device_id, name)
                self._send_json(200, {"status": "ok"})
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        if parsed.path == "/api/syncthing-device-rename":
            body = self._read_json_body()
            instance_id = body.get("instanceId")
            device_id = body.get("deviceId")
            name = (body.get("name") or "").strip()
            if not instance_id or not device_id or not name:
                self._send_json(400, {"error": "missing instanceId, deviceId, or name"})
                return
            try:
                stc.rename_device(instance_id, device_id, name)
                self._send_json(200, {"status": "ok"})
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        if parsed.path == "/api/syncthing-device-remove":
            body = self._read_json_body()
            instance_id = body.get("instanceId")
            device_id = body.get("deviceId")
            if not instance_id or not device_id:
                self._send_json(400, {"error": "missing instanceId or deviceId"})
                return
            try:
                stc.remove_device(instance_id, device_id)
                self._send_json(200, {"status": "ok"})
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        if parsed.path == "/api/shopping-item-add":
            body = self._read_json_body()
            list_id = body.get("listId")
            text = (body.get("text") or "").strip()
            if not list_id or not text:
                self._send_json(400, {"error": "missing listId or text"})
                return
            try:
                item = mwp.create_shopping_item(list_id, text)
                self._send_json(200, {
                    "id": item.get("id"),
                    "display": item.get("display") or item.get("note") or text,
                    "checked": item.get("checked", False),
                })
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        if parsed.path == "/api/shopping-item-delete":
            body = self._read_json_body()
            item_id = body.get("itemId")
            if not item_id:
                self._send_json(400, {"error": "missing itemId"})
                return
            try:
                mwp.delete_shopping_item(item_id)
                self._send_json(200, {"status": "ok"})
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        if parsed.path == "/api/shopping-item-check":
            body = self._read_json_body()
            item_id = body.get("itemId")
            checked = bool(body.get("checked"))
            if not item_id:
                self._send_json(400, {"error": "missing itemId"})
                return
            try:
                mwp.set_shopping_item_checked(item_id, checked)
                self._send_json(200, {"status": "ok"})
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        if parsed.path == "/api/swap-days":
            body = self._read_json_body()
            try:
                date_a = date.fromisoformat(body.get("dateA"))
                date_b = date.fromisoformat(body.get("dateB"))
            except Exception:
                self._send_json(400, {"error": "invalid dateA/dateB"})
                return
            try:
                self._send_json(200, mwp.swap_meals(date_a, date_b))
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        if parsed.path == "/audiobook-upload-local":
            profile = params.get("profile", [None])[0]
            title = params.get("title", [None])[0]
            ext = params.get("ext", ["mp3"])[0]
            if not profile or not title:
                self._send_json(400, {"error": "missing profile or title"})
                return
            content_length = int(self.headers.get("Content-Length", 0))
            if content_length <= 0:
                self._send_json(400, {"error": "empty upload"})
                return
            book_id = str(uuid.uuid4())[:8]
            safe_ext = re.sub(r"[^a-zA-Z0-9]", "", ext)[:10] or "mp3"
            filename = f"{book_id}.{safe_ext}"
            os.makedirs(alib.LOCAL_FILES_DIR, exist_ok=True)
            filepath = os.path.join(alib.LOCAL_FILES_DIR, filename)
            remaining = content_length
            try:
                with open(filepath, "wb") as f:
                    while remaining > 0:
                        chunk = self.rfile.read(min(65536, remaining))
                        if not chunk:
                            break
                        f.write(chunk)
                        remaining -= len(chunk)
            except Exception as e:
                self._send_json(500, {"error": f"upload failed: {e}"})
                return
            try:
                entry = alib.add_local_shared(title, filename, uploaded_by=profile, book_id=book_id)
                self._send_json(200, entry)
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        if parsed.path == "/preview":
            body = self._read_json_body()
            dates = [date.fromisoformat(d) for d in body.get("dates", [])]
            avoid_repeats = body.get("avoidRepeats", True)
            overrides = body.get("overrides", {})
            try:
                picks = mwp.preview_dates(dates, avoid_repeats=avoid_repeats, overrides=overrides)
                self._send_json(200, {"picks": picks})
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        if parsed.path == "/reroll":
            body = self._read_json_body()
            target_date = body.get("date")
            avoid_repeats = body.get("avoidRepeats", True)
            exclude_ids = body.get("excludeIds", [])
            try:
                pick = mwp.reroll_pick(target_date, avoid_repeats=avoid_repeats, exclude_ids=exclude_ids)
                self._send_json(200, {"pick": pick})
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        if parsed.path == "/commit":
            body = self._read_json_body()
            picks = body.get("picks", [])
            current_process = subprocess.Popen(
                ["python3", "-c",
                 "import sys; sys.path.insert(0,'/root/scripts'); import mealie_weekly_plan as mwp; "
                 "import json; picks=json.loads(sys.argv[1]); mwp.commit_picks(picks)",
                 json.dumps(picks)]
            )
            self._send_json(200, {"status": "started"})
            return

        if parsed.path == "/clear-dates":
            body = self._read_json_body()
            dates = body.get("dates", [])
            current_process = subprocess.Popen(
                ["python3", "/root/scripts/mealie_weekly_plan.py", "clear-dates", ",".join(dates)]
            )
            self._send_json(200, {"status": "started"})
            return

        if parsed.path == "/create-recipe":
            body = self._read_json_body()
            name = (body.get("name") or "").strip()
            if not name:
                self._send_json(400, {"error": "missing name"})
                return
            try:
                resp = mwp.requests.post(f"{mwp.MEALIE_URL}/api/recipes", headers=mwp.get_headers(), json={"name": name})
                resp.raise_for_status()
                slug = resp.json()
                detail = mwp.requests.get(f"{mwp.MEALIE_URL}/api/recipes/{slug}", headers=mwp.get_headers())
                detail.raise_for_status()
                data = detail.json()
                self._send_json(200, {"id": data["id"], "name": data["name"]})
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        if parsed.path == "/" and "action" in params:
            action = params.get("action", [None])[0]
            valid = {"run-current", "run-next", "clear-current", "clear-next"}
            if action not in valid:
                self.send_response(403)
                self.end_headers()
                return
            verb, which = action.split("-")
            start, end = mwp.get_week_range(which)
            dates = [(start + timedelta(days=i)).isoformat() for i in range(7)]
            if verb == "run":
                current_process = subprocess.Popen(
                    ["python3", "-c",
                     "import sys; sys.path.insert(0,'/root/scripts'); import mealie_weekly_plan as mwp; "
                     "import json; from datetime import date; "
                     "dates=[date.fromisoformat(d) for d in json.loads(sys.argv[1])]; "
                     "picks=mwp.preview_dates(dates); mwp.commit_picks(picks)",
                     json.dumps(dates)]
                )
            else:
                current_process = subprocess.Popen(
                    ["python3", "/root/scripts/mealie_weekly_plan.py", "clear-dates", ",".join(dates)]
                )
            self._send_json(200, {"status": "started", "action": action})
            return

        if parsed.path == "/audiobook-add-profile":
            body = self._read_json_body()
            try:
                profiles = alib.add_profile(body.get("name", ""))
                self._send_json(200, {"profiles": profiles})
            except Exception as e:
                self._send_json(400, {"error": str(e)})
            return

        if parsed.path == "/audiobook-rename-profile":
            body = self._read_json_body()
            try:
                profiles = alib.rename_profile(body.get("old"), body.get("new", ""))
                self._send_json(200, {"profiles": profiles})
            except Exception as e:
                self._send_json(400, {"error": str(e)})
            return

        if parsed.path == "/audiobook-delete-profile":
            body = self._read_json_body()
            try:
                profiles = alib.delete_profile(body.get("name"))
                self._send_json(200, {"profiles": profiles})
            except Exception as e:
                self._send_json(400, {"error": str(e)})
            return

        if parsed.path == "/audiobook-add":
            body = self._read_json_body()
            url = (body.get("url") or "").strip()
            profile = body.get("profile")
            if not url or not profile:
                self._send_json(400, {"error": "missing url or profile"})
                return
            try:
                entry = alib.add_book(url, profile)
                self._send_json(200, entry)
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        if parsed.path == "/audiobook-update-resume":
            body = self._read_json_body()
            book_id = body.get("id")
            seconds = body.get("resume_seconds")
            profile = body.get("profile")
            try:
                updated = alib.update_resume(profile, book_id, int(seconds))
                self._send_json(200, updated)
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        if parsed.path == "/audiobook-set-stop":
            body = self._read_json_body()
            book_id = body.get("id")
            seconds = body.get("stop_seconds")
            profile = body.get("profile")
            try:
                updated = alib.set_stop(profile, book_id, int(seconds) if seconds is not None else None)
                self._send_json(200, updated)
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        if parsed.path == "/audiobook-record-checkpoint":
            body = self._read_json_body()
            book_id = body.get("id")
            profile = body.get("profile")
            try:
                updated = alib.record_checkpoint(profile, book_id)
                self._send_json(200, updated)
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        if parsed.path == "/audiobook-revert-resume":
            body = self._read_json_body()
            book_id = body.get("id")
            seconds = body.get("seconds")
            profile = body.get("profile")
            try:
                updated = alib.revert_resume(profile, book_id, int(seconds))
                self._send_json(200, updated)
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        if parsed.path == "/audiobook-delete":
            body = self._read_json_body()
            book_id = body.get("id")
            try:
                alib.delete_book(book_id)
                self._send_json(200, {"status": "ok"})
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        self.send_response(404)
        self.end_headers()


if __name__ == "__main__":
    http.server.ThreadingHTTPServer(("0.0.0.0", 9001), Handler).serve_forever()
