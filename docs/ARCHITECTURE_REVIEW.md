# OpenGolem — Architectural Review v1.0
*Produced: 2026-04-05*

This document records a first-principles review of OpenGolem's philosophical underpinning triggered by the completion of M9 and the NanoClaw lineage clearance. NanoClaw, MicroClaw, and OpenClaw each had a clear philosophical stance that shaped their technical decisions. This review makes OpenGolem's stance explicit and resolves inherited assumptions that no longer fit.

Six propositions are examined. Each is evaluated against the current spec, existing decisions are confirmed or updated, and implications for implementation are recorded.

---

## Review Outcome Summary

| # | Proposition | Verdict | Action |
|---|---|---|---|
| R1 | Minimalism stays | Affirmed | No change to P1/P2 |
| R2 | Claude-preferred, not Claude-only | Adopted | Updates SPECS.md §3, §5.1; new Decision 13 |
| R3 | IPC as the explicit security boundary | Adopted | Updates SPECS.md §4, new security principle; new Decision 14 |
| R4 | Cato as neurosymbolic; Alef as neural | Adopted — clarifies, doesn't change code | Updates SPECS.md §7; Decision 10 extended |
| R5 | Name is a parameter; roles are fixed | Adopted | Lightweight doc/config change; M8 note |
| R6 | Alef for teams — subagents and MCP governance | Adopted | Scoped to M8 + Phase 2; no immediate implementation |

---

## R1 — Minimalism Stays

**Proposition:** OpenGolem's minimalism is a feature, not a constraint. P2 ("Codebase small enough to audit in one sitting") and the "three integrations done correctly beats fifty done poorly" stance are not up for revision.

**Assessment:** Affirmed without qualification. Every architectural addition in this review must be tested against minimalism: does it require more code than the value it delivers? If yes, defer or descope.

The multi-model and multi-agent additions (R2, R6) are particularly at risk here. The principle of containment applies: feature scope lives in Skills and configuration; the core grows only when there is no alternative.

**What changes:** Nothing. The principle is reaffirmed.

---

## R2 — Claude-Preferred, Not Claude-Only

**Proposition:** SPECS.md §11 already says multi-model routing is "Supported." But the implementation — the Claude Agent SDK running inside every container — makes Claude the only runtime in practice. The proposal is to make the provider-agnostic commitment structural, not aspirational. Self-hosted (Ollama, LM Studio), OpenRouter, and other vendor backends should be first-class options, not afterthoughts.

**Why this matters:**
- **Safety by design for power users:** A user who routes sensitive tasks to a local model never sends that data to any external endpoint. This is a stronger privacy posture than "we don't log your data."
- **Enterprise posture:** Enterprise deployments that cannot send data to Anthropic (air-gapped, regulated, on-prem) need a credible path. "Claude-preferred" signals this is designed-in, not bolted on.
- **Resilience:** Dependence on one vendor is a single point of failure for uptime and pricing.

**Current state:**
- SPECS.md §3 stack table: "Anthropic Claude Agent SDK in containers" — implies Claude-only.
- SPECS.md §11: "Multi-model routing: Supported" — but no architecture for it.
- Token Broker: issues credentials to Anthropic API. Extension to other providers not designed.
- PLAN.md: "Anthropic Claude Agent SDK in containers: Keep" — inherits this assumption.

**Decision:** The container runtime is provider-agnostic by design. The Claude Agent SDK is the **default runner** — it is the best-integrated option and the one used unless the operator configures otherwise. Other providers are supported through a documented extension point.

**Architecture:**

The Token Broker's credential backend interface already abstracts over secret sources. The same abstraction is extended to cover *provider endpoints*:

```
Provider configuration (per group, or system-wide default):
  provider: anthropic | openrouter | ollama | custom
  model: <model-id>
  endpoint: <URL>  (optional; for custom/ollama)
  credential_key: <Token Broker key reference>
```

The container runner injects the appropriate env vars for the configured provider. The agent inside the container adapts via a thin provider shim. For Claude Agent SDK (Anthropic), no change. For other providers, the shim translates the SDK call to the provider's API format.

**Implications:**
- Token Broker must be able to hold and inject non-Anthropic credentials. The backend interface extends: each credential entry declares a `provider_type`.
- The Call Inspector's endpoint scope check must validate against the *configured* provider endpoint, not a hardcoded Anthropic URL.
- SPECS.md §3 is updated: "Agent runtime: Claude Agent SDK (default); provider-agnostic via configuration."
- Security consideration: self-hosted models bypass Anthropic's safety filters. PSYCHE.md should note that Cato's inline checks carry more weight in self-hosted deployments because there is no upstream filter.
- M8 (Skill Schema): `.intent.md` must declare which providers a skill is compatible with. A skill that uses Anthropic-specific features (e.g., extended thinking) must declare that dependency.

**What this is not:** A model-routing layer that selects the cheapest model per query. That may be a future skill. The base architecture is about operator configuration of a preferred provider, not runtime load-balancing.

---

## R3 — IPC as the Explicit Security Boundary

**Proposition:** The current spec describes IPC as an implementation convenience ("filesystem-based, simple, inspectable"). The proposal is to elevate IPC to the primary architectural organizing principle: every component boundary is an IPC boundary, and IPC security is what the system's security argument rests on.

**Why this matters:**

NanoClaw's architecture works because the container boundary is hard. But "container boundary" is a deployment fact, not an architectural principle — it tells you where the walls are, not why they're trustworthy. The more precise claim is: **every component communicates only through defined, audited IPC channels, and no component can influence another except through those channels.**

This reframes the security model from "trust the container" to "trust the IPC protocol." The difference matters when containers are not involved (e.g., the Token Broker talking to the orchestrator, or the orchestrator talking to Cato) — those boundaries are equally important.

**Current IPC channels in the system:**

| Channel | Parties | Protocol | Audited? |
|---|---|---|---|
| Orchestrator ↔ Container | Host/Container | Filesystem sentinel markers + stdin/stdout | Partially (stdout logged) |
| Orchestrator ↔ Token Broker | Host/Host | Unix socket (JSON-RPC) | Yes (broker log) |
| Agent ↔ Outbound API | Container/External | HTTP(S) via Call Inspector proxy | Yes (audit.db) |
| Orchestrator ↔ Cato inline hook | Host/Host | Unix socket | Yes (catoCheck log) |
| Container ↔ Shared filesystem | Container/Host | Bind mount (read-only) | Via mount allowlist |
| Orchestrator ↔ Channel adapters | In-process | Function calls | No (same process) |

**Decision:** IPC is the primary security architectural principle. New principle P7:

**P7 — Every component boundary is a documented, audited IPC boundary.**
No component influences another except through defined channels. In-process function calls between major subsystems are acceptable within a single trust boundary (e.g., orchestrator internals); they are not acceptable between trust domains. Trust domain boundaries must be documented explicitly.

**Implications:**

1. **Trust domain map required.** SPECS.md must enumerate the trust domains (Host orchestrator, Token Broker process, Cato process, Agent containers, External APIs, Channel providers) and the permitted communication paths between them.

2. **Filesystem IPC is a trust boundary.** The sentinel protocol is not an implementation detail — it is the primary host-container interface. Any change to it must be treated as a security-relevant protocol change.

3. **In-process channel adapters are in the same trust domain as the orchestrator.** This is acceptable because channels are applied as Skills (audited surface area). But it means a compromised channel adapter has orchestrator-level access. SPECS.md should document this explicitly rather than leaving it implicit.

4. **Cato must run as a separate process (not in-process) in all production deployments.** The deterministic stub (M6) is an acceptable start, but the architecture must not allow Cato to be reduced to an in-process function call in production. The Unix socket boundary is the security guarantee, not the logic inside the function.

5. **MCP servers are external trust domains.** When R6 (Alef for teams) introduces MCP access, each MCP server is an external trust domain. Its communication path must be documented and audited. MCP calls must go through the Call Inspector, not directly from the agent container.

---

## R4 — Cato as Neurosymbolic; Alef as Neural

**Proposition:** The distinction between Alef and Cato should be framed not just as "conversational vs. oversight" but as a deeper architectural split: Alef is a pure neural layer (LLM-driven, probabilistic, character-based); Cato is a neurosymbolic layer (deterministic rules + optional LLM judgment operating within constrained, enumerated criteria).

**What "neurosymbolic" means here:**
- **Symbolic component:** PSYCHE.md defines explicit, enumerable criteria. Cato's deterministic checks (path traversal patterns, prompt size limits) are pure symbolic: finite rules, binary outcomes, no ambiguity.
- **Neural component:** When a deterministic check is inconclusive, Cato can escalate to LLM judgment — but only within the scope defined by PSYCHE.md's criteria. The LLM is not free-ranging; it is evaluating specific evidence against specific, pre-specified questions. This is LLM-as-classifier, not LLM-as-reasoner.
- **Combination:** The symbolic component gates what the neural component sees. Obvious cases are handled by rules without touching the LLM. Ambiguous cases get LLM judgment only after the symbolic layer has failed to resolve them. The LLM cannot bypass the symbolic layer; it can only adjudicate in cases where the symbolic layer returns "inconclusive."

**Why this framing matters:**
- It clarifies Cato's trust model. A pure LLM oversight layer is untrustworthy — the LLM can be prompted to rationalize any action. A pure rule system is brittle — rules cannot cover all cases. The neurosymbolic combination is neither: the symbolic layer is auditable and non-circumventable; the neural layer handles cases the rules don't reach.
- It explains why Alef's `[FLAG]` protocol and assertiveness dial are **not** security mechanisms. Alef's refusals are neural (character-driven, probabilistic). They can be overridden by a sufficiently persistent user. This is by design. Cato's blocks are symbolic (or symbolically-gated neural); they cannot be overridden by the user or Alef.
- It provides a clear escalation model: symbolic → neural (escalation) → hard block (non-negotiable).

**Relationship to Decision 10 and Decision 12:** Decision 10 established the two-layer separation. Decision 12 deferred the LLM escalation path to Phase 2. This review adds the neurosymbolic framing as the architectural reason that escalation path is sound: the LLM in Cato is constrained by the symbolic framework around it, making it qualitatively different from an unconstrained LLM.

**What changes:**
- SPECS.md §7 adds the neurosymbolic framing.
- PSYCHE.md should explicitly enumerate the criteria Cato's LLM judgment is allowed to evaluate (no open-ended reasoning).
- Decision 10 is extended with this characterization.

---

## R5 — Name Is a Parameter; Roles Are Fixed by Design

**Proposition:** The names "Alef" and "Cato" are defaults, not architectural commitments. An operator should be able to rename the assistant to fit their team's culture without the documentation falling apart. But the *roles* — conversational agent layer with SOUL.md character, and neurosymbolic oversight layer with PSYCHE.md criteria — are architectural constants.

**Current state:**
- Alef is renamed via `ASSISTANT_NAME` (env var). This works.
- "Cato" has no equivalent rename mechanism. PSYCHE.md, DECISIONS.md, and SPECS.md use "Cato" as though it is the role name, not a default label.
- SOUL.md is Alef's identity document. If the assistant is renamed to "Aria", SOUL.md still says "Alef" internally.

**Decision:**

1. `ASSISTANT_NAME` continues to control the name used in conversations and logs. Default: `Alef`.
2. `OVERSIGHT_NAME` is added as an optional config var. Default: `Cato`. Controls the name used in logs and the TUI health panel. Does not affect any logic.
3. SPECS.md §7 is rewritten to refer to roles by function ("executive assistant layer", "oversight layer") and introduce Alef/Cato as the default names for those roles. This makes it clear that renaming is safe and supported.
4. SOUL.md is parameterized: the name token in SOUL.md is replaced at container run time by `ASSISTANT_NAME`. Same for PSYCHE.md and `OVERSIGHT_NAME`.

**What this is not:** Dynamic role switching. An operator can name the layers whatever they want. They cannot merge them, swap their functions, or disable one. The architectural separation is non-configurable.

---

## R6 — Alef for Teams: Subagents, Enterprise Security, and MCP Governance

**Proposition:** A well-specified use case for OpenGolem is Alef operating as a team member — not just a personal assistant, but a participant in a collaborative workflow who can spawn subagents, hold delegated work items, and access enterprise tools via MCP. This use case does not require heavy new implementation, but it does define the governance and access requirements for Skills and MCP that are currently underspecified.

**Why this is architecturally significant:**

When Alef is a personal assistant, the threat model is: one user, one container, defined task scope. When Alef is a team member, the threat model expands:
- Alef receives instructions from multiple team members (not just its primary user).
- Alef spawns subagents to delegate work.
- Subagents have their own token scopes — but who authorized those scopes? Alef did, on behalf of a team member.
- MCP servers provide access to shared team infrastructure (project management, code repos, knowledge bases). Who controls which MCPs Alef can access?

This is an enterprise governance problem, not just a "more features" problem. Getting it wrong means a team member can prompt Alef to spawn a subagent with broader access than they themselves should have.

**Decisions:**

**MCP as a first-class trust domain (follows from R3):**
Each MCP server is an external trust domain. MCP calls must be declared in a skill's `.intent.md`, pass through the Call Inspector, and appear in the audit log. An agent container cannot open an MCP connection that is not declared in its token's skill whitelist. This is already structurally true (the Call Inspector checks endpoint scope) — what changes is that MCP endpoints are explicitly enumerated as a category, not a special case.

**Subagent delegation model:**
When Alef spawns a subagent, the subagent receives a *derivative* of Alef's token — not an equal or broader token. The Token Broker enforces this: a spawning container's token defines the ceiling of what it can delegate. Subagent tokens are scoped to a subset of the parent's declared skill whitelist. This is the same principle as the existing token model applied recursively.

**Team member identity:**
In team mode, incoming messages may arrive from multiple authenticated users. Each user maps to a permission tier (defined in the group configuration). Alef's behavior when acting on a message is bounded by the permission tier of the sender — a lower-tier team member cannot instruct Alef to take actions that require a higher-tier authorization.

**MCP governance in `.intent.md` (M8 scope):**
The Skill Schema (M8) must include an explicit MCP section:
```yaml
mcp:
  servers:
    - id: github
      url: mcp://github.com/anthropics/mcp-github
      scopes: [read_issues, write_issues]
      min_permission_tier: member
    - id: confluence
      url: mcp://confluence.internal/...
      scopes: [read_pages]
      min_permission_tier: viewer
```
The `min_permission_tier` field gates which team members can trigger MCP calls via their Alef interactions.

**Phase 2 work:**
Full team mode — authenticated multi-user per group, permission tiers, subagent delegation tracking in dao_score — is a Phase 2 feature. What Phase 1 (M8) must do:
1. Design `.intent.md` with MCP and permission-tier fields (even if the tier enforcement is stub-only).
2. Document the subagent delegation ceiling rule in the Token Broker spec.
3. Add MCP endpoint category to the Call Inspector's endpoint scope check.

---

## Impact on Existing Decisions

| Existing Decision | Status |
|---|---|
| Decision 1 — Token format | Extended: tokens must carry provider context (R2) and delegation ceiling (R6). |
| Decision 2 — Call Inspector | Extended: MCP endpoint category added (R6); provider endpoint validation updated (R2). |
| Decision 3 — Skill `.intent.md` schema | Extended: provider compatibility, MCP section, permission tier (R2, R6). M8 scope expanded. |
| Decision 8 — Credential backends | Extended: non-Anthropic provider credentials added to backend interface (R2). |
| Decision 10 — Alef vs. Cato | Extended: neurosymbolic framing added (R4); role name parameterization added (R5). |
| Decision 12 — Cato deterministic stub | Unchanged: still the correct Phase 1 posture. R4 explains *why* LLM escalation is safe in Phase 2. |
| SPECS.md §11 — Multi-model | Was aspirational; R2 makes it structural. |
| SPECS.md §13 — Agent swarms | Was deferred to v1.1; R6 unblocks the design. Phase 2 implementation confirmed. |

---

## Immediate Action Items

Before this review's findings are incorporated into code:

1. **Update SPECS.md** — Add P7, update §3 stack table, §7 neurosymbolic framing, §11 multi-model structural commitment, add trust domain map section.
2. **Update DECISIONS.md** — Add Decision 13 (provider-agnostic), Decision 14 (IPC as primary security boundary). Extend Decision 10 with R4 framing.
3. **Update PLAN.md** — Add "Architectural Review" as a completed step. Update M8 scope to include MCP governance and provider compatibility in `.intent.md`.
4. **SOUL.md / PSYCHE.md parameterization** — Low-effort: replace hardcoded name tokens with env var substitution at container run time.
5. **`OVERSIGHT_NAME` config var** — Add to `bootstrap.ts` CONFIG_KEYS and document in CLAUDE.md.

No new code milestone is required for R1–R5. R6 (subagent delegation, team permissions, full MCP governance) is Phase 2 scope, with M8 producing the `.intent.md` schema foundation.

---

*This document supersedes any prior informal notes on multi-model or multi-agent scope. It does not modify SPECS.md directly — that update follows in SPECS.md v0.5.*
