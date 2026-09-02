# My Class Routine — Project Notes (resume file)

Paste this whole file into a new Claude chat (any account) to resume work instantly.

## What this is
A static HTML/CSS/JS website for **Varendra University CSE** class routine, built for
free hosting on **GitHub Pages**. Features: live "Up Next" card, weekly day-by-day
routine per Semester/Section, "Save as Default" (localStorage), today's-class
highlighting with a checkmark for completed classes, a lunch **Break** row (1:15–1:50 PM)
shown inline in the timeline, plus a **Room Finder** and **Teacher Finder** with
auto-suggest search across the whole week.

Owner: Momenur Rashid, CSE undergrad, Varendra University, Rajshahi.

## Files
- `index.html` — page structure (3 tabs: Routine / Room Finder / Teacher Finder)
- `style.css` — design tokens + layout (Fraunces display font + Plus Jakarta Sans body,
  light warm background, colorful per-day accents, buttery `cubic-bezier(.22,1,.36,1)`
  transitions on tab switches, card entrances, hovers)
- `script.js` — all logic (data loading/normalizing, rendering, finders, persistence)
- `data.js` — `FALLBACK_CLASSES`: the full master routine (550 rows, all 8 semesters,
  parsed from the user's Google Sheet as of the data the user pasted) embedded as JSON,
  used when the live API is unreachable
- `PROJECT_NOTES.md` — this file

## Data source (IMPORTANT — not yet wired up)
The user has **already deployed a Google Apps Script Web App** that serves the Google
Sheet as JSON, but **has not yet given the URL** to paste in.

In `script.js`, at the top:
```js
const CONFIG = {
  API_URL: "PASTE_YOUR_APPS_SCRIPT_WEB_APP_URL_HERE",
  ...
};
```
**Next step when resuming:** ask the user for their Apps Script Web App `/exec` URL and
paste it into `CONFIG.API_URL`. Until then, the site silently falls back to the embedded
`FALLBACK_CLASSES` in `data.js`, so it still works and looks fully live.

The loader (`loadData()` in script.js) is tolerant of two possible JSON shapes coming
back from the Apps Script endpoint:
1. Raw sheet mirror: `{Semester, Section, Day, Time, "Course Code", "Course Title", Teacher, Room}`
   where `Time` looks like `"Slot 2 10:05 AM - 11:10 AM"` (this is the sheet's real format)
2. Already-normalized: `{semester, section, day, slot, start, end, code, title, teacher, room}`

Both are handled by `normalizeRow()` — no code changes needed regardless of which shape
the Apps Script returns, as long as it's an array of row objects.

It also caches the last successful fetch in `localStorage` (`routine_data_cache_v1`) so
returning visitors see real data even before the network call resolves.

## Sheet structure assumed
Columns: `Semester | Section | Day | Time | Course Code | Course Title | Teacher | Room`
- `Time` format: `Slot <n> <h:mm AM/PM> - <h:mm AM/PM>`
- Fixed daily slot template (also hardcoded in `SLOT_TEMPLATE` in script.js, used to
  render gaps/breaks even for slots with no class that day):
  - Slot 1: 09:00–10:05 AM
  - Slot 2: 10:05–11:10 AM
  - Slot 3: 11:10 AM–12:15 PM
  - Slot 4: 12:15–01:15 PM
  - **Break: 01:15–01:50 PM**
  - Slot 5: 01:50–02:55 PM
  - Slot 6: 02:55–04:00 PM
- Week order used everywhere: Saturday, Sunday, Monday, Tuesday, Wednesday, Thursday
  (Friday is off and excluded from the day pills' "today" fallback)
- Timezone: `Asia/Dhaka` (used for "today", "up next", and the status line)

## Known open items / things to double check with the user
1. **Apps Script URL** — still needs to be supplied and pasted into `CONFIG.API_URL`.
2. Confirm the Apps Script's CORS behavior — Google Apps Script Web Apps deployed as
   "Execute as: Me" / "Who has access: Anyone" normally return JSON fine to `fetch()`,
   but if the user sees a fetch/CORS error in the console, the fix is usually to make
   sure the deployment is a new version with "Anyone" access (not "Anyone with a
   Google account").
3. Confirm whether the sheet ever has multiple sub-rows for one physical class (e.g. a
   2-hour lab spanning two consecutive slots) — currently each slot row is treated as
   its own timeline entry, so a 2-slot lab will show as two back-to-back cards with the
   same title, which is probably fine but worth confirming visually.
4. Room/teacher name formatting isn't fully standardized in the sheet (e.g. some rooms
   are just numbers like `509`, others are `106 DSAL`). The finders do a simple
   case-insensitive substring match, so this already works across both formats.

## Features added in v2 (after initial build)
- **Dark mode** — toggle button in header (sun/moon icon), persists to `localStorage`
  (`routine_theme`), defaults to system `prefers-color-scheme` on first visit.
- **Skeleton loading** — shimmering placeholder cards show while `loadData()` runs on
  first load (not on manual refresh, to avoid flicker).
- **Swipe gesture** — swiping left/right on the day-classes area on mobile moves to the
  next/previous day (Saturday→Thursday, Friday excluded).
- **Share/Export** — the share icon next to "Your schedule" screenshots the day's class
  list via `html2canvas` (loaded from cdnjs) and either opens the native share sheet
  (`navigator.share` with a file, on supporting mobile browsers) or downloads a PNG.
- **Up Next countdown** — live "Starts in N min" / "Ongoing · ends in N min" badge on the
  Up Next card, updates every 30s via `setInterval`, only shown when the upcoming class
  is today (not a future day).
- **Free Room Finder** — 4th tab. Pick a Day + Slot, see every known room minus the ones
  occupied by *any* semester/section at that day+slot. Room list is derived from
  `ALL_CLASSES`, so it stays in sync with whatever data is loaded.
- Gap/break-only-between-first-and-last-class logic (position-based, not time-based) —
  see `renderDayClasses()` in script.js. Empty slots before the first class or after the
  last one are never shown; internal gaps and the lunch break always are.

## Still open
- Apps Script Web App URL still needs to be pasted into `CONFIG.API_URL` (see above).
- PWA/offline install and push notifications for upcoming classes were discussed as
  ideas but not yet built — good next steps if the user wants them.

1. Push `index.html`, `style.css`, `script.js`, `data.js` to a GitHub repo.
2. Settings → Pages → deploy from the branch (root).
3. Done — no build step, pure static files.

## How to resume in a fresh chat
Paste this file's content, then say what you want changed (e.g. "here's my Apps
Script URL: ...", "change the color palette", "add a PDF export button", etc).
