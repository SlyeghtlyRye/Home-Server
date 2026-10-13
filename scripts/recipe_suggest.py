"""
recipe_suggest.py -- the "Suggest" button: pulls a real, ready-to-cook
recipe from TheMealDB's free random-meal API (mealdb_client.py) and
creates it directly in Mealie from the already-structured data it
returns (mealie_weekly_plan.create_recipe_from_structured()).

Earlier version of this feature let the user curate a list of blog URLs
and scraped them through Mealie's generic page scraper -- confirmed
repeatedly, live, to be unreliable (slow-page timeouts, 400s on
unparseable page structures, and a site's own homepage "succeeding"
with placeholder junk content that passed a naive non-empty check).
TheMealDB is purpose-built for exactly this "random meal" use case and
returns clean structured data directly, so none of those failure modes
apply -- no user-managed source list is needed any more either.
"""
import json
import mealdb_client
import mealie_weekly_plan as mwp
from config import SUGGESTED_RECIPE_IDS_FILE

# At most this many consecutive random pulls per click, looking for one
# not already suggested before -- TheMealDB can return the same meal
# twice in a row by chance; bounded rather than unbounded so one click
# can't spin forever if luck is bad.
MAX_ATTEMPTS_PER_SUGGEST = 4


def _load_suggested_ids():
    try:
        with open(SUGGESTED_RECIPE_IDS_FILE) as f:
            data = json.load(f)
            return set(data) if isinstance(data, list) else set()
    except (FileNotFoundError, json.JSONDecodeError):
        return set()


def _save_suggested_ids(ids):
    with open(SUGGESTED_RECIPE_IDS_FILE, "w") as f:
        json.dump(sorted(ids), f, indent=2)


def suggest_recipe():
    """Returns (recipe_id, recipe_name) for a freshly-created recipe.
    Prefers a meal never suggested before (tracked by TheMealDB's own
    stable meal ID) -- repeating a meal already in the library isn't a
    suggestion, it's just noise. Falls back to accepting a repeat only
    if every attempt in this batch landed on an already-seen meal."""
    suggested_ids = _load_suggested_ids()
    meal = None
    for _ in range(MAX_ATTEMPTS_PER_SUGGEST):
        candidate = mealdb_client.fetch_random_meal()
        if candidate["idMeal"] not in suggested_ids:
            meal = candidate
            break
    if meal is None:
        meal = candidate

    ingredient_lines = [
        f"{measure} {ingredient}".strip()
        for measure, ingredient in mealdb_client.meal_ingredients(meal)
    ]
    instruction_steps = mealdb_client.meal_instructions(meal)
    recipe_id, name = mwp.create_recipe_from_structured(meal["strMeal"], ingredient_lines, instruction_steps)

    suggested_ids.add(meal["idMeal"])
    _save_suggested_ids(suggested_ids)
    return recipe_id, name
