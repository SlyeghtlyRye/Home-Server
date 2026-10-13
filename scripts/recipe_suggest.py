"""
recipe_suggest.py -- the "Suggest" button: picks a random URL from a
curated, user-editable list of recipe websites and asks Mealie to
scrape+import it (mealie_weekly_plan.create_recipe_from_url(), the same
create-from-URL endpoint Mealie's own "Import from URL" button uses).

Not every site's markup scrapes cleanly -- suggest_recipe() tries a
handful of random sources and quietly moves on to the next on failure
rather than surfacing it, same "not everything will work" expectation
the user set up front. Each source's running success/failure count is
tracked and exposed to the Calendar Settings UI so a chronically-failing
site is visible (and removable) instead of silently wasting retries
forever.
"""
import json
import random
from config import RECIPE_SUGGESTION_SOURCES_FILE
import mealie_weekly_plan as mwp

# Seeded on first use from URLs already confirmed to import cleanly --
# not a hardcoded permanent list, just a sensible starting point. Add or
# remove freely via the settings UI from here on.
DEFAULT_SOURCES = [
    "https://www.cookincanuck.com/buffalo-chicken-stuffed-sweet-potatoes/",
    "https://moribyan.com/sushi-bake/",
    "https://www.loveandlemons.com/crispy-smashed-potatoes/",
    "https://www.eatingthaifood.com/thai-basil-chicken-recipe-pad-kra-pao-gai/",
    "https://www.dinneratthezoo.com/instant-pot-chili/",
]

# suggest_recipe() tries at most this many random sources per call --
# unbounded would mean a click could end up scraping every single source
# sequentially (each with its own network round-trip) as the list grows
# over time with more additions.
MAX_ATTEMPTS_PER_SUGGEST = 4


def _load():
    try:
        with open(RECIPE_SUGGESTION_SOURCES_FILE) as f:
            return json.load(f)
    except FileNotFoundError:
        sources = [{"url": u, "successes": 0, "failures": 0} for u in DEFAULT_SOURCES]
        _save(sources)
        return sources


def _save(sources):
    with open(RECIPE_SUGGESTION_SOURCES_FILE, "w") as f:
        json.dump(sources, f, indent=2)


def get_sources():
    return _load()


def add_source(url):
    url = url.strip()
    sources = _load()
    if any(s["url"] == url for s in sources):
        return
    sources.append({"url": url, "successes": 0, "failures": 0})
    _save(sources)


def remove_source(url):
    sources = _load()
    sources = [s for s in sources if s["url"] != url]
    _save(sources)


def _record_result(url, success):
    sources = _load()
    for s in sources:
        if s["url"] == url:
            s["successes" if success else "failures"] += 1
            break
    _save(sources)


def suggest_recipe():
    """Returns (recipe_id, recipe_name) from whichever source succeeds
    first. Raises RuntimeError only if every attempted source failed.

    Prefers sources that have never succeeded before -- a source that
    already succeeded once means that recipe already exists in the
    library, so picking it again is just re-suggesting something already
    had, not discovering anything new (the whole point of this button).
    Only falls back to the full pool, repeats included, once every
    source has succeeded at least once."""
    sources = _load()
    if not sources:
        raise RuntimeError("No recipe suggestion sources configured yet -- add one in Calendar Settings.")
    never_succeeded = [s for s in sources if s["successes"] == 0]
    pool = never_succeeded if never_succeeded else sources
    candidates = pool[:]
    random.shuffle(candidates)
    candidates = candidates[:MAX_ATTEMPTS_PER_SUGGEST]
    errors = []
    for source in candidates:
        url = source["url"]
        try:
            recipe_id, recipe_name = mwp.create_recipe_from_url(url)
            _record_result(url, success=True)
            return recipe_id, recipe_name
        except Exception as e:
            _record_result(url, success=False)
            errors.append(f"{url}: {e}")
    raise RuntimeError("Every suggestion source failed this time -- " + "; ".join(errors))
