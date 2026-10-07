import itertools
import re
import uuid
import requests
from datetime import date, timedelta
from config import HOST_IP, KANBOARD_TOKEN_FILE

KANBOARD_URL = f"http://{HOST_IP}:3000"
RPC_URL = f"{KANBOARD_URL}/jsonrpc.php"
CHORES_PROJECT_NAME = "Chores"

_request_id = itertools.count(1)

# Kanboard's own open/closed constants (is_active on the task row: 1 open,
# 0 closed). Verified against the Kanboard source, not guessed.
STATUS_OPEN = 1
STATUS_CLOSED = 0


def get_auth():
    """Reads the token fresh from disk on every call, same reasoning as
    mealie_weekly_plan.get_headers(): the server can start before a token
    exists yet (first-time setup wizard), and a newly-pasted token takes
    effect immediately, no restart needed. Kanboard's JSON-RPC API uses
    HTTP Basic auth with the literal username "jsonrpc" for a project-wide
    API token (Settings -> API in the Kanboard UI) -- confirm this against
    the live instance if auth calls start failing with a clear 401/403."""
    with open(KANBOARD_TOKEN_FILE) as f:
        token = f.read().strip()
    return ("jsonrpc", token)


def rpc(method, params=None):
    body = {"jsonrpc": "2.0", "method": method, "id": next(_request_id), "params": params or {}}
    resp = requests.post(RPC_URL, json=body, auth=get_auth())
    resp.raise_for_status()
    data = resp.json()
    if "error" in data:
        raise RuntimeError(f"Kanboard RPC {method} failed: {data['error']}")
    return data.get("result")


def _to_kb_date(d):
    # NOTE: assumed ISO date string. Kanboard's documented date format for
    # task date fields varies by endpoint/version -- if real creates/updates
    # silently land on the wrong day (or error), this is the first thing to
    # check against the live instance.
    return d.isoformat()


def _from_kb_date(value):
    """getTask/getAllTasks return date_due as a unix timestamp (string or
    int), 0 meaning unset. Defensive since this hasn't been confirmed
    against the live instance yet (see rpc() callers)."""
    if not value:
        return None
    try:
        ts = int(value)
    except (TypeError, ValueError):
        return None
    if ts <= 0:
        return None
    return date.fromtimestamp(ts).isoformat()


def get_or_create_chores_project():
    projects = rpc("getAllProjects") or []
    match = next((p for p in projects if p.get("name") == CHORES_PROJECT_NAME), None)
    if match:
        return int(match["id"])
    new_id = rpc("createProject", {"name": CHORES_PROJECT_NAME})
    return int(new_id)


def get_all_people():
    """Kanboard users, used as the "assigned to" list -- not real login
    accounts in spirit, just names (see get_or_create_person below), but
    they live in Kanboard's real user table so a task's real owner_id
    actually reflects who it's assigned to if you look at the real board."""
    users = rpc("getAllUsers") or []
    return [
        {"id": int(u["id"]), "name": u.get("name") or u.get("username"), "username": u.get("username")}
        for u in users
    ]


def get_or_create_person(display_name):
    """Looks up an existing person by display name (case-insensitive), or
    creates a new Kanboard user for them -- the same "type a name, reuse
    it if it matches, otherwise create it" pattern Mealie's recipe combo
    box uses (see resolveNewRecipes() in mealie.js), just for people
    instead of recipes. These users are never meant to log in -- the
    random password and disable_login_form are best-effort "don't
    actually function as a login" signals; verify disable_login_form is
    a real createUser param against the live instance, since it's assumed
    rather than confirmed, like the other Kanboard API shapes in this file."""
    display_name = (display_name or "").strip()
    if not display_name:
        return None
    people = get_all_people()
    match = next((p for p in people if p["name"].lower() == display_name.lower()), None)
    if match:
        return match["id"]
    base = re.sub(r"[^a-zA-Z0-9]+", "_", display_name).strip("_").lower() or "person"
    existing_usernames = {p["username"] for p in people}
    candidate, suffix = base, 1
    while candidate in existing_usernames:
        suffix += 1
        candidate = f"{base}{suffix}"
    new_id = rpc("createUser", {
        "username": candidate,
        "password": uuid.uuid4().hex,
        "name": display_name,
        "disable_login_form": True,
    })
    return int(new_id)


def get_tasks_in_range(start, end):
    """Returns {iso_date: [{id, title, done, assignee}, ...]} for every
    chore (open or closed) due within [start, end] -- plural per day,
    unlike Mealie's one-meal-per-day plannedMap, since a day can have
    several chores."""
    project_id = get_or_create_chores_project()
    people_by_id = {p["id"]: p["name"] for p in get_all_people()}
    tasks = []
    for status_id in (STATUS_OPEN, STATUS_CLOSED):
        tasks.extend(rpc("getAllTasks", {"project_id": project_id, "status_id": status_id}) or [])

    by_date = {}
    for t in tasks:
        iso = _from_kb_date(t.get("date_due"))
        if not iso or iso < start.isoformat() or iso > end.isoformat():
            continue
        owner_id = int(t.get("owner_id") or 0)
        by_date.setdefault(iso, []).append({
            "id": int(t["id"]),
            "title": t.get("title", ""),
            # Kanboard's JSON-RPC responses come back with all fields as
            # strings -- compare as string, not int, to avoid "0" != 0.
            "done": str(t.get("is_active")) == "0",
            "assignee": people_by_id.get(owner_id) if owner_id else None,
        })
    return by_date


def create_task(title, due_date, assignee=None):
    project_id = get_or_create_chores_project()
    params = {
        "title": title,
        "project_id": project_id,
        "date_due": _to_kb_date(due_date),
    }
    if assignee:
        params["owner_id"] = get_or_create_person(assignee)
    task_id = rpc("createTask", params)
    return int(task_id)


def create_recurring_tasks(title, interval_days, start_date, count, assignee=None):
    """No series linkage (no tags/parent-child) -- each occurrence is a
    fully independent task once created, matching Mealie's Edit mode
    semantics (an edit/delete only ever touches one day)."""
    created = []
    for i in range(count):
        due = start_date + timedelta(days=interval_days * i)
        created.append(create_task(title, due, assignee=assignee))
    return created


def update_task(task_id, title=None, due_date=None, assignee=None):
    task = rpc("getTask", {"task_id": task_id})
    params = {
        "id": task_id,
        "title": title if title is not None else task.get("title"),
    }
    if due_date is not None:
        params["date_due"] = _to_kb_date(due_date)
    if assignee is not None:
        params["owner_id"] = get_or_create_person(assignee) if assignee.strip() else 0
    rpc("updateTask", params)


def close_task(task_id):
    rpc("closeTask", {"task_id": task_id})


def open_task(task_id):
    rpc("openTask", {"task_id": task_id})


def remove_task(task_id):
    rpc("removeTask", {"task_id": task_id})
