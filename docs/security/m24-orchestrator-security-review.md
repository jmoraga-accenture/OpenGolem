# M24 — Orchestrator v2: Security Review and QA

*Reviewed: 2026-04-07 | Reviewer: Claude Code (Security Reviewer + QA/QC role)*
*Implementation: `src/orchestrator/index.ts` (1148 lines, M23)*
*Test suite: `src/orchestrator/orchestrator.test.ts` (M22)*
*Spec: `docs/specs/orchestrator-spec.md`*

---

## Security Reviewer Verdict: PASS WITH FINDINGS

All five required security checks pass. Two additional findings are recorded below — one of medium severity and one of low severity. Neither is a trust domain boundary violation.

---

### Required Checks

**Check 1: No raw credentials in orchestrator memory (INV-7)**

PASS.

No API key, OAuth token, Bitwarden session credential, or other long-lived secret appears anywhere in `src/orchestrator/index.ts`. The file imports only `crypto`, `fs`, `net`, and `path` from Node core — no credential or secrets libraries. No `process.env` reads appear. No `console.log` or logger calls are present that could leak token material.

The opaque derivative token string (`token`) is received from the broker response at `index.ts:877` and stored in a local variable, but it is never passed to the container spawn call (see Finding F-2 below), never appended to audit entries, and never persisted. The `tokenId` reference identifier — not the token value — is what appears in audit entries. This satisfies INV-7.

**Check 2: No path from TD-CONTAINER to TD-CATO (Architecture §2.2)**

PASS.

The `catoSocketPath` is a private class field (`index.ts:393`) used exclusively within `sendCatoCheck()` calls at lines 618 and 675. These are only reachable from `handleCatoEscalate()` and `performCatoCheck()`, both of which are called by the orchestrator's own methods — not by any container-exposed interface.

Container output reaches the orchestrator only through the sentinel protocol (`parseSentinelOutput`), which extracts JSON between fixed markers from stdout. There is no mechanism by which container output could cause a Cato socket connection to be opened. The escalation socket server (`_startEscalationServer`) accepts connections from the broker only — no path from containers to that server exists in the implementation.

Architecture §2.2 explicitly prohibits a TD-CONTAINER → TD-CATO path and this is enforced by the structure of the IPC: containers communicate via filesystem and stdout, never via Unix sockets.

**Check 3: Escalation relay strips broker-internal fields before forwarding to Cato (Decision 23)**

PASS.

In `handleCatoEscalate()` (`index.ts:594–638`), the relay constructs the Cato request object explicitly:

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

Only the seven permitted fields are included. `escalationReason` and `inspectorCheck` are received in `params` but are not copied into `catoReq`. `contentExcerpt` is passed through unchanged per Decision 23. This is correct.

The test at `orchestrator.test.ts:1023–1024` independently verifies this by asserting `escalationReason` and `inspectorCheck` do not appear in the serialized Cato request.

**Check 4: MEMORY_WRITE gate is non-bypassable (spec §3.10, INV-4)**

PASS WITH FINDINGS — gate logic is correct but implementation is incomplete (see Finding F-1).

The gate itself is non-bypassable: `applyMemoryWriteProposal()` (`index.ts:723–761`) unconditionally calls `performCatoCheck()` with `action: 'MEMORY_WRITE'` before proceeding. If Cato returns `allow: false` or is unreachable (which also returns `allow: false` via fail-closed logic at `index.ts:676–684`), the method returns early without writing. There is no code path through `applyMemoryWriteProposal` that bypasses the Cato check.

The only direct `writeFileSync` calls in the file are at `index.ts:1050` (empty `CLAUDE.md` scaffold) and `index.ts:1057` (empty `messages.db` scaffold) — both inside `_ensureGroupScaffold()`. These are first-use auto-creation of empty files, consistent with Decision 22 and explicitly exempted from the MEMORY_WRITE gate by the spec. No agent-proposed content delta is written here.

**However**, `applyMemoryWriteProposal()` does not itself write the approved delta to `CLAUDE.md` — it delegates persistence to the caller (comment at line 753: "caller is responsible for actual persistence"). This means the gate function approves but does not execute the write. This is a functional incompleteness rather than a bypassable gate — callers cannot write without calling `applyMemoryWriteProposal()` first, but the actual `CLAUDE.md` write after approval is not implemented. See Finding F-1.

**Check 5: Security mode loaded from group config, not from mutable runtime state (Decision 25, Architecture §3.0)**

PASS.

`securityMode` is derived exclusively from the `loadGroupConfig()` return value (`index.ts:843`). The call at `index.ts:864` passes `cfg.securityMode` — where `cfg` is the result of `loadGroupConfig(groupDir, { audit: this.audit })` — directly into the `issueToken` params. There is no `securityMode` field on the `Orchestrator` class, no mutable runtime variable holding it, and no mechanism for in-flight updates. Each task dispatch reloads group config fresh, and `loadGroupConfig()` reads from the filesystem, validates the value against `VALID_SECURITY_MODES`, and falls back to `DEPLOYMENT_DEFAULTS` (`securityMode: 'golem_guard'`) on any parse or validation failure. This satisfies Architecture §3.0: "the group config file is the source of truth, not in-memory ad hoc state."

---

### Additional Findings

**F-1: MEMORY_WRITE gate approves but does not persist — incomplete implementation [Medium]**

`applyMemoryWriteProposal()` performs the Cato gate check correctly and emits an audit event on approval, but it does not write the approved delta to `groups/{name}/CLAUDE.md`. The comment at `index.ts:753` reads "caller is responsible for actual persistence." The spec (§3.4 step 3b, AC-12) requires the orchestrator to perform the write after `allow: true`.

Additionally, the audit event name on approval is `memory_write_allowed` (`index.ts:755`) but the spec table (§2.6) and AC-12 require `memory_write_approved`. The blocked path emits `cato_block` with `action: 'MEMORY_WRITE'` rather than the spec-required `memory_write_blocked` event type.

Impact: Tier 1 memory mutations proposed by agents are silently discarded even after Cato approval. The system is safe (no unauthorized writes occur) but Tier 1 memory never updates from agent proposals. Audit consumers expecting `memory_write_approved` and `memory_write_blocked` events will see neither.

Fix required before full M23 sign-off:
1. After `allow: true`, write `proposal.proposedDelta` to `groups/{groupId}/CLAUDE.md` (append or replace per Tier 1 spec).
2. Change audit event name from `memory_write_allowed` to `memory_write_approved`.
3. Change the blocked-path audit event to `memory_write_blocked` (separate from the generic `cato_block`).
4. Add tests for AC-11 and AC-12 (see QA section).

**F-2: Opaque derivative token received but not passed to container — functional gap [Low / Informational]**

The `token` variable at `index.ts:877` receives the opaque derivative token string from the broker response, but this value is never passed to `runContainer()`. The container therefore starts without a derivative token in its environment. This means containers cannot currently authenticate to the credential proxy using their task-scoped token.

This is a security-neutral finding with respect to trust domain isolation (no credential leakage), but it is a functional incompleteness: the token-based credential proxy model requires the container to present its derivative token. The container spawn call will need to inject the token as an environment variable (`ANTHROPIC_BASE_URL` and the token itself) per the architecture spec (§2.5).

**F-3: Cato block path leaks active group lock — liveness issue [Medium]**

In `_dispatchTask()`, when Cato returns `allow: false` on the `AGENT_PROMPT` check (`index.ts:925–938`), the method calls `revokeToken` and `_notifyChannel` then `return`s — but it does **not** call `this.activeGroups.delete(groupId)` or `this._drainQueue(groupId)`. The group remains permanently marked as active after a Cato block. Any messages queued for that group will never be dispatched in the current session.

This is a liveness bug rather than a security vulnerability, but it could be used to permanently stall a group's message processing by triggering a Cato block (e.g. through prompt injection that the Call Inspector escalates). Existing tests for AC-8 do not detect this because they do not check queue state after a Cato block.

Fix: Add `this.activeGroups.delete(groupId); this._drainQueue(groupId);` before the `return` on the Cato-block path (`index.ts:938`).

---

## QA Verdict: PASS WITH FINDINGS

All 52 active tests pass. 2 tests are correctly marked skip (supervised mode confirm/cancel — Phase 2). The full suite of 781 tests passes.

---

### Test Results

**Orchestrator suite only:**

```
✓ src/orchestrator/orchestrator.test.ts (54 tests | 2 skipped) 584ms
  52 passed | 2 skipped
```

**Full suite:**

```
Test Files  38 passed (38)
      Tests 781 passed | 25 skipped (806)
   Duration  5.45s
```

All test files pass. No regressions introduced by M23 implementation.

---

### Acceptance Criteria Coverage

| AC | Description | Test Coverage |
|----|-------------|---------------|
| AC-1 | Orchestrator reaches healthy status when broker and Cato are listening | Not explicitly tested (startup sequence not exercised in isolation) |
| AC-2 | No container spawned when broker absent at startup | Partial — broker unavailability during dispatch tested (stub detection), not startup health check loop |
| AC-3 | No container spawned when Cato absent at startup | Partial — same as AC-2 |
| AC-4 | Escalation socket bound before broker health check | Not tested (socket creation order not asserted) |
| AC-5 | `issueToken` called before spawn; `token_request` in audit | COVERED — `'completes the full lifecycle'` test, `'passes securityMode from group config'` |
| AC-6 | `revokeToken` called and `token_revoke` in audit on task completion | COVERED — `'revokes token on task completion'` |
| AC-7 | `token_store_full` → no spawn, user notified | COVERED — stub detection test `'FAILS if implementation proceeds with task when issueToken returns token_store_full'` |
| AC-8 | Cato `allow:false` on `AGENT_PROMPT` → no spawn, `cato_block` in audit | COVERED — `'does not spawn container when Cato blocks AGENT_PROMPT'` |
| AC-9 | Cato socket unreachable → no spawn, user notified | COVERED — `'routes [BLOCKED] to channel when Cato socket is unreachable'` |
| AC-10 | `contentExcerpt` non-null for `AGENT_PROMPT`/`OUTBOUND_API_CALL`/`MEMORY_WRITE`; null for `FILESYSTEM_WRITE`/`CREDENTIAL_REQUEST` | COVERED — three `contentExcerpt` invariant tests |
| AC-11 | Cato `allow:false` on `MEMORY_WRITE` → no write to `CLAUDE.md`, `memory_write_blocked` in audit | **NOT COVERED** |
| AC-12 | Cato `allow:true` on `MEMORY_WRITE` → write to `CLAUDE.md`, `memory_write_approved` in audit | **NOT COVERED** |
| AC-13 | `container_spawn` audit entry has `containerId`, `mountPaths`, `tokenId` | COVERED — `'container_spawn audit entry includes containerId, mountPaths, and tokenId'` |
| AC-14 | TTL expiry → container torn down, token revoked, `container_ttl_expired` in audit, user notified | COVERED — `'revokes token when TTL expires'` |
| AC-15 | Second message to idle group dispatches new task | COVERED — `'drains queue after first task completes'` |
| AC-16 | Second message to active group enters queue, not dispatched | COVERED — `'queues second message while first task is active'` |
| AC-17 | `catoEscalate` forwarded to Cato; `escalationReason`/`inspectorCheck` stripped; response returned to broker | COVERED — `'forwards catoEscalate to cato.sock after stripping escalationReason and inspectorCheck'` |
| AC-18 | Cato unreachable during escalation → `allow:false` to broker, `cato_check_relayed` blocked outcome | COVERED — `'returns allow:false to broker when Cato is unreachable during escalation'` |
| AC-19 | Audit log entries exist with correct `eventType` before next operation | Implicitly covered across lifecycle tests; not asserted as ordering invariant |
| AC-20 | Audit log write failure → Orchestrator does not proceed | **NOT COVERED** |
| AC-21 | No UPDATE or DELETE in audit write interface | COVERED — `'Orchestrator write interface issues only INSERT statements'` |
| AC-22 | Valid `.intent.md` → skill registered, `registerSkillScope` called, `skill_applied` in audit | **NOT COVERED** (skill lifecycle not implemented in M23) |
| AC-23 | Invalid `.intent.md` → skill rejected, no `registerSkillScope`, registry unchanged | **NOT COVERED** (skill lifecycle not implemented in M23) |
| AC-24 | Skill removal → `deregisterSkillScope`, `skill_removed` in audit, existing tokens not revoked | **NOT COVERED** (skill lifecycle not implemented in M23) |
| AC-25 | Missing `messages.db` → auto-created with Tier 2 schema and WAL mode | COVERED — `'creates messages.db with WAL mode if absent before spawn'` (file creation verified; WAL pragma not verified at this layer) |
| AC-26 | Missing `CLAUDE.md` → empty file auto-created before spawn | COVERED — `'creates empty CLAUDE.md if absent before spawn'` |
| AC-27 | Remote-control task → `task_start` with `sourceChannel: "remote-control"` | COVERED — `'task_start entry includes sourceChannel: "remote-control"'` |
| AC-28 | Remote-control bridge error → no task record, no container spawned | COVERED — two tests in `'Remote-control surface fails closed'` |
| AC-29 | No raw credentials in orchestrator process memory during test run | COVERED — `'issueToken params contain no API key, OAuth token, or raw credential fields'` |
| AC-30 | Health endpoint reachable only on 127.0.0.1 | **NOT COVERED** (health endpoint HTTP server not implemented in M23) |

---

### Coverage Gaps

**Missing tests (blocking for full M22/M23 sign-off):**

1. **AC-11** — No test verifies that `MEMORY_WRITE` Cato block prevents the write to `CLAUDE.md` and emits `memory_write_blocked`. Related to F-1.

2. **AC-12** — No test verifies that `MEMORY_WRITE` Cato approval causes the delta to be written to `CLAUDE.md` and emits `memory_write_approved`. Related to F-1.

3. **AC-20** — No test for audit log write failure causing the guarded action to be suspended. This is the fail-safe behavior of INV-5.

**Missing tests (deferred — components not yet implemented):**

4. **AC-22, AC-23, AC-24** — Skill lifecycle (apply, validate, remove) tests not present. The M23 implementation does not implement the skill lifecycle methods; these ACs are deferred pending M-skill milestone.

5. **AC-30** — Health endpoint HTTP server not present in M23. Deferred.

**Partial coverage (startup sequence):**

6. **AC-1, AC-2, AC-3, AC-4** — Startup health check loop and escalation socket binding order are not directly exercised. The in-process dispatch tests cover the runtime behavior but not the startup contract. These would require a subprocess-level test or a testable `waitForBroker()` method.

7. **F-3 (Cato block group lock leak)** — The existing AC-8 test does not verify `getQueueDepth()` returns to 0 or that subsequent messages are dispatched after a Cato block. A regression test should be added for this.

---

## Overall Verdict: PASS WITH FINDINGS

The implementation is structurally sound for security purposes. All five required security checks pass. No trust domain violations are present. The escalation relay correctly strips broker-internal fields. The MEMORY_WRITE gate is architecturally non-bypassable. Security mode is loaded from group configuration, not from mutable runtime state.

---

## Blocking Issues

The following issues must be resolved before M24 is closed and M23 is merged:

**BLK-1 (F-1, Medium): MEMORY_WRITE persistence not implemented**
`applyMemoryWriteProposal()` does not write the approved delta to `CLAUDE.md`. The gate logic is correct but the write is absent. Additionally the audit event names deviate from spec (`memory_write_allowed` vs `memory_write_approved`; `cato_block` vs `memory_write_blocked`).

**BLK-2 (F-3, Medium): Cato block path leaks active group lock**
`_dispatchTask()` on the `allow: false` path does not call `activeGroups.delete(groupId)` or `_drainQueue(groupId)`. Any group that receives a Cato block becomes permanently stalled for the session.

**BLK-3 (AC-11, AC-12): Missing tests for MEMORY_WRITE gate**
Tests must be added for the blocked and approved MEMORY_WRITE cases before BLK-1 is fixed, so the fix is verified.

---

*The following findings are non-blocking but should be addressed in M25 or the next maintenance cycle:*

- **F-2 (Low):** Derivative token not passed to container spawn; container cannot authenticate to credential proxy. This will need to be resolved when the credential proxy integration is wired end-to-end.
- **AC-20 gap:** Audit log write failure behavior is unverified.
- **AC-1–AC-4 gap:** Startup sequence tests are absent.
