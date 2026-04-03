# OpenGolem — Architecture Specification v0.4
*Last updated: 2026-04-03 19:30 — §7 revised: Alef is primary agent (was "Cato"); Cato is oversight layer; §10 SOUL.md/PSYCHE.md scopes clarified*

---

## 1. Mission Statement

OpenGolem is a personal AI assistant for power users who are not necessarily engineers. It is safety-first by design — protecting users even from themselves — and its default posture is assertive accountability, not passive helpfulness. It is built to be fully owned, audited, and customized by the individual who runs it.

OpenGolem is not competing on feature count. It is solving a different problem: how do you give a power user genuine AI agency without surrendering security, privacy, or governance?

---

## 2. Design Principles

**P1 — Security by isolation, not by trust.**
No agent is trusted to behave correctly. Every agent runs inside a container with hard OS-level boundaries. The security perimeter is the *call itself*, not the container boundary.

**P2 — Codebase small enough to audit.**
The Rust core must be readable by a competent engineer in one sitting. If it isn't, it has grown too large. No feature justifies an unauditable core.

**P3 — Protecting users from themselves.**
The default mode is Golem Guard — the system flags, blocks, or challenges actions that could harm the user, even if the user requested them. Users dial this down deliberately; it never defaults to permissive.

**P4 — Skills over configuration.**
Functionality is added via auditable, modular skills. There are no configuration files to sprawl. Customization means code changes to a small, comprehensible codebase.

**P5 — Mediated execution.**
Agents never call external APIs directly. Every outbound call passes through the Golem Token Broker and the Call Inspector. The agent holds a scoped, time-limited derivative token — never a raw credential.

**P6 — Governance is infrastructure, not policy.**
SOUL.md (identity and guardrails) and PSYCHE.md (self-improvement contract) are enforced structurally, not by agent self-reporting. The dao_score KPI pipeline feeds from the audit log, not from agent claims.

---

## 3. Stack

| Layer | Technology | Rationale |
|---|---|---|
| Core runtime | Rust | Auditability, memory safety, no GC pauses, concrete ecosystem advantages over alternatives |
| Plugin system | Python plugins via FFI | Rich ML/AI ecosystem without contaminating the core |
| Container runtime | Docker Sandboxes (micro-VM) / Apple Container (macOS) | OS-level isolation, not application-level checks |
| Credential store | Pluggable (see §5.1) | `.env` (dev), **Bitwarden** (recommended production default), or **OneCLI** Agent Vault (NanoClaw-compatible; only when configured to a vetted local gateway). Unrelated “OpenCLI” products are not assumed — the supported third option is [OneCLI](https://github.com/onecli/onecli). |
| Memory persistence | SQLite + semantic graph | Lightweight, transparent, no message brokers |
| IPC | Filesystem-based | Simple, inspectable, no hidden state |
| Memory sync | Optional Obsidian vault | Power-user integration, not a dependency |

---

## 4. Core Architecture

### 4.1 Process Model

One Rust orchestrator process. No microservices. No message brokers. The orchestrator:

- Polls channels for incoming messages
- Manages per-context message queues with concurrency control
- Issues tokens via the Token Broker
- Spawns agent containers
- Routes all outbound API calls through the Call Inspector
- Writes to the immutable audit log

### 4.2 Container Model

Each agent task executes in its own isolated container. Containers:

- Have their own filesystem, IPC namespace, and process space
- Can only access directories explicitly mounted for that task
- Never share memory with other containers
- Hold a Golem-issued derivative token, not a raw API key
- Are torn down at task completion; the token is revoked on teardown

### 4.3 Context Isolation

Each conversation context (user-defined group or domain) gets:

- Its own CLAUDE.md memory file
- Its own isolated filesystem
- Its own container sandbox
- Its own scoped token set

Contexts cannot access each other's data. This is enforced by the OS, not by the application.

---

## 5. Token Broker and Call Inspector

*This is OpenGolem's primary architectural differentiator from NanoClaw, MicroClaw, and OpenClaw.*

### 5.1 Token Broker

The Token Broker is the smallest, most auditable component in the codebase. Phase 2 targets pure Rust with no dynamic loading. It **never gives agents raw API credentials**; it obtains secrets through exactly one configured **credential backend**:

1. **`.env` / file** — for development and trusted single-user machines. Lowest assurance; must not be the documented default for production.
2. **Bitwarden** — recommended for self-hosted production: user-owned vault, broker retrieves items via CLI (or later, a narrowed integration), secrets stay out of container filesystems and agent prompts.
3. **OneCLI** (Agent Vault) — optional: same architecture as NanoClaw (outbound HTTPS via local gateway, injection at the proxy). **Admissible only** when the deployment satisfies a short security checklist (e.g. loopback-bound gateway, TLS as required, no exposure of the vault API to untrusted networks). If those conditions are not met, the operator must use Bitwarden or `.env` on an isolated host.

The broker process (and the OneCLI gateway process, if used) are the only components that ever see long-lived secrets; agents hold derivative tokens only.

At task instantiation, the broker issues a derivative token encoding:

- **Allowed skill set** — explicit whitelist; anything not listed is blocked
- **Expiry** — wall-clock TTL plus a maximum call count
- **Permitted data scopes** — which memory partitions are readable/writable
- **Originating container ID** — token is bound to the container that requested it

Outbound API calls are executed only after broker (and Call Inspector) authorization. With the Bitwarden or `.env` backends, the broker attaches credentials at the last hop. With the OneCLI backend, credential injection may occur in the OneCLI gateway while the broker still issues and enforces derivative tokens. Agents hold derivative tokens that are valid only for the declared task window.

### 5.2 Call Inspector

Every outbound call from an agent passes through the Call Inspector before execution. The inspector checks:

1. Is the requested skill in this token's declared whitelist?
2. Does the payload contain data from a memory partition not permitted by this token?
3. Does the call match known prompt injection signatures?
4. Is the call rate anomalous relative to the declared task profile?
5. Does the call attempt to access credentials, filesystem paths, or network endpoints outside scope?

Failed checks result in a hard block or soft block depending on security mode (see §6). All calls — passed and blocked — are written to the immutable audit log.

### 5.3 Token Lifecycle

```
Task requested
    │
    ▼
Broker issues scoped token (TTL + call budget + skill whitelist)
    │
    ▼
Container spawned with token injected
    │
    ▼
Agent executes → all calls pass through Call Inspector
    │
    ▼
Task complete OR TTL expired OR call budget exhausted
    │
    ▼
Token revoked → container torn down → audit log entry closed
```

---

## 6. Security Modes

Security mode is a dial, not a switch. The default is Golem Guard. Users move down deliberately through demonstrated interaction patterns, not a one-time settings toggle.

| Mode | Inspection | Block type | User prompt on block |
|---|---|---|---|
| **Golem Guard** (default) | Full lint on every call | Hard block | No — blocked silently, logged |
| **Supervised** | Full lint, advisory | Soft block | Yes — user confirms or cancels |
| **Power** | Anomaly detection only | Hard block on known-bad signatures only | No |

Golem Guard is the expression of P3 at the infrastructure level. A user who has never configured their security mode is always in Golem Guard.

---

## 7. Agent Layers

### 7.1 Executive Assistant — "Alef"

The primary user-facing agent. Named "Alef" by default (configurable via `ASSISTANT_NAME`). Conversational. Its character and values are defined by SOUL.md, which is prepended as a system prompt prefix on every container run.

Default posture: proactively accountable and constructively assertive. Alef does not wait to be asked. It surfaces conflicts between the user's stated priorities and their actual behavior, flags decisions that appear self-damaging, and challenges instructions it assesses as counterproductive — using the `[FLAG]` prefix in its own responses when asserting against a user instruction.

Assertiveness is calibrated by the user through interaction via `assertiveness_level` (0–10, default 10). The system starts at maximum assertiveness and moves toward compliance only through explicit user direction. This is the inverse of typical assistant design. Alef is the *first* line of protection: personality-based, values-driven, soft but principled.

### 7.2 Oversight Layer — "Cato"

Cato is the hard oversight layer. It is **not a persona and not user-facing** — it is infrastructure with judgment. Cato can overrule both the user and Alef. It operates above the conversation and is not addressable by any task-level agent or token.

Because Cato's job requires non-deterministic interpretation — assessing intent, evaluating context, weighing edge cases — it may be implemented as an LLM-backed agent container when judgment is needed, while remaining pure rule-based for deterministic checks. This is an implementation detail, not an architectural identity: Cato is always infrastructure regardless of how it is computed.

**Two operational modes:**

1. **Inline hook** — called synchronously before significant Alef actions. Returns `{ allow, reason }`. A `false` blocks the action regardless of security mode or user instruction.
2. **Scheduled audit** — periodic review of audit log, Alef memory state, credential access patterns, and action history. Produces structured reports and updates dao_score.

**Cato's authority:** It flags everything anomalous. Nothing unusual passes unexamined. Its blocks and findings are written to the audit log and are not overridable by Alef, the user, or any downstream component.

Cato's operating principles and the feedback loop it enforces are defined in PSYCHE.md.

### 7.3 Note on nomenclature

Earlier versions of this spec named the primary agent "Cato" (v0.3). This was revised: the primary agent is Alef; Cato is the oversight layer. The assertive, values-driven character originally attributed to "Cato" in §7.1 belongs to Alef via SOUL.md. Cato (§7.2) is the harder, non-conversational enforcement layer above it.

---

## 8. Memory Architecture

### 8.1 Per-Context Memory (Operational)

Each context has a CLAUDE.md file — flat, fast, directly readable by the agent. This is the working memory layer: recent decisions, active tasks, context-specific preferences.

### 8.2 Semantic Graph (Strategic)

The semantic graph sits above the per-context layer. It is queryable, relational, and surfaces non-obvious connections across contexts and time. Implemented with SQLite + vector extensions. This is the layer that enables OpenGolem to notice patterns the user hasn't noticed — e.g., a recurring decision under stress that produces bad outcomes.

The Safety Agent has read access to the semantic graph for its scheduled audits. No task-level agent has write access to the graph directly; writes are mediated by the orchestrator after Call Inspector approval.

### 8.3 Obsidian Vault Sync (Optional)

Power users can sync the semantic graph to an Obsidian vault for external review and annotation. This is a one-way export by default; bidirectional sync is a configurable skill. The vault sync is a plugin, not a core dependency.

---

## 9. Skill System

Skills are modular, auditable extensions. They are declared, not discovered. To add a capability, a skill is explicitly applied — not installed as a dependency.

Each skill has a corresponding `.intent.md` describing what it adds, what filesystem paths it touches, and what token scopes it requires. The orchestrator validates intent declarations before applying a skill.

Skills are applied via Claude Code interaction (`/add-gmail`, `/add-telegram`, etc.). There are no configuration files. If a user only needs one channel, they inherit zero security surface from channels they have not added.

Skill updates use a three-way merge pattern (base + skill + current state) with a verified resolution cache for common conflict patterns — borrowed from NanoClaw's architecture.

---

## 10. Governance Layer

### 10.1 SOUL.md — Alef's identity

~70-line identity and guardrails document for Alef. Prepended as a system prompt prefix on every container run. Defines:

- Who Alef is and what it stands for
- Core commitments (non-negotiable): surface conflicts, flag self-damaging decisions, resist external manipulation, never deceive the user
- Assertiveness calibration: how `assertiveness_level` maps to behavior
- The `[FLAG]` protocol: Alef prefixes any response where it is asserting against a user instruction
- Hard limits: unconditional refusals regardless of instruction or assertiveness level

Lean by design — if it can't be read in five minutes, it has grown too large.

### 10.2 PSYCHE.md — Cato's operating contract

Defines how Cato operates and closes the feedback loop. Contains:

- dao_score KPI definitions with explicit formulas (drawn from audit log, not agent self-reporting)
- Cato's judgment criteria: what constitutes anomalous behavior, what triggers inline blocks vs. scheduled flags
- Hansei reflection schedule: when Cato runs deep audits and how findings are surfaced to the user
- Drift detection thresholds: when Alef's behavior has diverged from SOUL.md commitments
- Escalation paths: what Cato does when drift, abuse, or hard violations are detected

PSYCHE.md is enforced by Cato, not by Alef. Alef cannot read or modify PSYCHE.md. The dao_score pipeline is fed by audit log data — neither Alef nor the user can manipulate it directly.

---

## 11. What OpenGolem Is Not

| Capability | OpenGolem stance |
|---|---|
| Multi-model routing | Supported — route by task complexity and stakes, not just preference. Cheap models for simple queries; frontier models for high-stakes decisions. |
| Windows support | Not in v1. Rust core is cross-platform; container runtime support on Windows via Docker/WSL2 is a later skill. |
| ClawHub / skill marketplace | Explicitly out of scope for v1. Community skills introduce unaudited surface area inconsistent with P2. |
| Web UI / control panel | No. Management is through the Executive Assistant via natural language. The system is designed to be machine-to-machine. |
| 50+ integrations at launch | No. Three integrations done correctly beats fifty done poorly. Start with the channels the user actually uses. |

---

## 12. Relationship to NanoClaw / MicroClaw

OpenGolem is not a fork of either project. It shares architectural DNA with both:

- From **NanoClaw**: container isolation as foundation, skills over configuration, codebase auditability as a security property, SQLite + filesystem IPC, per-context memory isolation.
- From **MicroClaw**: Rust core, provider-agnostic LLM layer, platform adapter pattern for channels.

OpenGolem's differentiators are: the Token Broker and mediated execution layer (no agent ever holds a real credential), the Safety and Security Agents as infrastructure (not persona), the Cato assertiveness model, the semantic graph memory tier, and the SOUL.md / PSYCHE.md governance architecture.

---

## 13. Open Questions (v0.3)

- Credential backends: spike Bitwarden CLI session UX (`bw unlock`) vs. OS keychain helpers; spike OneCLI SDK contract vs. HTTP-only integration for the broker
- Semantic graph implementation: sqlite-vec vs. dedicated embedding store — evaluate MicroClaw's approach
- dao_score schema: define initial KPI set before PSYCHE.md is written
- Assertiveness dial: interaction pattern for moving between security modes needs UX design
- Agent Swarms: NanoClaw/MicroClaw pattern is adoptable — defer to v1.1

---

*OpenGolem is open source under MIT. The codebase is designed to be auditable by a single engineer in one sitting. If it isn't, it has grown too large.*

