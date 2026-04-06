# OpenGolem — Team v2
*Produced: 2026-04-05 | Supersedes: TEAM.md v1*

OpenGolem is moving from a working prototype (v0.1, TypeScript, NanoClaw lineage cleared) to a designed system (v1.0, grounded in ARCHITECT_BRIEF.md and ARCHITECTURE.md). This document defines the team structure, role execution model, and handoff protocol for that transition.

The v0.1 codebase is a starting point and a source of information — not the canonical target. Where v0.1 and ARCHITECTURE.md conflict, ARCHITECTURE.md is correct.

---

## Role Execution Model

In April 2026, frontier models are capable of executing any specialist role to a production standard. The team operates on this basis. Every role — including PM, Voice of Customer, and specialist functions — can be executed by a frontier model in a session scoped to that role's remit.

**Jim's authority is non-delegable. His execution is.** Jim holds three authorities that cannot be transferred: roadmap and scope decisions, risk acceptance sign-offs, and final merge approval. He does not need to personally execute every task those authorities oversee. A frontier model operating in a scoped PM session can draft the milestone sequence; Jim approves or revises it. A frontier model operating as Voice of Customer can assess a `[BLOCKED]` message template against the grandparent-to-enterprise spectrum; Jim confirms or overrides the assessment.

The practical implication: every role produces an artifact, and every artifact requires Jim's review and approval before it is acted upon. The frontier model executes; Jim governs.

---

## Team

| Role | Executed by | Jim's authority gate |
|------|-------------|----------------------|
| **PM** | Frontier model (scoped session) | Approves milestone sequence and scope decisions |
| **Voice of Customer** | Frontier model (scoped session) | Confirms VoC assessments against lived experience |
| **Architect** | Frontier model (scoped session) | Approves ADRs and architectural changes |
| **Spec Writer** | Frontier model (scoped session) | Approves specs before development starts |
| **Developer** | Frontier model (scoped session) | Approves merge |
| **Tester** | Frontier model (scoped session) | Reviews test suite before development starts |
| **Security Reviewer** | Frontier model (scoped session) | Approves security review verdicts |
| **QA/QC** | Frontier model (scoped session) | Approves QA verdict before merge |
| **Cybersecurity Specialist** | Frontier model (scoped session) | Approves threat model findings and ADR recommendations |
| **DevOps / Systems Administrator** | Frontier model (scoped session) | Approves deployment hardening guidance and runbooks |
| **UX / Interaction Designer** | Frontier model (scoped session) | Approves UX recommendations before implementation |
| **Supply-Chain Auditor** | Frontier model (scoped session) | Approves dependency audit findings and policy |

---

## Roles in Detail

### PM

Defines the milestone sequence, sequencing constraints, and definitions of done per milestone. Commissions and sequences all other roles. Maintains PM_BRIEF.md as the operating document. Does not write code or specs, and does not make architectural decisions — those belong to the Architect.

When triggered as a frontier model session, the PM role reads ARCHITECTURE.md, TEAM.md, DECISIONS.md, and the current PM_BRIEF.md. It produces: revised milestone sequences, stream assignments, or scope recommendations. Jim approves before any output is acted upon.

### Voice of Customer

The "grandparent to enterprise" lens applied to every user-facing decision. Invoked specifically when a `[BLOCKED]` or `[FLAG]` message template is written, when Cato risk code descriptions are authored, when error messages or health output are designed, and at the end of each development stream's QA phase before Security Review.

This role reviews what users see and experience. It does not review code.

### Architect

Owns ARCHITECTURE.md. Resolves design questions that cross trust domain boundaries. Produces the v0.1 → v1.0 gap analysis (IMPLEMENTATION_AUDIT.md) and the milestone implementation plan (PLAN_V1.md). Reviews each behavioral spec for architectural consistency before development starts. Updates ARCHITECTURE.md and records ADRs when implementation questions reveal design gaps.

The Architect does not implement code.

### Spec Writer

Produces one behavioral specification per component, derived from ARCHITECTURE.md. A behavioral spec defines observable behavior, external interface (exact schema), behavioral contract, failure modes, invariants, and acceptance criteria. It does not describe implementation internals.

The Spec Writer reads ARCHITECTURE.md and the relevant component sections. It does not read `src/` — the spec describes the target, not the current state. One spec is produced per session. Jim reviews and approves before development proceeds.

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

### Developer

Implements one component per session, working from the behavioral spec, ARCHITECTURE.md §4 (IPC schemas), and the test suite written by the Tester. The v0.1 implementation of the same component is available as a reference, not a constraint. The Developer does not make architectural decisions. If a spec is ambiguous or contradicts ARCHITECTURE.md, the session stops and the Architect is consulted.

**File structure rules (enforced by convention — no exceptions):**

- Every component lives in its own subdirectory under `src/`: `src/broker/`, `src/cato/`, `src/skills/`, `src/memory/`, `src/orchestrator/`, etc.
- No application source files are created directly in `src/` root. Shared utilities and types that are genuinely cross-component live in `src/shared/`.
- v0.1 files currently flat in `src/` root are relocated into the appropriate component subdirectory as part of the stream that refactors them. The Developer does not leave them in place and import from there.
- Test files live alongside the source they test: `src/broker/token-broker.test.ts` tests `src/broker/token-broker.ts`. No test files in `src/` root.
- Configuration files (`vitest.config.ts`, `eslint.config.js`, `tsconfig.json`) remain at project root — this is correct and expected.
- `tsconfig.json` `rootDir: "./src"` is a hard compiler guardrail. Do not change it.

### Tester

Writes tests before the Developer starts. Reads the behavioral spec only — not `src/`, not v0.1 tests. Tests verify acceptance criteria independently of how the implementation works internally.

Tests are organised in four tiers: unit (component in isolation, all dependencies stubbed), contract (IPC protocol compliance — does the component honour its wire schema?), integration (component with real dependencies), and stub detection (verifies that a real behavioral failure causes a test failure — prevents tests that always pass).

### Security Reviewer

Reviews the implementation of every trust domain crossing in a completed component. Reads ARCHITECTURE.md §2 (trust domain map) and §4 (IPC boundaries) and the implementation diff. Does not read the behavioral spec during review — the review tests compliance with the architecture, not the spec. Both checks are required and they are independent.

### QA/QC

Runs the full test suite and verifies integration across component boundaries. Produces a pass/fail verdict per milestone. Does not make architectural or implementation decisions.

### Cybersecurity Specialist

Scoped to threat modelling and security architecture review. The session is provided with ARCHITECTURE.md, the behavioral specs, and the Security Strengthening Document. It produces findings, severity assessments, and ADR recommendations for transport security, audit log integrity, dependency surface risk, and in-process adapter supply-chain risk. Jim reviews all findings before they are incorporated into ADRs or the specification backlog.

This role is invoked at two points: before v1.0 scope is finalised (to close the findings in the Security Strengthening Document), and at the Phase 2 Rust rewrite design stage (to validate the reduced dependency surface).

### DevOps / Systems Administrator

Produces deployment hardening guidance and operational runbooks. The session is provided with the architecture process model, the Token Broker spec, and the Orchestrator spec. It produces: a network hardening annex for the deployment documentation, a credential rotation runbook with time-to-rotation targets per backend type, and a broker crash recovery procedure. Jim approves before any guidance is published.

### UX / Interaction Designer

Responsible for three distinct surfaces, each reviewed in a separate session.

The first is setup and onboarding: the sequence of steps from cloning the repository to a running, correctly configured system. The review assesses cognitive load for a non-expert operator and produces recommendations for documentation structure and progressive disclosure.

The second is the CLI and TUI interaction model: the `opengolem>` prompt, the TUI health dashboard, the health panel toggle (`Ctrl-D`), and the administrative command surface. The review assesses information hierarchy, error message clarity, and legibility of security state for the target user spectrum.

The third is the Report Dashboard skill, which is the primary governance interface for human calibration decisions (ADR-3). Because the dashboard surfaces KPI trends, block history, hansei findings, and threshold change recommendations, its information design directly affects the quality of human oversight decisions. This is the highest-consequence UX surface in the system from a responsible AI standpoint and should be reviewed before the dashboard skill spec is written, not after.

Each session reads the relevant behavioral specs and produces wireframe-level information architecture recommendations and annotated user flow descriptions, not visual design. Jim approves before the recommendations are incorporated into specs or implementation.

### Supply-Chain Auditor

Responsible for the external dependency surface across all three layers identified in the Security Strengthening Document: the Node.js runtime and npm package graph (Phase 1), the Rust crate dependency graph (Phase 2), and the agent container base image. The session produces: a dependency audit report for the current Phase 1 baseline, a crate dependency minimisation policy and target graph for Phase 2, and a container image pinning and scanning policy. Jim approves before the policies are adopted.

This role is invoked once for Phase 1 (before v1.0 ships) and once at the start of Phase 2 (before the Rust crate structure is finalised).

---

## Starting Point vs. Target

**v0.1 codebase** — what exists in `src/`. Produced from the NanoClaw lineage (cleared), proving the core ideas work: container isolation, Token Broker, Call Inspector, Cato inline hook (deterministic stub), SOUL.md / PSYCHE.md, dao_score, channel adapters. Approximately 520 tests. Architecturally inherited, not designed to ARCHITECTURE.md.

**v1.0 target** — defined by ARCHITECTURE.md and the behavioral specs derived from it. The trust domain map, IPC schemas, component responsibility boundaries, skill schema, and memory tier access controls are the canonical targets.

Where a v0.1 component maps cleanly to its ARCHITECTURE.md counterpart, it becomes the starting implementation — refactored to spec, not rewritten from scratch. Where a v0.1 component contradicts the architecture, it is replaced. Where the architecture requires something with no v0.1 equivalent, it is built from the spec.

The Architect produces the gap analysis (keep / shed / build per component) before the Developer workstreams begin.

---

## Parallel Streams

### Development streams (original)

| Stream | Component | Depends on |
|--------|-----------|------------|
| A | Token Broker + Call Inspector | Nothing |
| B | Cato v2 (neurosymbolic) | PSYCHE.md criteria draft (produced in the Cato spec session) |
| C | Skill Schema | Nothing |
| D | Memory Tiers (all three) | Nothing |
| E | Orchestrator v2 | Stream A + B + C interfaces |
| F | Channel Adapters | Orchestrator interface |

Streams A–D can run simultaneously once their specs are approved. Stream E starts when A, B, and C have stable, approved interfaces. Stream F starts when E has a stable inbound message interface.

### Security and UX streams (added v2)

| Stream | Work | Depends on | Jim gate |
|--------|------|------------|----------|
| G | Cybersecurity Specialist review (Security Strengthening Document F-1 through F-10) | Security Strengthening Document; approved specs for A and E | Approves findings; commissions ADRs |
| H | DevOps hardening guidance and runbooks | Token Broker spec; Orchestrator spec | Approves before publication |
| I | UX review — setup and onboarding | Draft deployment documentation | Approves recommendations |
| J | UX review — CLI and TUI | Channel Adapters spec; health endpoint spec | Approves before Stream F implementation |
| K | UX review — Report Dashboard | Dashboard skill spec (Stream C sub-item) | Approves before dashboard spec is finalised |
| L | Supply-Chain Audit — Phase 1 | Current `package.json` and lockfile | Approves policy before v1.0 ships |
| M | Supply-Chain Audit — Phase 2 | Phase 2 Rust crate structure draft | Approves dependency minimisation target |

Stream G should begin as soon as the Security Strengthening Document is approved and Streams A and E specs are available. Streams I, J, and K are sequenced against the UX surfaces they review, not against development streams — they should run ahead of or parallel to the relevant development work, not after it.

---

## Handoff Rule

Every role transition produces a document the receiving role can act on without asking questions. If the receiving role cannot start from the handoff artifact alone, the sending role must improve it before the transition proceeds.

| Transition | Artifact |
|------------|---------|
| PM → Spec Writer | Component brief (scope, relevant ARCHITECTURE.md sections, definition of done) |
| PM → Cybersecurity Specialist | Security Strengthening Document + relevant specs |
| PM → DevOps | Token Broker spec + Orchestrator spec + findings from Stream G |
| PM → UX Designer | Relevant behavioral specs + Voice of Customer assessment |
| PM → Supply-Chain Auditor | Current dependency manifest + Security Strengthening Document F-10 |
| Spec Writer → Tester | Behavioral spec |
| Spec Writer → Developer | Behavioral spec |
| UX Designer → Spec Writer | Annotated information architecture recommendations |
| Cybersecurity Specialist → Architect | Findings report with ADR recommendations |
| Tester → Developer | Test suite in place in the branch, initially failing |
| Developer → QA | Implementation complete, tests passing locally |
| QA → Security Reviewer | QA report (criteria passed/failed, overall verdict) |
| Security Reviewer → PM | Review verdict (finding list, severity, overall verdict) |

---

*The v0.1 codebase proved the ideas work. The team's job is to build the system that was always the right answer — now that the philosophy, architecture, and security posture are defined well enough to drive it.*
