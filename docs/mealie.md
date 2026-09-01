tags: mealie, backend, frontend

# Mealie Meal Planning

Automates weekly meal planning against a self-hosted Mealie instance:
calendar-based day selection, randomized recipe preview with reroll/manual
override, no-repeat memory, and per-week shopping list generation. The
dashboard tab also surfaces today's meal, a read-only calendar view, a
per-week recipe browser, and an editable shopping list -- all layered on
top of the same planning data.

## How it works

- `scripts/mealie_weekly_plan.py` talks to Mealie's API directly (recipes,
  meal plan entries, shopping lists, shopping list items)
- `scripts/trigger_server.py` exposes this over HTTP for the dashboard
- `js/mealie.js` is the frontend: meal-of-the-day, calendar (plan/view/edit),
  preview/commit flow, meals-of-the-week browser, shopping list

## Dashboard layout

The Mealie tab renders, top to bottom:

1. **Meal of the day** -- today's planned meal (if any), with a link to
   its full recipe (ingredients + steps) via the recipe detail modal.
2. **Calendar**, with a Plan/View/Edit toggle. All three modes share one
   floating panel docked to the bottom of the screen (`#mode-panel` /
   `renderModePanel()` in `js/mealie.js`) instead of each having its own
   inline block or centered modal -- it floats above the page (fixed
   position) so it stays on screen while the calendar and rest of the
   dashboard scroll underneath it. A small colored badge in the panel
   (blue/green/amber) names the active mode, and a grip handle in its
   top-right corner lets you drag it taller (persisted across sessions via
   `localStorage`); a close button, or each mode's own Cancel action,
   dismisses it.
   - *Plan* is the original flow -- click a day to select a 7-day block,
     which opens the panel showing selection controls (avoid-repeats,
     exclude Fridays, Plan/Clear/Cancel); "Plan Selected Days" swaps the
     panel to a preview of random picks per day, with reroll/override,
     then commit.
   - *View* is read-only -- click a single day to highlight it and open its
     meal (if any) in the panel, with a link to the recipe detail modal.
   - *Edit* opens the panel for a single day: change its recipe (same
     search/reroll combo as Plan's preview row), or swap it with another
     day via a date field in the same panel. A swap only rearranges the
     meal plan -- it never touches the shopping list, since that list can
     only grow (see `add_recipe_to_list`) and has no way to subtract a
     recipe's ingredients, so re-adding both sides on every swap would
     double-count ingredients for a same-week swap. Swapping onto an empty
     day acts as a move (the source day clears). Changing a day's recipe
     to something new *does* update the shopping list, same as Plan.
   Switching modes clears any in-progress plan selection and closes the
   panel; which mode's body renders is decided purely by which piece of
   state is currently set (`previewPicks`/`weekSelection` for Plan,
   `viewSelectedIso` for View, `editPick` for Edit).
3. **Meals of the week** -- a week picker (populated from
   `/data/available-weeks`, which lists any week with a planned meal plus
   the current week) driving a day-by-day list. Clicking a day with a
   planned meal opens that recipe's ingredients and steps in the same
   recipe detail modal used by meal-of-the-day and calendar View mode.
4. **Shopping lists** -- weekly grouping, plus inline editing: check items
   off, delete them, or add freeform items. All three write straight
   through to Mealie's shopping list (no local-only state), via
   `/api/shopping-item-{add,delete,check}`. A "By Meal / All Items" toggle
   (defaulting to By Meal) controls layout: By Meal groups each list's
   items under the recipe(s) that generated them (via Mealie's
   `recipeReferences` on each shopping list item, resolved to a recipe name
   server-side in `_fetch_list_detail`), with an "Other" section for
   freeform additions that have no recipe association. An item shared by
   two recipes (Mealie merges identical ingredient lines) appears under
   each relevant meal.

Recipe detail (ingredients/steps) is fetched by recipe ID via
`/data/recipe-detail`, which looks up the recipe's slug from the recipe
list (Mealie's detail endpoint is slug-keyed, not ID-keyed) before
fetching the full recipe.

## No-repeat logic

A recipe won't be picked again within 7 days of last use. History is tracked
in `scripts/meal_history.json` (gitignored -- personal data).

## Shopping lists

Generated per **Sunday-start week**, not per selection range. Re-planning
part of an already-planned week reuses the existing list rather than
duplicating it. Lists older than 21 days are auto-cleaned on each commit.

## Extending this feature

See the "Adding a new integration" section in README.md -- this feature is
the reference example that pattern was written from.
