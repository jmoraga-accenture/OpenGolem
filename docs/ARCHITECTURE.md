# OpenGolem — Architecture v1.0
*Produced: 2026-04-05 | Revised: 2026-04-05 (RC-1–RC-7) | Architect: upstream of SPECS.md v1.0*
*Inputs: ARCHITECT_BRIEF.md, REVIEW_META_PLAN.md, ARCHITECTURE_REVIEW.md, SPECS.md v0.4, DECISIONS.md*

This document defines the "to be" architecture for OpenGolem. It is not a description of the current codebase. It is the target against which the Phase 2 implementation is built and against which any existing code is evaluated. Where this document and the codebase conflict, this document is correct.

Seven topics are covered in order: process model, trust domain map, component responsibilities, IPC boundaries, skill system, memory architecture, and architectural decisions. No implementation is implied until all seven are defined.

---

## 1. Process Model

### 1.1 Long-Lived Processes

Three host processes run for the lifetime of the Golem service. They start in this order and do not restart each other — a failed process surfaces to a supervisor (systemd/launchd).

**Orchestrator**
The central coordinator. Manages the inbound message queue per context, spawns and tracks agent containers, routes outbound messages through channel adapters, writes orchestrator events to the audit log. It owns no secrets and makes no safety decisions. It asks the Token Broker for tokens and asks Cato for permission before significant actions. It is the only process that drives the container lifecycle.

**Token Broker**
The sole keeper of long-lived credentials. Issues scoped derivative tokens to the orchestrator on demand. Revokes tokens at task completion, TTL expiry, or explicit cancel. Proxies outbound LLM API calls (acting as the HTTP credential injection point), applying the Call Inspector before each forward. Communicates with the orchestrator only — no other process contacts it directly.

**Cato**
The oversight process. Receives inline check requests from the orchestrator and returns allow/block decisions. Runs scheduled deep audits of the audit log at a configured interval. Computes dao_score KPIs from audit data. Produces hansei reports for administrator review. Has no channel to users and receives no instructions from any user session or agent token. Cannot be addressed, prompted, or modified by any running agent.

### 1.2 Ephemeral Processes

**Agent Containers**
One container per task. Spawned by the orchestrator with explicit bind mounts and injected environment variables. Runs the agent runtime (default: Claude Agent SDK; alternatives via provider shim). Torn down at task completion, TTL expiry, or Cato block. The container holds a derivative token but never a raw credential. Containers do not know about each other and cannot access each other's data.

### 1.3 Startup Order and Dependencies

```
Credential backends (file/.env, Bitwarden, OneCLI) must be reachable before:
  Token Broker starts (reads backends on init; fails closed if unavailable)

Token Broker must be listening on its Unix socket before:
  Orchestrator starts (orchestrator contacts broker at boot for health check)

Cato must be listening on its Unix socket before:
  Orchestrator starts (orchestrator contacts Cato at boot for health check)

Orchestrator starts last; all containers are spawned by it after it is running.

The orchestrator binds the **escalation listener** (§4.2.2 — Token Broker → orchestrator `catoEscalate`) before marking itself healthy, so the broker never blocks on a missing relay during Call Inspector escalation.
```

If any long-lived process fails, the orchestrator queues inbound messages and does not spawn containers until all dependencies are healthy. No task starts without a valid token and an available Cato endpoint.

### 1.4 What Does Not Exist

No message broker. No service mesh. No central database server. No HTTP API surface exposed to the network. No web UI. The entire host-side system communicates via Unix sockets and the local filesystem.

---

## 2. Trust Domain Map

A trust domain is a set of components that share a security perimeter: they are mutually trusted, communicate in-process or through low-ceremony channels, and present a single external attack surface. Trust domain crossings are always explicit IPC with an audit trail.

### 2.1 Enumerated Trust Domains

**TD-CATO**
Components: Cato process, PSYCHE.md configuration, dao_score database, hansei report files.
Trusted to: make allow/block decisions, read the audit log, compute KPIs, produce administrator reports.
Not trusted to: communicate with users, modify orchestrator state, issue tokens, hold external credentials, take actions in the world.
External contacts: receives check requests from TD-ORCHESTRATOR; writes to the shared audit log; writes hansei report files to a well-known host directory (orchestrator reads via poll — §4.7).

**TD-ORCHESTRATOR**
Components: Orchestrator process, channel adapters (in-process), message queue, routing logic, group configuration.
Trusted to: manage the message and task lifecycle, drive container spawn/teardown, route outbound messages, write orchestrator events to the audit log.
Not trusted to: hold raw credentials, make safety decisions, modify agent containers' filesystems directly, reconfigure Cato, issue tokens.
External contacts: Token Broker (TD-BROKER), Cato (TD-CATO), agent containers (TD-CONTAINER), channel providers (TD-CHANNEL); **listens** for Token Broker `catoEscalate` on a dedicated Unix socket (§4.2).

**TD-BROKER**
Components: Token Broker process, credential proxy (HTTP), token store (in-memory), credential backends.
Trusted to: hold long-lived secrets, issue derivative tokens, revoke tokens, proxy and inspect outbound LLM API calls.
Not trusted to: make routing decisions, access agent filesystems, read audit log, communicate with users.
External contacts: receives token requests from TD-ORCHESTRATOR; opens **client** connections to TD-ORCHESTRATOR for `catoEscalate` (§4.2); forwards LLM calls to TD-EXTERNAL after Call Inspector approval; receives HTTP calls from TD-CONTAINER.

**TD-CONTAINER[n]**
One domain per active container instance. Each is isolated from all other container instances.
Components: agent runtime (Claude Agent SDK or provider shim), container filesystem, container skills.
Trusted to: execute agent logic within its declared scope, read its scoped filesystem mounts, make outbound LLM calls through the credential proxy using its derivative token.
Not trusted to: access other containers' data, hold or inspect raw credentials, communicate directly with Cato or the Token Broker, modify the audit log, access the semantic graph directly.
External contacts: receives task input from TD-ORCHESTRATOR (filesystem); sends output to TD-ORCHESTRATOR (stdout sentinel); calls TD-BROKER via HTTP (credential proxy).

**TD-CHANNEL**
Components: external channel providers (Telegram API, WhatsApp servers, TUI terminal), in-process channel adapters.
Note: The adapters are in-process with the orchestrator (same TD-ORCHESTRATOR trust domain, detailed in Section 4). The *external* channel providers — Telegram's servers, WhatsApp's infrastructure — are untrusted external entities.
Trusted to: deliver messages from authenticated users.
Not trusted to: modify system state, access configuration, bypass Cato.

**TD-EXTERNAL**
Components: LLM provider APIs (Anthropic, OpenRouter, Ollama, custom), MCP servers declared by skills.
Not trusted. All communication is outbound from TD-BROKER (for LLM calls) or from TD-CONTAINER via TD-BROKER (for MCP calls).

**TD-ADMIN**
The human administrator. Interacts via the local filesystem, config files, and Claude Code CLI. Can apply skills, modify PSYCHE.md, review hansei reports, and configure credential backends. Cannot modify Cato's inline behavior at runtime — changes require a deploy cycle. Cannot read another group's private data through the admin interface. Cannot override an active inline Cato block.

**TD-USER**
A user interacting through a channel session. Has no access to system configuration. Cannot address Cato. Can instruct Alef. The safety guarantee holds even when the user attempts to subvert it.

### 2.2 Permitted Communication Paths

The following paths are permitted. All others are prohibited by architecture, not by policy.

```
TD-ADMIN    → TD-ORCHESTRATOR   (config file reads at startup; Claude Code skill application)
TD-ADMIN    → TD-CATO           (PSYCHE.md edits; hansei report reads — read only, no runtime influence)

TD-USER     → TD-CHANNEL        (inbound messages via channel protocol)
TD-CHANNEL  → TD-ORCHESTRATOR   (message delivery — in-process adapter)

TD-ORCHESTRATOR → TD-BROKER     (token request/revoke — Unix socket)
TD-BROKER       → TD-ORCHESTRATOR (Call Inspector escalation relay — Unix socket; broker-initiated synchronous RPC; orchestrator forwards to Cato and returns)
TD-ORCHESTRATOR → TD-CATO       (inline check — Unix socket)
TD-ORCHESTRATOR → TD-CONTAINER  (spawn, send task, receive result — filesystem + stdout)
TD-ORCHESTRATOR → TD-CHANNEL    (outbound message routing — in-process)
TD-ORCHESTRATOR → audit log     (append writes)

TD-BROKER   → TD-EXTERNAL       (proxied LLM API call — HTTPS)
TD-BROKER   → audit log         (append writes for call events)

TD-CONTAINER → TD-BROKER        (outbound LLM/MCP call — HTTP to credential proxy)

TD-CATO     → audit log         (append writes for check decisions and scheduled audit events)
TD-CATO     → filesystem        (hansei report files under a well-known host path — write only)

TD-ORCHESTRATOR → filesystem    (hansei report directory — read only, poll; see §4.7)

audit log   → TD-CATO           (scheduled audit reads — direct SQLite access, read-only)
```

No path exists from TD-CONTAINER to TD-CATO. No path exists from TD-CONTAINER to TD-ORCHESTRATOR except the sentinel protocol. No path exists from TD-USER or TD-CHANNEL to TD-CATO, TD-BROKER, or the audit log.

---

## 3. Component Responsibilities

### 3.0 Security mode model

Security mode is a **per-group** dial. It is persisted in **group configuration on the host filesystem** (same surface as other group-scoped settings). The orchestrator loads it at startup and treats the loaded value as authoritative for that group until configuration is reloaded (administrator edit + orchestrator reload or equivalent).

**Which component owns “current mode” for a running context:** the **orchestrator** applies the mode when issuing tokens and when presenting soft-block prompts; the **group config file** is the source of truth, not in-memory ad hoc state.

**Flow to the Call Inspector:** when the orchestrator calls `issueToken`, it passes the group’s current `securityMode`. The Token Broker **encodes `securityMode` as a claim inside the derivative token**. The Call Inspector reads the validated token on every proxied call and enforces the mode-appropriate posture. No separate race-prone channel is required.

**Who may change the mode, and how:** by default, **TD-ADMIN** only — edits to group configuration and a reload boundary. (A future skill may allow a narrower “power user” path; that remains a governed extension, not an agent or container capability.)

**Interaction with Cato:** Cato’s inline `allow: false` remains **unconditional** — it is the protection floor (ADR-1, ADR-2). Security mode does not relax Cato. It **does** change how the **Call Inspector** treats failed or ambiguous deterministic checks, and whether the user is prompted (Supervised) before an action proceeds.

| Mode | Call Inspector posture (summary) | User prompt on Inspector-mediated friction |
|------|----------------------------------|---------------------------------------------|
| **Golem Guard** (default) | Full five-check lint on every proxied call; failed check → hard block | No |
| **Supervised** | Full five-check lint; failed check → **soft block** — outbound call or action is held until the user confirms or cancels on the channel | Yes |
| **Power** | Reduced inspection: hard block only on **high-confidence prompt-injection signatures** and scope/rate violations that indicate abuse; other lint failures are advisory per SPECS | No |

Exact predicates per check and mode are **behavioral spec** (SPECS.md v1.0), not this document. This section fixes **ownership, storage, and data flow**.

### 3.1 Orchestrator

**Owns:**
- Per-group **security mode** application: reads mode from group config, passes it to the Token Broker at `issueToken`, and implements **Supervised** user-confirm/cancel flows for Inspector soft blocks (channel adapter round-trip)
- Inbound message queue per context, with concurrency control (one active task per context at a time)
- Container spawn and teardown lifecycle (issues spawn, monitors TTL, forces teardown)
- Outbound message routing to the appropriate channel adapter
- Token request/revoke calls to the Token Broker
- Cato inline check calls before significant actions
- **Call Inspector escalation relay:** responds to broker-initiated JSON-RPC (`catoEscalate`) by forwarding a minimal check payload to Cato and returning Cato’s decision to the broker (§4.2, §4.3, ADR-11)
- Audit log entries for orchestrator events (task start, container spawn, task complete, Cato block, TTL expiry)
- Group configuration loading at startup
- Health status endpoint (for administrator inspection, 127.0.0.1 only)

**Does not own:**
- Raw credentials — never stored in orchestrator memory beyond a transient token reference
- Safety decisions — all enforcement decisions come from Cato
- Channel protocol implementation — delegated to adapters
- Agent logic — all execution is inside containers
- Audit log analysis — that is Cato's job
- Any user-facing content — Alef (inside the container) is the sole voice to users

### 3.2 Token Broker

**Owns:**
- Long-lived secret resolution via the configured credential backend
- Token issuance: produces a signed, opaque token encoding skill whitelist, TTL, call budget, permitted data scopes, originating container ID, **`securityMode` claim** (per §3.0)
- Token validation on every proxied call
- Token revocation: invalidates the token's entry in the in-memory store
- Outbound call proxying: intercepts HTTP calls from containers, validates token, applies Call Inspector checks, injects credentials at last hop, forwards to provider
- Audit log entries for token events and call decisions

**Does not own:**
- Routing or scheduling decisions — it responds to requests, it does not initiate workflow
- Agent container management — it never spawns or addresses containers directly
- Safety decisions beyond the Call Inspector's five checks — anomaly analysis is Cato's job
- Multiple simultaneous credential backends — one backend per deployment

### 3.3 Call Inspector (component within Token Broker)

The Call Inspector is not a separate process. It is the enforcement logic run by the Token Broker on every proxied call, before the call is forwarded. It is architecturally distinct from the rest of the broker because it is the only component in TD-BROKER that reasons about call content.

**Owns:**
- Five deterministic checks (in order):
  1. Skill whitelist: is the requested endpoint declared in this token's skill set?
  2. Memory scope: does the payload reference partitions not permitted by this token?
  3. Prompt injection signatures: does the payload match known high-confidence injection patterns? (maintained as source code, not configuration)
  4. Call rate: is the call rate anomalous relative to the declared task profile?
  5. Endpoint scope: is the target URL within the token's permitted endpoint set (including MCP endpoints)?
- **Mode-aware enforcement:** reads `securityMode` from the validated derivative token (§3.0). **Golem Guard:** failed check → hard block. **Supervised:** failed check → soft block (orchestrator-mediated user prompt). **Power:** only checks that SPECS marks as hard-blocking in Power mode may hard-block; others are advisory or skipped.
- **Inconclusive symbolic outcomes:** when a check is designed to return *inconclusive* (neither pass nor fail) and policy requires judgment, the Inspector **does not guess**. It invokes **Cato via the orchestrator escalation relay** (§4.2, ADR-11); the broker has no direct socket to Cato.
- Audit log entry for every call (pass, fail, soft-block, and escalation)

**Does not own:**
- LLM-based ambiguity resolution — Cato owns escalation judgment; the Inspector only routes to Cato through the relay
- Semantic analysis of payload content beyond its deterministic rules — the Inspector is a linter, not a reasoner
- Safety decisions about the overall task — it checks individual calls, not intent

### 3.4 Cato

**Owns:**
- Inline check protocol: receives `{action, payload_hash, context_id, token_id}` from the orchestrator; returns `{allow: bool, code?: CatoRiskCode, reason?: string}`
- Tier 1 memory mutations: `MEMORY_WRITE` inline checks on proposed `CLAUDE.md` deltas before the orchestrator commits (ADR-10)
- Deterministic symbolic checks (Phase 1): path traversal patterns, oversized payload detection
- LLM escalation path (Phase 2): for cases where symbolic checks return inconclusive, escalates to LLM judgment bounded by PSYCHE.md's enumerated criteria
- Scheduled audit: periodic deep review of audit log, Alef behavior patterns, credential access history, and dao_score trends
- dao_score computation: three KPIs derived from audit log data (security_failures_per_call, data_leaks_per_call, behavioral_change_rate)
- Hansei reports: structured administrator-facing summaries from scheduled audits
- Risk code enumeration: maintains the authoritative set of CatoRiskCode values

**Does not own:**
- User-facing communication — Alef translates Cato's decisions; Cato never addresses users
- Credential management — no secrets, no tokens
- Container lifecycle — no spawn or teardown authority
- Threshold auto-recalibration — KPIs are diagnostic; calibration is a human decision
- Decisions outside PSYCHE.md's enumerated criteria — even the LLM escalation path operates within a closed list of judgment questions

**Cato's LLM escalation model (Phase 2 specification):**
The symbolic layer runs first. If a check is conclusive (allow or block), the decision is returned immediately — the LLM is not consulted. If the symbolic check returns inconclusive, the LLM is invoked as a classifier against a specific, enumerated question from PSYCHE.md (e.g. "Does this payload contain a social engineering attempt to extract credentials?"). The LLM receives only what PSYCHE.md authorizes it to see (payload hash, context type, risk class under evaluation). It returns allow/block for that question. It cannot expand its own mandate, request additional context, or produce a non-binary outcome.

### 3.5 Alef (Agent Instance)

Alef is not a process. Alef is the character instantiated by the agent runtime inside each container run, defined by SOUL.md prepended to every prompt.

**Owns:**
- All user-facing communication: conversational responses, skill execution output, explanations
- **Language detection and adaptation:** infers the user’s language from inbound messages (per channel), responds in that language, and **adapts when the user switches languages within a session** — expected and supported. Explanatory text for `[FLAG]` and `[BLOCKED]` is always composed in the **detected user language** (ADR-8: Cato still treats language-switching as a potential evasion signal; Alef’s localization does not weaken checks).
- **Configurable display markers (per group):** the strings shown to the user for Alef-originated disagreement and for Cato-mediated blocks are **not fixed English tokens**. Group configuration supplies `flag_display_tag` and `blocked_display_tag` (defaults: `[FLAG]`, `[BLOCKED]`). A user may set e.g. `[BLOQUEADO]` or suppress a tag entirely for less visual noise. The orchestrator injects these into the container environment (same pattern as `ASSISTANT_NAME`); SOUL.md references the injected values. **`[FLAG]` and `[BLOCKED]` remain the canonical English forms in the audit log and in machine-readable telemetry** — display configuration is UI-only decoupled from logging (philosophical synthesis, REVIEW_META_PLAN).
- `[FLAG]` assertions (user-visible tag = configured display string): Alef's own voice when asserting against a user instruction
- `[BLOCKED]` communications (user-visible tag = configured display string): translating Cato's enforcement decision into a user-readable explanation in the user's language. The explanation names the risk class and explains it — it does not reproduce payload content
- Assertiveness dial (`assertiveness_level` 0–10): configures how forcefully Alef challenges self-damaging instructions
- Skill invocation within the container's declared scope

**Does not own:**
- Any enforcement decision — all blocks come from Cato or the Call Inspector
- Credential management
- Audit log writes (those come from the orchestrator and broker)
- Safety guarantees — Alef's protection is character-based and probabilistic; it is the communication layer, not the protection layer

### 3.6 Channel Adapters

**Owns:**
- Channel-specific protocol handling (Telegram bot API polling/webhook, WhatsApp Baileys events, TUI readline)
- Inbound message normalization into the orchestrator's internal message format
- Outbound message formatting from the orchestrator's internal format to channel-specific syntax (markdown → channel native)
- User identity resolution (Telegram user ID → internal user ID, etc.)

**Does not own:**
- Routing or scheduling
- Safety decisions
- Agent invocation
- Persistent storage
- Any business logic

Channel adapters run in-process with the orchestrator (same trust domain). This is architecturally accepted: adapters are applied as Skills with audited declarations; TD-ORCHESTRATOR's access to them is intentional.

### 3.7 Audit Log

The audit log is a single append-only SQLite file. Every significant system event is written here. It is the ground truth for all governance: dao_score, hansei reports, and administrator inspection all read from this file.

**Owns:**
- Event storage: structured rows with timestamp, event type, context ID, actor, payload hash (not payload content), outcome
- Append-only semantics: enforced by schema design (no UPDATE/DELETE in the write interface), supplemented by OS-level file permissions where possible

**Does not own:**
- Analysis — Cato reads and analyzes; the log stores and serves
- Retention policy — a configurable rolling window is a Cato configuration, not a log property
- Alert generation — alerts come from Cato's analysis of the log

**Writers:** Orchestrator, Token Broker/Call Inspector, Cato. No agent container has a write path to the audit log.

---

## 4. IPC Boundaries

For every trust domain crossing, the following is specified: protocol, direction, message schema (where fixed), and how the interaction is audited.

### 4.1 Channel Provider → Channel Adapter → Orchestrator

**TD-CHANNEL → TD-ORCHESTRATOR (in-process)**

This is two hops. The external hop (channel provider to adapter) uses the channel's native protocol (Telegram webhook/long-poll, WhatsApp Baileys WebSocket, TUI readline). The internal hop (adapter to orchestrator) is an in-process function call — both are in TD-ORCHESTRATOR.

*Protocol (external):* Channel-native. Not specified here; it is channel-specific.
*Protocol (internal):* In-process method call. No serialization.
*Direction:* Inbound (channel → system).
*Auditability:* The orchestrator logs every received message to the audit log (context ID, sender identity hash, channel, timestamp). Message content is not stored — only the fact of receipt and a content hash.

### 4.2 Orchestrator ↔ Token Broker (JSON-RPC over Unix sockets)

Token and health operations use **one** Unix socket: the **orchestrator is the JSON-RPC client**, the **broker is the server**. Call Inspector escalation uses a **second** Unix socket: the **broker is the client**, the **orchestrator is the server** (ADR-11). Two sockets avoid multiplexing conflicting caller roles on a single JSON-RPC channel.

#### 4.2.1 Orchestrator → Token Broker (token lifecycle)

**TD-ORCHESTRATOR → TD-BROKER**

*Protocol:* Unix socket (broker listens), newline-delimited JSON-RPC 2.0.
*Direction:* Orchestrator initiates; broker responds.

```json
// Issue token
{"jsonrpc":"2.0","method":"issueToken","params":{"contextId":"...","skillSet":["..."],"ttl":300,"callBudget":50,"dataScopes":["..."],"securityMode":"golem_guard|supervised|power"},"id":1}
{"jsonrpc":"2.0","result":{"token":"<opaque>","tokenId":"...","expiresAt":"..."},"id":1}

// Revoke token
{"jsonrpc":"2.0","method":"revokeToken","params":{"tokenId":"..."},"id":2}
{"jsonrpc":"2.0","result":{"revoked":true},"id":2}

// Health check
{"jsonrpc":"2.0","method":"health","params":{},"id":3}
{"jsonrpc":"2.0","result":{"status":"ok"},"id":3}
```

#### 4.2.2 Token Broker → Orchestrator (Call Inspector → Cato escalation)

**TD-BROKER → TD-ORCHESTRATOR**

*Protocol:* Unix socket (**orchestrator listens**, broker connects per escalation or holds a pooled connection), newline-delimited JSON-RPC 2.0.
*Direction:* Broker initiates; orchestrator responds after forwarding to Cato (§4.3).

```json
{"jsonrpc":"2.0","method":"catoEscalate","params":{"checkId":"<uuid>","action":"OUTBOUND_API_CALL","contextId":"...","tokenId":"...","payloadHash":"<sha256-hex>","payloadSize":42000,"escalationReason":"INSPECTOR_INCONCLUSIVE","inspectorCheck":"PROMPT_INJECTION"},"id":4}
{"jsonrpc":"2.0","result":{"allow":false,"code":"PROMPT_INJECTION","reason":"..."},"id":4}
```

The `result` object **must** mirror Cato’s inline response semantics (`allow`, optional `code`, optional `reason`). The orchestrator is the **only** component that opens a client connection to Cato; the broker never connects to TD-CATO (§2.2, ADR-11).

*Auditability:* Broker logs every token issuance and revocation (token ID, context ID, skill set, security mode, TTL — not the token value itself). Orchestrator logs the token ID for the task it spawns. Escalation round-trips log `checkId`, `tokenId`, and outcome on broker, orchestrator, and Cato. Together these provide a complete token lifecycle trail and escalation trail.

### 4.3 Orchestrator → Cato (Inline Hook)

**TD-ORCHESTRATOR → TD-CATO**

*Protocol:* Unix socket, newline-delimited JSON. Not JSON-RPC — Cato's protocol is simpler and fixed.
*Direction:* Bidirectional request/response. Orchestrator initiates; Cato responds.
*Request schema:*
```json
{
  "checkId": "<uuid>",
  "action": "<action-type>",
  "contextId": "<group-or-session-id>",
  "tokenId": "<token-id>",
  "payloadHash": "<sha256-hex>",
  "payloadSize": 42000
}
```
`action` is a fixed enumeration: `AGENT_PROMPT`, `OUTBOUND_API_CALL`, `FILESYSTEM_WRITE`, `CREDENTIAL_REQUEST`, `MEMORY_WRITE` (Tier 1 persistence — ADR-10). No free-text action types.
`payloadHash` and `payloadSize` allow size and pattern checks without Cato receiving raw payload content. Cato's reason field in its response must not reproduce payload content.

*Response schema:*
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
`code` is drawn from the CatoRiskCode enumeration (Section 4.3.1). `reason` is free text for cases that don't fit a code; it names the risk class, it does not reproduce the payload. Both fields are optional on allow decisions.

*Auditability:* Cato logs every check (checkId, action, contextId, tokenId, payloadHash, outcome, code). The orchestrator logs the checkId alongside the task record. Together these provide a full gate trail per task.

*Failure mode:* If the Cato socket is unreachable, the orchestrator blocks the action (fail-closed). No action proceeds without a Cato allow response. This is not configurable.

**4.3.1 CatoRiskCode Enumeration (Phase 1)**

| Code | Meaning |
|------|---------|
| `PATH_TRAVERSAL` | Payload contains `../` or `..\` indicating potential filesystem escape |
| `OVERSIZED_PAYLOAD` | Payload exceeds configured size limit (default: 100 KB) |
| `PROMPT_INJECTION` | Payload matches a high-confidence injection signature |
| `PII_PLAIN_TEXT` | Payload contains what appears to be PII (SSN, card number, credential) in plaintext |
| `CREDENTIAL_EXPOSURE` | Payload appears to contain a raw API key or token |
| `OUT_OF_SCOPE_ENDPOINT` | Requested endpoint not declared in the token's skill set |
| `MEMORY_SCOPE_VIOLATION` | Payload references a memory partition not permitted by this token |
| `RATE_ANOMALY` | Call rate significantly exceeds declared task profile |
| `DELEGATION_CEILING_EXCEEDED` | Subagent token request exceeds parent token's scope |

This set is intentionally open for extension. New codes are added by PSYCHE.md revision when new risk patterns are observed in practice. Codes are not removed — they are deprecated in PSYCHE.md while remaining valid in historical audit records.

### 4.4 Orchestrator → Agent Container

**TD-ORCHESTRATOR → TD-CONTAINER[n]**

This boundary is the primary host-container interface. Any change to it is a security-relevant protocol change and requires an architectural decision record.

**Spawn direction (orchestrator → container):**
*Protocol:* Container runtime invocation (docker run / apple container run) with explicit parameters.
*What the orchestrator controls:*
- Bind mounts: `--mount type=bind,src=<group-dir>,dst=/workspace/group,ro=false` and `--mount type=bind,src=<extra-dir>,dst=/workspace/extra,ro=true`
- Environment variables: `ANTHROPIC_BASE_URL` (set to credential proxy URL), provider config vars, `ASSISTANT_NAME`, `ALEF_FLAG_DISPLAY_TAG`, `ALEF_BLOCKED_DISPLAY_TAG` (defaults `[FLAG]`, `[BLOCKED]` — §3.5)
- No raw credentials in environment
- Resource limits: CPU and memory caps set at spawn time per task profile
*Auditability:* Orchestrator logs container ID, bind mounts, token ID, and task ID at spawn.

**Task input (orchestrator → container, filesystem):**
The task description is written to a file in the group directory before container spawn. The container reads it via the bind mount. No stdin channel for task content — filesystem only.

**Result output (container → orchestrator, stdout sentinel):**
```
---OPENGOLEM_OUTPUT_START---
{"status":"success"|"error","result":"...","newSessionId":"..."}
---OPENGOLEM_OUTPUT_END---
```
The orchestrator reads stdout, parses between sentinel markers, and processes the JSON. Everything outside the markers is discarded (not logged to the audit log — it may contain conversation content).
*Auditability:* The orchestrator logs task completion status and the newSessionId. Result content is not logged.

**Container → orchestrator communication beyond stdout:**
None. A container cannot initiate communication with the orchestrator. It cannot write to the orchestrator's filesystem. It cannot signal the orchestrator. The sentinel protocol is the complete interface.

### 4.5 Agent Container → Credential Proxy (LLM and MCP Calls)

**TD-CONTAINER → TD-BROKER**

*Protocol:* HTTP to `ANTHROPIC_BASE_URL` (or equivalent provider URL), injected as an environment variable by the orchestrator at spawn.
*Direction:* Outbound (container initiates).
*What the container sends:* A normal LLM API call with its derivative token as the bearer token. The proxy intercepts it.
*What the proxy does:*
1. Validates the derivative token (not expired, not revoked, within call budget)
2. Runs the five Call Inspector checks
3. On pass: replaces the derivative token with the real credential, forwards to the actual provider endpoint
4. On fail: returns an HTTP 403 with a structured error body; logs the blocked call to the audit log

*The container never sees the real provider URL or credential.* It sees only the proxy URL and its derivative token.
*Auditability:* Every call (pass and fail) logged to the audit log with token ID, endpoint category, call budget consumed, and outcome code.

### 4.6 Credential Proxy → External Provider

**TD-BROKER → TD-EXTERNAL**

*Protocol:* HTTPS to the configured provider endpoint (Anthropic API, OpenRouter, Ollama, custom).
*Direction:* Outbound (proxy initiates).
*Auditability:* Proxy logs endpoint base URL (not path with potential PII), response status code, and call latency. Payload content is not logged.

### 4.7 Cato → Orchestrator (Hansei Report Delivery)

**Choice (RC-1): filesystem drop + orchestrator poll only.** Push notifications (e.g. broker or Cato → orchestrator socket) are **not** part of v1.0 — they introduce a second protocol, asymmetric spoofing/replay analysis, and ambiguous responsibility when the receiver is down. A single mechanism keeps trust boundaries auditable.

**TD-CATO → host filesystem; TD-ORCHESTRATOR → host filesystem (read)**

*Protocol:* Cato writes each hansei report as an **atomic file create** under a **well-known directory** on the host (e.g. `data/hansei/inbox/` — exact path is deployment config, not over-specified here). Filename includes timestamp and report id; content is replace-only-at-create (write temp + rename).

*Direction:* Cato writes; orchestrator **polls** the inbox on a fixed interval and after Cato appends a **report-ready marker** to the audit log (event type defined in SPECS). Polling is orchestrator-initiated only — Cato never opens a client connection to the orchestrator for delivery.

*Report format:* Structured JSON with timestamp, period covered, KPI values, anomaly findings, and recommendation flags. Never auto-applied — the report is surfaced to the administrator through the **dashboard skill**, health endpoint, or CLI (§5.4).

*Auditability:* Report production is logged by Cato (scheduled audit event). The orchestrator logs each file it ingests (report id, path hash, ingest timestamp). No shadow channel.

### 4.8 Audit Log Access

The audit log is a shared SQLite file on the host filesystem.

*Writers:* Orchestrator (task events), Token Broker/Call Inspector (token and call events), Cato (check decisions, audit run events). All writes are appends — INSERT only, no UPDATE or DELETE through the normal write path.
*Readers:* Cato (for scheduled audits and dao_score computation), administrator tools (health endpoint, CLI status).
*Agent containers:* No access path. The audit log directory is never bind-mounted into a container.
*Integrity:* WAL mode enables concurrent writers. Append-only semantics enforced by the write interface design. A build-time check verifies no UPDATE or DELETE appears in audit log write paths.

---

## 5. Skill System

### 5.1 What a Skill Is

A skill is a declared, auditable extension to the Golem's capabilities. Skills are explicit — they are applied by the administrator and take effect immediately. No capability is discovered at runtime. No undeclared capability exists in the token scope.

Four skill types:

| Type | What it does | Applied how |
|------|-------------|-------------|
| **Feature** | Merges a branch that adds code (channel adapters, integrations) | Git merge + restart |
| **Utility** | Ships code files alongside a `SKILL.md` install guide | File copy + config |
| **Operational** | Instruction-only workflow; no new code | Documentation |
| **Container** | Loaded inside agent containers at runtime | Bind-mounted into container |

### 5.2 `.intent.md` Schema

Every non-operational skill carries an `.intent.md` file. The orchestrator validates this declaration at skill application time. A skill whose `.intent.md` fails validation is not applied.

```yaml
---
skill: <skill-id>            # unique, kebab-case identifier
version: <semver>            # e.g. "1.0.0"
type: feature | utility | container
description: <one-line>      # what this skill enables

# Token scope additions — what this skill adds to the allowed skill set
token_scopes:
  skills:
    - <skill-id>             # each listed id is added to tokens issued while this skill is active

# Host filesystem effects
filesystem:
  host_reads:                # paths this skill reads on the host
    - <path-pattern>
  host_writes:               # paths this skill writes on the host
    - <path-pattern>
  container_mounts:          # bind mounts this skill adds to spawned containers
    - host_path: <path>
      container_path: <path>
      access: read | read-write

# Network endpoints this skill makes available to agents (Call Inspector validates against this)
network:
  endpoints:
    - pattern: <url-pattern> # glob or prefix, e.g. "https://api.telegram.org/*"
      protocol: https | wss
      direction: outbound

# MCP servers this skill declares
mcp:
  servers:
    - id: <server-id>
      url: <mcp-endpoint>
      scopes:
        - <scope-name>
      min_permission_tier: viewer | member | owner | admin

# LLM provider compatibility
providers:
  compatible:
    - anthropic | openrouter | ollama | any
  requires_features:         # optional: Anthropic-specific features this skill depends on
    - extended_thinking | tool_use | ...

# Who can apply this skill
apply_permission: admin | power_user
---
```

### 5.3 Skill Validation Rules

At application time, the orchestrator verifies:
1. `skill` ID is unique in the installed set (no collision with existing skills)
2. All `token_scopes.skills` entries are recognizable skill IDs
3. All `filesystem.container_mounts` host paths exist and are within permitted mount roots
4. All `network.endpoints` patterns are valid URL patterns
5. All `mcp.servers` have a `min_permission_tier` declared
6. `providers.compatible` is non-empty
7. `apply_permission` is present

A skill with missing or malformed fields is rejected. Errors are surfaced to the administrator with the specific field that failed.

### 5.4 First-party skills (architecture-mandated)

These skills are part of the product surface, not optional extras:

| Skill | Type | Role |
|-------|------|------|
| **dashboard** | Feature (or Utility + host UI) | **Governance interface for human calibration (ADR-3, REVIEW_META_PLAN).** Surfaces KPI trends, usage patterns, block and warning history, hansei reports, false-positive signals, and threshold change history to administrators and power users. **Implementation priority:** Stage 1 of the post-audit roadmap — ship alongside or immediately after audit log + Cato + broker are wired so humans can exercise judgment. |

Behavioral details belong in SPECS; this table fixes **presence and scope**.

### 5.5 Skill Lifecycle

```
Administrator applies skill
    │
    ▼
Orchestrator reads .intent.md, validates schema
    │ (fail) → Error surfaced to admin; skill not applied
    ▼ (pass)
Skill registered in installed skill set
Token Broker notified of new skill scope
Call Inspector endpoint list updated
MCP endpoint list updated
    │
    ▼
Next agent task spawned uses updated scope
```

Skill removal follows the inverse path. Removing a skill does not invalidate existing active tokens — they expire normally. New tokens do not include the removed skill's scope.

---

## 6. Memory Architecture

Memory is organized in three tiers with distinct access controls. Agents do not have direct write access to any tier above Tier 1. All cross-tier writes are mediated.

### 6.1 Tier 1 — Operational Memory (per-context, per-session)

*Storage:* `groups/{name}/CLAUDE.md` — flat markdown file on the host filesystem.
*Content:* Recent decisions, active task state, context-specific preferences, session continuity notes.
*Written by:* The orchestrator, **after Cato inline check approval** on the proposed memory mutation, following agent task completion. The agent produces memory update proposals in its output; the orchestrator applies them only on Cato allow (ADR-10).
*Read by:* Agent containers (bind-mounted read-write). Cato (read-only, for inline context on check requests).
*Lifetime:* Persists across sessions for the group. Cleared by explicit administrator action.
*Access control:* Each group's CLAUDE.md is visible only to that group's containers. Cross-group reads are prevented by the bind-mount model — no container receives mounts from another group's directory.

### 6.2 Tier 2 — Episodic Memory (per-context, structured)

*Storage:* SQLite database per group (`groups/{name}/messages.db`).
*Content:* Message history, task records, session logs, timing data.
*Written by:* Orchestrator only. Agents produce no direct writes to episodic storage.
*Read by:* Orchestrator (for context window construction before container spawn). Cato (read-only, for scheduled audits). Agents receive excerpts as injected context, not direct database access.
*Lifetime:* Persistent. A configurable rolling retention window can prune old records (administrator-configured; default: no pruning).
*Access control:* Per-group isolation by separate database files. No container has the database file in its mount set.

### 6.3 Tier 3 — Strategic Memory (cross-context, semantic graph)

*Storage:* Single SQLite database with vector extension (sqlite-vec), at `data/memory.db`.
*Content:* Cross-context semantic embeddings, observed behavioral patterns, long-term entity relationships, anomaly history.
*Written by:* Orchestrator, after explicit Call Inspector approval, based on agent-proposed observations. No agent writes directly. No spontaneous writes — every entry requires an approved write path.
*Read by:* Cato (read-only; primary reader for scheduled audits). Orchestrator (read-only; for context enrichment before high-stakes tasks). Agents: none — agents do not query the graph directly.
*Lifetime:* Persistent. Entries are not pruned by default. A skill can provide Tier 3 pruning behavior, but it requires administrator application.
*Access control:* The semantic graph database is not bind-mounted into any container. Access from Tier 3 to agents is always mediated by the orchestrator injecting relevant excerpts as context.
*Optional export:* A skill may provide Obsidian vault sync, exporting Tier 3 data as markdown notes. Read-only by default. Bidirectional sync is a separate, higher-privilege skill requiring admin permission.

### 6.4 Access Control Matrix

| Component | Tier 1 | Tier 2 | Tier 3 |
|-----------|--------|--------|--------|
| Agent container | Read-write (via bind mount) | None | None |
| Orchestrator | Read-write | Read-write | Read-write (mediated) |
| Cato | Read (for audit context) | Read (for scheduled audits) | Read (primary reader) |
| Token Broker | None | None | None |
| Channel adapters | None | None | None |
| Administrator | Read-write (direct filesystem) | Read (via health/CLI) | Read (via health/CLI) |

"Mediated" for Tier 3 orchestrator writes means: every proposed write passes through the Call Inspector before the orchestrator commits it. Rejected writes are logged; the agent receives an error signal.

---

## 7. Architectural Decisions

These are the decisions where the design space had real alternatives. Each records the choice, the reason, and what the choice implies.

### ADR-1: Cato Is Infrastructure, Not Persona

**Choice:** Cato has no conversational character, cannot be addressed by users or agents, and communicates through a binary allow/block protocol only. Alef translates Cato's decisions into user-readable explanations.

**Why not a single agent that both communicates and enforces:** A conversational safety agent can be worn down through interaction. Its character can be influenced. Character-based protection is probabilistic. An infrastructure-level gate is not. Keeping them separate preserves both: a trustworthy character-driven assistant (Alef) and an unconditional enforcement layer (Cato) whose floor does not move regardless of what Alef's character becomes.

**Implies:** The user-visible **blocked marker** (default `[BLOCKED]`) belongs to Alef's voice, not Cato's protocol; the string is configurable per group and may be empty if the user finds bracketed tags noisy (§3.5). **The explanation text remains mandatory** (ADR-4). Cato's output is a JSON object. Alef decides how to explain it, in the user's language, at whatever assertiveness level applies. Cato never addresses the user. A user who experiences Cato's blocks always receives an educational explanation of the risk class; they may omit only the decorative marker prefix.

---

### ADR-2: Neurosymbolic Cato — Symbolic Gates Neural

**Choice:** Cato's inline check runs deterministic symbolic rules first. The LLM escalation path is only available for cases where symbolic checks are inconclusive, and it operates only within criteria enumerated in PSYCHE.md.

**Why not pure symbolic:** Rules cannot cover all attack surfaces. Novel injection patterns, semantic social engineering, and language-switching evasion are not reliably detected by pattern matching. The system would have hard edges that become well-known exploits.

**Why not pure LLM judgment:** An LLM evaluating its own outputs can be prompted to rationalize any action. An unconstrained LLM as a safety gate is not trustworthy. It can be jailbroken; it is probabilistic; it makes the safety guarantee non-auditable.

**Why neurosymbolic:** The symbolic layer handles high-confidence cases without touching the LLM — faster, deterministic, auditable. The LLM handles ambiguity but only within a closed list of questions that PSYCHE.md defines. The LLM cannot expand its own mandate. Its outputs are binary (allow/block for a specific question), not free-ranging. This combination is auditable AND handles novelty.

**Implies:** PSYCHE.md must enumerate the exact questions the LLM may be asked. If a new attack surface is discovered, it enters as either a new symbolic rule or a new enumerated LLM question — not as an open-ended "ask the LLM to figure it out."

---

### ADR-3: No Auto-Recalibration

**Choice:** Cato does not adjust its own thresholds based on dao_score KPIs. KPIs are diagnostic signals surfaced to the administrator. Threshold changes require a deliberate administrator decision.

**Why:** A system that optimizes against its own safety metrics will drift toward proxy optimization. If block rate is a KPI, the system may learn to block less to improve the metric. If compliance rate is a KPI, it may learn to allow more to reduce friction. The only reliable calibration signal comes from outside the loop: user false-positive reports, actual incident outcomes, administrator judgment. The dashboard skill is the mechanism by which that external signal is available to the administrator.

**Implies:** The hansei report must surface enough information for a human to make calibration decisions: what was blocked, why, whether the block was appropriate, whether thresholds appear too tight or too loose. Threshold changes are committed to PSYCHE.md as code changes (requiring a deploy), not toggled at runtime.

---

### ADR-4: Every Block Is Explained

**Choice:** Every Cato or Call Inspector **block** communicated to the user must include a user-readable explanation in the user's language (default marker `[BLOCKED]`, configurable display string per §3.5). Silent protection was a prior design error.

**Why:** The safety layer is educational, not just operational. A user who never understands why something was blocked cannot develop risk literacy. They will route around the system ("I'll just do it in a different way") instead of understanding the risk. Explained protection builds trust; silent protection builds resentment and workarounds. This is not a UX choice — it is the mechanism by which OpenGolem's safety model propagates to human behavior.

**Constraint:** The explanation names the risk class; it does not reproduce the payload. Payload reproduction would create an injection surface from the blocked content into Alef's context window. Cato's `reason` field is also constrained the same way — it is free text about risk class, not evidence.

---

### ADR-5: Derivative Token Delegation Ceiling

**Choice:** When an agent spawns a subagent, the Token Broker enforces that the subagent's token is a strict subset of the parent's token scope. No spawning container can delegate more than it was granted.

**Why:** Without this rule, privilege escalation is possible through the delegation chain. A container with restricted scope requests the orchestrator to spawn a subagent; the orchestrator issues a fresh token to the subagent from the broker. If the broker does not check the parent's ceiling, the subagent could receive broader scope than the parent. A chain of such delegations could reach administrator scope from an unprivileged task.

**Implies:** The Token Broker must know, for every token it issues to a subagent, what the parent token's scope was. This requires the orchestrator to pass the parent token ID to the broker when requesting a subagent token. The broker validates the requested subagent scope against the parent ceiling before issuing.

---

### ADR-6: Channel Adapters Share the Orchestrator's Trust Domain

**Choice:** Channel adapters run in-process with the orchestrator. They are not separate processes with a defined IPC boundary.

**Why not out-of-process:** Channel adapters (Grammy for Telegram, Baileys for WhatsApp) are high-churn, event-driven, SDK-heavy code. Running them out-of-process would require a serialization protocol for messages — adding complexity with no proportional security benefit, because a compromised adapter would have orchestrator-level access whether in-process or over a socket. The threat model difference between "in-process compromised adapter" and "out-of-process compromised adapter with a localhost socket" is minimal.

**Accepted risk:** A compromised channel adapter has orchestrator-level access. This is accepted because adapters are applied as Skills (audited, administrator-authorized surface area). A malicious skill that compromises the orchestrator would be a supply chain attack on the administrator's machine — a threat outside OpenGolem's security boundary (the canonical repository is the source of truth).

**Implies:** Skill application (adding a channel) requires administrator authorization. The `.intent.md` schema for channel skills must declare what code runs in-process. Channel adapters must not import from outside their declared dependency set.

---

### ADR-7: Provider Routing and Credential Storage Are Separate Concerns

**Choice:** Which LLM provider to call is configured per group (or system-wide default). Which credential to use for that provider is resolved by the Token Broker from its credential backend. These are independent concerns with independent configuration surfaces.

**Why:** Conflating them ties the credential architecture to the provider selection. A user who wants to switch from Anthropic to Ollama (for privacy or cost reasons) should not have to reconfigure their credential backend. A user who wants to use the same Anthropic key for multiple groups should not have to declare it per-group. The separation also makes the security model cleaner: the broker always mediates credentials regardless of which provider is configured.

**Security consequence:** Provider identity must flow into the Call Inspector and Cato. A locally-hosted model (Ollama) bypasses upstream safety filters that cloud providers apply. The Call Inspector endpoint scope check must validate against the *configured* provider endpoint. Cato's PSYCHE.md should note that self-hosted deployments warrant elevated scrutiny because the Cato checks are the only safety filter.

**Implies:** The Token Broker's credential backend interface carries a `provider_type` field per credential entry. The container runner reads the group's provider config and sets the appropriate `ANTHROPIC_BASE_URL` (or equivalent) pointing at the credential proxy, regardless of which provider is behind it.

---

### ADR-8: Language-Switching Is a Potential Evasion Vector

**Choice:** Cato's symbolic checks are byte-level and script-agnostic. The LLM escalation path (Phase 2) explicitly treats unexpected language-switching as a signal requiring elevated scrutiny, not as a context that lowers scrutiny.

**Why:** A naive pattern-matching system that is tuned on English payloads will fail to detect injection attempts in Japanese, Arabic, or mixed-script payloads. Language-switching mid-conversation is a known technique for probing safety system boundaries. The system serves users who legitimately switch languages — this is expected and supported. Alef responds in the user's language. But Cato must not interpret language-switching as a reason to apply looser checks.

**Implies:** Symbolic checks (path traversal patterns, size limits, regex signatures) do not parse language — they operate on bytes. For the LLM escalation path, the evaluation prompt must instruct the evaluator that language-switching is noted but does not affect the evaluation criteria. The `[FLAG]` and `[BLOCKED]` display tags are user-configurable per group to work in the user's language (so the visual signal lands) — but the canonical English forms are always used in the audit log.

---

### ADR-9: The Audit Log Is the Source of Truth for All Governance

**Choice:** dao_score, hansei reports, and all administrator-visible governance data are derived exclusively from the audit log. No agent self-report is used as a governance input.

**Why:** An agent can misreport its own behavior. It can claim it blocked something it did not block. It can claim high compliance while doing the opposite. The audit log is written by the enforcement components (orchestrator, broker, Cato) — not by the agents they constrain. Governance based on audit log data is governance based on what actually happened, not on what the agent claims happened.

**Implies:** The audit log write interface is the most critical security property in the system. It is append-only. Agent containers have no write path to it. The orchestrator and broker write to it — and their writes must be correct. A test suite verifying append-only semantics and write correctness is mandatory, not optional.

---

### ADR-10: Tier 1 Memory Writes Require Cato Inline Approval

**Choice:** Every proposed write to Tier 1 (`groups/{name}/CLAUDE.md`) is submitted to Cato’s inline check before the orchestrator commits it. The agent emits proposals; the orchestrator does not apply them on `allow: false`.

**Why not orchestrator-only mediation:** Without a Cato gate, persistent memory could absorb content that symbolic checks at API-call time never saw (e.g. exfiltrated or harmful state committed after a series of seemingly benign calls). Cato authority over what becomes **long-lived institutional memory** closes that gap: the oversight layer that can block actions also governs what the system **remembers**.

**Performance cost:** Adds one synchronous Cato round-trip per task completion that proposes memory updates. Accepted: task completion is already bounded; memory writes are infrequent relative to token traffic; latency is preferable to ungoverned persistence.

**Implies:** Cato’s inline `action` enumeration (§4.3) must include a memory-mutation action (e.g. `MEMORY_WRITE` or equivalent) with payload hash covering the proposed delta. SPECS defines the exact schema.

---

### ADR-11: Call Inspector Escalation Uses Orchestrator Relay (No Broker → Cato Socket)

**Choice:** TD-BROKER does not open a connection to TD-CATO. When the Call Inspector requires Cato judgment (inconclusive deterministic check, or policy-mandated escalation), the Token Broker issues a **synchronous JSON-RPC** `catoEscalate` to TD-ORCHESTRATOR, which performs the existing Cato inline request and returns the result.

**Why not broker → Cato directly:** The orchestrator is already the sole lifecycle owner that coordinates Cato checks with task state. A second broker-owned client duplicates correlation, complicates auditing (two callers), and blurs “who owns the gate trace for this task.” One Cato client preserves a single request semantics.

**Why not fail-open or fail-closed locally on inconclusive:** Guessing would violate ADR-2; blind hard-block would conflate Inspector scope with Cato’s judgment mandate.

**Implies:** The orchestrator exposes a **dedicated escalation listener** (Unix socket); the Token Broker connects as client to invoke `catoEscalate` (§4.2.2). The **architectural** invariant: **Cato sees one protocol and one schema; the orchestrator always intermediates broker-originated escalations** — TD-BROKER never opens a socket to TD-CATO.

---

*This document is the input to SPECS.md v1.0. SPECS.md v1.0 will translate this architecture into behavioral specifications for each component. The implementation audit follows: an Explore subagent walks `src/` against this document and produces a gap list (keep / shed / build). A **new** staged implementation roadmap replaces `docs/PLAN.md` v0.1 only after that audit; it treats the current codebase as v0.1 (starting point, not target), sequences parallel workstreams where permitted, and **does not** use retired “Phase 2 clean lab” framing.*

*Produced: 2026-04-05. Architect: this session. Review comments RC-1–RC-7 incorporated 2026-04-05.*

---

## Governance review closure

RC-1 through RC-7 from the 2026-04-05 architectural review are **resolved in this revision** (§2.2, §3.0–3.5, §4.2, §4.7, §5.4, §6.1, ADR-10, ADR-11). **Next:** run the implementation audit (`src/` vs this document), then author SPECS v1.0 and the replacement roadmap for `PLAN.md`.
