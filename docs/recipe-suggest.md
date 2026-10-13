tags: recipe-suggest, mealie, backend, frontend

# Recipe Suggest

A "Suggest" button next to Reroll in Mealie's Plan/Edit flow: instead of
picking from your existing recipe library, it imports a brand-new recipe
from a random site on a curated, user-editable list of recipe websites,
and assigns it directly to that day -- same slot and role as Reroll,
just pulling from the web instead of what's already in Mealie.

## Scope, decided up front

- **Not every site will import cleanly, and that's expected.** Mealie's
  scraper depends on the source page having parseable `schema.org`
  Recipe markup -- most food blogs have it, some don't. Suggest tries a
  few random sources per click and quietly moves to the next on failure
  rather than surfacing it -- the user only ever sees a result once
  something actually worked (or every attempt failed).
- **The source list is user-editable**, not a fixed set -- managed from
  Mealie's own gear-icon Calendar Settings popover (the same one that
  hosts holidays/sync), listing each source's running success/failure
  count so a chronically-failing site is visible and removable instead
  of silently wasting retries forever.
- Seeded on first use with 5 URLs already confirmed to import cleanly
  (see `recipe_suggest.DEFAULT_SOURCES`) -- not a permanent hardcoded
  list, just a sensible starting point.

## Backend

- `scripts/mealie_weekly_plan.py` -- `create_recipe_from_url(url)` calls
  Mealie's `POST /api/recipes/create/url` (the same endpoint Mealie's
  own "Import from URL" button uses, confirmed via the API's own
  create-then-return-slug shape), then re-fetches the full recipe by
  slug -- same create-then-re-fetch idiom as this file's existing
  `create_recipe()`, consistent with this project's established lesson
  that a create endpoint's own return value isn't reliably trustworthy
  on its own.
- `scripts/recipe_suggest.py` -- the source list and retry logic:
  - `get_sources()`/`add_source()`/`remove_source()` -- backed by
    `RECIPE_SUGGESTION_SOURCES_FILE` (default
    `/root/scripts/recipe_suggestion_sources.json`, gitignored, same
    "read fresh every call, not `.env`-cached" pattern as
    `HOLIDAY_COUNTRY_FILE`). Self-seeds with `DEFAULT_SOURCES` on first
    read if the file doesn't exist yet.
  - `suggest_recipe()` -- shuffles the source list, tries at most
    `MAX_ATTEMPTS_PER_SUGGEST` (4) of them in order, recording a
    success/failure against each attempted URL as it goes. Returns the
    first success; raises only if every attempt in that batch failed.
    Capped rather than unbounded specifically so one click can't turn
    into a sequential scrape of the entire list as it grows over time.
- `scripts/trigger_server.py` -- `GET /data/recipe-suggestion-sources`,
  `POST /api/add-recipe-suggestion-source` / `.../remove-recipe-suggestion-source`,
  `POST /api/suggest-recipe` (no body -- returns `{recipeId, recipeName}`
  from whichever source succeeded).

## Frontend

- `js/calendar-settings.js` -- the source list management UI lives in
  the *shared* Calendar Settings popover, gated on `calendarKey ===
  'mealie'` (same branch-on-calendarKey pattern `icalUrl()` already uses
  for its own Mealie-vs-Kanboard feed path) -- Kanboard has no recipe
  concept, so its popover never renders this section even though both
  calendars load the same cached data.
- `js/mealie.js` -- `suggestRecipe(dateStr)`/`editSuggest()` mirror
  `rerollDay()`/`editReroll()` exactly in shape, but show their own
  loading status (`showStatusModal(..., 'loading')`) since this is a
  real network round-trip to an external site through Mealie's scraper,
  not an instant pick from the existing library like Reroll is.
