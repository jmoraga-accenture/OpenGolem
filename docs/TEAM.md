# OpenGolem — Team
*Produced: 2026-04-05 | For Phase 2: v0.1 → v1.0*

OpenGolem is moving from a working prototype (v0.1, TypeScript, NanoClaw lineage cleared) to a designed system (v1.0, grounded in ARCHITECT_BRIEF.md and ARCHITECTURE.md). This document defines the team and roles needed to make that happen.

The v0.1 codebase is a starting point and a source of information — not the canonical target. Where v0.1 and ARCHITECTURE.md conflict, ARCHITECTURE.md is correct.

---

## Team

| Role | Who | Scope |
|------|-----|-------|
| **PM** | Jim | Owns the roadmap, sequencing, and milestone definitions. Final decision on all scope questions. |
| **Voice of Customer** | Jim | The "grandparent to enterprise" lens on every user-facing decision. Challenges complexity. Challenges jargon. Ensures explained-protection (ADR-4) actually lands. |
| **Architect** | Claude Code | Owns ARCHITECTURE.md. Resolves design questions that cross trust domain boundaries. Produces the v0.1 → v1.0 gap analysis and implementation plan. |
| **Spec Writer** | Claude Code | Translates ARCHITECTURE.md sections into behavioral specifications per component. One spec per component. |
| **Developer** | Claude Code | Implements components against their behavioral specs. Works one component at a time per stream. Does not make architectural decisions. |
| **Tester** | Claude Code | Writes tests from behavioral specs before implementation begins (TDD). Tests are the spec made executable. |
| **Security Reviewer** | Claude Code | Reviews every trust domain crossing and IPC boundary in the implementation against ARCHITECTURE.md. Reports violations; does not fix them. |
| **QA/QC** | Claude Code | Runs the full test suite. Verifies integration across component boundaries. Produces pass/fail verdict per milestone. |

Jim holds the three roles that cannot be delegated: PM (roadmap and scope authority), Voice of Customer (no AI can stand in for real users), and final merge approval. Every other role is executed by Claude Code in a session scoped to that role's work.

---

## Starting Point vs. Target

**v0.1 codebase** — what exists in `src/`. Produced from the NanoClaw lineage (cleared), proving the core ideas work: container isolation, Token Broker, Call Inspector, Cato inline hook (deterministic stub), SOUL.md / PSYCHE.md, dao_score, channel adapters. Approximately 520 tests. Architecturally inherited, not designed to ARCHITECTURE.md.

**v1.0 target** — defined by ARCHITECTURE.md and the behavioral specs derived from it. The trust domain map, IPC schemas, component responsibility boundaries, skill schema, and memory tier access controls are the canonical targets.

**What this means in practice:**

- Where a v0.1 component maps cleanly to its ARCHITECTURE.md counterpart, it becomes the starting implementation — refactored to spec, not rewritten from scratch.
- Where a v0.1 component contradicts the architecture (wrong trust domain, in-process when it should be out-of-process, holding credentials it should not hold), it is replaced.
- Where the architecture requires something with no v0.1 equivalent, it is built from the spec.

The Architect produces the gap analysis (keep / shed / build per component) before the Developer workstreams begin.

---

## Roles in Detail

### PM — Jim

Defines the milestone sequence. Each milestone has:
- A target component or set of components
- A definition of done (what QA must confirm before the milestone closes)
- A sequencing constraint (what must exist before this can start)

The PM does not write code or specs. The PM approves specs before the Developer starts — because a spec that does not match the PM's intent produces correct-but-wrong implementation.

### Voice of Customer — Jim

Invoked specifically when:
- A `[BLOCKED]` message template is written (would a non-technical user understand it?)
- A skill's `.intent.md` is declared (is the `apply_permission` level right for the intended operator?)
- Cato's risk code descriptions are written (is `PATH_TRAVERSAL` legible, or should the user see something else?)
- An error message or health endpoint output is designed

This role does not review code. It reviews what users see and experience.

### Architect — Claude Code

Holds the current design session context. Responsible for:

1. **Gap analysis** — walks v0.1 `src/` against ARCHITECTURE.md and classifies each component: keep, shed, or build. Produces `docs/IMPLEMENTATION_AUDIT.md`.
2. **Implementation plan** — sequences the gap list into milestones, identifies what can run in parallel (components with no shared IPC dependency), and produces `docs/PLAN_V1.md`.
3. **ADR maintenance** — when an implementation question reveals an architectural gap or ambiguity, the Architect is consulted. If the answer changes ARCHITECTURE.md, the Architect updates it and the decision is recorded.
4. **Spec review** — reviews each behavioral spec for consistency with ARCHITECTURE.md before the Developer starts. Not for completeness (that is QA's job) — for architectural correctness.

The Architect does not implement code.

### Spec Writer — Claude Code

Produces one behavioral spec per component. A behavioral spec defines:
- What the component does (observable behavior, not internal structure)
- Its external interface (input schema, output schema, protocol)
- Its behavioral contract (given X → must produce Y)
- Its failure modes (what it does when dependencies are unavailable)
- Its invariants (properties that hold at all times)
- Acceptance criteria (testable, binary)

The Spec Writer reads ARCHITECTURE.md and the component's section in it. It does not read `src/` — the spec describes the target, not the current state.

One spec is produced per session. The PM reviews and approves before work proceeds.

### Developer — Claude Code

Implements one component per session, working from:
- The behavioral spec for that component
- ARCHITECTURE.md §4 (IPC schemas — the interface contract)
- The test suite (written by the Tester before implementation starts)
- The v0.1 implementation of the same component, as a reference only — not as a constraint

The Developer does not make architectural decisions. If a spec is ambiguous or contradicts ARCHITECTURE.md, the session stops and the Architect is consulted before implementation continues.

**File structure rules (enforced by convention — no exceptions):**

- Every component lives in its own subdirectory under `src/`: `src/broker/`, `src/cato/`, `src/skills/`, `src/memory/`, `src/orchestrator/`, etc.
- No application source files are created directly in `src/` root. Shared utilities and types that are genuinely cross-component live in `src/shared/`.
- v0.1 files currently flat in `src/` root (`container-runner.ts`, `db.ts`, `ipc.ts`, `router.ts`, etc.) are relocated into the appropriate component subdirectory as part of the stream that refactors them. The Developer does not leave them in place and import from there.
- Test files live alongside the source they test: `src/broker/token-broker.test.ts` tests `src/broker/token-broker.ts`. No test files in `src/` root.
- Configuration files (`vitest.config.ts`, `eslint.config.js`, `tsconfig.json`) remain at project root — this is correct and expected.
- `tsconfig.json` `rootDir: "./src"` is a hard compiler guardrail. Do not change it.

### Tester — Claude Code

Writes tests before the Developer starts. Reads the behavioral spec only — not `src/`, not v0.1 tests. The goal is tests that verify the acceptance criteria independently of how the implementation works internally.

Tests are organized in four tiers:

| Tier | Tests what | When |
|------|-----------|------|
| Unit | Component in isolation; all dependencies stubbed | Every commit |
| Contract | IPC protocol compliance — does the component honor its wire schema? | Every PR |
| Integration | Component with real dependencies (real SQLite, real Unix socket) | Pre-merge |
| Stub detection | Verifies that a real behavioral failure causes a test failure | Pre-merge |

The stub detection tier prevents tests that always pass. Every test must demonstrate that a behavioral failure causes a test failure — not just that the component exists.

### Security Reviewer — Claude Code

Reviews the implementation of every trust domain crossing in a completed component. Reads:
- ARCHITECTURE.md §2 (trust domain map) and §4 (IPC boundaries)
- The implementation diff for the component

Does not read the behavioral spec during review — the review tests compliance with the architecture, not compliance with the spec. Both are needed and they are independent.

Specific checks (from ARCHITECTURE.md):

1. Does every trust domain crossing use the documented protocol? (§4)
2. Does any component hold credentials beyond its chartered scope? (ADR-7)
3. Is every Cato inline hook failure handled fail-closed? (§3.4)
4. Is the audit log write path append-only with no UPDATE/DELETE? (ADR-9)
5. Do container mounts expose only the declared group filesystem? (§4.4)
6. Does the token delegation path enforce the ceiling rule? (ADR-5)

Verdict: **approved**, **approved with concerns** (documented, non-blocking), or **blocked** (must fix before merge).

### QA/QC — Claude Code

Runs the full test suite against the completed component on its branch. Reads the behavioral spec's acceptance criteria and verifies each one against actual test output. Produces a pass/fail verdict per milestone with specific criteria references.

QA/QC does not fix code. Failures go back to the Developer with the specific acceptance criterion that failed.

---

## Workflow

```
PM defines milestone
    └── Component target + definition of done

Spec Writer produces behavioral spec
    └── PM + Architect review before work begins

Tester writes tests from spec
    └── Tests must fail (no implementation yet) — confirms tests are real

Developer implements from spec + test suite + v0.1 reference
    └── All tests pass before handoff

QA/QC runs full test suite
    └── Pass → Security Review
    └── Fail → back to Developer

Security Reviewer checks trust domain and IPC compliance
    └── Approved → PM review
    └── Blocked → back to Developer

PM reviews diff and VoC-sensitive outputs
    └── Approves merge to main
```

No role is optional. A fast Developer who skips QA or Security Review produces an unreviewed component regardless of test count.

---

## Parallel Streams

Components with no shared IPC dependency can be implemented simultaneously:

| Stream | Component | Depends on |
|--------|-----------|-----------|
| A | Token Broker + Call Inspector | Nothing |
| B | Cato v2 (neurosymbolic) | PSYCHE.md criteria draft — produced inside the Cato spec (PM decision, Decision 14 session) |
| C | Skill Schema | Nothing |
| D | Memory Tiers (all three) | Nothing |
| E | Orchestrator v2 | Stream A + B + C interfaces |
| F | Channel Adapters | Orchestrator interface |

Streams A–D can run simultaneously once their specs are approved. Stream E starts when A, B, and C have stable, approved interfaces (not necessarily complete implementations). Stream F starts when E has a stable inbound message interface.

**PSYCHE.md criteria:** The Cato behavioral spec (Stream B) includes a subsection drafting the PSYCHE.md question enumeration. PM reviews and approves that section as part of the spec review gate. The approved text becomes the canonical PSYCHE.md draft; a separate prior spec step is not required.

---

## Handoff Rule

Every role transition produces a document the receiving role can act on without asking questions. If the receiver cannot start from the handoff artifact alone, the sender must improve it before the transition proceeds.

| Transition | Artifact |
|-----------|---------|
| PM → Spec Writer | Component brief (scope, relevant ARCHITECTURE.md sections, definition of done) |
| Spec Writer → Tester | Behavioral spec |
| Spec Writer → Developer | Behavioral spec |
| Tester → Developer | Test suite in place in the branch |
| Developer → QA | Implementation complete, tests passing locally |
| QA → Security Reviewer | QA report (which criteria passed, which failed, overall verdict) |
| Security Reviewer → PM | Review verdict (finding list, severity, overall verdict) |

---

*The v0.1 codebase proved the ideas work. The team's job is to build the system that was always the right answer — now that the philosophy and architecture are defined well enough to drive it.*
