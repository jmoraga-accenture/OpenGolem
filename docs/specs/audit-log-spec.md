# Audit Log — Behavioral Specification

*Produced: 2026-04-05 | Spec Writer: Claude Code | Stream: cross-cutting*
*Source: ARCHITECTURE.md §3.7, §4.8, ADR-9; DECISIONS.md Decision 6, 15, 16; cato-spec.md §2.4; memory-tiers-spec.md §Tier 3 Interface*

---

## Responsibilities

The audit log is the ground truth for all governance in OpenGolem. Every significant system event is recorded here. Cato's dao_score KPIs, hansei reports, and all administrator-visible governance data are derived exclusively from the audit log — not from agent self-reports (ADR-9).

The audit log is a single append-only SQLite file at `data/audit.db`. It is distinct from:
- `data/memory.db` and its `memory_audit` table (Tier 3 local audit)
- `groups/{name}/messages.db` per-group episodic memory

**The audit log owns:**
- Structured event storage for all three writers (Orchestrator, Token Broker/Call Inspector, Cato)
- Append-only semantics: enforced by schema design (INSERT only; no UPDATE or DELETE through any write path) and by the write interface — not relying on SQLite triggers or OS-level enforcement alone
- Concurrent write safety: WAL mode enables multiple host processes to write simultaneously without write-lock contention
- A unified schema that accommodates all event types from all writers, with shared cross-writer fields enabling queries such as "all events for contextId X in the last hour"

**The audit log does not own:**
- Analysis — Cato reads and analyzes; the log stores and serves
- Retention policy — the live log is never truncated, rotated, or pruned by any automated process
- Alert generation — alerts come from Cato's analysis of the log
- Archival — read-only cold-storage copies are permitted but are not part of this spec
- Access control beyond the host filesystem permissions on `data/audit.db`

**Writers:** Orchestrator, Token Broker/Call Inspector, Cato. Three concurrent writers, all INSERT-only.

**Readers:** Cato (scheduled audits and dao_score computation), administrator tools (health endpoint, CLI status). Agent containers have no read or write path to the audit log — the audit log directory is never bind-mounted into any container.

---

## Storage

**File path:** `data/audit.db` (relative to the project root at runtime; resolved to an absolute path at startup).

**Format:** SQLite 3.

**WAL mode:** Write-Ahead Logging is mandatory. All three writers open the file with `PRAGMA journal_mode=WAL` before their first INSERT. WAL is the only mode that supports concurrent writers and the Cato reader without serializing access. A `data/audit.db` that cannot be opened in WAL mode is a startup error — the process that detected the failure logs to stderr and halts.

**Auto-create:** If `data/audit.db` does not exist when any writer first opens it, the file is created, the normative schema is applied, and WAL mode is enabled. This happens transparently. If the file cannot be created (permissions, disk full), the writer logs the error and fails closed — no event proceeds past a failed audit log initialization.

**Directory:** `data/` must exist before any process starts. The orchestrator is responsible for creating `data/` at startup if it does not exist. `data/audit.db` and `data/sockets/` live in the same directory tree; `data/` itself is never bind-mounted into containers.

---

## Schema

### 3.1 Unified `events` Table

The audit log contains a single table. All event types from all three writers use this table. Shared fields enable cross-writer queries; writer-specific fields are carried in a structured JSON column.

```sql
CREATE TABLE events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Shared cross-writer fields (all writers must populate these)
  event_type   TEXT    NOT NULL,                     -- see §3.2
  writer       TEXT    NOT NULL CHECK (writer IN (
                   'orchestrator',
                   'broker',
                   'cato'
               )),
  context_id   TEXT,                                  -- group-or-session ID; NULL for system-level events
  occurred_at  INTEGER NOT NULL,                      -- Unix timestamp (seconds, UTC)

  -- Per-event correlation fields (populated where applicable; NULL otherwise)
  token_id     TEXT,                                  -- derivative token ID; NULL for events without a token
  check_id     TEXT,                                  -- Cato or Call Inspector checkId (UUID); NULL if not a check event
  task_id      TEXT,                                  -- orchestrator task UUID; NULL if not task-scoped
  container_id TEXT,                                  -- container instance ID; NULL if no container involved

  -- Outcome and risk classification
  outcome      TEXT    CHECK (outcome IN (
                   'allow',
                   'block',
                   'soft_block',
                   'revoked',
                   'issued',
                   'started',
                   'completed',
                   'timed_out',
                   'error',
                   'info'
               )),                                    -- NULL for events that have no binary outcome
  risk_code    TEXT,                                  -- CatoRiskCode (§3.3); NULL if no risk classification applies

  -- Payload reference (never payload content)
  payload_hash TEXT,                                  -- SHA-256 hex; NULL for events with no associated payload
  payload_size INTEGER,                               -- byte count; NULL for events with no associated payload

  -- Writer-specific structured fields
  details      TEXT    NOT NULL DEFAULT '{}',         -- JSON object; writer populates fields defined in §3.4–§3.6

  -- Audit trail integrity
  sequence_id  INTEGER NOT NULL                       -- monotonically increasing per writer per process run;
                                                      -- see §3.7 for the per-writer sequence contract
);

CREATE INDEX events_context_id_occurred_at ON events (context_id, occurred_at)
    WHERE context_id IS NOT NULL;
CREATE INDEX events_event_type_occurred_at ON events (event_type, occurred_at);
CREATE INDEX events_token_id ON events (token_id) WHERE token_id IS NOT NULL;
CREATE INDEX events_check_id ON events (check_id) WHERE check_id IS NOT NULL;
```

No UPDATE or DELETE statement is permitted against this table through any write path in any component. This is a hard invariant (§6.4). A build-time check verifies that no UPDATE or DELETE appears in any source file's audit log write path.

### 3.2 Event Type Enumeration

The `event_type` column uses string identifiers. The following are the normative Phase 1 values, organized by writer.

**Orchestrator events:**

| `event_type` | When written |
|---|---|
| `message_received` | An inbound message is received from a channel adapter |
| `task_start` | A task is about to be dispatched to a container |
| `container_spawned` | A container has been successfully started |
| `container_teardown` | A container has been stopped (normal completion, TTL expiry, or Cato block) |
| `task_complete` | A task has returned a result via the sentinel protocol |
| `task_timed_out` | A container was stopped due to TTL expiry before completing |
| `cato_block_applied` | The orchestrator blocked an action following a Cato `allow: false` response |
| `memory_write_applied` | A Tier 1 memory mutation was committed after Cato approval |
| `memory_write_rejected` | A proposed Tier 1 mutation was discarded because Cato returned `allow: false` |
| `hansei_report_ingested` | The orchestrator has read and acknowledged a hansei report from the inbox |
| `token_requested` | The orchestrator issued an `issueToken` request to the Token Broker |
| `token_revoke_requested` | The orchestrator issued a `revokeToken` request to the Token Broker |
| `escalation_relayed` | The orchestrator forwarded a `catoEscalate` call from the broker to Cato and returned the result |

**Token Broker / Call Inspector events:**

| `event_type` | When written |
|---|---|
| `token_issued` | A derivative token was successfully issued |
| `token_revoked` | A token was revoked (by explicit request, TTL expiry, or task completion) |
| `token_store_full` | A `issueToken` request was rejected because the store is at capacity (Decision 16) |
| `call_proxied` | A proxied LLM or MCP call passed all Call Inspector checks and was forwarded |
| `call_blocked` | A proxied call was blocked by the Call Inspector (hard block) |
| `call_soft_blocked` | A proxied call was held pending user confirmation (Supervised mode) |
| `inspector_escalated` | The Call Inspector sent a `catoEscalate` to the orchestrator relay for an inconclusive check |
| `skill_registered` | A skill scope was registered with the broker via `registerSkillScope` (Decision 19) |
| `skill_deregistered` | A skill scope was removed via `deregisterSkillScope` |

**Cato events:**

| `event_type` | When written |
|---|---|
| `cato_check` | An inline check was completed (allow or block) |
| `cato_audit_start` | A scheduled audit run has begun |
| `cato_audit_complete` | A scheduled audit run has completed |
| `hansei_report_ready` | A hansei report file has been written to the inbox |
| `cato_audit_error` | A scheduled audit run was skipped or a report could not be written |

This set is open for extension. New event types are added when new writers or events are introduced; existing event types are never removed or redefined.

### 3.3 CatoRiskCode Values

The `risk_code` column uses CatoRiskCode string identifiers when applicable. Valid Phase 1 values:

| Code | Meaning |
|---|---|
| `PATH_TRAVERSAL` | Payload contains `../` or `..\` indicating potential filesystem escape |
| `OVERSIZED_PAYLOAD` | Payload exceeds configured size limit (default: 100 KB) |
| `PROMPT_INJECTION` | Payload matches a high-confidence injection signature |
| `PII_PLAIN_TEXT` | Payload contains what appears to be PII in plaintext |
| `CREDENTIAL_EXPOSURE` | Payload appears to contain a raw API key or token |
| `OUT_OF_SCOPE_ENDPOINT` | Requested endpoint not declared in the token's skill set |
| `MEMORY_SCOPE_VIOLATION` | Payload references a memory partition not permitted by this token |
| `RATE_ANOMALY` | Call rate significantly exceeds declared task profile |
| `DELEGATION_CEILING_EXCEEDED` | Subagent token request exceeds parent token's scope |

Codes are never removed from this enumeration. Deprecated codes remain valid in historical audit records.

### 3.4 Orchestrator `details` Fields

The `details` JSON object for orchestrator events carries the following fields where applicable. Absent fields are omitted (not set to null).

| Event type | Required `details` fields | Optional `details` fields |
|---|---|---|
| `message_received` | `channel`, `sender_hash` (SHA-256 of sender identity) | `message_hash` (SHA-256 of content) |
| `task_start` | `task_id`, `context_id` | `session_id` |
| `container_spawned` | `container_id`, `task_id`, `token_id`, `bind_mounts` (list of mount points, not paths) | `resource_limits` |
| `container_teardown` | `container_id`, `task_id`, `reason` (`completed` \| `timed_out` \| `blocked`) | |
| `task_complete` | `task_id`, `container_id`, `new_session_id` | `result_status` (`success` \| `error`) |
| `task_timed_out` | `task_id`, `container_id`, `ttl_seconds` | |
| `cato_block_applied` | `check_id`, `action`, `risk_code` | `reason` (risk class description) |
| `memory_write_applied` | `check_id`, `context_id` | |
| `memory_write_rejected` | `check_id`, `context_id`, `risk_code` | `reason` |
| `hansei_report_ingested` | `report_id`, `path_hash` | |
| `token_requested` | `context_id`, `skill_set` (list of skill IDs), `security_mode`, `ttl_seconds` | `call_budget`, `data_scopes` |
| `token_revoke_requested` | `token_id` | |
| `escalation_relayed` | `check_id`, `escalation_reason`, `inspector_check`, `cato_allow` | `cato_risk_code` |

`sender_hash` and `message_hash` are SHA-256 hex digests. Raw sender identity and message content are never stored in the audit log.

`bind_mounts` is a list of mount-point strings (container-side paths only — e.g. `["/workspace/group", "/workspace/extra"]`). Host-side paths are not stored.

### 3.5 Token Broker / Call Inspector `details` Fields

| Event type | Required `details` fields | Optional `details` fields |
|---|---|---|
| `token_issued` | `token_id`, `context_id`, `skill_set`, `security_mode`, `ttl_seconds`, `call_budget` | `data_scopes`, `parent_token_id` (for subagent tokens) |
| `token_revoked` | `token_id`, `reason` (`explicit` \| `ttl_expired` \| `task_complete`) | |
| `token_store_full` | `store_capacity` | `oldest_token_age_seconds` |
| `call_proxied` | `token_id`, `endpoint_category`, `call_budget_remaining` | `response_status_code`, `latency_ms` |
| `call_blocked` | `token_id`, `endpoint_category`, `risk_code`, `inspector_check` | `reason` |
| `call_soft_blocked` | `token_id`, `endpoint_category`, `inspector_check` | |
| `inspector_escalated` | `check_id`, `token_id`, `escalation_reason`, `inspector_check` | |
| `skill_registered` | `skill_id`, `token_scopes`, `network_endpoint_count` | |
| `skill_deregistered` | `skill_id` | |

`endpoint_category` is a general category string (e.g. `anthropic_api`, `openrouter`, `mcp_server`) — not the full URL, which may contain path segments with PII.

The token value itself is never stored. `token_id` is the opaque identifier associated with the token at issuance.

### 3.6 Cato `details` Fields

| Event type | Required `details` fields | Optional `details` fields |
|---|---|---|
| `cato_check` | `check_id`, `action`, `context_id`, `token_id`, `payload_hash`, `payload_size`, `allow` | `risk_code`, `reason` (if block), `llm_escalation` (bool, Phase 2), `psyche_criterion_id` (Phase 2) |
| `cato_audit_start` | `run_id`, `period_start` (ISO8601), `period_end` (ISO8601) | |
| `cato_audit_complete` | `run_id`, `report_id` | |
| `hansei_report_ready` | `run_id`, `report_id`, `report_path_hash` | |
| `cato_audit_error` | `run_id`, `error_reason` | `skipped_period_start`, `skipped_period_end` |

`reason` in `cato_check` details names the risk class; it never reproduces payload content.

`report_path_hash` is a SHA-256 hex digest of the report file path, not the path itself, to avoid leaking deployment filesystem layout into the audit log.

### 3.7 Sequence ID Contract

`sequence_id` is a monotonically increasing integer per writer per process run. It is not globally unique across writers — it is scoped per writer. Its purpose is to allow per-writer sequence gap detection (a gap indicates a dropped write).

Writers maintain an in-process sequence counter that increments atomically before each INSERT. The counter starts at 1 on process startup and is never persisted — it resets on restart. A gap in `sequence_id` for a given `writer` over a contiguous period of `occurred_at` values is a detectable signal that one or more rows were dropped.

---

## Behavioral Contract

### 4.1 Append-Only Write Path

**Given** any write operation by any writer,
**Must:** issue an INSERT statement only. No UPDATE or DELETE is ever issued against the `events` table, for any reason, by any writer.

**Given** a writer attempts to amend or correct a previously written row,
**Must:** insert a new row with a corrective `event_type` (e.g. a subsequent event that supersedes the earlier one) rather than updating the earlier row. The earlier row remains in the log unchanged.

### 4.2 Write Atomicity

**Given** a writer issues an INSERT,
**Must:** the INSERT is wrapped in an explicit SQLite transaction. Either the row is committed completely or it is not committed at all. Partial rows are not permitted.

**Given** a transient write failure (e.g. SQLITE_BUSY under concurrent write load),
**Must:** the writer retries with exponential backoff up to a configurable retry limit (default: 5 retries, starting at 10 ms). After exhausting retries, the writer logs the failure and the event is lost with error surfaced to the caller (see §4.4 below for ADR-9 implications).

### 4.3 Concurrent Write Safety

Three host processes write simultaneously. WAL mode is mandatory. WAL allows concurrent readers and one writer at a time — writers queue behind each other for a short time but do not block readers.

**Given** two writers attempt to INSERT simultaneously,
**Must:** SQLite WAL serializes them. Neither insert is lost. The order of concurrent inserts is not guaranteed between writers, but each writer's own `sequence_id` is monotonically increasing relative to its own inserts.

**Given** a writer holds an open write transaction while another writer attempts to INSERT,
**Must:** the second writer receives `SQLITE_BUSY`. It retries per §4.2.

### 4.4 Call Cannot Proceed Without an Audit Record (ADR-9)

This spec defines what the audit log does. The callers' behavior (suspending the action until the write succeeds) is defined in their respective specs. The audit log's obligation is to surface write failures clearly — not to silently swallow them.

**Given** an INSERT fails after all retries are exhausted,
**Must:** the audit log write interface returns a structured error to the caller. The error must be distinguishable from a successful write.

**Given** the audit log file cannot be opened at startup (file system error, permission denied, WAL mode failure),
**Must:** the write interface returns an initialization error. The calling process must not proceed past this error (it is a startup failure, not a recoverable condition).

### 4.5 No Payload Content in the Log

**Given** any event written by any writer,
**Must:** the `events` row contain no raw payload content. Payload is represented by `payload_hash` and `payload_size` only. Writer-specific `details` fields may include structured metadata about the payload (e.g. endpoint category, action type, risk code) but never the payload's bytes or a human-readable excerpt of the payload's content.

**Given** a `reason` field is written in `details` (by Cato or the Call Inspector),
**Must:** the `reason` value names a risk class or describes a structural condition. It does not reproduce any portion of the payload under review.

### 4.6 Timestamp Accuracy

**Given** any INSERT,
**Must:** `occurred_at` is the Unix timestamp (seconds, UTC) at the time the writer constructs the row. Writers do not back-date or forward-date events. Rows written close together in real time may carry the same `occurred_at` value — this is expected and not an error.

**Given** two events in the same writer's sequence that share the same `occurred_at`,
**Must:** the `sequence_id` values are still distinct and ordered.

### 4.7 Schema Initialization

**Given** `data/audit.db` does not exist when a writer first opens it,
**Must:** the writer creates the file, applies the schema in §3.1 (all `CREATE TABLE` and `CREATE INDEX` statements), and enables WAL mode before issuing any INSERT.

**Given** `data/audit.db` exists but WAL mode is not enabled,
**Must:** the writer enables WAL mode (`PRAGMA journal_mode=WAL`) before issuing any INSERT. If the pragma fails, the writer treats this as an initialization error (see §4.4).

**Given** `data/audit.db` exists and the `events` table already exists,
**Must:** the writer issues no schema changes. Schema migration (adding columns, indices) is a deployment operation, not a runtime automatic migration.

### 4.8 Cross-Writer Queries

The unified schema supports cross-writer correlation. Any component (Cato, administrator tool) can query across event types without writer-specific knowledge.

**Example: all events for a context in the last hour**
```sql
SELECT * FROM events
WHERE context_id = ? AND occurred_at >= ?
ORDER BY occurred_at, sequence_id;
```

**Example: full token lifecycle**
```sql
SELECT * FROM events
WHERE token_id = ?
ORDER BY occurred_at, sequence_id;
```

**Example: all checks associated with a task**
```sql
SELECT * FROM events
WHERE task_id = ? OR check_id IN (
    SELECT check_id FROM events WHERE task_id = ? AND check_id IS NOT NULL
)
ORDER BY occurred_at, sequence_id;
```

These are illustrative only. The audit log does not own query logic — Cato owns the queries for governance purposes.

---

## Failure Modes

| Failure | Audit log behavior |
|---|---|
| Writer cannot create `data/audit.db` (permissions, disk full) | Initialization error returned to the caller; the calling process must fail closed |
| WAL mode pragma fails on open | Initialization error returned to the caller; treated as startup failure |
| `SQLITE_BUSY` on INSERT under concurrent write load | Retry with exponential backoff (default: 5 retries, starting at 10 ms); error returned to caller if all retries fail |
| Disk full during INSERT | SQLite returns `SQLITE_FULL`; writer surfaces this as a write failure after retries; caller must fail closed per ADR-9 |
| Corrupt `data/audit.db` (SQLite integrity check fails at open) | Writer surfaces the failure as an initialization error; no automatic repair is attempted; administrator intervention required |
| A writer process crashes mid-INSERT | SQLite WAL ensures the partial transaction is rolled back on next open; the row is not written and no partial row appears |
| Cato attempts to read `data/audit.db` while all three writers are active | WAL mode allows the read to proceed concurrently; no read lock contention from concurrent writers |

---

## Invariants

The following properties hold at all times, across all writers and all operations.

**I-1: Append-only.** No UPDATE or DELETE statement is issued against the `events` table by any component, for any reason, at any time. The row count of `events` is monotonically non-decreasing.

**I-2: No raw credentials or payload content.** No row in `events` contains a raw API key, OAuth token, derivative token value, user credential, or the byte content of any payload under review.

**I-3: WAL mode always active.** `data/audit.db` is always open in WAL mode by any process that has it open. No process opens it with a conflicting journal mode.

**I-4: Single file, shared by all writers.** All three writers write to the same `data/audit.db`. There are no per-writer audit log files, shadow copies, or write-through proxies. The single file is the unified log.

**I-5: Agent containers have no access.** No agent container has a read or write path to `data/audit.db`. The directory containing `data/audit.db` is never bind-mounted into any container.

**I-6: Audit write precedes action result.** A call that cannot produce an audit record cannot proceed. Writers suspend the action until the write succeeds or exhaust retries and fail closed. The audit log is always at least as current as the completed actions it records.

**I-7: Live log is never truncated or pruned.** No automated process deletes rows from `events`, drops the table, replaces the file, or resets the sequence. Archival (read-only copy to cold storage) is permitted; the live `data/audit.db` is unaffected by archival.

**I-8: `sequence_id` is monotonically increasing per writer.** Within a single process run, each writer's `sequence_id` values are strictly increasing for that writer's rows. A gap is detectable and indicates a dropped write.

**I-9: `occurred_at` is UTC seconds.** All timestamps are Unix timestamps in UTC. No local timezone offsets are stored.

**I-10: CatoRiskCode values in `risk_code` are from the enumeration.** Any row with a non-null `risk_code` uses a value from the defined CatoRiskCode enumeration (§3.3). Free-text risk descriptions appear in the `details.reason` field, not in `risk_code`.

---

## Acceptance Criteria

Each criterion is binary and testable by direct SQLite inspection or by operating the system under test conditions.

**AC-1: Schema is created on first open.**
Given `data/audit.db` does not exist, when any writer opens the audit log, then `data/audit.db` is created, the `events` table exists with the normative schema, all defined indices exist, and WAL mode is active. Verified by: `.schema` and `PRAGMA journal_mode` queries on the resulting file.

**AC-2: WAL mode is active.**
Given `data/audit.db` exists and has been opened by any writer, then `PRAGMA journal_mode` returns `wal`. Verified by: direct pragma query.

**AC-3: INSERT-only write path.**
Given any sequence of operations by any of the three writers, then the WAL log and the `events` table contain no UPDATE or DELETE statements. The row count never decreases between any two measurements. Verified by: row count monotonicity check and SQLite WAL inspection.

**AC-4: Concurrent writes from three writers produce no lost rows.**
Given all three writers (orchestrator, broker, Cato) insert 100 rows each concurrently, then the `events` table contains exactly 300 rows, each with the correct `writer` value, and no row is corrupted or partial. Verified by: row count and per-writer count query after concurrent insert test.

**AC-5: Cross-writer query by `context_id` and time window returns rows from all relevant writers.**
Given events have been written by all three writers for the same `context_id`, then a query of the form `SELECT * FROM events WHERE context_id = ? AND occurred_at >= ?` returns rows with all applicable `writer` values without join or transformation. Verified by: query result inspection.

**AC-6: `payload_hash` is present for events that have an associated payload.**
Given events with associated payloads (e.g. `cato_check`, `call_proxied`, `message_received`), then `payload_hash` is a non-null 64-character hex string (SHA-256). For events without a payload (e.g. `cato_audit_start`), `payload_hash` is null. Verified by: field value inspection per event type.

**AC-7: No raw payload content in any row.**
Given any row in `events`, then neither the top-level columns nor the `details` JSON contain a string matching patterns associated with raw API keys, OAuth tokens, or reproduction of payload bytes. Verified by: regex scan of all `details` column values after a representative set of operations.

**AC-8: Token value is never stored.**
Given a `token_issued` event, then the `details` JSON contains `token_id` but not the token value itself. Verified by: the `details` JSON does not contain the string value of the issued token (captured from the broker's issuance response in the test harness).

**AC-9: `sequence_id` is monotonically increasing per writer.**
Given 50 rows inserted by a single writer process, then the `sequence_id` values for that writer are strictly increasing with no gaps. After a process restart, the sequence restarts from 1 for that writer — this is expected. Verified by: `MIN`, `MAX`, and gap detection query on `sequence_id` filtered by `writer`.

**AC-10: Write failure surfaces an error to the caller.**
Given the disk is full (simulated) and a writer attempts an INSERT, then the write interface returns a structured error. The caller receives the error synchronously before any action proceeds. Verified by: simulated SQLITE_FULL injection; caller error handling captured.

**AC-11: Initialization failure on unwritable path.**
Given `data/audit.db` cannot be created or opened (e.g. `data/` directory has no write permission), then the writer returns an initialization error and does not proceed. Verified by: permission-restricted test environment; caller receives error on first open attempt.

**AC-12: `risk_code` values are from the enumeration.**
Given any row with a non-null `risk_code`, then the value is a member of the CatoRiskCode enumeration (§3.3). Verified by: enumeration membership check after a representative set of block events.

**AC-13: `occurred_at` is a reasonable UTC Unix timestamp.**
Given any inserted row, then `occurred_at` is a Unix timestamp within a 60-second window of the actual clock time at insertion. Verified by: comparison of `occurred_at` to the test harness's recorded wall-clock time at each INSERT.

**AC-14: Agent containers have no write path to the audit log.**
Given a running agent container, then `data/audit.db` (and its containing directory) is absent from the container's bind mount set. Verified by: inspect the container's mount configuration at spawn time and confirm no audit log path is present.

**AC-15: Live log is not pruned by any automated process.**
Given the system runs for a period during which multiple audit and task events are written, then the row count of `events` at the end of the period equals the row count at the start plus the number of events written during the period. No automated process removes rows. Verified by: row count before and after a run of multiple tasks and audits.

**AC-16: `details` contains the required fields per event type.**
Given a `cato_check` event, then `details` contains `check_id`, `action`, `context_id`, `token_id`, `payload_hash`, `payload_size`, and `allow`. Given a `token_issued` event, then `details` contains `token_id`, `context_id`, `skill_set`, `security_mode`, `ttl_seconds`, and `call_budget`. Given a `container_spawned` event, then `details` contains `container_id`, `task_id`, `token_id`, and `bind_mounts`. Verified by: JSON schema validation of the `details` column for each event type in a full end-to-end test run.

**AC-17: Partial row is not committed after a mid-INSERT crash.**
Given a writer process is killed mid-INSERT (simulated), then when `data/audit.db` is next opened, no partial row is present and the WAL has been cleaned up by SQLite's crash recovery. The table remains queryable. Verified by: kill signal during INSERT in a test harness; subsequent row count and schema integrity check.

**AC-18: `writer` column matches the actual writing process.**
Given events written by the orchestrator, Token Broker, and Cato respectively, then the `writer` column values are `orchestrator`, `broker`, and `cato` for each respective writer's rows, with no cross-population. Verified by: per-process event injection in a test harness; `writer` column values asserted per process.
