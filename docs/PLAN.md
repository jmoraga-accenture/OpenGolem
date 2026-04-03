# OpenGolem — Implementation Plan
*Produced: April 2026 | Last updated: 2026-04-03 | Tracks SPECS.md v0.4 | M2 in progress*

---

## Status

| Milestone | Status | Notes |
|---|---|---|
| M1 — Repository Scaffold | ✅ Complete | 304 tests passing; TUI live; Telegram pulled, inactive by default; assistant named Alef |
| M2 — Token Broker | 🔧 In progress | |
| M3 — Call Inspector | 🔲 Not started | |
| M4 — Channel Adapters (Teams) | 🔲 Not started | TUI completed in M1; Teams remains |
| M5 — Cato + SOUL.md | 🔲 Not started | |
| M6 — Safety Agent + Security Agent + dao_score | 🔲 Not started | |
| M7 — TUI Health Dashboard | 🔲 Not started | |
| M8 — Skill Schema | 🔲 Not started | |
| M9 — Integration + Hardening | 🔲 Not started | |
| **Phase 2 — OpenGolem-v2 (clean lab)** | 🔲 Not started | Incremental TypeScript rewrite from specs; begins after M9 |

---

## Overview

OpenGolem is built in two phases:

1. **Phase 1 — OpenGolem-TS:** Fork NanoClaw (TypeScript/Node.js) to prove the architecture and iron out the design. The security perimeter is the container boundary, not the language runtime — TypeScript with strict mode is auditable enough for the host orchestrator. Channel adapters (Grammy, Baileys) and the Claude Agent SDK are JS/TS; staying in TypeScript avoids FFI complexity with no security benefit.

2. **Phase 2 — OpenGolem-v2 (clean lab):** Specs-first TypeScript rewrite from first principles. Replace Phase 1 modules one at a time at their interface boundary. No NanoClaw lineage; module boundaries and abstractions designed for OpenGolem, not inherited. Stays TypeScript — the clean-room is about architecture, not language.

**Default channel is TUI.** The console/readline prompt is the primary interface. External channels (Telegram, Teams, WhatsApp) are optional skills applied on top. `OPENGOLEM_CHANNELS=tui` is the out-of-box default; no credentials required to start.

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
| OneCLI-only credential proxy | **Replace** | Token Broker + Call Inspector own mediation; **OneCLI remains optional** as a credential *backend* (Agent Vault), same security model as NanoClaw when configured locally |
| Discord channel | **Remove** | Out of scope |
| Slack channel | **Remove** | Out of scope |
| Gmail channel | **Remove** | Out of scope |
| Call Inspector | **New** | No NanoClaw equivalent |
| Token Broker | **New** | Issues opaque tokens; resolves real secrets via user-chosen backend: `.env`, Bitwarden CLI, or OneCLI |
| Security Modes | **New** | No NanoClaw equivalent |
| TUI channel | **New** | No NanoClaw equivalent |
| Microsoft Teams channel | **New** | No NanoClaw equivalent |
| Cato persona | **New** | Executive assistant with SOUL.md |
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
│  │  │  Cato   │  │ Safety/Sec.  │  │                  │
│  │  │         │  │ Agents       │  │                  │
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

### Milestone 1: Repository Scaffold and NanoClaw Fork Baseline ✅ Complete

**Completed:** April 2026 — 304 tests passing, clean build.

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
   - `src/agents/cato/` — Cato
   - `src/agents/safety/` — Safety Agent
   - `src/agents/security/` — Security Agent
   - `src/tui/` — TUI channel adapter
   - `src/dao/` — dao_score pipeline
6. Create `SOUL.md` and `PSYCHE.md` as empty placeholder files.

**Gate:** `npm run build` passes; Telegram and WhatsApp adapters initialize; no Discord/Slack/Gmail references in `src/`.

**What was actually done (deviations from plan):**
- Security audit of NanoClaw source performed before copy; all Tier 1 and most Tier 2 findings fixed during M1 rather than deferred to M9. See `docs/SECURITY_AUDIT.md`.
- OneCLI replaced immediately (was planned for M2) with a native credential proxy (`src/credential-proxy.ts`) to unblock local testing. The Token Broker in M2 will replace this proxy.
- Sentinel markers rebranded from `NANOCLAW_OUTPUT_*` to `OPENGOLEM_OUTPUT_*` in both host and container.
- All `nanoclaw` references in service names, config paths, container names, and log files rebranded to `opengolem`.
- `src/broker/`, `src/inspector/`, `src/audit/`, `src/agents/`, `src/dao/` stub directories not yet created — deferred to respective milestones rather than adding empty files.
- `SOUL.md` and `PSYCHE.md` placeholder files not yet created — deferred to M5/M6.
- **TUI channel built and active** (`src/channels/tui.ts`) — originally planned for M4. Console prompt is the default and primary interface; `OPENGOLEM_CHANNELS=tui` out of the box, zero credentials required. The TUI portion of M4 is complete.
- **Telegram channel pulled in** (`src/channels/telegram.ts`, ported from nanoclaw-telegram) but **disabled by default**. Activating it requires `OPENGOLEM_CHANNELS=tui,telegram` and `TELEGRAM_BOT_TOKEN` in `.env`. Telegram is never the default channel.
- **Assistant renamed to Alef** (default `ASSISTANT_NAME`). Inspired by the Hebrew letter and Borges' *El Aleph*.
- **304 tests passing** (not 246 as originally targeted).
- **`predev` npm hook** (`scripts/stop-service.ts`) stops the background service and kills server processes before `npm run dev` to avoid port conflicts.

**Credential path in M1:**
`src/credential-proxy.ts` is the only active credential mechanism. It reads `CLAUDE_CODE_OAUTH_TOKEN` (preferred), then `ANTHROPIC_AUTH_TOKEN`, then `ANTHROPIC_API_KEY` from `.env` and injects the auth header into every outbound call before passing it upstream. It starts automatically on `npm start`. **`.env` is the only supported credential backend in M1.** OneCLI Agent Vault backend support lands in M2 as one of the three pluggable `CredentialBackend` implementations.

---

### Milestone 2: Token Broker (Node.js) 🔧 In progress

**Goal:** Internal Node.js process on a Unix socket. Issues scoped opaque tokens. Resolves API credentials through a **pluggable backend** (see below). Call Inspector + broker still mediate every outbound path; agents never hold raw secrets.

**Credential backends (exactly one active via config):**

| Backend | Use case | Security notes |
|---|---|---|
| **`.env` / file** | Local dev, minimal setup | Secrets on disk; acceptable only in trusted single-user environments. Document as non-default for production. |
| **Bitwarden** | Recommended default for self-host | User-owned vault; broker invokes `bw` (or equivalent) to fetch items; no vendor-hosted secret store required beyond Bitwarden’s normal sync. |
| **OneCLI** (Agent Vault) | Parity with NanoClaw / existing installs | [onecli/onecli](https://github.com/onecli/onecli) gateway injects credentials at the proxy; containers never see raw keys. **Supported only when** the gateway is bound to loopback (or an equivalently vetted network posture), TLS where applicable, and a short security checklist in `docs/` is satisfied — same bar as NanoClaw’s model. *Unrelated tools marketed as “OpenCLI” are out of scope unless explicitly evaluated and adopted later.* |

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
- `src/broker/credentials/` — `CredentialBackend` interface; `env.ts`, `bitwarden.ts`, `onecli.ts` implementations; factory from `OPENGOLEM_CREDENTIAL_BACKEND` (names TBD; align with `src/config.ts`)

**Gate:** Issue/verify/revoke unit tests pass. Budget exhaustion and container-binding rejection tested. Zero `ANTHROPIC_API_KEY` references outside `src/broker/credentials/`. Each backend has at least one integration or contract test (OneCLI may use mocked gateway).

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

### Milestone 4: Channel Adapters — Microsoft Teams

**Goal:** Add Microsoft Teams as a channel adapter. TUI (readline/console) was completed in M1 and is the default channel. Telegram is already pulled in and available as an opt-in skill.

**Teams:** HTTP webhook receiver for inbound messages; Bot Framework REST API for outbound via broker/inspector. Registered as a Claude Code skill (`/add-teams`).

**Channel hierarchy (by default):**
1. **TUI** — always on; zero config; `npm run dev` gives a working prompt immediately
2. **Telegram** — opt-in skill; set `OPENGOLEM_CHANNELS=tui,telegram` + `TELEGRAM_BOT_TOKEN`
3. **Teams** — opt-in skill (this milestone); Azure Bot registration required
4. **WhatsApp** — opt-in skill (existing, via Baileys); phone pairing required

**Gate:** Teams webhook POST delivers to message queue within 500ms. `/add-teams` skill registers the adapter. TUI remains the default when no `OPENGOLEM_CHANNELS` override is set.

---

### Milestone 5: Cato Agent Persona and SOUL.md

**Goal:** Implement the Executive Assistant with maximum-assertiveness-default behavior. Write SOUL.md and wire it as a system prompt prefix.

**Assertiveness dial:** `assertiveness_level` integer, 0–10, default 10, stored per-context in SQLite.
- Decreasing the level requires user confirmation in `Supervised` mode; rejected entirely in `Golem Guard`.
- The safety agent enforces the threshold — the orchestrator cannot reduce it without passing the safety check.

**`[FLAG]` protocol:** SOUL.md instructs Cato to prefix any response that challenges a user instruction with `[FLAG]`. The orchestrator detects this marker post-response and routes it to each channel adapter's `flaggedResponse` formatter. A flag event is written to the audit log.

**SOUL.md structure (~70 lines):**
- Identity: who Cato is.
- Core commitments (non-negotiable): flag self-damaging decisions, surface conflicts, never falsify audit log, defer to Safety Agent on blocks.
- Assertiveness calibration: how `assertiveness_level` maps to behavior.
- Escalation path: what Cato does when assessing an instruction as harmful.
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
- Escalation path (surface to user via Cato `[FLAG]` mode; block security mode downgrade requests).

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
1. TUI message → Cato responds → two audit log entries.
2. Prompt injection attempt → Call Inspector hard block → audit log `hard_block` row.
3. Safety Agent scheduled run → valid safety report.
4. dao_score pipeline → non-zero KPI values from integration test audit log.

**Security hardening:**
- Audit every `process.env` access outside `src/broker/credentials.ts`.
- Verify audit log DELETE trigger.
- Verify Safety Agent socket is bound to `127.0.0.1` or a filesystem socket with restrictive permissions.

**Deliverables:** `docs/ARCHITECTURE.md`, `docs/DEVELOPMENT.md`, tag `opengolem-ts-1.0`.

---

## Phase 2: OpenGolem-v2 (Clean Lab)

### Rationale

After M9, OpenGolem-TS will be working but will carry inherited structure from NanoClaw: the message loop pattern, the container runner design, and some channel abstractions were designed for WhatsApp-first, not TUI-first. Phase 2 is a specs-first TypeScript rewrite that sheds this lineage and designs from OpenGolem's actual requirements.

**Why TypeScript, not Rust:** The security perimeter is the container boundary, not the language runtime. Whether the orchestrator is TypeScript or Rust, agents run inside Docker with identical isolation. Channel adapters (Grammy, Baileys) and the Claude Agent SDK are JS/TS; Rust would require subprocess calls to reach them — more complexity, same security profile. TypeScript with strict mode is auditable enough for a 3–5k line orchestrator.

**Approach — incremental, not flag-day:** Phase 1 stays in production throughout. Phase 2 modules replace Phase 1 modules one at a time at their interface boundary (Unix socket or function call). Each module is shadow-validated before switching. No big-bang rewrite.

### Design Principles for v2

- **TUI-first.** The console prompt is the primary interaction model. External channels are optional skills layered on top. All architectural decisions favour the local-use case before the remote-messaging case.
- **No inherited assumptions.** The message loop, channel abstraction, and IPC protocol are redesigned from SPECS.md, not evolved from NanoClaw.
- **Smallest possible surface.** Each module does one thing. No shared mutable state outside SQLite. No singletons.
- **Specs before code.** Each v2 module begins with a one-page design doc (interface, data flow, error model) before any implementation.

### Module Replacement Sequence

**v2-M1 — Orchestrator core:** Redesigned message loop. TUI-native (not retrofitted). Channel registry unchanged at the interface boundary.

**v2-M2 — Channel abstraction:** Clean channel interface designed for TUI + Teams + Telegram as equal peers, not WhatsApp-primary with others added.

**v2-M3 — Token Broker v2:** Incorporate lessons from M2 implementation. Cleaner socket protocol; pluggable backend interface simplified based on actual usage patterns.

**v2-M4 — Container runner:** Redesigned for the sentinel protocol; remove NanoClaw-era assumptions about volume mounts and group structure.

**v2-M5 — TUI Health Dashboard v2:** Replace readline-based panel with a proper split-pane TUI (Ink or blessed). Richer health data surface.

**v2-M6 — Archive Phase 1:** After 30-day parallel operation, Phase 1 becomes read-only. `main` branch is the v2 codebase.

---

## Deferred Decision: Phase 3 — Rust?

**Revisit after v2-M6 is stable in production.** Do not decide earlier.

At that point, OpenGolem-v2 will be a clean TypeScript codebase with no NanoClaw lineage, well-defined module boundaries, and a proven architecture. That is the right moment to evaluate whether a Rust rewrite adds enough value to justify the cost.

### Questions to answer at the decision point

| Question | Why it matters |
|---|---|
| What is the actual attack surface of the host process? | If the orchestrator is essentially a message router with no privileged operations, Rust's memory safety gains are marginal. If it handles untrusted input at the socket boundary, Rust is more compelling. |
| Are channel adapters still JS/TS only? | If Grammy, Baileys, or a Teams SDK with no Rust equivalent is still in use, Rust orchestrator → JS subprocess → channel adapter adds a process boundary for no security gain. |
| Has the Claude Agent SDK gained a Rust binding? | The SDK is currently JS/TS only. A native Rust binding would remove the main FFI argument against Rust. |
| Is auditability a bottleneck? | If a clean v2 TypeScript codebase is already auditable in one sitting (target: <5k lines of core), the Rust argument weakens further. |
| Are there performance requirements TypeScript can't meet? | Container orchestration is I/O-bound. Node.js handles this well. Rust wins on CPU-bound work; identify whether any hot path is actually CPU-bound before committing. |

### Criteria for choosing Rust

Rust is the right call if, at the decision point, **three or more** of the following are true:

- The Claude Agent SDK has a stable Rust binding
- The host orchestrator handles cryptographic operations at scale (Token Broker under high load)
- A production security audit identifies memory-safety risks in the TypeScript runtime
- Channel adapters are available as Rust crates or can be replaced by HTTP webhooks (no in-process JS required)
- The team has production Rust experience and can maintain it without velocity cost

### Default outcome

If the criteria are not met: **stay on TypeScript v2.** A clean, auditable, well-tested TypeScript codebase is a better outcome than a Rust rewrite done for its own sake. The security perimeter is the container boundary. The language of the orchestrator is a secondary concern.
