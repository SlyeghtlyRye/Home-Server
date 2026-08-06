import sys
import re
import json
import random
import requests
from collections import defaultdict
from datetime import date, timedelta
from config import HOST_IP, MEALIE_TOKEN_FILE

MEALIE_URL = f"http://{HOST_IP}:9000"
HISTORY_FILE = "/root/scripts/meal_history.json"

with open(MEALIE_TOKEN_FILE) as f:
    TOKEN = f.read().strip()

headers = {
    "Authorization": f"Bearer {TOKEN}",
    "Content-Type": "application/json",
}


def get_week_range(which):
    start = date.today() if which == "current" else date.today() + timedelta(days=7)
    end = start + timedelta(days=6)
    return start, end


def canonical_week_start(d):
    days_since_sunday = (d.weekday() + 1) % 7
    return d - timedelta(days=days_since_sunday)


def list_name_for(start):
    return f"Week of {start.isoformat()}"

def create_recipe(name):
    resp = requests.post(f"{MEALIE_URL}/api/recipes", headers=headers, json={"name": name})
    resp.raise_for_status()
    slug = resp.json()
    detail = requests.get(f"{MEALIE_URL}/api/recipes/{slug}", headers=headers)
    detail.raise_for_status()
    data = detail.json()
    return data["id"], data["name"]

def get_recipe_ids():
    resp = requests.get(f"{MEALIE_URL}/api/recipes", headers=headers, params={"perPage": 100})
    resp.raise_for_status()
    return [(r["id"], r["name"]) for r in resp.json()["items"]]


def create_mealplan_entry(entry_date, recipe_id):
    body = {
        "date": entry_date.isoformat(),
        "entryType": "dinner",
        "title": "",
        "text": "",
        "recipeId": recipe_id,
    }
    resp = requests.post(f"{MEALIE_URL}/api/households/mealplans", headers=headers, json=body)
    if not resp.ok:
        print(f"  FAILED creating entry for {entry_date}: {resp.status_code} {resp.text}")
    resp.raise_for_status()


def get_mealplan_entries(start, end):
    resp = requests.get(
        f"{MEALIE_URL}/api/households/mealplans",
        headers=headers,
        params={"start_date": start.isoformat(), "end_date": end.isoformat(), "perPage": 100},
    )
    resp.raise_for_status()
    return resp.json()["items"]


def get_planned_dates_in_range(start, end):
    entries = get_mealplan_entries(start, end)
    return sorted({e["date"] for e in entries})


def delete_mealplan_entry(entry_id):
    resp = requests.delete(f"{MEALIE_URL}/api/households/mealplans/{entry_id}", headers=headers)
    if not resp.ok:
        print(f"  FAILED deleting entry {entry_id}: {resp.status_code} {resp.text}")


def create_shopping_list(name, extras=None):
    body = {"name": name, "extras": extras or {}}
    resp = requests.post(f"{MEALIE_URL}/api/households/shopping/lists", headers=headers, json=body)
    resp.raise_for_status()
    return resp.json()["id"]


def find_shopping_list(name):
    resp = requests.get(f"{MEALIE_URL}/api/households/shopping/lists", headers=headers, params={"perPage": 100})
    resp.raise_for_status()
    for item in resp.json()["items"]:
        if item["name"] == name:
            return item["id"]
    return None


def delete_shopping_list(list_id):
    resp = requests.delete(f"{MEALIE_URL}/api/households/shopping/lists/{list_id}", headers=headers)
    if not resp.ok:
        print(f"  FAILED deleting list {list_id}: {resp.status_code} {resp.text}")


def add_recipe_to_list(list_id, recipe_id):
    body = [{"recipeId": recipe_id, "recipeIncrementQuantity": 1}]
    resp = requests.post(f"{MEALIE_URL}/api/households/shopping/lists/{list_id}/recipe", headers=headers, json=body)
    if not resp.ok:
        print(f"  FAILED adding recipe {recipe_id}: {resp.status_code} {resp.text}")


def load_history():
    try:
        with open(HISTORY_FILE) as f:
            return json.load(f)
    except FileNotFoundError:
        return {}


def save_history(hist):
    with open(HISTORY_FILE, "w") as f:
        json.dump(hist, f)


def filter_recent(recipes, history, cutoff_days=7):
    cutoff = date.today() - timedelta(days=cutoff_days)
    kept = []
    for rid, name in recipes:
        last = history.get(rid)
        if last is None or date.fromisoformat(last) < cutoff:
            kept.append((rid, name))
    return kept


def preview_dates(dates, avoid_repeats=True, overrides=None):
    overrides = overrides or {}
    recipes = get_recipe_ids()
    history = load_history() if avoid_repeats else {}
    pool = filter_recent(recipes, history) if avoid_repeats else recipes

    picks = []
    used_ids = set()
    for d in dates:
        d_iso = d.isoformat()
        if d_iso in overrides:
            rid = overrides[d_iso]
            name = next((n for i, n in recipes if i == rid), "(unknown)")
            picks.append({"date": d_iso, "recipeId": rid, "recipeName": name})
            used_ids.add(rid)
            continue
        candidates = [r for r in pool if r[0] not in used_ids]
        if not candidates:
            candidates = [r for r in recipes if r[0] not in used_ids]
        if not candidates:
            candidates = recipes
        rid, name = random.choice(candidates)
        used_ids.add(rid)
        picks.append({"date": d_iso, "recipeId": rid, "recipeName": name})
    return picks


def reroll_pick(target_date, avoid_repeats=True, exclude_ids=None):
    exclude_ids = set(exclude_ids or [])
    recipes = get_recipe_ids()
    history = load_history() if avoid_repeats else {}
    pool = filter_recent(recipes, history) if avoid_repeats else recipes
    candidates = [r for r in pool if r[0] not in exclude_ids]
    if not candidates:
        candidates = [r for r in recipes if r[0] not in exclude_ids]
    if not candidates:
        candidates = recipes
    rid, name = random.choice(candidates)
    return {"date": target_date, "recipeId": rid, "recipeName": name}


def commit_picks(picks):
    dates = sorted(date.fromisoformat(p["date"]) for p in picks)
    start, end = dates[0], dates[-1]

    date_set = {p["date"] for p in picks}
    existing = get_mealplan_entries(start, end)
    for e in existing:
        if e["date"] in date_set:
            delete_mealplan_entry(e["id"])

    history = load_history()
    for p in picks:
        create_mealplan_entry(date.fromisoformat(p["date"]), p["recipeId"])
        history[p["recipeId"]] = p["date"]
    save_history(history)

    by_week = defaultdict(list)
    for p in picks:
        wk = canonical_week_start(date.fromisoformat(p["date"]))
        by_week[wk].append(p)

    created_lists = []
    for wk_start in sorted(by_week.keys()):
        wk_picks = by_week[wk_start]
        list_name = list_name_for(wk_start)
        list_id = find_shopping_list(list_name)
        if not list_id:
            list_id = create_shopping_list(list_name, extras={"week_start": wk_start.isoformat()})
        for p in wk_picks:
            add_recipe_to_list(list_id, p["recipeId"])
        created_lists.append(list_name)

    cleanup_stale_lists()
    return {"lists": created_lists, "count": len(picks)}


def clear_dates(dates):
    dates = sorted(dates)
    date_strs = {d.isoformat() for d in dates}
    start, end = dates[0], dates[-1]
    entries = get_mealplan_entries(start, end)
    matching = [e for e in entries if e["date"] in date_strs]
    print(f"Clearing {len(matching)} of {len(entries)} entries in range ({start} - {end}) matching selected days.")
    for entry in matching:
        delete_mealplan_entry(entry["id"])

    weeks_touched = sorted({canonical_week_start(d) for d in dates})
    for wk_start in weeks_touched:
        wk_end = wk_start + timedelta(days=6)
        remaining = get_mealplan_entries(wk_start, wk_end)
        if not remaining:
            list_name = list_name_for(wk_start)
            list_id = find_shopping_list(list_name)
            if list_id:
                delete_shopping_list(list_id)
                print(f"Deleted shopping list: {list_name}")
    print("Done.")


def cleanup_stale_lists(days=21):
    resp = requests.get(f"{MEALIE_URL}/api/households/shopping/lists", headers=headers, params={"perPage": 100})
    resp.raise_for_status()
    cutoff = date.today() - timedelta(days=days)
    removed = []
    for item in resp.json()["items"]:
        m = re.match(r"^Week of (\d{4}-\d{2}-\d{2})$", item["name"])
        if m:
            list_date = date.fromisoformat(m.group(1))
            if list_date < cutoff:
                delete_shopping_list(item["id"])
                removed.append(item["name"])
    return removed


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: preview DATES | clear-dates DATES | cleanup")
        sys.exit(1)

    cmd = sys.argv[1]
    if cmd == "preview":
        dates = [date.fromisoformat(d) for d in sys.argv[2].split(",")]
        picks = preview_dates(dates)
        print(json.dumps(picks, indent=2))
    elif cmd == "clear-dates":
        dates = [date.fromisoformat(d) for d in sys.argv[2].split(",")]
        clear_dates(dates)
    elif cmd == "cleanup":
        removed = cleanup_stale_lists()
        print("Removed:", removed)
    else:
        print("Unknown command.")
