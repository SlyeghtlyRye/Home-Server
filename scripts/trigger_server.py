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

sys.path.insert(0, "/root/audiobooks")
import audiobook_lib as alib

from config import TRIGGER_SECRET as SECRET

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

    def _fetch_list_detail(self, list_id):
        resp = mwp.requests.get(
            f"{mwp.MEALIE_URL}/api/households/shopping/lists/{list_id}",
            headers=mwp.headers,
        )
        resp.raise_for_status()
        data = resp.json()
        items = [
            {
                "display": it.get("display") or it.get("note") or (it.get("food", {}).get("name") if isinstance(it.get("food"), dict) else None) or "(item)",
                "checked": it.get("checked", False),
            }
            for it in data.get("listItems", [])
        ]
        return {"name": data.get("name"), "items": items}

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
                        {"date": e["date"], "recipe": (e.get("recipe") or {}).get("name", "(none)")}
                        for e in entries
                    ]
                    self._send_json(200, {"entries": result})
                    return
                except Exception as e:
                    last_exc = e
                    time.sleep(0.5)
            self._send_json(500, {"error": str(last_exc)})
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
                    results = []
                    for sunday in sundays:
                        name = mwp.list_name_for(sunday)
                        list_id = mwp.find_shopping_list(name)
                        if list_id:
                            detail = self._fetch_list_detail(list_id)
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
                resp = mwp.requests.post(f"{mwp.MEALIE_URL}/api/recipes", headers=mwp.headers, json={"name": name})
                resp.raise_for_status()
                slug = resp.json()
                detail = mwp.requests.get(f"{mwp.MEALIE_URL}/api/recipes/{slug}", headers=mwp.headers)
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
