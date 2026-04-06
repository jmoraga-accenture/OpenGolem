# Token Broker + Call Inspector — Behavioral Specification

*Produced: 2026-04-05 | Spec Writer: Claude Code | Input: ARCHITECTURE.md v1.0, DECISIONS.md, IMPLEMENTATION_AUDIT.md*

The Token Broker is one of three long-lived host processes. It is the sole keeper of long-lived credentials. The Call Inspector is a logical component within the Token Broker — not a separate process — that enforces five deterministic checks on every proxied outbound call before it is forwarded to an external provider.

---

## Responsibilities

### Token Broker

- Resolves long-lived secrets from the configured credential backend (`.env`/file, Bitwarden, or OneCLI). Exactly one backend is active per deployment, selected by the `OPENGOLEM_CREDENTIAL_BACKEND` configuration value. Multiple simultaneous backends are not supported.
- Issues signed, opaque derivative tokens encoding: skill whitelist, TTL, call budget, permitted data scopes, originating container ID, and `securityMode` claim. Token internal structure is HMAC-SHA256 JWT (Phase 1). The format is opaque to all callers — no caller other than the Token Broker parses or validates token claims.
- Maintains an in-memory token store. Token state (valid, expired, revoked) is tracked per `tokenId`. The store does not persist across process restarts — tokens issued before a restart are invalid after restart.
- Validates derivative tokens on every inbound proxy request: checks expiry, revocation status, and call budget consumption.
- Revokes tokens on explicit request from the orchestrator, at TTL expiry, or when call budget is exhausted. Revocation is immediate and irreversible within a process lifetime.
- Proxies outbound LLM API calls: validates the derivative token, runs the Call Inspector, injects the real credential at last hop, and forwards to the provider. The container never receives the real credential or the real provider URL.
- Tracks call budget consumption per token. When a token's call budget is exhausted, subsequent proxied calls receive HTTP 403 and the token is revoked.
- Writes append-only audit log entries for: token issuance (tokenId, contextId, skillSet, securityMode, TTL — not the token value), token revocation (tokenId, reason), every proxied call (pass, fail, soft-block, escalation — with tokenId, endpoint category, call budget consumed, outcome code).
- Enforces the delegation ceiling rule (ADR-5): when issuing a token for a subagent, the Token Broker validates that the requested skill set, data scopes, call budget, and security mode are strict subsets of the parent token's claims. A subagent token request that exceeds any parent ceiling is rejected without issuance.

### Call Inspector

- Runs five deterministic checks in order on every proxied call before forwarding. All five run in the same process and in the same synchronous pass; there is no deferred or async inspection path.
- Reads `securityMode` from the validated derivative token on every call to determine enforcement posture.
- Writes an audit log entry for every proxied call regardless of outcome.
- When a check returns inconclusive and policy requires judgment, invokes Cato via the orchestrator escalation relay (`catoEscalate` — §4.2.2 of ARCHITECTURE.md, ADR-11). The Call Inspector does not guess, does not fail-open, and does not connect directly to Cato.
- Does not perform LLM-based analysis of payload content. It is a linter, not a reasoner.

---

## External Interface

### 4.2.1 Orchestrator → Token Broker (Token Lifecycle Socket)

**Protocol:** Unix socket (broker listens). Newline-delimited JSON-RPC 2.0.  
**Direction:** Orchestrator initiates; broker responds.  
**Socket path:** `data/sockets/broker.sock` (overridable via `BROKER_SOCKET_PATH` env var — Decision 15).

#### `issueToken`

```json
{
  "jsonrpc": "2.0",
  "method": "issueToken",
  "params": {
    "contextId": "<group-or-session-id>",
    "skillSet": ["<skill-id>", "..."],
    "ttl": 300,
    "callBudget": 50,
    "dataScopes": ["<scope-id>", "..."],
    "securityMode": "golem_guard | supervised | power",
    "parentTokenId": "<token-id> | null"
  },
  "id": 1
}
```

`parentTokenId` is required when requesting a subagent token; it is `null` for top-level task tokens. When non-null, the broker validates the delegation ceiling before issuing.

**Success response:**
```json
{
  "jsonrpc": "2.0",
  "result": {
    "token": "<opaque-bearer-token>",
    "tokenId": "<uuid>",
    "expiresAt": "<ISO-8601-timestamp>"
  },
  "id": 1
}
```

**Error response (delegation ceiling exceeded, unknown parent, invalid params):**
```json
{
  "jsonrpc": "2.0",
  "error": {
    "code": -32600,
    "message": "<reason>",
    "data": { "field": "<field-name>" }
  },
  "id": 1
}
```

Valid `securityMode` values: `golem_guard`, `supervised`, `power`. Any other value is rejected with a JSON-RPC error.

#### `revokeToken`

```json
{
  "jsonrpc": "2.0",
  "method": "revokeToken",
  "params": { "tokenId": "<uuid>" },
  "id": 2
}
```

**Response:**
```json
{
  "jsonrpc": "2.0",
  "result": { "revoked": true },
  "id": 2
}
```

Revoking an already-revoked or expired token returns `{ "revoked": true }` without error.

#### `health`

```json
{
  "jsonrpc": "2.0",
  "method": "health",
  "params": {},
  "id": 3
}
```

**Response:**
```json
{
  "jsonrpc": "2.0",
  "result": { "status": "ok" },
  "id": 3
}
```

The `health` method is available from the moment the broker's Unix socket is bound. It returns `ok` when the credential backend is reachable and the token store is operational. If the credential backend is unreachable, the response is:
```json
{
  "jsonrpc": "2.0",
  "result": { "status": "degraded", "reason": "credential_backend_unreachable" },
  "id": 3
}
```

A `degraded` broker does not issue new tokens. Existing valid tokens continue to be validated and proxied.

### 4.2.2 Token Broker → Orchestrator (Call Inspector Escalation Socket)

**Protocol:** Unix socket (orchestrator listens; broker connects per escalation or holds a pooled connection). Newline-delimited JSON-RPC 2.0.  
**Direction:** Broker initiates; orchestrator responds after forwarding to Cato.  
**Socket path:** `data/sockets/escalation.sock` (overridable via `ESCALATION_SOCKET_PATH` env var — Decision 15).

#### `catoEscalate`

```json
{
  "jsonrpc": "2.0",
  "method": "catoEscalate",
  "params": {
    "checkId": "<uuid>",
    "action": "OUTBOUND_API_CALL",
    "contextId": "<group-or-session-id>",
    "tokenId": "<uuid>",
    "payloadHash": "<sha256-hex>",
    "payloadSize": 42000,
    "contentExcerpt": "<base64-encoded-bytes | null>",
    "escalationReason": "INSPECTOR_INCONCLUSIVE",
    "inspectorCheck": "PROMPT_INJECTION"
  },
  "id": 4
}
```

`inspectorCheck` names which of the five Call Inspector checks produced the inconclusive result. Valid values: `SKILL_WHITELIST`, `MEMORY_SCOPE`, `PROMPT_INJECTION`, `CALL_RATE`, `ENDPOINT_SCOPE`.

`escalationReason` is always `INSPECTOR_INCONCLUSIVE` in v1.0. Additional escalation reasons may be defined in future revisions.

`contentExcerpt` is the first 4 KB of the inspected payload, base64-encoded (or the full payload if shorter). The broker holds the payload at inspection time and is responsible for including this field. The Orchestrator passes it through to Cato unchanged. See Decision 23.

**Response** (mirrors Cato inline response semantics):
```json
{
  "jsonrpc": "2.0",
  "result": {
    "allow": false,
    "code": "PROMPT_INJECTION",
    "reason": "<risk-class description; does not reproduce payload content>"
  },
  "id": 4
}
```

`code` is drawn from the CatoRiskCode enumeration (ARCHITECTURE.md §4.3.1). `reason` is optional on allow. Both `code` and `reason` are optional on allow decisions; they are expected on block decisions.

### 4.5 Container → Credential Proxy (LLM and MCP Calls)

**Protocol:** HTTP to the URL injected as `ANTHROPIC_BASE_URL` at container spawn.  
**Direction:** Outbound (container initiates).  
**Authentication:** The container sends its derivative token as the HTTP `Authorization: Bearer <token>` header.

On every inbound HTTP request from a container, the proxy:
1. Validates the derivative token (signature, expiry, revocation status, call budget).
2. Runs the five Call Inspector checks in order.
3. On pass: decrements call budget, replaces the `Authorization` header with the real provider credential, forwards to the actual provider endpoint.
4. On fail (hard block): returns HTTP 403 with a structured error body; logs the blocked call.
5. On soft block (`supervised` mode): issues `catoEscalate` to the orchestrator and waits synchronously for a decision before proceeding.

**HTTP 403 error body (on block):**
```json
{
  "error": {
    "type": "call_blocked",
    "code": "<CatoRiskCode>",
    "message": "<risk-class description>"
  }
}
```

The container sees the HTTP 403 and code; it never sees the blocked payload content echoed back.

### 4.6 Credential Proxy → External Provider

**Protocol:** HTTPS to the configured provider endpoint.  
**Direction:** Outbound (proxy initiates).

**Valid `provider_type` values for v1.0:**

| `provider_type` | Description | Credential requirement |
|-----------------|-------------|------------------------|
| `anthropic` | Anthropic API (primary). HTTPS to `api.anthropic.com` or a configured enterprise endpoint. | Bearer token or API key from the active credential backend. |
| `ollama` | Local self-hosted Ollama instance. HTTP (not HTTPS) to a configured local endpoint. | No credential — the proxy forwards without injecting an `Authorization` header. |
| `custom` | User-defined provider with a user-defined base URL. | Credential entry from the active backend keyed to this provider type; may be empty if the endpoint requires no auth. |

`openrouter` and all other provider types are not valid in v1.0. A token issued with an endpoint scope referencing an unsupported provider type is rejected at issuance time.

The proxy logs endpoint base URL (not path), response status code, and call latency. Payload content is never logged.

---

## Behavioral Contract

### Token Issuance

**Given:** Orchestrator calls `issueToken` with valid params and `parentTokenId: null`.  
**Must:** Issue a token whose claims encode exactly the requested `skillSet`, `ttl`, `callBudget`, `dataScopes`, and `securityMode`. Return `token`, `tokenId`, and `expiresAt`. Log the issuance event (tokenId, contextId, skillSet, securityMode, TTL — not the token value).

**Given:** Orchestrator calls `issueToken` with `parentTokenId` set to a valid, non-revoked parent token.  
**Must:** Validate that the requested `skillSet` is a subset of the parent's `skillSet`, `dataScopes` is a subset of the parent's `dataScopes`, `callBudget` does not exceed the parent's remaining call budget, and `securityMode` is not more permissive than the parent's (ordering: `golem_guard` < `supervised` < `power`; the subagent may not receive a more permissive mode than its parent). Issue the token if all checks pass. Reject with a JSON-RPC error if any check fails.

**Given:** Orchestrator calls `issueToken` with an unknown or revoked `parentTokenId`.  
**Must:** Reject with a JSON-RPC error. No token is issued.

**Given:** `securityMode` is not one of `golem_guard`, `supervised`, `power`.  
**Must:** Reject with a JSON-RPC error. No token is issued.

**Given:** `issueToken` is called when the token store is at capacity (`TOKEN_STORE_MAX_CAPACITY` tokens exist and none have expired).
**Must:** Reject with JSON-RPC error `{ code: -32603, message: 'token_store_full' }`. No token is issued. Write an alert-level audit log entry if this is the first store-full rejection in the current 60-second window. (Decision 16)

**Given:** Credential backend is unreachable at token issuance time.  
**Must:** Reject the request with a JSON-RPC error. Health status transitions to `degraded`. Existing valid tokens continue to be validated.

### Token Revocation

**Given:** Orchestrator calls `revokeToken` with a valid `tokenId`.  
**Must:** Immediately mark the token as revoked in the in-memory store. Subsequent proxy calls bearing this token receive HTTP 403. Log the revocation event (tokenId, reason: `explicit_revoke`).

**Given:** A token's TTL expires.  
**Must:** The broker treats the token as revoked on its next validation. The token is not pre-emptively removed from the store; it is checked at use time. Log the revocation event (tokenId, reason: `ttl_expired`) at first validation after expiry.

**Given:** A proxied call exhausts a token's call budget (call budget reaches zero).  
**Must:** The call that causes budget exhaustion is still forwarded (if the Inspector approves). Immediately after forwarding, the token is marked revoked. Subsequent calls with this token receive HTTP 403. Log revocation (tokenId, reason: `budget_exhausted`).

### Call Inspector — Five Checks (in order)

**Check 1 — Skill whitelist:**  
**Given:** A proxied call targets an endpoint or invokes a skill not declared in the token's `skillSet`.  
**Must:** Hard block in all security modes. Return HTTP 403 with `code: OUT_OF_SCOPE_ENDPOINT`. Log the blocked call.

**Check 2 — Memory scope:**  
**Given:** A proxied call's payload references a memory partition not permitted by the token's `dataScopes`.  
**Must:** Hard block in all security modes. Return HTTP 403 with `code: MEMORY_SCOPE_VIOLATION`. Log the blocked call.

**Check 3 — Prompt injection signatures:**  
**Given:** A proxied call's payload matches a high-confidence prompt injection pattern from the maintained signature set.  
**Must:**  
- `golem_guard`: hard block. HTTP 403, `code: PROMPT_INJECTION`.  
- `supervised`: soft block — issue `catoEscalate` to orchestrator; wait synchronously for decision; block if Cato returns `allow: false`; forward if `allow: true`. Log escalation and outcome.  
- `power`: hard block only if the signature is classified as high-confidence in POWER mode per the signature set; otherwise the check is advisory (logged but does not block).  
**Given:** The check returns inconclusive (neither match nor clear pass) and mode requires judgment:  
**Must:** Issue `catoEscalate` to the orchestrator escalation relay. Do not guess. Do not hard-block locally without Cato's decision. Block if Cato returns `allow: false`.

**Check 4 — Call rate:**  
**Given:** Call rate for this token exceeds the anomaly threshold relative to the declared task profile.  
**Must:**  
- `golem_guard`: hard block. HTTP 403, `code: RATE_ANOMALY`.  
- `supervised`: soft block (escalate to orchestrator; await user confirm or Cato decision).  
- `power`: advisory — logged, not blocked.

**Check 5 — Endpoint scope:**  
**Given:** The target URL is outside the token's permitted endpoint set (derived from `skillSet` and configured `provider_type`).  
**Must:** Hard block in all security modes. HTTP 403, `code: OUT_OF_SCOPE_ENDPOINT`. Log the blocked call.

**Check ordering invariant:** If Check 1 blocks, Checks 2–5 do not run. If Check 2 blocks, Checks 3–5 do not run. And so on. The audit log entry records which check triggered.

**All-pass path:**  
**Given:** All five checks pass.  
**Must:** Decrement the token's call budget by 1. Replace the `Authorization` header with the real provider credential. Forward the request to the provider. Log the call (pass, tokenId, endpoint category, budget remaining, HTTP response status code, latency).

### Escalation Relay

**Given:** The Call Inspector issues `catoEscalate` and the orchestrator escalation socket is unreachable.  
**Must:** Hard block the proxied call. HTTP 403, no `code` (the Inspector cannot produce a CatoRiskCode without Cato's response). Log the escalation failure. Do not forward the call. This failure mode is not configurable — it is always fail-closed.

**Given:** `catoEscalate` returns `allow: true`.  
**Must:** Forward the proxied call. Log the outcome (escalation resolved, allow).

**Given:** `catoEscalate` returns `allow: false`.  
**Must:** Block the proxied call. HTTP 403 with the `code` and `reason` from Cato's response. Log the outcome (escalation resolved, block).

### Audit Log Writes

Every audit log write by the Token Broker/Call Inspector is an append (INSERT only). No UPDATE or DELETE is issued through the write interface. The following events must produce an audit log entry:

| Event | Fields logged |
|-------|--------------|
| Token issued | `tokenId`, `contextId`, `skillSet`, `securityMode`, `ttl`, `expiresAt`, `parentTokenId` (if applicable) |
| Token revoked | `tokenId`, `reason` (`explicit_revoke` / `ttl_expired` / `budget_exhausted`) |
| Proxied call — pass | `tokenId`, `endpoint_category`, `budget_consumed`, `budget_remaining`, `provider_type`, `response_status`, `latency_ms` |
| Proxied call — hard block | `tokenId`, `inspector_check` (which check triggered), `code` (CatoRiskCode), `endpoint_category` |
| Proxied call — soft block (supervised) | `tokenId`, `inspector_check`, `escalation_initiated: true` |
| Escalation issued | `checkId`, `tokenId`, `contextId`, `inspectorCheck`, `escalationReason` |
| Escalation resolved | `checkId`, `tokenId`, `outcome` (`allow` / `block`), `code` (if block) |
| Token budget exhausted | `tokenId`, `final_call_logged: true` |

Payload content is never written to the audit log. Only `payloadHash` (SHA-256 hex) and `payloadSize` are stored where a payload reference is needed.

---

## Failure Modes

**Credential backend unreachable at startup:**  
The Token Broker fails to start. It does not bind its Unix socket. The orchestrator cannot pass its health check and does not start. No tasks run. This is not configurable.

**Credential backend becomes unreachable after startup:**  
The broker transitions to `degraded` status. It does not issue new tokens (returns JSON-RPC error on `issueToken`). Existing valid tokens continue to be validated and proxied using their already-resolved credentials. The `health` method returns `{ "status": "degraded", "reason": "credential_backend_unreachable" }`.

**Token Broker Unix socket unreachable (from orchestrator's perspective):**  
Documented in the Orchestrator spec. From the broker's perspective, this condition does not arise — the broker is the socket server.

**Orchestrator escalation socket unreachable (from broker's perspective):**  
All proxied calls that trigger `catoEscalate` are hard-blocked. Calls that pass all five checks without an inconclusive result are forwarded normally. The broker logs each escalation failure with reason `escalation_socket_unreachable`.

**Provider endpoint unreachable or returns non-2xx:**  
The broker forwards the provider's response code to the container unchanged. If the provider is unreachable (connection error), the broker returns HTTP 502 to the container. The call is logged with the outcome status.

**Audit log write failure:**  
The Token Broker does not forward a proxied call if its audit log write fails. The call is abandoned; the container receives HTTP 500. This preserves ADR-9: the audit log is the source of truth and a call that cannot be recorded cannot proceed.

**Token store exhausted (memory):**  
When the in-memory token store reaches the configured maximum (`TOKEN_STORE_MAX_CAPACITY`, default 10,000), `issueToken` requests are rejected with `{ code: -32603, message: 'token_store_full' }`. No token is issued. Health status remains `ok` — store-full is not a credential backend failure. An alert-level audit log entry is written on the first store-full rejection in each 60-second window. Expired tokens are removed lazily at validation time; no background sweeper is required. (Decision 16)

---

## Invariants

These properties must hold at all times while the Token Broker process is running:

1. **No raw credential leaves the broker process.** The real API key, OAuth token, or equivalent credential is never written to the audit log, never returned in a JSON-RPC response, and never forwarded to any caller except the provider endpoint over HTTPS.

2. **Every proxied call is audited.** There is no code path through the proxy that forwards a call to an external provider without producing an audit log entry. A forward without an audit entry is a defect.

3. **Every blocked call is audited.** There is no code path that blocks a call without producing an audit log entry. A silent block is a defect.

4. **The Call Inspector runs on every proxied call.** There is no bypass. The check sequence cannot be short-circuited by any caller claim or token field. The only variable is which checks apply with which enforcement posture — that is determined by `securityMode` from the token, not from the caller.

5. **Cato is never connected to directly.** The Token Broker has no socket client to Cato. All Cato escalations go through the orchestrator relay at the escalation socket.

6. **Delegation ceiling is enforced at issuance.** A subagent token is never broader than its parent. If the parent is revoked at issuance time, the subagent token is not issued.

7. **Audit log writes are append-only.** No UPDATE or DELETE statement is issued by the broker or Call Inspector against any audit table.

8. **A call that cannot be audited is not forwarded.** The audit write precedes or is transactionally coupled to the forward decision. A partial failure that produces a forward without an audit entry is a defect.

9. **The `securityMode` claim in a token is immutable after issuance.** The token's mode cannot be changed by any caller, channel, or agent after the broker has issued it.

10. **Ollama calls receive no injected credential.** When `provider_type` is `ollama`, the broker forwards the request without an `Authorization` header. Injecting a credential to a local endpoint is a defect.

---

## Acceptance Criteria

Each criterion is testable from outside the Token Broker (via its Unix socket and HTTP proxy interface).

**AC-1:** A valid `issueToken` request returns a response containing `token`, `tokenId`, and `expiresAt`. The `token` value is an opaque string (non-empty, no decodable plaintext claim structure observable from outside). The `tokenId` matches a UUID format.

**AC-2:** A bearer token presented to the credential proxy that was issued for skill set `[S]` causes an HTTP 403 with `code: OUT_OF_SCOPE_ENDPOINT` when the request targets an endpoint not in `[S]`. The same token succeeds when targeting an endpoint in `[S]` (all other checks assumed pass).

**AC-3:** A bearer token presented after its TTL has elapsed causes an HTTP 403. The `health` endpoint and audit log confirm the token was treated as revoked.

**AC-4:** After `revokeToken` is called for a `tokenId`, the next proxy call bearing that token receives HTTP 403. This holds even if the token has remaining TTL and call budget.

**AC-5:** A token issued with `callBudget: N` allows exactly `N` proxied calls (all checks passing) and returns HTTP 403 on call `N+1`. The audit log shows `N` pass entries and one block entry with reason `budget_exhausted`.

**AC-6:** A `catoEscalate` request sent to the orchestrator escalation socket returns a response with `allow` (boolean) and, on `allow: false`, a `code` field drawn from the CatoRiskCode enumeration. The escalation is recorded in the audit log with `checkId`, `tokenId`, and outcome.

**AC-7:** When the orchestrator escalation socket is unreachable and the Call Inspector would issue `catoEscalate`, the proxy returns HTTP 403 to the container. The audit log records the escalation failure. No call is forwarded.

**AC-8:** An `issueToken` request with `parentTokenId` set to a valid parent token and a requested `skillSet` that is a strict superset of the parent's is rejected with a JSON-RPC error. No token is issued.

**AC-9:** An `issueToken` request with `parentTokenId` set to a revoked or expired parent token is rejected with a JSON-RPC error. No token is issued.

**AC-10:** The credential proxy never returns the real API key or upstream credential in any HTTP response body or header to the container.

**AC-11:** When `provider_type` is `ollama`, the forwarded request sent by the broker to the provider does not contain an `Authorization` header.

**AC-12:** When `provider_type` is `openrouter` (or any v1.0-invalid value), `issueToken` is rejected with a JSON-RPC error.

**AC-13:** A `health` JSON-RPC call returns `{ "status": "ok" }` when the credential backend is reachable. When the credential backend is made unreachable, subsequent `health` calls return `{ "status": "degraded", "reason": "credential_backend_unreachable" }`, and subsequent `issueToken` calls return a JSON-RPC error.

**AC-14:** Every proxied call — pass or block — produces exactly one audit log entry. No call produces zero entries; no call produces more than one entry (excluding escalation sub-entries, which are separate).

**AC-15:** A payload matching a high-confidence prompt injection signature causes HTTP 403 with `code: PROMPT_INJECTION` when `securityMode` is `golem_guard`. The same payload under `power` mode produces an audit log entry marked advisory but does not return HTTP 403 (call is forwarded if all other checks pass).

**AC-16:** The `catoEscalate` response `result` object contains `allow` (boolean). When `allow` is `false`, `code` is present and is a string matching one of the CatoRiskCode values defined in ARCHITECTURE.md §4.3.1.

**AC-17:** A token issued with `securityMode: supervised` and a payload that triggers a soft block causes the proxy to issue `catoEscalate` before responding. The proxy does not forward or block unilaterally while awaiting the orchestrator's response.

**AC-18:** The broker's Unix socket for the token lifecycle (§4.2.1) and the escalation listener socket (§4.2.2) are distinct paths. Connecting to the token lifecycle socket and issuing a `catoEscalate` message returns a JSON-RPC error (method not found or protocol mismatch). Connecting to the escalation socket and issuing `issueToken` returns a JSON-RPC error.

---

*This spec describes observable behavior and wire schemas only. Internal implementation decisions (signature data structure, JWT library, in-memory store eviction strategy) are Developer decisions, not spec decisions. Where ARCHITECTURE.md is silent on a material question, "TBD — architect to resolve" is noted rather than inventing an answer.*
