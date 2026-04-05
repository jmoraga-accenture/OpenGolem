# OpenGolem — Architect Brief
*Produced: 2026-04-05 | For the incoming architect. No prior knowledge of this project or similar systems assumed.*

---

## Your Mandate

You are being asked to define the "to be" architecture for OpenGolem. A working v0.1 codebase exists as a starting point — an implementation that proved the core ideas work. Your job is not to patch it. Your job is to design the correct architecture from first principles, grounded in the philosophy documented here. A separate implementation audit will inventory what in v0.1 maps to your architecture, what contradicts it, and what is missing. That audit feeds a staged implementation plan to reach v1.0.

You produce: a process model, trust domain map, component responsibilities, IPC boundaries, and enough architectural decision records to drive detailed spec writing.

---

## What OpenGolem Is

OpenGolem is an AI assistant service. Users talk to it through a messaging interface (terminal, Telegram, WhatsApp, or similar). It understands their requests and acts on them — searching, writing, executing tasks, interacting with external services.

That description fits dozens of products. Here is what makes OpenGolem different.

**Every other system in this space assumes a technically sophisticated operator.** They defer security to the person running the service — "configure your API keys correctly," "know which permissions to grant," "understand the risks of what you're asking the agent to do." That assumption excludes most people, and it fails even sophisticated ones. A researcher at a major AI lab had his API keys leaked by his own assistant. A security lead at a major tech company had all her emails wiped. A major cloud provider went down because of a miscommunication between an assistant and a support workflow. These are not careless people. The tools they used made the mistakes architecturally possible.

**OpenGolem's thesis:** safety infrastructure done correctly makes AI agency genuinely accessible to everyone — from a grandparent installing it for the first time to an enterprise team deploying it as a permanent member. The protection is architectural, not instructional. You do not configure your way to safety; the unsafe paths are structurally unavailable by design.

---

## Who It Serves

OpenGolem is designed for:

- Individuals with no technical background (the system must be safe by default, with no configuration required)
- Power users and developers (the system must be auditable, extensible, and honest about what it is doing)
- Enterprise teams (the system must support multiple users under a single administrator, with auditable team interactions)

All three groups share the same core system. The difference is configuration, not architecture. The safety floor is the same for everyone. Power users and administrators configure additional capabilities upward from that floor; they do not start from an unsafe baseline and add security.

---

## Philosophy

These are not preferences. They are constraints that every architectural decision must satisfy.

**1. Safety as universally necessary, not a power-user feature.**
The safety layer exists because even world-class engineers make catastrophic mistakes with AI agents when the architecture permits them. The protection is unconditional. It does not depend on the user understanding it, enabling it, or deserving it.

**2. Alef is the communication layer. Cato is the sole protection layer. These are not the same thing.**
The system has two named entities with distinct, non-overlapping roles. Alef handles all communication with the user — warmly, educationally, adaptively. Alef warns, explains, flags, and challenges. Cato enforces. Cato is infrastructure, not a persona. It does not communicate with users. Even if every Alef behaviour is stripped away by a user, Cato's floor does not move. The safety guarantee is entirely Cato's. Alef's role is to make the system legible and trustworthy, not to protect it.

**3. Security as education, not just enforcement.**
Every block or warning is a teaching moment. The system actively explains risk in the user's language. "I blocked that because your request included your account number in plain text — here is why that is dangerous and how to achieve the same goal safely." This is not a UX nicety. It is the mechanism by which the system builds user trust and risk literacy over time. Silent protection was a prior design error; explained protection is the correct model.

**4. IPC boundaries are the primary security architecture.**
Every component boundary is a documented, audited IPC boundary. No component influences another except through defined channels. The security argument rests on the protocol, not on trusting any individual component to behave correctly. In-process function calls are acceptable within a single trust domain; they are not acceptable between trust domains.

**5. Complexity proportional to problem scope.**
"Minimal" does not mean "small." It means: solve the problem correctly and no more. A component whose problem domain is simple should have a simple implementation. A component whose problem domain is genuinely complex (e.g. semantic risk analysis) may be correspondingly complex — but it must not be more complex than its domain requires. Every addition must answer: does this solve a problem the component actually has?

**6. Language as implementation detail.**
Clean IPC boundaries mean each component can use the best language for its domain. No single language is mandated. The spec — not the language — is the source of truth.

**7. The spec is the product.**
The long-term aspiration is specifications written in clear enough English to drive implementation or reimplementation in any language. Every architectural and behavioral document in this project is working toward that standard.

---

## The Two Core Entities

### Alef — The Assistant

Alef is the user-facing conversational agent. It has a defined character: proactively helpful, assertive when the user's actions appear self-damaging, warm but honest. It adapts its communication style to the user over time — language, register, level of explanation.

Alef's character is defined in a document called SOUL.md, which is injected as a system prompt prefix on every agent run. SOUL.md defines communication style, the `[FLAG]` and `[BLOCKED]` tag conventions (see below), and hard limits that Alef does not cross regardless of instruction.

Alef is not a security mechanism. Its character can be influenced through interaction. This is by design — a good assistant adapts to its user. The safety guarantee does not depend on Alef's character holding.

**Two structured communication tags:**

- `**[FLAG]**` — Alef asserting its own disagreement with a user instruction. Alef's voice, Alef's judgment.
- `**[BLOCKED]**` — Alef communicating a Cato enforcement decision. Alef translates Cato's technical finding into a human explanation.

Both tags are user-configurable display strings. The defaults are English. A user who interacts in Portuguese may configure `[BLOQUEADO]`. The canonical English forms are always used in the audit log regardless of display configuration.

### Cato — The Oversight Layer

Cato is infrastructure. It is not a persona, not user-facing, not addressable by any user session or agent token. It operates above the conversation.

Cato's external interface to the rest of the system is a strict protocol:

```json
{ "allow": true|false, "code": "RISK_CODE", "reason": "optional short free text" }
```

`code` is drawn from a small, enumerable set of structured risk codes (PATH_TRAVERSAL, PROMPT_INJECTION, PII_PLAIN_TEXT, CREDENTIAL_EXPOSURE, OVERSIZED_PAYLOAD, …). The set is intentionally not exhaustive — new codes are added as risk patterns are observed in practice. The `reason` field is free text for cases that do not fit a structured code. Both fields are optional on allow decisions.

Cato has two operational modes:

1. **Inline hook** — called synchronously before significant Alef actions. Returns the protocol above. A `false` blocks the action unconditionally — no security mode, user instruction, or Alef judgment overrides it.
2. **Scheduled audit** — periodic review of the audit log, Alef behavior patterns, and credential access history. Produces a structured report for the administrator. Does not auto-modify thresholds.

Cato's implementation is neurosymbolic: deterministic symbolic checks handle high-confidence cases (pattern matching, size limits); an LLM escalation path handles ambiguous cases within constrained, pre-specified criteria. The LLM is an evaluator operating within the symbolic framework — it cannot bypass the symbolic layer.

Cato's output must be laconic. The `reason` field should not contain payload content from the blocked request — it names the risk class, not the evidence. This is both a security property (minimizes injection surface into Alef's context) and a design constraint.

---

## Governance

**dao_score** is a set of KPIs computed from the immutable audit log. They measure system behavior: how often calls are blocked, what categories of risk appear, whether agents adjust behavior after blocks.

Critical constraint: **Cato does not auto-recalibrate against dao_score.** KPIs are diagnostic signals for human review, not optimization targets for the system. The scheduled audit (hansei) produces a report surfaced to the Golem administrator. Threshold changes are deliberate administrator decisions. This is mandatory — a system that auto-recalibrates against its own metrics will drift toward optimizing proxies rather than actual safety outcomes.

**Dashboard** — a skill available to administrators and power users that surfaces KPI trends, block and warning history, usage patterns, and hansei reports. This is the interface through which human calibration judgment is exercised. Without it, the "human in the loop" principle has no mechanism.

---

## Access Model

The Golem has one **administrator** — the person or entity who deploys and configures it. The administrator owns the full system: Cato's configuration, skill policies, credential backends, permission settings.

**Users** access the Golem only through session chat. They configure nothing of the core. A user session is encapsulated — it changes nothing outside itself. Users may adjust their interaction preferences (communication style, autonomy level) within bounds the administrator has set.

**Team deployments** follow the same model. The team administrator owns the Golem. Team members are users. No team member has access to Cato, skill policies, or system configuration. The collective visibility of the group chat provides an additional informal audit layer.

---

## Credential and Provider Model

**Credential mediation is unconditional.** Agents never hold raw API keys or credentials. Every credential is mediated by a dedicated broker component. The broker resolves long-lived secrets through a pluggable backend (local file for development; a secrets manager for production). Agents hold short-lived scoped derivative tokens, not raw credentials.

**Provider routing is separate from credential storage.** Which AI model and endpoint to call (Anthropic, OpenRouter, Ollama, or any other provider) is a configuration concern, not a credential concern. A user may configure Ollama running locally — meaning no credential at all, and no data leaving the machine. Provider configuration lives in group or task config; credential mediation is always the broker's job regardless of provider. These must not be architecturally conflated.

Security implication: a locally-hosted model bypasses any upstream safety filters the provider would apply. Cato's checks carry more weight in self-hosted deployments for this reason.

---

## Language Awareness

The system responds in the user's language. A user may switch languages within or across sessions — this is expected. Cato's symbolic checks are language-agnostic by design (byte-level patterns, size constraints). Cato's LLM escalation path must be explicitly designed to treat language-switching as a potential evasion vector — not a reason to lower scrutiny. The `[FLAG]` and `[BLOCKED]` display tags are configurable per user or group. The audit log always uses canonical English forms.

---

## Scope of the Safety Guarantee

OpenGolem guarantees safety for a **correctly deployed Golem from the canonical repository**. It does not claim to prevent safety failures in forks, tainted distributions, or deliberately misconfigured deployments. No software can prevent misuse by a bad-faith operator. The repository is the source of truth; beyond that boundary, OpenGolem's guarantees do not reach.

---

## What You Are Designing

Given the philosophy and constraints above, define:

1. **Process model** — what processes exist, their responsibilities, and their lifetimes
2. **Trust domain map** — enumerate every trust domain and the permitted communication paths between them
3. **Component responsibilities** — what each component owns and what it explicitly does not own
4. **IPC boundaries** — for every trust domain crossing, specify: protocol, direction, auditability
5. **Skill system** — how capabilities are declared, validated, and scoped; the `.intent.md` schema
6. **Memory architecture** — operational memory (per-session), strategic memory (cross-session semantic graph), and their access controls
7. **Key architectural decisions** — where the design space has real alternatives, record the choice and the reason

You are not writing code. You are not constrained by the v0.1 implementation. You are designing the system that SPECS.md v1.0 will describe.

---

*This brief was produced from a philosophical and architectural review session on 2026-04-05. The full session record is in `docs/REVIEW_META_PLAN.md`.*
