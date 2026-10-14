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

## Suggest options popup

Clicking Suggest opens a small popup (cuisine dropdown + category
dropdown, both populated live from TheMealDB's own `list.php` -- never
hardcoded, so they can't drift out of date with what the API actually
has) before pulling a meal. "Any"/"Any" behaves exactly like the
original pure-random version. A user explicitly asked for "suggest top
meal by users" too, but TheMealDB's free API has no popularity/rating
concept at all -- it's a static recipe database, not a social/rated
platform -- so cuisine + category (both real, well-supported filters)
replaced that idea instead of being left unaddressed.

`filter.php` only accepts one parameter per call (can't combine area +
category server side), so picking both filters by whichever TheMealDB
supports directly and checks the other against each candidate's full
looked-up detail afterward (`recipe_suggest._pick_filtered()`).

## Backend

- `scripts/mealdb_client.py` -- thin wrapper around TheMealDB's free,
  no-signup-required test key (`1`, fine for a household's low click
  volume). `fetch_random_meal()` (`random.php`) returns one raw meal
  dict; `list_areas()`/`list_categories()` (`list.php?a=list`/`?c=list`)
  back the popup's dropdowns; `filter_meals()` (`filter.php`) returns
  meal summaries (id/name/thumb only) matching one area or category;
  `lookup_meal()` (`lookup.php`) gets full detail (ingredients/
  instructions included) by id, needed after filter_meals() since its
  summaries don't carry them. `meal_ingredients()` collapses TheMealDB's
  20 numbered `strIngredientN`/`strMeasureN` fields into
  `[(measure, ingredient), ...]` pairs; `meal_instructions()` splits its
  single instructions blob into individual steps on newlines.
- `scripts/mealie_weekly_plan.py` -- `create_recipe_from_structured(name,
  ingredient_lines, instruction_steps)` creates a new Mealie recipe
  directly from already-structured plain-text data: `create_recipe()` to
  get a fresh empty recipe, then a read-modify-write PUT setting
  `recipeIngredient`/`recipeInstructions` -- same pattern as this file's
  existing `sync_recipe_ingredients()`, no scraping involved at all.
- `scripts/recipe_suggest.py` -- `suggest_recipe(dinners_only=False)`
  pulls up to `MAX_ATTEMPTS_PER_SUGGEST` (4) random meals, preferring one
  that's both never suggested before (tracked by TheMealDB's own stable
  meal ID in `SUGGESTED_RECIPE_IDS_FILE`, default
  `/root/scripts/suggested_recipe_ids.json`, gitignored -- repeating a
  meal already in the library isn't a suggestion, just noise) and, when
  `dinners_only` is set, not in `NON_DINNER_CATEGORIES` (`Breakfast`,
  `Dessert`, `Starter`, `Side`). TheMealDB has no "Dinner" category of
  its own -- it splits by protein/dish-type instead -- so this excludes
  the clearly-wrong categories rather than trying to maintain an
  include-list of every category that counts as a main course. Falls
  back to accepting a non-matching meal only if every attempt in a batch
  fails one or both checks.
- `scripts/trigger_server.py` -- `GET /data/mealdb-areas` / `GET
  /data/mealdb-categories` back the popup's dropdowns. `POST
  /api/suggest-recipe`, body `{dinnersOnly, area, category}` (all
  optional), returns `{recipeId, recipeName}`.

No user-managed source list exists any more -- there's nothing left to
curate once the source is a large public database instead of a handful
of hand-picked blog URLs.

## Frontend

- `js/mealie.js` -- `showSuggestOptionsModal()` reuses the same
  `#status-overlay`/`#status-modal` DOM core.js's own `showConfirmModal()`
  manipulates directly (appending a custom row the same way), rather
  than adding a new generic "form modal" primitive to core.js for the
  one place that currently needs selects instead of a plain message.
  Resolves to `{area, category}` or `null` if cancelled; both
  `suggestRecipe()`/`editSuggest()` await it first and bail out on
  cancel, before ever touching the loading state below.
- `suggestRecipe(dateStr)`/`editSuggest()` show a
  **localized per-row loading state** instead of a blocking global
  modal: the specific day's row dims (`opacity` + `pointer-events: none`
  on that one `.preview-row`) and its recipe field shows an animated
  "Suggesting..." placeholder (pulsing text + an indeterminate sliding
  progress bar, `.suggesting-bar`) in place of the input, while the rest
  of the week/panel stays fully interactive -- Confirm/Cancel are the
  one exception, disabled while any row is suggesting so they can't act
  on a still-updating `previewPicks`. Driven by
  `suggestingDate`/`editSuggesting` module state. A non-JSON response
  (e.g. an nginx proxy timeout serving its own HTML error page) shows a
  plain-language message instead of a raw `SyntaxError` dump.
- `shouldSuggestDinnersOnly()` reads a per-browser localStorage flag
  (`mealie_suggestDinnersOnly`), set via an inline checkbox in both the
  Preview panel and the Edit panel (not the gear-icon Calendar Settings
  popover -- this is toggled in the same moment as clicking Suggest
  itself, so it stays inline rather than requiring a trip to a separate
  settings UI) -- sent as `dinnersOnly` on every `/api/suggest-recipe`
  call.
- `js/calendar-settings.js` -- back to holidays/sync only; the
  Mealie-only recipe-source-management section that used to live in
  this shared popover was removed along with the source-list concept.
