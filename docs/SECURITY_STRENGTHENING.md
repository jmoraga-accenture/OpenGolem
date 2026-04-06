# OpenGolem — Security Strengthening Document
*Produced: 2026-04-05 | Status: Approved — canonical project document (Decision 28)*
*Prepared by: AI-assisted architectural review against ARCHITECTURE.md v1.0, behavioral specs, and IMPLEMENTATION_AUDIT.md*

---

## Purpose and Scope

This document identifies architectural and specification-level security gaps in OpenGolem that are not addressed by the current design. It is explicitly **not** about implementation debt — the gap between the current TypeScript baseline and the target architecture is tracked separately in IMPLEMENTATION_AUDIT.md. The findings here concern gaps in the **philosophy, architecture, and specifications** themselves: places where the design, even if fully implemented as written, would leave security or responsible AI concerns unaddressed.

Each finding includes a severity rating, the discipline primarily responsible for resolution, and a recommended action. Findings are organised by theme rather than severity to support coherent team discussion.

---

## Recommended Reviewers

TEAM.md defines the current team as Jim (PM, Voice of Customer, final merge authority) and Claude Code executing all technical roles. In April 2026, frontier models are capable of filling any specialist role with appropriate Human-in-the-Loop oversight from Jim. The question is therefore not which roles require a human practitioner, but which roles require a distinct specialist context — whether that specialist is a human or a frontier model operating in a scoped session.

The following roles are recommended for this work, each requiring Jim's HitL review and approval of outputs before findings are acted upon.

**Cybersecurity Specialist (frontier model, scoped session).** The primary reviewer for F-1 through F-4. The session should be scoped with the full ARCHITECTURE.md, the behavioral specs, and this document as input, and tasked specifically with threat modelling the inbound transport surface, the credential proxy binding, the audit log integrity model, and the in-process adapter supply-chain risk. Classic application security framing is insufficient for F-3 and F-4; the session prompt must establish agentic system threat context explicitly.

**DevOps / Systems Administrator (frontier model, scoped session).** Responsible for producing the deployment hardening annex and operational runbooks for F-5, F-6, and F-8. Input should include the architecture's process model, the Token Broker spec, and the Orchestrator spec. Output should be a concrete hardening checklist and credential rotation runbook suitable for inclusion in the deployment documentation.

**UX / Interaction Designer (frontier model, scoped session).** Three distinct UX surfaces exist in OpenGolem and each warrants specialist attention.

The first is the setup and onboarding experience — the sequence of steps an operator follows from cloning the repository to a running, correctly configured system. The current documentation addresses this technically but has not been reviewed for the cognitive load it places on a non-expert operator, which is a stated design goal of the project.

The second is the CLI and TUI interaction model. The TUI health dashboard, the `opengolem>` prompt, the health panel toggle, and the administrative command surface all constitute an interaction design problem that benefits from structured UX review — information hierarchy, progressive disclosure, error message clarity, and the legibility of security state.

The third is the Report Dashboard skill, which is the primary governance interface for administrators and the mechanism through which human calibration judgment is exercised (ADR-3). Given that the dashboard surfaces KPI trends, block history, hansei findings, and threshold change recommendations, its information design directly affects the quality of human oversight decisions. This is arguably the highest-consequence UX surface in the system from a responsible AI standpoint.

**PM (Jim — HitL authority).** Scope and prioritisation decisions, Phase 1 versus Phase 2 risk acceptance sign-offs (particularly F-7 and F-9), and final approval of all outputs from the specialist sessions above. The security remediation work identified here represents a material addition to the v1.0 scope as currently defined in PM_BRIEF.md and should be explicitly sequenced against the existing milestone plan before specialist sessions are commissioned.

---

## Findings

---

### F-1 — Inbound Transport Security Is Unspecified
**Severity:** High
**Discipline:** Cybersecurity / DevOps
**Source:** `channel-adapters-spec.md`; `ARCHITECTURE.md` §4.1

The architecture specifies TLS for all outbound calls from the Token Broker to external LLM providers. It does not specify the transport security posture for inbound connections. The Microsoft Teams adapter requires a locally-bound HTTP endpoint to receive Bot Framework activity payloads. Whether this endpoint should require TLS, how it should be exposed (localhost-only, reverse-proxied, tunnelled), and what authentication it should perform on inbound payloads are all unspecified.

For deployments where the host is reachable from the internet — which is the normal case for a self-hosted Telegram or WhatsApp assistant — the absence of guidance on inbound exposure creates a meaningful attack surface. An unauthenticated HTTP endpoint receiving Bot Framework payloads is an injection vector that bypasses all Call Inspector and Cato checks, because those checks apply to agent-originated outbound calls, not to inbound message delivery.

**Recommended action:** The architecture should specify that (a) the Teams Bot Framework endpoint is bound to localhost only and exposed via a reverse proxy (nginx, Caddy) with TLS termination and Bot Framework signature verification; (b) all webhook endpoints include payload signature validation using channel-provider-issued secrets before delivery to the orchestrator; (c) a network hardening annex is added to the deployment documentation specifying firewall posture for each channel type.

---

### F-2 — Credential Proxy HTTP Binding Is Unspecified
**Severity:** High
**Discipline:** Cybersecurity / DevOps
**Source:** `token-broker-spec.md` §4.5; `ARCHITECTURE.md` §4.5

The Token Broker proxies outbound LLM calls over HTTP. Agent containers point their `ANTHROPIC_BASE_URL` environment variable at this proxy. The specifications do not state what interface the proxy binds to, whether it should be restricted to the Docker bridge network, or whether TLS is required between container and proxy.

This matters because if the proxy binds to `0.0.0.0` or any externally reachable interface, any process with network access to the host — not just spawned containers — can present a derivative token and make proxied calls. The derivative token model provides the primary defence, but a misconfigured binding enlarges the attack surface unnecessarily.

Unix sockets are already used for all host-to-host IPC (orchestrator ↔ broker, orchestrator ↔ Cato). The container-to-proxy HTTP channel is the one remaining surface that uses TCP, and it is unspecified.

**Recommended action:** The Token Broker spec should explicitly require the credential proxy to bind to the Docker bridge network interface only (not `0.0.0.0`), document the expected Docker network configuration, and specify whether TLS is required for the container-to-proxy hop. An alternative — moving the container-to-proxy communication to a Unix socket shared via bind mount — should be evaluated as a Phase 2 option.

---

### F-3 — Audit Log Has No Cryptographic Integrity Protection
**Severity:** High
**Discipline:** Cybersecurity / MLSecOps
**Source:** `ARCHITECTURE.md` §3.7; `cato-spec.md` §3 (scheduled audit)

The unified audit log is enforced as append-only at the write interface level. No component is permitted to issue UPDATE or DELETE against it. This is correct policy — but it is enforced purely in application code, not at the storage layer. The log is a SQLite file on the host filesystem. An attacker with host filesystem access, a compromised process running as the service user, or a rogue administrator can truncate, replace, or selectively delete records from the file directly, without going through the application write interface.

This gap is particularly significant because Cato's scheduled audit reads the log directly via SQLite and derives dao_score KPIs and hansei findings from it. If the log is tampered with, Cato's governance outputs are based on falsified data — silently, with no detection mechanism. The responsible AI story depends on Cato being trustworthy; Cato's trustworthiness depends on the integrity of what it reads.

**Recommended action:** The architecture should specify a tamper-evidence mechanism for the audit log. Options in ascending cost: (a) append a per-entry HMAC chain using a key held separately from the log (each entry's HMAC covers its own content plus the previous entry's HMAC, making retroactive modification detectable); (b) periodically export signed log digests to an append-only external store (e.g. a git repository, an S3 object with object lock, a separate host); (c) use a write-once filesystem feature (Linux `chattr +a`). Option (a) is the lowest-friction starting point and should be specified for Phase 2 at minimum.

---

### F-4 — In-Process Adapter Supply-Chain Risk Is Accepted Without Mitigation Controls
**Severity:** High
**Discipline:** Cybersecurity / MLSecOps
**Source:** `ARCHITECTURE.md` ADR-6; `channel-adapters-spec.md` §invariants

ADR-6 explicitly accepts that a compromised in-process channel adapter has orchestrator-level access, classifying this as a supply-chain attack outside OpenGolem's security boundary. The OpenClaw ecosystem has already demonstrated that this threat class is real and actively exploited: Cisco documented a popular ClawHub skill silently exfiltrating users' complete Discord message histories.

The acceptance of this risk is architecturally honest, but the architecture provides no mitigating controls. The `.intent.md` schema declares network endpoints and filesystem paths, but these are advisory declarations validated at skill application time — they do not constrain what Node.js modules an adapter imports at runtime, what network connections it opens directly (as opposed to via the credential proxy), or what host data it can read from within the orchestrator process.

**Recommended action:** The architecture should add the following mitigation layers, even if implemented progressively: (a) specify that channel adapter skills must be sourced only from the canonical repository or administrator-audited sources, with this requirement documented as a deployment obligation; (b) evaluate Node.js `--permission` flag (available since Node 20) to restrict filesystem and network access at the process level; (c) specify that adapter-to-channel-provider connections (which are direct host connections, not routed through the credential proxy) must be declared in `.intent.md` and that undeclared outbound connections from the orchestrator process are logged as anomalies; (d) consider whether high-privilege channel adapters should eventually be moved out-of-process, accepting the serialisation cost.

---

### F-5 — Token Store Crash Leaves Orphaned Containers
**Severity:** Medium
**Discipline:** Cybersecurity / DevOps
**Source:** `token-broker-spec.md` §Responsibilities; `DECISIONS.md` Decision 16

The token store is intentionally in-memory and does not persist across restarts — tokens issued before a restart are invalid after it. This is correct for security (no stale tokens survive a crash). However, the failure behaviour for mid-task broker restarts is unspecified. A container running a task when the broker crashes holds a token the broker no longer recognises. Its next proxied call returns HTTP 403. The container cannot complete its work, but it is still alive, consuming resources, holding filesystem write locks, and running until its TTL fires.

The orchestrator's failure-handling spec covers broker-unreachable at task start but does not specify detection of or recovery from mid-task broker loss.

**Recommended action:** The orchestrator spec should define a mid-task broker loss detection and recovery path: (a) the orchestrator should detect broker socket unavailability on a short polling interval during active tasks; (b) on detected loss, active containers should be torn down immediately rather than left to TTL expiry; (c) the token revocation obligation should be noted as non-enforceable in this scenario and the audit log entry should record the broker-loss-induced teardown. The deployment documentation should specify process supervision (systemd, launchd) restart policy for the broker, with a target restart time below the shortest expected task TTL.

---

### F-6 — No Inbound Message Rate Limiting
**Severity:** Medium
**Discipline:** Cybersecurity / MLSecOps
**Source:** `orchestrator-spec.md` §3.2

The Call Inspector includes call rate anomaly detection on outbound proxied calls (Check 4). There is no equivalent control at the inbound message level. The per-group queue accepts messages without bound. A user — or a compromised channel delivering injected messages — can exhaust host memory by filling the queue. The sender allowlist mitigates this for known bad actors, but there is no per-sender rate limit, no queue depth limit with back-pressure, and no alerting on anomalous inbound volume.

For LLM workloads this is particularly relevant because each queued message will eventually trigger a container spawn with associated memory, CPU, and API credit consumption. Queue depth is therefore a proxy for unbounded resource consumption, not just a memory concern.

**Recommended action:** The orchestrator spec should define: (a) a configurable per-sender message rate limit (default: N messages per minute, with excess silently queued or dropped and logged); (b) a per-group queue depth maximum with back-pressure signalling back to the channel adapter; (c) an audit log event on queue depth threshold breach. The dao_score KPI set should be extended to include an inbound anomaly rate metric computable from these log events.

---

### F-7 — Self-Hosted Model Deployments: Safety Posture Gap Is Underdocumented
**Severity:** Medium
**Discipline:** MLSecOps / Responsible AI
**Source:** `ARCHITECTURE_REVIEW.md` R2; `DECISIONS.md` Decision 8; `token-broker-spec.md` §4.6

ADR-7 correctly notes that Ollama and `custom` provider deployments bypass any upstream safety filters the cloud provider would apply, and states that "Cato's inline checks carry more weight in self-hosted deployments." This observation appears in the Architecture Review document and the Architect Brief. It does not appear in PSYCHE.md, the deployment documentation, the skill schema spec, or any in-product surface an operator would encounter when enabling a local model.

An operator who configures Ollama receives no in-product guidance that their Cato configuration now constitutes the entire safety envelope with no upstream backstop. In Phase 1, where Cato's inline checks are deterministic stubs (path traversal and oversized payload only), a self-hosted model deployment has materially weaker safety coverage than an Anthropic-backed one. This is a responsible AI disclosure gap.

**Recommended action:** (a) The skill schema for `providers.compatible: [ollama]` or `custom` should trigger an explicit administrator acknowledgement at skill application time, surfacing the reduced upstream filter coverage; (b) PSYCHE.md should include a section specifying that self-hosted deployments warrant elevated Cato scrutiny thresholds; (c) the deployment documentation should include a "Safety posture by provider" section making this explicit. The Phase 2 LLM escalation path in Cato becomes especially important for self-hosted deployments and should be prioritised accordingly.

---

### F-8 — No Credential Rotation Procedure
**Severity:** Medium
**Discipline:** DevOps / Cybersecurity
**Source:** `DECISIONS.md` Decision 8; `token-broker-spec.md` §Responsibilities

The architecture specifies three credential backends (`.env`, Bitwarden, OneCLI) and the Token Broker's resolution and derivative token model. It does not specify what happens when a long-lived credential is rotated — for example, when an Anthropic API key is cycled on a schedule, a Bitwarden vault credential is updated, or a token is revoked following a suspected compromise.

Specifically unspecified: whether the broker detects credential changes without a restart, whether in-flight derivative tokens continue to function after the underlying credential changes, and what the operator procedure is for emergency credential rotation (suspected key leak). For a system designed to be safe for non-technical users, the absence of an emergency rotation runbook is an operational gap that could result in credential exposure continuing beyond the point of detection.

**Recommended action:** The Token Broker spec should define credential rotation behaviour: (a) for planned rotation, the broker re-reads the backend on a configurable polling interval so that rotated credentials take effect without a full restart; (b) for emergency rotation, a `rotateCredential` JSON-RPC method (or equivalent CLI command) triggers immediate backend re-read and optional revocation of all in-flight derivative tokens; (c) the deployment documentation should include an emergency rotation runbook with time-to-rotation targets for each backend type.

---

### F-9 — MCP Permission Tier Enforcement Is Phase 2 With No Interim Controls
**Severity:** Medium
**Discipline:** Cybersecurity / MLSecOps
**Source:** `ARCHITECTURE_REVIEW.md` R6; `skill-schema-spec.md` §MCP block

The `.intent.md` schema correctly includes a `min_permission_tier` field for MCP server declarations. Enforcement of this field — verifying that the triggering user has sufficient permission tier to authorise an MCP call — is deferred to Phase 2. During Phase 1, a lower-tier team member can instruct Alef to take an action that causes an MCP call to an enterprise system (code repository, project management, knowledge base) for which they would not otherwise have authorisation.

This gap is bounded in Phase 1 by the fact that MCP connections must be declared in `.intent.md` and approved by an administrator. However, administrator approval of a skill does not imply approval of every user invoking every MCP scope that skill declares.

**Recommended action:** The orchestrator spec and the skill schema spec should document this as a known Phase 1 limitation with explicit risk acceptance by the PM, visible to deploying administrators. In the interim, the recommended mitigation is to restrict MCP-declaring skills to administrator-only groups until Phase 2 permission tier enforcement is implemented. This should be stated as a deployment guidance item, not left implicit.

---

## Summary Table

| # | Finding | Severity | Primary Discipline | Phase |
|---|---|---|---|---|
| F-1 | Inbound transport security unspecified | High | Cybersecurity / DevOps | v1.0 |
| F-2 | Credential proxy HTTP binding unspecified | High | Cybersecurity / DevOps | v1.0 |
| F-3 | Audit log has no cryptographic integrity protection | High | Cybersecurity / MLSecOps | Phase 2 min. |
| F-4 | In-process adapter supply-chain risk — no mitigating controls | High | Cybersecurity / MLSecOps | v1.0 (partial) |
| F-5 | Token store crash leaves orphaned containers | Medium | Cybersecurity / DevOps | v1.0 |
| F-6 | No inbound message rate limiting | Medium | Cybersecurity / MLSecOps | v1.0 |
| F-7 | Self-hosted model safety posture underdocumented | Medium | MLSecOps / Responsible AI | v1.0 |
| F-8 | No credential rotation procedure | Medium | DevOps / Cybersecurity | v1.0 |
| F-9 | MCP permission tier enforcement deferred — no interim controls | Medium | Cybersecurity / MLSecOps | Phase 1 documented risk |

---

---

### F-10 — External Dependency Surface Is an Unaddressed Systemic Risk
**Severity:** High
**Discipline:** Cybersecurity / Architecture
**Source:** `DECISIONS.md` Decision 7; `README.md`; `ECOSYSTEM.md`; `IMPLEMENTATION_AUDIT.md`

OpenGolem's Phase 1 host-side system runs entirely within a single Node.js process. This creates three distinct but related dependency risk surfaces that are not addressed anywhere in the current architecture or specifications.

The first is the Node.js runtime itself. The V8 engine and libuv underpin every host-side process — the orchestrator, Token Broker, Cato, and all channel adapters. Any vulnerability in the Node.js runtime is inherited unconditionally, with no mitigation available at the application layer. The npm ecosystem is among the most frequently targeted in supply-chain attacks; the Node.js runtime has itself been subject to compromise. Neither OpenGolem's trust domain model nor its Call Inspector gates apply below the application layer.

The second is the npm transitive dependency tree. Grammy (Telegram), Baileys (WhatsApp), better-sqlite3, the Claude Agent SDK, and their transitive dependencies constitute a package graph OpenGolem does not control or audit. A malicious or compromised package anywhere in that graph executes within TD-ORCHESTRATOR with full access to the in-memory token store, the Unix sockets, and the group filesystem. The `.intent.md` skill schema gates what administrator-applied skills can declare — it does not gate what the core orchestrator imports. This is structurally identical to the vector that caused the documented OpenClaw ClawHub exfiltration incident, applied one level closer to the security-critical components.

The third is the agent container image. The container runs an OS base image plus the Claude Agent SDK and their dependencies. This surface is isolated by the container boundary but is still outside OpenGolem's direct control.

MicroClaw and PicoClaw both reduce this risk class structurally — MicroClaw via a compiled Rust binary with a small, auditable crate dependency tree; PicoClaw via a single self-contained Go binary with zero runtime dependencies. Neither eliminates supply-chain risk, but both reduce the dependency graph by an order of magnitude and eliminate the npm ecosystem as an attack vector. ECOSYSTEM.md explicitly records Rust as an architectural takeaway for OpenGolem's Phase 2 rewrite, and DECISIONS.md Decision 7 commits to it. However, neither document frames the dependency surface as a security concern — the Rust rewrite is currently motivated by performance and auditability, not by supply-chain risk reduction.

The gap is not that the Rust rewrite is absent — it is planned and correctly sequenced. The gap is twofold: the Phase 1 TypeScript baseline has no dependency auditing process specified, and the Phase 2 Rust rewrite has no explicit requirement to minimise the crate dependency surface as a security objective.

**Recommended action:** Three actions are required across the two phases. For Phase 1, a dependency audit process should be specified — at minimum, `npm audit` enforced in CI with a zero-high-severity policy, and a locked `package-lock.json` with integrity verification on install. This does not eliminate the risk but makes regressions detectable. For Phase 2, the Rust rewrite specification should include an explicit dependency minimisation objective: each crate dependency should require justification, and the target dependency graph should be defined as an acceptance criterion alongside functional correctness. The architecture should also specify a container image pinning and scanning policy for the agent container base image, independent of the host-side rewrite.

---

## What Is Not a Gap

For completeness, the following are intentional architectural decisions, not omissions, and should not be reopened without a new ADR:

- **No web UI.** TUI-only management is a deliberate minimalism decision (ARCHITECTURE_REVIEW.md R1). A web UI would add an inbound HTTP attack surface.
- **No message broker or service mesh.** Complexity reduction is intentional. The Unix socket IPC model is simpler and harder to misconfigure than a distributed message bus.
- **Cato has no auto-recalibration.** ADR-3 explicitly prohibits threshold auto-adjustment. This is a responsible AI decision: calibration signals must come from outside the system, not from the system optimising against its own safety metrics.
- **Token store does not persist across restarts.** This is intentional. The security benefit (no stale tokens survive a crash) is worth the operational cost of container invalidation on restart.
- **Cato LLM escalation deferred to Phase 2.** Decision 12 explains the rationale: the deterministic stub is correct for Phase 1 while Cato's context (PSYCHE.md, audit history) stabilises. This is not a gap — it is a phased approach with a documented upgrade path.

---

## Recommended Next Steps

The PM should drive the following before v1.0 scope is finalised:

1. **Engage a cybersecurity specialist** with LLM/agentic systems experience to independently validate F-1 through F-4. These findings represent the highest-severity gaps and benefit from external review before the architecture is locked.
2. **Add F-1, F-2, F-5, F-6, and F-8 to the v1.0 spec backlog** as ADR-producing items. Each requires a decision record before the relevant spec (Token Broker, Orchestrator, Channel Adapters) is finalised.
3. **Obtain PM risk-acceptance sign-off on F-9** (MCP permission tier enforcement) as a documented Phase 1 limitation before any MCP-declaring skill is shipped.
4. **Schedule F-3 (audit log integrity) and F-4 (adapter supply-chain mitigations) for Phase 2** with explicit milestone placement — these should not be indefinitely deferred.
5. **Update the deployment documentation** to incorporate the responsible AI disclosures required by F-7 and the operational runbooks required by F-8 before any external deployment is made.

---

*This document is a living record. Findings should be updated to Resolved when the corresponding ADR is produced and the relevant spec is updated. Findings should not be closed by implementation alone — the architectural specification must be updated first.*
