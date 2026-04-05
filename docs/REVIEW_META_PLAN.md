# OpenGolem — Philosophical & Architectural Review: Meta-Plan
*Started: 2026-04-05 | Tracks the review session that precedes SPECS.md v0.5 and Phase 2*

No implementation work proceeds until this plan is closed.

---

## Purpose

M1–M9 + NanoClaw lineage clearance are complete. Before Phase 2 (clean-lab rewrite), six philosophical and architectural tensions must be resolved. This document tracks the review session, the decisions made, and the artifacts it produces.

---

## Decisions

| ID | Question | Status | Decision |
|----|----------|--------|----------|
| A | Who is OpenGolem for? | ✅ Closed | Personal-first, team-capable (Phase 2+ Skill-layer only). Crucially: NOT power-users-only — **the inverse**. Current systems require power users because they don't take safety seriously. OpenGolem's safety infrastructure IS the accessibility layer for non-technical users. |
| B | Where does the minimalism boundary sit? | ✅ Closed | Applies to all components, but "minimal" is relative to problem scope. Core is minimal because its problem is simple and well-defined. Every other component must be as minimal as its problem allows — no component grows beyond what its domain requires. Philosophical anchor: **complexity proportional to problem scope.** |
| C | Stack: TypeScript forever? | ✅ Closed | TypeScript as default. Fit-for-purpose language per component is valid where the problem demands it (e.g. Cato semantic risk graph → Python or Rust). The IPC boundary from R3 makes language an implementation detail. Interface is the contract; language is not. |
| D | Provider routing and credential storage: same concern? | ✅ Closed | Separate concerns. Provider config (PROVIDER, MODEL, ENDPOINT) lives in container-runner / group config. Token Broker stays focused on credential mediation only. Security caveat: provider identity must flow into Cato/Call Inspector so they can calibrate posture (local model = no upstream safety filters). |
| E | Should Golem Guard notify on blocks? | ✅ Closed | Yes, always. The safety layer is **educational, not just operational**. Every block is a teaching moment: explain the risk, not just enforce the rule. Example: "You want to include your SSN in plain text? Here's why that's a risk." Silent blocking was an oversight in the original spec. |
| F | Phase 2 start condition | ✅ Closed | Spec must be clean (this session + SPECS v0.5 written) + IP clearance check passes. Long-term vision: specs written as English-driven, language-agnostic documents sufficient for automated SDD/TDD/XP implementation or reimplementation in any language. The spec is the product. |

---

## Direction (revised mid-session)

The current PLAN.md and SPECS.md are **v0.1 artifacts**. The current codebase is the v0.1 starting point, not the target. We do not patch the existing plan or spec — we write new ones grounded in the philosophy established in this session.

**Immediate next steps, in order:**

1. **Define the "to be" architecture** — process model, trust domains, component responsibilities, IPC boundaries, all flowing from the philosophical anchors above. This session's output.
2. **Write new specs** — SPECS.md v1.0 and detailed behavioral specs for each component. English-driven, language-agnostic, complete enough to drive implementation.
3. **Implementation audit** — spin an Explore subagent to walk `src/` and inventory what exists: what maps to the new architecture (keep), what contradicts it (shed), what is missing (build). Produces the gap list.
4. **Staged implementation plan** — from the gap list, create a v1.0 roadmap with parallel workstreams where the architecture allows.

---

## Implementation Audit (Subagent Task — deferred to step 3)

After the new architecture and specs are written, spin an Explore subagent to:

1. Walk `src/` against the new SPECS.md v1.0.
2. For each component: maps to new architecture / contradicts it / no spec equivalent.
3. Produce a gap list: keep / shed / build.

**Input to the staged implementation plan. Do not start planning before this.**

---

## Philosophical Synthesis (derived from session)

The decisions above, read together, produce a coherent thesis that is **different from what SPECS.md v0.4 states**:

**Old framing:** "A personal AI assistant for power users who are not necessarily engineers."

**Revised framing:** OpenGolem makes AI agency genuinely safe for everyone — from a grandparent installing it for the first time to an Accenture team deploying it as a permanent team member. Where every other system in this space implicitly assumes a technically sophisticated operator, OpenGolem's safety infrastructure works by default, without configuration, for the least technically sophisticated user. Enterprise teams and power users configure upward from that safe default; they never configure downward from an unsafe one.

This produces eight philosophical anchors for SPECS.md v0.5:

1. **Safety as universally necessary, not just accessible.** Golem Guard is not a feature for non-technical users — it prevents entire classes of mistakes that world-class engineers make with existing tools (Karpathy's API keys leaked by his own assistant; a Meta security lead's emails wiped; AWS down from assistant/tech-support miscommunication). The failure mode is always architectural: tools that let the agent touch things it should never be able to touch. OpenGolem's safe default is the answer to that architectural failure, for everyone.
2. **Security as education, not just enforcement.** Every block, flag, or challenge is a teaching moment. Alef explains risk in the user's language — warm, contextual, non-condescending. The system builds trust by making risk legible, not by silently managing it. "Silent protection" was an oversight; the correct model is informed protection.
3. **Alef is the communication layer. Cato is the only protection layer. These must not be conflated.**
   "First line of protection" is a misleading framing for Alef and is retired. Alef is the first line of *communication* — the relationship, the education, the warmth, the warnings. Cato is the sole architectural protection, and it is unconditional: even if the user strips every Alef behaviour and maximises autonomy, Cato remains. The floor does not move. The safety guarantee is entirely Cato's responsibility; Alef's responsibility is making the system legible and trustworthy to the user.

   **Scope of the safety claim:** OpenGolem guarantees safety for a correctly deployed Golem using the canonical repository. It does not claim to prevent bad-faith forks, misconfigured deployments, or tainted distributions. No software can prevent those. The repository is the source of truth; beyond that boundary, OpenGolem's guarantees do not reach.

4. **Alef owns all user-facing communication. Cato's protocol is a shared JSON contract, not part of SOUL.md.** Cato's external interface is `{allow: bool, code?: CatoRiskCode, reason?: string}` — a small enumeration of structured codes (PATH_TRAVERSAL, PROMPT_INJECTION, PII_PLAIN_TEXT, …) plus a free-text `reason` field for anything that doesn't fit a code. This schema is a shared contract between Cato and Alef, defined in its own spec (not SOUL.md). SOUL.md is strictly about communication style — how Alef speaks, its character, and the two structural marker conventions:
   - `**[FLAG]**` — Alef asserting its own disagreement with a user instruction (Alef's voice)
   - `**[BLOCKED]**` — Alef communicating a Cato enforcement decision (infrastructure's voice, translated by Alef)
   Both markers are **user-configurable** — default values are English (`[FLAG]`, `[BLOCKED]`), but can be overridden per group or per user (e.g. `[BLOQUEADO]` in Portuguese, `[ENGELLENDİ]` in Turkish). The defaults serve English-speaking power users; non-English users need tags legible in their own language or the visual signal is lost. Power users who find the tags noisy can reduce or remove them. Internally, the canonical English forms are always used in the audit log regardless of display configuration — machine-readable logging is decoupled from user-facing display. Alef's explanation following the marker is always in the user's language. Cato never addresses users directly. We will never capture all risk modes; the protocol is open for extension as new patterns emerge in practice.
5. **Complexity proportional to problem scope.** Minimalism is not "make everything tiny" — it is "solve the problem correctly and no more." The core is minimal because its problem is well-defined. Every component answers to this same discipline: as minimal as its domain allows, no more.
6. **Language as implementation detail.** Clean IPC boundaries (P7) mean each component can use the best language for its domain. TypeScript is the default; fit-for-purpose alternatives are valid where the problem demands it (e.g. Cato's semantic risk graph). The spec — not the language — is the source of truth.
7. **The spec is the product.** The long-term aspiration is English-driven specifications complete enough to drive automated implementation or reimplementation in any language. SOUL.md, PSYCHE.md, and `.intent.md` are early instances of this pattern. Every document in this project is working toward that standard.

8. **The system is language-aware throughout.** Alef detects and responds in the user's language. A single user may interact in multiple languages across different sessions or even within one session — this is expected and supported. User-visible marker **text** is configurable per group (anchor 4 above); **audit logs and telemetry** use the canonical English tokens `[FLAG]` and `[BLOCKED]` regardless of display strings. All explanatory text follows in the user's language. Critically: **Cato's checks are language-agnostic by design.** Symbolic checks (path traversal, oversized prompt, injection signatures) must fire regardless of the script or language family of the payload. When the LLM escalation path is introduced (Phase 2), Cato's analysis must handle non-Latin scripts, ideographic languages, and language-switching as a potential evasion vector — e.g. a user deliberately querying in Japanese to test whether oversight holds across language families.

---

## Open Notes (unresolved, deferred)

**dao_score calibration — human in the loop** — Cato measures and enforces; it does not auto-recalibrate. The hansei reflection produces a structured report surfaced to the administrator for review. Threshold changes are deliberate human decisions, not automatic adjustments. KPIs are diagnostic signals, not optimization targets. Ground truth for calibration must come from outside the loop: user feedback, false positive reports, actual incidents. A Golem that auto-recalibrates against its own metrics will drift toward optimizing proxies (block rate, compliance rate) rather than actual safety outcomes. The dashboard plugin (see below) is the mechanism that makes this human review possible.

**Dashboard skill (admin/power-user)** — Required consequence of the "calibration is human judgment" principle. Humans can only exercise calibration judgment if they can see the data. A dashboard skill for administrators and power users must surface: KPI trends, usage patterns, block and warning history, hansei reports, false positive signals, and threshold change history. This is not optional — it is the interface through which the governance layer remains honest. **Architecture:** first-party skill, Stage 1 implementation priority after core audit/Cato/broker wiring (`docs/ARCHITECTURE.md` §5.4).

**Mastery path / autonomy progression** — Currently user-defined: the user decides when they want more autonomy. This may be the wrong long-term decision but is necessary now. The system does not gate progression on external criteria. Mitigation: even at higher autonomy levels, Alef and Cato continue to surface common failure modes — raise and explain, even when not blocking. This preserves the educational model without imposing a gating mechanism the user hasn't consented to.

---

## Session Log

| Date | Progress |
|------|----------|
| 2026-04-05 | Tensions identified from ARCHITECTURE_REVIEW.md + SPECS.md; Decision framework A–F framed; all six decisions closed; philosophical synthesis derived; adversarial review completed; key clarifications: Alef is communication layer not protection layer, Cato is sole unconditional protection floor, calibration is human judgment not auto-recalibration, safety claim scoped to correctly deployed Golems from canonical repo; goals and sequencing session opened |
| 2026-04-05 | `docs/ARCHITECTURE.md` review comments RC-1–RC-7 incorporated (security modes, Hansei delivery, Inspector→Cato relay, Alef i18n + display tags, Tier 1 ADR, dashboard skill, two-socket broker RPC). Philosophical synthesis renumbered; anchor 8 aligned with configurable markers vs canonical audit tokens. |
