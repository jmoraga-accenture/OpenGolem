# Architect Review — Priority 1 Behavioral Specs

*Produced: 2026-04-05 | Architect: Claude Code*
*Input documents: ARCHITECTURE.md v1.0, DECISIONS.md (through Decision 14), token-broker-spec.md, cato-spec.md, skill-schema-spec.md, memory-tiers-spec.md*

This document records the consistency verdict for each Priority 1 behavioral spec and the resolution for every TBD item flagged in those specs. Verdicts are one of:

- **Consistent** — the spec faithfully reflects ARCHITECTURE.md with no material departures.
- **Consistent with notes** — minor clarifications or recommendations; no blocking issues for the Tester.
- **Inconsistent** — one or more findings must be corrected by the Spec Writer before the Tester begins.

TBD resolutions reference the Decision record added to DECISIONS.md in this same session.

---

## Spec A: Token Broker + Call Inspector

**Verdict: Consistent with notes**

### Consistency findings

**A-1 (note, non-blocking): `parentTokenId` field not in ARCHITECTURE.md §4.2.1 schema**
The ARCHITECTURE.md §4.2.1 `issueToken` schema does not include a `parentTokenId` field. The Token Broker spec (§4.2.1, `issueToken` params) adds this field to support the delegation ceiling rule (ADR-5). The omission in ARCHITECTURE.md is an intentional underspecification at the architecture level — ADR-5 mandates the ceiling rule and the spec is the correct place to define the wire field. No conflict; the spec extends the architectural schema in a direction that ADR-5 requires. The Spec Writer may note this in the spec header.

**A-2 (note, non-blocking): `openrouter` excluded from v1.0 `provider_type` values**
ARCHITECTURE.md §4.6 names "Anthropic API, OpenRouter, Ollama, custom" as the provider set. The Token Broker spec (§4.6) lists `anthropic`, `ollama`, and `custom` as valid v1.0 `provider_type` values and explicitly excludes `openrouter`. AC-12 tests for rejection of `openrouter`. This is an intentional scope decision by the Spec Writer, not grounded in a specific architectural decision. The Spec Writer should confirm with the PM whether this deferral is accepted. If it is, a note in the spec header citing the rationale (OpenRouter requires additional credential model work) is recommended. No blocking issue; the architecture permits this scoping.

**A-3 (note, non-blocking): `securityMode` ordering defined in spec but not in ARCHITECTURE.md**
The spec (Behavioral Contract, Token Issuance) defines a security mode ordering for delegation: `golem_guard < supervised < power` (where a subagent may not receive a more permissive mode than its parent). ARCHITECTURE.md §3.0 describes the three modes but does not enumerate their relative permissiveness for delegation purposes. The spec's ordering is correct and fills a gap. No conflict.

**A-4 (note, non-blocking): `health` response `degraded` state described in spec, not in ARCHITECTURE.md**
ARCHITECTURE.md §4.2.1 shows the health response as `{"status":"ok"}` only. The spec adds a `degraded` variant with `reason`. This is a correct and necessary extension — ARCHITECTURE.md §1.3 describes the credential backend dependency but not the wire representation of a degraded state. No conflict.

### TBD resolutions (this spec)

**TBD-A1 resolved** — see Decision 15 (socket paths).
**TBD-A2 resolved** — see Decision 16 (token store exhaustion).

---

## Spec B: Cato

**Verdict: Inconsistent — one finding must be corrected before the Tester starts**

### Known inconsistency confirmed and expanded

**B-1 (blocking — PM flagged, confirmed): INV-3 vs §3.6 contradiction on audit-before-response**

INV-3 (p.303 of cato-spec.md) states: "The `cato_check` audit entry for an inline decision is committed to the audit log before the response is returned to the orchestrator."

§3.6 "Fail-Closed on All Error Paths" states: "If Cato's audit log write fails during an inline check, Cato still responds with the computed allow/block decision and separately attempts to retry the audit log write."

These are directly contradictory. INV-3 says the audit write precedes the response with no exception. §3.6 says the response is returned even if the audit write fails.

**Correct behavior per ADR-9:** The audit log is the source of truth for all governance. A call that cannot be recorded cannot proceed. ARCHITECTURE.md §3.7 (audit log) and the Token Broker spec invariant 8 both confirm: "A call that cannot be audited is not forwarded / a call that cannot be recorded cannot proceed." The pattern for audit-write failure is suspension (not silent proceed). INV-3 is correct; §3.6 must be corrected.

**Required correction (Spec Writer — Cato §3.6):** Remove the sentence "Cato still responds with the computed allow/block decision and separately attempts to retry the audit log write." Replace with: "If Cato's audit log write fails during an inline check, Cato suspends the response until the write succeeds or a retry limit is reached. After exhausting retries, Cato returns `allow: false` (fail-closed), logs the audit failure to a separate failure log, and does not forward the response as an allow. A call that cannot be audited is not allowed to proceed."

The Failure Modes table entry for "Audit log unavailable at inline check time" must be updated to match: it currently reads "Inline check proceeds; log write is retried; decision is not withheld from the orchestrator pending the retry" — this must change to reflect that the decision IS withheld pending the write, and on write failure the decision becomes `allow: false`.

AC-8 is already correctly specified: "the audit log INSERT timestamp precedes the socket response timestamp." AC-8 does not need correction — only §3.6 and the Failure Modes table.

### Additional consistency findings

**B-2 (note, non-blocking): §3.1 path traversal check defers to TBD-B1**
The spec correctly identifies the tension between hash-only delivery and byte-level pattern checking, and flags it as TBD. See TBD-B1 resolution below (Decision 17). The Spec Writer must update §3.1 and §2.1 (the request schema) per Decision 17 once this review is issued.

**B-3 (note, non-blocking): §3.4 audit event ordering**
The spec (§3.4, step 6) lists audit events written at the end of a scheduled audit run as: `cato_audit_start`, `cato_audit_complete`, `hansei_report_ready`. `cato_audit_start` must logically be written at the beginning of the run (step 1), not step 6. The spec's step numbering implies all three are written together at the end, which is inconsistent with using `cato_audit_start` to bound audit periods. Recommended correction: `cato_audit_start` is written at the beginning of the run (before the audit log read); `cato_audit_complete` and `hansei_report_ready` are written after the report is created.

**B-4 (note, non-blocking): AC-2 inline response timeout left as TBD**
AC-2 includes "(TBD — architect to resolve; must be short enough not to meaningfully degrade task latency under normal load)". See Decision 22 (Cato inline response timeout) — resolved to 500 ms, configurable.

**B-5 (note, non-blocking): §2.3 CatoRiskCode enumeration is consistent with ARCHITECTURE.md §4.3.1**
All nine codes match exactly. No discrepancy.

**B-6 (note, non-blocking): Cato inline check audit fields consistent with ARCHITECTURE.md §4.3**
ARCHITECTURE.md §4.3 specifies audit fields as: `checkId`, `action`, `contextId`, `tokenId`, `payloadHash`, `outcome`, `code`. The spec (§2.4) adds `payloadSize` and `allow` (as separate columns, with `allow` being the boolean form of `outcome`). This is a compatible extension — no conflict.

### TBD resolutions (this spec)

**TBD-B1 resolved** — see Decision 17 (hash-only vs byte-level check).
**TBD-B2 resolved** — see Decision 18 (scheduled audit interval default).

---

## Spec C: Skill Schema and Lifecycle

**Verdict: Consistent with notes**

### Consistency findings

**C-1 (note, non-blocking): Broker notification wire format left as TBD**
Skill-schema-spec.md §2 "Broker Notification" section correctly flags: "TBD — architect to resolve: ARCHITECTURE.md §5.5 states 'Token Broker notified of new skill scope' but does not specify the exact JSON-RPC method or message schema." See TBD-C1 resolution below (Decision 19). The Spec Writer must add the wire format once this review is issued.

**C-2 (note, non-blocking): Skill registry persistence left as TBD**
The spec notes: "TBD — architect to resolve: the spec does not prescribe the persistence format for the skill registry." This is a genuine gap but it is scoped to an internal orchestrator implementation detail (how the orchestrator reconstructs its installed skill set after restart). It does not affect the external interface or the broker/inspector behavior. Resolution: the orchestrator persists the installed skill registry as a JSON file at a well-known host path (e.g. `data/skill-registry.json`). This is a Developer decision, not an Architect decision — the spec may note "persisted as a host JSON file; exact path is Developer-determined" and close the TBD. No architectural ADR required.

**C-3 (note, non-blocking): Inspector endpoint update described as in-process**
The spec (§2 "Inspector Endpoint Update") correctly notes the Call Inspector runs within TD-BROKER and updates in-process. ARCHITECTURE.md §3.3 confirms this. No conflict.

**C-4 (note, non-blocking): `type: operational` is correctly out of scope**
The spec's Invariant 6 correctly excludes operational skills. ARCHITECTURE.md §5.1 table lists operational skills as "instruction-only." Consistent.

**C-5 (note, non-blocking): Validation rule 2 (`token_scopes.skills` recognizable IDs) — definition of "recognizable"**
ARCHITECTURE.md §5.3 validation rule 2 says "All `token_scopes.skills` entries are recognizable skill IDs." The spec does not define what "recognizable" means precisely — is it "in the installed skill set" or "syntactically valid kebab-case"? The spec's AC-3b tests for "unrecognized skill ID" but does not define the recognition predicate. The Developer needs clarity. Recommended: "recognizable" means the ID passes syntactic validation (kebab-case, non-empty) — not that it must already be installed, since a skill may declare scope for skills not yet installed. The Spec Writer should clarify in the field constraints table.

**C-6 (consistent): Skill lifecycle diagram matches ARCHITECTURE.md §5.5**
The spec's Behavioral Contract mirrors the ARCHITECTURE.md §5.5 flowchart exactly. Consistent.

### TBD resolutions (this spec)

**TBD-C1 resolved** — see Decision 19 (broker notification wire format).

---

## Spec D: Memory Tiers

**Verdict: Consistent with notes**

### Consistency findings

**D-1 (consistent): Three-tier structure matches ARCHITECTURE.md §6**
Tier storage locations, access control matrix, and ownership rules all match §6.1–6.4 exactly. No discrepancy.

**D-2 (consistent): ADR-10 MEMORY_WRITE gate is correctly reflected**
T1-2, T1-3, INV-2 all correctly require Cato inline approval for every Tier 1 host write. The `MEMORY_WRITE` action type is included in the Cato spec's action enumeration. Consistent.

**D-3 (consistent): Tier 3 write mediation via Call Inspector matches §6.4**
ARCHITECTURE.md §6.4 specifies "Mediated" for orchestrator Tier 3 writes, meaning "every proposed write passes through the Call Inspector before the orchestrator commits it." The spec (T3-1, T3-2, INV-5) enforces `source_check_id` on every `memory_entries` row and logs rejected writes. Consistent.

**D-4 (note, non-blocking): Tier 2 WAL mode stated as assumption in spec, not normative**
T2-7 reads: "Cato may open a read-only connection to any group's `messages.db` during scheduled audits... (WAL mode is assumed; TBD — architect to resolve: confirm WAL mode is mandatory for Tier 2 databases)." See TBD-D3 resolution (Decision 21). WAL mode is now normative.

**D-5 (note, non-blocking): Audit log is append-only; INV-7 for `memory_audit` is correct but scoped only to Tier 3**
INV-7 states "`memory_audit` rows are never deleted or updated." The unified audit log (§3.7 ARCHITECTURE.md) has the same append-only invariant, enforced at the write interface level. The spec correctly separates Tier 3's `memory_audit` (local to the memory tier schema) from the unified audit log. No conflict; the naming distinction is appropriate.

**D-6 (note, non-blocking): `router_state` TBD**
See TBD-D1 resolution (Decision 20).

**D-7 (note, non-blocking): Session/task retention TBD**
See TBD-D2 resolution (Decision 20).

**D-8 (note, non-blocking): Missing `messages.db` TBD**
See TBD-D4 resolution (Decision 21).

**D-9 (note, non-blocking): Missing `CLAUDE.md` at spawn TBD**
See TBD-D5 resolution (Decision 22).

**D-10 (note, non-blocking): Tier 3 sqlite-vec index configuration left as TBD in spec**
The spec notes: "TBD — architect to resolve: exact `sqlite-vec` index configuration (HNSW vs brute-force for Phase 1 scale, dimensionality of embedding vectors, distance metric)." This is appropriately deferred — Phase 1 does not implement Tier 3 writes (no agent-proposed Tier 3 writes until the capability is built). This TBD does not block Phase 1 implementation and is not resolved in this session. It should be resolved when Tier 3 write capability is implemented.

### TBD resolutions (this spec)

**TBD-D1 resolved** — see Decision 20 (`router_state` placement).
**TBD-D2 resolved** — see Decision 20 (session/task retention).
**TBD-D3 resolved** — see Decision 21 (WAL mode mandatory).
**TBD-D4 resolved** — see Decision 21 (missing `messages.db`).
**TBD-D5 resolved** — see Decision 22 (missing `CLAUDE.md`).

---

## Cross-spec consistency — shared interfaces

### Audit log schema used by Token Broker, Cato, and Memory Tiers

The three specs that write to the unified audit log define their write events independently. Cross-checking:

- **Common fields** (all writers): `checkId`/event-id, timestamp, `contextId`, `tokenId` (where applicable). No conflict.
- **`payloadHash` / `payloadSize`**: Cato spec (§2.4) and Token Broker spec (Audit Log Writes table) both log `payloadHash` (SHA-256 hex) and `payloadSize`. Field names and types are consistent.
- **`allow` / `code` fields**: Cato spec uses `allow` (boolean) and `code` (nullable CatoRiskCode string). Token Broker spec uses `code` (CatoRiskCode) for block events. No field name conflict.
- **INSERT-only**: All three specs declare INSERT-only writes. Consistent with ARCHITECTURE.md §3.7 and ADR-9.
- **`memory_audit` vs unified audit log**: The Memory Tiers spec's `memory_audit` table is a Tier 3 local table, not the unified audit log. The naming is potentially confusing. Recommendation: the Spec Writer add a clarifying sentence to the Tier 3 interface section: "`memory_audit` is a Tier 3-local table within `data/memory.db`. It is distinct from the unified audit log at `data/audit.db`."

### CatoRiskCode enumeration

ARCHITECTURE.md §4.3.1, Cato spec §2.3, and Token Broker spec (§4.6 HTTP error body, Behavioral Contract five checks) all use the same nine codes. Field names and enum values are identical across all three. Consistent.

### Cato inline check request schema

ARCHITECTURE.md §4.3 and Cato spec §2.1 both specify the six-field request schema (`checkId`, `action`, `contextId`, `tokenId`, `payloadHash`, `payloadSize`). Consistent.

Token Broker spec §4.2.2 `catoEscalate` adds `escalationReason` and `inspectorCheck` fields. These are additional fields on the escalation variant of the check, routed through the orchestrator. The orchestrator strips the extra fields and presents the standard six-field schema to Cato's socket. This relay behavior is correct per ADR-11 and §4.2 — the orchestrator intermediates. No conflict; the extra fields are orchestrator-internal metadata, not delivered to Cato.

### `securityMode` enum values

All four specs use the same three values: `golem_guard`, `supervised`, `power`. Consistent with ARCHITECTURE.md §3.0.

---

## Summary table

| Spec | Verdict | Blocking issues | Notes |
|------|---------|-----------------|-------|
| Token Broker + Call Inspector | Consistent with notes | None | A-1 through A-4: minor gaps and intentional scope decisions; all non-blocking |
| Cato | **Inconsistent** | **B-1 (§3.6 / Failure Modes table contradicts INV-3 and ADR-9)** | B-2 through B-6: non-blocking notes; B-3 audit event ordering correction recommended |
| Skill Schema and Lifecycle | Consistent with notes | None | C-1 (broker notification TBD — resolved Decision 19); C-5 ("recognizable" needs clarification) |
| Memory Tiers | Consistent with notes | None | Multiple TBDs resolved; D-10 deferred to Phase 1 Tier 3 implementation |

**Required Spec Writer actions before Tester begins:**

1. **Cato spec — blocking:** Correct §3.6 and the Failure Modes table per finding B-1. The audit log write must precede (or be transactionally coupled to) the inline response; audit write failure results in `allow: false`, not silent proceed.
2. **Cato spec — recommended:** Correct §3.4 step ordering per B-3 (`cato_audit_start` written at audit start, not end).
3. **Cato spec:** Update §3.1 and the request schema per TBD-B1 resolution (Decision 17 — orchestrator includes content excerpt for pattern-check action types).
4. **Skill Schema spec:** Add the broker notification wire format per TBD-C1 resolution (Decision 19 — `registerSkillScope` method on the token lifecycle socket).
5. **Memory Tiers spec:** Mark WAL mode normative per Decision 21; update FM-3 auto-create behavior per Decision 21; update FM-5 auto-create behavior per Decision 22.
6. **Memory Tiers spec:** Add clarifying sentence distinguishing `memory_audit` from the unified audit log (cross-spec note above).

---

## TBD Resolution Index

| TBD ID | Spec | Decision | Summary |
|--------|------|----------|---------|
| TBD-A1 | Token Broker | Decision 15 | Socket paths for all three sockets |
| TBD-A2 | Token Broker | Decision 16 | Token store exhaustion: reject new requests |
| TBD-B1 | Cato | Decision 17 | Orchestrator sends content excerpt for pattern-check actions |
| TBD-B2 | Cato | Decision 18 | Scheduled audit default interval: 6 hours, `CATO_AUDIT_INTERVAL` env var |
| TBD-C1 | Skill Schema | Decision 19 | Broker notification: `registerSkillScope` method on token lifecycle socket |
| TBD-D1 | Memory Tiers | Decision 20 | `router_state`: in-process only, no Tier 2 persistence |
| TBD-D2 | Memory Tiers | Decision 20 | Retention window applies to `messages` table only |
| TBD-D3 | Memory Tiers | Decision 21 | WAL mode is mandatory for all Tier 2 `messages.db` files |
| TBD-D4 | Memory Tiers | Decision 21 | Missing `messages.db`: auto-create |
| TBD-D5 | Memory Tiers | Decision 22 | Missing `CLAUDE.md` at spawn: auto-create empty file |
