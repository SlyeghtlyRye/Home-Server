"""
recipe_cleanup.py -- one-off tidy-up of the Mealie recipe library.

  python3 scripts/recipe_cleanup.py                      # dry run: show the plan
  python3 scripts/recipe_cleanup.py --apply              # actually delete
  python3 scripts/recipe_cleanup.py --remove "Name" ...  # also drop these
  POST /api/recipe-cleanup {"apply": bool, "remove": [names]}  # same, over HTTP

Two things get removed:

1. Duplicates. Mealie saves a second recipe with a taken name as
   "Name (1)", "Name (2)", ... -- the same normalize_recipe_name() rule
   the dashboard now uses to refuse new duplicates groups them. One copy
   is kept per group: one that's on the meal plan if any, else the one
   without a " (N)" suffix, else the first. Meal plan entries that point
   at a copy being deleted are moved to the kept recipe first.
2. Anything named with --remove (every copy of it). Use it for entries
   that aren't meals at all, e.g. a blog homepage the old URL scraper
   saved as a "recipe". A --remove target that's on the meal plan is
   skipped, not deleted -- take it off the plan first.

Before deleting, each recipe's full JSON is saved to
scripts/recipe_backups/<timestamp>.json (gitignored), so anything removed
by mistake can be re-created by hand from it.
"""
import argparse
import json
import os
from datetime import date, datetime, timedelta

import mealie_weekly_plan as mwp

BACKUP_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "recipe_backups")


def all_mealplan_entries():
    resp = mwp.requests.get(
        f"{mwp.MEALIE_URL}/api/households/mealplans",
        headers=mwp.get_headers(),
        params={
            "start_date": (date.today() - timedelta(days=3 * 365)).isoformat(),
            "end_date": (date.today() + timedelta(days=3 * 365)).isoformat(),
            "perPage": -1,
        },
    )
    resp.raise_for_status()
    return resp.json()["items"]


def build_plan(recipes, entries, remove_names):
    planned = {}
    for e in entries:
        rid = (e.get("recipe") or {}).get("id") or e.get("recipeId")
        if rid:
            planned.setdefault(rid, []).append(e)

    groups = {}
    for r in recipes:
        groups.setdefault(mwp.normalize_recipe_name(r["name"]), []).append(r)

    remove_keys = {mwp.normalize_recipe_name(n) for n in remove_names}
    deletes, repoints, skipped = [], [], []

    for key, group in groups.items():
        if key in remove_keys:
            for r in group:
                if r["id"] in planned:
                    skipped.append((r, "on the meal plan"))
                else:
                    deletes.append((r, "not a meal (--remove)"))
            continue
        if len(group) < 2:
            continue
        keeper = (
            next((r for r in group if r["id"] in planned), None)
            or next((r for r in group if not mwp._COPY_SUFFIX.search(r["name"])), None)
            or group[0]
        )
        for r in group:
            if r["id"] == keeper["id"]:
                continue
            deletes.append((r, f'duplicate of "{keeper["name"]}"'))
            for e in planned.get(r["id"], []):
                repoints.append((e, keeper))

    missing = remove_keys - set(groups)
    return deletes, repoints, skipped, missing


def run(apply=False, remove_names=()):
    """Does the cleanup and returns its log as a list of lines. Also
    exposed as POST /api/recipe-cleanup (trigger_server.py), so it can be
    run from the dashboard host without SSH."""
    lines = []
    print = lines.append  # noqa: A001 -- collect output instead of printing

    recipes = mwp.get_recipe_summaries()
    entries = all_mealplan_entries()
    deletes, repoints, skipped, missing = build_plan(recipes, entries, remove_names)

    print(f"{len(recipes)} recipes, {len(entries)} meal plan entries.")
    for r, why in sorted(deletes, key=lambda x: x[0]["name"].lower()):
        print(f"  DELETE  {r['name']}  -- {why}")
    for e, keeper in repoints:
        print(f"  MOVE    {e['date']} meal plan entry -> {keeper['name']}")
    for r, why in skipped:
        print(f"  SKIP    {r['name']}  -- {why}")
    for key in sorted(missing):
        print(f"  ??      --remove \"{key}\" matched no recipe")
    print(f"{len(deletes)} to delete, {len(recipes) - len(deletes)} left.")

    if not apply:
        print("Dry run -- nothing changed. Re-run with --apply to do it.")
        return lines
    if not deletes:
        return lines

    for e, keeper in repoints:
        mwp.delete_mealplan_entry(e["id"])
        mwp.create_mealplan_entry(date.fromisoformat(e["date"]), keeper["id"])

    os.makedirs(BACKUP_DIR, exist_ok=True)
    backup = []
    for r, _ in deletes:
        resp = mwp.requests.get(f"{mwp.MEALIE_URL}/api/recipes/{r['slug']}", headers=mwp.get_headers())
        resp.raise_for_status()
        backup.append(resp.json())
    backup_path = os.path.join(BACKUP_DIR, datetime.now().strftime("%Y%m%d-%H%M%S") + ".json")
    with open(backup_path, "w") as f:
        json.dump(backup, f, indent=2)
    print(f"Backed up {len(backup)} recipes to {backup_path}")

    failed = 0
    for r, _ in deletes:
        resp = mwp.requests.delete(f"{mwp.MEALIE_URL}/api/recipes/{r['slug']}", headers=mwp.get_headers())
        if not resp.ok:
            failed += 1
            print(f"  FAILED deleting {r['name']}: {resp.status_code} {resp.text[:200]}")
    print(f"Deleted {len(deletes) - failed} recipes" + (f", {failed} failed." if failed else "."))
    return lines


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--apply", action="store_true", help="actually delete (default is a dry run)")
    ap.add_argument("--remove", nargs="*", default=[], metavar="NAME", help="also delete every copy of these recipes")
    args = ap.parse_args()
    for line in run(apply=args.apply, remove_names=args.remove):
        print(line)


if __name__ == "__main__":
    main()
