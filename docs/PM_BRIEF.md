# OpenGolem — PM Brief
*Produced: 2026-04-05 | Owner: Jim (PM) | Status: ready to execute*

This is the operating document for driving OpenGolem from v0.1 to v1.0. It tells you what exists, what needs to happen next, in what order, and how to start each piece of work.

---

## Current Status *(updated 2026-04-05)*

| Phase | Step | Status | Notes |
|-------|------|--------|-------|
| Phase 0 — Foundation | All | **Complete** | Architecture, team, PM brief |
| Phase 1 — Specifications | Step 1.1 Implementation Audit | **Complete** | `docs/IMPLEMENTATION_AUDIT.md` produced |
| Phase 1 — Specifications | Step 1.2 Priority 1 specs (A–D) | **In progress** | 4 Spec Writer agents running in parallel |
| Phase 1 — Specifications | Step 1.2 Priority 2 spec (Orchestrator, Stream E) | **Blocked** — awaiting A, B, C interfaces | |
| Phase 1 — Specifications | Step 1.2 Priority 3 specs (Channel Adapters, Audit Log, SOUL/PSYCHE) | **Not started** | |
| Phase 1 — Specifications | PLAN_V1.md (Architect milestone plan) | **Not yet commissioned** | Commission Architect after Priority 1 specs are approved; input is audit + approved interfaces |
| Phase 2 — Development | All streams | **Blocked** — awaiting specs | |
| Phase 3 — Integration | All | **Blocked** — awaiting Phase 2 | |

**In-flight specs (Priority 1):**
- Stream A — Token Broker + Call Inspector → `docs/specs/token-broker-spec.md`
- Stream B — Cato → `docs/specs/cato-spec.md`
- Stream C — Skill Schema → `docs/specs/skill-schema-spec.md`
- Stream D — Memory Tiers → `docs/specs/memory-tiers-spec.md`

**PM review gate:** When all four Priority 1 specs land, PM reviews each for VoC alignment and commissions Architect review for architectural consistency. Approved specs unlock Tester and Developer for those streams.

**Open PM decisions:** None. Two decisions made this session (Decision 13: remote-control.ts keep; Decision 14: Cato scheduled audit = hansei + poll). Recorded in `docs/DECISIONS.md`.

---

---

## What Exists Right Now

| Document | What it is | Status |
|----------|-----------|--------|
| `docs/ARCHITECT_BRIEF.md` | The mandate given to the architect — philosophy, constraints, deliverables | Complete. Reference. |
| `docs/REVIEW_META_PLAN.md` | The philosophical session that resolved six tensions and produced the 6 anchors | Complete. Reference. |
| `docs/ARCHITECTURE_REVIEW.md` | Six propositions reviewed and adopted (R1–R6) — feeds into ARCHITECTURE.md | Complete. Reference. |
| `docs/ARCHITECTURE.md` | The "to be" architecture: process model, trust domains, IPC schemas, skill schema, memory tiers, 9 ADRs | **Canonical. Everything derives from here.** |
| `docs/TEAM.md` | Team roles, information walls, handoff artifacts, parallel workstreams | Complete. |
| `docs/DECISIONS.md` | Implementation-level ADRs from v0.1 — partially absorbed into ARCHITECTURE.md | Keep. Useful reference for Developers. |
| `docs/ECOSYSTEM.md` | NanoClaw / MicroClaw positioning — what OpenGolem takes from each | Keep. Useful context for Spec Writers. |
| `docs/archive/` | Superseded v0.1 docs (SPECS-v0.4, PLAN-v0.1, INTERNALS, SECURITY_AUDIT, component specs) | Reference only. Not canonical. |
| `src/` | v0.1 codebase — 520 tests, NanoClaw lineage cleared | Starting point. Informational. Not canonical. |

**The single source of truth for v1.0 is `docs/ARCHITECTURE.md`.** When anything conflicts with it, ARCHITECTURE.md wins.

---

## The Four Phases

```
Phase 0 — Foundation       [COMPLETE]
  Philosophy, architecture, team defined.

Phase 1 — Specifications   [NEXT]
  Gap analysis + behavioral spec per component.

Phase 2 — Development      [BLOCKED on Phase 1]
  Implement components against specs. Parallel streams.

Phase 3 — Integration      [BLOCKED on Phase 2]
  Cross-component integration, full QA, v1.0 release.
```

---

## Phase 1 — Specifications

Phase 1 has two steps that must happen in order.

### Step 1.1 — Implementation Audit

**What it is:** A read-only analysis of `src/` against `ARCHITECTURE.md`. Every component is classified: keep (maps to architecture), shed (contradicts architecture), or build (no v0.1 equivalent). Produces `docs/IMPLEMENTATION_AUDIT.md`.

**Who does it:** Architect (Claude Code, Explore subagent — read-only, no code changes).

**How to trigger it:**
> "You are the Architect. Read `docs/ARCHITECTURE.md` in full. Then walk `src/` and classify every component against the architecture. For each component: (1) does it match ARCHITECTURE.md? (2) does it contradict it? (3) does ARCHITECTURE.md require something not present? Produce `docs/IMPLEMENTATION_AUDIT.md` with a verdict per component (keep / shed / build) and one-paragraph justification. Do not change any code."

**Output:** `docs/IMPLEMENTATION_AUDIT.md`

**You are done when:** Every component in `src/` has a verdict, and every ARCHITECTURE.md component has an entry (even if it is "build — no equivalent").

**This is the input to Step 1.2.**

---

### Step 1.2 — Behavioral Specs

**What it is:** One behavioral specification per component, derived from ARCHITECTURE.md. Written by the Spec Writer. The spec defines observable behavior, external interface (exact schema), behavioral contract, failure modes, invariants, and acceptance criteria. It does not describe implementation internals.

**Who does it:** Spec Writer (Claude Code, general-purpose). One session per spec.

**Spec format** (from `docs/TEAM.md`):
```
# Component Name — Behavioral Specification
## Responsibilities
## External Interface
## Behavioral Contract
## Failure Modes
## Invariants
## Acceptance Criteria
```

**Where they go:** `docs/specs/<component>-spec.md`

**Order:** Use the parallel stream map from `docs/TEAM.md`. Specs for independent streams (A–D) can be written in parallel. Stream E (Orchestrator) spec waits until the interfaces for A, B, and C are defined in their specs.

**Spec queue — ordered by dependency:**

| Priority | Component | Stream | Relevant ARCHITECTURE.md sections |
|----------|-----------|--------|-----------------------------------|
| 1 | Token Broker + Call Inspector | A | §1.1 (Broker), §3.2 (Broker), §3.3 (Inspector), §4.2 (Orch→Broker IPC), §4.5 (Container→Broker), §4.6 (Broker→External), ADR-5, ADR-7 |
| 1 | Cato (inline hook + scheduled audit) | B | §1.1 (Cato), §3.4 (Cato), §4.3 (Orch→Cato IPC), §4.3.1 (risk codes), ADR-2, ADR-3 |
| 1 | Skill Schema | C | §5 (entire section) |
| 1 | Memory Tiers | D | §6 (entire section), §6.4 (access matrix) |
| 2 | Orchestrator | E | §1.1 (Orch), §1.3 (startup), §3.1 (Orch responsibilities), §4.1–§4.4, §4.7–§4.8 |
| 3 | Channel Adapters | F | §3.6, §4.1, ADR-6 |
| 3 | Audit Log | — | §3.7, §4.8, ADR-9 |
| 3 | SOUL.md / PSYCHE.md governance | — | §3.5 (Alef), §3.4 (Cato/PSYCHE.md), ADR-1, ADR-4 |

**How to trigger a spec** (example for Token Broker):
> "You are the Spec Writer. Read `docs/ARCHITECTURE.md` sections §1.1, §3.2, §3.3, §4.2, §4.5, §4.6, and ADRs 5 and 7. Do not read `src/`. Write a behavioral specification for the Token Broker and Call Inspector as a single document at `docs/specs/token-broker-spec.md`. Use the spec format defined in `docs/TEAM.md`. Do not describe implementation; describe observable behavior, exact wire schemas, failure modes, and testable acceptance criteria."

**You are done with Phase 1 when:** All eight specs above exist and have been reviewed by you (PM) for alignment with your VoC expectations, and the Architect has confirmed each spec is internally consistent with ARCHITECTURE.md.

### Step 1.3 — Implementation Plan (PLAN_V1.md)

**What it is:** After Priority 1 specs are approved and their external interfaces are stable, the Architect sequences the full component list into numbered milestones with definitions of done, ordering constraints, and parallel stream assignments. Produces `docs/PLAN_V1.md`.

**Who does it:** Architect (Claude Code).

**When to trigger:** After PM approves Priority 1 specs (A–D). Does not require Priority 2–3 specs to be complete — the Architect can plan around their pending interfaces.

**How to trigger:**
> "You are the Architect. Read `docs/ARCHITECTURE.md`, `docs/IMPLEMENTATION_AUDIT.md`, `docs/TEAM.md`, and the approved specs in `docs/specs/`. Produce `docs/PLAN_V1.md`: a numbered milestone sequence for Phase 2 development. Each milestone has: target component(s), definition of done (specific acceptance criteria from the spec), sequencing constraints (what must exist first), and stream assignment. Group milestones by stream where possible. Identify any ordering dependencies across streams."

**Output:** `docs/PLAN_V1.md`

---

## Phase 2 — Development

Phase 2 opens when Phase 1 is complete for at least one stream. You do not need all specs before starting development — you need the specs for the stream you are starting.

### Development cycle per component (from `docs/TEAM.md`)

```
1. PM confirms spec is approved
2. Tester writes tests from spec (no src/ access)
3. Tests must initially fail — confirms tests are real
4. Developer implements from spec + test suite + v0.1 as reference
5. All tests pass before handoff
6. QA/QC runs full suite, verifies acceptance criteria
7. Security Reviewer checks trust domain + IPC compliance
8. PM reviews and approves merge
```

### Parallel streams

These can run simultaneously once their specs are ready:

| Stream | Component | v0.1 starting point | Expected verdict |
|--------|-----------|--------------------|--------------------|
| A | Token Broker + Call Inspector | `src/broker/`, `src/inspector/`, `src/credential-proxy.ts` | Mostly keep; extend for delegation ceiling (ADR-5), provider type field (ADR-7) |
| B | Cato | `src/cato/` | Keep deterministic stub; build neurosymbolic escalation path (Phase 2 per ADR-2) |
| C | Skill Schema | No equivalent (M8 not started) | Build from scratch |
| D | Memory Tiers | `src/db.ts`, `groups/*/CLAUDE.md` | Tier 1+2 extend; Tier 3 (semantic graph) build from scratch |
| E | Orchestrator | `src/index.ts`, `src/ipc.ts`, `src/group-queue.ts`, `src/container-runner.ts`, `src/router.ts`, `src/task-scheduler.ts` | Refactor to spec; trust domain boundaries enforced |
| F | Channel Adapters | `src/channels/` | Keep; `.intent.md` declarations added |

### How to trigger a development workstream

Once a spec is approved, trigger Tester first:
> "You are the Tester. Read `docs/specs/<component>-spec.md` only. Do not read `src/`. Write a complete test suite for this component at `src/<component>/<component>.test.ts`. Every test must verify a specific acceptance criterion from the spec. Tests should fail with no implementation present."

Then Developer:
> "You are the Developer. Read `docs/specs/<component>-spec.md`, `docs/ARCHITECTURE.md` §4 (IPC schemas), and the test suite at `src/<component>/<component>.test.ts`. Use `src/<v0.1-equivalent>/` as a reference for context — it is not canonical. Implement the component such that all tests pass. Do not make architectural decisions; if the spec is ambiguous, stop and ask."

---

## Phase 3 — Integration

Phase 3 begins when Streams A, B, and E are complete and passing their individual QA gates.

Integration work:
1. Wire Orchestrator to real Token Broker and real Cato (replacing stubs)
2. Run integration tests across the full process model (Orchestrator + Broker + Cato + one container)
3. Validate the sentinel protocol end-to-end
4. Validate Cato fail-closed behavior (kill the Cato socket; confirm orchestrator blocks)
5. Validate audit log append-only semantics under concurrent writers
6. VoC review: run a real conversation through the system; review all `[FLAG]` and `[BLOCKED]` outputs for legibility

---

## Your Decisions as PM

These are questions that will arise during specifications and development that only you can answer. Think about them now.

**1. Cato neurosymbolic escalation — when?**
ARCHITECTURE.md ADR-2 specifies the LLM escalation path for Phase 2. The spec for Cato (Stream B) needs to know: does Phase 2 begin with the neurosymbolic path included in scope, or does the deterministic stub get a spec first and the LLM escalation is a later spec? Recommendation: write the Cato spec to cover both paths, with the escalation path clearly marked as "Phase 2 implementation." The spec is complete; the implementation is phased.

**2. PSYCHE.md criteria enumeration — before or after the spec?**
ADR-2 requires PSYCHE.md to enumerate the exact questions Cato's LLM is allowed to ask. This content must exist before the Cato spec's "behavioral contract" section can be complete for the LLM path. Recommendation: you and the Architect draft the PSYCHE.md criteria enumeration as part of the Cato spec session, not separately.

**3. Provider shim — which providers are in scope for v1.0?**
ARCHITECTURE.md ADR-7 and R2 commit to provider-agnostic routing. The Token Broker spec needs to know which `provider_type` values are in v1.0 scope. Recommendation: Anthropic (primary), Ollama (local self-hosted, no credential), and a `custom` type. OpenRouter and others are v1.1.

**4. Skill schema `.intent.md` — first real skill?**
Stream C defines the schema. But a schema is validated against real skills. The first real skill to have `.intent.md` declared against the new schema is the one that makes the schema concrete. Recommendation: Telegram channel adapter (already exists in v0.1, well-understood surface area, makes a good first target).

**5. VoC review points — when?**
The Voice of Customer role is invoked at specific points (per `docs/TEAM.md`): `[BLOCKED]` message templates, skill `.intent.md` declarations, error messages, health output. Plan a VoC review gate at the end of each stream's QA phase, before Security Review. This keeps the user experience honest throughout rather than one big review at the end.

---

## Active Document Set (what to keep open)

| Document | Why |
|----------|-----|
| `docs/ARCHITECTURE.md` | The target. Read before any spec or implementation decision. |
| `docs/TEAM.md` | Role definitions and handoff protocol. |
| `docs/PM_BRIEF.md` | This document. Your operating brief. |
| `docs/DECISIONS.md` | Implementation-level ADRs still valid for developers. |
| `docs/ECOSYSTEM.md` | Background context for Spec Writers. |
| `docs/IMPLEMENTATION_AUDIT.md` | Produced in Step 1.1. Gap list for all streams. |
| `docs/specs/<component>-spec.md` | One per component, as they are written. |

---

## Next Action

**Right now:** Commission Step 1.1 — the Implementation Audit.

Use the trigger prompt from Step 1.1 above. The audit returns a keep/shed/build verdict per component. You review it, then sequence the spec queue in Step 1.2 based on the actual verdicts.

Nothing in Phase 2 starts before the audit is complete and the first spec is approved.
