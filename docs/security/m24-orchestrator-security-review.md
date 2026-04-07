# M24 — Orchestrator v2: Security Review and QA (Re-Review)

*Original review: 2026-04-07 | Re-review: 2026-04-07*
*Reviewer: Claude Code (Security Reviewer + QA/QC role)*
*Implementation: `src/orchestrator/index.ts` (1148 lines)*
*Test suite: `src/orchestrator/orchestrator.test.ts` (M22)*
*Spec: `docs/specs/orchestrator-spec.md`*

---

## Security Reviewer Verdict: PASS

All three blocking issues from the previous M24 review are resolved. All required security checks pass. Two non-blocking findings from the previous review (F-2 and the AC-20 gap) remain open and are correctly deferred to a later milestone. One new informational finding is recorded below.

---

## Blocking Issue Resolution

### BLK-1 (F-1): MEMORY_WRITE persistence not implemented — RESOLVED

**Previous state:** `applyMemoryWriteProposal()` performed the Cato gate check but did not write the approved delta to `CLAUDE.md`. Additionally the audit event names deviated from spec (`memory_write_allowed` vs `memory_write_approved`; `cato_block` vs `memory_write_blocked`).

**Current state (lines 776–791):** After `allow: true`, the method now constructs the canonical path `path.join(this.rootDir, 'groups', proposal.groupId, 'CLAUDE.md')` and calls `fs.writeFileSync(claudePath, proposal.proposedDelta, 'utf8')`. The approval audit event is named `memory_write_approved`. The blocked path (lines 762–774) emits `memory_write_blocked` as a standalone event type, not the generic `cato_block`. Both are correct per spec §2.6.

**Verification:** Test AC-11 (`orchestrator.test.ts:1977–2017`) reads the file back after `applyMemoryWriteProposal()` with `allow: true` and asserts `written === delta`. It also asserts `audit.entries.some(e => e.eventType === 'memory_write_approved')` and `!audit.entries.some(e => e.eventType === 'memory_write_allowed')`. Test AC-12 (`orchestrator.test.ts:2019–2060`) asserts the file content is unchanged after a block and that `memory_write_blocked` is emitted. Both tests pass.

**BLK-1: CLOSED.**

---

### BLK-2 (F-3): Cato block path leaks active group lock — RESOLVED

**Previous state:** In `_dispatchTask()`, when Cato returned `allow: false` on the `AGENT_PROMPT` check, the method returned without calling `this.activeGroups.delete(groupId)` or `this._drainQueue(groupId)`. Groups receiving a Cato block became permanently stalled.

**Current state (lines 989–991):** The Cato block path now reads:

```typescript
this.activeGroups.delete(groupId);
this._drainQueue(groupId);
return;
```

This is confirmed by the comment at line 988: `// BLK-2 fix: release group lock so queue can drain`. The group lock is cleared on the block path before returning.

**Verification:** The existing AC-8 test (`orchestrator.test.ts:1609–1651`) verifies that the container is not spawned and the token is revoked on a Cato block. The BLK-2 fix is confirmed by the presence of both lines in the implementation. No regression test for queue-drain-after-Cato-block was added (the previous review noted this as a gap), but the implementation fix is structurally sound and the token/revoke lifecycle is verified.

**BLK-2: CLOSED.**

---

### BLK-3 (AC-11, AC-12): Missing tests for MEMORY_WRITE gate — RESOLVED

**Previous state:** No tests exercised the blocked or approved MEMORY_WRITE paths.

**Current state:** Two new tests appear in the invariants section of `orchestrator.test.ts`:

- AC-11 (`orchestrator.test.ts:1977`): `'AC-11: MEMORY_WRITE approved — delta written to CLAUDE.md and memory_write_approved audit event emitted'` — confirms the write and the event name.
- AC-12 (`orchestrator.test.ts:2019`): `'AC-12: MEMORY_WRITE blocked — CLAUDE.md unchanged and memory_write_blocked audit event emitted'` — confirms the file is not modified and the blocked event name is correct.

Both tests use `audit.entries` (not the previous incorrect `.events`) and `cato.blockAll()` (not params), matching the `AuditCapture` and `startFakeCato` helper APIs.

**BLK-3: CLOSED.**

---

## Required Security Checks

### Check 1: No raw credentials in orchestrator memory (INV-7)

PASS.

No API key, OAuth token, Bitwarden session credential, or other long-lived secret appears anywhere in `src/orchestrator/index.ts`. The file imports only `crypto`, `fs`, `net`, and `path` from Node core. No `process.env` reads appear. No logging calls that could emit token material are present.

The opaque derivative token string (`_token`) is received at line 921, stored in a local variable prefixed with underscore to indicate intentionally unused status, and never passed to `runContainer()`, never appended to audit entries, and never persisted. The `tokenId` reference identifier appears in audit entries instead. This satisfies INV-7.

The no-credentials invariant test (AC-29, `orchestrator.test.ts:2064–2095`) independently verifies that `issueToken` params contain no `api_key`, `oauth_token`, `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, or `BW_SESSION` fields.

### Check 2: No path from TD-CONTAINER to TD-CATO (Architecture §2.2)

PASS.

The `catoSocketPath` is a private class field used exclusively within `sendCatoCheck()` calls at lines 636 and 696. These are only reachable from `handleCatoEscalate()` and `performCatoCheck()`, which are called by orchestrator-owned methods only.

Container output reaches the orchestrator only through the sentinel protocol (`parseSentinelOutput`), which extracts JSON between fixed markers from stdout. There is no mechanism by which container-supplied data could cause a Cato socket connection to be opened. The escalation socket server (`_startEscalationServer`) accepts connections from the broker only. No path from containers to that server exists in the implementation.

### Check 3: Escalation relay strips broker-internal fields before forwarding to Cato (Decision 23)

PASS.

In `handleCatoEscalate()` (lines 624–632), the relay constructs the Cato request object explicitly:

```typescript
const catoReq = {
  checkId: params.checkId,
  action: params.action,
  contextId: params.contextId,
  tokenId: params.tokenId,
  payloadHash: params.payloadHash,
  payloadSize: params.payloadSize,
  contentExcerpt: params.contentExcerpt,
};
```

Only the seven permitted fields are included. `escalationReason` and `inspectorCheck` are received in `params` but are not copied into `catoReq`. `contentExcerpt` is passed through unchanged per Decision 23.

The test at `orchestrator.test.ts:1263–1264` asserts `escalationReason` and `inspectorCheck` do not appear in the serialized Cato request.

### Check 4: MEMORY_WRITE gate is non-bypassable (spec §3.10, INV-4)

PASS.

`applyMemoryWriteProposal()` (lines 746–792) unconditionally calls `performCatoCheck()` with `action: 'MEMORY_WRITE'` before proceeding. If Cato returns `allow: false` or is unreachable (which also returns `allow: false` via fail-closed logic at lines 697–705), the method returns early without writing. There is no code path through `applyMemoryWriteProposal` that bypasses the Cato check and reaches `fs.writeFileSync`.

The two direct `fs.writeFileSync` calls in `_ensureGroupScaffold()` (lines 1105, 1112) write empty scaffold files only — no agent-proposed content — and are explicitly exempted from the MEMORY_WRITE gate by the spec (Decision 22, AC-26).

The persistence defect from the previous review (BLK-1) is fixed: the approved delta is now written at line 783 after `allow: true`, with correct audit event naming. The gate is both non-bypassable and functional.

### Check 5: Security mode loaded from group config, not from mutable runtime state (Decision 25, Architecture §3.0)

PASS.

`securityMode` is derived exclusively from the `loadGroupConfig()` return value at line 880. There is no `securityMode` field on the `Orchestrator` class, no mutable runtime variable holding it, and no mechanism for in-flight updates. Each task dispatch reloads group config fresh from the filesystem. `loadGroupConfig()` validates the value against `VALID_SECURITY_MODES` and falls back to `DEPLOYMENT_DEFAULTS` (`securityMode: 'golem_guard'`) on any parse or validation failure.

---

## Fresh Security Review — New Issues

### F-NEW-1: `groupId` used in filesystem path without path-traversal sanitization [Low / Informational]

`groupId` from an inbound message is used to construct a filesystem path at line 874:

```typescript
const groupDir = path.join(this.rootDir, 'groups', groupId);
```

The same unsanitized `groupId` appears in `applyMemoryWriteProposal()` at line 777–781 to construct the `CLAUDE.md` write path. `_validateMessage()` checks only that `groupId` is truthy (non-empty); it does not reject values containing `..` or path separators.

A `groupId` of `../../../etc` would construct a path outside the groups directory. The attack vector requires that a caller supply a maliciously crafted `groupId` to `deliver()` or `applyMemoryWriteProposal()`. In practice, `groupId` is sourced from channel adapter code that derives it from trusted runtime state (chat JID normalization), and `applyMemoryWriteProposal()` is only called by orchestrator-internal code. This is not a trust-domain boundary crossing in the current architecture.

However, the absence of sanitization means a future code path that accepts `groupId` from an untrusted source (e.g. the remote-control surface or a future broker-supplied field) could introduce a traversal vulnerability without any existing guard catching it.

Recommendation (non-blocking): Add a `groupId` format assertion in `_validateMessage()` (e.g. `if (!/^[a-zA-Z0-9_\-]+$/.test(msg.groupId)) throw new Error(...)`) and in `applyMemoryWriteProposal()`. This closes the pattern before it becomes a trust domain issue.

### F-NEW-2: TTL timer `await this._revokeToken(tokenId)` runs inside `setTimeout` callback — unhandled rejection risk [Informational]

At line 948, the TTL handler calls `await this._revokeToken(tokenId)` inside an `async` `setTimeout` callback:

```typescript
const ttlTimer = setTimeout(async () => {
  ...
  await this._revokeToken(tokenId);
  resolveTtlAbort('TTL expired');
  ...
}, this.defaultTtlMs);
```

`_revokeToken` catches its own errors internally (lines 1079–1087 wrap the `sendJsonRpc` in a `try/catch` and always appends the `token_revoke` audit entry), so in practice the revocation never rejects. However the `async` callback pattern inside `setTimeout` is structurally unguarded — if `_revokeToken` were changed to throw before the `try/catch`, the rejection would be silently swallowed by the Node.js event loop (pre-v15 behavior) or converted to an `unhandledRejection` event. The current implementation is safe because `_revokeToken` is already defensively coded, but the pattern is fragile.

This finding is informational only and does not represent a current security issue.

---

## Deferred Findings (Carried from Previous Review)

The following non-blocking items from the previous review remain open and are correctly deferred:

- **F-2 (Low):** Derivative token not passed to container spawn; container cannot authenticate to credential proxy. Will be resolved when the credential proxy integration is wired end-to-end.
- **AC-20 gap:** Audit log write failure behavior is unverified.
- **AC-1–AC-4 gap:** Startup sequence tests are absent.
- **AC-22, AC-23, AC-24 gap:** Skill lifecycle tests deferred pending M-skill milestone.
- **AC-30 gap:** Health endpoint HTTP server not present; deferred.

---

## QA Verdict: PASS

All 783 active tests pass. 25 tests are correctly marked skip (supervised mode confirm/cancel — Phase 2; SQLite integration — environment dependency).

### Test Results

**Full suite:**

```
Test Files  38 passed (38)
      Tests 783 passed | 25 skipped (808)
   Duration  5.80s
```

**Orchestrator-specific tests added since previous review:**

| Test | AC | Result |
|------|----|--------|
| `AC-11: MEMORY_WRITE approved — delta written to CLAUDE.md and memory_write_approved audit event emitted` | AC-11 | PASS |
| `AC-12: MEMORY_WRITE blocked — CLAUDE.md unchanged and memory_write_blocked audit event emitted` | AC-12 | PASS |

### Acceptance Criteria Coverage (Updated)

| AC | Description | Coverage |
|----|-------------|---------|
| AC-5 | `issueToken` called before spawn; `token_request` in audit | COVERED |
| AC-6 | `revokeToken` called and `token_revoke` in audit on task completion | COVERED |
| AC-7 | `token_store_full` → no spawn, user notified | COVERED |
| AC-8 | Cato `allow:false` on `AGENT_PROMPT` → no spawn, `cato_block` in audit | COVERED |
| AC-9 | Cato socket unreachable → no spawn, user notified | COVERED |
| AC-10 | `contentExcerpt` non-null for `AGENT_PROMPT`/`MEMORY_WRITE`; null for `FILESYSTEM_WRITE`/`CREDENTIAL_REQUEST` | COVERED |
| AC-11 | Cato `allow:false` on `MEMORY_WRITE` → no write to `CLAUDE.md`, `memory_write_blocked` in audit | **NOW COVERED** |
| AC-12 | Cato `allow:true` on `MEMORY_WRITE` → write to `CLAUDE.md`, `memory_write_approved` in audit | **NOW COVERED** |
| AC-13 | `container_spawn` audit entry has `containerId`, `mountPaths`, `tokenId` | COVERED |
| AC-14 | TTL expiry → container torn down, token revoked, `container_ttl_expired` in audit, user notified | COVERED |
| AC-15 | Second message to idle group dispatches new task | COVERED |
| AC-16 | Second message to active group enters queue, not dispatched | COVERED |
| AC-17 | `catoEscalate` forwarded to Cato; `escalationReason`/`inspectorCheck` stripped; response returned to broker | COVERED |
| AC-18 | Cato unreachable during escalation → `allow:false` to broker, `cato_check_relayed` blocked outcome | COVERED |
| AC-20 | Audit log write failure → Orchestrator does not proceed | NOT COVERED (deferred) |
| AC-21 | No UPDATE or DELETE in audit write interface | COVERED |
| AC-25 | Missing `messages.db` → auto-created | COVERED |
| AC-26 | Missing `CLAUDE.md` → empty file auto-created before spawn | COVERED |
| AC-27 | Remote-control task → `task_start` with `sourceChannel: "remote-control"` | COVERED |
| AC-28 | Remote-control bridge error → no task record, no container spawned | COVERED |
| AC-29 | No raw credentials in orchestrator process memory during test run | COVERED |

---

## Overall Verdict: PASS

All three blocking issues from the M24 FAIL report are resolved. The implementation is structurally sound for security purposes. All five required security checks pass. No trust domain violations are present. The MEMORY_WRITE gate is now both non-bypassable and functionally complete. The Cato block path correctly releases the group lock. AC-11 and AC-12 are now covered by tests. 783 tests pass.

M24 is closed. M23 may proceed to merge.

---

*Previous review issued FAIL on 2026-04-07 due to BLK-1, BLK-2, and BLK-3. All three resolved before this re-review.*
