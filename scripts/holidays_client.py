"""
holidays_client.py -- wraps the `holidays` PyPI package (computes public
holiday dates per country/year, including moving holidays like Easter or
Thanksgiving, fully offline -- no third-party API calls at runtime).
Requires `pip3 install holidays` on the host; not in a requirements.txt
since this repo doesn't have one -- every dependency here (including
`requests`) is installed the same informal, manual way.
"""
# A bare top-level `import holidays` would crash this whole module at
# import time if the package isn't installed yet -- and since
# trigger_server.py imports this module unconditionally at ITS top
# level, that would take down the entire backend (Mealie and Kanboard
# included), not just the holidays feature, exactly the class of failure
# this codebase has been burned by before (see js/config.js's history).
# Deferred/defensive instead: only get_holidays_in_range() (the one
# function that actually needs it) fails, with a clear message, and only
# when someone's actually configured a country and asked for holidays.
try:
    import holidays as holidays_lib
except ImportError:
    holidays_lib = None

from config import HOLIDAY_COUNTRY_FILE

# A curated subset of the library's full supported-country list --
# `holidays_lib.list_supported_countries()` gives ISO codes but not
# display names, and pulling in a second new dependency (e.g. pycountry)
# just for names isn't worth it for a short, rarely-changing list. Add
# more here if a household actually needs one that's missing; every code
# below is a real `holidays` library country code.
SUPPORTED_COUNTRIES = {
    "US": "United States",
    "CA": "Canada",
    "GB": "United Kingdom",
    "AU": "Australia",
    "NZ": "New Zealand",
    "IE": "Ireland",
    "DE": "Germany",
    "FR": "France",
    "IT": "Italy",
    "ES": "Spain",
    "PT": "Portugal",
    "NL": "Netherlands",
    "BE": "Belgium",
    "CH": "Switzerland",
    "AT": "Austria",
    "SE": "Sweden",
    "NO": "Norway",
    "DK": "Denmark",
    "FI": "Finland",
    "PL": "Poland",
    "JP": "Japan",
    "KR": "South Korea",
    "CN": "China",
    "IN": "India",
    "SG": "Singapore",
    "BR": "Brazil",
    "MX": "Mexico",
    "AR": "Argentina",
    "ZA": "South Africa",
    "IL": "Israel",
}


def get_supported_countries():
    return [{"code": code, "name": name} for code, name in sorted(SUPPORTED_COUNTRIES.items(), key=lambda kv: kv[1])]


def get_configured_country():
    """Reads the country fresh from disk on every call, same reasoning as
    kanboard_client.get_auth()/mwp.get_headers(): the setting can change
    via the dashboard's settings popover without needing
    mealie-trigger.service restarted, and this file simply not existing
    yet (nobody has configured a country) is a normal, expected state --
    returns "" rather than raising, callers treat that as "holidays
    feature not active yet"."""
    try:
        with open(HOLIDAY_COUNTRY_FILE) as f:
            return f.read().strip()
    except FileNotFoundError:
        return ""


def save_configured_country(country_code):
    with open(HOLIDAY_COUNTRY_FILE, "w") as f:
        f.write(country_code.strip())


def get_holidays_in_range(country_code, start, end):
    """Returns [{date, name}] (iso date strings) for every holiday in
    `country_code` falling within [start, end]. `years=` spans every
    calendar year touched by the range, not just start.year, since a
    range can cross a year boundary."""
    if holidays_lib is None:
        raise RuntimeError(
            "The 'holidays' Python package isn't installed -- run "
            "'pip3 install holidays' on the device, no restart needed, "
            "this is read fresh on the next request."
        )
    years = range(start.year, end.year + 1)
    country_holidays = holidays_lib.country_holidays(country_code, years=years)
    return [
        {"date": d.isoformat(), "name": name}
        for d, name in sorted(country_holidays.items())
        if start <= d <= end
    ]
