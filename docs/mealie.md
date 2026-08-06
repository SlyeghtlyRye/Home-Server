tags: mealie, backend, frontend

# Mealie Meal Planning

Automates weekly meal planning against a self-hosted Mealie instance:
calendar-based day selection, randomized recipe preview with reroll/manual
override, no-repeat memory, and per-week shopping list generation.

## How it works

- `scripts/mealie_weekly_plan.py` talks to Mealie's API directly (recipes,
  meal plan entries, shopping lists)
- `scripts/trigger_server.py` exposes this over HTTP for the dashboard
- `js/mealie.js` is the frontend: calendar UI, preview/commit flow

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
