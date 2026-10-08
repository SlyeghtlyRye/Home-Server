"""
ical_builder.py -- hand-rolled RFC 5545 .ics generation, no library.
What this needs (day-level and simple timed events, no recurrence rules,
no attendees/timezones) is simple enough not to justify a dependency,
matching this project's established style elsewhere (plain `requests`,
no SDKs).

Timed events are written as floating local time (no TZID/UTC suffix) --
correct for this use case: everyone subscribing is a household member
viewing from the same local area, so "2pm" should just mean 2pm on
whatever device displays it, not require a timezone database entry.
"""
from datetime import datetime, timedelta, timezone


def _escape_text(s):
    # RFC 5545 section 3.3.11 -- escape backslash, semicolon, comma, and
    # turn real newlines into the literal two-character escape.
    s = str(s).replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,")
    return s.replace("\r\n", "\\n").replace("\n", "\\n").replace("\r", "")


def _fold(line):
    # RFC 5545 section 3.1 -- lines over 75 octets must be folded with a
    # CRLF + a single leading space. Titles here are short enough that
    # this rarely triggers, but a long one shouldn't produce an invalid file.
    if len(line) <= 75:
        return line
    parts = [line[:75]]
    rest = line[75:]
    while rest:
        parts.append(" " + rest[:74])
        rest = rest[74:]
    return "\r\n".join(parts)


def build_ics(calendar_name, events):
    """events: list of dicts, each either:
      {"uid", "title", "date": date}                      -- all-day
      {"uid", "title", "start": datetime, "end": datetime} -- timed
    `uid` should be stable across refreshes (e.g. derived from the
    source record's own id) so subscribing calendar apps recognize a
    re-fetched event as an update, not a duplicate."""
    dtstamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        f"PRODID:-//Home Dashboard//{_escape_text(calendar_name)}//EN",
        "CALSCALE:GREGORIAN",
        _fold(f"X-WR-CALNAME:{_escape_text(calendar_name)}"),
    ]
    for ev in events:
        lines.append("BEGIN:VEVENT")
        lines.append(f"UID:{ev['uid']}@home-dashboard")
        # DTSTAMP (creation time of this calendar object, not the event's
        # own time) is a required VEVENT property per RFC 5545 -- some
        # parsers reject an .ics file missing it, not just warn.
        lines.append(f"DTSTAMP:{dtstamp}")
        if "date" in ev:
            d = ev["date"]
            lines.append(f"DTSTART;VALUE=DATE:{d.strftime('%Y%m%d')}")
            lines.append(f"DTEND;VALUE=DATE:{(d + timedelta(days=1)).strftime('%Y%m%d')}")
        else:
            lines.append(f"DTSTART:{ev['start'].strftime('%Y%m%dT%H%M%S')}")
            lines.append(f"DTEND:{ev['end'].strftime('%Y%m%dT%H%M%S')}")
        lines.append(_fold(f"SUMMARY:{_escape_text(ev['title'])}"))
        lines.append("END:VEVENT")
    lines.append("END:VCALENDAR")
    return "\r\n".join(lines) + "\r\n"
