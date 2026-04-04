# Spec: `src/timezone.ts`

**Date:** 2026-04-04
**Round:** 2 (utility files clean-room pass)
**Tests:** `src/timezone.test.ts` — 9 tests, 1 `describe` block

---

## Purpose

Three utility functions for IANA timezone validation and UTC-to-local time
formatting. No external dependencies beyond Node.js built-ins.

---

## Exports

### `isValidTimezone(tz: string): boolean`

Returns `true` if `tz` is a valid IANA timezone identifier that
`Intl.DateTimeFormat` can use; `false` otherwise.

**Behaviour:**
- Attempt to construct `Intl.DateTimeFormat(undefined, { timeZone: tz })`.
- If it succeeds, return `true`.
- If it throws (`RangeError` for unknown timezones), return `false`.
- Any non-empty string that Intl accepts is considered valid.
- Empty string, whitespace-only, and garbage strings (`'not/a/zone'`,
  `'INVALID'`, etc.) must return `false`.

---

### `resolveTimezone(tz: string): string`

Returns `tz` if it is a valid IANA identifier (as determined by
`isValidTimezone`), otherwise returns `'UTC'`.

---

### `formatLocalTime(utcIso: string, timezone: string): string`

Converts a UTC ISO 8601 timestamp to a human-readable local time string.

**Parameters:**
- `utcIso` — a UTC ISO 8601 timestamp string (e.g. `'2024-01-15T10:30:00.000Z'`)
- `timezone` — IANA timezone identifier; invalid values fall back to `'UTC'`

**Behaviour:**
- Parse `utcIso` with `new Date(utcIso)`.
- Call `date.toLocaleString` with locale `'en-US'` and these Intl options:
  ```
  timeZone: resolveTimezone(timezone)
  year: 'numeric'
  month: 'short'
  day: 'numeric'
  hour: 'numeric'
  minute: '2-digit'
  hour12: true
  ```
- Return the resulting string directly.
- If `timezone` is invalid, `resolveTimezone` falls back to `'UTC'`; the
  output is still formatted (not an error).

**No external dependencies.** Do not import `moment`, `luxon`, `date-fns`, or
any other library. Use `Intl` only.

---

## What NOT to do

- Do not cache or memoize timezone validity.
- Do not throw on invalid input — always return a fallback (`false` / `'UTC'` /
  a UTC-formatted string).
- Do not import from any other module in this project.
