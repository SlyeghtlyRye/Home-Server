"""
mealdb_client.py -- TheMealDB (https://www.themealdb.com), a free,
public recipe database with a dedicated "give me a random meal" endpoint,
used as the real recipe source for Mealie's Suggest button.

Replaces the earlier approach of scraping arbitrary user-picked blog
URLs through Mealie's generic page scraper -- confirmed repeatedly, live,
to be fragile in exactly the ways a purpose-built recipe API isn't: slow
pages timing out, page structures the scraper can't parse returning
400s, and (worst of all) a site's own homepage "succeeding" with
placeholder junk content that still passed a naive non-empty check.
TheMealDB returns clean, already-structured data directly -- no HTML
parsing involved at all, nothing to scrape, nothing to guess at.

Uses the API's free test key ("1", TheMealDB's own publicly documented
key for low-volume personal use) -- no signup, no secret to manage.
"""
import requests

BASE_URL = "https://www.themealdb.com/api/json/v1/1"
RANDOM_URL = f"{BASE_URL}/random.php"
LIST_URL = f"{BASE_URL}/list.php"
FILTER_URL = f"{BASE_URL}/filter.php"
LOOKUP_URL = f"{BASE_URL}/lookup.php"


def fetch_random_meal():
    """Returns TheMealDB's raw meal dict for one random meal. Raises if
    the request fails outright or the response is malformed -- callers
    (recipe_suggest.py) retry on a bounded number of random pulls, same
    as the old scraper-retry logic did for bad source URLs."""
    resp = requests.get(RANDOM_URL, timeout=15)
    resp.raise_for_status()
    data = resp.json()
    meals = data.get("meals")
    if not meals:
        raise RuntimeError("TheMealDB returned no meal")
    return meals[0]


def meal_ingredients(meal):
    """[(measure, ingredient), ...] -- TheMealDB spreads these across 20
    numbered strIngredientN/strMeasureN fields, most of them null/blank
    for any meal with fewer than 20 ingredients."""
    pairs = []
    for i in range(1, 21):
        ingredient = (meal.get(f"strIngredient{i}") or "").strip()
        measure = (meal.get(f"strMeasure{i}") or "").strip()
        if ingredient:
            pairs.append((measure, ingredient))
    return pairs


def list_areas():
    """Every cuisine/area TheMealDB knows about (e.g. 'Mexican',
    'Italian', 'Thai'), straight from its own list.php -- never
    hardcoded, so this can't drift out of date with what filter_meals()
    actually accepts."""
    resp = requests.get(LIST_URL, params={"a": "list"}, timeout=15)
    resp.raise_for_status()
    data = resp.json()
    return sorted(m["strArea"] for m in (data.get("meals") or []) if m.get("strArea"))


def list_categories():
    resp = requests.get(LIST_URL, params={"c": "list"}, timeout=15)
    resp.raise_for_status()
    data = resp.json()
    return sorted(m["strCategory"] for m in (data.get("meals") or []) if m.get("strCategory"))


def filter_meals(area=None, category=None):
    """Returns [{idMeal, strMeal, strMealThumb}, ...] matching ONE filter
    -- TheMealDB's filter.php only accepts a single filter parameter per
    call (can't combine area+category server-side), so a caller wanting
    both has to filter by one and then check the other after looking up
    full details. Summary data only, no ingredients/instructions --
    lookup_meal() is needed for those."""
    if area:
        params = {"a": area}
    elif category:
        params = {"c": category}
    else:
        raise ValueError("filter_meals() needs an area or a category")
    resp = requests.get(FILTER_URL, params=params, timeout=15)
    resp.raise_for_status()
    data = resp.json()
    return data.get("meals") or []


def lookup_meal(meal_id):
    """Full meal detail (ingredients/instructions included) by id --
    needed after filter_meals(), whose summaries don't include them."""
    resp = requests.get(LOOKUP_URL, params={"i": meal_id}, timeout=15)
    resp.raise_for_status()
    data = resp.json()
    meals = data.get("meals")
    if not meals:
        raise RuntimeError(f"TheMealDB has no meal with id {meal_id}")
    return meals[0]


def meal_instructions(meal):
    """Splits TheMealDB's single instructions blob into individual steps.
    It's normally newline-separated (plain \\n or \\r\\n); splitting on
    newlines alone handles the common case without trying to parse every
    possible numbering/formatting variant."""
    raw = (meal.get("strInstructions") or "").strip()
    steps = [s.strip() for s in raw.replace("\r\n", "\n").split("\n")]
    return [s for s in steps if s]
