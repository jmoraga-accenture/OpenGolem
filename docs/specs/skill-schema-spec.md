# Skill Schema and Lifecycle — Behavioral Specification

*Produced: 2026-04-05 | Spec Writer: Claude Code | Component: Stream C (Skill Schema, M8)*
*Input documents: ARCHITECTURE.md §5, DECISIONS.md Decision 3 and Decision 13, IMPLEMENTATION_AUDIT.md row "5 Skill system"*

---

## Responsibilities

The Skill Schema and Lifecycle component is responsible for:

1. **Parsing and validating `.intent.md` declarations** — every non-operational skill carries an `.intent.md` file; the orchestrator reads and validates this file at skill application time.
2. **Applying the skill to the installed skill set** — registering the skill in the orchestrator's in-memory skill registry when validation passes; rejecting and never partially applying it when validation fails.
3. **Notifying the Token Broker of scope additions** — when a skill is successfully registered, the orchestrator notifies the Token Broker so that subsequent `issueToken` calls reflect the new skill's `token_scopes`.
4. **Updating the Call Inspector endpoint list** — when a skill is registered, the network endpoint patterns from the skill's `network.endpoints` field become active constraints for the Call Inspector.
5. **Updating the MCP endpoint list** — when a skill is registered, the MCP server declarations from the skill's `mcp.servers` field become active.
6. **Surfacing validation errors to the administrator** — when a skill's `.intent.md` fails any validation rule, the orchestrator reports the specific failing field and does not apply the skill.
7. **Managing skill removal** — removing a skill from the installed set and reversing the broker notification and inspector endpoint updates; existing active tokens are not invalidated (they expire normally); new tokens do not include the removed skill's scope.

This component has no user-facing surface. It operates entirely within the TD-ADMIN / TD-ORCHESTRATOR trust boundary (ARCHITECTURE.md §2.1, ADR-6).

**What this component does not do:**
- Apply operational skills (these are instruction-only workflows with no `.intent.md`; they are outside this component's scope).
- Make safety decisions (Cato is not consulted during skill application).
- Issue tokens (token issuance belongs to the Token Broker; this component only triggers broker notification).
- Persist the installed skill registry to long-term storage beyond what is needed to reconstruct state on orchestrator restart. TBD — architect to resolve: the spec does not prescribe the persistence format for the skill registry.

---

## External Interface

### Input: `.intent.md` File

An `.intent.md` file is a YAML document (YAML frontmatter block) with the following schema. Fields marked **required** must be present and non-empty. Fields marked **optional** may be omitted; their absence has defined semantics noted inline.

```yaml
---
skill: <skill-id>            # required; string; unique kebab-case identifier
version: <semver>            # required; string; semantic version e.g. "1.0.0"
type: feature | utility | container   # required; one of the three listed values (not "operational")
description: <one-line>      # required; string; human-readable single-line description

# Token scope additions — what this skill adds to the allowed skill set
token_scopes:                # optional block; if absent, skill adds no token scope entries
  skills:
    - <skill-id>             # each listed id is added to tokens issued while this skill is active

# Host filesystem effects
filesystem:                  # optional block; if absent, skill declares no filesystem effects
  host_reads:                # optional list; paths this skill reads on the host
    - <path-pattern>
  host_writes:               # optional list; paths this skill writes on the host
    - <path-pattern>
  container_mounts:          # optional list; bind mounts this skill adds to spawned containers
    - host_path: <path>
      container_path: <path>
      access: read | read-write

# Network endpoints this skill makes available to agents (Call Inspector validates against this)
network:                     # optional block; if absent, skill declares no additional endpoints
  endpoints:
    - pattern: <url-pattern> # required per entry; glob or prefix e.g. "https://api.telegram.org/*"
      protocol: https | wss  # required per entry
      direction: outbound    # required per entry; currently only "outbound" is valid

# MCP servers this skill declares
mcp:                         # optional block; if absent, skill declares no MCP servers
  servers:
    - id: <server-id>        # required per entry; unique kebab-case identifier
      url: <mcp-endpoint>    # required per entry; full URL
      scopes:                # required per entry; list of scope names, must be non-empty
        - <scope-name>
      min_permission_tier: viewer | member | owner | admin  # required per entry

# LLM provider compatibility
providers:                   # required block
  compatible:                # required; list; must be non-empty
    - anthropic | openrouter | ollama | any
  requires_features:         # optional list; Anthropic-specific features this skill depends on
    - extended_thinking | tool_use | ...

# Who can apply this skill
apply_permission: admin | power_user   # required; one of the two listed values
---
```

**Field definitions:**

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `skill` | string | yes | Unique across all installed skills; kebab-case format |
| `version` | string | yes | Valid semantic version (MAJOR.MINOR.PATCH) |
| `type` | enum | yes | One of: `feature`, `utility`, `container` |
| `description` | string | yes | Non-empty; single line (no newlines) |
| `token_scopes.skills` | string[] | no | Each entry must be a syntactically valid skill ID (non-empty, kebab-case format). The entry need not reference an already-installed skill — a skill may declare scope for skills not yet installed. Syntactic validation only; no registry lookup at apply time. |
| `filesystem.host_reads` | string[] | no | Path patterns; validated as syntactically valid path expressions |
| `filesystem.host_writes` | string[] | no | Path patterns; validated as syntactically valid path expressions |
| `filesystem.container_mounts[].host_path` | string | per mount | Must be an absolute path that exists on the host and is within permitted mount roots |
| `filesystem.container_mounts[].container_path` | string | per mount | Must be an absolute path |
| `filesystem.container_mounts[].access` | enum | per mount | One of: `read`, `read-write` |
| `network.endpoints[].pattern` | string | per endpoint | Valid URL pattern (glob or prefix); must be non-empty |
| `network.endpoints[].protocol` | enum | per endpoint | One of: `https`, `wss` |
| `network.endpoints[].direction` | enum | per endpoint | Currently only `outbound` is valid |
| `mcp.servers[].id` | string | per server | Kebab-case; unique within the declaration |
| `mcp.servers[].url` | string | per server | Valid URL |
| `mcp.servers[].scopes` | string[] | per server | Non-empty list |
| `mcp.servers[].min_permission_tier` | enum | per server | One of: `viewer`, `member`, `owner`, `admin` |
| `providers.compatible` | string[] | yes | Non-empty; valid values: `anthropic`, `openrouter`, `ollama`, `any` |
| `providers.requires_features` | string[] | no | Advisory; not validated against provider capability at application time |
| `apply_permission` | enum | yes | One of: `admin`, `power_user` |

### Validation Output

When validation fails, the orchestrator produces a structured error surfaced to the administrator. The error identifies:
- The failing field name (exact path, e.g. `filesystem.container_mounts[0].host_path`)
- The reason the field failed (e.g. "path does not exist on host", "skill ID collision: 'telegram' is already installed")
- No partial application occurs — the skill is not registered at all if any validation rule fails

When validation passes, the orchestrator produces a success signal identifying the skill ID and version applied.

### Broker Notification (Orchestrator → Token Broker)

On successful skill registration, the orchestrator sends a `registerSkillScope` JSON-RPC call on the existing token lifecycle socket (`data/sockets/broker.sock`, per Decision 15):

```json
{
  "jsonrpc": "2.0",
  "method": "registerSkillScope",
  "params": {
    "skillId": "<skill-id>",
    "tokenScopes": ["<skill-id>", "..."],
    "networkEndpoints": [
      { "pattern": "<url-pattern>", "protocol": "https | wss", "direction": "outbound" }
    ]
  },
  "id": 5
}
```

**Response (success):**
```json
{
  "jsonrpc": "2.0",
  "result": { "registered": true },
  "id": 5
}
```

On skill removal, the orchestrator sends `deregisterSkillScope`:

```json
{
  "jsonrpc": "2.0",
  "method": "deregisterSkillScope",
  "params": { "skillId": "<skill-id>" },
  "id": 6
}
```

**Response (success):**
```json
{
  "jsonrpc": "2.0",
  "result": { "deregistered": true },
  "id": 6
}
```

Both methods return a JSON-RPC error if the broker is unreachable or the operation fails. See Decision 19 for rationale.

### Inspector Endpoint Update (In-Process)

On successful skill registration, the Call Inspector's active endpoint set is updated in-process (the inspector runs within TD-BROKER). The network endpoint patterns from the registered skill's `network.endpoints` field are added to the inspector's constraint list. These patterns take effect for all calls processed after the update completes; calls already in flight are not retroactively affected.

---

## Behavioral Contract

### On skill application (given X → must produce Y):

**Given** an administrator applies a skill by providing a path to a directory containing an `.intent.md` file:

**When** the `.intent.md` passes all validation rules (§5.3 of ARCHITECTURE.md, enumerated in the External Interface section above):
- The skill is registered in the orchestrator's installed skill set.
- The Token Broker is notified of the new skill scope. The broker must confirm receipt before the orchestrator reports success to the administrator.
- The Call Inspector endpoint list is updated with the skill's declared network endpoints.
- The MCP endpoint list is updated with the skill's declared MCP servers.
- The orchestrator reports success to the administrator with the skill ID and version.
- The next agent task spawned by the orchestrator uses the updated scope — tasks that were already in flight at application time continue with the scope active at their `issueToken` call.

**When** the `.intent.md` fails any validation rule:
- The skill is not registered. No partial state is written.
- The Token Broker is not notified.
- The Call Inspector endpoint list is not modified.
- The MCP endpoint list is not modified.
- The orchestrator reports the specific failing field and reason to the administrator.

**When** the `.intent.md` file is absent from the skill directory:
- The skill is rejected. Operational skills (type: operational) do not carry `.intent.md`; they are not processed by this component.
- An error is surfaced: "no .intent.md found; skill not applied."

### On skill removal:

**Given** an administrator removes an installed skill by skill ID:

- The skill is removed from the orchestrator's installed skill set.
- The Token Broker is notified: new tokens must not include the removed skill's scope. Existing active tokens are not invalidated — they expire per their declared TTL.
- The Call Inspector endpoint list is updated: the removed skill's network endpoints are no longer in the active constraint list for new calls. Calls in flight using tokens issued before removal continue against the endpoint list active at their `issueToken` call.
- The MCP endpoint list is updated: the removed skill's MCP servers are no longer declared.
- The orchestrator reports success with the removed skill ID.

**When** the skill ID is not in the installed set:
- The orchestrator reports an error: skill not found; no changes made.

### Skill ID uniqueness:

At all times, the installed skill set contains at most one skill per skill ID. Applying a skill whose ID collides with an already-installed skill is rejected with a validation error identifying the collision.

### Scope precedence across tasks:

A task uses the skill scope that was active at the moment `issueToken` was called for that task. Skills applied or removed after `issueToken` do not affect that task's token or its Call Inspector constraints.

---

## Failure Modes

### `.intent.md` parse failure
The YAML is malformed. The orchestrator rejects the skill with an error identifying the parse failure location. No state changes.

### Validation rule failure
One or more fields fail the rules in §5.3 (ARCHITECTURE.md). The orchestrator rejects the skill with a field-level error. No state changes. The administrator must correct the declaration and re-apply.

### Host path does not exist (`filesystem.container_mounts[].host_path`)
The declared host path is within permitted mount roots but does not exist on the filesystem at application time. The skill is rejected with: "host path does not exist: `<path>`". The administrator must create the path before applying the skill.

### Host path outside permitted mount roots (`filesystem.container_mounts[].host_path`)
The declared host path is outside the permitted mount roots. The skill is rejected with: "host path outside permitted mount roots: `<path>`". The administrator must correct the declaration.

### Skill ID collision
A skill with the same ID is already installed. The skill is rejected with: "skill ID collision: `<id>` is already installed." To update an installed skill, the administrator must remove the existing skill first, then apply the new version.

### Token Broker unreachable at notification time
If the Token Broker is unreachable when the orchestrator attempts to notify it of the new skill scope, the skill application fails. The skill is removed from the registry (rollback), the administrator is notified, and the system reports an error identifying the broker as unavailable. No partial state is retained.

### Skill removal while broker is unreachable
If the Token Broker is unreachable at skill removal time, the removal fails. The skill remains in the installed set. The administrator is notified. The system does not produce a partially-removed state.

---

## Invariants

These properties hold at all times during normal operation:

1. **No undeclared capability.** Every capability accessible to an agent token was declared in an installed skill's `.intent.md` at the time the token was issued. No capability is discovered at runtime.

2. **Validation gate is unconditional.** A skill whose `.intent.md` fails any validation rule is never registered, even partially. There is no "apply with warnings" mode.

3. **Skill ID uniqueness.** At any point in time, the installed skill set contains at most one skill per skill ID.

4. **Broker consistency.** The Token Broker's view of the active skill scope is always consistent with the orchestrator's installed skill set, modulo the propagation latency of a notification in flight. If a broker notification fails, the skill is rolled back.

5. **No active-token invalidation on removal.** Removing a skill never invalidates tokens already issued. Token scope is fixed at `issueToken` time. Removal only affects future tokens.

6. **Operational skills are out of scope.** The schema validation and lifecycle machinery described in this spec applies exclusively to skill types `feature`, `utility`, and `container`. Skills of type `operational` carry no `.intent.md` and are not subject to this component.

7. **No Cato gate on skill application.** Skill application is a TD-ADMIN action (ARCHITECTURE.md §2.1). It does not pass through a Cato inline check. The trust model relies on administrator authorization at the apply step, not on real-time Cato evaluation.

8. **No user-facing surface.** No running user session or agent token can trigger skill application or removal. These are exclusively administrator operations.

9. **Scope is fixed at `issueToken` time.** A task's Call Inspector constraints and token scope are determined by the installed skill set at the moment the orchestrator called `issueToken` for that task. Post-issuance changes to the installed set do not affect that task.

---

## Acceptance Criteria

Each criterion is testable from outside the component (orchestrator API, broker state, file system state, error output). No criterion relies on internal implementation details.

### AC-1: Valid `.intent.md` is accepted and skill is registered

**Given** a syntactically valid `.intent.md` whose fields pass all validation rules,
**when** the administrator applies the skill,
**then** the skill appears in the orchestrator's installed skill set query with its declared ID, version, and type.

### AC-2: Invalid `.intent.md` is rejected with a field-level error

**Given** a `.intent.md` with a missing required field (e.g. `apply_permission` absent),
**when** the administrator applies the skill,
**then** the orchestrator returns an error naming the missing field and the skill does not appear in the installed skill set.

### AC-3: All seven validation rules are individually enforced

For each of the following, a `.intent.md` that violates only that rule is rejected, and the error identifies the correct failing field:

- AC-3a: `skill` ID collides with an already-installed skill.
- AC-3b: A `token_scopes.skills` entry is an unrecognized skill ID.
- AC-3c: A `filesystem.container_mounts[].host_path` does not exist on the host.
- AC-3d: A `filesystem.container_mounts[].host_path` is outside permitted mount roots.
- AC-3e: A `network.endpoints[].pattern` is not a valid URL pattern (empty string or syntactically invalid).
- AC-3f: An `mcp.servers` entry lacks `min_permission_tier`.
- AC-3g: `providers.compatible` is empty.

### AC-4: Token Broker is notified on successful registration

**Given** a valid skill is applied successfully,
**when** the next `issueToken` call is made for any task,
**then** the issued token's skill set includes the newly applied skill's `token_scopes.skills` entries.

### AC-5: Call Inspector endpoint list is updated on successful registration

**Given** a valid skill with `network.endpoints` is applied successfully,
**when** an agent presents a token issued after application and makes a call to an endpoint matching one of the skill's declared patterns,
**then** the Call Inspector permits the call (endpoint scope check passes).

**And given** the same token is used to call an endpoint *not* declared by any installed skill,
**then** the Call Inspector blocks the call on the endpoint scope check.

### AC-6: Skill removal removes scope from future tokens

**Given** an installed skill is removed,
**when** a new `issueToken` call is made after removal,
**then** the issued token's skill set does not include the removed skill's `token_scopes.skills` entries.

### AC-7: Skill removal does not invalidate existing tokens

**Given** an active token was issued while a skill was installed,
**when** that skill is removed,
**then** the active token remains valid for its declared TTL and continues to carry the removed skill's scope for calls in flight under that token.

### AC-8: Skill ID collision is rejected

**Given** a skill with ID `telegram` is already installed,
**when** the administrator applies a second skill with the same ID `telegram`,
**then** the orchestrator rejects the application with a collision error and the installed skill set is unchanged.

### AC-9: No partial application on failure

**Given** a `.intent.md` that fails validation on field `X` (any field),
**when** the administrator applies the skill,
**then** no aspect of the skill's declared scope (token scopes, network endpoints, MCP servers, filesystem mounts) appears in any subsequently issued token or inspector constraint set.

### AC-10: Broker unavailability causes skill application to fail cleanly

**Given** the Token Broker is unreachable,
**when** the administrator applies a skill that would otherwise pass validation,
**then** the orchestrator reports a broker-unavailability error and the skill does not appear in the installed skill set.

### AC-11: Telegram channel adapter `.intent.md` example validates correctly

The following is the designated first skill for schema validation. A conforming implementation must accept this `.intent.md` without error.

```yaml
---
skill: telegram
version: 1.0.0
type: feature
description: Telegram channel adapter — delivers and receives messages via the Telegram Bot API

token_scopes:
  skills:
    - telegram

filesystem:
  host_reads: []
  host_writes: []
  container_mounts: []

network:
  endpoints:
    - pattern: "https://api.telegram.org/*"
      protocol: https
      direction: outbound

mcp: {}

providers:
  compatible:
    - anthropic
    - openrouter
    - any

apply_permission: admin
---
```

**Acceptance check:** The orchestrator accepts this `.intent.md`, registers the skill with ID `telegram` and version `1.0.0`, notifies the Token Broker of the `telegram` scope addition, and adds `https://api.telegram.org/*` to the Call Inspector's active endpoint patterns.

**Negative check:** If `apply_permission` is removed from this declaration, the orchestrator rejects it with an error identifying `apply_permission` as the missing field.

### AC-12: Operational skills are not processed by this component

**Given** a skill directory that contains a `SKILL.md` but no `.intent.md`,
**when** the administrator attempts to apply it through the skill lifecycle,
**then** the orchestrator returns an error: "no .intent.md found; skill not applied" — and no changes are made to the installed skill set, broker scope, or inspector constraints.

---

*End of specification. The PM and Architect must review before the Tester writes against these criteria and the Developer begins implementation.*
