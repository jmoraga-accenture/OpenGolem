# OpenGolem — Runtime Loss Validation with Evidence

Date: 2026-04-07
Comparison target: current `v0.3` code (`c68d655`)
Method: static validation against the codebase, with function/script-level evidence

## Purpose

This document validates reported runtime losses against the actual v0.3 code.
It does **not** assume the reports are correct.
Each claim is classified as one of:
- **Confirmed** — the code clearly implements the problematic behavior
- **Contradicted** — the code clearly implements the opposite behavior
- **Partially supported** — some mechanism exists, but a related failure mode is also present
- **Inconclusive** — the code alone cannot prove or disprove the report

---

## Executive summary

After validating the code, the runtime-loss claims split into two groups:

### Confirmed / partially confirmed
1. **Session reset when context/session state gets too large** — **Confirmed**
2. **Continuity can be lost under certain fallback conditions** — **Partially supported**

### Contradicted by the code
3. **Bots cannot create files in their workspace** — **Contradicted**
4. **Everything is transient / no persistence exists** — **Contradicted**
5. **There is no context compaction path** — **Contradicted**

So the accurate conclusion is:

> The code does contain a real and important continuity hazard — explicit session clearing when the stored session file becomes too large — but it does **not** support the stronger claim that the system has no writable workspace, no persistence, or no compaction mechanism.

---

## Claim 1 — "Bots couldn't even create files in their workspace"
**Verdict:** Contradicted

## Evidence

### 1. Container filesystem is explicitly writable at `/workspace/group`
- `container/Dockerfile:60-67`
  - `chown -R node:node /workspace`
  - `WORKDIR /workspace/group`

This is explicit setup for a writable workspace owned by the runtime user.

### 2. Group workspace is mounted read-write into the container
- `src/container-runner.ts:230-239`
  - mounts `groupDir -> /workspace/group`
  - `readonly: false`

This is the central runtime fact. The group workspace is not mounted read-only.

### 3. Group folders are created on registration
- `src/index.ts:163-188`
  - `copyClaudeTemplate()` writes `CLAUDE.md`
  - `registerGroup()` creates `logs/` and group filesystem structure

That means the host-side workspace path is expected to exist and be writable.

## Important nuance
There **is** a read-only project mount for the main group:
- `src/container-runner.ts:216-228`
  - `projectRoot -> /workspace/project`
  - `readonly: true`

So if an agent was trying to write to `/workspace/project`, that would fail **by design**.
But that is different from saying it cannot write to its workspace.
The writable workspace is `/workspace/group`, not `/workspace/project`.

## Conclusion
The claim that bots cannot create files in their workspace is **not supported by the code**.
A more accurate possibility is:
- the agent wrote to the wrong mount (`/workspace/project` instead of `/workspace/group`), or
- there was an environment/runtime bug outside the static code path.

---

## Claim 2 — "Everything was transient"
**Verdict:** Contradicted

## Evidence

### 1. Claude session state is persisted on the host
- `src/container-runner.ts:131-205`
  - `prepareSessionLayout()` uses `DATA_DIR/sessions/<groupFolder>/...`
  - creates persistent `.claude/` directory on the host
  - copies agent runner source and skills into the session layout

This is host-backed persistence, not transient in-container state.

### 2. Session IDs are persisted in SQLite
- `src/db.ts:570-584`
  - `getSession(groupFolder)`
  - `setSession(groupFolder, sessionId)`
- `src/db.ts:591-600`
  - `getAllSessions()`

That is explicit persistence of session identity across runs.

### 3. The orchestrator restores and updates session state
- `src/index.ts:125-126`
  - loads `sessions = getAllSessions()` at startup
- `src/index.ts:458-462`, `494-497`
  - stores `newSessionId` back to the DB when the container reports one

### 4. Message history is stored persistently in SQLite
- `src/db.ts:52-84`, `279-283`, `437-457`
  - persistent `messages` and `scheduled_tasks` tables
  - database initialized under `store/messages.db`
  - inbound messages written durably

## Conclusion
The system is **not** architected as fully transient.
It has durable storage for:
- session IDs
- message history
- scheduled tasks
- group folders
- Claude session state

What *is* true is that continuity can still be broken by specific fallback paths (see Claims 4 and 5).
But the stronger statement "everything was transient" is contradicted by the code.

---

## Claim 3 — "They were not compacting context"
**Verdict:** Contradicted

## Evidence

### 1. There is an explicit PreCompact hook
- `container/agent-runner/src/index.ts:160-208`
  - `createPreCompactHook()`
  - archives transcript before compaction

### 2. The PreCompact hook is actually registered with the SDK query
- `container/agent-runner/src/index.ts:500-503`
  - `hooks: { PreCompact: [ { hooks: [createPreCompactHook(...)] } ] }`

### 3. Compaction archives are written into the persistent group workspace
- `container/agent-runner/src/index.ts:186-199`
  - writes archived transcript to `/workspace/group/conversations/<date>-<summary>.md`

## What this means
The code does have a context-compaction path.
More specifically, it has:
- an SDK-level compaction hook
- pre-compaction archiving of the full transcript into the persistent workspace

## Important nuance
This does **not** prove the compaction experience is ideal.
It only proves that the claim "there is no compaction path" is false.

Possible weaker criticism that remains valid:
- compaction exists but may not be sufficient in practice
- compaction depends on SDK behavior, not just host orchestration
- the system still has a separate hard-reset path when sessions become too large

---

## Claim 4 — "They reset the session when context was too long"
**Verdict:** Confirmed

## Evidence

### 1. Hard session-size guard exists in the orchestrator
- `src/index.ts:484`
  - `const MAX_SESSION_BYTES = 10_000_000;`
- `src/index.ts:430-450`
  - looks up the session transcript file under `data/sessions/<group>/.claude/projects/-workspace-group/<sessionId>.jsonl`
  - if file size exceeds `MAX_SESSION_BYTES`, logs warning:
    - `Session too large — clearing before spawn to prevent proxy timeout`
  - then clears session mapping:
    - `delete sessions[group.folder]`
    - `deleteSession(group.folder)`

This is direct evidence of a reset/clear behavior triggered by oversized session state.

## Interpretation
This is not exactly "context too long" in token-count terms.
It is "persisted Claude session file too large" in byte-size terms.
But operationally, the user-facing effect is similar:
- session continuity is discarded
- next run starts effectively fresh

## Conclusion
This reported loss is **real**.
The code confirms an explicit continuity-breaking fallback when session state grows too large.

---

## Claim 5 — "Continuity is lost under failure conditions"
**Verdict:** Partially supported

## Evidence

### 1. Oversized-session path clears continuity
- see Claim 4 (`src/index.ts:430-450`)

### 2. Stale session detection also clears continuity
- `src/container-runner.ts:654-665`
  - detects stale/missing session conditions and returns error
- `src/container-runner.ts:681-690`
  - normalizes stale session failure to `No conversation found — stale session cleared`
- `src/index.ts:500-506`
  - on stale-session error, deletes session mapping from the DB

This means continuity is preserved normally, but there are explicit fallback paths that clear it.

## Interpretation
So the right statement is not:
- "continuity does not exist"

It is:
- **continuity exists, but it can be broken by specific guard/fallback paths**

That is a materially different diagnosis.

---

## Consolidated catalog

| Claim | Verdict | Evidence |
|---|---|---|
| Bots cannot create files in workspace | **Contradicted** | `container/Dockerfile:60-67`, `src/container-runner.ts:230-239`, `src/index.ts:163-188` |
| Everything is transient | **Contradicted** | `src/container-runner.ts:131-205`, `src/db.ts:570-600`, `src/index.ts:125-126, 458-462, 494-497` |
| No context compaction exists | **Contradicted** | `container/agent-runner/src/index.ts:160-208`, `500-503`, `186-199` |
| Session gets reset when too large | **Confirmed** | `src/index.ts:430-450`, `484` |
| Continuity can be lost under fallback conditions | **Partially supported** | `src/index.ts:430-450`, `500-506`; `src/container-runner.ts:654-665`, `681-690` |

---

## Bottom line

The validation result is mixed:

### Real loss / real hazard
- **Yes:** the code does clear session continuity when stored session state becomes too large.
- **Yes:** stale-session handling also clears continuity.

### Not supported by the code
- **No:** it is not true that the bot has no writable workspace.
- **No:** it is not true that everything is transient.
- **No:** it is not true that there is no compaction mechanism.

## Best precise summary

> v0.3 does not appear to have lost persistence or workspace writing in general, but it does contain an explicit continuity-breaking reset path for oversized session state, plus a stale-session clear path. So the major validated regression is **continuity fragility**, not total loss of persistence.

That is a much more defensible conclusion than either extreme.
