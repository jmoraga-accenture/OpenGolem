# Memory Tiers — Behavioral Specification

*Produced: 2026-04-05 | Spec Writer: Claude Code | Source: ARCHITECTURE.md §6, ADR-10, DECISIONS.md Decision 10, Decision 14, IMPLEMENTATION_AUDIT.md §6*

---

## Responsibilities

The Memory Tiers component defines the three-layer persistent memory model for OpenGolem. Its responsibilities are:

1. **Tier 1 — Operational Memory:** Per-group flat markdown context (`groups/{name}/CLAUDE.md`). Persists across sessions. Readable by agent containers within the group. Writable by the orchestrator only, after Cato inline approval on every proposed mutation.

2. **Tier 2 — Episodic Memory:** Per-group structured SQLite database (`groups/{name}/messages.db`). Stores message history, task records, session logs, and timing data. Writable by the orchestrator only. Readable by the orchestrator (for context construction) and by Cato (for scheduled audits). Never mounted into agent containers.

3. **Tier 3 — Strategic Memory:** Single host-wide SQLite database with vector extension (`data/memory.db`). Stores cross-context semantic embeddings, observed behavioral patterns, long-term entity relationships, and anomaly history. Writable by the orchestrator only, after explicit Call Inspector approval on every proposed write. Never mounted into agent containers.

The Memory Tiers component does not include the mechanisms for Cato's inline check (that belongs to the Cato component), the Call Inspector (that belongs to the Token Broker component), or container spawn/teardown (that belongs to the Orchestrator component). It describes storage layout, access control, schemas, and behavioral contracts from the perspective of an external observer.

---

## External Interface

### Tier 1 Interface

**Storage location:** `groups/{name}/CLAUDE.md` — one file per group, on the host filesystem.

**Read access:**
- Agent containers: read-write bind mount at `/workspace/group/CLAUDE.md` (read at container start; writes from within the container are the agent's proposed memory update mechanism — not committed to the host file directly; see Behavioral Contract §T1-3).
- Cato: read-only, provided as context on inline check requests.

**Write access:**
- Orchestrator only: overwrites the file with the approved new content after a `MEMORY_WRITE` Cato inline check returns `allow: true`.

**Isolation:** `groups/{name}/CLAUDE.md` is visible only to containers spawned for group `name`. No container receives a bind mount from another group's directory. This is enforced at spawn time by the orchestrator's mount configuration.

### Tier 2 Interface

**Storage location:** `groups/{name}/messages.db` — one SQLite database per group, on the host filesystem.

**Schema (normative):**

```sql
CREATE TABLE messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT    NOT NULL,
  role        TEXT    NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content     TEXT    NOT NULL,
  channel     TEXT,
  sender_id   TEXT,
  created_at  INTEGER NOT NULL  -- Unix timestamp (seconds)
);

CREATE TABLE sessions (
  id          TEXT    PRIMARY KEY,  -- UUID
  context_id  TEXT    NOT NULL,     -- group name
  started_at  INTEGER NOT NULL,     -- Unix timestamp (seconds)
  ended_at    INTEGER,              -- NULL if session is open
  task_count  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE tasks (
  id            TEXT    PRIMARY KEY,  -- UUID
  session_id    TEXT    NOT NULL REFERENCES sessions(id),
  container_id  TEXT,
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER,
  status        TEXT    NOT NULL CHECK (status IN ('running', 'completed', 'timed_out', 'blocked')),
  token_id      TEXT,
  check_id      TEXT
);
```

`router_state` (outbound routing metadata) is maintained in-process by the orchestrator only. It is not persisted to Tier 2. (Decision 20)

**Read access:**
- Orchestrator: read-write. The orchestrator reads message history to construct context windows before container spawn, and writes every inbound message, outbound response, and task lifecycle event.
- Cato: read-only. Used during scheduled audits. Cato never holds a write handle to any Tier 2 database.

**Write access:**
- Orchestrator only. Agent containers have no path to any `messages.db` file — it is never included in a container's bind mount set.

**Retention:** Persistent by default. A configurable rolling retention window, set by the administrator, may prune records older than the window. When no pruning configuration is set, no records are deleted. Pruning, when configured, applies only to the `messages` table; `sessions` and `tasks` records are retained indefinitely and are not subject to the rolling retention window. (Decision 20)

**Isolation:** Per-group isolation is enforced by separate database files. There is no single cross-group messages database. The v0.1 central `store/messages.db` is not the target state and must not be used for new writes after migration.

### Tier 3 Interface

**Storage location:** `data/memory.db` — single SQLite database with `sqlite-vec` extension enabled, on the host filesystem.

**Schema (normative):**

```sql
CREATE TABLE memory_entries (
  id            TEXT    PRIMARY KEY,   -- UUID
  entry_type    TEXT    NOT NULL CHECK (entry_type IN (
                            'semantic_embedding',
                            'behavioral_pattern',
                            'entity_relationship',
                            'anomaly_history'
                        )),
  context_id    TEXT,                  -- group name, or NULL for cross-context entries
  content_hash  TEXT    NOT NULL,      -- SHA-256 hex of the source text
  content_text  TEXT    NOT NULL,      -- human-readable summary (not the raw payload)
  embedding     BLOB,                  -- sqlite-vec vector; NULL if not yet embedded
  created_at    INTEGER NOT NULL,      -- Unix timestamp (seconds)
  source_check_id TEXT                 -- checkId of the Call Inspector approval that authorized this write
);

CREATE TABLE memory_audit (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id      TEXT    NOT NULL REFERENCES memory_entries(id),
  event_type    TEXT    NOT NULL CHECK (event_type IN ('write', 'read', 'rejected_write')),
  actor         TEXT    NOT NULL CHECK (actor IN ('orchestrator', 'cato')),
  check_id      TEXT,                  -- Call Inspector checkId; required for 'write' events
  occurred_at   INTEGER NOT NULL       -- Unix timestamp (seconds)
);
```

**Note:** `memory_audit` is a Tier 3-local audit table within `data/memory.db`. It is distinct from the unified governance audit log at `data/audit.db`. Writes to `memory_audit` do not replace writes to the unified audit log — both receive entries for Tier 3 write events where applicable.

TBD — architect to resolve: exact `sqlite-vec` index configuration (HNSW vs brute-force for Phase 1 scale, dimensionality of embedding vectors, distance metric).

**Read access:**
- Cato: read-only. Primary reader; used during scheduled audits and for context on high-stakes inline checks.
- Orchestrator: read-only. Used to enrich context for high-stakes tasks (reads relevant excerpts; does not expose the database file to containers).

**Write access:**
- Orchestrator only, after explicit Call Inspector approval (`source_check_id` must be a valid approved checkId before the row is inserted). Every proposed Tier 3 write that is rejected by the Call Inspector is logged to `memory_audit` as a `rejected_write` event.

**Container access:** None. `data/memory.db` is never bind-mounted into any agent container.

**Pruning:** Entries are not pruned by default. A skill explicitly applied by the administrator may provide Tier 3 pruning behavior. No pruning occurs without administrator action.

---

## Behavioral Contract

### Tier 1 Contracts

**T1-1: Isolation by group**
For any two distinct groups `A` and `B`, no agent container spawned for group `A` has a read or write path to `groups/B/CLAUDE.md`. An attempt by an `A` container to read or write `B`'s file must fail at the filesystem level.

**T1-2: No Tier 1 write without Cato approval**
The orchestrator must not write to `groups/{name}/CLAUDE.md` until it has received a Cato inline check response with `allow: true` for a `MEMORY_WRITE` action whose `payloadHash` covers the proposed new content. If the check returns `allow: false`, the file is left unmodified. The blocked mutation is logged.

**T1-3: Agent proposals are not direct writes**
An agent container's write to its bind-mounted copy of `CLAUDE.md` does not automatically update the host file. The orchestrator reads the container's proposed update from task output, submits the `MEMORY_WRITE` Cato check, and conditionally applies the update. The mechanism by which agent proposals are transmitted to the orchestrator is defined in the Orchestrator and Container specs. This spec constrains only: no host-side write without prior Cato approval.

**T1-4: Cato socket unreachable — fail closed**
If the Cato socket is unreachable when the orchestrator attempts the `MEMORY_WRITE` check, the write does not proceed. The proposed mutation is discarded. The orchestrator logs the failed check attempt.

**T1-5: Tier 1 lifetime**
`groups/{name}/CLAUDE.md` persists across sessions. It is not cleared at session end. It may only be cleared by an explicit administrator action (direct filesystem deletion or an administrator-authorized management command).

### Tier 2 Contracts

**T2-1: Per-group isolation**
All read and write operations on Tier 2 data for group `name` target `groups/{name}/messages.db` exclusively. There is no shared cross-group message database.

**T2-2: Orchestrator-only writes**
The orchestrator is the only writer to any `messages.db`. No other process holds a write connection to these files. Agent containers have no filesystem path to any `messages.db`.

**T2-3: Write on every inbound message**
Every inbound message accepted by the orchestrator for a group is written to that group's `messages.db` before any agent container is spawned to process it.

**T2-4: Write on every outbound response**
Every outbound response routed by the orchestrator is written to the relevant group's `messages.db` after routing completes.

**T2-5: Task lifecycle records**
A `tasks` row is created when a container is spawned for a task, and updated when the task ends (with `ended_at` and final `status`). A task that times out records `status = 'timed_out'`. A task blocked by Cato records `status = 'blocked'`.

**T2-6: No container access**
The directory `groups/{name}/` is bind-mounted into containers for group `name` with specific file and path permissions. `messages.db` must not be included in the container's bind mount set. A container that attempts to open `messages.db` receives a filesystem permission error.

**T2-7: Cato read access**
Cato may open a read-only connection to any group's `messages.db` during scheduled audits. This read connection does not block orchestrator writes. WAL (Write-Ahead Logging) mode is mandatory for all Tier 2 `messages.db` files (Decision 21). The orchestrator must set `PRAGMA journal_mode=WAL` when creating or opening any `messages.db`. This ensures Cato's read-only audit connections do not block orchestrator writes.

### Tier 3 Contracts

**T3-1: No write without Call Inspector approval**
The orchestrator must not insert a row into `memory_entries` unless it holds a valid `source_check_id` from a Call Inspector approval for the proposed write. The `source_check_id` field is non-nullable for `write` events in `memory_audit`.

**T3-2: Rejected writes are logged**
When the Call Inspector rejects a proposed Tier 3 write, the orchestrator logs a `rejected_write` event to `memory_audit` with the `check_id` of the rejection. The agent that proposed the write receives an error signal.

**T3-3: No spontaneous writes**
No Tier 3 write occurs except in response to an agent-proposed observation that has passed Call Inspector approval. The orchestrator does not write to Tier 3 autonomously.

**T3-4: No container access**
`data/memory.db` is never bind-mounted into any agent container. An agent that requests Tier 3 data receives orchestrator-mediated excerpts injected as context — it does not query the database directly.

**T3-5: Agent access is read-mediated by orchestrator**
When an agent's task warrants Tier 3 context enrichment, the orchestrator queries `memory_entries` and injects relevant excerpts into the agent's task input. The agent sees text, not a database connection.

**T3-6: Cato read access**
Cato may open a read-only connection to `data/memory.db` during scheduled audits. This is the primary use of Tier 3 data outside of orchestrator-mediated context injection.

**T3-7: Pruning requires administrator action**
Rows in `memory_entries` are not deleted by any automatic process unless a pruning skill has been explicitly applied by the administrator. Default behavior is no deletion.

---

## Failure Modes

### FM-1: Cato socket unreachable during Tier 1 write

**Trigger:** Orchestrator receives a memory update proposal from a completed agent task; Cato socket is unreachable when the `MEMORY_WRITE` check is submitted.

**Behavior:** The proposed Tier 1 write is abandoned. `groups/{name}/CLAUDE.md` is not modified. The orchestrator logs the failed check attempt (context ID, proposed payloadHash, timestamp, error: socket unreachable). The agent receives no confirmation of the write. The agent's task is considered complete with a partial result — memory persistence was not achieved.

**Must not happen:** The orchestrator must not write to `CLAUDE.md` without a confirmed Cato `allow` response, even under retry logic or timeout conditions.

### FM-2: Call Inspector unreachable during Tier 3 write

**Trigger:** Orchestrator attempts to submit a proposed Tier 3 write; the Call Inspector is unreachable.

**Behavior:** The proposed Tier 3 write is abandoned. No row is inserted into `memory_entries`. A `rejected_write` event is logged to `memory_audit` with a system-generated note that the inspector was unreachable (not a policy rejection). The agent receives an error signal.

### FM-3: Tier 2 database missing or corrupt

**Trigger:** Orchestrator attempts to write to `groups/{name}/messages.db` and the file is missing, locked by a non-orchestrator process, or returns a SQLite error.

**Behavior:** The orchestrator logs the error and does not proceed with the agent task for that group until the database is accessible. Pending messages for the group are held in the in-memory queue. No message is silently dropped.

**Missing `messages.db`:** The orchestrator auto-creates the file by applying the normative schema (Decision 21). Creation includes setting WAL mode. The orchestrator logs a warning noting that the database was created (not found). Processing resumes without administrator intervention.

**Corrupt `messages.db`:** The orchestrator logs the error and does not proceed. Pending messages are held in-memory. The database must be repaired or deleted by the administrator before processing resumes for that group. The orchestrator does not attempt auto-repair of a corrupt database.

### FM-4: Tier 3 database missing or sqlite-vec unavailable

**Trigger:** Orchestrator or Cato attempts to open `data/memory.db` and the file is missing, or the `sqlite-vec` extension is not loadable.

**Behavior:** Tier 3 reads return empty result sets. Tier 3 writes are rejected and logged. The orchestrator continues operating without Tier 3 context enrichment. Cato's scheduled audit notes the unavailability. The system does not degrade on Tier 1 or Tier 2 behavior due to Tier 3 failure.

### FM-5: Tier 1 file missing at container spawn

**Trigger:** A container is being spawned for group `name`, but `groups/{name}/CLAUDE.md` does not exist on the host filesystem.

**Resolution (Decision 22):** The orchestrator auto-creates an empty `groups/{name}/CLAUDE.md` at group provisioning time if the file does not exist. If the file is still missing at spawn time (e.g. deleted between provisioning and spawn), the orchestrator creates it then. No Cato check is required for creation of an empty file — there is no content to evaluate. The orchestrator logs that the file was created.

---

## Invariants

**INV-1: No cross-group Tier 1 read**
At all times, for any running agent container for group `A`, there exists no filesystem path within the container's mount namespace that resolves to `groups/{B}/CLAUDE.md` for any `B ≠ A`.

**INV-2: No Tier 1 host write without prior Cato allow**
At all times, every write to any `groups/{name}/CLAUDE.md` on the host is preceded by a Cato inline check response `{ allow: true, ... }` for action `MEMORY_WRITE` with a `payloadHash` covering the written content. This invariant has no exception and is not configurable.

**INV-3: No Tier 2 access from containers**
At all times, no agent container has a filesystem path to any `groups/{name}/messages.db` file.

**INV-4: No Tier 3 access from containers**
At all times, `data/memory.db` is not present in any agent container's bind mount set.

**INV-5: No spontaneous Tier 3 write**
Every row in `memory_entries` has a non-null `source_check_id`. There are no rows without a corresponding approved Call Inspector check event.

**INV-6: Per-group Tier 2 layout**
There is no cross-group `messages.db` file. The path `store/messages.db` (v0.1 central database) is not written to by any v1.0 component.

**INV-7: Audit trail completeness for Tier 3**
Every Tier 3 write and every rejected Tier 3 write attempt is represented as a row in `memory_audit`. Rows in `memory_audit` are never deleted or updated.

---

## Acceptance Criteria

### Tier 1

**AC-T1-1:** Given two groups `alpha` and `beta` with distinct `CLAUDE.md` content, spawn a container for group `alpha`. Confirm that the container cannot read `groups/beta/CLAUDE.md` (attempt returns a permission error or file-not-found from within the container's namespace).

**AC-T1-2:** Given a running system with Cato responding normally, submit a task that produces a Tier 1 memory update proposal. Confirm that `groups/{name}/CLAUDE.md` is updated only after a Cato check response with `allow: true` has been received. Confirm the updated content matches the approved proposal.

**AC-T1-3:** With Cato returning `allow: false` for `MEMORY_WRITE`, submit a task with a memory update proposal. Confirm that `groups/{name}/CLAUDE.md` is not modified. Confirm a rejection event is logged.

**AC-T1-4:** With Cato socket shut down, submit a task with a memory update proposal. Confirm that `groups/{name}/CLAUDE.md` is not modified. Confirm the orchestrator logs a failed check attempt with reason: socket unreachable.

**AC-T1-5:** Confirm that `groups/{name}/CLAUDE.md` exists after a session ends and the container is torn down (the file is not deleted on session close).

### Tier 2

**AC-T2-1:** Send an inbound message to group `alpha`. Confirm a row appears in `groups/alpha/messages.db` in the `messages` table before any container is spawned for that message.

**AC-T2-2:** Confirm that `groups/alpha/messages.db` and `groups/beta/messages.db` are distinct files. Confirm that writing a message to `alpha` creates no row in `beta`'s database.

**AC-T2-3:** Spawn a container for group `alpha`. Confirm that no file with the path `messages.db` (or equivalent) is visible within the container's filesystem namespace.

**AC-T2-4:** Confirm that a task spawned for group `alpha` creates a `tasks` row with `status = 'running'` at spawn time, and the row is updated with a terminal status and `ended_at` when the task completes.

**AC-T2-5:** Confirm that a task killed by TTL expiry produces a `tasks` row with `status = 'timed_out'`.

**AC-T2-6:** Confirm that a task blocked by Cato produces a `tasks` row with `status = 'blocked'`.

**AC-T2-7:** Open a read-only connection to `groups/{name}/messages.db` (simulating Cato audit access) while the orchestrator is actively writing. Confirm that reads succeed without blocking writes (WAL behavior).

### Tier 3

**AC-T3-1:** Submit a proposed Tier 3 write with a valid Call Inspector approval `checkId`. Confirm a row appears in `memory_entries` with `source_check_id` matching the approved `checkId`.

**AC-T3-2:** Submit a proposed Tier 3 write with the Call Inspector returning a rejection. Confirm no row is inserted in `memory_entries`. Confirm a `rejected_write` event appears in `memory_audit` with the rejection `checkId`.

**AC-T3-3:** Confirm that `data/memory.db` is not present in any spawned container's bind mount set (inspect the container's mounts at spawn time).

**AC-T3-4:** Query `memory_entries` and confirm every row has a non-null `source_check_id`.

**AC-T3-5:** Confirm that `memory_audit` contains no UPDATE or DELETE operations against any existing row (append-only enforcement: attempt a DELETE and confirm it fails or is structurally prevented).

**AC-T3-6:** With `data/memory.db` unavailable (removed or extension unloadable), confirm the system continues to process messages and spawn containers without error. Confirm Tier 1 and Tier 2 behavior is unaffected. Confirm the orchestrator logs the Tier 3 unavailability.

**AC-T3-7:** Confirm that an agent container has no mechanism to query `data/memory.db` directly — any Tier 3 data received by an agent arrives as injected text in its task input, not via a database connection.
