# Orchestrator — Behavioral Specification

*Produced: 2026-04-05 | Spec Writer: Claude Code | Stream: E*
*Source: ARCHITECTURE.md §1.1, §1.3, §2.1–§2.2, §3.0–§3.1, §4.1–§4.4, §4.7–§4.8, §5.2–§5.5, §6.1–§6.2, ADR-5, ADR-6, ADR-8, ADR-9, ADR-10, ADR-11; DECISIONS.md Decision 13, 15, 17, 21, 22; ARCHITECT_REVIEW.md cross-spec notes*

---

## Responsibilities

The Orchestrator is the central coordinator for the lifetime of the Golem service. It starts third (after the Token Broker and Cato) and is the only process permitted to drive the container lifecycle.

**Core responsibilities:**

1. **Inbound message queue management** — maintains a per-group ordered queue of inbound messages; enforces one active task per group at a time (concurrency control).
2. **Security mode application** — reads `securityMode` from group configuration; passes it to the Token Broker at `issueToken`; implements Supervised user-confirm/cancel flows for Call Inspector soft blocks.
3. **Token lifecycle** — requests scoped derivative tokens from the Token Broker before each task; revokes them at task completion, TTL expiry, or Cato block.
4. **Cato inline checks** — submits pre-action check requests to Cato before delivering agent prompts, writing memory, requesting credentials, making filesystem writes, or relaying escalations; blocks the action unconditionally on `allow: false` or on Cato socket unreachability.
5. **Call Inspector escalation relay** — listens on `data/sockets/escalation.sock`; receives `catoEscalate` JSON-RPC calls from the Token Broker; forwards a standard Cato check to `data/sockets/cato.sock` and returns the result to the broker.
6. **Container lifecycle** — spawns agent containers with declared bind mounts and environment variables; monitors TTL; forces teardown at expiry or on Cato block.
7. **Outbound message routing** — routes container output through the appropriate in-process channel adapter to the originating channel.
8. **Skill lifecycle** — validates `.intent.md` declarations, maintains the installed skill registry, notifies the Token Broker of scope additions and removals.
9. **Audit log writes** — appends orchestrator events to the shared audit log (INSERT only; no UPDATE or DELETE).
10. **Hansei inbox poll** — polls `data/hansei/inbox/` for Cato-produced reports; ingests and logs each new report.
11. **Health status endpoint** — exposes a local-only health endpoint for administrator inspection.
12. **Group configuration loading** — reads group config files at startup; reloads on administrator signal.
13. **Remote-control surface (TD-ADMIN)** — accepts remote agent invocations from `remote-control.ts` (claude.ai bridge); see §2.7.

**What the Orchestrator does not own:**

- Raw credentials — the orchestrator holds a transient derivative token reference only; no long-lived secrets reside in orchestrator memory.
- Safety decisions — all allow/block enforcement comes from Cato or the Call Inspector.
- Channel protocol implementation — delegated to in-process channel adapters.
- Agent logic — all execution is inside containers.
- Audit log analysis — Cato reads and reasons about the audit log.
- Any user-facing content — Alef (inside the container) is the sole voice to users.

---

## External Interface

### 2.1 Inbound: Channel Adapter Delivery

Channel adapters run in-process within TD-ORCHESTRATOR (ADR-6). They deliver messages to the Orchestrator via an in-process method call. No serialization is required.

**Normalized inbound message fields:**

| Field | Type | Description |
|-------|------|-------------|
| `groupId` | string | Identifies the group (group directory name under `groups/`) |
| `channelId` | string | Channel identifier (e.g. `tg:12345678`, `wa:447700000000`, `tui`) |
| `senderId` | string | Opaque channel-native sender identity |
| `messageId` | string | Channel-native message identifier (for deduplication) |
| `text` | string | Message text content |
| `timestamp` | ISO-8601 string | When the message was received from the channel |

The Orchestrator does not store message text. It logs receipt of each message to the audit log using the `groupId`, `channelId`, a hash of `senderId`, and the `timestamp`. Message content is not written to the audit log.

### 2.2 Outbound: Token Broker Socket

*Path:* `data/sockets/broker.sock` (Decision 15). Overridable by `BROKER_SOCKET_PATH`.
*Protocol:* Newline-delimited JSON-RPC 2.0. Orchestrator is the JSON-RPC client; Token Broker is the server.

**Methods the Orchestrator calls:**

```json
// Issue token
{"jsonrpc":"2.0","method":"issueToken","params":{"contextId":"...","skillSet":["..."],"ttl":300,"callBudget":50,"dataScopes":["..."],"securityMode":"golem_guard|supervised|power","parentTokenId":"<token-id-or-null>"},"id":1}
{"jsonrpc":"2.0","result":{"token":"<opaque>","tokenId":"...","expiresAt":"..."},"id":1}

// Revoke token
{"jsonrpc":"2.0","method":"revokeToken","params":{"tokenId":"..."},"id":2}
{"jsonrpc":"2.0","result":{"revoked":true},"id":2}

// Health check (at startup and on recovery)
{"jsonrpc":"2.0","method":"health","params":{},"id":3}
{"jsonrpc":"2.0","result":{"status":"ok"},"id":3}

// Register skill scope (on skill application)
{"jsonrpc":"2.0","method":"registerSkillScope","params":{"skillId":"<kebab-case>","tokenScopes":["..."],"networkEndpoints":[{"pattern":"<url-pattern>","protocol":"https|wss"}]},"id":10}
{"jsonrpc":"2.0","result":{"registered":true},"id":10}

// Deregister skill scope (on skill removal)
{"jsonrpc":"2.0","method":"deregisterSkillScope","params":{"skillId":"<kebab-case>"},"id":11}
{"jsonrpc":"2.0","result":{"deregistered":true},"id":11}
```

The `parentTokenId` field is `null` for first-level tasks; it carries the parent token's ID when the Orchestrator issues a token for a subagent container (ADR-5).

### 2.3 Inbound: Call Inspector Escalation Socket

*Path:* `data/sockets/escalation.sock` (Decision 15). Overridable by `ESCALATION_SOCKET_PATH`.
*Protocol:* Newline-delimited JSON-RPC 2.0. **Orchestrator listens; Token Broker connects** (ADR-11).

The Orchestrator must bind this socket and be ready to accept connections before it reports itself healthy (§1.3 startup order obligation).

**Method the Orchestrator handles:**

```json
// Inbound from Token Broker
{"jsonrpc":"2.0","method":"catoEscalate","params":{"checkId":"<uuid>","action":"OUTBOUND_API_CALL","contextId":"...","tokenId":"...","payloadHash":"<sha256-hex>","payloadSize":42000,"escalationReason":"INSPECTOR_INCONCLUSIVE","inspectorCheck":"PROMPT_INJECTION"},"id":4}

// Response returned after Cato inline check (see §2.4)
{"jsonrpc":"2.0","result":{"allow":false,"code":"PROMPT_INJECTION","reason":"..."},"id":4}
```

The Orchestrator strips the broker-specific fields (`escalationReason`, `inspectorCheck`) before forwarding to Cato. It presents the standard six-field Cato request schema (§2.4) to `data/sockets/cato.sock`. The extra fields are orchestrator-internal metadata; they are not delivered to Cato (ARCHITECT_REVIEW.md, cross-spec note).

### 2.4 Outbound: Cato Inline Check Socket

*Path:* `data/sockets/cato.sock` (Decision 15). Overridable by `CATO_SOCKET_PATH`.
*Protocol:* Newline-delimited JSON (not JSON-RPC). Orchestrator is the sole client; Cato listens.

**Request schema:**

```json
{
  "checkId": "<uuid>",
  "action": "<action-type>",
  "contextId": "<group-or-session-id>",
  "tokenId": "<token-id>",
  "payloadHash": "<sha256-hex>",
  "payloadSize": 42000,
  "contentExcerpt": "<base64-encoded-bytes | null>"
}
```

`action` is one of: `AGENT_PROMPT`, `OUTBOUND_API_CALL`, `FILESYSTEM_WRITE`, `CREDENTIAL_REQUEST`, `MEMORY_WRITE`.

`contentExcerpt` is the first 4 KB of the payload, base64-encoded (or the full payload if shorter). It is present (non-null) for `AGENT_PROMPT`, `OUTBOUND_API_CALL`, and `MEMORY_WRITE`. It is `null` or omitted for `FILESYSTEM_WRITE` and `CREDENTIAL_REQUEST` (Decision 17).

**Response schema:**

```json
{
  "checkId": "<uuid>",
  "allow": true,
  "code": null,
  "reason": null
}
```

```json
{
  "checkId": "<uuid>",
  "allow": false,
  "code": "PATH_TRAVERSAL",
  "reason": "Prompt contains filesystem escape sequence"
}
```

`checkId` in the response must match `checkId` in the request. The Orchestrator must verify this before acting on the response.

**Failure mode:** If the Cato socket is unreachable or returns an error, the Orchestrator blocks the action (fail-closed). No action proceeds without a confirmed Cato `allow: true`. This is not configurable.

### 2.5 Outbound: Agent Container Spawn and Teardown

*Protocol:* Container runtime invocation (`docker run` or `apple container run`).

**At spawn, the Orchestrator controls:**

- **Bind mounts:**
  - `--mount type=bind,src=<group-dir>,dst=/workspace/group,ro=false` — group filesystem (read-write)
  - `--mount type=bind,src=data/extra,dst=/workspace/extra,ro=true` — shared read-only context (ADR Decision 11)
  - Additional mounts declared by active skills (from their `.intent.md` `filesystem.container_mounts`)
- **Environment variables:**
  - `ANTHROPIC_BASE_URL` — set to the credential proxy URL (never the real provider URL)
  - `ASSISTANT_NAME` — agent display name for this group
  - `ALEF_FLAG_DISPLAY_TAG` — group-configured display string for `[FLAG]` (default: `[FLAG]`)
  - `ALEF_BLOCKED_DISPLAY_TAG` — group-configured display string for `[BLOCKED]` (default: `[BLOCKED]`)
  - Provider config vars as required by the group's provider configuration
  - No raw API credentials in environment
- **Resource limits:** CPU and memory caps per task profile
- **Pre-spawn file checks:**
  - If `groups/{name}/messages.db` does not exist, the Orchestrator creates it with the normative Tier 2 schema and WAL mode enabled before proceeding (Decision 21).
  - If `groups/{name}/CLAUDE.md` does not exist, the Orchestrator creates an empty file at that path before configuring the bind mount (Decision 22). No Cato check is required for this empty-file creation.

**Audit log entry at spawn:** container ID, bind mounts (path list), token ID, task ID.

**Task input (filesystem):** The task description is written to a file in the group directory before container spawn. The container reads it via the bind mount. No stdin channel for task content.

**Result input (stdout sentinel):**

```
---OPENGOLEM_OUTPUT_START---
{"status":"success"|"error","result":"...","newSessionId":"..."}
---OPENGOLEM_OUTPUT_END---
```

The Orchestrator parses between the sentinel markers. Everything outside the markers is discarded. Result content is not logged to the audit log. The Orchestrator logs task completion status and `newSessionId`.

**TTL enforcement:** If a container exceeds its TTL, the Orchestrator tears it down, revokes its token, and routes a timeout notification to the user via the channel adapter. If any partial output was produced before the sentinel was emitted, the Orchestrator may include it in the notification at its discretion; partial content is never logged to the audit log.

### 2.6 Outbound: Audit Log

*Location:* `data/audit.db` (shared SQLite file).
*Protocol:* SQLite INSERT. No UPDATE or DELETE.

The Orchestrator writes audit entries for the following event types. All entries include `timestamp`, `eventType`, `groupId`, and `taskId` (where applicable).

| Event Type | Required Fields |
|------------|----------------|
| `message_received` | `groupId`, `channelId`, `senderHash`, `messageId`, `timestamp` |
| `task_start` | `groupId`, `taskId`, `tokenId`, `skillSet` |
| `container_spawn` | `taskId`, `containerId`, `mountPaths`, `tokenId` |
| `cato_check_relayed` | `checkId`, `action`, `tokenId`, `contextId`, `payloadHash`, `outcome`, `code` |
| `task_complete` | `taskId`, `containerId`, `status`, `newSessionId` |
| `container_ttl_expired` | `taskId`, `containerId`, `tokenId` |
| `cato_block` | `taskId`, `checkId`, `code`, `reason` |
| `token_request` | `taskId`, `tokenId`, `contextId`, `skillSet`, `securityMode` |
| `token_revoke` | `tokenId`, `reason` |
| `hansei_report_ingested` | `reportId`, `reportPath`, `ingestTimestamp` |
| `skill_applied` | `skillId`, `version`, `appliedBy` |
| `skill_removed` | `skillId`, `removedBy` |
| `memory_write_approved` | `taskId`, `checkId`, `groupId`, `payloadHash` |
| `memory_write_blocked` | `taskId`, `checkId`, `groupId`, `payloadHash`, `code` |

The audit log file is opened in WAL mode. Write failures suspend the current task until the write succeeds. A task that cannot produce an audit entry does not proceed.

### 2.7 Remote-Control Surface (TD-ADMIN)

`remote-control.ts` is the claude.ai bridge. It is part of the Orchestrator component, not a standalone component (Decision 13).

**Trust domain:** TD-ADMIN. The bridge accepts connections only from localhost and only from processes running as the Golem service user. It is not exposed to the network.

**Function:** Allows the administrator to invoke an agent task without routing through a messaging channel (e.g. from Claude Code CLI or the claude.ai interface). The invocation carries a `groupId` and a task description. The Orchestrator treats the invocation as equivalent to an inbound channel message for that group — it enters the same per-group queue, receives the same Cato checks, and generates the same audit log entries.

**Audit obligation:** The Orchestrator logs every remote-control-initiated task to the audit log with `eventType: task_start` and a `sourceChannel: "remote-control"` field. Remote-initiated tasks are indistinguishable from channel-initiated tasks in the audit log except for this field. No task is initiated without an audit entry.

**Failure mode:** If the bridge is unreachable or fails during a task invocation, the Orchestrator does not silently queue the task. It returns an error to the caller and does not create a task record. Fail-closed: a task that cannot be logged is not started.

### 2.8 Outbound: Hansei Inbox Poll

*Directory:* `data/hansei/inbox/` (well-known host path; deployment-configurable).
*Protocol:* Host filesystem poll on a fixed interval.

The Orchestrator polls the inbox directory after each scheduled poll interval. On detecting a new file (determined by filename not previously seen in the session), the Orchestrator:

1. Reads the file atomically (the file is created by Cato via temp-file rename, so a complete file is guaranteed on first read).
2. Parses the report JSON (structured fields: timestamp, period covered, KPI values, anomaly findings, recommendation flags).
3. Writes a `hansei_report_ingested` audit log entry (report ID, path hash, ingest timestamp).
4. Makes the report available to the health endpoint and dashboard skill.
5. Does not auto-apply any recommendation in the report. Reports are surfaced to the administrator for human review.

The Orchestrator also polls after Cato appends a `hansei_report_ready` event to the audit log, without waiting for the next scheduled poll interval.

### 2.9 Health Status Endpoint

*Binding:* `127.0.0.1` only. Port is deployment-configurable; not exposed to any network interface.

The endpoint returns the current operational status of the Orchestrator and its dependencies.

**Response schema:**

```json
{
  "status": "ok" | "degraded" | "halted",
  "components": {
    "tokenBroker": "ok" | "unreachable",
    "cato": "ok" | "unreachable",
    "escalationSocket": "ok" | "error"
  },
  "activeContainers": 0,
  "queueDepth": 0,
  "lastHanseiReport": "<ISO-8601-or-null>",
  "uptime": 0
}
```

`status` is `ok` when all components are reachable and task dispatch is active; `degraded` when one or more components are unhealthy but the Orchestrator is running; `halted` when the Orchestrator is not dispatching tasks (e.g. all dependencies down).

---

## Behavioral Contract

### 3.1 Startup Sequence

1. Resolve all socket paths (applying env var overrides per Decision 15).
2. Create `data/sockets/` directory if absent.
3. Bind `data/sockets/escalation.sock` and begin accepting connections.
4. Issue a `health` JSON-RPC call to `data/sockets/broker.sock`. If the broker is unreachable, wait and retry; do not proceed until the broker responds `ok`.
5. Issue a `health` check to `data/sockets/cato.sock`. If Cato is unreachable, wait and retry; do not proceed until Cato responds.
6. Load group configurations from the host filesystem.
7. Reconstruct the installed skill registry (from `data/skill-registry.json` or equivalent persisted state).
8. Mark the Orchestrator healthy and begin draining inbound message queues.

No containers are spawned before step 8. The escalation socket (step 3) must be bound before the Orchestrator contacts the broker (step 4), so the broker never blocks on a missing relay during startup.

### 3.2 Message Receipt and Queuing

Given: a channel adapter delivers a normalized inbound message.

1. Write `message_received` to the audit log (hash of `senderId`, not raw identity).
2. Enqueue the message in the group's inbound queue.
3. If no task is currently active for the group, dispatch the next queued message (§3.3).
4. If a task is active, the message waits in the queue. No message is dropped.

### 3.3 Task Dispatch

Given: the group queue has a pending message and no active task.

1. Load group configuration (security mode, provider config, display tags, skill set).
2. Request a derivative token: call `issueToken` with `contextId`, `skillSet`, `ttl`, `callBudget`, `dataScopes`, `securityMode`, and `parentTokenId: null`.
   - If the broker returns an error (including `token_store_full`), queue the task and notify the user via the channel. No container is spawned.
3. Perform a Cato `AGENT_PROMPT` check: send `checkId`, `action: "AGENT_PROMPT"`, `contextId`, `tokenId`, `payloadHash` (SHA-256 of the prompt text), `payloadSize`, and `contentExcerpt` (first 4 KB base64).
   - If Cato returns `allow: false`, call `revokeToken`, write `cato_block` to the audit log, and route a `[BLOCKED]` explanation to the user. Do not spawn a container.
   - If the Cato socket is unreachable, call `revokeToken`, block the task, and notify the user. Do not spawn a container.
4. Pre-spawn file checks: create `messages.db` and `CLAUDE.md` if absent (§2.5).
5. Write `container_spawn` to the audit log.
6. Spawn the container with the declared mounts, environment variables, and resource limits.
7. Start TTL timer.
8. Write `task_start` to the audit log.

### 3.4 Task Completion

Given: the container emits the sentinel protocol output.

1. Parse the JSON between sentinel markers. Discard everything outside.
2. Extract `status` and `newSessionId`.
3. If the agent's output contains a Tier 1 memory mutation proposal:
   a. Perform a Cato `MEMORY_WRITE` check with `payloadHash` of the proposed delta and `contentExcerpt`.
   b. If `allow: true`: write the mutation to `groups/{name}/CLAUDE.md` and write `memory_write_approved` to the audit log.
   c. If `allow: false` or Cato unreachable: discard the mutation proposal, write `memory_write_blocked` to the audit log. The agent is not notified separately; the block is an orchestrator-level decision.
4. Persist the task outcome to Tier 2 (`messages.db`).
5. Call `revokeToken` for the task's token.
6. Write `task_complete` to the audit log.
7. Route the result to the user via the channel adapter.
8. Dequeue the next message for this group (if any) and repeat §3.3.

### 3.5 TTL Expiry

Given: the container TTL timer fires before the sentinel is emitted.

1. Tear down the container.
2. Call `revokeToken`.
3. Write `container_ttl_expired` to the audit log.
4. Route a timeout notification to the user via the channel adapter.
5. Dequeue the next message for this group (if any).

### 3.6 Call Inspector Escalation Relay

Given: the Token Broker sends a `catoEscalate` JSON-RPC call to `data/sockets/escalation.sock`.

1. Extract `checkId`, `action`, `contextId`, `tokenId`, `payloadHash`, `payloadSize`, and `contentExcerpt` from the params. Drop `escalationReason` and `inspectorCheck`.
2. Pass `contentExcerpt` through to Cato unchanged. The broker is the holder of the payload excerpt — the Orchestrator does not need to derive or store it. (Decision 23)
3. Send the standard Cato inline request (with `contentExcerpt`) to `data/sockets/cato.sock`.
4. Write `cato_check_relayed` to the audit log with `checkId`, outcome, and code.
5. Return Cato's response to the broker via the escalation socket: `{"allow":...,"code":...,"reason":...}`.

The escalation relay is synchronous. The broker's `catoEscalate` call blocks until the Orchestrator returns.

### 3.7 Supervised Mode Soft-Block Flow

Given: the group's `securityMode` is `supervised` and the Token Broker returns a soft-block signal on a proxied call (the Call Inspector held the call pending user confirmation).

1. Route a user-confirmation prompt to the channel adapter: describe the action being held and request confirm or cancel.
2. Wait for the user's response. Timeout: 60 seconds from when the prompt is sent. (Decision 24)
3. If confirmed: send `resolveSupervised` JSON-RPC call to `data/sockets/broker.sock` with `{ "checkId": "<uuid>", "decision": "confirm" }`. The broker forwards the held call.
4. If cancelled: send `resolveSupervised` with `{ "checkId": "<uuid>", "decision": "cancel" }`. Write a `cato_block` entry with `code: null, reason: "user_cancelled"` to the audit log.
5. If timed out: send `resolveSupervised` with `decision: "cancel"`. Write a `cato_block` entry with `code: null, reason: "supervised_timeout"` to the audit log. (Decision 24)

### 3.8 Skill Application

Given: the administrator applies a skill (provides a path to a `.intent.md` file).

1. Parse the YAML frontmatter from `.intent.md`.
2. Validate all seven rules per ARCHITECTURE.md §5.3:
   - `skill` ID unique in the installed set
   - All `token_scopes.skills` entries are syntactically valid kebab-case strings
   - All `filesystem.container_mounts` host paths exist and are within permitted mount roots
   - All `network.endpoints` patterns are valid URL patterns
   - All `mcp.servers` have `min_permission_tier` declared
   - `providers.compatible` is non-empty
   - `apply_permission` is present
3. If any rule fails: surface the specific failing field to the administrator; do not apply the skill.
4. If all rules pass:
   a. Register the skill in the in-memory installed skill registry.
   b. Persist the updated registry to `data/skill-registry.json` (or equivalent).
   c. Call `registerSkillScope` on `data/sockets/broker.sock` with `skillId`, `tokenScopes`, and `networkEndpoints`.
   d. If the broker returns an error, roll back the registry update and surface the error to the administrator.
   e. Write `skill_applied` to the audit log.
5. The next spawned container for any group uses the updated skill scope.

Skill removal follows the inverse: call `deregisterSkillScope`, update the registry, write `skill_removed`. Existing active tokens are not revoked; they expire normally. New tokens do not include the removed skill's scope.

### 3.9 Group Configuration

Group configuration is loaded from the host filesystem at startup and on an explicit administrator reload signal. The Orchestrator treats the loaded configuration as authoritative for each group until the next reload.

**File:** `groups/{name}/config.json` (JSON format). Created by the administrator; absent file is valid and results in deployment defaults being used. (Decision 25)

**Required fields:** `securityMode` (one of `golem_guard | supervised | power`), `assertiveness_level` (integer 1–5).

**Optional fields:** `flag_display_tag` (string, default `[FLAG]`), `blocked_display_tag` (string, default `[BLOCKED]`), `provider_override` (object, overrides deployment default for this group), `skill_set_override` (array of skill IDs; if absent, uses the global installed skill set).

**Absent file:** Orchestrator uses deployment defaults for all fields. No error is logged.

**Malformed file:** Orchestrator logs a `config_parse_error` audit event with the group ID and error summary (not the file content), falls back to deployment defaults, and does not halt. (Decision 25)

### 3.10 Tier 1 Memory Write Gate (ADR-10)

The Orchestrator must never write to `groups/{name}/CLAUDE.md` without a preceding Cato `MEMORY_WRITE` inline check that returned `allow: true`. This constraint has no exceptions. The empty-file auto-creation at spawn time (Decision 22) is not a memory write in this sense — it creates an empty file, not an agent-proposed content delta. Agent-proposed content deltas always pass through the Cato gate before being applied.

---

## Failure Modes

| Condition | Orchestrator Behavior |
|-----------|----------------------|
| Token Broker unreachable at startup | Retry until broker responds. Do not mark healthy. Do not spawn containers. |
| Cato unreachable at startup | Retry until Cato responds. Do not mark healthy. Do not spawn containers. |
| Token Broker unreachable during task dispatch | Queue pending messages. Notify the user via the channel. Do not spawn a container. |
| `issueToken` returns `token_store_full` | Treat as broker unavailable: queue pending messages, notify user, do not spawn. |
| Cato unreachable during inline check | Block the action (fail-closed). Revoke any issued token. Notify user. Write failure event to audit log. |
| Cato returns `allow: false` on `AGENT_PROMPT` | Do not spawn container. Revoke token. Route `[BLOCKED]` explanation to user. Write `cato_block` audit entry. |
| Cato returns `allow: false` on `MEMORY_WRITE` | Discard the mutation proposal. Write `memory_write_blocked` audit entry. Task completion proceeds without the memory write. |
| Container exceeds TTL | Tear down container, revoke token, notify user of timeout. Write `container_ttl_expired` audit entry. |
| Audit log write failure | Suspend the current operation until the write succeeds or a retry limit is reached. After retry exhaustion, abort the task (do not proceed with an unaudited action). Log the write failure to a local failure log. |
| `messages.db` creation fails at spawn time | Log the error. Queue pending messages for the group without dispatching containers until the database is accessible. Do not silently proceed. |
| `CLAUDE.md` creation fails at spawn time | Log the error. Abort the container spawn for this task. Route an error notification to the user. |
| Escalation socket receives `catoEscalate` when Cato is unreachable | Return `allow: false` to the broker (fail-closed). Write `cato_check_relayed` with outcome `blocked`, code `null`. |
| remote-control bridge unreachable or errors on invocation | Return error to caller. Do not create a task record. Do not queue the task. Fail-closed. |
| Hansei report file is unreadable or unparseable | Move the file to `data/hansei/quarantine/` (created at startup). Write a `hansei_parse_error` audit entry with the SHA-256 hash of the file path and the error summary (never file content). Do not retry. Health endpoint exposes `quarantinedHanseiReports` count; non-zero drives `status: "degraded"`. Administrator clears quarantine manually. (Decision 26) |

---

## Invariants

These properties hold at all times while the Orchestrator is running.

**INV-1: One active task per group.** At most one container is running for any given `groupId` at any moment. No second container is spawned for a group while the first is active.

**INV-2: No token without a task.** Every live derivative token corresponds to an active task record. Token issuance and revocation are always paired with task lifecycle events in the audit log.

**INV-3: No container without a Cato `AGENT_PROMPT` allow.** A container is never spawned unless the Orchestrator has received `allow: true` for the corresponding `AGENT_PROMPT` check in the same task lifecycle.

**INV-4: No Tier 1 write without Cato `MEMORY_WRITE` allow.** The Orchestrator never writes to `groups/{name}/CLAUDE.md` (beyond the empty-file auto-creation at first spawn) without a preceding `MEMORY_WRITE` check that returned `allow: true` (ADR-10).

**INV-5: Audit log write precedes action.** Every significant action (container spawn, token revoke, memory write) is preceded by its corresponding audit log INSERT. An action that cannot be audited does not proceed.

**INV-6: Fail-closed on all Cato paths.** Any failure to reach Cato — socket error, timeout, malformed response, `checkId` mismatch — is treated as `allow: false`. No action is permitted on a Cato communication failure.

**INV-7: No raw credentials in orchestrator memory.** The Orchestrator holds a derivative token reference (`tokenId` and opaque token string) only. No API key, OAuth token, or raw credential is ever stored in orchestrator process memory or logged to any output.

**INV-8: Escalation socket bound before healthy.** The Orchestrator binds `data/sockets/escalation.sock` before it performs its startup health checks with the broker. The broker can never send a `catoEscalate` to a missing socket.

**INV-9: Audit log is append-only.** The Orchestrator's write interface to the audit log issues INSERT statements only. No UPDATE or DELETE statement is produced by the Orchestrator on the audit log.

**INV-10: No message dropped.** Inbound messages are never silently discarded. They either enter the per-group queue or trigger an immediate error response to the originating channel. A bounded queue implementation must surface backpressure, not discard.

**INV-11: Remote-control tasks are audited identically to channel tasks.** Every task initiated via `remote-control.ts` produces the same audit log entries as a channel-initiated task, plus `sourceChannel: "remote-control"` on the `task_start` entry.

**INV-12: `contentExcerpt` presence matches action type.** For every Cato inline check the Orchestrator sends, `contentExcerpt` is non-null for `AGENT_PROMPT`, `OUTBOUND_API_CALL`, and `MEMORY_WRITE`, and is `null` or absent for `FILESYSTEM_WRITE` and `CREDENTIAL_REQUEST` (Decision 17).

---

## Acceptance Criteria

Each criterion is binary and testable from outside the Orchestrator process boundary.

**Startup**

AC-1: Given the Token Broker is listening and Cato is listening, the Orchestrator reaches healthy status and begins processing inbound messages.

AC-2: Given the Token Broker is not listening at startup, the Orchestrator does not spawn any container and does not mark itself healthy until the broker becomes reachable.

AC-3: Given Cato is not listening at startup, the Orchestrator does not spawn any container and does not mark itself healthy until Cato becomes reachable.

AC-4: Given the Orchestrator starts, it binds `data/sockets/escalation.sock` before issuing the health check to the broker socket. (Verifiable by observing socket creation order via filesystem timestamps or test sequencing.)

**Token Lifecycle**

AC-5: Given a new task is dispatched, the Orchestrator calls `issueToken` before spawning a container. The audit log contains a `token_request` entry for the token issued for that task.

AC-6: Given a task completes normally, the Orchestrator calls `revokeToken` and the audit log contains a `token_revoke` entry before the next task for the same group begins.

AC-7: Given the broker returns `token_store_full`, no container is spawned and the user receives a notification via the channel.

**Cato Gate**

AC-8: Given a task is dispatched and Cato returns `allow: false` on `AGENT_PROMPT`, no container is spawned and the audit log contains a `cato_block` entry.

AC-9: Given a task is dispatched and the Cato socket is unreachable, no container is spawned and the user receives an error notification.

AC-10: For action types `AGENT_PROMPT`, `OUTBOUND_API_CALL`, and `MEMORY_WRITE`, the Cato inline check request includes a non-null `contentExcerpt` field. For `FILESYSTEM_WRITE` and `CREDENTIAL_REQUEST`, `contentExcerpt` is absent or null in the request.

AC-11: Given Cato returns `allow: false` on `MEMORY_WRITE`, the Orchestrator does not write to `groups/{name}/CLAUDE.md` and the audit log contains a `memory_write_blocked` entry.

AC-12: Given Cato returns `allow: true` on `MEMORY_WRITE`, the Orchestrator writes the proposed delta to `groups/{name}/CLAUDE.md` and the audit log contains a `memory_write_approved` entry.

**Container Lifecycle**

AC-13: Given a container is spawned, the audit log contains a `container_spawn` entry with `containerId`, `mountPaths`, and `tokenId` before the container starts.

AC-14: Given a container exceeds its TTL, the container is torn down, the token is revoked, a `container_ttl_expired` entry appears in the audit log, and the user receives a timeout notification.

AC-15: Given a group has no active container, a second inbound message to that group results in a new task being dispatched (queue drain behavior).

AC-16: Given a group has an active container, a second inbound message to that group enters the queue and is not dispatched until the active task completes.

**Escalation Relay**

AC-17: Given the Token Broker sends a `catoEscalate` call to `data/sockets/escalation.sock`, the Orchestrator forwards a Cato inline check to `data/sockets/cato.sock` and returns Cato's `allow` and `code` to the broker. The `escalationReason` and `inspectorCheck` fields from the broker params are not present in the Cato request.

AC-18: Given Cato is unreachable during an escalation relay, the Orchestrator returns `allow: false` to the broker and the audit log contains a `cato_check_relayed` entry with a blocked outcome.

**Audit Log**

AC-19: Given any significant event (task start, spawn, complete, block, revoke, memory write), the corresponding audit log entry exists with the correct `eventType` before the next operation in the lifecycle proceeds.

AC-20: Given an audit log write fails, the Orchestrator does not proceed with the guarded action.

AC-21: Inspection of the audit log SQL schema and write paths reveals no UPDATE or DELETE statements in the Orchestrator's write interface.

**Skill Lifecycle**

AC-22: Given a valid `.intent.md`, the Orchestrator registers the skill, calls `registerSkillScope` on the broker socket, and the audit log contains a `skill_applied` entry.

AC-23: Given an invalid `.intent.md` (any failing validation rule), the Orchestrator rejects the skill and surfaces the specific failing field. No `registerSkillScope` call is made. The installed skill registry is unchanged.

AC-24: Given a skill is removed, the Orchestrator calls `deregisterSkillScope` and the audit log contains a `skill_removed` entry. Existing active tokens are not revoked.

**Pre-Spawn Auto-Create**

AC-25: Given a group directory exists but `messages.db` does not, the Orchestrator creates the database with the normative Tier 2 schema and WAL mode before spawning the container. The message is processed normally.

AC-26: Given a group directory exists but `CLAUDE.md` does not, the Orchestrator creates an empty file at `groups/{name}/CLAUDE.md` before spawning the container. The container starts normally with the empty file mounted.

**Remote Control**

AC-27: Given a remote-control-initiated task, the audit log contains a `task_start` entry with `sourceChannel: "remote-control"`. All other audit entries (spawn, complete, block) are produced identically to a channel-initiated task.

AC-28: Given the remote-control bridge errors during task invocation, no task record is created and no container is spawned.

**Invariant Verification**

AC-29: At no point during any test run does the Orchestrator process memory contain a raw API key, OAuth token, or Bitwarden session credential (verified by inspecting environment and heap snapshot).

AC-30: The health endpoint is reachable only on `127.0.0.1`. A request from any other address is refused.
