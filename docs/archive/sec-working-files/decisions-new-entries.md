<!-- archived: content merged into canonical docs -->
# New entries for DECISIONS.md
*Append after Decision 22. Produced: 2026-04-05.*

---

## Decision 23: Role Execution Model — Frontier Models for All Roles with HitL Authority (April 2026)

**Question:** TEAM.md v1 stated that certain roles (PM, Voice of Customer, final merge authority) "cannot be delegated" because no AI can stand in for real users. Is this still accurate in April 2026?

**Decision:** The framing is revised. In April 2026, frontier models are capable of executing any specialist role to a production standard. Every role — PM, Voice of Customer, Architect, Cybersecurity Specialist, UX Designer, and all others — can be executed by a frontier model in a session scoped to that role's remit.

Jim's authority remains non-delegable. His *execution* is not. The distinction is: Jim holds three authorities that cannot be transferred — roadmap and scope decisions, risk acceptance sign-offs, and final merge approval. He does not need to personally execute every task those authorities oversee. Every role produces an artifact; every artifact requires Jim's review and approval before it is acted upon. The frontier model executes; Jim governs.

**Implications:**
- TEAM.md is updated to v2, replacing the "cannot be delegated" framing with the authority/execution distinction.
- New specialist roles are added to TEAM.md v2: Cybersecurity Specialist, DevOps/Systems Administrator, UX/Interaction Designer, and Supply-Chain Auditor — each executable by a frontier model in a scoped session.
- PM_BRIEF.md is updated to v2, incorporating session trigger prompts for all new specialist roles and sequencing the security and UX streams alongside the original development streams.

---

## Decision 24: Security Strengthening Document as Canonical Project Document (April 2026)

**Question:** The Security Strengthening Document produced in the 2026-04-05 architectural review session identifies ten findings against the current architecture and specifications. Should it be treated as a standing project document in the canonical doc set, or as a review artefact?

**Decision:** The Security Strengthening Document (`docs/SECURITY_STRENGTHENING.md`) is a canonical project document. It is added to the active document set in PM_BRIEF.md v2 and is the primary input to security streams G, H, and L.

**Findings summary:**

| # | Finding | Severity |
|---|---------|---------|
| F-1 | Inbound transport security unspecified | High |
| F-2 | Credential proxy HTTP binding unspecified | High |
| F-3 | Audit log has no cryptographic integrity protection | High |
| F-4 | In-process adapter supply-chain risk — no mitigating controls | High |
| F-5 | Token store crash leaves orphaned containers | Medium |
| F-6 | No inbound message rate limiting | Medium |
| F-7 | Self-hosted model safety posture underdocumented | Medium |
| F-8 | No credential rotation procedure | Medium |
| F-9 | MCP permission tier enforcement deferred — no interim controls | Medium |
| F-10 | External dependency surface is an unaddressed systemic risk | High |

Findings are closed when the corresponding ADR is produced and the relevant spec is updated. Findings must not be closed by implementation alone.

**Implications:**
- Streams G (Cybersecurity Specialist), H (DevOps), and L (Supply-Chain Audit) are commissioned to close or escalate findings before v1.0 ships.
- F-9 requires a PM risk-acceptance decision (Decision 25 below) before any MCP-declaring skill ships.
- F-10 has a Phase 1 component (npm audit policy, container image pinning) and a Phase 2 component (Rust crate dependency minimisation as acceptance criterion).

---

## Decision 25: F-9 Risk Acceptance — MCP Permission Tier Enforcement Deferred to Phase 2 (April 2026)

**Question:** The `.intent.md` schema includes a `min_permission_tier` field for MCP server declarations, but enforcement is deferred to Phase 2. During Phase 1, a lower-tier team member can trigger MCP calls to enterprise systems for which they would not otherwise have authorisation. Is this risk accepted for Phase 1?

**Decision:** Accepted for Phase 1, with the following documented interim control: MCP-declaring skills are restricted to administrator-only groups until Phase 2 permission tier enforcement is implemented. This must be stated as explicit deployment guidance in the documentation, not left implicit.

**Conditions:** The risk acceptance is contingent on the interim control being documented before any MCP-declaring skill ships. A skill that declares MCP servers may not be published without this guidance in place. The risk is automatically closed when Phase 2 permission tier enforcement is implemented and verified by the Security Reviewer.

**Implications:**
- Deployment documentation must include a "Phase 1 MCP limitation" notice before any MCP skill is published.
- The dashboard skill (Stream C sub-item) does not declare MCP servers and is not affected.
- Phase 2 scope must include permission tier enforcement as a named deliverable, not an open item.
