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

## Suggest popup -- filter, then review before committing

Clicking Suggest opens a popup with two steps:

1. **Filters** -- cuisine dropdown + category dropdown, both populated
   live from TheMealDB's own `list.php` (never hardcoded, so they can't
   drift out of date with what the API actually has). "Any"/"Any"
   behaves like pure random. A user explicitly asked for "suggest top
   meal by users" too, but TheMealDB's free API has no popularity/rating
   concept at all -- it's a static recipe database, not a social/rated
   platform -- so cuisine + category (both real, well-supported filters)
   replaced that idea instead of being left unaddressed.
2. **Review** -- TheMealDB picks a candidate meal, but *nothing is
   created in Mealie yet*. The popup shows its name, photo, and (when
   TheMealDB has one) a "View recipe" link that opens the original
   source page or YouTube video in a **new tab** (`target="_blank"`,
   doesn't navigate away from the popup or lose any state) so the meal
   can actually be reviewed before committing to it. From here: **Use
   This Meal** creates it in Mealie and assigns it to the day, **Try
   Another** re-picks within the same filters without closing the popup,
   **Cancel** backs out entirely.

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
  ingredient_lines, instruction_steps, org_url=None)` creates a new
  Mealie recipe directly from already-structured plain-text data:
  `create_recipe()` to get a fresh empty recipe, then a read-modify-write
  PUT setting `recipeIngredient`/`recipeInstructions` (and `orgURL` when
  given -- TheMealDB's `strSource`/`strYoutube`, so the recipe keeps a
  link back to where it came from even after the popup closes) -- same
  pattern as this file's existing `sync_recipe_ingredients()`, no
  scraping involved at all.
- `scripts/recipe_suggest.py` splits picking from creating, matching the
  popup's two steps:
  - `pick_meal(dinners_only=False, area=None, category=None,
    exclude_id=None)` -- picks a candidate meal *without creating
    anything in Mealie*. Pulls up to `MAX_ATTEMPTS_PER_SUGGEST` (4)
    candidates, preferring one that's both never suggested before
    (tracked by TheMealDB's own stable meal ID in
    `SUGGESTED_RECIPE_IDS_FILE`, default
    `/root/scripts/suggested_recipe_ids.json`, gitignored) and, when
    `dinners_only` applies, not in `NON_DINNER_CATEGORIES` (`Breakfast`,
    `Dessert`, `Starter`, `Side` -- TheMealDB has no "Dinner" category of
    its own, it splits by protein/dish-type instead, so this excludes
    the clearly-wrong ones rather than maintaining an include-list).
    `exclude_id` is how "Try Another" avoids immediately re-showing the
    meal just previewed. An explicit category choice overrides
    `dinners_only` entirely -- asking for "Dessert" on purpose shouldn't
    then get rejected for not being dinner.
  - `confirm_meal(meal_id)` -- called only after the user clicks "Use
    This Meal". Re-fetches fresh from TheMealDB by id rather than
    trusting whatever the browser sends back, then actually creates the
    Mealie recipe and records the id as suggested.
- `scripts/trigger_server.py` -- `GET /data/mealdb-areas` / `GET
  /data/mealdb-categories` back the popup's dropdowns. `POST
  /api/suggest-recipe-preview`, body `{dinnersOnly, area, category,
  excludeId}` (all optional), returns `{mealId, name, thumb, sourceUrl}`
  without touching Mealie. `POST /api/suggest-recipe-confirm`, body
  `{mealId}`, actually creates the recipe and returns
  `{recipeId, recipeName}`.

No user-managed source list exists any more -- there's nothing left to
curate once the source is a large public database instead of a handful
of hand-picked blog URLs.

## Frontend

- `js/mealie.js` -- `showSuggestOptionsModal()` reuses the same
  `#status-overlay`/`#status-modal` DOM core.js's own `showConfirmModal()`
  manipulates directly (appending a custom row the same way), rather
  than adding a new generic "form modal" primitive to core.js for the
  one place that currently needs it. Internally swaps the row's content
  between a filters step, a loading step, an error-with-retry step, and
  the review step (photo/name/link + Use This Meal/Try Another/Cancel)
  -- all within the same popup instance, no page navigation involved.
  Resolves to `{mealId}` only once "Use This Meal" is clicked, or `null`
  if cancelled at any point; both `suggestRecipe()`/`editSuggest()` await
  it first and bail out on cancel, before ever touching the loading
  state below or calling `/api/suggest-recipe-confirm`.
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
  settings UI) -- sent as `dinnersOnly` on every
  `/api/suggest-recipe-preview` call.
- `js/calendar-settings.js` -- back to holidays/sync only; the
  Mealie-only recipe-source-management section that used to live in
  this shared popover was removed along with the source-list concept.
