# OpenGolem — Implementation Plan
*Produced: April 2026*

---

## Overview

OpenGolem is built in two phases:

1. **Phase 1 — OpenGolem-TS:** Fork NanoClaw (TypeScript/Node.js) to prove the architecture and iron out the design before committing to a full rewrite.
2. **Phase 2 — OpenGolem-RS:** Rewrite in Rust, crate-by-crate, while Phase 1 stays in production. TypeScript components are replaced one at a time at their interface boundary (Unix socket protocol).

The NanoClaw fork lives in `.background/repos/nanoclaw`. It is excluded from version control via `.gitignore`.

---

## What Changes vs. What Stays from NanoClaw

| Component | Status | Notes |
|---|---|---|
| Single orchestrator process | Keep | Same process model |
| Agent containers per group | Keep | Same container model |
| Filesystem IPC (sentinel protocol) | Keep | Unchanged in both phases |
| Per-context CLAUDE.md | Keep | Extended with assertiveness level |
| SQLite for messages/sessions/state | Keep | Schema extended, not replaced |
| Anthropic Claude Agent SDK in containers | Keep | Agents unchanged inside containers |
| Skills via Claude Code slash commands | Keep | Schema extended with `.intent.md` |
| OneCLI credential proxy | **Replace** | Token Broker replaces this entirely |
| Discord channel | **Remove** | Out of scope |
| Slack channel | **Remove** | Out of scope |
| Gmail channel | **Remove** | Out of scope |
| Call Inspector | **New** | No NanoClaw equivalent |
| Token Broker | **New** | Replaces OneCLI |
| Security Modes | **New** | No NanoClaw equivalent |
| TUI channel | **New** | No NanoClaw equivalent |
| Microsoft Teams channel | **New** | No NanoClaw equivalent |
| Jiminy Cricket persona | **New** | Executive assistant with SOUL.md |
| Safety Agent | **New** | Inline hook + scheduled |
| Security Agent | **New** | Scheduled log auditor |
| dao_score pipeline | **New** | Computed from audit log |
| SOUL.md / PSYCHE.md | **New** | Governance layer |
| Immutable audit log | **New** | Append-only SQLite |
| `.intent.md` skill schema | **New** | Formalized skill declarations |
| TUI health dashboard | **New** | System health panel |

---

## Phase 1: OpenGolem-TS

### Process Model

```
┌─────────────────────────────────────────────────────────┐
│  Host                                                   │
│                                                         │
│  ┌──────────────┐   IPC (Unix socket)  ┌─────────────┐ │
│  │ Orchestrator │◄───────────────────► │ Token Broker│ │
│  │  (Node.js)   │                      │  (Node.js)  │ │
│  └──────┬───────┘                      └─────────────┘ │
│         │                                               │
│         │  Filesystem IPC (sentinel)                   │
│         ▼                                               │
│  ┌──────────────────────────────────┐                  │
│  │        Agent Containers          │                  │
│  │  ┌──────────┐  ┌──────────────┐  │                  │
│  │  │ Jiminy   │  │ Safety/Sec.  │  │                  │
│  │  │ Cricket  │  │ Agents       │  │                  │
│  │  └──────────┘  └──────────────┘  │                  │
│  └──────────────────────────────────┘                  │
│                                                         │
│  ┌──────────────────────────────────┐                  │
│  │  Audit Log (append-only SQLite)  │                  │
│  └──────────────────────────────────┘                  │
└─────────────────────────────────────────────────────────┘
```

The Call Inspector is middleware inside the orchestrator's outbound call path — not a separate process.

---

### Milestone 1: Repository Scaffold and NanoClaw Fork Baseline

**Goal:** Establish the OpenGolem-TS codebase from the NanoClaw fork. Remove out-of-scope channels. Add empty module stubs for new components.

**Tasks:**
1. Fork NanoClaw into `opengolem` repository; tag exact upstream commit as `nanoclaw-baseline`.
2. Remove Discord, Slack, Gmail channel adapters and all corresponding skill files.
3. Remove OneCLI credential injection code.
4. Audit and trim `package.json` dependencies for removed channels.
5. Add placeholder directory structure:
   - `src/broker/` — Token Broker
   - `src/inspector/` — Call Inspector
   - `src/audit/` — Audit log
   - `src/agents/jiminy/` — Jiminy Cricket
   - `src/agents/safety/` — Safety Agent
   - `src/agents/security/` — Security Agent
   - `src/tui/` — TUI channel adapter
   - `src/dao/` — dao_score pipeline
6. Create `SOUL.md` and `PSYCHE.md` as empty placeholder files.

**Gate:** `npm run build` passes; Telegram and WhatsApp adapters initialize; no Discord/Slack/Gmail references in `src/`.

---

### Milestone 2: Token Broker (Node.js)

**Goal:** Internal Node.js process on a Unix socket. Holds raw credentials (Bitwarden CLI). Issues scoped opaque tokens. Replaces OneCLI entirely.

**Token structure (JWT payload, internal to broker):**
```json
{
  "jti": "<uuid>",
  "container_id": "<id>",
  "skills": ["telegram.send", "anthropic.message"],
  "scopes": ["context:home"],
  "iat": 1234567890,
  "exp": 1234567890,
  "budget": 50
}
```

Tokens are HMAC-SHA256 signed. The signing key is generated fresh at each broker startup and never persisted. Agents receive the opaque token only — they never see the payload or the credential.

**Broker socket operations:**
- `ISSUE` — takes `{ container_id, skills[], scopes[], ttl_seconds, budget }`, returns `{ token }`.
- `VERIFY` — takes `{ token }`, returns `{ valid, claims }`. Used by the Call Inspector.
- `REVOKE` — takes `{ token }` or `{ container_id }`. Adds jti to revocation set.

**Key files:**
- `src/broker/server.ts` — Unix socket listener
- `src/broker/token.ts` — HMAC-SHA256 JWT encode/sign/verify
- `src/broker/credentials.ts` — Bitwarden CLI integration; `.env` fallback for local dev

**Gate:** Issue/verify/revoke unit tests pass. Budget exhaustion and container-binding rejection tested. Zero `ANTHROPIC_API_KEY` references outside `src/broker/credentials.ts`.

---

### Milestone 3: Call Inspector

**Goal:** Middleware on every outbound API call. Five synchronous lint checks. Append-only audit log. Hard/soft block behavior per security mode.

**Five checks (run in order):**
1. `checkSkillWhitelist` — skill must be in token's declared whitelist.
2. `checkMemoryScope` — payload must not reference memory partitions outside token's `scopes`.
3. `checkPromptInjection` — payload scanned against a maintained signature list (`src/inspector/signatures.ts`). Initial high-confidence set: `ignore previous instructions`, `disregard your guidelines`, `system prompt override`, `you are now`, `repeat the above`.
4. `checkCallRate` — call rate compared against declared task profile (simple threshold in Phase 1).
5. `checkEndpointScope` — target API endpoint must be within the token's skill set.

**Security mode behavior:**
| Mode | Behavior on check failure |
|---|---|
| Golem Guard (default) | Hard block, no user prompt, logged |
| Supervised | Soft block, user confirmation required |
| Power | Hard block only on `checkPromptInjection`; all others advisory |

**Audit log schema (`audit.db`):**
```sql
CREATE TABLE calls (
  id           INTEGER PRIMARY KEY,
  ts           INTEGER NOT NULL,
  jti          TEXT NOT NULL,
  container    TEXT NOT NULL,
  skill        TEXT NOT NULL,
  outcome      TEXT NOT NULL,        -- 'pass' | 'hard_block' | 'soft_block'
  block_rule   TEXT,
  payload_hash TEXT NOT NULL,        -- SHA256 of payload, never raw payload
  security_mode TEXT NOT NULL
);
-- DELETE is blocked by trigger; table is append-only
```

**Gate:** All five checks have passing unit tests. Blocked calls are written to `audit.db`. DELETE trigger fires. Supervisor mode emits user confirmation event.

---

### Milestone 4: Channel Adapters — TUI and Microsoft Teams

**Goal:** Add TUI (readline-based terminal) and Microsoft Teams (webhook-based) channel adapters. Scope: TUI, Teams, Telegram, WhatsApp — four channels total.

**TUI:** readline-based (`src/channels/tui/index.ts`). Chat pane reads from stdin, writes to stdout. Feeds the same message queue as production channels. Doubles as the health dashboard surface (M7). Handles Ctrl-C gracefully.

**Teams:** HTTP webhook receiver for inbound messages; Bot Framework REST API for outbound via broker/inspector. Registered as a Claude Code skill (`/add-teams`).

**Gate:** `npm start --channel tui` routes a typed message through the orchestrator. Teams webhook POST delivers to message queue within 500ms. All four channel adapters are registered.

---

### Milestone 5: Jiminy Cricket Agent Persona and SOUL.md

**Goal:** Implement the Executive Assistant with maximum-assertiveness-default behavior. Write SOUL.md and wire it as a system prompt prefix.

**Assertiveness dial:** `assertiveness_level` integer, 0–10, default 10, stored per-context in SQLite.
- Decreasing the level requires user confirmation in `Supervised` mode; rejected entirely in `Golem Guard`.
- The safety agent enforces the threshold — the orchestrator cannot reduce it without passing the safety check.

**`[FLAG]` protocol:** SOUL.md instructs Jiminy to prefix any response that challenges a user instruction with `[FLAG]`. The orchestrator detects this marker post-response and routes it to each channel adapter's `flaggedResponse` formatter. A flag event is written to the audit log.

**SOUL.md structure (~70 lines):**
- Identity: who Jiminy Cricket is.
- Core commitments (non-negotiable): flag self-damaging decisions, surface conflicts, never falsify audit log, defer to Safety Agent on blocks.
- Assertiveness calibration: how `assertiveness_level` maps to behavior.
- Escalation path: what Jiminy does when assessing an instruction as harmful.
- Hard limits: unconditional refusals.

**Gate:** New context initializes with `assertiveness_level = 10`. Test prompt containing self-damaging instruction produces `[FLAG]` response. Reducing `assertiveness_level` in Golem Guard mode is rejected.

---

### Milestone 6: Safety Agent, Security Agent, and dao_score

**Goal:** Implement both agents and the dao_score pipeline. Write PSYCHE.md.

**Safety Agent — two modes:**
- *Inline hook:* Lightweight Unix socket server (`src/agents/safety/inline.ts`). Orchestrator calls it synchronously before executing any action. Returns `{ allow: bool, reason? }`. A `false` blocks the action regardless of security mode. Starts as a long-lived child process.
- *Scheduled:* Full container run (default: every 6 hours). Reads audit log, per-context memory files, credential access log. Produces `reports/safety-<timestamp>.json`.

**Security Agent:** Scheduled container run (default: every 24 hours). Reads audit log only. Audits for anomalous call rates, token scope violations, prompt injection artifacts, Supervised-mode override patterns. Produces `reports/security-<timestamp>.json`.

Neither agent is in the orchestrator's addressable agent map — no other agent can send them a message.

**dao_score — initial KPIs:**
```
security_failures_per_call  = hard_blocks + soft_blocks / total calls (period)
data_leaks_per_call         = checkMemoryScope blocks / total calls (period)
behavioral_change_rate      = distinct block_rules that produced a subsequent change
                              in agent behavior (same rule not re-fired within 10 calls)
```
Computed by `src/dao/score.ts` from `audit.db`. Written to `dao_score.db`.

**PSYCHE.md structure:**
- dao_score KPI definitions with explicit formulas.
- Hansei ritual schedule (weekly: Security Agent report review + dao_score delta).
- Drift detection thresholds (e.g., `security_failures_per_call > 0.05` triggers Golem Guard lock).
- Escalation path (surface to user via Jiminy `[FLAG]` mode; block security mode downgrade requests).

**Gate:** Safety Agent inline socket blocks cross-context memory access independently of the Call Inspector. Safety Agent is not in the addressable agent map. All three KPIs compute from a fixture audit log. PSYCHE.md KPI names match those produced by `dao_score.ts`.

---

### Milestone 7: TUI Health Dashboard

**Goal:** Split-pane terminal UI. Upper pane: chat. Lower pane: health panel (toggle `Ctrl-D`).

**Health panel data sources (polled every 500ms):**
- Active container count + pending messages (orchestrator `getHealth()`)
- Active token count + tokens expiring in <60s (broker `getActiveTokenCount()`)
- Last 10 rows from `audit.db`
- Latest dao_score KPI values from `dao_score.db`

Implemented with Node.js `readline` + ANSI escape codes (no TUI library in Phase 1 — keeps dependency surface minimal and auditable). Replaced with `ratatui` in Phase 2.

**Gate:** `Ctrl-D` renders health panel with all four data sources. Panel updates every 500ms without disrupting chat scroll. Terminal resize redraws without artifacts.

---

### Milestone 8: Skill System and `.intent.md` Schema

**Goal:** Formalize skill declarations. Orchestrator validates intent before applying any skill.

**`.intent.md` frontmatter schema:**
```yaml
skill: add-teams
version: 1.0.0
description: "Microsoft Teams channel adapter"
token_scopes:
  - channel:teams:send
  - channel:teams:receive
filesystem_paths:
  - /var/golem/channels/teams/
network_endpoints:
  - "https://smba.trafficmanager.net/*"
dependencies: []
breaking_changes: []
```

The body of the file is human-readable documentation. The orchestrator parses only the frontmatter.

An agent cannot request a broker token for a skill the context has not applied. This check is enforced in `src/broker/token.ts` against the context's skill registry (stored in SQLite).

**Gate:** Skill validator unit tests pass (valid/missing-field/unknown-field). Applying a skill without valid `.intent.md` is rejected. Requesting a broker token for an unapplied skill is rejected. All three channel skills have passing intent files.

---

### Milestone 9: Integration, Hardening, and Documentation

**Goal:** End-to-end tests, security audit, developer docs, Phase 1 release tag.

**Integration test scenarios:**
1. TUI message → Jiminy responds → two audit log entries.
2. Prompt injection attempt → Call Inspector hard block → audit log `hard_block` row.
3. Safety Agent scheduled run → valid safety report.
4. dao_score pipeline → non-zero KPI values from integration test audit log.

**Security hardening:**
- Audit every `process.env` access outside `src/broker/credentials.ts`.
- Verify audit log DELETE trigger.
- Verify Safety Agent socket is bound to `127.0.0.1` or a filesystem socket with restrictive permissions.

**Deliverables:** `docs/ARCHITECTURE.md`, `docs/DEVELOPMENT.md`, tag `opengolem-ts-1.0`.

---

## Phase 2: OpenGolem-RS

### Migration Strategy

The TypeScript system stays in production throughout. Rust crates replace TypeScript components at the Unix socket boundary — the wire protocol is preserved so components can be swapped one at a time. Each crate is shadow-validated (both TS and RS running in parallel, outputs compared) before switching.

### Crate Structure

```
opengolem-rs/
├── Cargo.toml                  (workspace)
└── crates/
    ├── golem-broker/           (Token Broker — port first)
    ├── golem-inspector/        (Call Inspector + audit)
    ├── golem-audit/            (Audit log writer)
    ├── golem-orchestrator/     (Orchestrator — port last)
    ├── golem-dao/              (dao_score pipeline)
    └── golem-tui/              (TUI dashboard, ratatui)
```

**Key dependencies:**
- `tokio` — async runtime, Unix socket server
- `ring` — HMAC-SHA256 token signing (no OpenSSL)
- `rusqlite` — SQLite (bundled feature)
- `serde` + `serde_json` — wire format
- `regex` — injection signatures compiled to `RegexSet` at startup
- `bollard` — Docker API for container management
- `ratatui` — TUI dashboard
- `DashMap` — concurrent token store

### Migration Sequence

**RS-M1 — `golem-broker`:** Port first. Shadow-validate for 1 week (TypeScript broker responses authoritative; Rust responses compared). Switch when zero divergences.

**RS-M2 — `golem-inspector` + `golem-audit`:** Wire Rust inspector into the TypeScript orchestrator via the same socket protocol. Injection signatures compiled to a `RegexSet` (zero per-call allocation). `AuditWriter` struct exposes only `append` — no `delete`, no `update`.

**RS-M3 — `golem-orchestrator`:** Largest port. Channel adapters one at a time: TUI → Teams → Telegram → WhatsApp. Container management via `bollard`. Sentinel IPC protocol unchanged.

**RS-M4 — `golem-tui`:** Replace readline with `ratatui`.

**RS-M5 — `golem-dao`:** dao_score as pure functions over SQLite. Build script validates PSYCHE.md KPI name references at compile time.

**RS-M6 — Archive TypeScript:** After 30-day shadow validation period, `opengolem-ts` becomes read-only. `main` branch switches to the Rust workspace.

### Rust Constraints

- `#![forbid(unsafe_code)]` in `golem-broker`, `golem-inspector`, `golem-audit`.
- `AuditWriter` owns the sole writable `audit.db` connection. Rust ownership model enforces this — no runtime check needed.
- Token `budget` field can only decrease. `TokenStore` exposes `consume_budget` using `fetch_sub` with checked underflow. No `set_budget` method exists.
- Injection signatures are a `const` array of `&'static str` in source. Adding a signature requires a code change and rebuild — not a config file edit. This is intentional: source-level signatures are auditable; config-driven signatures can be manipulated.
