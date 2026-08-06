tags: streams, backend, frontend

# Streams (media player)

A Netflix-style multi-profile media player supporting both YouTube links
(metadata via yt-dlp, no download) and local file uploads (audio or video),
with resume tracking and a shared player abstraction.

## Multi-profile system

Each profile has fully separate watch history, remembered per-browser via
localStorage. Local file uploads are shared across all profiles (everyone
can see and play them), but resume position is tracked per-profile.

## Player abstraction

`js/streams.js` wraps both YT.Player and native `<audio>`/`<video>`
elements behind an identical interface (`getCurrentTime`, `seekTo`,
`pauseVideo`, `destroy`). Every other feature -- autosave, checkpoints,
sleep timer, chapters -- works identically regardless of source. This is
the single most important design decision in this module; if you add a
third media source later, wrap it the same way rather than branching
feature code on source type.

## Resume tracking

Position autosaves every 15s while playing, plus on pause/end. A 3-entry
checkpoint history is kept per stream (recorded each time you open it),
with one-click revert.

## Known limitation

Chapters only exist for YouTube sources (from video metadata) -- local
files have no chapter source.
