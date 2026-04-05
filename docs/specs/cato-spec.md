# Cato — Behavioral Specification

*Produced: 2026-04-05 | Spec Writer: Claude Code | Stream: B*
*Source: ARCHITECTURE.md §1.1, §3.4, §4.3, §4.3.1, §4.7, §4.8, ADR-1, ADR-2, ADR-3, ADR-4, ADR-9, ADR-10; DECISIONS.md Decision 10, 12, 14*

---

## Responsibilities

Cato is the oversight process. It is a long-lived host process with two operational modes — inline (synchronous, request-driven) and scheduled (asynchronous, interval-driven). It is infrastructure, not a persona.

**Inline check:** Cato receives check requests from the orchestrator before significant actions and returns a binary allow/block decision. The orchestrator blocks the action unconditionally on `allow: false` or on any failure to reach Cato. This path is synchronous and fail-closed.

**Scheduled audit:** Cato periodically reads the unified audit log, computes dao_score KPIs, identifies anomaly patterns, and produces a structured hansei report. Reports are delivered by atomic file creation in a well-known inbox directory. The orchestrator polls that directory independently.

**dao_score computation:** Cato derives three KPIs from audit log data and records them with each hansei report. KPIs are diagnostic signals; Cato does not act on them autonomously.

**What Cato does not do:**
- Communicate with users. Alef translates Cato's decisions; Cato never addresses any user or agent directly.
- Issue or hold credentials or tokens of any kind.
- Spawn, terminate, or interact with containers.
- Adjust its own thresholds based on KPI trends (ADR-3). Calibration is a human decision made via PSYCHE.md edits.
- Receive instructions from any user session, running agent, or agent token.
- Open client connections to the orchestrator — report delivery is filesystem-only; poll initiation is orchestrator-side.
- Read Tier 1 memory at inline check time beyond what the orchestrator supplies in the request payload hash (the orchestrator summarises context in `contextId`; Cato does not independently mount or read group filesystems).

---

## External Interface

### 2.1 Unix Socket — Inline Check Endpoint

Cato listens on a Unix socket (path is deployment configuration). The orchestrator is the only permitted client. The protocol is newline-delimited JSON — not JSON-RPC. Each line is one complete JSON object.

**Direction:** orchestrator → Cato (request), Cato → orchestrator (response). Each request produces exactly one response. Cato does not send unsolicited messages.

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

`contentExcerpt` is present (non-null) only for action types that require byte-level pattern inspection: `AGENT_PROMPT`, `OUTBOUND_API_CALL`, `MEMORY_WRITE`. It is `null` or omitted for `FILESYSTEM_WRITE` and `CREDENTIAL_REQUEST`. When present, it contains the first 4 KB of the payload base64-encoded (or the full payload if shorter than 4 KB). The orchestrator is responsible for providing the excerpt; Cato uses it for deterministic pattern checks. See Decision 17 for rationale.

`action` is a fixed enumeration. Valid values:

| Value | When used |
|-------|-----------|
| `AGENT_PROMPT` | Orchestrator is about to deliver a prompt to an agent container |
| `OUTBOUND_API_CALL` | Call Inspector has escalated an inconclusive check (via orchestrator relay, §4.2.2, ADR-11) |
| `FILESYSTEM_WRITE` | Orchestrator is about to write to a group filesystem path |
| `CREDENTIAL_REQUEST` | Orchestrator is requesting a token from the Token Broker on behalf of a container |
| `MEMORY_WRITE` | Orchestrator is about to apply a Tier 1 memory mutation proposed by an agent (ADR-10) |

Requests with any other `action` value are rejected with `allow: false` and `code: null` (unknown action is treated as an error, not a pass).

`payloadHash` is a SHA-256 hex digest of the content under review. `payloadSize` is the byte count of that same content. Cato does not receive raw payload content. Cato's `reason` field in responses must never reproduce payload content.

**Response schema — allow:**

```json
{
  "checkId": "<uuid>",
  "allow": true,
  "code": null,
  "reason": null
}
```

**Response schema — block:**

```json
{
  "checkId": "<uuid>",
  "allow": false,
  "code": "PATH_TRAVERSAL",
  "reason": "Prompt contains filesystem escape sequence"
}
```

`code` is drawn from the CatoRiskCode enumeration (§2.3 below). `reason` is free text naming the risk class — it does not reproduce payload content. Both `code` and `reason` are optional on allow decisions but must be present on block decisions where a known code applies. If no enumerated code applies and a block is required, `code` may be `null` and `reason` must describe the risk class.

The `checkId` in the response must match the `checkId` in the corresponding request exactly.

### 2.2 Hansei Report — Filesystem Delivery

Cato delivers scheduled audit results by writing files to an inbox directory on the host filesystem. The exact path is deployment configuration (e.g. `data/hansei/inbox/`). The orchestrator polls this directory independently.

**Write protocol:** Cato writes each report as an atomic file create using write-to-temp-then-rename. The filename encodes a timestamp and a report ID (format: `hansei-<ISO8601-compact>-<uuid>.json`). A report file, once created, is not modified.

**Report content schema:**

```json
{
  "reportId": "<uuid>",
  "generatedAt": "<ISO8601>",
  "periodStart": "<ISO8601>",
  "periodEnd": "<ISO8601>",
  "daoScore": {
    "security_failures_per_call": 0.012,
    "data_leaks_per_call": 0.003,
    "behavioral_change_rate": 0.74
  },
  "anomalyFindings": [
    {
      "findingId": "<uuid>",
      "severity": "high | medium | low | info",
      "riskClass": "<CatoRiskCode or free-text category>",
      "contextIds": ["<group-or-session-id>", "..."],
      "summary": "<free text — names risk class, does not reproduce payload>"
    }
  ],
  "recommendationFlags": [
    {
      "flag": "<flag-id>",
      "description": "<free text>"
    }
  ],
  "reportVersion": "1.0"
}
```

Reports are never auto-applied. They are surfaced to the administrator through the dashboard skill, health endpoint, or CLI. Cato has no mechanism to force the orchestrator to act on a report's findings.

**Report-ready signal:** After creating a report file, Cato appends a `hansei_report_ready` event to the unified audit log (see §2.4). The orchestrator may use audit log polling or inotify on the inbox directory as its detection mechanism — both are valid. The audit log event is always written regardless of which detection mechanism the orchestrator uses.

### 2.3 CatoRiskCode Enumeration

The following codes are the complete Phase 1 set. The set is intentionally open for extension via PSYCHE.md revision. Codes are never removed — deprecated codes remain valid in historical audit records.

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

### 2.4 Audit Log — Cato Write Events

Cato appends to the unified audit log (append-only SQLite) for the following events. All writes are INSERT only — no UPDATE or DELETE through any Cato write path.

| Event type | Written when | Required fields |
|-----------|--------------|-----------------|
| `cato_check` | Every inline check response, allow or block | `checkId`, `action`, `contextId`, `tokenId`, `payloadHash`, `payloadSize`, `allow`, `code` (nullable), timestamp |
| `cato_audit_start` | Scheduled audit run begins | `runId`, `periodStart`, `periodEnd`, timestamp |
| `cato_audit_complete` | Scheduled audit run completes | `runId`, `reportId`, timestamp |
| `hansei_report_ready` | Hansei report file written to inbox | `runId`, `reportId`, `reportPath` (path hash, not full path), timestamp |

The `reportPath` field stores a hash of the report file path, not the path itself, to avoid leaking deployment filesystem layout into the audit log.

---

## Behavioral Contract

### 3.1 Inline Check — Phase 1 (Deterministic)

On receiving a valid inline check request, Cato applies deterministic symbolic checks in order. The checks are byte-level and script-agnostic — they operate on bytes without language parsing.

**Phase 1 checks (applied to all action types where relevant):**

**Path traversal check (resolved — Decision 17):** If `contentExcerpt` is present and the decoded bytes contain `../` or `..\` sequences, return `allow: false, code: PATH_TRAVERSAL`.

**Oversized payload check:** If `payloadSize` exceeds the configured limit (default: 100 KB), return `allow: false, code: OVERSIZED_PAYLOAD`. This check does not require `contentExcerpt`.

**For action types without `contentExcerpt`** (`FILESYSTEM_WRITE`, `CREDENTIAL_REQUEST`): only the size check applies in Phase 1. If `payloadSize` is within limits, the result is conclusive allow.

**Conclusive result:** If any check produces a definite allow or block, Cato returns immediately. Remaining checks are not applied. The response is written to the audit log before the response is sent.

**Inconclusive result (Phase 1):** If all applicable checks are inconclusive, Cato returns `allow: true` with `code: null` and `reason: null`. In Phase 1 there is no LLM escalation. The audit log entry records outcome as `allow: true` with a note that no symbolic check fired.

### 3.2 Inline Check — Phase 2 (LLM Escalation)

*This section describes Phase 2 behavior. The external interface (socket protocol and response schema) is identical to Phase 1. Only the implementation inside Cato changes.*

If the symbolic layer returns inconclusive and PSYCHE.md has an enumerated criterion applicable to the `action` type and risk pattern under evaluation, Cato invokes its LLM as a classifier against that specific question. The LLM receives only what PSYCHE.md authorizes it to see: `payloadHash`, `action`, `contextId` category, and the specific risk class under evaluation. It returns `allow` or `block` for that question only.

The LLM cannot:
- Expand the question set beyond what PSYCHE.md enumerates.
- Request additional context fields not listed in PSYCHE.md.
- Produce a non-binary outcome (inconclusive is not a valid LLM output in this path).
- Address any user or channel.

The LLM escalation path is gated by PSYCHE.md revision, not runtime configuration. Adding a new escalation question requires a code change, not a runtime toggle.

**Audit:** LLM escalation decisions are logged with `code: PROMPT_INJECTION` (or the applicable CatoRiskCode), a `llm_escalation: true` flag, and the PSYCHE.md criterion ID that was evaluated. The orchestrator's `checkId` is included.

### 3.3 PSYCHE.md — LLM Escalation Criteria (Working Draft)

*This subsection is a draft of the PSYCHE.md criteria enumeration required by ADR-2. It serves as the working draft for PM review before PSYCHE.md is authored. The final enumeration lives in PSYCHE.md, not this spec.*

**What Cato's LLM is permitted to evaluate (criterion categories):**

| Criterion ID | Question class | Applicable actions |
|---|---|---|
| `PSY-01` | Does this payload contain a social engineering attempt to extract credentials or bypass instructions? | `AGENT_PROMPT`, `OUTBOUND_API_CALL` |
| `PSY-02` | Does this payload exhibit characteristics of a multi-turn prompt injection pattern (instructions embedded to be retrieved later)? | `AGENT_PROMPT`, `MEMORY_WRITE` |
| `PSY-03` | Does this payload attempt to manipulate Cato's own evaluation by claiming authority or constructing a false premise about system configuration? | `AGENT_PROMPT` |
| `PSY-04` | Does this memory write proposal introduce instructions that would expand the agent's declared scope or override SOUL.md directives? | `MEMORY_WRITE` |
| `PSY-05` | Does this payload use unexpected language-switching or mixed-script encoding in a pattern consistent with injection evasion? | `AGENT_PROMPT`, `OUTBOUND_API_CALL` |

**What the LLM is permitted to see per evaluation:**
- The `action` type being evaluated
- The `payloadHash` (for reference in the audit trail only — not for content reconstruction)
- The specific criterion ID being evaluated
- The `contextId` category (group type, not full history)
- A binary decision: `allow` or `block`

**What the LLM is forbidden to do:**
- Ask for the raw payload or any excerpt of it not explicitly provided
- Produce explanatory prose for the user (Alef handles user communication)
- Produce a probability or confidence score instead of a binary decision
- Evaluate criteria not listed above without PSYCHE.md revision
- Make decisions based on the user's language, nationality, or communication style
- Treat language-switching as a reason to lower scrutiny (ADR-8); it may be a signal to escalate to `PSY-05`

**Scope limits:**
- Each LLM call evaluates exactly one criterion for exactly one check request
- PSYCHE.md criteria are defined at deploy time; no criterion is injected or modified at runtime
- The LLM model and prompt template are part of the Cato deployment — not configurable by users or operators without a deploy cycle

**Out-of-scope — Cato may not ask:**
- Whether an action is useful or efficient for the user
- Whether an action aligns with the user's stated preferences
- Any question about the user's identity, location, or intent beyond the payload under evaluation
- Any question whose answer would vary based on which user sent the message

### 3.4 Scheduled Audit

Cato runs a scheduled audit at a configured interval (default interval: TBD — architect to resolve; must be configurable without a code change, expressed in deployment configuration). The audit covers the period since the previous audit's `periodEnd`, or a configured lookback window for the first run.

**Audit procedure:**

1. Cato appends `cato_audit_start` to the unified audit log (records `runId`, `periodStart`, `periodEnd`, timestamp).
2. Cato reads the unified audit log (read-only, direct SQLite access).
3. Cato computes dao_score KPIs for the covered period.
4. Cato identifies anomaly patterns from `cato_check` block events, call rate deviations, credential access patterns, and behavioral_change_rate signals.
5. Cato produces a hansei report JSON object.
6. Cato writes the report to the hansei inbox directory using atomic file create (write-to-temp-then-rename).
7. Cato appends `cato_audit_complete` and `hansei_report_ready` events to the unified audit log.

**If the audit log is unavailable:** The scheduled audit run is skipped. Cato logs a `cato_audit_error` event when the log becomes available again, recording the skipped period.

**If the inbox directory is unavailable:** The audit computation completes but the report cannot be written. Cato retries the report write up to a configurable limit. After exhausting retries, Cato logs `cato_audit_error` with the reason. The orchestrator does not receive a report for that period.

**Inline hook availability during audit:** A scheduled audit run does not block or delay inline check responses. The two operational modes are independent.

### 3.5 dao_score KPIs

Cato computes three KPIs from audit log data for each scheduled audit period. KPI definitions must match those in PSYCHE.md exactly (a build-time check enforces this in Phase 2).

| KPI name | Formula | Measures |
|---|---|---|
| `security_failures_per_call` | (hard_blocks + soft_blocks) / total proxied calls in period | Security posture — rate of suspicious call blocking |
| `data_leaks_per_call` | `MEMORY_SCOPE_VIOLATION` blocks / total proxied calls in period | Safety posture — rate of out-of-scope memory access attempts |
| `behavioral_change_rate` | distinct `code` values that did not re-fire within 10 subsequent calls from the same `contextId` / total distinct `code` values fired in period | Reflection — whether agents adjust after being blocked |

KPIs are diagnostic. Cato does not recalibrate thresholds, enable or disable checks, or alter its own behavior based on KPI values (ADR-3). KPI trends are surfaced in hansei reports for administrator review.

### 3.6 Fail-Closed on All Error Paths

If the Cato socket is unreachable, the orchestrator must block the action. This is not Cato's behavior to specify — it is the orchestrator's obligation (§4.3, ARCHITECTURE.md). Cato's obligation is symmetric:

- If Cato receives a malformed request (missing required fields, unknown `action` value, invalid `checkId` format), it responds `allow: false` with `code: null` and `reason: "malformed request"`. It does not drop the connection or leave the request unanswered.
- If Cato's audit log write fails during an inline check, Cato suspends the response until the write succeeds or a retry limit is reached. After exhausting retries, Cato returns `allow: false` (fail-closed) and records the failure in a local failure log (separate from the unified audit log). A call that cannot be audited is not allowed to proceed. The orchestrator receives `allow: false` with `code: null` and `reason: 'audit_write_failed'`.
- If Cato's internal state is inconsistent on startup (e.g. previous audit run did not complete), Cato completes startup as normal, logs the inconsistency to the audit log, and begins accepting inline checks. The next scheduled audit run covers the gap.

---

## Failure Modes

| Failure | Cato's observable behavior |
|---------|--------------------------|
| Orchestrator sends a request with an unrecognized `action` | `allow: false`, `code: null`, `reason: "malformed request"`, audit log entry |
| Orchestrator sends a request with a missing required field | `allow: false`, `code: null`, `reason: "malformed request"`, audit log entry |
| `payloadSize` alone exceeds 100 KB | `allow: false`, `code: "OVERSIZED_PAYLOAD"`, audit log entry |
| Cato socket receives a non-JSON line | Connection remains open; the malformed line is discarded; no response sent for that line (the orchestrator's `checkId` is unknown). Cato logs a socket protocol error to the audit log. |
| Audit log unavailable at inline check time | Cato suspends the inline response and retries the audit log write up to a configurable retry limit. If all retries fail, Cato returns `allow: false, code: null, reason: 'audit_write_failed'` to the orchestrator. The call is not allowed to proceed without an audit record. |
| Audit log unavailable at scheduled audit time | Audit run is skipped; `cato_audit_error` is appended when log becomes available |
| Hansei inbox directory unavailable | Report write is retried up to the configured retry limit; after exhaustion, `cato_audit_error` is logged; no report is delivered for that period |
| Phase 2 LLM call times out or errors | `allow: false` (fail-closed on LLM failure), `code: null` if no deterministic code applies, `reason: "llm_escalation_failed"`, audit log entry with `llm_escalation: true` |
| Cato process crashes | The orchestrator detects socket unavailability and blocks all subsequent actions until the socket is restored (this is orchestrator behavior, not Cato behavior). On restart, Cato resumes accepting inline checks from a clean state. |

---

## Invariants

These properties hold at all times, across both operational modes:

1. **Fail-closed on malformed input.** Any request that cannot be fully validated (missing fields, unknown action, invalid encoding) results in `allow: false`. Cato never allows by default on ambiguous input.

2. **Response always echoes checkId.** Every response contains the exact `checkId` from the corresponding request. No `checkId` is reused or truncated.

3. **Audit log is written before response is sent.** The `cato_check` audit entry for an inline decision is committed to the audit log before the response is returned to the orchestrator. If the audit write fails and cannot be retried before the response timeout, see Failure Modes above.

4. **Cato never opens a client connection to the orchestrator.** All hansei delivery is via filesystem. All audit log access is direct SQLite reads and writes. There is no Cato-initiated socket call to any other process (§2.2, ADR-11, §2.2 Permitted Communication Paths).

5. **Cato never addresses a user.** No Cato output reaches a user session, channel adapter, or agent container. The only outputs are inline check responses (to the orchestrator's socket client), audit log entries, and hansei report files.

6. **Payload content is not reproduced.** Neither `reason` fields in inline responses nor `summary` fields in hansei report findings reproduce any portion of payload content. Findings describe risk classes, not evidence.

7. **Audit writes are INSERT-only.** No UPDATE or DELETE statement is issued against the unified audit log through any Cato code path, for any reason.

8. **Scheduled audit does not block inline checks.** An in-progress audit run does not delay or queue inline check responses. The two modes are independent.

9. **CatoRiskCode values are stable identifiers.** Once a code is defined in this spec or in PSYCHE.md, it is never removed. Deprecated codes remain valid in historical audit records and in the response schema.

10. **Thresholds are not self-adjusted.** Cato does not modify PSYCHE.md, threshold configuration, or its own check logic at runtime based on KPI values or observed patterns. Any change to thresholds requires a deploy cycle (ADR-3).

---

## Acceptance Criteria

Each criterion is binary and testable from outside Cato (via its Unix socket and the resulting audit log and filesystem state).

**AC-1: Inline socket is available before orchestrator starts.**
Given the startup sequence is followed, Cato's Unix socket is accepting connections before the orchestrator completes its boot health check. Verified by: orchestrator health check returns healthy without retry.

**AC-2: Valid allow response.**
Given a well-formed inline check request with `action: AGENT_PROMPT` and `payloadSize` below the limit, Cato returns `{"checkId": "<same-uuid>", "allow": true, "code": null, "reason": null}` within a measurable timeout (TBD — architect to set; must be short enough not to meaningfully degrade task latency under normal load). Verified by: response field values.

**AC-3: Block on OVERSIZED_PAYLOAD.**
Given a request with `payloadSize` exceeding 100 KB (or the configured limit), Cato returns `allow: false` and `code: "OVERSIZED_PAYLOAD"`. Verified by: response field values.

**AC-4: checkId is echoed exactly.**
Given any valid or invalid request, the `checkId` in the response matches the `checkId` in the request byte-for-byte. Verified by: string comparison.

**AC-5: Malformed request returns fail-closed.**
Given a request with a missing required field (e.g. no `action`), Cato returns `allow: false`. Verified by: response field value.

**AC-6: Unknown action returns fail-closed.**
Given a request with `action: "UNKNOWN_VALUE"`, Cato returns `allow: false`. Verified by: response field value.

**AC-7: Every inline check is audited.**
Given any inline check — allow or block — a `cato_check` row is present in the unified audit log with matching `checkId`, `action`, `contextId`, `tokenId`, `payloadHash`, `allow`, and `code` fields. Verified by: direct SQLite query on audit log after the check.

**AC-8: Audit log write precedes response.**
Given an inline check where the audit log is instrumented to record write order, the audit log INSERT timestamp precedes the socket response timestamp. Verified by: instrumented test harness measuring write order.

**AC-9: Hansei report is written atomically.**
Given a scheduled audit run completes, a file matching the naming pattern `hansei-<timestamp>-<uuid>.json` exists in the inbox directory. The file content is valid JSON matching the report schema. No partial file is present (write-to-temp-then-rename is confirmed by absence of temp files after completion). Verified by: filesystem inspection after audit run.

**AC-10: Hansei report-ready event is audited.**
Given a hansei report is written, a `hansei_report_ready` event is present in the unified audit log with matching `reportId` and a `reportPath` field containing a non-empty value (hash, not the raw path). Verified by: SQLite query on audit log.

**AC-11: dao_score KPI names match enumeration.**
Given a completed hansei report, the `daoScore` object contains exactly the three keys `security_failures_per_call`, `data_leaks_per_call`, and `behavioral_change_rate`, and no others. Verified by: JSON schema validation of report file.

**AC-12: Scheduled audit does not delay inline checks.**
Given a scheduled audit is in progress and an inline check request arrives, the inline check response is returned within the normal latency bound (same as AC-2). Verified by: concurrent test — audit run started, then inline check issued; response latency measured.

**AC-13: Cato does not initiate network or socket connections.**
Given normal operation, no outbound socket connection is initiated by the Cato process to any address. Verified by: network trace or strace during a complete audit cycle.

**AC-14: No audit log UPDATE or DELETE.**
Given any sequence of Cato operations (inline checks and scheduled audits), the unified audit log contains no UPDATE or DELETE statements in its write-ahead log and no rows are modified or deleted. Verified by: SQLite WAL inspection and row-count monotonicity check before and after each operation.

**AC-15: Phase 2 — LLM escalation path fails closed.**
Given Phase 2 is implemented and the LLM call returns an error or timeout, Cato returns `allow: false`. Verified by: stubbed LLM that returns an error; response field value.

**AC-16: Phase 2 — LLM is given only authorized fields.**
Given Phase 2 is implemented and an LLM escalation is triggered, the call payload to the LLM contains only the fields authorized by the applicable PSYCHE.md criterion (no raw content, no user identity, no session history). Verified by: LLM call capture in an instrumented test harness.

**AC-17: CatoRiskCode values in responses are drawn from the enumeration.**
Given any block response from Cato, the `code` field value is either null or a member of the defined CatoRiskCode enumeration. Verified by: enumeration membership check on response field.
