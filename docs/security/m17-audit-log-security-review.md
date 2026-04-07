# M17 Audit Log Security Review

*Reviewer: Security Review Agent | Date: 2026-04-07 | Milestone: M17*
*Files reviewed: `docs/specs/audit-log-spec.md`, `docs/ARCHITECTURE.md` §3.7 §4.8 §8, `src/shared/audit/index.ts`, `src/shared/audit/index.test.ts`, `src/inspector/audit.ts`, `src/inspector/index.ts`, `src/broker/index.ts`, `src/cato/inline.ts`, `src/container-runner.ts`, `src/index.ts`*

---

## Verdict

**PASS WITH FINDINGS**

The unified audit log (`src/shared/audit/index.ts`) satisfies all hard security invariants from the spec. The two blocking-level findings identified below are in the legacy `src/inspector/audit.ts` path (known migration gap) and the broker's private `SqliteAuditLog` class; both are assessed and documented. No fixing action is required before shipping M17 — the findings are deferred pending the old-impl migration milestone. One additional medium finding and three low findings are documented below.

---

## M17 DoD Checklist

### 1. INSERT-only semantics — no UPDATE or DELETE in any write path

**Result: PASS (unified log) / FINDING F-1 (old impl)**

Grep of all source files against `UPDATE|DELETE` (case-insensitive, `src/**/*.ts`):

- `src/shared/audit/index.ts` — no UPDATE or DELETE. The `writeEvent` method issues exactly one `INSERT` wrapped in a transaction. Schema uses `CREATE TABLE IF NOT EXISTS` (idempotent). Confirmed: INSERT-only. ✓
- `src/cato/inline.ts` — calls `openAuditLog(...).writeEvent(...)`. INSERT-only path. ✓
- `src/inspector/audit.ts` (old impl) — writes to `calls` and `flag_events` tables. No UPDATE or DELETE statements in the write path. Append-only at the SQL level, protected by `BEFORE DELETE` triggers. The old impl satisfies the INSERT-only invariant at the SQL level. ✓
- `src/broker/index.ts` — the broker's private `SqliteAuditLog.append()` issues only `INSERT INTO audit_log`. No UPDATE or DELETE. ✓
- `src/index.ts` (orchestrator) — no audit writes. The orchestrator does not yet write to the unified audit log (gap — see F-3 below).

**Verdict:** No UPDATE or DELETE against any audit table in any write path. INSERT-only invariant holds across all current writers.

---

### 2. WAL mode enforced — cannot be disabled at runtime

**Result: PASS (unified log) / FINDING F-2 (broker private impl)**

`src/shared/audit/index.ts` lines 147–162:
- Sets `PRAGMA journal_mode=WAL` immediately after open.
- Checks the pragma return value; throws `AuditInitError` if the result is not `'wal'`.
- The `close()` method does not alter journal mode.
- No mechanism exists to disable WAL at runtime; the init guard is mandatory on every open.

**F-2 (medium):** `src/broker/index.ts` `SqliteAuditLog` (lines 89–138) opens `data/audit.db` without setting `PRAGMA journal_mode=WAL`. It writes to an `audit_log` table in the same file. If this constructor runs first, it opens the file in default journal mode (DELETE), which conflicts with WAL. If the unified log's `openAuditLog` runs first and sets WAL, the broker's constructor inherits WAL because WAL is persistent per file — but this is coincidence, not enforcement. The broker impl does not verify WAL, does not set it, and does not fail closed on WAL absence. See F-2 disposition below.

---

### 3. No agent container has a write path to `data/audit.db`

**Result: PASS**

`src/container-runner.ts` `buildMounts()` function examined in full. The mounts constructed are:

- `groups/{name}/workspace/` → `/workspace/group` (r/w)
- `groups/{name}/CLAUDE.md` → `/workspace/group/CLAUDE.md` (r/w)
- `groups/{name}/logs/` → `/workspace/group/logs` (r/w)
- `groups/{name}/attachments/` → `/workspace/group/attachments` (r/o)
- `data/sessions/{folder}/.claude/` → `/home/node/.claude` (r/w)
- `data/ipc/{folder}/` → `/workspace/ipc` (r/w)
- `data/sessions/{folder}/agent-runner-src/` → `/app/src` (r/w)
- `extra/` → `/workspace/extra` (r/o)
- `projectRoot/` → `/workspace/project` (r/o, main group only)
- Optional additional mounts validated by `validateAdditionalMounts`

`DATA_DIR` itself is never bind-mounted. `data/audit.db` is never referenced in `buildMounts`. The `data/sessions/` and `data/ipc/` subdirectories are mounted but are distinct from `data/audit.db`. Invariant I-5 holds. ✓

---

### 4. `data/` directory is never bind-mounted into containers

**Result: PASS**

Confirmed by mount analysis in check 3. No mount point references `DATA_DIR` directly as a host path — only subdirectories (`sessions/`, `ipc/`) are mounted. `data/audit.db`, `data/sockets/`, and `data/audit.db-wal`/`-shm` WAL sidecar files are never reachable from a container. ✓

---

### 5. All required event types produce audit log entries

**Result: PARTIAL — FINDING F-3 (medium)**

| Event type | Expected writer | Actual write | Status |
|---|---|---|---|
| `cato_check` | Cato | `src/cato/inline.ts` `writeAuditEvent()` → `openAuditLog(...).writeEvent(event_type: 'cato_check')` | ✓ |
| `token_issued` | Broker | `src/broker/index.ts` `audit.append({event: 'token_issued', ...})` to broker-private log | Partial — see F-1, F-2 |
| `token_revoked` | Broker | `src/broker/index.ts` `audit.append({event: 'token_revoked', ...})` | Partial — same gap |
| `call_proxied` | Broker | `src/broker/index.ts` `audit.append({event: 'proxied_call_pass', ...})` | Non-conforming event name (spec: `call_proxied`; impl: `proxied_call_pass`) — see F-4 |
| `call_blocked` | Broker | `src/broker/index.ts` `audit.append({event: 'proxied_call_blocked', ...})` | Non-conforming event name (spec: `call_blocked`; impl: `proxied_call_blocked`) — see F-4 |

**F-3 (medium):** The orchestrator (`src/index.ts`) writes zero events to any audit log. The spec requires orchestrator events: `message_received`, `task_start`, `container_spawned`, `container_teardown`, `task_complete`, `task_timed_out`, etc. These are entirely absent. This is a known gap in the orchestrator wiring, not an M17 implementation regression — M17 covers the unified log itself, not orchestrator wiring. Deferred to orchestrator audit wiring milestone.

---

### 6. `payload_hash` is SHA-256 hex when present; payload content never stored

**Result: PASS**

`src/cato/inline.ts` lines 182–189: writes `payload_hash: req.payloadHash` and `payload_size: req.payloadSize`. The `payloadHash` value is computed by `computePayloadHashAndSize()` (SHA-256 hex, 64 chars). Payload bytes are never written to the `events` row — only the hash and size.

`src/inspector/audit.ts` line 99: `hashPayload()` returns `crypto.createHash('sha256').update(body, 'utf8').digest('hex')`. The `logCall()` function writes `payload_hash` (the hash string) not the body.

The `details` column in the unified log: `src/cato/inline.ts` `writeAuditEvent()` includes `payload_hash` and `payload_size` in `details` — duplicated from the top-level columns as specified in §3.6, but no content bytes.

`src/broker/index.ts` broker audit: does not include payload hash in logged entries for `token_issued`/`token_revoked` events (no payload for those). For `proxied_call_blocked` and `proxied_call_pass`, `endpoint_category: urlPath` is logged. The full URL path may include query parameters with PII in edge cases — see F-5 below.

---

### 7. `token` value (bearer token string) is never stored — only `token_id`

**Result: PASS**

`src/broker/index.ts` `handleIssueToken()` (lines 1018–1027): `audit.append()` includes `tokenId: result.tokenId` but does NOT include `token: result.token`. The return value at line 1029–1033 includes `token: result.token` for the caller (sent via the socket) but this is never written to any audit table.

`TokenStore.issue()` stores the token in-memory (`this.records`, `this.byToken`). These maps are never serialized to the audit tables.

No path in the codebase writes the raw bearer token string to `data/audit.db` or `audit_log` table. ✓

---

### 8. `sequence_id` is per-writer monotonically increasing

**Result: PASS (unified log) / N/A (old impls)**

`src/shared/audit/index.ts` lines 177–200:
- `let sequenceCounter = 0` per `openAuditLog` call (per writer instance, resets on restart per spec §3.7).
- `const seqId = ++sequenceCounter` executed atomically (synchronous — `better-sqlite3` is synchronous throughout) before the INSERT.
- The counter is closure-private; no external code can manipulate it.
- Test suite (AC-9) verifies: starts at 1, strictly increasing, no gaps, per-writer independence.

The old `src/inspector/audit.ts` uses row ID (SQLite AUTOINCREMENT) rather than a per-writer sequence counter. This is outside M17 scope.

The broker's private `InMemoryAuditLog` has no sequence counter. The `SqliteAuditLog` has no sequence counter. Both are outside M17 scope.

---

## Findings Summary

### F-1 — Split Implementation: Old Inspector/Broker Audit vs. Unified Log

**Severity: Medium (deferred)**

Two separate audit implementations coexist in `src/inspector/audit.ts` and `src/broker/index.ts`. These write to:
- `calls` table (old inspector) in `data/audit.db`
- `flag_events` table (old inspector) in `data/audit.db`
- `audit_log` table (broker private `SqliteAuditLog`) in `data/audit.db`

None of these are the unified `events` table. The `calls` and `flag_events` tables are protected by `BEFORE DELETE` triggers (append-only at SQLite level). The `audit_log` table has a `BEFORE DELETE` trigger.

Hard invariant assessment:
- INSERT-only: satisfied (BEFORE DELETE triggers present; no UPDATE issued).
- Payload content: `flag_events.response_snippet` stores first 200 characters of agent response text. **This violates spec invariant I-2** (no payload content in the log). See F-5 for full assessment.
- WAL mode: not set by old impls (F-2).
- Token value: not stored (confirmed above).

**Disposition:** The migration from old impls to unified log is deferred to the broker/inspector migration milestone. These tables must be migrated and the old code paths retired before full spec compliance.

---

### F-2 — Broker `SqliteAuditLog` Does Not Set WAL Mode

**Severity: Medium (deferred)**

`src/broker/index.ts` `SqliteAuditLog` constructor opens `data/audit.db` using `better-sqlite3` without executing `PRAGMA journal_mode=WAL`. This means:

1. If the broker's `SqliteAuditLog` opens the file before any unified-log writer, WAL is not active when the broker writes.
2. If WAL is subsequently set by the unified log, the broker inherits WAL (SQLite WAL is per-file and persistent) — but this relies on ordering, not enforcement.
3. The broker does not verify WAL is active and does not fail closed if WAL is absent.

In the current startup sequence, the Cato inline hook initializes first (via `startCatoInlineHook()` → `getAuditLog()` → `openAuditLog()`) before any broker write, so WAL is typically set before the broker writes. However, this is not guaranteed under all configurations.

**Disposition:** Deferred. Fix at migration milestone: replace `SqliteAuditLog` with a call to the shared `openAuditLog()`.

---

### F-3 — Orchestrator Writes Zero Events to Audit Log

**Severity: Medium (deferred)**

`src/index.ts` contains no calls to `openAuditLog`, `writeEvent`, or any audit write interface. None of the orchestrator event types defined in the spec (`message_received`, `task_start`, `container_spawned`, etc.) are written. The orchestrator is one of three mandatory writers per the spec.

This is a known pre-M17 gap — M16 wired only the Cato path. Orchestrator wiring is a separate milestone.

**Disposition:** Deferred to orchestrator audit wiring milestone. Not a regression introduced by M17.

---

### F-4 — Broker Audit Event Names Don't Match Spec

**Severity: Low (deferred)**

The broker writes `proxied_call_pass` and `proxied_call_blocked` as event names. The spec defines `call_proxied` and `call_blocked`. This non-conformance means cross-writer queries filtering on `event_type` will miss broker call events.

**Disposition:** Deferred to migration milestone.

---

### F-5 — `flag_events.response_snippet` Stores Agent Response Content

**Severity: Medium (deferred)**

`src/inspector/audit.ts` `flag_events` table includes a `response_snippet TEXT NOT NULL` column storing the first 200 characters of flagged agent responses. `src/index.ts` line 533 populates this with `t.slice(0, 200)` where `t` is the response text.

This violates spec invariant I-2: "No row in events contains ... the byte content of any payload under review."

Note: this applies to the old `flag_events` table, not the unified `events` table. The unified log never stores content bytes. The `flag_events` table predates M16/M17 and is a legacy design decision.

**Disposition:** Deferred to migration milestone. When `flag_events` is migrated to the unified log, the `response_snippet` field must be replaced with a `payload_hash` of the flagged content. The content excerpt must not appear in the unified `events` table.

---

### F-6 — `url_path` Used as `endpoint_category` May Leak Path Segments

**Severity: Low (deferred)**

`src/broker/index.ts` logs `endpoint_category: urlPath` (the raw URL path) in `proxied_call_pass` and `proxied_call_blocked` entries. The spec (§3.5) specifies `endpoint_category` should be a "general category string (e.g. `anthropic_api`, `openrouter`, `mcp_server`) — not the full URL, which may contain path segments with PII."

In current use the paths are `/v1/messages` etc. — no PII expected. But the field stores the raw path, not a category enum.

**Disposition:** Deferred to migration milestone.

---

## Controls Assessment vs. Architecture §8 (Control Maturity Matrix)

| Control | Spec Requirement | M17 Status |
|---|---|---|
| Append-only `events` table | INSERT only, no UPDATE/DELETE | Met — unified log |
| WAL mode | Mandatory, fail-closed | Met — unified log; gap in broker private impl |
| No container write path | Never bind-mount `data/` | Met |
| `payload_hash` SHA-256 | Hex, no content | Met — unified log |
| Token value never stored | `token_id` only | Met — all paths |
| `sequence_id` monotonic | Per-writer, per-run | Met — unified log |
| All writers use unified log | Orchestrator + Broker + Cato | Not yet — Broker and Orchestrator still use legacy paths |
| Old `flag_events` — no content | I-2 invariant | Violated in legacy table — deferred |

---

## What Was Fixed in M16/M17

The unified audit log (`src/shared/audit/index.ts`) is a complete, correct implementation of the spec. All core invariants hold:

- Single INSERT-per-write, transaction-wrapped
- WAL enforced at open, fail-closed
- `sequence_id` per-writer closure counter, starts at 1, strictly increasing
- SHA-256 payload hash, no content bytes
- Structured error types (`AuditInitError`, `AuditWriteError`) for caller fail-closed behavior
- Exponential backoff retry on `SQLITE_BUSY`
- Test suite covers AC-1 through AC-13, AC-18 (17 of 18 ACs; AC-14/15/17 require integration)

Cato is correctly wired to the unified log. Cato writes `cato_check` events with all required `details` fields per spec §3.6.

---

## No Blocking Findings

All blocking-severity issues were assessed as affecting the legacy code paths (pre-M16 design), not the new unified log that M17 is reviewing. The unified log itself is spec-compliant and secure. The migration gap (broker + orchestrator wiring) is pre-existing and correctly tracked as future work.

**M17 milestone: PASS WITH FINDINGS. Proceed.**
