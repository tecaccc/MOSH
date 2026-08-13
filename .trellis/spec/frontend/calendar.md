# Calendar & Datetime Conventions

> Conventions for the Calendar feature (subtask `08-12-calendar`) and shared date/time helpers.

## Two time-value formats

Every event stores `start_at`/`end_at` in one of two formats. **Never mix helper families**:

| Mode | Storage | Input control | Conversion |
|------|---------|---------------|------------|
| Timed | ISO8601 UTC (`...T09:00:00Z`) | `<input type="datetime-local">` | `toLocalInput` / `fromLocalInput` |
| All-day | date-only `YYYY-MM-DD` | `<input type="date">` | **no timezone conversion** — value is the storage value |

`data.all_day === true` selects all-day mode. The all-day flag and the input control type must stay in sync; `EventEditor.onToggleAllDay` converts the start/end values between formats on toggle (timed→all-day takes the local date portion; all-day→timed appends `T09:00`/`T10:00`).

Helpers live in `src/lib/datetime.ts`: `toLocalInput`, `fromLocalInput`, `toDateOnly`, `formatDate`, `formatDateTime`, `formatTime`. **`toDateOnly` is the bridge** — it passes date-only through unchanged and extracts the local date from ISO/datetime-local, so per-day overlap math works uniformly for both formats.

## Calendar grid math

`src/lib/calendar-grid.ts` (pure, no Svelte). **Week starts Monday** (user-confirmed). Anchor everything on date-only `YYYY-MM-DD`:

- Date arithmetic uses **local** `new Date(y, m-1, d)` — never `new Date("YYYY-MM-DD")` (that parses as UTC midnight and shifts a day in negative offsets).
- `monthGridStart` = Monday of the week containing day 1 → the 6×7 grid's first cell.
- `eventOnDay(event, day)` = unified closed-interval overlap `[toDateOnly(start), toDateOnly(end)]` ∋ day. Works for both formats because all-day `end_at` is inclusive and date-only.
- `timedBlockOnDay` clamps cross-midnight timed events to the day's `[0, 1440]` minute range and sets `clipped: true` (rendered with `…`).
- `layoutTimedDay` = cluster-based lane packing so overlapping events sit side-by-side (`lane`/`laneCount` → CSS left/width %).

## Range query window (from inclusive / to exclusive)

`calendar.svelte.ts.loadRange` computes a `[from, to)` window per mode and calls `listEvents(from, to)`:

- `from` = first day of the visible window (inclusive), `to` = day **after** the last (exclusive) — both date-only.
- Month: `[monthGridStart, monthGridStart+42)`; Week: `[mondayOfWeek, +7)`; Day: `[cursor, +1)`; Agenda: `[cursor, +30)`.
- The backend `list_events_in_range` SQL (`start_at < to AND end_at >= from`, lexicographic) correctly handles both date-only and ISO8601 in one query because date-only is a prefix of any ISO8601 string for that day. See `backend` specs.

## Calendar store

`src/lib/calendar.svelte.ts` follows the **function-export pattern** (see [State Management](./state-management.md)): reassigned `$state` (`_mode`, `_cursor`, `_editingId`) is private; reads go through `mode()`/`cursor()`/`events()`/`editingEvent()`. `CalendarPane` reloads via `$effect` tracking `mode()`+`cursor()`. The EventEditor mounts in the root `+page.svelte` right pane (same slot as TodoEditor), driven by `editingEvent()` — not inside CalendarPane.

## Forbidden patterns

- Don't compare ISO and date-only strings directly except via the documented overlap rule (the exclusive `to` makes it safe). For per-day membership always go through `eventOnDay` / `toDateOnly`.
- Don't construct dates from date-only strings with `new Date("YYYY-MM-DD")`. Parse with the local-component path in `calendar-grid.ts`.
- Don't export reassigned `$state` or `$derived` from `*.svelte.ts` (Svelte 5 `state_invalid_export` / `derived_invalid_export`; `npm run check` does **not** catch this — `npm run build` is authoritative).
