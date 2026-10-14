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
import random
import mealdb_client
import mealie_weekly_plan as mwp
from config import SUGGESTED_RECIPE_IDS_FILE

# At most this many consecutive random pulls per click, looking for one
# not already suggested before -- TheMealDB can return the same meal
# twice in a row by chance; bounded rather than unbounded so one click
# can't spin forever if luck is bad.
MAX_ATTEMPTS_PER_SUGGEST = 4

# TheMealDB has no "Dinner" category of its own -- its categories split
# by protein/dish-type (Beef, Chicken, Seafood, Vegetarian, Pasta, ...)
# rather than meal-of-the-day. Excluding the clearly-not-dinner ones is
# simpler and more robust than trying to maintain an include-list of
# every category that counts as a main course.
NON_DINNER_CATEGORIES = {"Breakfast", "Dessert", "Starter", "Side"}


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


def _pick_random(suggested_ids, apply_dinner_filter):
    meal = None
    candidate = None
    for _ in range(MAX_ATTEMPTS_PER_SUGGEST):
        candidate = mealdb_client.fetch_random_meal()
        already_seen = candidate["idMeal"] in suggested_ids
        wrong_meal_type = apply_dinner_filter and candidate.get("strCategory") in NON_DINNER_CATEGORIES
        if not already_seen and not wrong_meal_type:
            meal = candidate
            break
    return meal or candidate


def _pick_filtered(area, category, suggested_ids, apply_dinner_filter):
    """filter.php only accepts one parameter per call, so a caller
    wanting both area and category filters it by whichever TheMealDB
    supports directly, then checks the other against each candidate's
    full looked-up detail (filter.php's own summaries don't include
    category/area at all)."""
    primary_area, primary_category = (area, None) if area else (None, category)
    summaries = mealdb_client.filter_meals(area=primary_area, category=primary_category)
    if not summaries:
        raise RuntimeError(f"TheMealDB has no meals matching that filter.")

    unseen = [s for s in summaries if s["idMeal"] not in suggested_ids]
    pool = unseen if unseen else summaries
    random.shuffle(pool)
    candidates = pool[:MAX_ATTEMPTS_PER_SUGGEST]

    meal = None
    fallback = None
    for summary in candidates:
        full = mealdb_client.lookup_meal(summary["idMeal"])
        fallback = fallback or full
        if area and category and full.get("strCategory") != category:
            continue
        if apply_dinner_filter and full.get("strCategory") in NON_DINNER_CATEGORIES:
            continue
        meal = full
        break
    return meal or fallback


def pick_meal(dinners_only=False, area=None, category=None, exclude_id=None):
    """Picks a candidate meal WITHOUT creating anything in Mealie yet --
    backs the Suggest popup's preview step, so the user can review a
    meal (name, photo, source/video link) and open it in a new tab
    before anything is actually added to their library. exclude_id lets
    "Try another" avoid immediately re-showing the meal just previewed,
    on top of the persistent already-suggested set.

    Prefers a meal never suggested before (tracked by TheMealDB's own
    stable meal ID) -- repeating a meal already in the library isn't a
    suggestion, it's just noise. An explicit category choice (e.g.
    "Dessert" from the popup) overrides dinners_only entirely -- the
    user asked for that category on purpose, so silently excluding it
    again would contradict their own choice; dinners_only still applies
    to a plain cuisine filter or pure random, where there's no explicit
    category to defer to."""
    suggested_ids = _load_suggested_ids()
    if exclude_id:
        suggested_ids = suggested_ids | {exclude_id}
    apply_dinner_filter = dinners_only and not category

    if area or category:
        return _pick_filtered(area, category, suggested_ids, apply_dinner_filter)
    return _pick_random(suggested_ids, apply_dinner_filter)


def confirm_meal(meal_id):
    """Creates the Mealie recipe for a meal the user already previewed
    and approved in the Suggest popup. Re-fetches fresh from TheMealDB
    by id rather than trusting whatever the browser sends back -- same
    "server, not client-held state, is the source of truth" reasoning
    used everywhere else in this codebase. Returns (recipe_id, name)."""
    meal = mealdb_client.lookup_meal(meal_id)

    ingredient_lines = [
        f"{measure} {ingredient}".strip()
        for measure, ingredient in mealdb_client.meal_ingredients(meal)
    ]
    instruction_steps = mealdb_client.meal_instructions(meal)
    source_url = meal.get("strSource") or meal.get("strYoutube") or None
    recipe_id, name = mwp.create_recipe_from_structured(
        meal["strMeal"], ingredient_lines, instruction_steps, org_url=source_url,
    )

    suggested_ids = _load_suggested_ids()
    suggested_ids.add(meal["idMeal"])
    _save_suggested_ids(suggested_ids)
    return recipe_id, name
