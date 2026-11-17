"""
chore_buckets.py -- reusable named presets ("buckets") for Kanboard's
Schedule flow: a chore or event the household creates often (Sweeping,
Trash, Date Night) without retyping it from scratch every time.

Deliberately thin, by explicit request:
- No assignee on the bucket itself -- a chore is general, not tied to
  one person every time; who's doing it is chosen fresh each time a
  bucket is placed on a day, same as Reroll never locking in a
  particular assignee either.
- No automatic cadence/recurrence (no "this bucket always wants
  Tue+Fri") -- Schedule picks days manually (same direct multi-select
  as the rest of this calendar), then picks a bucket per day. An
  auto-cadence layer could build on top of this later if wanted, but
  isn't part of this first pass.

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


def remove_bucket(bucket_id):
    buckets = [b for b in _load() if b["id"] != bucket_id]
    _save(buckets)
