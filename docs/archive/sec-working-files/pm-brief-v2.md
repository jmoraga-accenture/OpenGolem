<!-- archived: content merged into canonical docs -->
# OpenGolem — PM Brief v2
*Produced: 2026-04-05 | Owner: Jim (PM) | Supersedes: PM_BRIEF.md v1*

This is the operating document for driving OpenGolem from v0.1 to v1.0. It tells you what exists, what needs to happen next, in what order, and how to start each piece of work.

---

## Current Status *(updated 2026-04-05)*

| Phase | Stream | Step | Status | Notes |
|-------|--------|------|--------|-------|
| Phase 0 — Foundation | — | All | **Complete** | Architecture, team, PM brief |
| Phase 1 — Specifications | — | Step 1.1 Implementation Audit | **Complete** | `docs/IMPLEMENTATION_AUDIT.md` produced |
| Phase 1 — Specifications | A–D | Step 1.2 Priority 1 specs | **In progress** | 4 Spec Writer sessions running in parallel |
| Phase 1 — Specifications | E | Step 1.2 Priority 2 spec (Orchestrator) | **Blocked** | Awaiting A, B, C interfaces |
| Phase 1 — Specifications | F | Step 1.2 Priority 3 specs (Channel Adapters, Audit Log, SOUL/PSYCHE) | **Not started** | |
| Phase 1 — Specifications | — | Step 1.3 PLAN_V1.md | **Not yet commissioned** | Commission Architect after Priority 1 specs approved |
| Phase 1 — Security & UX | G | Cybersecurity Specialist review | **Not started** | Commission after Security Strengthening Document approved and Streams A, E specs stable |
| Phase 1 — Security & UX | H | DevOps hardening and runbooks | **Not started** | Commission after Stream G findings approved |
| Phase 1 — Security & UX | L | Supply-Chain Audit — Phase 1 | **Not started** | Commission before v1.0 ships |
| Phase 2 — Development | A–F | All development streams | **Blocked** | Awaiting specs |
| Phase 2 — Security & UX | I | UX — Setup and onboarding | **Not started** | Commission ahead of deployment documentation finalisation |
| Phase 2 — Security & UX | J | UX — CLI and TUI | **Not started** | Commission ahead of Stream F implementation |
| Phase 2 — Security & UX | K | UX — Report Dashboard | **Not started** | Commission before dashboard skill spec is finalised |
| Phase 3 — Integration | — | All | **Blocked** | Awaiting Phase 2 |

**In-flight specs (Priority 1):**
- Stream A — Token Broker + Call Inspector → `docs/specs/token-broker-spec.md`
- Stream B — Cato → `docs/specs/cato-spec.md`
- Stream C — Skill Schema → `docs/specs/skill-schema-spec.md`
- Stream D — Memory Tiers → `docs/specs/memory-tiers-spec.md`

**PM review gate:** When all four Priority 1 specs land, review each for VoC alignment and commission Architect review for architectural consistency. Approved specs unlock Tester and Developer for those streams.

**Open PM decisions:**

| # | Decision required | When |
|---|---|---|
| 1 | Security Strengthening Document — approve and add to canonical doc set | Now |
| 2 | Security streams G, H, L — sequence against existing milestone plan | Before PLAN_V1.md is commissioned |
| 3 | UX streams I, J, K — confirm surfaces and brief scope | Before Stream F spec begins |
| 4 | F-9 risk acceptance — MCP permission tier enforcement deferred to Phase 2 | Before any MCP-declaring skill ships |
| 5 | F-10 supply-chain audit scope — npm audit policy for Phase 1 | Before v1.0 ships |
| 6 | Phase 2 Rust rewrite — add dependency minimisation as an explicit acceptance criterion | When Phase 2 is scoped |

---

## What Exists Right Now

| Document | What it is | Status |
|----------|-----------|--------|
| `docs/ARCHITECT_BRIEF.md` | Mandate given to the architect — philosophy, constraints, deliverables | Complete. Reference. |
| `docs/REVIEW_META_PLAN.md` | Philosophical session resolving six tensions; produced the eight anchors | Complete. Reference. |
| `docs/ARCHITECTURE_REVIEW.md` | Six propositions reviewed and adopted (R1–R6) | Complete. Reference. |
| `docs/ARCHITECTURE.md` | The "to be" architecture: process model, trust domains, IPC schemas, skill schema, memory tiers, 11 ADRs | **Canonical. Everything derives from here.** |
| `docs/TEAM.md` | Team roles, role execution model, handoff protocol, parallel streams (v2) | **Updated this session.** |
| `docs/DECISIONS.md` | Architecture decision records | Keep. Developers and Spec Writers read before starting. |
| `docs/ECOSYSTEM.md` | NanoClaw / MicroClaw / OpenClaw / PicoClaw positioning | Keep. Context for Spec Writers. |
| `docs/IMPLEMENTATION_AUDIT.md` | v0.1 vs ARCHITECTURE.md gap analysis — keep / shed / build per component | Complete. Input to PLAN_V1.md. |
| `docs/SECURITY_STRENGTHENING.md` | Architectural security gaps with severity, discipline, and recommended actions | **New this session. Pending PM approval.** |
| `docs/specs/token-broker-spec.md` | Token Broker + Call Inspector behavioral spec (Stream A) | In progress. |
| `docs/specs/cato-spec.md` | Cato behavioral spec (Stream B) | In progress. |
| `docs/specs/skill-schema-spec.md` | Skill Schema behavioral spec (Stream C) | In progress. |
| `docs/specs/memory-tiers-spec.md` | Memory Tiers behavioral spec (Stream D) | In progress. |

**The single source of truth for v1.0 is `docs/ARCHITECTURE.md`.** When anything conflicts with it, ARCHITECTURE.md wins.

---

## The Four Phases

```
Phase 0 — Foundation            [COMPLETE]
  Philosophy, architecture, team, security baseline defined.

Phase 1 — Specifications        [IN PROGRESS]
  Gap analysis + behavioral specs + security and UX stream commissioning.

Phase 2 — Development           [BLOCKED on Phase 1]
  Implement components against specs. Parallel development and UX streams.

Phase 3 — Integration           [BLOCKED on Phase 2]
  Cross-component integration, full QA, v1.0 release.
```

---

## Phase 1 — Specifications

### Step 1.1 — Implementation Audit ✅ Complete

Output: `docs/IMPLEMENTATION_AUDIT.md`.

### Step 1.2 — Behavioral Specs

One behavioral specification per component, derived from ARCHITECTURE.md. Written by the Spec Writer in a scoped session. The spec defines observable behaviour, external interface, behavioural contract, failure modes, invariants, and acceptance criteria. It does not describe implementation internals.

**Spec format:**
```
# Component Name — Behavioral Specification
## Responsibilities
## External Interface
## Behavioral Contract
## Failure Modes
## Invariants
## Acceptance Criteria
```

**Spec queue — ordered by dependency:**

| Priority | Stream | Component | Relevant ARCHITECTURE.md sections |
|----------|--------|-----------|-----------------------------------|
| 1 | A | Token Broker + Call Inspector | §1.1, §3.2, §3.3, §4.2, §4.5, §4.6, ADR-5, ADR-7 |
| 1 | B | Cato (inline + scheduled audit) | §1.1, §3.4, §4.3, §4.3.1, ADR-2, ADR-3 |
| 1 | C | Skill Schema | §5 (entire section) |
| 1 | D | Memory Tiers | §6 (entire section), §6.4 |
| 2 | E | Orchestrator | §1.1, §1.3, §3.1, §4.1–§4.4, §4.7–§4.8 |
| 3 | F | Channel Adapters, Audit Log, SOUL.md/PSYCHE.md governance | §3.6, §3.7, §3.5, §4.1, ADR-6 |

**How to trigger a spec session (example for Token Broker):**
> "You are the Spec Writer. Read `docs/ARCHITECTURE.md` sections §1.1, §3.2, §3.3, §4.2, §4.5, §4.6, and ADRs 5 and 7. Do not read `src/`. Write a behavioral specification for the Token Broker and Call Inspector as a single document at `docs/specs/token-broker-spec.md`. Use the spec format defined in `docs/TEAM.md`. Do not describe implementation; describe observable behaviour, exact wire schemas, failure modes, and testable acceptance criteria."

**Phase 1 is complete when:** All specs above exist and have been approved by the PM for VoC alignment, and the Architect has confirmed each spec is internally consistent with ARCHITECTURE.md.

### Step 1.3 — Implementation Plan (PLAN_V1.md)

After Priority 1 specs are approved and their interfaces are stable, the Architect sequences the full component list — including security and UX streams — into numbered milestones with definitions of done, ordering constraints, and stream assignments.

**How to trigger:**
> "You are the Architect. Read `docs/ARCHITECTURE.md`, `docs/IMPLEMENTATION_AUDIT.md`, `docs/TEAM.md` v2, `docs/SECURITY_STRENGTHENING.md`, and the approved specs in `docs/specs/`. Produce `docs/PLAN_V1.md`: a numbered milestone sequence for Phase 2 development. Each milestone has: target component(s) or work stream, definition of done, sequencing constraints, and stream assignment. Include security streams G, H, L and UX streams I, J, K alongside development streams A–F. Identify ordering dependencies across all streams."

**Output:** `docs/PLAN_V1.md`

### Step 1.4 — Security and UX Stream Commissioning

These streams are commissioned during Phase 1, run in parallel with or ahead of development, and must not be deferred to post-development review.

**Stream G — Cybersecurity Specialist review**

Commission when: Security Strengthening Document is PM-approved and Streams A and E specs are stable.

**How to trigger:**
> "You are the Cybersecurity Specialist. Read `docs/ARCHITECTURE.md`, `docs/SECURITY_STRENGTHENING.md`, and `docs/specs/token-broker-spec.md`. Your focus is threat modelling the following surfaces: (1) inbound transport and webhook authentication (F-1), (2) credential proxy HTTP binding (F-2), (3) audit log integrity model (F-3), (4) in-process channel adapter supply-chain risk (F-4), and (5) the external dependency surface (F-10). For each finding, produce: a threat model narrative, a severity assessment, and a concrete ADR recommendation. Where a finding can be closed by an architectural decision alone, draft the decision record. Where it requires a new specification section, identify which spec and which section."

**Output:** Updated `docs/SECURITY_STRENGTHENING.md` with findings closed or escalated; draft ADR text for PM review.

**Stream H — DevOps hardening and runbooks**

Commission when: Stream G findings are approved.

**How to trigger:**
> "You are the DevOps/Systems Administrator. Read `docs/specs/token-broker-spec.md`, `docs/specs/orchestrator-spec.md`, and `docs/SECURITY_STRENGTHENING.md` findings F-1, F-2, F-5, F-6, and F-8. Produce: (1) a network hardening annex for the deployment documentation covering firewall posture, socket binding, and Docker network configuration; (2) a credential rotation runbook with time-to-rotation targets for each backend type (.env, Bitwarden, OneCLI); (3) a broker crash recovery procedure covering mid-task broker loss detection and container teardown. Each runbook must be executable by a non-expert operator."

**Output:** `docs/deployment/hardening.md`, `docs/deployment/credential-rotation.md`, `docs/deployment/broker-recovery.md`.

**Stream L — Supply-Chain Audit, Phase 1**

Commission when: before v1.0 ships.

**How to trigger:**
> "You are the Supply-Chain Auditor. Read `docs/SECURITY_STRENGTHENING.md` finding F-10 and the current `package.json` and `package-lock.json`. Produce: (1) a dependency audit report classifying each direct dependency by risk surface and maintenance status; (2) an npm audit policy for CI enforcement (zero-high-severity gate, lockfile integrity verification); (3) a container base image pinning and scanning policy. For Phase 2, draft the crate dependency minimisation objective and target graph structure for the Rust rewrite."

**Output:** `docs/security/dependency-audit.md`, `docs/security/supply-chain-policy.md`.

---

## Phase 2 — Development

Phase 2 opens when Phase 1 is complete for at least one development stream. Specs for that stream must be approved before development begins. Security and UX streams I, J, and K run in parallel with development — they must be commissioned ahead of the relevant implementation work, not after it.

### Development cycle per component

```
1. PM confirms spec is approved
2. Tester writes tests from spec (no src/ access)
3. Tests must initially fail — confirms tests are real
4. Developer implements from spec + test suite + v0.1 as reference
5. All tests pass before handoff
6. QA/QC runs full suite, verifies acceptance criteria
7. Security Reviewer checks trust domain + IPC compliance
8. VoC review gate (before Security Review, end of each stream)
9. PM reviews and approves merge
```

### Development streams

| Stream | Component | v0.1 starting point | Expected effort |
|--------|-----------|--------------------|--------------------|
| A | Token Broker + Call Inspector | `src/broker/`, `src/inspector/`, `src/credential-proxy.ts` | Refactor; extend for delegation ceiling, provider type, process separation |
| B | Cato | `src/cato/` | Keep deterministic stub; wire neurosymbolic path for Phase 2 |
| C | Skill Schema | None | Build from scratch |
| D | Memory Tiers | `src/db.ts`, `groups/*/CLAUDE.md` | Tiers 1+2 extend; Tier 3 build from scratch |
| E | Orchestrator | `src/index.ts`, `src/group-queue.ts`, `src/container-runner.ts`, `src/router.ts` | Refactor to spec; enforce trust domain boundaries |
| F | Channel Adapters | `src/channels/` | Keep; add `.intent.md` declarations |

### Security and UX streams (Phase 2)

| Stream | Work | Sequencing |
|--------|------|------------|
| I | UX — Setup and onboarding | Ahead of deployment documentation finalisation |
| J | UX — CLI and TUI | Ahead of Stream F implementation |
| K | UX — Report Dashboard | Before dashboard skill spec is finalised (Stream C sub-item) |
| M | Supply-Chain Audit — Phase 2 Rust | At start of Phase 2, before crate structure is finalised |

**How to trigger UX stream sessions (example for Stream K — Report Dashboard):**
> "You are the UX/Interaction Designer. Read `docs/ARCHITECTURE.md` ADR-3 (no auto-recalibration), `docs/specs/skill-schema-spec.md` §5.4 (dashboard skill), and `docs/ARCHITECT_BRIEF.md` §Access Model. The Report Dashboard is the primary governance interface through which the administrator exercises human calibration judgment. It surfaces KPI trends, block history, hansei report findings, and threshold change recommendations. Produce: (1) an information architecture for the dashboard covering hierarchy, grouping, and progressive disclosure; (2) annotated user flow descriptions for the three primary administrator tasks: reviewing a hansei report, assessing a KPI anomaly, and deciding whether to adjust a PSYCHE.md threshold; (3) a list of content and labelling recommendations for technical terms that must be made legible to a non-expert administrator. Do not produce visual design — produce structure and language."

---

## Phase 3 — Integration

Phase 3 begins when Streams A, B, and E are complete and passing their individual QA gates.

Integration work:
1. Wire Orchestrator to real Token Broker and real Cato (replacing stubs)
2. Run integration tests across the full process model (Orchestrator + Broker + Cato + one container)
3. Validate the sentinel protocol end-to-end
4. Validate Cato fail-closed behaviour (kill the Cato socket; confirm orchestrator blocks)
5. Validate audit log append-only semantics under concurrent writers
6. VoC review — run a real conversation through the system; review all `[FLAG]` and `[BLOCKED]` outputs for legibility
7. Security Reviewer — full trust domain crossing review across the integrated system
8. Confirm all Stream G, H, L outputs are incorporated into deployment documentation before release

---

## PM Decisions Required

These are decisions that must be made before the relevant work can proceed. They are yours alone to close.

**1. Cato neurosymbolic escalation — Phase 1 or Phase 2?**
Recommendation: write the Cato spec to cover both paths, with the LLM escalation path clearly marked as Phase 2 implementation. The spec is complete; the implementation is phased.

**2. PSYCHE.md criteria enumeration — before or after the spec?**
Recommendation: draft the PSYCHE.md criteria enumeration as part of the Cato spec session, not in a separate prior step. The approved text becomes the canonical PSYCHE.md draft.

**3. Provider shim — which providers are in scope for v1.0?**
Recommendation: Anthropic (primary), Ollama (local, no credential), and a `custom` type. OpenRouter and others are v1.1. Confirm before Token Broker spec is finalised.

**4. Skill schema `.intent.md` — first real skill?**
Recommendation: Telegram channel adapter — well-understood surface area, makes the schema concrete.

**5. VoC review cadence.**
Recommendation: VoC review gate at the end of each stream's QA phase, before Security Review.

**6. Security Strengthening Document — approve and add to canonical doc set.**
Required before Streams G, H, and L can be commissioned.

**7. F-9 risk acceptance — MCP permission tier enforcement deferred.**
Required before any MCP-declaring skill ships. Must be a documented decision in DECISIONS.md.

**8. F-10 npm audit policy — Phase 1.**
Required before v1.0 ships. Closes after Stream L output is approved.

**9. Phase 2 Rust rewrite — dependency minimisation as acceptance criterion.**
Required at the start of Phase 2 scoping. Closes after Stream M output is approved.

---

## Active Document Set

| Document | Why |
|----------|-----|
| `docs/ARCHITECTURE.md` | The target. Read before any spec or implementation decision. |
| `docs/TEAM.md` | Role definitions, execution model, and handoff protocol (v2). |
| `docs/PM_BRIEF.md` | This document. |
| `docs/DECISIONS.md` | Architecture decision records. Developers and Spec Writers read before starting. |
| `docs/ECOSYSTEM.md` | Ecosystem context. Background for Spec Writers. |
| `docs/IMPLEMENTATION_AUDIT.md` | Gap list. Input to PLAN_V1.md. |
| `docs/SECURITY_STRENGTHENING.md` | Security and responsible AI gaps. Input to Streams G, H, L. |
| `docs/specs/<component>-spec.md` | One per component, as produced and approved. |

---

## Next Actions

**Immediately:** Commission PM approval of the Security Strengthening Document and add it to the canonical document set.

**Concurrently with Priority 1 spec completion:** Commission Stream G (Cybersecurity Specialist) as soon as Streams A and E specs are stable. Do not wait for all specs to be complete — G can begin with A and E alone.

**Before PLAN_V1.md is commissioned:** Sequence security and UX streams G–M into the milestone plan alongside development streams A–F. The Architect cannot produce PLAN_V1.md without this scope defined.

**Before Stream F begins:** Commission Stream J (UX — CLI and TUI) so that recommendations can inform the Channel Adapters spec, not merely comment on the implementation after the fact.
