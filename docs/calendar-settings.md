tags: calendar-settings, mealie, kanboard, backend, frontend

# Calendar Settings: Holidays + iCal/Google Calendar Sync

A small gear-icon settings popover on both Mealie's and Kanboard's
calendar headers: show/hide a holiday overlay, which country's holidays
to show (one setting, shared by both calendars), and a subscribable
`.ics` feed URL per calendar.

## Scope, decided up front

- **The feed is a live subscribable URL**, not a one-time export button
  -- paste it into Apple Calendar/Outlook/Thunderbird once, it keeps
  refreshing.
- **Location is country-only** (no state/province), using the
  `holidays` PyPI package -- computes correct dates per country/year,
  including moving holidays (Easter, Thanksgiving), fully offline, no
  third-party API calls at runtime.
- **LAN/Tailscale-only, not publicly exposed.** Google Calendar's own
  "From URL" subscribe feature polls from Google's servers on the public
  internet, which can't reach this device's LAN/Tailscale-only address --
  known and accepted. Apple Calendar/Outlook/Thunderbird on the user's
  own devices (phone, laptop) work fine subscribing while on the same
  network. Publicly exposing the feed (e.g. Tailscale Funnel) is
  explicitly out of scope.

## New Python dependency

`holidays` (plus the pre-existing `requests`) is installed automatically
by `reset_manager.py`'s `ensure_python_deps()`, run as part of both
first-time setup and factory reset -- this repo has no
`requirements.txt`; every dependency is installed directly into the
host's system Python the same informal way, just no longer by hand.

A device set up *before* this existed (or before `holidays` was added
to `PYTHON_DEPENDENCIES`) needs a one-time manual catch-up:
`apt-get install -y python3-pip` if `pip3`/`python3 -m pip` isn't
present yet, then `python3 -m pip install --break-system-packages
holidays`, then `systemctl restart mealie-trigger.service` -- the
package import happens once at that service's startup, so installing it
alone doesn't take effect until the service restarts.

**The import is defensive, not a bare top-level `import`.**
`scripts/holidays_client.py` wraps it in `try/except ImportError`,
falling back to `holidays_lib = None` -- a bare import would crash this
whole module at import time if the package isn't installed yet, and
since `trigger_server.py` imports this module unconditionally at ITS
top level, that would take down the *entire* backend (Mealie and
Kanboard included), not just the holidays feature. Only
`get_holidays_in_range()` (the one function that actually needs the
library) fails, with a clear message telling you to install it -- and
only when someone's actually configured a country and asked for
holidays.

## The country setting is a file, not `.env`

Unlike most global config in this repo (`HOST_IP`, `TIMEZONE`, etc.),
the holiday country is **not** stored in `.env`. `scripts/config.py`
caches every value it reads once, at process import time -- updating
`.env` while `mealie-trigger.service` is already running wouldn't take
effect until the service restarts, which is bad UX for a "change a
setting" feature that should feel instant. Instead, `HOLIDAY_COUNTRY_FILE`
(default `/root/scripts/holiday_country.txt`, gitignored, same pattern
as `MEALIE_TOKEN_FILE`/`KANBOARD_TOKEN_FILE`) just holds the raw country
code, and `holidays_client.get_configured_country()` re-reads it fresh
on every call -- a saved change is live on the very next request.

## Backend

- `scripts/holidays_client.py` -- `SUPPORTED_COUNTRIES` (a curated ~30
  common countries; the library's own `list_supported_countries()` gives
  codes but not display names, and a second dependency like `pycountry`
  isn't worth it for a short, rarely-changing list), `get_holidays_in_range()`,
  `get_configured_country()`/`save_configured_country()`. `DEFAULT_SUBDIVISION`
  maps a country code to a specific province/state passed to the
  `holidays` library -- with none given, the library returns only
  holidays common to *every* subdivision, which for Canada silently
  drops Thanksgiving (not statutory in NB/NS). Caught on a real device
  with `country=CA` configured: `/data/holidays` returned an empty list
  for October despite everything else working. Since this is a household
  overlay, not a payroll tool, a single representative subdivision (`ON`
  for Canada) beats technical completeness. Add more entries if another
  supported country turns out to have the same gap.
- `scripts/ical_builder.py` -- hand-rolled RFC 5545 `.ics` generation, no
  library. What this needs (day-level and simple timed events, no
  recurrence rules, no attendees/timezones) is simple enough not to
  justify a dependency, matching this project's established style
  elsewhere. Timed events are written as **floating local time** (no
  `TZID`/UTC suffix) -- correct here since everyone subscribing is a
  household member viewing from the same local area. `DTSTAMP` is
  included on every `VEVENT` since it's a required RFC 5545 property,
  not just good practice -- some parsers reject a feed missing it.
- `scripts/trigger_server.py` new endpoints, same `TRIGGER_SECRET`-gated
  pattern as everything else:
  - `GET /data/holiday-countries`, `GET /data/holiday-settings`,
    `POST /api/save-holiday-country`
  - `GET /data/holidays?start&end` -- powers the on-screen overlay in
    both calendars
  - `GET /data/mealie-ical` / `GET /data/kanboard-ical` -- the
    subscribable feeds, `Content-Type: text/calendar`, a 60-day-back /
    180-day-forward rolling window (wide enough to be a useful
    subscription, not just "this month"), merging in holidays when
    called with `?holidays=1`
  - `_kanboard_task_event()` turns a task into a timed `VEVENT` when it
    has a start and/or due time, or an all-day one when it has neither --
    a task with only one of the two gets a 1-hour block anchored to
    whichever time it has (a bare deadline needs *some* duration to
    render as a timed event; 1 hour is a reasonable default, not a
    meaningful commitment).

## Frontend -- shared, not duplicated

Unlike the floating mode-panel (which stayed duplicated between
`js/mealie.js` and `js/kanboard.js` because Mealie's was already mature
and risky to touch), this was a *brand new* feature in both calendars --
built once, in `js/calendar-settings.js`, imported by both.

**Exports plain render/handler functions, not its own DOM listeners.**
Each calendar's `renderCalendar()` rebuilds its header's `innerHTML`
wholesale on every render (month navigation, day clicks, holiday toggle,
anything) -- a listener attached directly to the popover's own elements
would get wiped out the next render. Instead, each calendar's *existing*
delegated click/change listener (already attached to its own stable
`#calendar-container`/`#kb-calendar-container`) calls
`handleClick()`/`handleChange()` here, the same
"one delegated listener, dispatch by `data-action`" pattern used
everywhere else in this codebase. `renderSettingsGearHtml()` stays
synchronous by reading from a module-level cache
(`loadCalendarSettingsData()`, called once per calendar's `onRender`,
same pattern as `allRecipes`/`allPeople`) rather than fetching at render
time.

The country setting and its loaded-options cache are genuinely global --
both calendars import the *same* module instance (ES modules are
singletons), so saving a country from either calendar's popover updates
the value the other one sees too, with no extra wiring needed.

"Show holidays" is a **per-browser, per-calendar** `localStorage` flag
(`${calendarKey}_showHolidays`), same pattern as `defaultExcludedWeekdays`
-- it also decides whether the copyable feed URL includes `&holidays=1`.

## Known gaps (intentional, for a later pass)

- No way to subscribe from Google Calendar's own web UI without
  additionally exposing the feed publicly (e.g. Tailscale Funnel) --
  explicitly out of scope for this pass, see above.
- Clicking outside an open settings popover only closes it if the click
  lands somewhere inside that calendar's own container -- clicking
  entirely elsewhere on the page (e.g. the mode toggle) leaves it open.
  Not wired to a document-wide click-away listener; minor, low priority.
- No validation yet that a real subscribed calendar app (not just a
  manual `.ics` fetch) actually refreshes and renders events correctly
  end to end -- worth doing once this is deployed.
