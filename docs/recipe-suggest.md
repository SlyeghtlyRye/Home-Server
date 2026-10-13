tags: recipe-suggest, mealie, backend, frontend

# Recipe Suggest

A "Suggest" button next to Reroll in Mealie's Plan/Edit flow: pulls a
real, ready-to-cook recipe from [TheMealDB](https://www.themealdb.com)'s
free random-meal API and creates it directly in Mealie, assigned
straight to that day -- same slot and role as Reroll, just pulling a
brand-new recipe instead of picking from your existing library.

## History -- why this isn't blog-scraping

The first version of this feature let the user curate a list of recipe
blog URLs, and used Mealie's generic `create/url` scraper (the same one
behind its own "Import from URL" button) to pull from them. Confirmed
live, repeatedly, to be unreliable in ways that don't show up until real
use:
- Real recipe pages routinely took longer than a 20s timeout to fetch
  and parse, while a bare homepage "succeeded" instantly.
- Some sites' page structure couldn't be parsed at all (a clean
  `400 Bad Request` from Mealie's own scraper).
- Worst case: given a non-recipe page (a site's homepage instead of one
  specific recipe), the scraper didn't fail -- it returned `200 OK` with
  the page's own title/tagline as a fake "recipe," and placeholder
  content in `recipeIngredient`/`recipeInstructions` passed a naive
  "is it non-empty" check, so junk entries slipped through as real
  suggestions.

None of these are fixable by tuning timeouts or validation harder --
they're inherent to asking a general-purpose HTML scraper to handle
arbitrary pages it was never built for. TheMealDB is a purpose-built
"give me one random meal" API: no HTML involved, no page structure to
guess at, data arrives already clean and structured. Switching to it
eliminated every one of the above failure modes at the root instead of
patching around them.

## Backend

- `scripts/mealdb_client.py` -- thin wrapper around
  `https://www.themealdb.com/api/json/v1/1/random.php` (the API's free,
  no-signup-required test key, fine for a household's low click volume).
  `fetch_random_meal()` returns one raw meal dict; `meal_ingredients()`
  collapses TheMealDB's 20 numbered `strIngredientN`/`strMeasureN`
  fields into `[(measure, ingredient), ...]` pairs; `meal_instructions()`
  splits its single instructions blob into individual steps on newlines.
- `scripts/mealie_weekly_plan.py` -- `create_recipe_from_structured(name,
  ingredient_lines, instruction_steps)` creates a new Mealie recipe
  directly from already-structured plain-text data: `create_recipe()` to
  get a fresh empty recipe, then a read-modify-write PUT setting
  `recipeIngredient`/`recipeInstructions` -- same pattern as this file's
  existing `sync_recipe_ingredients()`, no scraping involved at all.
- `scripts/recipe_suggest.py` -- `suggest_recipe()` pulls up to
  `MAX_ATTEMPTS_PER_SUGGEST` (4) random meals, preferring one never
  suggested before (tracked by TheMealDB's own stable meal ID in
  `SUGGESTED_RECIPE_IDS_FILE`, default
  `/root/scripts/suggested_recipe_ids.json`, gitignored) -- repeating a
  meal already in the library isn't a suggestion, just noise. Falls back
  to accepting a repeat only if every attempt in a batch lands on an
  already-seen meal.
- `scripts/trigger_server.py` -- `POST /api/suggest-recipe` (no body),
  returns `{recipeId, recipeName}`.

No user-managed source list exists any more -- there's nothing left to
curate once the source is a large public database instead of a handful
of hand-picked blog URLs.

## Frontend

- `js/mealie.js` -- `suggestRecipe(dateStr)`/`editSuggest()` are
  unchanged in shape from the original version (still just `POST
  /api/suggest-recipe` and assign the result to a day), but now show a
  **localized per-row loading state** instead of a blocking global
  modal: the specific day's row dims (`opacity` + `pointer-events: none`
  on that one `.preview-row`) and its recipe field shows "Suggesting..."
  in place of the input, while the rest of the week/panel stays fully
  interactive. Driven by `suggestingDate`/`editSuggesting` module state.
- `js/calendar-settings.js` -- back to holidays/sync only; the
  Mealie-only recipe-source-management section that used to live in
  this shared popover was removed along with the source-list concept.
