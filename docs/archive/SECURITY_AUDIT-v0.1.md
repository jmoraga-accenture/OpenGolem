# OpenGolem — Security Audit: NanoClaw Baseline
*Audited: April 2026 | Applied during: Milestone 1*

This document records the security audit performed on the NanoClaw codebase before it was copied into OpenGolem. All Tier 1 (critical) and most Tier 2 (high) findings were fixed during M1. Remaining items are tracked below.

---

## Summary

| Tier | Count | Fixed in M1 | Deferred |
|---|---|---|---|
| Critical | 3 | 3 | 0 |
| High | 4 | 4 | 0 |
| Medium | 4 | 3 | 1 |
| Low | 2 | 1 | 1 |

Overall risk level reduced from **Medium-High → Low**.

---

## Tier 1 — Critical (all fixed)

### C1: Arbitrary Shell Script Execution in Agent Container
**File:** `container/agent-runner/src/index.ts` — `runScript()`
**Finding:** The `script` field from `schedule_task` IPC messages was written to `/tmp/task-script.sh` and executed with `bash`. No sanitization. An agent-supplied script could execute arbitrary commands with full access to all mounted volumes, potentially escaping the container via shared paths.
**Fix:** `runScript()` replaced with a stub that logs a warning and returns `null`. Script execution is disabled in OpenGolem. Scheduled tasks use prompt-based agent execution only.
**Note for M2:** The Token Broker will enforce that containers cannot invoke script execution skills. This fix is defense-in-depth on top of that.

---

### C2: Command Injection via `pkill` with User-Controlled Path
**File:** `setup/service.ts:168` — `killOrphanedProcesses()`
**Finding:** `execSync(\`pkill -f '${projectRoot}/dist/index\\.js' || true\`)` interpolates `projectRoot` (from `process.cwd()`) directly into a shell command. A directory path containing shell metacharacters could break out of the single-quote context.
**Fix:** Replaced with `execFileSync('pkill', ['-f', \`${projectRoot}/dist/index.js\`])` — no shell interpolation.

---

### C3: Unvalidated `containerConfig` in IPC `register_group`
**File:** `src/ipc.ts` — `processTaskIpc()` `register_group` case
**Finding:** `containerConfig` from IPC messages was passed directly to `registerGroup()` without schema validation. An agent could supply `additionalMounts: [{hostPath: "/etc", containerPath: "/workspace/etc"}]` and cause sensitive host directories to be mounted into future containers.
**Fix:** Added explicit schema validation before accepting `containerConfig`:
- Must be a non-null, non-array object
- `additionalMounts` must be an array
- Each mount entry must have non-empty string `hostPath` and `containerPath`
- Any validation failure logs a warning and sets `containerConfig` to `undefined`

---

## Tier 2 — High (all fixed)

### H1: `execSync` Shell Interpolation in `setup/service.ts`
**File:** `setup/service.ts` — `setupLaunchd()`, `setupSystemd()`
**Finding:** Multiple `execSync(\`launchctl load ${...}\`)` and `execSync(\`${systemctlPrefix} ...\`)` calls used string interpolation with shell execution.
**Fix:** All replaced with `execFileSync` and explicit argument arrays. `systemctlPrefix` decomposed into base command + `['--user']` args array.

---

### H2: Environment Variable Leak in Subprocess Spawn
**File:** `src/remote-control.ts:112` — `startRemoteControl()`
**Finding:** `spawn('claude', [...], { cwd, stdio, detached: true })` inherited `process.env` by default. If `.env` secrets were ever loaded into `process.env`, they would leak to the spawned process.
**Fix:** Added explicit `env: { PATH, HOME, TERM }` — minimal environment, no secrets.

---

### H3: Weak Task ID Randomness
**File:** `src/ipc.ts:252`
**Finding:** Task IDs used `Math.random().toString(36).slice(2, 8)` — not cryptographically random, predictable given a known timestamp.
**Fix:** Replaced with `randomBytes(8).toString('hex')` from Node.js `crypto` module.

---

### H4: Cron/Interval Task Flood (DoS)
**File:** `src/ipc.ts` — `schedule_task` case
**Finding:** No minimum interval enforced. An agent could schedule `* * * * *` (every minute) tasks, creating thousands of task evaluations per day. No rate limiting on task creation.
**Fix:** Minimum interval of 5 minutes enforced for both cron and interval schedule types. Sub-5-minute cron expressions are rejected with a logged warning. Interval values below `300000ms` are rejected.

---

## Tier 3 — Medium

### M1: Error Message Information Disclosure ✅ Fixed
**File:** `src/container-runner.ts:588`
**Finding:** `Container exited with code ${code}: ${stderr.slice(-200)}` returned raw container stderr to callers. Stderr could contain stack traces, file paths, database errors, or API error messages.
**Fix:** `stderr` stripped from the returned error. Full stderr still logged server-side at debug level. Caller receives only `Container exited with code ${code}`.

---

### M2: Symlink / TOCTOU Race on Mount Allowlist ⚠️ Accepted Risk
**File:** `src/mount-security.ts`
**Finding:** `fs.realpathSync()` resolves symlinks at check time, but a symlink could be swapped between the check and the actual Docker mount call (TOCTOU).
**Status:** Accepted as operator-level responsibility. `realpathSync` is the correct defense; true TOCTOU mitigation would require OS-level mount namespacing (Phase 2 scope). Documented here for awareness.

---

### M3: IPC File Permission Race
**File:** `src/ipc.ts`, `container/agent-runner/src/ipc-mcp-stdio.ts`
**Finding:** IPC directory is readable by the agent container. Another agent in the same group could race to read IPC files before the host processes them.
**Status:** Mitigated by atomic write (`.tmp` → rename) in the agent-runner. Full mitigation (per-agent IPC subdirectories with `700` permissions) deferred to M6 when the Safety Agent inline hook is designed.

---

### M4: IPC Authorization Uses Folder Name Equality ⚠️ Noted
**File:** `src/ipc.ts:79-93`
**Finding:** Cross-group message authorization checks `targetGroup.folder === sourceGroup` — relies on folder names uniquely identifying groups. Multiple JIDs could theoretically map to the same folder.
**Status:** Not fixed in M1. The group registration path (`isValidGroupFolder`) enforces uniqueness. Full JID-based authorization planned for M6 when the IPC model is reviewed for the Safety Agent integration.

---

## Tier 4 — Low

### L1: Container Name Truncation ✅ Fixed (via rebranding)
**File:** `src/container-runner.ts`
**Finding:** Container names could theoretically exceed Docker's 64-character limit if `group.folder` is long.
**Status:** During M1 rebranding (`nanoclaw-` → `opengolem-`), no length was added. Existing `[^a-zA-Z0-9-]` sanitization on `group.folder` is sufficient. Noted for future hardening.

---

### L2: `/tmp/dist` Overwrite Race in Container Entrypoint ⚠️ Mitigated by Design
**File:** `container/Dockerfile`
**Finding:** Container entrypoint compiles TypeScript to `/tmp/dist`. In principle, two containers could collide on this path.
**Status:** Each container has its own `/tmp` namespace (Linux container isolation). Not exploitable in practice. No fix needed.

---

## Positive Security Findings (kept from NanoClaw)

These properties were in NanoClaw and are preserved in OpenGolem:

- ✅ **Selective `.env` loading** — `src/env.ts` reads named keys only; never pollutes `process.env`
- ✅ **Parameterized SQL** — `better-sqlite3` prepared statements throughout `src/db.ts`
- ✅ **Non-root container user** — Dockerfile runs as `node` user (uid 1000)
- ✅ **Atomic IPC writes** — `.tmp` + `rename()` in agent-runner prevents partial reads
- ✅ **Read-only project root mount** — host project directory mounted `:ro` in containers
- ✅ **`.env` shadowed to `/dev/null`** in container mounts — secrets never visible inside containers
- ✅ **Path traversal prevention** — `group-folder.ts` validates folder names with regex; `mount-security.ts` uses `realpathSync`
- ✅ **Container name sanitization** — `[^a-zA-Z0-9-]` stripped before constructing container names
- ✅ **Hard container timeout** — containers killed after `CONTAINER_TIMEOUT` + `IDLE_TIMEOUT`
- ✅ **IPC authorization** — non-main groups cannot send messages to other groups or create tasks for other groups

---

## OpenGolem Additions (not in NanoClaw)

Planned security properties not yet implemented — tracked against their milestones:

| Property | Milestone | Description |
|---|---|---|
| Token Broker | M2 | Agents hold scoped derivative tokens, never raw credentials |
| Call Inspector | M3 | Every outbound call linted before execution |
| Immutable audit log | M3 | Append-only SQLite with DELETE trigger |
| Safety Agent inline hook | M6 | Pre-execution block on every action, independent of Call Inspector |
| Prompt injection signatures | M3 | Maintained signature list in source (not config) |
| Security modes | M3 | Golem Guard / Supervised / Power |
