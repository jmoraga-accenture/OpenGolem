# M19 — Skill Schema: Security Review and QA

*Reviewed: 2026-04-07 | Reviewer: Claude Code (Security Reviewer role)*

---

## Security Reviewer Verdict: PASS WITH FINDINGS

One medium-severity path traversal issue is present in the mount-root allowlist check
(`skill-schema.ts:374–376`). The trust domain controls are otherwise correctly implemented.
The finding does not permit a container or channel to apply skills, but does create a
restricted escape in the `container_mounts` host-path allowlist.

---

### Trust Domain Crossing Review

#### Check 1: Skill application is TD-ADMIN only

**Finding: PASS.**

`applySkill` and `removeSkill` are exported from `src/skills/skill-schema.ts` but have
**no callers** anywhere in the orchestrator, IPC processor, or channel adapters in the
current codebase. Grep across `src/` confirms the only files that reference these symbols
are `skill-schema.ts` itself and `skill-schema.test.ts`.

There is no message handler, IPC command, or channel adapter pathway that accepts any
input and routes it into `applySkill`. A container (TD-CONTAINER) communicates with the
orchestrator exclusively through the stdout sentinel protocol
(`src/container-runner.ts`), which has no skill-application dispatch. Channel messages
flow through `src/router.ts` and the channel adapters, none of which call `applySkill`.

**Evidence:**
- `src/skills/skill-schema.ts` — sole definition of `applySkill` / `removeSkill`
- `src/ipc.ts` — no import or reference to skill-schema
- `src/index.ts` — no import or reference to skill-schema
- `src/router.ts` — no import or reference to skill-schema
- Grep result: only `skill-schema.ts` and `skill-schema.test.ts` contain `applySkill`

**Caveat:** The integration between the orchestrator and the Skill Schema module is not
yet wired in `src/index.ts`. When that wiring is added, the reviewer must re-confirm
that the call site is gated behind a TD-ADMIN authorization check (e.g. only accessible
through the Claude Code CLI or a local-only admin IPC channel, not reachable from a
channel message or container output).

---

#### Check 2: `.intent.md` validation cannot be bypassed

**Finding: PASS (with one sub-finding — see F-1 below).**

The `validateIntent` function in `skill-schema.ts:301–474` enforces all five required
fields unconditionally:

- `skill` — KEBAB_CASE regex enforced (`skill-schema.ts:303`)
- `version` — SEMVER regex enforced (`skill-schema.ts:308`)
- `type` — set membership enforced (`skill-schema.ts:313`)
- `description` — non-empty string enforced (`skill-schema.ts:318`)
- `apply_permission` — set membership enforced (`skill-schema.ts:323`)
- `providers.compatible` — non-empty array with per-item validation (`skill-schema.ts:329–336`)

These are enforced as hard rejections: `validateIntent` returns a `ValidationError`
object and the caller (`applySkill:680–686`) immediately returns `{ ok: false, ... }`
without proceeding to registry insertion or broker notification. There is no advisory-only
path or partial-validation mode.

The YAML parser is dependency-free and custom-written (`parseYamlBlock`,
`parseYamlList`, `parseScalar`). It is sufficient for the `.intent.md` schema and does
not expose any YAML deserialisation gadgets (no `__proto__` manipulation, no `!!js/eval`
tags, no dynamic dispatch). The parser returns plain `Record<string, unknown>` maps; all
field values are cast via `String()` or checked with `Array.isArray()` before use.

**Sub-finding F-1 (see below):** The `filesystem.container_mounts[].host_path`
validation is bypassable via path traversal. This is a validation enforcement gap, not
a bypass of the required-field gate, but it weakens the mount-root security boundary.

---

#### Check 3: Broker scope updates are atomic — no partial registration state

**Finding: PASS.**

The apply flow is:

1. Parse `.intent.md` (`skill-schema.ts:668–676`)
2. Validate all fields; fail-fast on first error (`skill-schema.ts:679–686`)
3. Check ID collision; fail if same context (`skill-schema.ts:694–707`)
4. Insert into `installedSkills` map (`skill-schema.ts:714`)
5. Call `notifyBrokerRegister`; on error, **delete from map and return `ok: false`**
   (`skill-schema.ts:718–730`)

The rollback on broker failure (`installedSkills.delete(skillId)` at line 723) is
executed synchronously in the catch block before the function returns. There is no
async gap between the rollback and the return that could leave the registry in an
inconsistent state.

The remove flow has symmetric rollback: skill is removed from the map, broker is
notified; if broker fails, skill is **re-inserted** before returning error
(`skill-schema.ts:763`).

Both flows use a single in-process `Map` with no concurrent mutation surface (Node.js
event loop is single-threaded; no worker threads). There is no TOCTOU window between
registry state and broker state under normal operation.

**Minor note:** The `_registeredWith` bypass for re-registration (lines 695–707) —
which silently deletes the old entry when a skill is applied with a different
`brokerSocketPath` — does not rollback the deregistration of the old skill's broker
scope. In production, this branch is effectively dead (the orchestrator uses one stable
socket path), but it represents a correctness gap that could surface during orchestrator
restarts with changed socket paths.

---

### Additional Findings

#### F-1: Path Traversal in Mount-Root Allowlist (MEDIUM)

**File:** `src/skills/skill-schema.ts:361–381`

**Description:** The permitted-mount-root check uses a raw string prefix test against the
`host_path` value without first canonicalizing the path:

```typescript
// skill-schema.ts:374–376
const withinPermitted = PERMITTED_MOUNT_ROOTS.some(
  (root) => hostPath === root || hostPath.startsWith(root + '/'),
);
```

A `host_path` containing `..` segments passes this check while resolving to a location
outside the declared permitted root. For example:

- Input: `/tmp/../etc/passwd`
- `'/tmp/../etc/passwd'.startsWith('/tmp/')` → `true` — check passes
- `fs.existsSync('/tmp/../etc/passwd')` → `true` (file exists)
- Docker/container bind-mount of `/tmp/../etc/passwd` → mounts `/etc/passwd`

The same bypass is possible for any permitted root: `/home/user/../../../etc/shadow`,
`/var/lib/opengolem/../../../root/.ssh/id_rsa`, etc.

**Severity:** Medium. The attack requires an administrator (TD-ADMIN) to apply a
malicious skill — the attack surface is the trust placed in the `.intent.md` content
at skill-application time. A compromised or socially-engineered admin workflow could
use this to mount sensitive host files into agent containers, breaking the isolation
guarantee. It is not exploitable by containers or channel messages.

**Recommended fix:** Normalize `hostPath` using `fs.realpathSync` (or `path.resolve`
as a minimum) before running the allowlist check:

```typescript
// Normalize before allowlist check
let resolvedHostPath: string;
try {
  resolvedHostPath = fs.realpathSync(hostPath);
} catch {
  return {
    field: `filesystem.container_mounts[${idx}].host_path`,
    reason: `host path does not exist: ${hostPath}`,
  };
}

const withinPermitted = PERMITTED_MOUNT_ROOTS.some(
  (root) => resolvedHostPath === root || resolvedHostPath.startsWith(root + '/'),
);
```

Note: `fs.realpathSync` also resolves symlinks, which closes a second class of escape
where `/tmp/link` → `/etc` would otherwise bypass the prefix check. Using `path.resolve`
alone would catch `..` traversal but not symlinks.

**Test coverage gap:** No test in the current suite exercises a traversal payload (e.g.
`/tmp/../etc/passwd`). The existing AC-3d test uses `/etc/passwd` directly, which is
caught correctly. A test with a traversal path that resolves outside permitted roots but
satisfies the raw prefix check should be added.

---

#### F-2: Registry Re-Registration Bypass (LOW / INFORMATIONAL)

**File:** `src/skills/skill-schema.ts:695–707`

**Description:** When `applySkill` is called with a different `brokerSocketPath` than
the one recorded at registration time, the existing registry entry is silently deleted
and replaced without notifying the broker to deregister the old scope. The code comment
acknowledges this is a test-isolation mechanism, not intended production behavior.

**Risk:** In production, the orchestrator uses one stable socket path, so this branch is
unreachable under normal operation. However, if an orchestrator restart changes the
socket path while skills are installed, a re-application of a skill could silently
drop the old broker registration without sending `deregisterSkillScope`, leaving the
broker with a stale scope entry.

**Recommendation:** Remove the context-bypass behavior from production code and replace
it with a test-only mechanism (e.g. an exported `resetRegistryForTest()` function, or
moving the bypass into the test harness). The current approach conflates test convenience
with production logic in the same code path.

---

## QA Verdict: PASS

### Test Results

```
vitest run src/skills/

 RUN  v4.0.18

 PASS  src/skills/skill-schema.test.ts (34 tests) 1412ms

 Test Files  1 passed (1)
       Tests  34 passed (34)
    Start at  19:09:02
    Duration  1.59s (transform 85ms, setup 0ms, import 101ms, tests 1.41s)
```

All 34 tests pass. No failures or skips.

---

### Acceptance Criteria Coverage

| AC | Description | Status | Notes |
|----|-------------|--------|-------|
| AC-1 | Valid `.intent.md` accepted and skill registered | **Covered** | Unit (2 tests) + Integration (1 test) |
| AC-2 | Invalid `.intent.md` rejected with field-level error | **Covered** | Unit (2 tests) — missing field name and no registry entry |
| AC-3a | Skill ID collision rejected | **Covered** | Unit (1 test) — collision error, registry unchanged |
| AC-3b | Invalid `token_scopes.skills` entry rejected | **Covered** | Unit (1 test) |
| AC-3c | Non-existent `host_path` rejected | **Covered** | Unit (1 test) |
| AC-3d | `host_path` outside permitted roots rejected | **Covered** | Unit (1 test) — uses `/etc/passwd` directly |
| AC-3e | Empty network endpoint pattern rejected | **Covered** | Unit (1 test) |
| AC-3f | MCP server missing `min_permission_tier` rejected | **Covered** | Unit (1 test) |
| AC-3g | Empty `providers.compatible` rejected | **Covered** | Unit (1 test) |
| AC-4 | Token Broker notified on successful registration | **Covered** | Contract (3 tests) + Integration (1 test) — includes delayed-ack timing test |
| AC-5 | Call Inspector endpoint list updated | **Partial** | Integration test verifies `networkEndpoints` in registry record; no test verifies the Call Inspector directly (Inspector is a separate component) |
| AC-6 | Skill removal removes scope from future tokens | **Covered** | Contract (2 tests) + Integration (1 test) |
| AC-7 | Skill removal does not invalidate existing tokens | **Covered** | Integration (1 test) — verifies no REVOKE call sent |
| AC-8 | Skill ID collision rejected (second apply) | **Covered** | Unit (1 test) — registry reflects first version |
| AC-9 | No partial application on any validation failure | **Covered** | Unit (1 test) — verifies no scopes, endpoints, or MCP entries leak |
| AC-10 | Broker unavailability causes clean failure + rollback | **Covered** | Integration (2 tests) — error broker stub + no-server socket |
| AC-11 | Telegram `.intent.md` example validates correctly | **Covered** | Integration (2 tests) — positive case and negative (missing `apply_permission`) |
| AC-12 | Operational skills (no `.intent.md`) rejected | **Covered** | Unit (1 test) + Integration (1 test) |

**Stub detection tests:** All three tiers (Unit, Contract, Integration) include a stub
detection test that confirms the harness catches an incorrect `ok: true` from a
broken or missing implementation. These pass correctly.

---

### Coverage Gaps

**Gap 1 — AC-3d: path traversal not tested (linked to F-1)**
The AC-3d test passes `/etc/passwd` as the `host_path`, which is caught by both the
`fs.existsSync` (file exists) → permitted-root check sequence. However, no test exercises
a traversal path like `/tmp/../etc/passwd`. Until F-1 is fixed, this is both an
undetected vulnerability and an uncovered test case.

**Gap 2 — AC-5: Call Inspector integration not directly tested**
AC-5 requires that after a skill with `network.endpoints` is registered, the Call
Inspector permits calls to declared endpoints and blocks calls to undeclared endpoints.
The integration test at line 873 only verifies that `networkEndpoints` appears correctly
in the installed skill's registry record — it does not invoke the Call Inspector. This is
acceptable for M19 scope (the Call Inspector is a separate component), but the gap should
be closed in a future milestone's integration test that exercises the broker's inspection
logic end-to-end.

**Gap 3 — Decision 29 MCP interim warning not tested**
The spec (Behavioral Contract, §"On skill application") requires the orchestrator to
emit a `mcp_skill_interim_warning` audit event and a console warning when a skill
declares `mcp.servers`. No test covers this behavior. The current implementation does
not emit this warning — the warning is a spec obligation that is not yet implemented,
and there is no test to enforce it.

**Gap 4 — ADR-36 self-hosted provider disclosure not tested**
The spec requires an acknowledgement prompt when `providers.compatible` contains
`ollama` or `custom`. No test and no implementation of this prompt exists. This is
a spec-required pre-apply gate that is currently absent.

---

## Overall Verdict: PASS WITH FINDINGS

The implementation is functionally correct and architecturally sound for the trust domain
controls it is responsible for. All 34 tests pass. The three primary M19 security checks
(TD-ADMIN enforcement, validation unconditional gate, broker atomicity) pass. Two spec
obligations (Decision 29 MCP warning, ADR-36 provider disclosure) are not yet
implemented.

---

## Blocking Issues

**None for merge, but the following should be tracked:**

1. **F-1 (Medium) — Path traversal in mount-root allowlist** (`skill-schema.ts:374–376`):
   Normalize `host_path` via `fs.realpathSync` before the prefix check. Add a test case
   with a traversal payload. This is not blocking for a milestone merge if skill
   application is TD-ADMIN-only (which it currently is — no orchestrator wiring exists),
   but it must be fixed before any public-facing skill application workflow is wired.

2. **F-2 (Low) — Registry re-registration bypass** (`skill-schema.ts:695–707`):
   Move the test-isolation bypass out of production code before the module is wired into
   the orchestrator.

3. **Gap 3 — Decision 29 MCP interim warning**: The spec-required `mcp_skill_interim_warning`
   audit event and admin warning are not implemented. This is a compliance gap against the
   behavioral contract and must be addressed before any MCP-declaring skill is applied in
   production.

4. **Gap 4 — ADR-36 self-hosted provider disclosure**: The acknowledgement prompt for
   `ollama`/`custom` providers is not implemented. This is a spec-required pre-apply gate.
