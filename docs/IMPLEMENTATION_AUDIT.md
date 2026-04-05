# OpenGolem — Implementation Audit (v0.1 `src/` vs `docs/ARCHITECTURE.md`)

*Produced: 2026-04-05 | Step: PM Brief 1.1 | Method: read-only comparison of `src/` to canonical `docs/ARCHITECTURE.md`*

This document classifies existing code and gaps for each architectural component. Verdicts: **keep** (maps to the target architecture and can evolve), **shed** (contradicts the target or must be replaced, not merely extended), **build** (required by the architecture with no adequate v0.1 equivalent).

When a single area mixes all three, the table uses the primary verdict and explains the rest in the justification.

---

## Executive summary

v0.1 is a **single Node.js process** that hosts orchestrator logic, an embedded Token Broker socket server, the credential HTTP proxy with Call Inspector, and Cato’s inline socket server. `docs/ARCHITECTURE.md` requires **three long-lived host processes** (Orchestrator, Token Broker, Cato) with specific **JSON-RPC Unix socket** contracts, a **second broker→orchestrator socket** for `catoEscalate`, and a **unified append-only audit log** written by orchestrator, broker, and Cato. The codebase has strong **starting points** (broker tokens, inspector checks, Cato fail-closed stub, channels, container runner, append-only call audit in SQLite) but **does not yet implement** process boundaries, wire protocols, delegation ceiling, inspector escalation relay, Tier 2/Tier 3 memory layout, skill `.intent.md` governance, or several ADR-shaped behaviors.

**Net:** Most of `src/` is **keep** as material to refactor toward the architecture; a few **deployment and protocol shapes** are **shed**; Tier 3 semantic memory, full skill declaration pipeline, dashboard skill, and parts of the audit/orchestration contract are **build**.

---

## Architecture components (ARCHITECTURE.md ↔ `src/`)

| Architecture component | Primary verdict | `src/` anchor(s) | Notes |
|------------------------|-----------------|------------------|-------|
| **1.1 Orchestrator** (long-lived) | **keep** (process model **shed**) | `index.ts`, `group-queue.ts`, `router.ts`, `task-scheduler.ts`, `ipc.ts`, `sender-allowlist.ts`, `seed-groups.ts` | Message loop, queues, routing, scheduling, IPC, container dispatch, and Cato gating before dispatch align with the *role* of the orchestrator. **Contradictions:** runs in the same OS process as broker and proxy; no dedicated Unix listener for broker-initiated `catoEscalate` (§4.2.2, ADR-11); orchestrator events are not consistently persisted to a **single** governance audit log as specified (§3.7, §4.8); per-group **security mode** is only partially reflected (env-wide `OPENGOLEM_SECURITY_MODE` in bootstrap vs group config authority §3.0); **MEMORY_WRITE** Cato gate before Tier 1 commits (ADR-10) is not implemented. |
| **1.1 Token Broker** (long-lived) | **keep** (IPC + placement **shed**) | `broker/server.ts`, `broker/client.ts`, `broker/token.ts`, `broker/credentials/*` | Issues, verifies, and revokes signed opaque tokens; pluggable credential backends match the *idea* of TD-BROKER. **Contradictions:** not a separate process; protocol is ad hoc `{ op: ISSUE | VERIFY | REVOKE }` over a line-oriented socket, not JSON-RPC `issueToken` / `revokeToken` / `health` (§4.2.1); **no `securityMode` claim** in token claims (`token.ts`); **no parent-token / delegation ceiling** (ADR-5); broker does not own the HTTP proxy — see credential proxy row. |
| **1.1 Cato** (long-lived) | **keep** (protocol + reporting **shed**/partial) | `cato/inline.ts`, `cato/scheduled-audit.ts`, `cato/dao-score.ts` | Unix socket inline hook, deterministic checks, fail-closed client, scheduled job, dao_score KPIs, and report files under `reports/` match parts of §3.4. **Contradictions:** request schema uses `type: 'check_action'` and **full prompt text**, not `{ checkId, action, contextId, tokenId, payloadHash, payloadSize }` (§4.3); responses lack **CatoRiskCode** enumeration; Cato **does not append** check outcomes to the unified audit log; **LLM escalation** for *inline* inconclusive checks is absent (Phase 2 per ADR-2); scheduled audit drives an **agent container** with PSYCHE rather than the §4.7 **hansei inbox** drop + orchestrator poll contract (related outcome, different mechanism). |
| **1.2 Agent containers** | **keep** | `container-runner.ts`, `container-runtime.ts`, `mount-security.ts` | Spawn/teardown, sentinel protocol, mounts, resource limits pattern, `ANTHROPIC_BASE_URL` toward proxy, broker token issuance hook — align with §4.4–4.5 at a high level. **Gaps:** env vars for **ALEF display tags** (§3.5, §4.4) may be partial vs spec; provider-type-agnostic proxy URL patterns need explicit alignment with ADR-7 in later specs. |
| **3.2–3.3 Token Broker + Call Inspector** | **keep** (placement + behaviors **shed**/partial) | `credential-proxy.ts`, `inspector/*` | Proxy validates/forwards upstream; inspector runs ordered checks and writes **append-only** `data/audit.db` — strong match to inspector *behavior* and ADR-9’s “enforcement writes truth.” **Contradictions:** Call Inspector runs **inside the orchestrator process** (import from proxy), not solely inside TD-BROKER as a logical component of the broker process (§3.3); **no `catoEscalate` path** when checks are inconclusive (§3.3, ADR-11); derivative **token not reliably present** on HTTP calls (`jti` often `unknown` per inspector comments); **Supervised** soft-block is not orchestrator-mediated user confirm (Phase 1 forwards after log). |
| **3.6 Channel adapters** | **keep** | `channels/*` | In-process adapters match ADR-6. **Build:** `.intent.md` validation, skill lifecycle, and token scope updates (§5.2–5.5). |
| **3.7 Audit log (unified)** | **build** (partial **keep**) | `inspector/audit.ts` | v0.1 has a dedicated append-only SQLite for **call/flag** events with delete triggers — good primitive. **Contradictions:** not the single governance log described in §3.7; **Cato and orchestrator** do not write task/check/orchestration events into the same store with the specified event model; schema differs from architecture’s “structured rows for all significant events.” |
| **5 Skill system (`.intent.md`, lifecycle)** | **build** | *(no `src/` implementation)* | Skills live in repo as branches/docs (`.claude/skills/`); architecture requires orchestrator-side validation, registration, broker notification, and inspector endpoint updates — **not implemented in TypeScript baseline.** |
| **5.4 Dashboard skill** | **build** | *(not in `src/`)* | Mandated first-party surface in architecture; absent from host code. |
| **6 Memory architecture** | **keep** / **build** | `db.ts`, `group-folder.ts`, `groups/*/CLAUDE.md` (data) | **Tier 1:** `groups/{name}/CLAUDE.md` exists — **keep**; **ADR-10** orchestrator-side Cato approval for mutations — **build**. **Tier 2:** architecture wants `groups/{name}/messages.db`; v0.1 uses **`store/messages.db`** (central) for chats/messages/sessions/router state — **shed** storage layout, **keep** logic as migration source. **Tier 3:** `data/memory.db` + sqlite-vec — **build** (no v0.1 equivalent). |
| **MCP / provider shim (§4.5–4.6, ADR-7)** | **partial keep** | `credential-proxy.ts`, `broker/credentials/*` | Upstream URL and credential injection exist. **Build:** explicit `provider_type` per credential entry, inspector endpoint rules per configured provider, and broker-owned forwarding semantics per spec. |
| **Health (§3.1)** | **keep** | `health.ts` | Localhost HTTP snapshot — matches intent. **Extend** toward any v1.0 fields the spec adds (e.g. hansei ingest status). |
| **Remote control (claude.ai bridge)** | **keep** *(TD-ADMIN, Decision 13)* | `remote-control.ts` | Useful operational feature; **not described** in ARCHITECTURE.md. **PM decision (Decision 13):** keep for v1.0 as a TD-ADMIN surface. No full behavioral spec; the Orchestrator spec will include a scoped paragraph. Spec Writers treat it as in-scope for the Orchestrator component only. |

---

## `src/` module inventory (verdict per area)

| Area | Verdict | Justification |
|------|---------|---------------|
| `index.ts` | **keep** | Orchestrator core; requires splitting processes, escalation listener, audit integration, security mode from group config, MEMORY_WRITE path. |
| `bootstrap.ts` | **keep** | Safe env whitelisting; align config keys with group-scoped security mode and future broker-only secrets. |
| `config.ts`, `env.ts` | **keep** | Central constants; extend for architecture paths (hansei inbox, sockets, provider config). |
| `logger.ts`, `types.ts` | **keep** | Infrastructure; no architectural conflict. |
| `broker/*` | **keep** | Core of TD-BROKER; replace wire protocol, add claims fields, delegation ceiling, co-locate proxy+inspector in broker **process** per target. |
| `credential-proxy.ts` | **keep** | Behavior valuable; **shed** from orchestrator binary when broker becomes separate process. |
| `inspector/*` | **keep** | Implements five-check narrative; add token propagation, escalation RPC, mode/Supervised UX per spec. |
| `cato/*` | **keep** | Preserve socket boundary; replace payloads with hash-based protocol, risk codes, audit writes, LLM path, hansei delivery per §4.7. |
| `container-runner.ts`, `container-runtime.ts`, `mount-security.ts` | **keep** | Align spawn env and audits with ARCHITECTURE §4.4 and mount rules. |
| `db.ts` | **keep** | **Shed** central message DB layout in favor of per-group Tier 2; retain APIs where possible behind migration. |
| `channels/*` | **keep** | Add `.intent.md` and scope declarations when skill pipeline exists. |
| `router.ts` | **keep** | Pure formatting/routing — compatible. |
| `group-queue.ts` | **keep** | Matches orchestrator queue ownership. |
| `group-folder.ts` | **keep** | Group isolation primitive — compatible. |
| `ipc.ts` | **keep** | Host filesystem IPC for tasks/messages; not in architecture prose but consistent with TD-ADMIN / local automation; confirm in channel/spec doc. |
| `task-scheduler.ts` | **keep** | Orchestrator responsibility. |
| `health.ts` | **keep** | Local admin inspection. |
| `sender-allowlist.ts` | **keep** | Telegram policy; stays in TD-ORCHESTRATOR. |
| `seed-groups.ts` | **keep** | Bootstrap helper. |
| `remote-control.ts` | **keep** | See table above (non-architected feature). |
| `timezone.ts` | **keep** | Utility. |
| `*.test.ts`, `integration.test.ts` | **keep** | Test assets follow refactored components. |

---

## Architecture requirements with no v0.1 equivalent (**build**)

- Second Unix socket: **orchestrator listens**, **broker connects** for `catoEscalate` (§4.2.2, ADR-11).
- **JSON-RPC** token lifecycle on broker primary socket (§4.2.1).
- **Derivative token** carrying **securityMode**, skill whitelist, endpoint scope, and **delegation ceiling** enforcement (§3.0, ADR-5, ADR-7).
- **Unified audit log** schema and writers from orchestrator, broker/inspector, and Cato (§3.7, §4.8, ADR-9).
- **Tier 3** semantic memory (`data/memory.db` + vec) and mediated write path (§6.3).
- **Skill** `.intent.md` parsing, validation, install lifecycle, broker/inspector updates (§5.2–5.5).
- **Dashboard** skill (§5.4).
- **Hansei** delivery via agreed inbox + poll (§4.7) if reports remain a v1.0 requirement (today: `reports/cato-*.json` + optional container).
- **Alef** display tag env injection (`ALEF_FLAG_DISPLAY_TAG`, `ALEF_BLOCKED_DISPLAY_TAG`) and SOUL/PSYCHE governance files as host-level contracts (§3.5 — largely container/group content, verify in container spec).

---

## Contradictions to resolve explicitly (**shed** or redesign)

1. **Monolithic process:** One Node binary hosts orchestrator + broker + proxy + Cato socket servers — conflicts §1.1–1.3 and TD separation.
2. **Broker protocol:** Custom `op` messages vs specified JSON-RPC methods and params.
3. **Cato wire format:** Raw prompt vs hash-only, structured `action` enum, `checkId`, and risk codes.
4. **Tier 2 location:** Central `store/messages.db` vs per-group `groups/{name}/messages.db`.
5. **Inspector home:** Implemented as part of orchestrator’s proxy module, not broker-only process boundary.
6. **Cato scheduled audit shape:** LLM-in-container report vs filesystem hansei + poll — **PM decision (Decision 14):** follow ARCHITECTURE.md §4.7. The v0.1 container-report approach is reference material only. The Cato spec target is hansei inbox drop + orchestrator poll.

---

## Completion criteria (Step 1.1)

- [x] Every major `src/` area has a verdict and short justification.
- [x] Each ARCHITECTURE.md long-lived component and named subsystem (skills, memory tiers, unified audit) has an entry, including **build** where v0.1 lacks an equivalent.

**Next (Step 1.2):** Use this audit to order `docs/specs/<component>-spec.md` work per `docs/PM_BRIEF.md` and `docs/TEAM.md`; prioritize specs whose rows above are **build** or **shed**-heavy (Broker+Inspector, Cato, Orchestrator, audit log, memory).

---

*End of audit — no code was modified.*
