# M13 — Token Broker + Call Inspector: Security Review and QA

*Reviewed: 2026-04-07 | Reviewer: Claude Code (Security Reviewer role)*

---

## Security Reviewer Verdict: PASS WITH FINDINGS

The four required trust-domain checks all pass. Two additional findings are raised below — one at Medium severity (SSRF risk via `x-provider-endpoint`), one at Low severity (non-constant-time HMAC comparison). Neither is a blocking issue for merge; both are worth tracking.

---

### Trust Domain Crossing Review

#### Check 1 — Token claims cannot be modified after issuance

**Result: PASS**

Tokens are issued as `header.claims.sig` where `sig = HMAC-SHA256(header.claims, in-memory key)`. The key is a 32-byte random value generated once at `TokenStore` construction (`src/broker/index.ts:143`) and never exposed outside the store. All three parts are base64url-encoded so they cannot be round-tripped and re-signed by callers.

On every proxy request, `getByToken()` recomputes the expected HMAC from the presented header and claims before returning the record (`src/broker/index.ts:206`). A tampered claim therefore produces a mismatched signature and `getByToken` returns `null`, which triggers a 403 with `code: invalid_token`.

The claims object encodes all governance-relevant fields (`jti`, `ctx`, `skl`, `bgt`, `dsc`, `sec`, `iat`, `exp`) at issuance time (`src/broker/index.ts:168–178`). Broker-side enforcement reads from the mutable `TokenRecord` in the store rather than re-parsing the claims, which is correct and avoids a desynchronisation window.

**Evidence:** `src/broker/index.ts:147–210`

#### Check 2 — Credential proxy is NOT bound to `0.0.0.0`

**Result: PASS**

`startCredentialProxy` binds to `process.env.CREDENTIAL_PROXY_BIND_ADDRESS ?? '127.0.0.1'` (`src/broker/index.ts:853`). A comment on line 851 explicitly notes "never 0.0.0.0". The code path is:

```typescript
const bindAddr = process.env.CREDENTIAL_PROXY_BIND_ADDRESS ?? '127.0.0.1';
await new Promise<void>((resolve) => server.listen(0, bindAddr, resolve));
```

There is no code path that can produce `0.0.0.0` from this expression, because neither the env override nor the fallback can evaluate to `0.0.0.0` unless the administrator explicitly sets `CREDENTIAL_PROXY_BIND_ADDRESS=0.0.0.0`, which is an explicit operator choice documented as an override, not a default. Decision 32 (the originating ADR) requires Docker bridge binding; the implementation correctly defaults to `127.0.0.1` for tests and accepts the Docker bridge address via override for production.

Note: Decision 32 says the production default should be the resolved Docker bridge address (`172.17.0.1`), not `127.0.0.1`. The implementation defaults to `127.0.0.1` instead. This is a documentation gap (the CLAUDE.md example shows `172.17.0.1` as the default in `.env`), but it is not a security regression — `127.0.0.1` is strictly more restrictive than the Docker bridge address. Containers on the bridge cannot reach a loopback-bound proxy. This means the proxy will not be reachable by containers unless `CREDENTIAL_PROXY_BIND_ADDRESS` is set, which is the correct production configuration. The gap is a deployment documentation issue, not a code defect.

**Evidence:** `src/broker/index.ts:851–855`

#### Check 3 — `catoEscalate` is the only path from broker to Cato; no direct cato.sock connection

**Result: PASS**

The entire broker source contains exactly one `net.createConnection` call (`src/broker/index.ts:380`), inside the `catoEscalate` function. It connects to `p.escalationSocketPath`, which is the orchestrator escalation relay socket (`data/sockets/escalation.sock` per Decision 15) — not Cato's socket (`data/sockets/cato.sock`). The architecture is correct: the broker never holds a reference to the Cato socket path.

The escalation socket path is injected as a parameter flowing from `startBrokerV2Options.escalationSocketPath` through `dispatchBrokerMethod` to `runCallInspector` and finally to `catoEscalate`. At no point does the broker resolve or construct the Cato socket path (`data/sockets/cato.sock`).

The broker also starts a fallback listener on the escalation socket (lines 543–596) to handle the case where no orchestrator relay is present. This fallback correctly returns `allow: false` (fail-closed) with `code: ESCALATION_FAILED`, so a missing orchestrator relay never grants a free pass.

**Evidence:** `src/broker/index.ts:374–421` (catoEscalate function), `src/broker/index.ts:380` (sole `createConnection`)

#### Check 4 — Derivative token value is never logged; tokenId is logged instead

**Result: PASS**

All audit log `append` calls in `src/broker/index.ts` were examined. The `token_issued` event (lines 791–800) logs `tokenId`, `contextId`, `skillSet`, `securityMode`, `ttl`, `expiresAt`, and `parentTokenId`. The signed token value (`result.token`) is returned to the caller at line 803 but is not present in the audit append at lines 791–800.

All proxy audit events (`proxied_call_blocked`, `proxied_call_pass`, `token_revoked`, `credential_emergency_rotation`) log `tokenId` only. The bearer token string extracted from the `Authorization` header at line 888 is used for validation and then discarded — it is not placed in any audit entry.

The `SqliteAuditLog.append` method (lines 102–107) separates `event` and `tokenId` from `rest`, serialising the remainder as `details`. Auditing code never passes `token` as a field name in any `append` call.

**Evidence:** `src/broker/index.ts:791–800` (token_issued audit), `src/broker/index.ts:884–961` (proxy handler audit calls)

---

### Additional Findings

#### Finding F-M13-1 — `x-provider-endpoint` header accepted without allowlist validation (Medium)

The `forwardRequest` function reads the `x-provider-endpoint` request header from the container's HTTP call and uses it directly as the upstream base URL without validation (`src/broker/index.ts:988–991`):

```typescript
const epHeader = req.headers['x-provider-endpoint'];
const targetBase = typeof epHeader === 'string' ? epHeader : upstreamBase;
const targetUrl = new URL(urlPath, targetBase.endsWith('/') ? targetBase.slice(0, -1) : targetBase);
```

A container holding a valid derivative token can set `x-provider-endpoint: http://169.254.169.254` (AWS IMDSv1) or any other internal address and cause the broker to make a credentialed HTTP request to that target. The Call Inspector checks the `urlPath` (the path portion), not the base URL, so this bypass is invisible to the inspector's endpoint-scope check (Check 5). The injected credential (real API key or OAuth token) is sent in the `Authorization` header of the forwarded request to the attacker-supplied destination.

**Severity:** Medium. Exploitation requires a compromised or malicious container that already holds a valid derivative token — containers are ephemeral and spawned by the orchestrator under Cato governance. However, the derivative-token model's purpose is to limit what a container can do even if it is fully compromised. SSRF using the credential proxy is a meaningful privilege escalation beyond that limit.

**Recommended fix:** Validate `x-provider-endpoint` against a deployment-level allowlist (registered via `registerSkillScope` `networkEndpoints` per Decision 19 and ARCHITECTURE.md §5.5). Reject requests with unregistered base URLs with a `403 OUT_OF_SCOPE_ENDPOINT` response before forwarding. This is architecturally consistent with the skill whitelist (Check 1) and the endpoint scope (Check 5) already implemented.

**Evidence:** `src/broker/index.ts:988–991`

#### Finding F-M13-2 — Non-constant-time HMAC comparison creates timing side-channel (Low)

`TokenStore.getByToken` compares the presented token signature against the computed HMAC using JavaScript string inequality (`!==`) at `src/broker/index.ts:207`:

```typescript
if (sig !== expected) return null;
```

JavaScript string comparison (`!==`) is not guaranteed to run in constant time — V8 may short-circuit on the first differing byte. An adversary who can make many proxy requests and measure response latency could use this timing oracle to confirm partial HMAC matches, potentially aiding a brute-force or length-extension attack.

**Severity:** Low. The HMAC key is a 32-byte random value generated fresh per broker instance and never exposed. Exploitation requires high-precision timing measurements and the ability to make a large volume of proxied requests, all of which would themselves appear as repeated `invalid_token` blocks in the audit log. The signature is also over 64 hex characters (the full SHA-256 output), making partial-match timing attacks impractical in practice. However, best practice for HMAC verification is to use `crypto.timingSafeEqual`.

**Recommended fix:** Replace the comparison at line 207 with:

```typescript
if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
```

Both buffers must be equal length; if the lengths differ (malformed token), reject immediately before calling `timingSafeEqual`.

**Evidence:** `src/broker/index.ts:206–207`

---

## QA Verdict: PASS WITH FINDINGS

### Test Results

```
Test Files: 1 passed (1)
Tests:      43 passed | 7 skipped (50 total)
Duration:   4.99s
```

All 43 executed tests pass. The 7 skipped tests are in the `Integration — real socket and SQLite audit log` describe block, which is guarded by `process.env.OPENGOLEM_INTEGRATION_TESTS === '1'`. These tests are not run in CI without that flag.

Three tests are flagged with their individual runtimes in the output (AC-3 TTL expiry at 1561ms, AC-5 budget exhaustion at 389ms/432ms, AC-17 supervised mode at 511ms/485ms) — these involve real time.sleep-equivalent delays for TTL and escalation waits. Runtimes are within acceptable bounds.

### Acceptance Criteria Coverage

| AC | Description | Status |
|----|-------------|--------|
| AC-1 | Valid `issueToken` returns `token`, `tokenId`, `expiresAt`; token is opaque | **Covered** — two unit tests (opaque structure + UUID format) + 1 integration (skipped) |
| AC-2 | Token for skill `[S]` causes HTTP 403 on out-of-scope endpoint | **Covered** — proxy contract test |
| AC-3 | Token past TTL causes HTTP 403 | **Covered** — proxy contract test (real sleep) + unit expiresAt check |
| AC-4 | Revoked token causes HTTP 403 even with remaining TTL and budget | **Covered** — unit (revoke returns `{revoked:true}`) + proxy contract test |
| AC-5 | `callBudget: N` allows exactly N calls, HTTP 403 on N+1 | **Covered** — proxy contract test with budget exhaustion sequence |
| AC-6 | `catoEscalate` to escalation socket returns `allow` + `code`; escalation logged | **Covered** — unit test for schema; integration (skipped) for audit log entry |
| AC-7 | Unreachable escalation socket causes proxy HTTP 403; no call forwarded | **Covered** — proxy contract test |
| AC-8 | `issueToken` with `parentTokenId` and superset skillSet rejected | **Covered** — three unit tests (skillSet superset, callBudget excess, dataScopes superset, securityMode escalation) |
| AC-9 | `issueToken` with revoked or unknown `parentTokenId` rejected | **Covered** — two unit tests |
| AC-10 | Proxy never returns real API key in response body or headers | **Covered** — proxy contract test |
| AC-11 | Ollama provider: forwarded request has no `Authorization` header | **Covered** — proxy contract test |
| AC-12 | Invalid `provider_type` (e.g. `openrouter`) causes `issueToken` rejection | **Covered** — two unit tests |
| AC-13 | `health` returns `ok` when backend reachable; `degraded` when unreachable; `issueToken` fails when degraded | **Partial** — "ok" case is covered in unit and integration tests. The "degraded → issueToken fails" half of the AC is not testable with the env backend (which is always reachable). The integration test (skipped) accepts either `ok` or `degraded`. No test drives the broker into a degraded state and then verifies `issueToken` rejection. |
| AC-14 | Every proxied call produces exactly one audit log entry | **Covered** — proxy contract test + integration (skipped) |
| AC-15 | Golem Guard hard-blocks prompt injection; Power mode forwards with advisory log | **Covered** — two proxy contract tests |
| AC-16 | `catoEscalate` response `result.allow` is boolean; `code` present when `false` | **Covered** — contract test |
| AC-17 | Supervised mode holds call until escalation decision; does not unilaterally forward or block | **Covered** — proxy contract test (real timing) |
| AC-18 | Broker lifecycle socket and escalation socket are distinct; each rejects the other's methods | **Covered** — two tests (one per socket direction) |

### Coverage Gaps

**AC-13 (partial):** The degraded-health-blocks-issueToken path is untested in any executed test. The integration test for AC-13 (line 1369 in the test file) is skipped by default and, even when enabled, only verifies the `health` response schema rather than proving that `issueToken` is rejected when health is degraded. The implementation comment at `src/broker/index.ts:772–776` explicitly notes that for the env backend the backend is "always reachable" and degraded state does not block `issueToken`. This creates a divergence from the spec text of AC-13, which says `issueToken` must return a JSON-RPC error when the backend is unreachable. The gap is a Phase 1 constraint (only env backend is implemented), but it should be documented as a known deviation.

**AC-6 audit log entry (skipped):** The integration test that verifies the escalation event is recorded in the SQLite audit log with `checkId`, `tokenId`, and outcome is in the skipped integration block. The passing unit test (AC-6 unit) only confirms the escalation socket response schema; it does not verify the audit log write. Full audit coverage of escalation events requires the integration tier.

**Decision 16 token store full (integration):** The `token_store_full` behavior is tested in the integration block (line 1383–1415) but is skipped. The unit-tier test in the executed set does not exercise this path.

---

## Overall Verdict: PASS WITH FINDINGS

The implementation correctly satisfies all four required security reviewer checks. The two additional findings (F-M13-1 SSRF via `x-provider-endpoint`, F-M13-2 non-constant-time HMAC comparison) and the AC-13 coverage gap are real issues worth tracking but do not constitute blocking defects.

---

## Blocking Issues

None. The implementation may be merged. The following should be tracked as follow-on work:

1. **F-M13-1** (Medium): Add allowlist validation of `x-provider-endpoint` against registered skill network endpoints. Recommend addressing before any skill that declares a non-Anthropic `networkEndpoints` entry ships.
2. **F-M13-2** (Low): Replace `sig !== expected` with `crypto.timingSafeEqual` at `src/broker/index.ts:207`. Low urgency; fix in next broker maintenance pass.
3. **AC-13 coverage gap**: Document the env-backend deviation from AC-13's "degraded → issueToken fails" contract. Add a test that exercises this path when a non-env credential backend is implemented (Bitwarden or OneCLI, Phase 2).
4. **Integration tier skipped**: The 7 skipped integration tests (AC-1, AC-6, AC-13, AC-14 ×2, Decision-16, STUB-DETECT-INTEGRATION) require `OPENGOLEM_INTEGRATION_TESTS=1`. Recommend enabling this flag in the CI matrix to avoid leaving integration-tier ACs permanently unverified.
