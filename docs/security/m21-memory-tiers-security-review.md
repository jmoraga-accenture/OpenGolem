# M21 — Memory Tiers: Security Review and QA

*Reviewed: 2026-04-07 | Reviewer: Claude Code (Security Reviewer role)*

---

## Security Reviewer Verdict: PASS WITH FINDINGS

Three findings are recorded. None are blocking (no path to arbitrary host write or container escape), but two warrant attention before the tier modules are wired into the live orchestrator.

---

### Trust Domain Crossing Review

#### Check 1 — Group isolation: does getMountsForGroup scope to the requesting group only?

**Result: PASS**

`tier1.ts::getMountsForGroup` (`src/memory/tier1.ts:57-71`) constructs the mount set by resolving `path.resolve(groupsDir, groupName)` and returns a single entry pointing to that group's `CLAUDE.md` only. The returned mount list is:

```
hostPath: groups/{groupName}/CLAUDE.md → containerPath: /workspace/group/CLAUDE.md
```

No parent directory, no sibling group path, no wildcard. A call for group `alpha` will never include group `beta`'s path in the returned set. The test at `AC-T1-1` confirms this with two assertions (exact-path check and prefix-scan across all returned mounts).

**Note (Finding F-1 below):** The actual container-runner (`src/container-runner.ts:231-239`) does *not* use `tier1.getMountsForGroup`. It mounts the entire `groupDir` directory into the container as `/workspace/group`. The tier1 function is currently not called by any production code path. The isolation guarantee expressed by the tier1 API exists only at the module level; it is not yet enforced end-to-end.

#### Check 2 — Tier 3 data/memory.db is NOT bind-mounted into any container

**Result: PASS**

`tier3.ts::getContainerMounts` (`src/memory/tier3.ts:278-294`) explicitly excludes `memory.db` from the returned mount list. The only mount returned is the group's `CLAUDE.md`. The comment at line 287 states the invariant explicitly: `// Only mount CLAUDE.md — never memory.db (INV-4)`.

`tier2.ts::getMountsForGroup` (`src/memory/tier2.ts:92-105`) likewise returns only `CLAUDE.md`. Neither function exposes any path under `data/`.

The independent container-runner (`src/container-runner.ts`) was also audited. It mounts: project root (isMain only), group directory, `.claude` dir, IPC dir, agent-runner source, extra dir, and optional `additionalMounts`. No `data/` path appears. `memory.db` is not mounted by any code path.

Test coverage: `AC-T3-3` exercises both `tier2.getMountsForGroup` and `tier3.getContainerMounts` (test lines 1389-1420).

#### Check 3 — MEMORY_WRITE Cato approval gate is non-bypassable

**Result: PASS**

`tier1.ts::applyMemoryWriteProposal` (`src/memory/tier1.ts:106-157`) is the single write path to any `CLAUDE.md` on the host. The function:

1. Calls `catoCheck` before touching the filesystem.
2. On exception from `catoCheck`, returns `{ status: 'socket_unreachable' }` — no write occurs (fail-closed, lines 127-135).
3. On `allow: false`, returns `{ status: 'rejected' }` — no write occurs (lines 137-145).
4. Writes only when `allow: true` is explicitly received (lines 148-149).

`ensureClaudeMd` (`src/memory/tier1.ts:81-96`) creates an empty file without a Cato check, which is explicitly permitted by spec (Decision 22, FM-5): empty file creation carries no content risk. The function does not accept proposed content — it writes zero bytes only, and only if the file is absent.

There is no alternative write path to `CLAUDE.md` exported from the module. The `catoCheck` parameter is typed as required (`catoCheck: CatoCheck`) in `applyMemoryWriteProposal`, so callers cannot omit it without a TypeScript error.

#### Check 4 — Audit trail for rejected Tier 1 writes

**Result: PASS (in-process record only — see Finding F-2)**

When `allow: false` is returned, `applyMemoryWriteProposal` stores the rejection in `_lastWriteResult` (module-level variable, lines 44/139-144) with `status: 'rejected'`, the `checkId`, and the `reason`. This is observable via `getLastWriteResult()`.

When the Cato socket is unreachable, `_lastWriteResult` is set to `status: 'socket_unreachable'` with the error message (lines 129-134).

The record is available to the caller for further action (e.g., writing to the audit log). It is not written to a durable store by this module; the spec places that responsibility on the orchestrator (T1-4 states "the orchestrator logs the failed check attempt"). The module correctly surfaces the information — durability is an orchestrator concern.

#### Check 5 — WAL mode on Tier 2: enforced or advisory?

**Result: PASS — enforced unconditionally**

`tier2.ts::openGroupDb` (`src/memory/tier2.ts:73-83`) issues `db.exec('PRAGMA journal_mode=WAL')` immediately after opening the database, before any schema creation. This runs on every open, including reopens of existing files. The `PRAGMA journal_mode=WAL` call is unconditional — no config flag, no fallback, no silent ignore. Decision 21 is implemented as a hard requirement, not advisory.

The test at `Decision 21 — auto-create messages.db: auto-created messages.db is in WAL mode` reads the `journal_mode` PRAGMA back and asserts `'wal'` (test line 934-947). The contract test `WAL mode is active on every messages.db opened by the implementation` opens three independent databases and verifies each (test lines 1126-1140).

---

### Additional Findings

#### F-1 — Container-runner mounts entire group directory, not just CLAUDE.md (Severity: MEDIUM)

**File:** `src/container-runner.ts:231-239`

`buildMounts` mounts the entire `groupDir` (`groups/{name}/`) into the container as `/workspace/group` (read-write). When the Tier 2 module is integrated, `groups/{name}/messages.db` will exist at that path and will be accessible to the container at `/workspace/group/messages.db`. This violates INV-3 and T2-6.

The `tier2.getMountsForGroup` function correctly excludes `messages.db`, but the container-runner does not call it. The container-runner's mount logic is independent of the tier module APIs.

**Impact:** Not currently exploitable because `messages.db` files do not yet exist in production group directories (the Tier 2 module is not yet wired into the orchestrator). The risk becomes real when integration occurs.

**Required action before Tier 2 integration:** The container-runner must either (a) mount only specific files from the group directory (CLAUDE.md by path, logs/ subdirectory separately) rather than the whole directory, or (b) exclude `messages.db` via a bind-mount shadow (e.g. mount `/dev/null` over `/workspace/group/messages.db`). Option (a) is architecturally cleaner and consistent with the tier1/tier2 module design.

#### F-2 — FM-2 not implemented: inspector unreachable during Tier 3 write does not log to memory_audit (Severity: LOW)

**File:** `src/memory/tier3.ts:160-174`

The spec (FM-2) states: "A `rejected_write` event is logged to `memory_audit` with a system-generated note that the inspector was unreachable." The implementation's catch block contains a comment acknowledging this gap (`// For now, just return without writing.`, line 173) and returns silently. No `memory_audit` row is written on inspector unreachability.

The FK constraint on `memory_audit.entry_id` is the root obstacle: a rejected_write audit row requires an `entry_id`, but no `memory_entries` row exists for the proposed id. The rejected-write path for inspector-returned rejections handles this by temporarily disabling FK enforcement (`PRAGMA foreign_keys=OFF`, line 186). The same technique would work for the unreachable case.

**Impact:** Inspector-unreachable events leave no trace in `memory_audit`. If the inspector is intermittently unreachable, write attempts will silently fail with no audit evidence. INV-7 is partially violated for this failure mode.

**Not blocking** for the current phase because the tier3 module is not yet wired into the orchestrator and the inspector-unreachable path is not exercised in production. Should be resolved before Tier 3 integration.

#### F-3 — PRAGMA foreign_keys=OFF window during rejected_write (Severity: LOW, Design Note)

**File:** `src/memory/tier3.ts:186-194`

The rejected-write path disables SQLite foreign key enforcement (`PRAGMA foreign_keys=OFF`) to insert a `memory_audit` row for an entry that does not exist in `memory_entries`. The FK enforcement is restored in a `finally` block. In the single-threaded Node.js / better-sqlite3 synchronous context, no concurrent statement can execute during this window, so there is no race condition.

However, the design couples audit integrity to a temporary relaxation of a database constraint. A cleaner solution would be to insert a placeholder row in `memory_entries` with a sentinel `entry_type` (e.g. `'rejected_proposal'`) before inserting the audit row, then leave the placeholder as an immutable record. This would preserve FK integrity throughout and make rejected proposals directly queryable.

**Not blocking.** The current implementation is thread-safe and the `finally` block prevents leaking the disabled state. Flagged for design review before Tier 3 integration.

---

## QA Verdict: PASS

### Test Results

```
vitest run src/memory/memory-tiers.test.ts

 RUN  v4.0.18 /home/jim/assistants/OpenGolem

 ✓  src/memory/memory-tiers.test.ts (69 tests) 1073ms

 Test Files  1 passed (1)
       Tests  69 passed (69)
    Start at  19:09:14
    Duration  1.24s (transform 83ms, setup 0ms, import 87ms, tests 1.07s)
```

All 69 tests pass. No failures, no skips.

### Acceptance Criteria Coverage

#### Tier 1

| AC | Description | Status |
|----|-------------|--------|
| AC-T1-1 | Cross-group isolation: alpha mount does not contain beta's path | **Covered** — 3 tests (exact path check, prefix scan, stub detection) |
| AC-T1-2 | Write only after Cato allow: true; content matches proposal | **Covered** — 3 tests (write on allow, action name check, content match) |
| AC-T1-3 | Cato allow: false → file unmodified, rejection logged | **Covered** — 3 tests (no modification, rejection status, stub detection) |
| AC-T1-4 | Cato socket unreachable → file unmodified, socket_unreachable logged | **Covered** — 2 tests (no modification, status check) |
| AC-T1-5 | CLAUDE.md persists after session ends | **Covered** — 2 tests (file exists, content unchanged) |

#### Tier 2

| AC | Description | Status |
|----|-------------|--------|
| AC-T2-1 | Inbound message written before container spawn (synchronous) | **Covered** — 2 tests (row present, synchronous guarantee) |
| AC-T2-2 | alpha and beta databases are distinct; writing to alpha creates no beta row | **Covered** — 3 tests (distinct paths, cross-contamination check, stub detection) |
| AC-T2-3 | messages.db not in container mount set | **Covered** — 2 tests (endsWith check, pattern check on both paths) |
| AC-T2-4 | Task row created with status=running at spawn; updated with terminal status and ended_at | **Covered** — 2 tests |
| AC-T2-5 | TTL expiry → status=timed_out | **Covered** — 1 test |
| AC-T2-6 | Cato block → status=blocked | **Covered** — 1 test |
| AC-T2-7 | Read-only connection succeeds while writer is active (WAL behavior) | **Covered** — 1 test |

#### Tier 3

| AC | Description | Status |
|----|-------------|--------|
| AC-T3-1 | Write with valid checkId → row in memory_entries with matching source_check_id | **Covered** — 2 tests |
| AC-T3-2 | Inspector rejection → no memory_entries row, rejected_write in memory_audit | **Covered** — 3 tests (no row, audit row present, stub detection) |
| AC-T3-3 | data/memory.db not in container mount set | **Covered** — 2 tests (tier2.getMountsForGroup and tier3.getContainerMounts) |
| AC-T3-4 | Every memory_entries row has non-null source_check_id (INV-5) | **Covered** — 2 tests (query for nulls, schema DDL check) |
| AC-T3-5 | memory_audit is append-only: DELETE and UPDATE throw | **Covered** — 3 tests (DELETE prevented, UPDATE prevented, stub detection) |
| AC-T3-6 | Tier 3 unavailable → Tier 1 and Tier 2 unaffected, openMemoryDbSafe returns null | **Covered** — 3 tests (Tier 2 still writes, Tier 1 still writes, safe open returns null) |
| AC-T3-7 | Agent receives text excerpts, not a database connection | **Covered** — 2 tests (return type is string, path not exposed in output) |

### Coverage Gaps

**Gap 1 — FM-2 inspector unreachable path has no test coverage**

`tier3.ts` lines 160-174 contain the inspector-unreachable catch block, which silently returns without writing to `memory_audit`. There is no test that (a) verifies a `rejected_write` audit row is produced on inspector failure, or (b) even confirms the silent-return behavior. Given the comment in the source acknowledges the gap, the test suite does not exercise this path. Any future fix to FM-2 would need a test added.

**Gap 2 — AC-T3-4 schema constraint is soft**

The `source_check_id TEXT NOT NULL` constraint exists in the DDL (confirmed by the schema test at line 1454-1473), so a raw INSERT omitting the column will be rejected by SQLite. However, the test at line 1454 checks the DDL text for the column name rather than attempting a NULL insert and asserting it throws. The constraint enforcement is correct but the test validates presence of the field name, not the NOT NULL behavior. Low risk, but a tighter test would attempt `INSERT ... source_check_id = NULL` and assert the exception.

**Gap 3 — Decision 22 auto-create not tested in container spawn sequence**

The spec (Decision 22, FM-5) requires the orchestrator to call `ensureClaudeMd` before finalizing the bind mount configuration. The unit tests confirm `ensureClaudeMd` creates an empty file and does not call Cato, but there is no integration test connecting `ensureClaudeMd` to a container spawn sequence. This gap is acceptable while the orchestrator integration is pending (the tier modules are not yet wired in), but must be addressed in the orchestrator integration milestone.

---

## Overall Verdict: PASS WITH FINDINGS

The memory tier modules are correctly implemented against their spec. All 69 tests pass. The security invariants expressed in the tier module APIs are sound. The three findings above are design-level concerns about the boundary between the tier modules and the container-runner, and one spec-compliance gap in the Tier 3 failure mode handling.

---

## Blocking Issues

None. The findings below are pre-conditions for integration milestones, not blockers for this milestone.

**Pre-integration requirements (not blocking M21, required before orchestrator wiring):**

1. **Before Tier 2 integration:** Resolve F-1 by modifying `container-runner.ts::buildMounts` to mount only specific files from the group directory, preventing `messages.db` from being accessible inside containers.

2. **Before Tier 3 integration:** Resolve F-2 by implementing the FM-2 inspector-unreachable audit path in `tier3.ts::writeMemoryEntry`, and add a test for it.

3. **Before Tier 3 integration:** Consider resolving F-3 by replacing the `PRAGMA foreign_keys=OFF` window with a placeholder entry design, as a cleaner long-term approach to rejected-write audit logging.
