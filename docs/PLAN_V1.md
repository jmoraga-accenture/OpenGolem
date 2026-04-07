# OpenGolem — Implementation Plan v1.0
*Status: PM approved 2026-04-07 | Produced: 2026-04-06*
*Architect: Claude Code | Input: All approved specs, IMPLEMENTATION_AUDIT.md, TEAM.md v2*

---

## How to Read This Document

Milestones are numbered sequentially (M1, M2, …). Phase 2 milestones cover all development and specialist review work. Phase 3 milestones cover integration, end-to-end validation, and final sign-off.

**Within Phase 2, milestones are ordered by earliest-start date** — if M5 can start the same day M4 starts (no dependency on M4), it appears after M4 in the list but with "none (starts in parallel)" noted in its sequencing constraint. A Developer reading this document can identify the next available milestone by finding the first milestone whose sequencing constraints are all marked complete.

**TDD rule:** For every component, the Tester milestone precedes the Developer milestone. Tests are written against the behavioral spec only, must fail, and are committed to the branch before the Developer starts.

**Review chain:** After every Developer milestone: Security Reviewer → QA/QC → Jim merge approval.

**Jim's gate** column names what Jim must approve before the milestone closes or the downstream chain can proceed.

---

## Milestone Status Key

- **[ ]** — not started
- **[T]** — Tester done, Developer not started
- **[D]** — Developer done, review in progress
- **[R]** — Security Review and QA/QC done, awaiting Jim merge approval
- **[x]** — complete (Jim approved)

---

## Phase 2 — Development

---

### M1 — Supply-Chain Audit Phase 1 (Stream L)

| Field | Value |
|-------|-------|
| **ID** | M1 |
| **Stream** | L |
| **Component / Work** | Supply-chain audit of the Phase 1 Node.js and npm dependency surface |
| **Assigned role** | Supply-Chain Auditor |
| **Sequencing constraints** | None — unblocked at plan approval. Inputs: current `package.json`, `package-lock.json`, and `SECURITY_STRENGTHENING.md` F-10. |
| **Definition of Done** | 1. `docs/supply-chain-audit-phase1.md` produced, covering: full transitive dependency inventory, severity classification per package (critical / high / medium / low), `npm audit` zero-high-severity policy recommendation, `package-lock.json` integrity enforcement recommendation, container base image pinning and scanning policy. 2. Any critical or high-severity findings are flagged with specific remediation recommendations. 3. A draft npm audit CI enforcement policy is included for Jim's review. |
| **Jim's gate** | Jim reviews and approves the audit findings and the npm audit CI policy before the policy is adopted and before any v1.0 milestone closes. |

---

### M2 — Cybersecurity Specialist Review (Stream G)

| Field | Value |
|-------|-------|
| **ID** | M2 |
| **Stream** | G |
| **Component / Work** | Threat model and security architecture review against `SECURITY_STRENGTHENING.md` F-1 through F-10 |
| **Assigned role** | Cybersecurity Specialist |
| **Sequencing constraints** | None — unblocked at plan approval. Inputs: `ARCHITECTURE.md`, all approved behavioral specs (token-broker-spec.md, cato-spec.md, orchestrator-spec.md, channel-adapters-spec.md, skill-schema-spec.md, memory-tiers-spec.md, audit-log-spec.md, soul-psyche-spec.md), `SECURITY_STRENGTHENING.md`. |
| **Definition of Done** | 1. `docs/sec/stream-g-cybersecurity-report.md` produced covering all ten findings (F-1 through F-10) against the v1.0 scope (TUI + Telegram only). 2. For each finding: severity confirmation or revision, threat model narrative, recommended ADR text or spec amendment. 3. For F-1 (inbound transport): assessed for both Telegram deployment modes — long-poll (no inbound surface) and webhook (locally-bound HTTP endpoint); severity verdict for each. 4. For F-2 (credential proxy binding): explicit recommendation on Docker bridge interface binding and whether TLS is required on the container-to-proxy hop. 5. For F-3 (audit log integrity): recommendation on HMAC chain implementation for Phase 2, and any interim Phase 1 controls. 6. For F-4 (adapter supply-chain): specific mitigations recommended (Node.js `--permission` flag evaluation, anomalous connection logging, adapter sourcing policy). 7. For F-5 through F-10: remediation recommendations that close or explicitly defer each finding with documented rationale. 8. ADR recommendations ready for PM review. |
| **Jim's gate** | Jim reviews all findings and ADR recommendations. Jim approves which findings are accepted for ADR production, which are accepted-as-documented risk (with PM sign-off recorded), and which are deferred to Phase 2 before Stream H commissions begin. |

---

### M3 — UX Review: Setup and Onboarding (Stream I)

| Field | Value |
|-------|-------|
| **ID** | M3 |
| **Stream** | I |
| **Component / Work** | UX review of the setup and onboarding experience from clone to running system |
| **Assigned role** | UX / Interaction Designer |
| **Sequencing constraints** | None — unblocked at plan approval. Inputs: current `README.md`, `docs/SECURITY_STRENGTHENING.md`, `ARCHITECTURE.md` §1.3 (startup order), orchestrator-spec.md §3.1. |
| **Definition of Done** | 1. `docs/ux-review-setup.md` produced. 2. Assessment of cognitive load at each setup step for the target user spectrum (non-expert to enterprise operator). 3. Specific recommendations for: documentation structure, progressive disclosure of credential backend options, error message clarity at startup failures (broker unreachable, Cato socket missing, missing `.env`). 4. Annotated user flow covering: first run, channel registration, group creation, skill application. 5. Identification of any steps where a user can reach a bad state with no clear recovery path. |
| **Jim's gate** | Jim approves UX recommendations before they are incorporated into documentation and before the Developer producing deployment documentation begins. |

---

### M4 — UX Review: CLI and TUI Interaction Model (Stream J)

| Field | Value |
|-------|-------|
| **ID** | M4 |
| **Stream** | J |
| **Component / Work** | UX review of the `opengolem>` prompt, TUI health dashboard, `Ctrl-D` toggle, and administrative command surface |
| **Assigned role** | UX / Interaction Designer |
| **Sequencing constraints** | None — unblocked at plan approval. Inputs: channel-adapters-spec.md (TUI adapter), orchestrator-spec.md §2.9 (health endpoint), `ARCHITECTURE.md` §3.1 (health dashboard). |
| **Definition of Done** | 1. `docs/ux-review-tui-cli.md` produced. 2. Assessment of: information hierarchy in the health panel, legibility of security state (active containers, Cato socket status, broker status) for the target user spectrum. 3. Annotated wireframe-level information architecture for the TUI split-pane layout (main conversation pane / health panel toggle). 4. Specific recommendations for: `Ctrl-D` toggle affordance, health panel content ordering, error message clarity (container TTL expiry, Cato block, broker unavailable). 5. Administrative command surface recommendations (what commands exist, how they are discovered, how errors are surfaced). |
| **Jim's gate** | Jim approves UX recommendations. Stream F (Channel Adapters) Developer may not start the TUI adapter implementation until Jim has approved these recommendations. |

---

### M5 — UX Review: Report Dashboard Skill (Stream K)

| Field | Value |
|-------|-------|
| **ID** | M5 |
| **Stream** | K |
| **Component / Work** | UX review of the Report Dashboard skill — the primary governance interface for human calibration decisions |
| **Assigned role** | UX / Interaction Designer |
| **Sequencing constraints** | None — unblocked at plan approval. Inputs: `ARCHITECTURE.md` §5.4 (dashboard skill mandate), `ARCHITECTURE.md` ADR-3 (no auto-recalibration), cato-spec.md §2.2 (hansei report schema), audit-log-spec.md §3.2 (event types). Note: the dashboard skill spec (Stream C sub-item) has not yet been written — this review informs that spec. |
| **Definition of Done** | 1. `docs/ux-review-dashboard.md` produced. 2. Information architecture for the governance dashboard: KPI trend surfaces (three dao_score metrics), block history view, hansei report inbox display, threshold change recommendation flow, false-positive signal capture path. 3. Assessment of: how an administrator transitions from "I see a KPI anomaly" to "I have made a calibration decision" — identifying friction, ambiguity, or missing information at each step. 4. Annotated user flow for: reviewing a hansei report, deciding whether to adjust a PSYCHE.md threshold, recording the decision. 5. Responsible AI framing: the review must explicitly assess whether the dashboard supports or undermines human oversight quality, not just usability. |
| **Jim's gate** | Jim approves UX recommendations before the dashboard skill spec (Stream C sub-item) is written. |

---

### M6 — Token Broker + Call Inspector: Tests Written (Stream A)

| Field | Value |
|-------|-------|
| **ID** | M6 |
| **Stream** | A |
| **Component / Work** | Test suite for Token Broker and Call Inspector, written against token-broker-spec.md |
| **Assigned role** | Tester |
| **Sequencing constraints** | None — unblocked at plan approval. Inputs: token-broker-spec.md, `DECISIONS.md` Decisions 1, 2, 8, 15, 16, 19, 23, 24. |
| **Definition of Done** | Four test tiers written and committed to the stream-A branch, all initially failing: 1. **Unit:** Token issuance with correct claims (contextId, skillSet, TTL, callBudget, dataScopes, securityMode), revocation (token not valid after revoke), store-full rejection (error code `token_store_full`), expired-token lazy eviction at validation time, `registerSkillScope` and `deregisterSkillScope` updates to scope list, `resolveSupervised` confirm and cancel paths, health check response. 2. **Contract (IPC wire):** JSON-RPC 2.0 format compliance on `broker.sock`; `catoEscalate` method on `escalation.sock` including `contentExcerpt` field forwarding. 3. **Integration:** Call Inspector five checks (skill whitelist, memory scope, prompt injection signature, call rate, endpoint scope) each producing the correct HTTP response code and audit log entry; mode-aware enforcement (Golem Guard hard block, Supervised soft block, Power advisory); HMAC-SHA256 JWT signature verification. 4. **Stub detection:** Verify that a bad token causes a 403 (test fails if stub always passes); verify that store-full causes rejection (test fails if stub always issues). |
| **Jim's gate** | Jim reviews the test suite for coverage completeness against the acceptance criteria in token-broker-spec.md before the Developer starts. |

---

### M7 — Cato: Tests Written (Stream B)

| Field | Value |
|-------|-------|
| **ID** | M7 |
| **Stream** | B |
| **Component / Work** | Test suite for Cato (inline check) and SOUL.md / PSYCHE.md governance, written against cato-spec.md and soul-psyche-spec.md |
| **Assigned role** | Tester |
| **Sequencing constraints** | None — unblocked at plan approval. Inputs: cato-spec.md, soul-psyche-spec.md, `DECISIONS.md` Decisions 12, 14, 17, 18. |
| **Definition of Done** | Four test tiers written and committed to the stream-B branch, all initially failing: 1. **Unit:** Inline check allow on normal prompt; block on path traversal (`../`); block on oversized payload (>100 KB); allow on absent `contentExcerpt` for `FILESYSTEM_WRITE`; reject on unknown `action` value; `checkId` round-trip. SOUL.md validation: presence of all five required sections; template variable injection. PSYCHE.md validation: dao_score KPI definitions parseable; alert threshold format valid. 2. **Contract (IPC wire):** Newline-delimited JSON (not JSON-RPC) protocol compliance on `cato.sock`; response schema matches `{checkId, allow, code, reason}` exactly. 3. **Integration:** Audit log write on every check (allow and block); `cato_audit_start` and `cato_audit_complete` events on scheduled audit; hansei report file atomic creation (`write-temp-then-rename`) and `hansei_report_ready` audit log event. 4. **Stub detection:** Verify path traversal actually blocks (test fails if check always allows); verify scheduled audit fires on interval (test fails if no `cato_audit_start` event appears). |
| **Jim's gate** | Jim reviews the test suite before the Developer starts. |

---

### M8 — Skill Schema: Tests Written (Stream C)

| Field | Value |
|-------|-------|
| **ID** | M8 |
| **Stream** | C |
| **Component / Work** | Test suite for the Skill Schema and Lifecycle component, written against skill-schema-spec.md |
| **Assigned role** | Tester |
| **Sequencing constraints** | None — unblocked at plan approval. Inputs: skill-schema-spec.md, `DECISIONS.md` Decision 3, 19. |
| **Definition of Done** | Four test tiers written and committed to the stream-C branch, all initially failing: 1. **Unit:** Valid `.intent.md` parses and registers; missing required field (`skill`, `version`, `type`, `description`) rejects with specific error; duplicate skill ID rejects; invalid URL pattern in `network.endpoints` rejects; `mcp.servers` without `min_permission_tier` rejects; skill removal reverses broker notification. 2. **Contract:** `registerSkillScope` JSON-RPC on `broker.sock` — correct params schema; `deregisterSkillScope` correct. 3. **Integration:** After `registerSkillScope`, subsequent `issueToken` calls include the new skill scope in claims; after `deregisterSkillScope`, new tokens do not include it; existing tokens are not revoked. 4. **Stub detection:** Verify that a skill with a missing required field actually fails to register (test fails if stub always succeeds). |
| **Jim's gate** | Jim reviews the test suite before the Developer starts. |

---

### M9 — Memory Tiers: Tests Written (Stream D)

| Field | Value |
|-------|-------|
| **ID** | M9 |
| **Stream** | D |
| **Component / Work** | Test suite for all three Memory Tiers, written against memory-tiers-spec.md |
| **Assigned role** | Tester |
| **Sequencing constraints** | None — unblocked at plan approval. Inputs: memory-tiers-spec.md, `DECISIONS.md` Decisions 20, 21, 22. |
| **Definition of Done** | Four test tiers written and committed to the stream-D branch, all initially failing: 1. **Unit (Tier 1):** Missing `CLAUDE.md` auto-creates empty file at spawn; `MEMORY_WRITE` Cato check blocks uncommitted mutation on `allow: false`; orchestrator overwrites file only on `allow: true`; group isolation (container for group A cannot access group B file). **Unit (Tier 2):** Missing `messages.db` auto-creates with normative schema and WAL mode; WAL mode mandatory (startup error if not achievable); `messages` table pruning respects retention window; `sessions` and `tasks` rows survive pruning. **Unit (Tier 3):** `data/memory.db` creation; Call Inspector approval required before any write commits; no bind-mount into containers. 2. **Contract:** WAL mode pragma confirmed on open; schema `CREATE TABLE` statements match normative spec. 3. **Integration:** Send message to a group whose `messages.db` and `CLAUDE.md` do not exist; confirm both are created and message is processed. 4. **Stub detection:** Verify `MEMORY_WRITE` Cato block actually prevents file update (test fails if stub always writes). |
| **Jim's gate** | Jim reviews the test suite before the Developer starts. |

---

### M10 — Audit Log: Tests Written (cross-cutting)

| Field | Value |
|-------|-------|
| **ID** | M10 |
| **Stream** | Cross-cutting (Streams A, B, E) |
| **Component / Work** | Test suite for the unified audit log, written against audit-log-spec.md |
| **Assigned role** | Tester |
| **Sequencing constraints** | None — unblocked at plan approval. Inputs: audit-log-spec.md, `DECISIONS.md` Decisions 6, 15, 16. |
| **Definition of Done** | Four test tiers written and committed to a shared audit-log branch, all initially failing: 1. **Unit:** Auto-create on first open; WAL mode mandatory; INSERT-only write interface (no UPDATE or DELETE reachable from write API); unified schema column set per event type; `payload` JSON column stores writer-specific fields correctly. 2. **Contract:** All three writers (Orchestrator, Broker/Inspector, Cato) produce events with required shared fields (`id`, `event_type`, `actor`, `context_id`, `timestamp`). 3. **Integration:** Concurrent writers (orchestrator + broker + Cato in WAL mode) produce no write errors or corruption; `contextId` query returns events from all three writers for the same context. 4. **Stub detection:** Verify that a failed audit log write actually halts the action (test fails if stub always proceeds). |
| **Jim's gate** | Jim reviews the test suite before the Developer starts. |

---

### M11 — DevOps Hardening Guidance (Stream H)

| Field | Value |
|-------|-------|
| **ID** | M11 |
| **Stream** | H |
| **Component / Work** | Deployment hardening guidance, runbooks, and network hardening annex |
| **Assigned role** | DevOps / Systems Administrator |
| **Sequencing constraints** | M2 (Cybersecurity Specialist) Jim-approved findings must be available. Inputs: approved findings from M2, token-broker-spec.md, orchestrator-spec.md, `SECURITY_STRENGTHENING.md`. |
| **Definition of Done** | `docs/devops-hardening.md` produced covering: 1. **Network hardening annex:** firewall posture per channel type (TUI: loopback only; Telegram: outbound long-poll or webhook — if webhook, localhost-bind + signature verification); credential proxy binding to Docker bridge interface only (not `0.0.0.0`). 2. **Credential rotation runbook:** procedure for planned rotation (each backend type: `.env`, Bitwarden); emergency rotation procedure (suspected key leak); time-to-rotation targets per backend; `rotateCredential` RPC usage. 3. **Broker crash recovery procedure:** detection of mid-task broker loss, container teardown sequence, restart policy recommendation (systemd/launchd), target restart time relative to shortest TTL. 4. **Process supervisor configuration:** sample systemd unit files for all three long-lived processes with correct startup order (Token Broker → Cato → Orchestrator); restart policy per process. 5. **F-7 documentation insert:** draft "Safety posture by provider" section for deployment docs, covering reduced upstream filter coverage for Ollama and custom providers. |
| **Jim's gate** | Jim approves all guidance before it is incorporated into deployment documentation or acted upon. |

---

### M12 — Token Broker + Call Inspector: Developer Implementation (Stream A)

| Field | Value |
|-------|-------|
| **ID** | M12 |
| **Stream** | A |
| **Component / Work** | Implement Token Broker and Call Inspector per token-broker-spec.md, working from the M6 test suite |
| **Assigned role** | Developer |
| **Sequencing constraints** | M6 (test suite) complete. Inputs: token-broker-spec.md, M6 test suite, IMPLEMENTATION_AUDIT.md (keep/shed notes on `broker/*`, `credential-proxy.ts`, `inspector/*`), `DECISIONS.md` 1, 2, 8, 15, 16, 19, 23, 24. |
| **Definition of Done** | 1. All M6 tests pass. 2. Token Broker runs as a standalone process (not co-located with the Orchestrator). 3. Broker listens on `data/sockets/broker.sock` with JSON-RPC 2.0 methods: `issueToken`, `revokeToken`, `health`, `registerSkillScope`, `deregisterSkillScope`, `resolveSupervised`. 4. `issueToken` produces a signed HMAC-SHA256 JWT encoding: contextId, skillSet, TTL, callBudget, dataScopes, securityMode. 5. Token store rejects new `issueToken` when at capacity (`TOKEN_STORE_MAX_CAPACITY`, default 10,000); error code `token_store_full`. 6. Call Inspector runs five checks in order; mode-aware enforcement per `securityMode` claim; inconclusive path calls `catoEscalate` on `data/sockets/escalation.sock`. 7. Escalation relay sends `contentExcerpt` (Decision 23). 8. Soft block (`Supervised` mode) holds call until `resolveSupervised` confirm/cancel or 60-second timeout. 9. Credential proxy binds to Docker bridge interface only (per M11 guidance, if approved). 10. All files in `src/broker/` subdirectory; `src/inspector/` subdirectory. No application files in `src/` root. |
| **Jim's gate** | Jim approves merge after Security Reviewer and QA/QC sign off. |

---

### M13 — Token Broker + Call Inspector: Security Review and QA (Stream A)

| Field | Value |
|-------|-------|
| **ID** | M13 |
| **Stream** | A |
| **Component / Work** | Security review and QA/QC of the Token Broker and Call Inspector implementation |
| **Assigned role** | Security Reviewer, then QA/QC |
| **Sequencing constraints** | M12 (Developer) complete. |
| **Definition of Done** | **Security Reviewer:** Reviews all trust domain crossings in `src/broker/` and `src/inspector/` against `ARCHITECTURE.md` §2 and §4.2. Specific checks: token claims cannot be modified after issuance; credential proxy binding is not `0.0.0.0`; `catoEscalate` is the only path from broker to Cato (no direct socket); derivative token never logged. Verdict: pass (with findings list) or fail (blocking issues). **QA/QC:** Full test suite run; M6 tests all pass; no regressions in existing suite; integration tests confirm concurrent token operations; coverage report meets threshold. QA verdict: pass or fail. |
| **Jim's gate** | Jim reviews Security Reviewer verdict and QA verdict; approves merge. |

---

### M14 — Cato: Developer Implementation (Stream B)

| Field | Value |
|-------|-------|
| **ID** | M14 |
| **Stream** | B |
| **Component / Work** | Implement Cato (inline check process, scheduled audit, dao_score, hansei delivery) per cato-spec.md; implement SOUL.md / PSYCHE.md governance per soul-psyche-spec.md |
| **Assigned role** | Developer |
| **Sequencing constraints** | M7 (test suite) complete. Inputs: cato-spec.md, soul-psyche-spec.md, M7 test suite, IMPLEMENTATION_AUDIT.md (keep/shed notes on `cato/*`), `DECISIONS.md` 12, 14, 17, 18. |
| **Definition of Done** | 1. All M7 tests pass. 2. Cato runs as a standalone process. 3. Cato listens on `data/sockets/cato.sock`; newline-delimited JSON protocol (not JSON-RPC). 4. Request schema includes `contentExcerpt` optional field (Decision 17). 5. Phase 1 deterministic checks: path traversal (on `contentExcerpt` when present), oversized payload (on `payloadSize`). 6. Unknown `action` value returns `allow: false`. 7. Every inline check response written to audit log (`cato_check` event). 8. Scheduled audit fires on `CATO_AUDIT_INTERVAL` (default 6 hours; minimum 15 minutes; startup error if below minimum or unparseable). 9. Hansei reports delivered via atomic file create (`write-temp-then-rename`) under `data/hansei/inbox/`; filename format `hansei-<ISO8601-compact>-<uuid>.json`. 10. `hansei_report_ready` audit log event written after each report. 11. SOUL.md validation: orchestrator rejects spawn if required sections absent. 12. PSYCHE.md loaded at startup and at each scheduled audit run. 13. All files in `src/cato/` subdirectory. |
| **Jim's gate** | Jim approves merge after Security Reviewer and QA/QC sign off. |

---

### M15 — Cato: Security Review and QA (Stream B)

| Field | Value |
|-------|-------|
| **ID** | M15 |
| **Stream** | B |
| **Component / Work** | Security review and QA/QC of the Cato implementation |
| **Assigned role** | Security Reviewer, then QA/QC |
| **Sequencing constraints** | M14 (Developer) complete. |
| **Definition of Done** | **Security Reviewer:** Reviews `src/cato/` against `ARCHITECTURE.md` §2 (trust domain map) and §3.4 (Cato responsibilities). Specific checks: no path from TD-CONTAINER to TD-CATO; Cato opens no client connection to the orchestrator; `reason` field in block responses does not reproduce payload content; `contentExcerpt` is not logged or persisted beyond the check. Verdict: pass or fail. **QA/QC:** All M7 tests pass; scheduled audit fires at correct interval in integration test; hansei report schema validates against spec; dao_score KPI formulas match PSYCHE.md definitions. QA verdict: pass or fail. |
| **Jim's gate** | Jim reviews Security Reviewer verdict and QA verdict; approves merge. |

---

### M16 — Audit Log: Developer Implementation (cross-cutting)

| Field | Value |
|-------|-------|
| **ID** | M16 |
| **Stream** | Cross-cutting |
| **Component / Work** | Implement unified audit log per audit-log-spec.md; wire all three writers |
| **Assigned role** | Developer |
| **Sequencing constraints** | M10 (test suite) complete; M12 (Token Broker) and M14 (Cato) implementations started (wire protocol finalized). Note: audit log writer interfaces can be implemented once the event schemas from broker and Cato specs are stable, which they are from M6/M7. Full integration (all three writers in WAL concurrent mode) can complete once M12 and M14 are done. |
| **Definition of Done** | 1. All M10 tests pass. 2. `data/audit.db` is a single SQLite file; WAL mode mandatory; auto-creates on first open. 3. Unified `events` table schema matches audit-log-spec.md §3.1 exactly. 4. Write interface exposes INSERT-only API; no UPDATE or DELETE methods in the write surface. 5. All three writers (Orchestrator, Token Broker/Inspector, Cato) write to the same file. 6. Concurrent WAL write test passes (no corruption or lock errors). 7. All event types from audit-log-spec.md §3.2 are represented in the write API. 8. New event types added by Decisions 24, 25, 26 are included: `supervised_timeout`, `config_parse_error`, `hansei_parse_error`. 9. Files in `src/shared/audit/`. |
| **Jim's gate** | Jim approves merge after Security Reviewer and QA/QC sign off. |

---

### M17 — Audit Log: Security Review and QA (cross-cutting)

| Field | Value |
|-------|-------|
| **ID** | M17 |
| **Stream** | Cross-cutting |
| **Component / Work** | Security review and QA/QC of the unified audit log |
| **Assigned role** | Security Reviewer, then QA/QC |
| **Sequencing constraints** | M16 (Developer) complete. |
| **Definition of Done** | **Security Reviewer:** Verifies INSERT-only semantics (no UPDATE or DELETE in write path); WAL mode enforcement; no agent container has a write path to `data/audit.db`; `data/` directory is never bind-mounted into containers. Reviews that all required event types produce audit log entries. Verdict: pass or fail. **QA/QC:** Concurrent write test (three simultaneous writers) completes without error; query by `contextId` returns events from all three writers; M10 tests all pass. QA verdict: pass or fail. |
| **Jim's gate** | Jim approves merge. |

---

### M18 — Skill Schema: Developer Implementation (Stream C)

| Field | Value |
|-------|-------|
| **ID** | M18 |
| **Stream** | C |
| **Component / Work** | Implement Skill Schema and Lifecycle component per skill-schema-spec.md |
| **Assigned role** | Developer |
| **Sequencing constraints** | M8 (test suite) complete; M12 (Token Broker) must have `registerSkillScope`/`deregisterSkillScope` interface stable (it is, from M12 DoD). |
| **Definition of Done** | 1. All M8 tests pass. 2. `.intent.md` YAML parsing and schema validation against all required fields. 3. Skill application rejects on: missing required field, duplicate skill ID, invalid URL pattern, MCP server without `min_permission_tier`, `apply_permission` absent. 4. Successful application: registers skill in in-memory skill registry; sends `registerSkillScope` JSON-RPC to `data/sockets/broker.sock`; updates Call Inspector endpoint constraint list. 5. Skill removal: sends `deregisterSkillScope`; existing tokens not revoked; new tokens do not include removed scope. 6. Validation errors reported to administrator with the specific failing field. 7. All files in `src/skills/`. |
| **Jim's gate** | Jim approves merge after Security Reviewer and QA/QC sign off. |

---

### M19 — Skill Schema: Security Review and QA (Stream C)

| Field | Value |
|-------|-------|
| **ID** | M19 |
| **Stream** | C |
| **Component / Work** | Security review and QA/QC of the Skill Schema implementation |
| **Assigned role** | Security Reviewer, then QA/QC |
| **Sequencing constraints** | M18 (Developer) complete. |
| **Definition of Done** | **Security Reviewer:** Verifies that skill application is TD-ADMIN only; `.intent.md` validation cannot be bypassed; broker scope updates are atomic (no partial registration). Verdict: pass or fail. **QA/QC:** All M8 tests pass; retroactive application of `.intent.md` schema to all existing skills validates correctly; no regressions. QA verdict: pass or fail. |
| **Jim's gate** | Jim approves merge. |

---

### M20 — Memory Tiers: Developer Implementation (Stream D)

| Field | Value |
|-------|-------|
| **ID** | M20 |
| **Stream** | D |
| **Component / Work** | Implement all three Memory Tiers per memory-tiers-spec.md |
| **Assigned role** | Developer |
| **Sequencing constraints** | M9 (test suite) complete; M14 (Cato) must have `MEMORY_WRITE` check interface stable (it is, from M14 DoD). |
| **Definition of Done** | 1. All M9 tests pass. 2. **Tier 1:** `groups/{name}/CLAUDE.md` auto-creates empty on missing at spawn; `MEMORY_WRITE` Cato check before any orchestrator commit; orchestrator commits only on `allow: true`. 3. **Tier 2:** `groups/{name}/messages.db` auto-creates with normative schema and WAL mode on missing; three tables (`messages`, `sessions`, `tasks`) match memory-tiers-spec.md schema exactly; pruning applies to `messages` only; `sessions` and `tasks` rows retained indefinitely; `router_state` is NOT persisted (Decision 20). 4. **Tier 3:** `data/memory.db` with sqlite-vec extension; no bind-mount into containers; every write requires Call Inspector approval; rejects uncommitted write on `allow: false`. 5. `store/messages.db` central database layout removed (shed per IMPLEMENTATION_AUDIT.md); data migration path documented. 6. All files in `src/memory/`. |
| **Jim's gate** | Jim approves merge after Security Reviewer and QA/QC sign off. |

---

### M21 — Memory Tiers: Security Review and QA (Stream D)

| Field | Value |
|-------|-------|
| **ID** | M21 |
| **Stream** | D |
| **Component / Work** | Security review and QA/QC of the Memory Tiers implementation |
| **Assigned role** | Security Reviewer, then QA/QC |
| **Sequencing constraints** | M20 (Developer) complete. |
| **Definition of Done** | **Security Reviewer:** Verifies group isolation (container for group A has no mount path to group B Tier 1/Tier 2); Tier 3 `data/memory.db` not bind-mounted into any container; `MEMORY_WRITE` Cato approval gate is non-bypassable; audit trail for rejected writes exists. Verdict: pass or fail. **QA/QC:** All M9 tests pass; cross-group isolation verified; Tier 3 write rejection audit entry confirmed; retention window pruning leaves structural rows intact. QA verdict: pass or fail. |
| **Jim's gate** | Jim approves merge. |

---

### M22 — Orchestrator: Tests Written (Stream E)

| Field | Value |
|-------|-------|
| **ID** | M22 |
| **Stream** | E |
| **Component / Work** | Test suite for the Orchestrator v2, written against orchestrator-spec.md |
| **Assigned role** | Tester |
| **Sequencing constraints** | M13 (Token Broker stable interfaces confirmed), M15 (Cato stable interfaces confirmed), M19 (Skill Schema stable interfaces confirmed) — Developer does not need to start; stable **interfaces** (from specs and test suites) are sufficient. The Tester reads orchestrator-spec.md and the IPC schemas, not the implementations. |
| **Definition of Done** | Four test tiers written and committed to stream-E branch, all initially failing: 1. **Unit:** Per-group inbound message queue (one active task per group); security mode loading from `groups/{name}/config.json`; absent config uses deployment defaults; malformed config logs `config_parse_error` event and falls back to defaults; `issueToken` call includes correct `securityMode`; `revokeToken` called at task completion, TTL expiry, and Cato block; hansei inbox poll ingests valid reports; malformed reports moved to `data/hansei/quarantine/` + `hansei_parse_error` audit event + `quarantinedHanseiReports` health count increments; remote-control surface (TD-ADMIN) fails closed on bridge unreachable. 2. **Contract (IPC wire):** Normalized `InboundMessage` schema from channel adapter; sentinel protocol parsing (`---OPENGOLEM_OUTPUT_START---` … `---OPENGOLEM_OUTPUT_END---`); `catoEscalate` inbound JSON-RPC on `escalation.sock`; Cato check forwarding strips `escalationReason` and `inspectorCheck`, passes `contentExcerpt`. 3. **Integration:** Full task lifecycle (message in → token issued → container spawned → sentinel parsed → token revoked → outbound routed); Supervised mode confirm/cancel round-trip including 60-second timeout auto-cancel with `supervised_timeout` audit reason; Cato block halts task and revokes token. 4. **Stub detection:** Verify Cato block actually stops container spawn (test fails if stub always proceeds); verify missing broker socket queues messages rather than dispatching tasks. |
| **Jim's gate** | Jim reviews the test suite before the Developer starts. |

---

### M23 — Orchestrator: Developer Implementation (Stream E)

| Field | Value |
|-------|-------|
| **ID** | M23 |
| **Stream** | E |
| **Component / Work** | Implement Orchestrator v2 per orchestrator-spec.md, integrating all stable A/B/C interfaces |
| **Assigned role** | Developer |
| **Sequencing constraints** | M22 (test suite) complete; M13 (Token Broker interfaces stable), M15 (Cato interfaces stable), M19 (Skill Schema interfaces stable). Implementations need not be merged — interfaces (specs + test suites) are sufficient. |
| **Definition of Done** | 1. All M22 tests pass. 2. Orchestrator starts third (after Token Broker and Cato); performs health checks on both sockets before marking itself healthy. 3. Listens on `data/sockets/escalation.sock` for broker `catoEscalate` calls; forwards to `data/sockets/cato.sock`; returns Cato result to broker; strips `escalationReason` and `inspectorCheck` from forwarded request; passes `contentExcerpt` through (Decision 23). 4. Per-group `config.json` loading with `securityMode` and `assertiveness_level`; absent config uses defaults; malformed config logs event and falls back. 5. `ALEF_FLAG_DISPLAY_TAG` and `ALEF_BLOCKED_DISPLAY_TAG` injected into container environment from group config. 6. Supervised mode: soft-block signal routed to channel adapter; 60-second timeout fires `resolveSupervised(cancel)` with `supervised_timeout` audit reason. 7. Hansei inbox polled; malformed reports quarantined to `data/hansei/quarantine/`; health endpoint reports `quarantinedHanseiReports` count. 8. `MEMORY_WRITE` Cato check before every Tier 1 commit. 9. Startup creates `data/`, `data/sockets/`, `data/hansei/inbox/`, `data/hansei/quarantine/` if absent. 10. `remote-control.ts` bridge integrated; fail-closed if bridge unreachable (Decision 13). 11. Vestigial NanoClaw channel stubs (Slack, Discord, Gmail) removed from `src/channels/`. 12. All files in `src/orchestrator/`; no application files in `src/` root. |
| **Jim's gate** | Jim approves merge after Security Reviewer and QA/QC sign off. |

---

### M24 — Orchestrator: Security Review and QA (Stream E)

| Field | Value |
|-------|-------|
| **ID** | M24 |
| **Stream** | E |
| **Component / Work** | Security review and QA/QC of the Orchestrator v2 |
| **Assigned role** | Security Reviewer, then QA/QC |
| **Sequencing constraints** | M23 (Developer) complete. |
| **Definition of Done** | **Security Reviewer:** Reviews all trust domain crossings in `src/orchestrator/` against `ARCHITECTURE.md` §2 and §4. Specific checks: orchestrator never holds raw credentials; no path from TD-CONTAINER to TD-CATO exists in orchestrator code; escalation relay strips broker-internal fields before forwarding to Cato; `MEMORY_WRITE` gate is non-bypassable; security mode is loaded from group config (not from in-memory ad-hoc state). Verdict: pass or fail. **QA/QC:** All M22 tests pass; full task lifecycle integration test passes; Supervised timeout test passes; no regressions in existing suite. QA verdict: pass or fail. |
| **Jim's gate** | Jim reviews Security Reviewer verdict and QA verdict; approves merge. |

---

### M25 — Channel Adapters: Tests Written (Stream F — TUI)

| Field | Value |
|-------|-------|
| **ID** | M25 |
| **Stream** | F |
| **Component / Work** | Test suite for the TUI channel adapter, written against channel-adapters-spec.md |
| **Assigned role** | Tester |
| **Sequencing constraints** | M4 (UX Review: CLI and TUI) Jim-approved; M22 (Orchestrator test suite complete — inbound message interface stable). The Tester reads channel-adapters-spec.md and the Orchestrator's `InboundMessage` schema. |
| **Definition of Done** | Four test tiers for the TUI adapter, all initially failing: 1. **Unit:** readline input normalized to `InboundMessage` schema; health panel toggle (`Ctrl-D`) produces correct health endpoint poll; `ASSISTANT_NAME` display uses injected value. 2. **Contract:** `InboundMessage` fields match orchestrator-spec.md §2.1 schema exactly; health panel display reflects `quarantinedHanseiReports` count. 3. **Integration:** TUI adapter self-registers with channel registry at startup; outbound message routes to terminal from orchestrator. 4. **Stub detection:** Verify health panel shows degraded status when `quarantinedHanseiReports > 0` (test fails if stub always shows OK). |
| **Jim's gate** | Jim reviews test suite before Developer starts. |

---

### M26 — Channel Adapters: Tests Written (Stream F — Telegram)

| Field | Value |
|-------|-------|
| **ID** | M26 |
| **Stream** | F |
| **Component / Work** | Test suite for the Telegram channel adapter, written against channel-adapters-spec.md |
| **Assigned role** | Tester |
| **Sequencing constraints** | M4 (UX Review: CLI and TUI) Jim-approved; M22 (Orchestrator inbound message interface stable). |
| **Definition of Done** | Four test tiers for the Telegram adapter, all initially failing: 1. **Unit:** Telegram update event normalized to `InboundMessage`; `senderId` hashed to opaque internal ID; language metadata preserved from message; sender allowlist enforcement (orchestrator-level, not adapter-level — verify adapter passes through and orchestrator gates). 2. **Contract:** `InboundMessage` schema compliance; adapter `.intent.md` validates against skill-schema-spec.md rules; `network.endpoints` declares `https://api.telegram.org/*`. 3. **Integration:** Self-registers with channel registry at startup; outbound message formats to Telegram markdown and routes. 4. **Stub detection:** Verify sender not on allowlist results in message being dropped (at orchestrator level — test fails if always delivered). |
| **Jim's gate** | Jim reviews test suite before Developer starts. |

---

### M27 — Channel Adapters: Developer Implementation (Stream F — TUI + Telegram)

| Field | Value |
|-------|-------|
| **ID** | M27 |
| **Stream** | F |
| **Component / Work** | Implement TUI and Telegram channel adapters per channel-adapters-spec.md, incorporating M4 UX recommendations |
| **Assigned role** | Developer |
| **Sequencing constraints** | M25 and M26 (test suites) complete; M4 (UX Review TUI/CLI) Jim-approved; M24 (Orchestrator Developer) complete (stable inbound message interface in code). |
| **Definition of Done** | 1. All M25 and M26 tests pass. 2. TUI adapter: readline/PTY input handling; health panel split-pane with `Ctrl-D` toggle; health panel content ordered per M4 UX recommendations; `quarantinedHanseiReports` count displayed when non-zero; `ASSISTANT_NAME` injected; UX recommendations from M4 incorporated. 3. Telegram adapter: long-poll (not webhook) for v1.0; inbound update normalized to `InboundMessage`; `senderId` hashing; outbound markdown formatting; `TELEGRAM_VALID_USERS` allowlist enforced at orchestrator level (adapter passes through). 4. Each adapter ships with a valid `.intent.md` declaring type, token_scopes, network endpoints, apply_permission. 5. Vestigial NanoClaw Slack/Discord/Gmail channel code removed (if not already done in M23). 6. All files in `src/channels/tui/` and `src/channels/telegram/`. |
| **Jim's gate** | Jim approves merge after Security Reviewer and QA/QC sign off. |

---

### M28 — Channel Adapters: Security Review and QA (Stream F)

| Field | Value |
|-------|-------|
| **ID** | M28 |
| **Stream** | F |
| **Component / Work** | Security review and QA/QC of TUI and Telegram channel adapters |
| **Assigned role** | Security Reviewer, then QA/QC |
| **Sequencing constraints** | M27 (Developer) complete. |
| **Definition of Done** | **Security Reviewer:** Reviews `src/channels/tui/` and `src/channels/telegram/` against `ARCHITECTURE.md` ADR-6 and channel-adapters-spec.md invariants. Specific checks: adapters hold no credentials beyond in-process connection lifetime; bot token sourced from credential backend, not hardcoded; no business logic in adapters (routing decisions belong to orchestrator); `.intent.md` declarations match actual runtime behavior. Verdict: pass or fail. **QA/QC:** All M25 and M26 tests pass; end-to-end message delivery (send Telegram message → agent response returned to Telegram) passes in integration test; TUI health panel accurately reflects system state. QA verdict: pass or fail. |
| **Jim's gate** | Jim reviews Security Reviewer verdict and QA verdict; approves merge. |

---

### M29 — Dashboard Skill Spec (Stream C sub-item)

| Field | Value |
|-------|-------|
| **ID** | M29 |
| **Stream** | C |
| **Component / Work** | Behavioral specification for the dashboard skill |
| **Assigned role** | Spec Writer (preceded by Voice of Customer review) |
| **Sequencing constraints** | M5 (UX Review: Report Dashboard) Jim-approved. Inputs: M5 UX recommendations, cato-spec.md §2.2 (hansei report schema), audit-log-spec.md (event types and dao_score queries), `ARCHITECTURE.md` §5.4. |
| **Definition of Done** | `docs/specs/dashboard-skill-spec.md` produced covering: Responsibilities, External Interface (what data is surfaced and how), Behavioral Contract (KPI trend display, block history view, hansei report inbox, calibration decision flow, false-positive signal capture), Failure Modes, Invariants, Acceptance Criteria. Spec incorporates M5 UX recommendations. Does not declare MCP servers (Decision 29: MCP-declaring skills restricted to admin groups; dashboard does not require MCP). |
| **Jim's gate** | Jim approves the spec before Tester writes tests. |

---

### M30 — Dashboard Skill: Tests Written (Stream C)

| Field | Value |
|-------|-------|
| **ID** | M30 |
| **Stream** | C |
| **Component / Work** | Test suite for the dashboard skill, written against dashboard-skill-spec.md |
| **Assigned role** | Tester |
| **Sequencing constraints** | M29 (Dashboard skill spec) Jim-approved. |
| **Definition of Done** | Test suite committed, initially failing, covering: KPI trend display with synthetic audit log data; hansei report inbox renders correctly from report JSON; block history query returns correct events; calibration decision flow captures and persists administrator input; false-positive signal path logs to audit log; degraded health state (quarantined reports) surfaces in dashboard. |
| **Jim's gate** | Jim reviews test suite before Developer starts. |

---

### M31 — Dashboard Skill: Developer Implementation (Stream C)

| Field | Value |
|-------|-------|
| **ID** | M31 |
| **Stream** | C |
| **Component / Work** | Implement the dashboard skill per dashboard-skill-spec.md |
| **Assigned role** | Developer |
| **Sequencing constraints** | M30 (test suite) complete; M17 (Audit Log) merged (dashboard reads from `data/audit.db`); M15 (Cato) merged (dashboard reads hansei reports from `data/hansei/inbox/`). |
| **Definition of Done** | 1. All M30 tests pass. 2. Dashboard skill ships with valid `.intent.md`. 3. KPI trends computable from audit log without agent self-reports (ADR-9). 4. Hansei report inbox display renders all fields from cato-spec.md report schema. 5. Calibration decision flow: administrator can record a threshold change intent; it is written to the audit log (not auto-applied to PSYCHE.md — ADR-3). 6. All files in `src/skills/dashboard/`. |
| **Jim's gate** | Jim approves merge after Security Reviewer and QA/QC sign off. |

---

### M32 — Dashboard Skill: Security Review and QA (Stream C)

| Field | Value |
|-------|-------|
| **ID** | M32 |
| **Stream** | C |
| **Component / Work** | Security review and QA/QC of the dashboard skill |
| **Assigned role** | Security Reviewer, then QA/QC |
| **Sequencing constraints** | M31 (Developer) complete. |
| **Definition of Done** | **Security Reviewer:** Verifies no auto-recalibration path (ADR-3); no MCP server declarations; audit log reads are SELECT only; dashboard does not surface payload content (only hashes, risk classes, event types). Verdict: pass or fail. **QA/QC:** All M30 tests pass; Voice of Customer (VoC) review of dashboard output against real synthetic conversation data (assesses whether governance information is legible to the target user spectrum). QA verdict: pass or fail. |
| **Jim's gate** | Jim reviews Security Reviewer verdict, QA verdict, and VoC assessment; approves merge. |

---

### M33 — Supply-Chain Audit Phase 2 (Stream M)

| Field | Value |
|-------|-------|
| **ID** | M33 |
| **Stream** | M |
| **Component / Work** | Supply-Chain Audit Phase 2 — prepare for Phase 2 Rust crate structure |
| **Assigned role** | Supply-Chain Auditor |
| **Sequencing constraints** | M1 (Supply-Chain Audit Phase 1) complete; Phase 2 Rust crate structure draft must be available. Note: this milestone is the Phase 2 start gate for the Rust rewrite — it does not block any Phase 2 TypeScript development milestones, but it must complete before Phase 2 Rust work begins. |
| **Definition of Done** | `docs/supply-chain-audit-phase2.md` produced covering: 1. Dependency minimisation policy: each Rust crate dependency requires explicit justification. 2. Target crate dependency graph: identified minimal set for Orchestrator, Token Broker, and Cato components in Rust. 3. Container image pinning and scanning policy: base image must be pinned to digest (not tag), scanned on each rebuild, and the scanning tool and threshold specified. 4. Audit trail requirement: the crate graph at Phase 2 completion is a formal acceptance criterion alongside functional correctness. |
| **Jim's gate** | Jim approves dependency minimisation policy before Rust crate structure is finalised. |

---

## Phase 3 — Integration and Final Sign-Off

These milestones run after all Phase 2 component streams have passed QA and Security Review (M13, M15, M17, M19, M21, M24, M28, M32 all complete).

---

### M34 — End-to-End Integration: Wire Orchestrator to Real Token Broker and Cato

| Field | Value |
|-------|-------|
| **ID** | M34 |
| **Stream** | Integration |
| **Component / Work** | Wire the three long-lived processes together on a real host; validate startup order and health checks |
| **Assigned role** | Developer, QA/QC |
| **Sequencing constraints** | M24 (Orchestrator merged), M13 (Token Broker merged), M15 (Cato merged). |
| **Definition of Done** | 1. All three processes start in correct order (Token Broker → Cato → Orchestrator) without errors. 2. Orchestrator performs health checks on both `broker.sock` and `cato.sock` before marking itself healthy. 3. Health endpoint returns `status: ok` with all three component statuses green. 4. Task dispatched end-to-end: channel message → token issued → container spawned → sentinel parsed → token revoked → response routed. 5. Audit log contains a complete event trail for the end-to-end task: `message_received`, `cato_check`, `token_issued`, `container_spawn`, `task_complete`, `token_revoked`. |
| **Jim's gate** | Jim reviews the integration run report and audit log trail before M35 starts. |

---

### M35 — Sentinel Protocol Validation

| Field | Value |
|-------|-------|
| **ID** | M35 |
| **Stream** | Integration |
| **Component / Work** | End-to-end sentinel protocol validation: container output parsing, error cases, malformed output handling |
| **Assigned role** | QA/QC |
| **Sequencing constraints** | M34 complete. |
| **Definition of Done** | 1. Well-formed sentinel output parsed correctly. 2. Missing `---OPENGOLEM_OUTPUT_START---` marker: orchestrator records error, revokes token, does not crash. 3. Malformed JSON between markers: orchestrator records error, revokes token. 4. Output outside markers: discarded (not logged to audit log). 5. `newSessionId` field in sentinel output correctly stored to Tier 2. |
| **Jim's gate** | Jim reviews QA report. |

---

### M36 — Cato Fail-Closed Test

| Field | Value |
|-------|-------|
| **ID** | M36 |
| **Stream** | Integration |
| **Component / Work** | Verify Cato fail-closed behavior: all actions blocked when Cato socket is unreachable |
| **Assigned role** | QA/QC |
| **Sequencing constraints** | M34 complete. |
| **Definition of Done** | 1. When `data/sockets/cato.sock` is unavailable, no container is spawned. 2. Messages are queued, not dropped, while Cato is unavailable. 3. When Cato is restored, queued messages are processed in order. 4. Audit log contains a `cato_unavailable` (or equivalent) event for the unavailability period. 5. Health endpoint reflects Cato unavailability as `status: degraded`. 6. Result is identical across all security modes — fail-closed is not mode-dependent. |
| **Jim's gate** | Jim reviews QA report. |

---

### M37 — Audit Log Concurrent Writer Test

| Field | Value |
|-------|-------|
| **ID** | M37 |
| **Stream** | Integration |
| **Component / Work** | Verify audit log integrity under concurrent writers (all three processes writing simultaneously) |
| **Assigned role** | QA/QC |
| **Sequencing constraints** | M34 complete. |
| **Definition of Done** | 1. Run a workload with all three writers active simultaneously (multiple concurrent tasks in multiple groups). 2. No SQLite WAL errors or lock contentions recorded. 3. Post-workload integrity check: row count matches event count from each writer; no partial rows; `contextId` queries return complete event sets. 4. Event ordering within a `contextId` is temporally consistent (no timestamp inversions beyond clock resolution). |
| **Jim's gate** | Jim reviews QA report. |

---

### M38 — Voice of Customer: Real Conversation Review

| Field | Value |
|-------|-------|
| **ID** | M38 |
| **Stream** | Integration |
| **Component / Work** | Voice of Customer assessment of a real conversation through the integrated system |
| **Assigned role** | Voice of Customer |
| **Sequencing constraints** | M35 and M36 complete (system operational for real conversations). |
| **Definition of Done** | 1. A real conversation (task with at least one Cato gate, one token issuance, and one outbound response) is run through the system. 2. VoC session reviews: the `[BLOCKED]` or `[FLAG]` message as the user would see it; the explanation of the risk class (does it make sense to a non-technical user?); the Supervised mode confirmation prompt (if applicable); the health panel state during and after the task. 3. VoC produces a written assessment with specific usability findings and any `[BLOCKED]` message template revision recommendations. |
| **Jim's gate** | Jim reviews VoC assessment. Any blocking UX findings are addressed before M39. |

---

### M39 — Final Security Reviewer Sign-Off

| Field | Value |
|-------|-------|
| **ID** | M39 |
| **Stream** | Integration |
| **Component / Work** | Final Security Reviewer sign-off across all components and the integrated system |
| **Assigned role** | Security Reviewer |
| **Sequencing constraints** | M34, M35, M36, M37, M38 all complete; M1 (Supply-Chain Audit Phase 1) Jim-approved; M11 (DevOps Hardening Guidance) Jim-approved; M2 (Cybersecurity Specialist) Jim-approved findings either resolved or explicitly accepted. |
| **Definition of Done** | Security Reviewer produces `docs/security-sign-off-v1.md` covering: 1. Confirmation that all ten `SECURITY_STRENGTHENING.md` findings are either resolved (ADR produced, spec updated, implementation verified), explicitly accepted with PM sign-off recorded, or deferred to Phase 2 with milestone placement in this plan. 2. Trust domain crossing review across the integrated system — no unintended paths discovered. 3. Supply-chain audit Phase 1 findings incorporated. 4. DevOps hardening guidance incorporated into deployment documentation. 5. Overall security verdict: ready for v1.0 release or blocking issues listed. |
| **Jim's gate** | Jim reviews and approves the final security sign-off. This is the final gate before v1.0 is declared complete. |

---

## Dependency Graph Summary

```
UNBLOCKED NOW (no prerequisites):
  M1  Supply-Chain Audit Phase 1          (Stream L)
  M2  Cybersecurity Specialist Review     (Stream G)
  M3  UX Review: Setup/Onboarding         (Stream I)
  M4  UX Review: CLI/TUI                  (Stream J)
  M5  UX Review: Dashboard                (Stream K)
  M6  Token Broker: Tests Written         (Stream A)
  M7  Cato: Tests Written                 (Stream B)
  M8  Skill Schema: Tests Written         (Stream C)
  M9  Memory Tiers: Tests Written         (Stream D)
  M10 Audit Log: Tests Written            (cross-cutting)

AFTER M2 (Jim-approved):
  M11 DevOps Hardening Guidance           (Stream H)

AFTER M6:
  M12 Token Broker: Developer             (Stream A)

AFTER M12:
  M13 Token Broker: Security Review + QA  (Stream A)

AFTER M7:
  M14 Cato: Developer                     (Stream B)

AFTER M14:
  M15 Cato: Security Review + QA          (Stream B)

AFTER M10 + M12 (started) + M14 (started):
  M16 Audit Log: Developer                (cross-cutting)

AFTER M16:
  M17 Audit Log: Security Review + QA     (cross-cutting)

AFTER M8 + M13 (broker interfaces stable):
  M18 Skill Schema: Developer             (Stream C)

AFTER M18:
  M19 Skill Schema: Security Review + QA  (Stream C)

AFTER M9 + M15 (Cato interfaces stable):
  M20 Memory Tiers: Developer             (Stream D)

AFTER M20:
  M21 Memory Tiers: Security Review + QA  (Stream D)

AFTER M13 + M15 + M19 (interfaces stable):
  M22 Orchestrator: Tests Written         (Stream E)

AFTER M22:
  M23 Orchestrator: Developer             (Stream E)

AFTER M23:
  M24 Orchestrator: Security Review + QA  (Stream E)

AFTER M4 (Jim-approved) + M22 (inbound interface stable):
  M25 TUI Adapter: Tests Written          (Stream F)
  M26 Telegram Adapter: Tests Written     (Stream F)

AFTER M25 + M26 + M4 (Jim-approved) + M24 (Orchestrator merged):
  M27 Channel Adapters: Developer         (Stream F)

AFTER M27:
  M28 Channel Adapters: Security Review + QA (Stream F)

AFTER M5 (Jim-approved):
  M29 Dashboard Skill Spec                (Stream C)

AFTER M29 (Jim-approved):
  M30 Dashboard Skill: Tests Written      (Stream C)

AFTER M30 + M17 + M15:
  M31 Dashboard Skill: Developer          (Stream C)

AFTER M31:
  M32 Dashboard Skill: Security Review + QA (Stream C)

AFTER M1 complete + Phase 2 Rust structure available:
  M33 Supply-Chain Audit Phase 2          (Stream M)

PHASE 3 — after M13, M15, M17, M19, M21, M24, M28, M32 all merged:
  M34 End-to-End Integration
  M35 Sentinel Protocol Validation        (after M34)
  M36 Cato Fail-Closed Test               (after M34)
  M37 Audit Log Concurrent Writer Test    (after M34)
  M38 VoC: Real Conversation Review       (after M35 + M36)
  M39 Final Security Reviewer Sign-Off    (after M34–M38 + M1 + M11 + M2 all complete)
```

---

## File Structure Compliance

Per TEAM.md Developer role rules (enforced by convention):

| Component | Source directory |
|-----------|-----------------|
| Token Broker + Call Inspector | `src/broker/`, `src/inspector/` |
| Cato | `src/cato/` |
| Orchestrator | `src/orchestrator/` |
| Memory Tiers | `src/memory/` |
| Skill Schema + Lifecycle | `src/skills/` |
| Dashboard Skill | `src/skills/dashboard/` |
| Channel Adapters | `src/channels/tui/`, `src/channels/telegram/` |
| Shared types and utilities | `src/shared/` |
| Audit Log (write interface) | `src/shared/audit/` |

No application source files may be created in `src/` root. Test files live alongside the source they test (`src/broker/token-broker.test.ts` tests `src/broker/token-broker.ts`).

---

## Open Items for Jim's Review

1. **M33 timing:** Stream M (Supply-Chain Audit Phase 2) depends on a Phase 2 Rust crate structure draft. This milestone does not block any Phase 2 TypeScript work — it is sequenced as a Phase 2 start gate for the Rust rewrite. Jim should confirm whether M33 belongs in this plan or in a separate Phase 2 plan.

2. **Teams and WhatsApp adapters:** Decision 30 scopes v1.0 to TUI + Telegram. Channel adapters spec covers all four channels. Teams and WhatsApp are optional skills with `apply_permission: admin`. This plan includes no milestone for Teams or WhatsApp adapter Developer work in Phase 2 — only the spec (already written). If Jim wants Teams or WhatsApp for v1.0, milestones M25/M26/M27/M28 pattern should be repeated for each.

3. **F-9 risk acceptance (MCP permission tier):** Decision 29 records PM acceptance for Phase 1. This plan contains no milestone for MCP permission tier enforcement — it is explicitly Phase 2. Jim should confirm this scope decision is still current before M39 closes.

4. **F-3 (audit log integrity — HMAC chain):** The Cybersecurity Specialist review (M2) will produce a recommendation. If the recommendation is Phase 2, M39 must record this as a formal Phase 2 commitment, not an open item.

---

*End of PLAN_V1.md — awaiting PM approval.*
