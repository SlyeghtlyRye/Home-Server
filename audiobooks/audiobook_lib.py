import json
import subprocess
import uuid
import os
from datetime import datetime

LIBRARY_FILE = "/root/audiobooks/library.json"
PROFILES_FILE = "/root/audiobooks/profiles.json"
LOCAL_FILES_DIR = "/root/audiobooks/local_files"
LOCAL_SHARED_FILE = "/root/audiobooks/local_shared.json"
LOCAL_PROGRESS_FILE = "/root/audiobooks/local_progress.json"


def load_library():
    try:
        with open(LIBRARY_FILE) as f:
            return json.load(f)
    except FileNotFoundError:
        return []


def save_library(data):
    with open(LIBRARY_FILE, "w") as f:
        json.dump(data, f, indent=2)


def load_profiles():
    try:
        with open(PROFILES_FILE) as f:
            return json.load(f)
    except FileNotFoundError:
        return []


def save_profiles(data):
    with open(PROFILES_FILE, "w") as f:
        json.dump(data, f, indent=2)


def load_local_shared():
    try:
        with open(LOCAL_SHARED_FILE) as f:
            return json.load(f)
    except FileNotFoundError:
        return []


def save_local_shared(data):
    with open(LOCAL_SHARED_FILE, "w") as f:
        json.dump(data, f, indent=2)


def load_local_progress():
    try:
        with open(LOCAL_PROGRESS_FILE) as f:
            return json.load(f)
    except FileNotFoundError:
        return {}


def save_local_progress(data):
    with open(LOCAL_PROGRESS_FILE, "w") as f:
        json.dump(data, f, indent=2)


def _progress_key(profile, local_id):
    return f"{profile}:{local_id}"


def add_profile(name):
    name = name.strip()
    if not name:
        raise ValueError("Profile name cannot be empty")
    profiles = load_profiles()
    if any(p.lower() == name.lower() for p in profiles):
        raise ValueError("A profile with that name already exists")
    profiles.append(name)
    save_profiles(profiles)
    return profiles


def rename_profile(old_name, new_name):
    new_name = new_name.strip()
    if not new_name:
        raise ValueError("New name cannot be empty")
    profiles = load_profiles()
    if old_name not in profiles:
        raise ValueError("Profile not found")
    if any(p.lower() == new_name.lower() and p != old_name for p in profiles):
        raise ValueError("A profile with that name already exists")
    profiles = [new_name if p == old_name else p for p in profiles]
    save_profiles(profiles)

    library = load_library()
    for b in library:
        if b.get("profile") == old_name:
            b["profile"] = new_name
    save_library(library)

    progress = load_local_progress()
    new_progress = {}
    for key, val in progress.items():
        prof, local_id = key.split(":", 1)
        new_progress[_progress_key(new_name if prof == old_name else prof, local_id)] = val
    save_local_progress(new_progress)

    return profiles


def delete_profile(name):
    profiles = load_profiles()
    if name not in profiles:
        raise ValueError("Profile not found")
    profiles = [p for p in profiles if p != name]
    save_profiles(profiles)

    library = [b for b in load_library() if b.get("profile") != name]
    save_library(library)

    progress = load_local_progress()
    progress = {k: v for k, v in progress.items() if not k.startswith(f"{name}:")}
    save_local_progress(progress)

    return profiles


def get_title(url):
    result = subprocess.run(
        ["yt-dlp", "--no-playlist", "--get-title", url],
        capture_output=True, text=True, timeout=30
    )
    return result.stdout.strip() or "Untitled"


def add_book(url, profile):
    if profile not in load_profiles():
        raise ValueError("Unknown profile")
    title = get_title(url)
    library = load_library()
    entry = {
        "id": str(uuid.uuid4())[:8],
        "profile": profile,
        "title": title,
        "source": "youtube",
        "url": url,
        "resume_seconds": 0,
        "stop_seconds": None,
        "date_added": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "last_played_at": None,
    }
    library.append(entry)
    save_library(library)
    return entry


# --- LOCAL STREAMS: shared file library, separate per-profile progress ---

def classify_media_type(filename):
    video_exts = {"mp4", "mkv", "webm", "mov", "avi", "m4v"}
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    return "video" if ext in video_exts else "audio"


def add_local_shared(title, filename, uploaded_by=None, book_id=None):
    shared = load_local_shared()
    entry = {
        "id": book_id or str(uuid.uuid4())[:8],
        "title": (title or "").strip() or "Untitled",
        "source": "local",
        "local_filename": filename,
        "media_type": classify_media_type(filename),
        "date_added": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "uploaded_by": uploaded_by,
    }
    shared.append(entry)
    save_local_shared(shared)
    return entry


def find_local_shared(local_id):
    for s in load_local_shared():
        if s["id"] == local_id:
            return s
    return None


def _merge_local_with_progress(shared_entry, profile):
    progress = load_local_progress().get(_progress_key(profile, shared_entry["id"]), {})
    merged = dict(shared_entry)
    merged["profile"] = profile
    merged["resume_seconds"] = progress.get("resume_seconds", 0)
    merged["stop_seconds"] = progress.get("stop_seconds")
    merged["resume_history"] = progress.get("resume_history", [])
    merged["last_played_at"] = progress.get("last_played_at")
    return merged


def local_shared_for_profile(profile):
    return [_merge_local_with_progress(s, profile) for s in load_local_shared()]


def _remove_local_file(shared_entry):
    filepath = os.path.join(LOCAL_FILES_DIR, shared_entry["local_filename"])
    try:
        os.remove(filepath)
    except OSError:
        pass


def delete_local_shared(local_id):
    shared = load_local_shared()
    entry = next((s for s in shared if s["id"] == local_id), None)
    if entry:
        _remove_local_file(entry)
    shared = [s for s in shared if s["id"] != local_id]
    save_local_shared(shared)

    progress = load_local_progress()
    progress = {k: v for k, v in progress.items() if not k.endswith(f":{local_id}")}
    save_local_progress(progress)

# --- end LOCAL STREAMS ---


def library_for_profile(profile):
    return [b for b in load_library() if b.get("profile") == profile]


def recently_played(profile, limit=5):
    youtube_books = [b for b in library_for_profile(profile) if b.get("last_played_at")]
    local_books = [b for b in local_shared_for_profile(profile) if b.get("last_played_at")]
    combined = youtube_books + local_books
    combined.sort(key=lambda b: b["last_played_at"], reverse=True)
    return combined[:limit]


def find_book(book_id):
    for b in load_library():
        if b["id"] == book_id:
            return b
    return None


def update_resume(profile, book_id, resume_seconds):
    library = load_library()
    for b in library:
        if b["id"] == book_id:
            b["resume_seconds"] = resume_seconds
            b["last_played_at"] = datetime.now().strftime("%Y-%m-%d %H:%M")
            save_library(library)
            return b
    shared = find_local_shared(book_id)
    if shared is not None:
        progress = load_local_progress()
        key = _progress_key(profile, book_id)
        entry = progress.get(key, {})
        entry["resume_seconds"] = resume_seconds
        entry["last_played_at"] = datetime.now().strftime("%Y-%m-%d %H:%M")
        progress[key] = entry
        save_local_progress(progress)
        return _merge_local_with_progress(shared, profile)
    raise ValueError("Book not found")


def set_stop(profile, book_id, stop_seconds):
    library = load_library()
    for b in library:
        if b["id"] == book_id:
            b["stop_seconds"] = stop_seconds
            save_library(library)
            return b
    shared = find_local_shared(book_id)
    if shared is not None:
        progress = load_local_progress()
        key = _progress_key(profile, book_id)
        entry = progress.get(key, {})
        entry["stop_seconds"] = stop_seconds
        progress[key] = entry
        save_local_progress(progress)
        return _merge_local_with_progress(shared, profile)
    raise ValueError("Book not found")


def record_checkpoint(profile, book_id):
    library = load_library()
    for b in library:
        if b["id"] == book_id:
            history = b.get("resume_history", [])
            current = b.get("resume_seconds", 0)
            now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            if not history or history[0]["seconds"] != current:
                history.insert(0, {"seconds": current, "time": now})
            b["resume_history"] = history[:3]
            save_library(library)
            return b
    shared = find_local_shared(book_id)
    if shared is not None:
        progress = load_local_progress()
        key = _progress_key(profile, book_id)
        entry = progress.get(key, {})
        history = entry.get("resume_history", [])
        current = entry.get("resume_seconds", 0)
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        if not history or history[0]["seconds"] != current:
            history.insert(0, {"seconds": current, "time": now})
        entry["resume_history"] = history[:3]
        progress[key] = entry
        save_local_progress(progress)
        return _merge_local_with_progress(shared, profile)
    raise ValueError("Book not found")


def revert_resume(profile, book_id, seconds):
    library = load_library()
    for b in library:
        if b["id"] == book_id:
            b["resume_seconds"] = seconds
            save_library(library)
            return b
    shared = find_local_shared(book_id)
    if shared is not None:
        progress = load_local_progress()
        key = _progress_key(profile, book_id)
        entry = progress.get(key, {})
        entry["resume_seconds"] = seconds
        progress[key] = entry
        save_local_progress(progress)
        return _merge_local_with_progress(shared, profile)
    raise ValueError("Book not found")


def delete_book(book_id):
    if find_book(book_id) is not None:
        library = [b for b in load_library() if b["id"] != book_id]
        save_library(library)
        return
    if find_local_shared(book_id) is not None:
        delete_local_shared(book_id)
        return
    raise ValueError("Book not found")


def build_resume_url(book):
    base = book["url"]
    seconds = int(book.get("resume_seconds", 0))
    if seconds <= 0:
        return base
    sep = "&" if "?" in base else "?"
    return f"{base}{sep}t={seconds}s"
