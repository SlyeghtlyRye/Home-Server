"""
chore_buckets.py -- reusable named presets ("buckets") for Kanboard's
Schedule flow: a chore or event the household creates often (Sweeping,
Trash, Date Night) without retyping it from scratch every time.

Deliberately thin, by explicit request:
- No assignee on the bucket itself -- a chore is general, not tied to
  one person every time; who's doing it is chosen fresh each time a
  bucket is placed on a day, same as Reroll never locking in a
  particular assignee either.
- No automatic placement yet -- Schedule picks days manually. Each
  bucket can carry an Auto Schedule setting, "perWeek" (times per week,
  0-7, absent = 0), set from the gear popover; it's stored for a future
  Auto Schedule button to use, and nothing reads it to create tasks yet.

Plain JSON file, same pattern as recipe_suggest.py's suggested-id
tracking -- gitignored, read fresh on every call, no caching.
"""
import json
import uuid
from config import CHORE_BUCKETS_FILE


def _load():
    try:
        with open(CHORE_BUCKETS_FILE) as f:
            data = json.load(f)
            return data if isinstance(data, list) else []
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def _save(buckets):
    with open(CHORE_BUCKETS_FILE, "w") as f:
        json.dump(buckets, f, indent=2)


def get_buckets():
    return _load()


def get_bucket(bucket_id):
    return next((b for b in _load() if b["id"] == bucket_id), None)


def add_bucket(name, task_type="task", start_time=None, due_time=None):
    name = (name or "").strip()
    if not name:
        raise ValueError("bucket name can't be empty")
    bucket = {
        "id": str(uuid.uuid4()),
        "name": name,
        "type": "event" if task_type == "event" else "task",
        "startTime": start_time or None,
        "dueTime": due_time or None,
    }
    buckets = _load()
    buckets.append(bucket)
    _save(buckets)
    return bucket


def update_bucket(bucket_id, name=None, task_type=None):
    """Rename a saved item and/or change its Task/Event type (from the
    gear popover). Tasks already created from it keep their old title --
    a saved item is only a preset. Names stay unique, case-insensitively,
    since Quick Add/Schedule match typed names against them. Returns the
    updated bucket, or None if no bucket has that id."""
    buckets = _load()
    bucket = next((b for b in buckets if b["id"] == bucket_id), None)
    if bucket is None:
        return None
    if name is not None:
        name = name.strip()
        if not name:
            raise ValueError("name can't be empty")
        if any(b["id"] != bucket_id and b["name"].strip().lower() == name.lower() for b in buckets):
            raise ValueError(f'"{name}" is already saved')
        bucket["name"] = name
    if task_type is not None:
        bucket["type"] = "event" if task_type == "event" else "task"
    _save(buckets)
    return bucket


MAX_PER_WEEK = 7


def set_per_week(bucket_id, per_week):
    """Auto Schedule setting: how many times a week this item should
    happen (0 = not auto-scheduled). Only the setting is stored for now --
    nothing places tasks from it yet. Returns the updated bucket, or None
    if no bucket has that id."""
    per_week = int(per_week)
    if not 0 <= per_week <= MAX_PER_WEEK:
        raise ValueError(f"times per week must be 0-{MAX_PER_WEEK}")
    buckets = _load()
    for b in buckets:
        if b["id"] == bucket_id:
            b["perWeek"] = per_week
            _save(buckets)
            return b
    return None


def remove_bucket(bucket_id):
    buckets = [b for b in _load() if b["id"] != bucket_id]
    _save(buckets)
