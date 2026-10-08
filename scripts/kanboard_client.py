import itertools
import re
import uuid
import requests
from datetime import datetime, time, timedelta
from zoneinfo import ZoneInfo
from config import HOST_IP, KANBOARD_TOKEN_FILE, TIMEZONE

KANBOARD_URL = f"http://{HOST_IP}:3000"
RPC_URL = f"{KANBOARD_URL}/jsonrpc.php"
TASKS_PROJECT_NAME = "Tasks"
LOCAL_TZ = ZoneInfo(TIMEZONE)
UTC = ZoneInfo("UTC")
# Earlier builds of this feature called the project "Chores" -- checked
# as a fallback so a project (and whatever tasks are already in it) from
# before this rename doesn't get silently orphaned in favor of a brand
# new "Tasks" project.
LEGACY_PROJECT_NAMES = ["Chores"]

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


# Sentinel time-of-day meaning "no specific time was chosen" -- every
# date_due/date_started write always includes an explicit time (see
# _to_kb_datetime) rather than a bare date, specifically to avoid relying
# on Kanboard's own "merges an unspecified time with its current clock"
# behavior (see git history/docs/kanboard.md for why that was a real,
# reproduced source of wrong due dates). Midnight is the default when
# nobody picked a real time; on the read side (get_tasks_in_range), a
# due/start time that's exactly this sentinel is treated as "none" rather
# than displayed as a real midnight deadline.
NO_TIME = time(0, 0)


def _to_kb_datetime(dt):
    # Confirmed against Kanboard v1.2.52's own source: the format list
    # DateParser::getParserFormats() tries for datetime fields is
    # 'Y-m-d H:i' (hour:minute, deliberately NO seconds) -- sending
    # seconds (e.g. "2026-10-07 00:00:00") was tried and rejected
    # outright during live testing, consistent with
    # DateTime::createFromFormat() requiring an exact match against
    # whichever format string it's tried with. Always sending a full,
    # explicit datetime (never a bare date) sidesteps Kanboard's
    # "unspecified time merges with its own current clock" behavior
    # entirely -- both the point of letting someone pick a real due/start
    # time, and a more reliable way to pin down the calendar day even
    # when nobody picks one.
    #
    # Also confirmed against the live instance: Kanboard's container
    # parses this naive string as UTC, not local time, regardless of the
    # `TZ` env var on the kanboard service in docker-compose.yml -- PHP
    # doesn't follow the OS `TZ` variable the way Python does, it needs
    # `date.timezone` set in php.ini, which this image apparently doesn't
    # do. A naive local time sent as-is landed 6 hours off (this
    # device's actual UTC offset), not randomly -- confirming a real,
    # consistent UTC interpretation on Kanboard's side, not noise.
    # Converting our intended LOCAL time to its UTC equivalent *before*
    # formatting makes every write correct regardless of what Kanboard's
    # container timezone actually is (now, or if it's ever fixed later) --
    # fixing this on our side instead of depending on Kanboard's config.
    utc_dt = dt.replace(tzinfo=LOCAL_TZ).astimezone(UTC)
    return utc_dt.strftime("%Y-%m-%d %H:%M")


def _from_kb_datetime(value):
    """getTask/getAllTasks have been seen to return date fields as a unix
    timestamp (string or int, 0/empty meaning unset) in some Kanboard
    versions and as a plain date/datetime string in others -- try both
    rather than assuming one. Silently treating a real due date as unset
    here is exactly the kind of bug that would make a newly-created task
    never show up in get_tasks_in_range()'s result without any visible
    error, so this is deliberately permissive. Returns a naive datetime,
    or None if unset."""
    if value in (None, "", 0, "0"):
        return None
    try:
        ts = int(value)
        return datetime.fromtimestamp(ts) if ts > 0 else None
    except (TypeError, ValueError):
        pass
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            return datetime.strptime(str(value).strip(), fmt)
        except ValueError:
            continue
    return None


def _find_project(projects, name):
    return next((p for p in projects if p.get("name") == name), None)


def get_or_create_tasks_project():
    projects = rpc("getAllProjects") or []
    match = _find_project(projects, TASKS_PROJECT_NAME)
    if match:
        return int(match["id"])
    for legacy_name in LEGACY_PROJECT_NAMES:
        match = _find_project(projects, legacy_name)
        if match:
            return int(match["id"])
    # createProject's JSON-RPC result isn't reliably the new project's id
    # across Kanboard versions -- some return a bare boolean success flag
    # instead. int(True) == 1, which would silently resolve to whatever
    # project happens to have id 1 (often a default/demo project) instead
    # of the real new "Tasks" project -- every task created right after
    # that would land in the wrong project and never show up in
    # get_tasks_in_range()'s results (which look up the project by name
    # fresh each time and would find the *correct* id on the next call,
    # masking the mismatch as "it didn't get added to the calendar" with
    # no visible error). Re-fetch and look up by name instead of trusting
    # the return value.
    rpc("createProject", {"name": TASKS_PROJECT_NAME})
    projects = rpc("getAllProjects") or []
    match = _find_project(projects, TASKS_PROJECT_NAME)
    if not match:
        raise RuntimeError(
            f'Asked Kanboard to create a "{TASKS_PROJECT_NAME}" project, '
            f"but it isn't in getAllProjects afterward -- check the Kanboard "
            f"API token's permissions (creating a project usually needs an "
            f"admin-level token)."
        )
    return int(match["id"])


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
    rpc("createUser", {
        "username": candidate,
        "password": uuid.uuid4().hex,
        "name": display_name,
        "disable_login_form": True,
    })
    # Same return-value caveat as get_or_create_tasks_project()'s
    # createProject call -- createUser's result isn't reliably the new
    # user's id either, so re-fetch and look up by the username we just
    # chose (guaranteed unique, unlike display_name) rather than trusting
    # whatever createUser handed back. A wrong owner_id here is exactly
    # the kind of thing that can make Kanboard's createTask reject the
    # whole task (an owner_id that doesn't reference a real user usually
    # fails a foreign-key check), which is a real failure mode this
    # bug fix is specifically guarding against.
    people = get_all_people()
    match = next((p for p in people if p["username"] == candidate), None)
    if not match:
        raise RuntimeError(
            f'Asked Kanboard to create a user "{candidate}" for "{display_name}", '
            f"but it isn't in getAllUsers afterward -- check the Kanboard API "
            f"token's permissions (creating a user usually needs an "
            f"admin-level token)."
        )
    return match["id"]


def _ensure_project_member(project_id, user_id):
    """Kanboard's web UI only ever lets you assign a task to a member of
    that task's project -- the API's createTask/updateTask may enforce
    the same rule even though owner_id is just a plain user id with no
    project scoping in the request itself. A real, reproduced symptom of
    this: createTask returning bare `false` for an otherwise well-formed
    request with a brand new person's (valid, real) owner_id -- every
    person this client creates only ever exists as a bare user, never
    added to the one project this app ever creates tasks in.

    Does NOT swallow the error silently anymore -- the first version of
    this did, and that turned out to hide whether addProjectUser was even
    the right call for this Kanboard version, making the next failure
    just as unexplained as this one. Returns the error message (if any)
    so create_task() can surface it instead of guessing again."""
    try:
        rpc("addProjectUser", {"project_id": project_id, "user_id": user_id})
        return None
    except RuntimeError as e:
        return str(e)


def _hhmm(dt):
    return dt.strftime("%H:%M") if dt else None


def get_tasks_in_range(start, end):
    """Returns {iso_date: [{id, title, done, assignee, startTime,
    dueTime}, ...]} for every task (open or closed) due within
    [start, end] -- plural per day, unlike Mealie's one-meal-per-day
    plannedMap, since a day can have several tasks. startTime/dueTime are
    "HH:MM" strings, or None when no specific time was chosen for that
    task -- date_started unset means no start time was ever given;
    date_due exactly at NO_TIME (midnight) means no due time was chosen
    either, since every write always includes a full datetime now (see
    _to_kb_datetime), defaulting to that sentinel rather than leaving the
    field ambiguous."""
    project_id = get_or_create_tasks_project()
    people_by_id = {p["id"]: p["name"] for p in get_all_people()}
    tasks = []
    for status_id in (STATUS_OPEN, STATUS_CLOSED):
        tasks.extend(rpc("getAllTasks", {"project_id": project_id, "status_id": status_id}) or [])

    by_date = {}
    for t in tasks:
        due_dt = _from_kb_datetime(t.get("date_due"))
        if not due_dt:
            continue
        iso = due_dt.date().isoformat()
        if iso < start.isoformat() or iso > end.isoformat():
            continue
        start_dt = _from_kb_datetime(t.get("date_started"))
        owner_id = int(t.get("owner_id") or 0)
        by_date.setdefault(iso, []).append({
            "id": int(t["id"]),
            "title": t.get("title", ""),
            # Kanboard's JSON-RPC responses come back with all fields as
            # strings -- compare as string, not int, to avoid "0" != 0.
            "done": str(t.get("is_active")) == "0",
            "assignee": people_by_id.get(owner_id) if owner_id else None,
            "startTime": _hhmm(start_dt),
            "dueTime": _hhmm(due_dt) if due_dt.time() != NO_TIME else None,
        })
    return by_date


def create_task(title, due_date, due_time=None, start_time=None, assignee=None):
    """due_time/start_time are datetime.time objects, or None for "no
    specific time" -- due_time defaults to NO_TIME (midnight) when
    omitted, since every write always includes a full datetime (see
    _to_kb_datetime)."""
    project_id = get_or_create_tasks_project()
    due_dt = datetime.combine(due_date, due_time or NO_TIME)
    params = {
        "title": title,
        "project_id": project_id,
        "date_due": _to_kb_datetime(due_dt),
    }
    if start_time:
        params["date_started"] = _to_kb_datetime(datetime.combine(due_date, start_time))
    membership_error = None
    if assignee:
        owner_id = get_or_create_person(assignee)
        membership_error = _ensure_project_member(project_id, owner_id)
        params["owner_id"] = owner_id
    task_id = rpc("createTask", params)
    if not task_id or task_id is True:
        # createTask returning a bare `false` (not an error, a clean RPC
        # response whose result IS false) means Kanboard itself rejected
        # the create -- commonly an owner_id that doesn't reference a
        # real user (now hardened against in get_or_create_person above)
        # or a project_id it doesn't recognize. Echo back what was sent,
        # plus whether the addProjectUser attempt above itself failed, so
        # a real failure here is diagnosable instead of a bare "got False"
        # with no way to tell which field (or which of this function's own
        # assumptions) caused it.
        extra = f" -- addProjectUser also failed: {membership_error}" if membership_error else ""
        raise RuntimeError(f"Kanboard createTask rejected the task (returned {task_id!r}) for params={params!r}{extra}")
    task_id = int(task_id)
    # Read the task back and confirm its due date/time actually round-trips
    # -- if _to_kb_datetime()'s format isn't what this Kanboard version
    # wants, the task still gets created (so it'd look like success) but
    # with no/the wrong due date, which is exactly what would make it
    # silently never appear in get_tasks_in_range()'s calendar query, or
    # land on the wrong day. Catching that here, loudly, beats a
    # newly-planned task just quietly showing up wrong with no explanation.
    created = rpc("getTask", {"task_id": task_id}) or {}
    actual_due = _from_kb_datetime(created.get("date_due"))
    if not actual_due or actual_due.replace(second=0, microsecond=0) != due_dt:
        raise RuntimeError(
            f"Created Kanboard task {task_id}, but its due date/time came back "
            f"as {created.get('date_due')!r} ({actual_due}) instead of {due_dt} -- "
            f"the datetime format this client sends (_to_kb_datetime) likely "
            f"doesn't match what this Kanboard version expects."
        )
    return task_id


def create_recurring_tasks(title, interval_days, start_date, count, due_time=None, start_time=None, assignee=None):
    """No series linkage (no tags/parent-child) -- each occurrence is a
    fully independent task once created, matching Mealie's Edit mode
    semantics (an edit/delete only ever touches one day). due_time/
    start_time (if given) are the same clock time on every occurrence."""
    created = []
    for i in range(count):
        due = start_date + timedelta(days=interval_days * i)
        created.append(create_task(title, due, due_time=due_time, start_time=start_time, assignee=assignee))
    return created


def update_task(task_id, title, due_date, due_time=None, start_time=None, assignee=None):
    """title/due_date are always required -- the Edit form always submits
    full current values (same convention as title/assignee already used),
    not a sparse "only what changed" patch, so there's no separate
    "don't touch this field" case to handle for due_time/start_time
    either: omitting one just means "no specific time", same as
    create_task."""
    task = rpc("getTask", {"task_id": task_id})
    params = {
        "id": task_id,
        "title": title,
        "date_due": _to_kb_datetime(datetime.combine(due_date, due_time or NO_TIME)),
        "date_started": _to_kb_datetime(datetime.combine(due_date, start_time)) if start_time else 0,
    }
    if assignee is not None:
        if assignee.strip():
            owner_id = get_or_create_person(assignee)
            _ensure_project_member(int(task["project_id"]), owner_id)
            params["owner_id"] = owner_id
        else:
            params["owner_id"] = 0
    rpc("updateTask", params)


def close_task(task_id):
    rpc("closeTask", {"task_id": task_id})


def open_task(task_id):
    rpc("openTask", {"task_id": task_id})


def remove_task(task_id):
    rpc("removeTask", {"task_id": task_id})
