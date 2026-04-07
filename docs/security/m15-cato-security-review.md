# M15 Cato Security Review

*Produced: 2026-04-07 | Reviewer: Security Reviewer (Claude Sonnet 4.6) | Stream: G*

**Verdict: PASS WITH FINDINGS**

One blocking finding was identified and fixed before this verdict was recorded. Two medium findings are documented for operator awareness but do not block the milestone.

---

## Scope

Files reviewed:

- `docs/specs/cato-spec.md`
- `docs/ARCHITECTURE.md` §2 (trust domains), §3.4 (Cato responsibilities)
- `src/cato/inline.ts`
- `src/cato/scheduled-audit.ts`
- `src/cato/dao-score.ts`
- `src/config.ts`
- `src/shared/audit/index.ts`
- `src/broker/server.ts` (for comparison of socket hardening pattern)
- `src/orchestrator/index.ts` (Cato client call paths)

---

## DoD Checklist Results

| # | Check | Result |
|---|-------|--------|
| 1 | Inline hook is fail-closed (socket unreachable = block) | PASS |
| 2 | No path from TD-CONTAINER to TD-CATO | PASS (see F-2) |
| 3 | Cato never holds or issues credentials or tokens | PASS |
| 4 | `contentExcerpt` never logged or stored | PASS |
| 5 | Hansei reports are atomic (write-temp-then-rename, correct path) | PASS |
| 6 | Audit log writes for every check (allow and block) | PASS |
| 7 | `reason` field never reproduces payload content | PASS |
| 8 | Scheduled audit reads audit log read-only during read phase | PASS |
| 9 | PSYCHE.md loaded at startup and each audit (not cached) | PASS |
| 10 | Unknown `action` values return `allow: false` | PASS |

---

## Findings

### F-1 — Blocking — Cato socket lacks owner-only permissions

**Severity:** Blocking

**Description:**
`src/cato/inline.ts` created the Cato Unix socket at `data/sockets/cato.sock` without restricting its filesystem permissions. The socket was world-accessible to any process on the host running as any user. The Token Broker socket (`src/broker/server.ts`) correctly applies `fs.chmodSync(socketPath, 0o600)` after binding. Cato omitted this step.

On a hardened host where containers run under a distinct UID (standard Docker practice), this is mitigated by filesystem isolation. However the spec requires defense in depth — Cato's socket should be reachable only by the orchestrator process owner. Without the chmod any local process sharing the host user could craft Cato check requests and receive `allow: true` responses, potentially bypassing the intent of the oversight layer.

**Fix applied:** Added `fs.chmodSync(socketPath, 0o600)` inside the `catoServer.listen` callback in `src/cato/inline.ts`, matching the broker pattern exactly.

```typescript
catoServer.listen(socketPath, () => {
  // Restrict socket to owner-only access — prevents local processes
  // running as other users from connecting to Cato (hardening, matches
  // broker socket pattern in src/broker/server.ts).
  fs.chmodSync(socketPath, 0o600);
  logger.info({ socketPath }, 'Cato: inline hook listening');
});
```

---

### F-2 — Medium — Container mounts do not explicitly exclude the sockets directory

**Severity:** Medium (deferred)

**Description:**
Architecture mandates no path from TD-CONTAINER to TD-CATO. The socket directory `data/sockets/` is not listed in any container bind-mount deny list — enforcement relies entirely on the orchestrator not mounting it. `src/container-runner.ts` controls mount composition; a future regression that accidentally mounts `data/` broadly could expose the socket to a container. The F-1 fix (chmod 0o600) provides a filesystem backstop, but an explicit exclusion in mount composition would add a second layer.

**Fix:** Deferred. Recommend adding an explicit assertion in `container-runner.ts` that the socket directory is never included in container mounts (as a mount-time sanity check). Tracked as a hardening item for M16 or the next container-runner review.

---

### F-3 — Medium — `response_snippet` from agent output flows into scheduled audit prompt

**Severity:** Medium (deferred)

**Description:**
`buildAuditSummary()` in `src/cato/scheduled-audit.ts` reads `response_snippet` from the legacy `flag_events` table (inspector DB) and embeds up to 120 characters of it into the plaintext prompt sent to the Cato audit container. `response_snippet` contains the first 200 characters of an agent response that triggered a `[FLAG]` marker.

While this is not `contentExcerpt` (the base64 payload reviewed by the inline hook), it is a slice of actual agent output content being injected into Cato's reasoning context. This means content authored by users (or by compromised agents) can reach the Cato LLM container through the scheduled audit path.

The spec (§3.3) states the LLM is forbidden to ask for "the raw payload or any excerpt of it not explicitly provided." The `response_snippet` inclusion pre-dates the Phase 2 LLM escalation path and is used for the legacy container audit, not the inline deterministic path — so it is not a violation of the inline check invariants. However it represents a low-confidence injection surface for the audit LLM.

**Fix:** Deferred to Phase 2 LLM escalation hardening. Consider stripping `response_snippet` from the audit summary or replacing it with only the assertiveness level and a hashed identifier. Tracked for the PSYCHE.md revision gating Phase 2 LLM criteria.

---

## Notes

- `contentExcerpt` is confirmed absent from all audit log writes (`writeAuditEvent` writes only `payloadHash` and `payloadSize`) and from all logger calls in the inline hook path.
- All `reason` field values in block responses are static string literals — none reproduce payload content.
- `loadPsycheMd()` calls `fs.readFileSync` on every `runCatoAudit()` invocation with no module-level caching. Each audit run sees any changes made to `runtime/PSYCHE.md` since the previous run.
- The `openAuditLog` API surface is INSERT-only by construction (`db.prepare(INSERT ...)` is the only prepared statement). No UPDATE or DELETE path exists through the Cato write interface.
- Hansei report path: `data/hansei/inbox/hansei-<ISO8601compact>-<uuid>.json`. Write is atomic: `writeFileSync(tmpPath)` followed by `renameSync(tmpPath, finalPath)`. Correct.
