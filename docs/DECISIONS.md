# OpenGolem — Architecture Decisions
*Produced: April 2026*

This document records the key architecture questions raised during the initial design session and the decisions made. These close the open questions listed in SPECS.md §13 and resolve the interface gaps identified before implementation could begin.

---

## Decision 1: Token Format and Governance Model

**Question:** What is the Token Broker's token wire format? Where do permissions and governance live?

**Decision:** Tokens are opaque to agents. The token is a signed blob (HMAC-SHA256 JWT in Phase 1; same in Rust). Governance — the permission model, scope enforcement, budget tracking — lives entirely inside the Token Broker. Agents never parse or inspect the token; they present it on each call and the broker enforces scope server-side.

**Analogy:** Google Play or Apple App Store permissions. The app presents a token; the platform enforces what the app is allowed to do. The app has no visibility into the permission logic.

**Implications:**
- The token wire format can change without affecting agents.
- The broker is the only component that needs to be audited for permission correctness.
- Phase 1: Node.js broker with HMAC-SHA256 JWTs, in-memory token store. Phase 2: Rust broker, same protocol.

---

## Decision 2: Call Inspector Complexity

**Question:** How complex should the Call Inspector be at launch? What checks does it perform?

**Decision:** Start simple. The Phase 1 inspector is a synchronous linter with five checks:
1. Skill whitelist check (is this skill in the token's declared set?)
2. Memory scope check (does the payload reference out-of-scope memory partitions?)
3. Prompt injection signature scan (regex against a maintained list of high-confidence patterns)
4. Call rate check (simple threshold against declared task profile)
5. Endpoint scope check (is the target API endpoint within the token's skill set?)

The injection signature list starts small and high-confidence. It is maintained as source code (`src/inspector/signatures.ts`), not a config file, so changes require a code review. In Phase 2 it is compiled to a `RegexSet` at startup.

**What is explicitly not in Phase 1:** ML-based anomaly detection, behavioral baselines, semantic payload analysis. These are deferred.

---

## Decision 3: Skill `.intent.md` Schema

**Question:** What is the formal schema for skill intent declarations?

**Decision:** Deferred. Define the schema when building the first real skill, not before. The YAML frontmatter structure (skill name, version, token_scopes, filesystem_paths, network_endpoints) is outlined in the plan as a starting point, but is not frozen until Milestone 8. The acceptance criteria for M8 includes formalizing and retroactively applying the schema to all existing skills.

---

## Decision 4: Channel Scope

**Question:** What channels does OpenGolem support at launch?

**Decision:** Four channels only:
1. **TUI** (terminal UI) — development, debugging, and the health dashboard surface
2. **Microsoft Teams** — enterprise/professional use case
3. **Telegram** — carried forward from NanoClaw
4. **WhatsApp** — carried forward from NanoClaw

Excluded: Discord, Slack, Gmail, and any other NanoClaw channels. Rationale: three integrations done correctly beats ten done poorly (SPECS.md §11). Teams was added because it serves a different user profile than Telegram/WhatsApp.

The TUI channel is also the health dashboard surface — it renders a split-pane terminal UI with a live health panel (`Ctrl-D` toggle).

---

## Decision 5: dao_score KPIs

**Question:** What are the initial dao_score KPIs?

**Decision:** Three KPIs for Phase 1, all computable from the audit log without agent self-reporting:

| KPI | Formula | Measures |
|---|---|---|
| `security_failures_per_call` | (hard_blocks + soft_blocks) / total calls in period | Security posture — how often the system is blocking suspicious calls |
| `data_leaks_per_call` | `checkMemoryScope` blocks / total calls in period | Safety posture — how often agents attempt out-of-scope data access |
| `behavioral_change_rate` | distinct block_rules that did not re-fire within 10 subsequent calls from the same container / total distinct block_rules fired | Reflection — whether the agent adjusts behavior after being blocked |

These feed PSYCHE.md's drift detection thresholds. A `security_failures_per_call > 0.05` triggers a Golem Guard lock. KPI definitions in PSYCHE.md must match the names produced by `src/dao/score.ts` (enforced by a build-time check in Phase 2).

**Rationale for this set:** All three are observable facts from the audit log, not claims made by the agent. The agent cannot manipulate its own dao_score. `behavioral_change_rate` is the most novel — it approximates whether the system is learning from its blocks, which is the intent of PSYCHE.md's "hansei ritual" concept.

---

## Decision 6: Failure Handling

**Question:** What does OpenGolem do when the Token Broker is unreachable, a container hangs, or other infrastructure fails?

**Decision:** Fail gracefully and report to the user. Specific behaviors:

- **Token Broker unreachable:** Orchestrator blocks any new agent task dispatch. Pending messages are queued (not dropped). User is notified via the active channel with a plain-language error. No task is started without a valid token.
- **Container exceeds TTL:** Container is torn down by the orchestrator. Token is revoked. User receives a timeout notification with the partial result if any output was produced.
- **Call Inspector unreachable:** All outbound calls are blocked (fail-closed, not fail-open). This is consistent with Golem Guard as the default posture.
- **Safety Agent inline hook unreachable:** All actions are blocked until the hook is reachable again. Fail-closed.
- **Audit log write failure:** Task is suspended until the write succeeds. We do not proceed past a failed audit log entry.

**Dashboard:** The TUI health panel surfaces system component health (Token Broker status, Safety Agent socket status, active container count, recent audit events). A more persistent dashboard is deferred until there is a demonstrated need.

---

## Decision 7: Implementation Sequencing

**Question:** Should OpenGolem be built from scratch in Rust, or should it start from a working TypeScript base?

**Decision:** Fork NanoClaw first (TypeScript/Node.js). Use the fork to validate the architecture and iron out design kinks before committing to the Rust rewrite. The NanoClaw fork lives in `.background/repos/nanoclaw` (excluded from version control).

**Rationale:** NanoClaw's container isolation, filesystem IPC, and SQLite patterns are proven. The OpenGolem-specific additions (Token Broker, Call Inspector, agents, governance) are the unknowns. Proving those unknowns in TypeScript first — where iteration is fast — reduces the risk of discovering design flaws after a full Rust rewrite.

The Rust rewrite (Phase 2) proceeds crate-by-crate, replacing TypeScript components at the Unix socket boundary, with shadow validation before each switch.

---

## Decision 8: Credential Backends

**Question:** Must OpenGolem commit to a single secret store (e.g. Bitwarden only), or support multiple provisioning models?

**Decision:** Support **three** selectable credential backends, all behind the Token Broker:

1. **`.env` / file** — development and minimal installs; clearly labeled as weak for multi-tenant or high-threat deployments.
2. **Bitwarden** — **recommended default** for production self-host (user-owned vault, auditable access patterns).
3. **OneCLI** ([Agent Vault](https://github.com/onecli/onecli)) — **optional**, for users who already run OneCLI or want NanoClaw-equivalent proxy injection. Enabled only when the gateway meets documented security constraints (local bind, network isolation, TLS where appropriate). Tools sold under similar names (“OpenCLI”) are **not** the same product; they require a separate ADR before inclusion.

**Rationale:** One backend forces migration pain and excludes valid operator preferences. The broker + inspector remain the consistent enforcement layer; only the *source* of long-lived secrets varies.

**Implications:**
- Configuration surface: one active backend per deployment (`OPENGOLEM_CREDENTIAL_BACKEND` or equivalent — exact name to be fixed in M2).
- Documentation must state default recommendation (Bitwarden) and threat model for each mode.
- M2 implements the interface and at least stub/tests for all three paths.

---

## Decision 9: Config vs Secret env vars — bootstrap pattern (April 2026)

**Problem discovered:** `channel-enabled.ts` read only `process.env.OPENGOLEM_CHANNELS`. The app intentionally does **not** call `dotenv.config()` (see `env.ts` comment: "keeps secrets out of process.env so they don't leak to child processes"). Under systemd, where `.env` is not shell-sourced, `process.env.OPENGOLEM_CHANNELS` was always `undefined`, so Telegram was never started despite being configured.

**Root cause:** The "no dotenv" decision was correct in intent but was scoped too broadly. It correctly blocks secrets from `process.env`; it incorrectly blocked non-secret configuration vars too. Two categories of `.env` content were conflated:

| Category | Examples | Safe in `process.env`? |
|---|---|---|
| **Secrets** | `ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`, `BW_SESSION` | No — must not reach Docker containers |
| **Config** | `OPENGOLEM_CHANNELS`, `LOG_LEVEL`, `TELEGRAM_VALID_USERS` | Yes — not sensitive |

**First (wrong) patch:** Added `readEnvFile` fallback directly to `channel-enabled.ts`. This was a band-aid that perpetuated the fragmented pattern (each file individually deciding how to read config) and would have left other config vars broken.

**Correct fix:** `src/bootstrap.ts` — a dependency-free module imported as the very first line of `index.ts`. It reads `.env` and populates only the whitelisted non-secret config keys into `process.env`. It runs before any other module loads, including `logger.ts` which calls `getEnabledChannelIds()` (→ `process.env.OPENGOLEM_CHANNELS`) at module evaluation time.

**Rule going forward:**
- `bootstrap.ts` is the single place to whitelist non-secret config vars from `.env` into `process.env`.
- Secrets (`*_API_KEY`, `*_TOKEN`, `BW_*`, `ONECLI_*`) must **never** be added to that whitelist.
- New non-secret config vars go in `bootstrap.ts`'s `CONFIG_KEYS` set; callers just read `process.env.VAR_NAME` as normal.
- `channel-enabled.ts` and `logger.ts` remain clean — no imports from `env.ts` or `config.ts`.

---

## Decision 10: Alef vs. Cato — agent layer separation (April 2026)

**Question:** The original spec (v0.3) named the primary user-facing agent "Cato". Implementation named it "Alef". What is Cato?

**Decision:** Two distinct layers with different natures:

- **Alef** is the primary conversational agent. Its character is defined by SOUL.md (prepended system prompt). It is assertive, values-driven, pushes back on self-damaging instructions — but through personality, not enforcement. Alef's protection is the first line: soft, principled, character-based. It uses `[FLAG]` in its own voice when asserting against a user instruction.

- **Cato** is the hard oversight layer. It is infrastructure, not a persona. It can overrule both the user and Alef. It operates above the conversation and is not addressable by any task-level agent or token. Because its job requires non-deterministic interpretation, it may run as an LLM-backed agent container — but this is an implementation detail, not an identity. Cato is always infrastructure. Its operating contract is PSYCHE.md; its observations feed the dao_score feedback loop.

**Why the separation matters:** Alef's assertiveness is designed to be calibrated by the user over time. Cato's authority is not calibratable. Mixing the two — having one agent that is both conversational and able to overrule the user — would create an adversarial dynamic that undermines the assistant relationship. Keeping them separate preserves both: a trustworthy, character-driven assistant (Alef) and an uncircumventable safety layer above it (Cato).

**Implications:**
- SOUL.md belongs to Alef. PSYCHE.md belongs to Cato.
- M5 = SOUL.md + assertiveness dial + `[FLAG]` protocol wired into Alef's container runs.
- M6 = Cato inline hook + scheduled audit + PSYCHE.md + dao_score pipeline.
- `assertiveness_level` is Alef's dial. Cato has no dial — it either allows or blocks.
- See SPECS.md §7 (revised v0.4) for the authoritative definition.

---

## Decision 12: Cato inline hook as deterministic stub (M6, April 2026)

**Question:** The spec calls for Cato's inline hook to run LLM judgment when deterministic checks are inconclusive. Should M6 implement the LLM path?

**Decision:** No. M6 implements the inline hook as a **deterministic stub only**. The Unix socket boundary is preserved — the caller interface (`catoCheck(req)` → `{ allow, reason? }`) is identical to what the LLM path will use. Only the implementation inside the server changes in Phase 2.

**Phase 1 deterministic checks:**
1. **Path traversal in prompt** (`../` or `..\`) — indicates potential filesystem escape attempt via prompt injection
2. **Oversized prompt** (>100 KB) — protects against context stuffing attacks

**Why not LLM escalation now:**
- Cato's LLM judgment requires its own context, separate from Alef's. That context (PSYCHE.md, audit history, pattern memory) needs to stabilise before it can make reliable inline decisions.
- LLM calls are synchronous gates — a poorly calibrated Cato would block legitimate actions and erode trust before any safety benefit is demonstrated.
- The deterministic checks cover the highest-confidence attack vectors. Everything else is better caught by the scheduled audit (retrospective, not real-time).

**Upgrade path:** Replace `runDeterministicChecks()` in `src/cato/inline.ts` with an LLM call when the deterministic pass returns inconclusive. The socket stays; the server implementation changes. Nothing outside `inline.ts` is affected.

---

## Decision 11: Shared read-only agent context directory (`data/extra/`) (April 2026)

**Question:** How should the user provide shared reference material (documents, standing instructions, datasets) that all agents across all groups should be able to read?

**Decision:** Bind-mount `data/extra/` on the host at `/workspace/extra` (read-only) inside every agent container at spawn. The host owns the directory; containers have no write access. No per-group configuration is needed — it applies universally.

**Rationale:** The per-group filesystem (`/workspace/group`) is already isolated by design (contexts cannot read each other's data). A separate shared directory is the clean solution: it is clearly scoped, clearly read-only, and does not require any change to the per-context isolation model. The audit trail is preserved — every container spawn logs its mounts including `/workspace/extra`. Agents attempting to write will receive a permission denied error from the OS, not a silent no-op.

**What was explicitly not done:** Making the directory writable (would allow agents to modify shared state and create cross-context interference), or making it per-group configurable (unnecessary complexity for the current use case). Writability for agents is a future skill-level decision, not a default.

---

## Decision 13: remote-control.ts — Keep as TD-ADMIN surface (April 2026)

**Question:** `remote-control.ts` (claude.ai bridge) is not described in ARCHITECTURE.md. Should it be retired, kept, or formally specified for v1.0?

**Decision:** Keep for v1.0 as a TD-ADMIN operational surface. It is not given a full behavioral spec of its own. The Orchestrator spec (Stream E) will include a scoped paragraph covering its trust domain placement, failure mode (fail-closed if bridge is unreachable), and any audit obligations. It is treated as part of the Orchestrator component, not a standalone component.

**Rationale:** The feature provides genuine operational value (remote agent invocation without a messaging channel) and poses no architectural contradiction — it sits naturally in TD-ADMIN/TD-ORCHESTRATOR. The risk of leaving it without an ADR was that Spec Writers might exclude it from the Orchestrator spec entirely, creating an undocumented surface. This decision closes that gap.

**Implications:**
- Not in the spec queue as a standalone item.
- The Orchestrator Spec Writer reads this decision before writing Stream E.
- If the remote-control surface grows (new endpoints, changed auth model), it graduates to its own spec at that point.

---

## Decision 14: Cato Scheduled Audit Mechanism — Hansei Inbox + Poll (April 2026)

**Question:** v0.1 Cato delivers scheduled audit results by spawning an LLM-in-container that writes `reports/cato-*.json`. ARCHITECTURE.md §4.7 specifies a **hansei inbox drop + orchestrator poll** pattern. Which is the v1.0 target?

**Decision:** Follow ARCHITECTURE.md §4.7. The v1.0 target is hansei inbox drop + orchestrator poll. The v0.1 container-report approach is reference material for the Cato Spec Writer — it is not the spec target.

**Rationale:** The v0.1 mechanism (container spawning its own report) tightly couples the scheduled audit to a container runtime and produces output outside the unified governance flow. The hansei pattern keeps Cato's output inside the orchestrator's control loop — the orchestrator polls a well-defined inbox, routes the result into the audit log, and can act on it programmatically. This preserves the single governance loop and avoids a second out-of-band report surface.

**Implications:**
- The Cato behavioral spec (Stream B) describes the hansei inbox contract (§4.7) as the normative delivery mechanism.
- The v0.1 `reports/cato-*.json` pattern is informational context only, referenced in the "v0.1 starting point" column of the development table.
- Spec Writers do not need to accommodate both mechanisms.

---

## Decision 15: Unix Socket Paths for All Three IPC Sockets (April 2026)

*Resolved from TBD-A1 in token-broker-spec.md. See also ARCHITECT_REVIEW.md TBD-A1.*

**Question:** What are the concrete Unix socket paths for the three IPC sockets used by the Broker, Orchestrator, and Cato? These must not conflict with each other.

**Decision:** All three sockets live under `data/sockets/` on the host filesystem, which is created at startup if absent. The paths are:

| Socket | Owner (listener) | Path |
|--------|------------------|------|
| Token lifecycle | Token Broker | `data/sockets/broker.sock` |
| Cato escalation relay | Orchestrator | `data/sockets/escalation.sock` |
| Cato inline check | Cato | `data/sockets/cato.sock` |

**Rationale:** A single well-known directory avoids scattered socket files and makes permissions straightforward (the directory is owned by the Golem service user; group-readable by each process). Flat names within that directory are unambiguous. Three distinct names eliminate any possibility of a process accidentally connecting to the wrong socket. Paths are relative to the project root at runtime; the orchestrator resolves them to absolute paths at startup.

**Configuration:** The paths above are the compiled-in defaults. Each path is overridable by an environment variable (`BROKER_SOCKET_PATH`, `ESCALATION_SOCKET_PATH`, `CATO_SOCKET_PATH`) for deployments that need alternative locations (e.g. a tmpfs or a different service user home). Overrides are non-secret config vars and belong in `bootstrap.ts`'s `CONFIG_KEYS` whitelist per Decision 9.

**Implications:**
- The Cato spec, Token Broker spec, and Orchestrator spec must reference `data/sockets/` as the default socket directory.
- `data/sockets/` must be added to `.gitignore`.
- The Tester can verify socket separation per token-broker-spec AC-18 by connecting to each path separately.

---

## Decision 16: Token Store Exhaustion Behavior (April 2026)

*Resolved from TBD-A2 in token-broker-spec.md. See also ARCHITECT_REVIEW.md TBD-A2.*

**Question:** What does the Token Broker do when its in-memory token store reaches a maximum capacity? Three options were considered: (a) reject new `issueToken` requests with a JSON-RPC error until existing tokens expire/are revoked, (b) evict the oldest expired token, (c) log a critical alert and begin evicting least-recently-used.

**Decision:** Option (a) — reject new `issueToken` requests with a JSON-RPC error when the store is at capacity. The error message must identify the reason as `token_store_full`. The maximum capacity is configurable via `TOKEN_STORE_MAX_CAPACITY` (default: 10,000 tokens). The broker does not auto-evict any token regardless of age or LRU status.

**Rationale:**
- Auto-eviction of valid tokens (options b and c) silently invalidates tokens that are in active use by running containers. Those containers would then receive HTTP 403 on their next proxied call — an unexpected, hard-to-diagnose failure. This is worse than the task queue blocking at the orchestrator level.
- Rejecting new `issueToken` requests surfaces the problem immediately and in the right place (the orchestrator, which owns the task lifecycle). The orchestrator already handles Token Broker unavailability by queuing inbound messages — the same queue absorbs store-full conditions without data loss.
- A store capacity of 10,000 is far above any realistic single-host deployment. If the limit is reached, it indicates a runaway token issuance pattern (a bug or attack), and the correct response is to surface it loudly, not to paper over it with eviction.
- Expired tokens in the store are removed lazily at validation time (when a request bearing an expired token is checked). This keeps the store size bounded in normal operation without requiring a background sweeper.

**Implications:**
- The Token Broker spec must add a behavioral contract: "Given a `issueToken` request when the token store is at capacity, Must: reject with `{code: -32603, message: 'token_store_full'}`. No token is issued. Health status remains `ok` (store-full is not a credential backend failure)."
- An alert-level audit log entry is written on the first store-full rejection in each 60-second window (to avoid flooding the log).
- The Tester must verify store-full behavior (AC addition to the Token Broker spec).

---

## Decision 17: Cato Hash-Only vs Byte-Level Check — Content Excerpt Model (April 2026)

*Resolved from TBD-B1 in cato-spec.md. See also ARCHITECT_REVIEW.md TBD-B1.*

**Question:** The Cato inline check request carries only `payloadHash` and `payloadSize`. Cato's Phase 1 deterministic checks (path traversal, injection signatures, PII patterns) require inspecting byte content, not just a hash. Three options:
- (a) Orchestrator includes a small signed content excerpt alongside the hash for pattern-check purposes.
- (b) Pattern checks are moved to the orchestrator or Call Inspector (before the Cato gate).
- (c) Cato receives full payload content for action types where pattern-checking is required, with PSYCHE.md defining which action types warrant content delivery.

**Decision:** Option (a) — the orchestrator includes a content excerpt in the inline check request for the action types where byte-level pattern checks are required.

**Implementation detail:**
- The inline check request schema gains an optional field: `"contentExcerpt": "<base64-encoded-bytes>"`.
- `contentExcerpt` is present only for action types that require byte-level inspection: `AGENT_PROMPT`, `OUTBOUND_API_CALL`, `MEMORY_WRITE`. It is absent (null or omitted) for `FILESYSTEM_WRITE` and `CREDENTIAL_REQUEST` (size check alone is sufficient for these in Phase 1).
- The excerpt is the first 4 KB of the payload, base64-encoded. If the payload is shorter than 4 KB, the full payload is included.
- The excerpt is included alongside the hash, not instead of it. The hash remains the authoritative content reference for the audit trail.
- No signing of the excerpt is required in Phase 1. The orchestrator is in TD-ORCHESTRATOR and is trusted to provide an accurate excerpt. In Phase 2, if tampering becomes a concern, HMAC of the excerpt against the full payload hash can be added.

**Why option (a) and not (b) or (c):**
- Option (b) moves pattern checks into the orchestrator, blurring the enforcement boundary. The Call Inspector already handles prompt injection for proxied calls. Cato's inline gate is the authority for orchestrator-level actions (prompts, memory writes). Moving Cato's checks into the orchestrator gives the orchestrator safety responsibilities it should not own (§3.1 ARCHITECTURE.md: "does not own safety decisions"). Rejected.
- Option (c) delivers full payload content to Cato. The ARCHITECTURE.md design intent (`payloadHash` and `payloadSize` only) is to prevent Cato from becoming a secondary surface where payload content is retained and auditable independently. A 4 KB excerpt is a practical compromise: enough for pattern matching, not a full content repository.
- Option (a) preserves the hash-primary design while making deterministic checks functional. The excerpt is transient — Cato uses it for the check and does not log or persist it.

**Implications:**
- The Cato spec (§2.1) must add `contentExcerpt` as an optional field in the request schema, with documentation of which action types include it.
- The Cato spec (§3.1) must be updated: the path traversal and injection checks operate on `contentExcerpt` when present; they are skipped when absent (e.g. for `FILESYSTEM_WRITE`).
- Cato's invariant 6 ("payload content is not reproduced") is not violated — the excerpt is used for checking, not reproduced in responses or audit entries. The `reason` field constraint still applies.
- The Cato spec's acceptance criteria must add: "AC-N: For action types `AGENT_PROMPT`, `OUTBOUND_API_CALL`, and `MEMORY_WRITE`, the request includes a `contentExcerpt` field. For `FILESYSTEM_WRITE` and `CREDENTIAL_REQUEST`, `contentExcerpt` is absent or null."

---

## Decision 18: Cato Scheduled Audit Interval Default and Configuration (April 2026)

*Resolved from TBD-B2 in cato-spec.md. See also ARCHITECT_REVIEW.md TBD-B2.*

**Question:** What is the default scheduled audit interval, and how is it configured?

**Decision:** Default interval is **6 hours**. Configured via the environment variable `CATO_AUDIT_INTERVAL`, expressed as a Go-style duration string (e.g. `6h`, `30m`, `24h`). The minimum permitted value is `15m`; values below this are rejected at startup with a configuration error.

**Rationale:**
- 1 hour is aggressive for a personal assistant with low call volume — it adds frequent disk I/O and LLM overhead (Phase 2) for little governance benefit on quiet days.
- 24 hours means a security anomaly from the morning is not surfaced until the next day, which is too slow for a responsive posture.
- 6 hours balances timeliness with overhead. Four audit cycles per day means an anomaly pattern is surfaced within hours, not a full day. For deployments with higher call volume, the administrator can reduce to `1h` or `2h`.
- A duration string (not seconds integer) is human-readable in config files and avoids unit confusion.

**Implications:**
- `CATO_AUDIT_INTERVAL` is a non-secret config var and belongs in `bootstrap.ts`'s `CONFIG_KEYS` whitelist per Decision 9.
- Cato must validate the interval at startup and refuse to start if the value is below `15m` or unparseable.
- The Cato spec §3.4 must replace "default interval: TBD" with "default interval: 6 hours; configured by `CATO_AUDIT_INTERVAL` (duration string, minimum `15m`)."

---

## Decision 19: Token Broker Notification Wire Format for Skill Registration (April 2026)

*Resolved from TBD-C1 in skill-schema-spec.md. See also ARCHITECT_REVIEW.md TBD-C1.*

**Question:** ARCHITECTURE.md §5.5 states "Token Broker notified of new skill scope" on skill registration but gives no JSON-RPC method or schema. What is the wire format, and does it use the existing token lifecycle socket or a new socket?

**Decision:** The notification reuses the existing **token lifecycle socket** (§4.2.1, `data/sockets/broker.sock`). A new JSON-RPC method `registerSkillScope` is defined on that socket. No new socket is created.

**Wire format:**

```json
// Registration (orchestrator → broker)
{
  "jsonrpc": "2.0",
  "method": "registerSkillScope",
  "params": {
    "skillId": "<kebab-case-skill-id>",
    "tokenScopes": ["<skill-id>", "..."],
    "networkEndpoints": [
      { "pattern": "<url-pattern>", "protocol": "https | wss" }
    ]
  },
  "id": 10
}

// Success response
{
  "jsonrpc": "2.0",
  "result": { "registered": true },
  "id": 10
}

// Error response (e.g. duplicate skill ID from broker's perspective)
{
  "jsonrpc": "2.0",
  "error": { "code": -32600, "message": "<reason>", "data": { "field": "<field>" } },
  "id": 10
}
```

**Deregistration (on skill removal):**
```json
{
  "jsonrpc": "2.0",
  "method": "deregisterSkillScope",
  "params": { "skillId": "<kebab-case-skill-id>" },
  "id": 11
}

// Success response
{
  "jsonrpc": "2.0",
  "result": { "deregistered": true },
  "id": 11
}
```

**Rationale:**
- Reusing the token lifecycle socket avoids a fourth socket and keeps all orchestrator→broker communication on one channel. The two-socket design (token lifecycle vs escalation) was motivated by direction inversion (§4.2 ADR-11); this notification is orchestrator-initiated, so it belongs on the existing orchestrator→broker socket.
- Including `networkEndpoints` in the registration call lets the broker update the Call Inspector's endpoint constraint list in one atomic operation — the inspector always sees the complete declared endpoint set for any registered skill.
- `tokenScopes` is the list of skill IDs to add to the allowed scope set (mirrors `token_scopes.skills` from `.intent.md`). It may be empty for skills that add endpoints but no token scope names.
- The broker responds synchronously before the orchestrator reports success to the administrator. This preserves the skill-schema-spec's Invariant 4 (broker consistency).

**Implications:**
- The Token Broker spec must add `registerSkillScope` and `deregisterSkillScope` to its External Interface section (§4.2.1).
- The Skill Schema spec must replace its "TBD" broker notification section with this wire format.
- The Call Inspector's endpoint constraint list is updated by the broker (not directly by the orchestrator) when `registerSkillScope` is processed. This keeps the inspector's state within TD-BROKER.
- The Tester should add an AC verifying that after `registerSkillScope`, subsequent `issueToken` calls include the new skill's scope in the issued token's claims.

---

## Decision 20: `router_state` Placement and Tier 2 Retention Scope (April 2026)

*Resolves TBD-D1 and TBD-D2 from memory-tiers-spec.md. See also ARCHITECT_REVIEW.md TBD-D1 and TBD-D2.*

### TBD-D1: `router_state` placement

**Question:** Does outbound routing metadata (`router_state`) belong in Tier 2 `messages.db` (as a new table) or is it maintained in-process by the orchestrator only with no persistence?

**Decision:** `router_state` is maintained **in-process by the orchestrator only** — no Tier 2 persistence.

**Rationale:** Outbound routing metadata (which channel adapter, which conversation thread, pending delivery acknowledgments) is ephemeral operational state. It is needed only while the orchestrator is routing an outbound message — a transaction that completes in milliseconds. Persisting it to SQLite adds write latency and schema surface for no governance benefit: routing state is not an audit concern, not a Cato input, and not needed for session continuity (the channel thread ID is already carried in the inbound `messages` row). On orchestrator restart, any in-flight routing state is naturally reset; the orchestrator re-reads the message queue and re-routes. No Tier 2 schema changes are needed.

**Implications:**
- The Tier 2 schema remains as specified in the Memory Tiers spec (three tables: `messages`, `sessions`, `tasks`). No `router_state` table is added.
- The Memory Tiers spec TBD note in the schema section can be closed with: "`router_state` is not persisted to Tier 2. Routing metadata is maintained in-process by the orchestrator."

### TBD-D2: Session/task retention scope

**Question:** When a pruning retention window is configured, does it apply only to the `messages` table, or also to `sessions` and `tasks` rows?

**Decision:** The retention window applies to the **`messages` table only**. `sessions` and `tasks` rows are retained indefinitely regardless of the retention window.

**Rationale:** Session and task records are thin metadata rows (a handful of columns, no payload content). They are the skeleton of the audit trail — removing them would leave orphaned `messages` rows and break Cato's ability to correlate message patterns with task and session context during scheduled audits. The governance value of the `sessions` and `tasks` tables is high relative to their storage cost. Pruning `messages` rows (which may contain excerpts or structured content) is the correct tradeoff: payload content ages out; the structural audit record does not.

**Implications:**
- The Memory Tiers spec Tier 2 Retention section must be updated: "When configured, the retention window applies to the `messages` table only. `sessions` and `tasks` rows are retained indefinitely."
- The Tester must verify that a pruning operation removes only `messages` rows older than the window and leaves `sessions` and `tasks` rows intact.

---

## Decision 21: WAL Mode Mandatory, Missing `messages.db` Auto-Create (April 2026)

*Resolves TBD-D3 and TBD-D4 from memory-tiers-spec.md. See also ARCHITECT_REVIEW.md TBD-D3 and TBD-D4.*

### TBD-D3: WAL mode mandatory for Tier 2

**Decision:** WAL (Write-Ahead Logging) mode is **mandatory** for all Tier 2 `messages.db` files. The orchestrator enables WAL mode (`PRAGMA journal_mode=WAL`) immediately after opening or creating any `messages.db`. This is not configurable. A `messages.db` that cannot be opened in WAL mode is treated as a startup error for that group.

**Rationale:** Cato requires concurrent read access to `messages.db` during scheduled audits while the orchestrator may be actively writing. WAL mode is the only SQLite mode that supports this without a full write lock. The alternative (exclusive write lock during audits) would block message processing for the audit duration — unacceptable. WAL is the correct and only supported mode.

**Implications:**
- The Memory Tiers spec T2-7 must drop "WAL mode is assumed; TBD" and replace with "WAL mode is mandatory (see Decision 21)."
- The orchestrator's database initialization code must issue `PRAGMA journal_mode=WAL` for every `messages.db` opened. This is a normative implementation requirement, not advisory.

### TBD-D4: Missing `messages.db` — auto-create

**Question:** When the orchestrator needs to write to a group's `messages.db` and the file does not exist, should it auto-create or halt?

**Decision:** **Auto-create.** When `groups/{name}/messages.db` does not exist, the orchestrator creates the file, applies the normative Tier 2 schema (three `CREATE TABLE` statements), enables WAL mode, and continues. This happens transparently — no administrator action is required to provision a new group's database.

**Rationale:** Requiring administrator intervention to create a database file for every new group would make the system unusable in practice. The schema is static and code-owned; there is no safety concern in creating it automatically. A missing database is a normal first-use condition for a new group, not an error condition. If the file cannot be created (permissions error, disk full), that is a genuine error and the orchestrator halts task dispatch for that group and logs the failure.

**Implications:**
- The Memory Tiers spec FM-3 must be updated: "If `messages.db` is missing, the orchestrator auto-creates it with the normative schema and WAL mode enabled. If creation fails (permissions, disk), the orchestrator logs the error and queues pending messages for the group without dispatching containers until the database is accessible."
- The Tester must verify auto-create behavior: send a message to a new group whose directory exists but whose `messages.db` does not; confirm the database is created and the message is processed normally.

---

## Decision 22: Missing `CLAUDE.md` at Container Spawn — Auto-Create (April 2026)

*Resolves TBD-D5 from memory-tiers-spec.md. See also ARCHITECT_REVIEW.md TBD-D5.*

**Question:** If `groups/{name}/CLAUDE.md` does not exist when a container is being spawned, should the orchestrator auto-create an empty file or halt?

**Decision:** **Auto-create an empty file.** If `groups/{name}/CLAUDE.md` does not exist at container spawn time, the orchestrator creates an empty file (zero bytes) at that path before finalizing the bind mount configuration. The container is then spawned normally with the empty file mounted.

**Rationale:** An empty `CLAUDE.md` is a perfectly valid Tier 1 state — it is the natural starting point for a group with no accumulated memory. Halting the spawn because the file is absent would mean that the first task for any new group always fails, which is a terrible user experience and serves no safety purpose. The bind mount must reference an existing file (container runtime requirement); auto-creating the empty file satisfies the runtime requirement without complexity. Cato's `MEMORY_WRITE` gate still governs any subsequent write to the file; the auto-create of an empty file is not a memory write proposal from an agent and does not require a Cato check.

**Implications:**
- The Memory Tiers spec FM-5 must be updated: "If `groups/{name}/CLAUDE.md` is absent at spawn time, the orchestrator creates an empty file at that path before configuring the bind mount. No Cato check is required for the empty-file creation. The container is spawned normally."
- The orchestrator's spawn logic must check for the file's existence and create it if absent before building the mount configuration. This is the same startup sequence as `messages.db` auto-create (Decision 21).
- The Tester must verify: spawn a container for a group whose directory exists but whose `CLAUDE.md` does not; confirm the container starts and the file exists (empty) after spawn.

---

## Decision 23: Content Excerpt Ownership for Broker-Originated Escalations (April 2026)

*Resolves TBD-O1 from orchestrator-spec.md §3.6. See also ARCHITECT_REVIEW.md TBD-O1.*

**Question:** The Orchestrator receives a `catoEscalate` call from the Token Broker for an in-flight proxied call (§3.6). It must forward a Cato check that includes `contentExcerpt` (first 4 KB base64, per Decision 17). The Orchestrator is not the originator of the proxied call — the container is. The question: how does the Orchestrator have the content excerpt available at escalation relay time?

**Decision:** The Orchestrator does not hold the content excerpt for broker-originated escalations. The **broker holds it** — the broker was the component that intercepted and inspected the proxied payload in the first place. When the broker sends `catoEscalate`, it must include `contentExcerpt` as an additional field in the escalation params. The Orchestrator passes it through to Cato unchanged.

**`catoEscalate` params schema update:** The broker→orchestrator escalation call gains an optional field:

```json
{
  "checkId": "<uuid>",
  "action": "OUTBOUND_API_CALL",
  "contextId": "...",
  "tokenId": "...",
  "payloadHash": "<sha256-hex>",
  "payloadSize": 42000,
  "escalationReason": "INSPECTOR_INCONCLUSIVE",
  "inspectorCheck": "PROMPT_INJECTION",
  "contentExcerpt": "<base64-encoded-bytes | null>"
}
```

`contentExcerpt` is present (non-null) when the action type is one that requires byte-level inspection per Decision 17 (`OUTBOUND_API_CALL` for broker-originated escalations). It is `null` or absent when the action type does not require it.

**Orchestrator relay behavior (§3.6 updated):** The Orchestrator extracts `contentExcerpt` from the broker params alongside `checkId`, `action`, `contextId`, `tokenId`, `payloadHash`, and `payloadSize`. It drops `escalationReason` and `inspectorCheck` (broker-internal metadata not delivered to Cato). The `contentExcerpt` value is forwarded to Cato in the standard seven-field check request, consistent with Decision 17.

**Rationale:**
- The broker is the natural content holder at escalation time. It intercepted the proxied call, ran the Call Inspector, and determined escalation was warranted. Moving excerpt responsibility to the Orchestrator would require a separate out-of-band excerpt delivery mechanism, adding complexity with no benefit.
- This approach is consistent with the existing design principle that the Orchestrator is a relay, not a content processor, during escalation (ADR-11).
- The excerpt is transient: the broker holds it only for the duration of the escalation round-trip; neither the broker nor the Orchestrator logs or persists the excerpt content.

**Implications:**
- The Token Broker spec (§4.2.2, `catoEscalate` params schema) must add `contentExcerpt` as an optional field.
- The Orchestrator spec §3.6 step 2 ("Derive `contentExcerpt`") must be corrected: the orchestrator does not derive the excerpt; it receives it from the broker params and passes it through.
- The Orchestrator spec §2.3 (inbound escalation socket schema) must reflect the updated `catoEscalate` params including `contentExcerpt`.
- INV-12 in the Orchestrator spec must be satisfied: for `OUTBOUND_API_CALL` escalations, `contentExcerpt` will be non-null in the broker params and must be forwarded non-null to Cato.

---

## Decision 24: Supervised Mode Confirm/Cancel Wire Protocol and Timeout (April 2026)

*Resolves TBD-O2 from orchestrator-spec.md §3.7. See also ARCHITECT_REVIEW.md TBD-O2.*

**Question:** After the broker issues a soft-block signal, the broker holds the proxied call waiting for a confirm or cancel decision from the user. The Orchestrator needs a wire mechanism to relay that decision back to the broker. The spec flags both the wire protocol and the timeout as TBD.

**Decision:**

### Part 1: `resolveSupervised` wire method

A new JSON-RPC method is defined on the **token lifecycle socket** (`data/sockets/broker.sock`) — the existing orchestrator→broker socket (Decision 15). No new socket is needed.

```json
// Orchestrator → Broker (after user confirms or cancels)
{
  "jsonrpc": "2.0",
  "method": "resolveSupervised",
  "params": {
    "checkId": "<uuid>",
    "decision": "confirm | cancel"
  },
  "id": 20
}

// Broker response
{
  "jsonrpc": "2.0",
  "result": { "accepted": true },
  "id": 20
}
```

`checkId` is the identifier from the original soft-block signal — the broker uses it to locate and resolve the held call. A `decision: "confirm"` causes the broker to forward the held proxied call. A `decision: "cancel"` causes the broker to abandon the held call and return an error response to the container.

### Part 2: User-confirmation timeout

**60 seconds** from the moment the soft-block signal is routed to the channel adapter (i.e. from when the user-confirmation prompt is sent). If no user response is received within 60 seconds, the Orchestrator automatically sends `resolveSupervised` with `decision: "cancel"`.

The 60-second timeout is not configurable in Phase 1. It is chosen as a reasonable interactive window — long enough for a user to read and respond, short enough that the container does not hang indefinitely while awaiting confirmation. In Phase 2, a per-group or per-deployment configuration option (`SUPERVISED_CONFIRM_TIMEOUT_SECS`) may be introduced if operational experience warrants it.

**Audit on auto-cancel:** When the timeout fires and the Orchestrator auto-cancels, it writes a `cato_block` entry to the audit log with `code: null` and `reason: "supervised_timeout"` (distinct from `reason: "user_cancelled"` which is used when the user explicitly cancels). This distinction lets Cato's scheduled audit differentiate between active user rejections and passive non-responses.

**Rationale:**
- Reusing the existing token lifecycle socket avoids a new socket and keeps all orchestrator→broker communication on one channel. The resolve call is orchestrator-initiated, which is consistent with the existing socket's direction.
- A UUID `checkId` matches the held call unambiguously. The broker may have multiple soft-blocked calls in flight concurrently (across groups); the `checkId` ensures the correct one is resolved.
- 60 seconds matches the interactive expectation for a mobile channel (Telegram/WhatsApp) where the user may receive a push notification and respond within a minute.

**Implications:**
- The Token Broker spec must add `resolveSupervised` to its External Interface section (§4.2.1) with the params schema above and behavioral contract: "On `decision: 'confirm'`: forward the held call. On `decision: 'cancel'`: abandon the held call and return an error to the container. Respond `{ accepted: true }` in both cases."
- The Orchestrator spec §3.7 must replace both TBD notes (timeout and wire protocol) with this decision.
- The Orchestrator spec §2.2 (methods the Orchestrator calls on the broker socket) must add `resolveSupervised`.
- The audit log event table (§2.6) must distinguish `reason: "supervised_timeout"` from `reason: "user_cancelled"` in the `cato_block` entry.
- `SUPERVISED_CONFIRM_TIMEOUT_SECS` is reserved as a future non-secret config var for Decision 9's whitelist if introduced in Phase 2.

---

## Decision 25: Per-Group Configuration File Format and Path (April 2026)

*Resolves TBD-O3 from orchestrator-spec.md §3.9. See also ARCHITECT_REVIEW.md TBD-O3.*

**Question:** The Orchestrator spec §3.9 references per-group configuration (security mode, assertiveness level, display tags, provider config, skill set override) but leaves the file format and path as TBD.

**Decision:**

**Path:** `groups/{name}/config.json` — JSON, not YAML. Consistent with the rest of the codebase's use of JSON for structured config (audit log schema, skill registry, IPC protocol bodies). One format, one parser.

**Required fields:**

| Field | Type | Values | Description |
|-------|------|--------|-------------|
| `securityMode` | string | `golem_guard \| supervised \| power` | Governs Call Inspector enforcement posture for this group |
| `assertiveness_level` | integer | 1–5 | Alef's assertiveness dial; 1 = most compliant, 5 = most assertive (Decision 10) |

**Optional fields:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `flag_display_tag` | string | `[FLAG]` | Display string Alef uses when asserting against an instruction |
| `blocked_display_tag` | string | `[BLOCKED]` | Display string used when a Cato block is communicated to the user |
| `provider_override` | object | (deployment default) | Overrides the deployment-level provider config for this group (same shape as the deployment provider config object) |
| `skill_set_override` | array of strings | (global installed set) | Array of skill IDs; if present, restricts this group's container to only these skills. If absent, the global installed skill set applies. |

**Example:**

```json
{
  "securityMode": "supervised",
  "assertiveness_level": 3,
  "flag_display_tag": "[FLAG]",
  "blocked_display_tag": "[BLOCKED]",
  "skill_set_override": ["browser", "status"]
}
```

**Absence and malformation:**
- If `config.json` is **absent**, the Orchestrator uses deployment defaults for all fields. This is the normal state for a new group and is not an error condition.
- If `config.json` is **present but malformed** (invalid JSON, required field missing, field value out of range), the Orchestrator logs a `config_parse_error` event to the audit log with the group ID and error summary (not the file content), and falls back to deployment defaults for that group. The Orchestrator does not halt and does not block task dispatch. An operator can diagnose and correct the file; the next reload will pick up the corrected config.

**Rationale:**
- JSON is already the wire and persistence format throughout OpenGolem (IPC protocol, audit schema, skill registry). Adding YAML parsing as a dependency for config files would introduce a second format with no benefit.
- Failure-to-parse falling back to defaults (rather than halting) is consistent with the general principle that a misconfigured group should not take down the entire service. The audit log entry ensures the operator is informed.
- Optional fields with explicit defaults mean a minimal `config.json` with only `securityMode` and `assertiveness_level` is valid and complete.

**Implications:**
- The Orchestrator spec §3.9 must be updated: replace "file format and path TBD" with "path: `groups/{name}/config.json`; format: JSON; required fields: `securityMode`, `assertiveness_level`; optional fields as above."
- The audit log event table (§2.6) must add a `config_parse_error` event type with fields `groupId` and `errorSummary`.
- The Developer must add `config.json` parsing to the group configuration load step (§3.1 step 6 and §3.9).
- `groups/*/config.json` must be added to `.gitignore` (contains per-group operator choices, not source code).
- The Tester must verify: (a) absent `config.json` results in deployment defaults; (b) malformed `config.json` results in deployment defaults plus a `config_parse_error` audit entry; (c) valid `config.json` overrides the corresponding fields.

---

## Decision 26: Hansei Inbox Quarantine Mechanism (April 2026)

*Resolves TBD-O4 from orchestrator-spec.md Failure Modes table. See also ARCHITECT_REVIEW.md TBD-O4.*

**Question:** When a hansei report file in `data/hansei/inbox/` is unreadable or fails JSON schema validation, the Orchestrator must not re-attempt it on every poll interval. The spec flags the quarantine mechanism as TBD.

**Decision:**

**On parse or validation failure:**
1. Move the file to `data/hansei/quarantine/` (the Orchestrator creates this directory at startup if absent, alongside `data/hansei/inbox/`).
2. Write a `hansei_parse_error` event to the audit log with: the SHA-256 hash of the file path (not the filename itself, to avoid leaking internal path structure in the audit log) and a brief parse error summary (the error message from the JSON parser or schema validator). The file content is never written to the audit log.
3. The file is not re-attempted. Only a manual administrator action (deleting the file from `data/hansei/quarantine/`) removes it from quarantine.

**Health endpoint surfacing:** The `/health` response gains a `quarantinedHanseiReports` integer field (count of files currently in `data/hansei/quarantine/`). A non-zero count is reflected in `status: "degraded"` — the Orchestrator is operational but the administrator's attention is needed. A count of zero does not contribute to degraded status.

**No automatic retry:** Automatic retry of quarantined files is explicitly not implemented. The assumption is that a file that cannot be parsed is either corrupted (retry will always fail) or represents a Cato implementation bug (which requires a code fix, not a retry). Retrying corrupt files wastes cycles and can mask persistent bugs. An administrator can re-introduce a corrected file into `data/hansei/inbox/` manually if needed.

**Administrator remediation path:**
1. Inspect `data/hansei/quarantine/` for the offending files.
2. Correct the file or discard it.
3. If the file is correctable (e.g. truncated but recoverable), move it back to `data/hansei/inbox/` for the next poll cycle to pick up. The Orchestrator treats any file in the inbox that has not been seen in the current session as new.
4. If the file is not correctable, delete it from quarantine.

**Rationale:**
- Moving to a dedicated quarantine directory (rather than simply skipping the file and logging a warning) prevents the failed file from being re-polled on every interval, which would flood the audit log with repeated parse errors.
- Using the file path hash (not the raw path) in the audit log preserves the no-content-in-audit-log invariant while still giving the administrator a stable correlator between the audit entry and the file on disk.
- Surfacing the quarantine count in the health endpoint closes the operational gap: without this, a quarantined file would be silent after the initial `hansei_parse_error` entry, and an administrator might not notice it until reviewing the audit log manually.
- No automatic retry is the conservative choice for a security-sensitive component. Cato is producing these reports; a file that Cato produced but the Orchestrator cannot parse is a signal worth preserving for human review, not silently retrying.

**Implications:**
- The Orchestrator spec Failure Modes table must replace "TBD — architect to resolve: quarantine mechanism" with the behavior above.
- The audit log event table (§2.6) must add a `hansei_parse_error` event type with fields `filePathHash` and `errorSummary`.
- The health endpoint schema (§2.9) must add `quarantinedHanseiReports: integer`.
- The startup sequence (§3.1) must create `data/hansei/quarantine/` alongside `data/hansei/inbox/` if absent.
- The Tester must verify: (a) a malformed file in `data/hansei/inbox/` is moved to `data/hansei/quarantine/` and a `hansei_parse_error` entry appears in the audit log; (b) the file is not re-attempted on subsequent polls; (c) the health endpoint reports a non-zero `quarantinedHanseiReports` count and `status: "degraded"`.
- `data/hansei/quarantine/` must be added to `.gitignore`.

---

## Decision 27: Role Execution Model — Frontier Models for All Roles with HitL Authority (April 2026)

**Question:** TEAM.md v1 stated that certain roles (PM, Voice of Customer, final merge authority) "cannot be delegated" because no AI can stand in for real users. Is this still accurate in April 2026?

**Decision:** The framing is revised. In April 2026, frontier models are capable of executing any specialist role to a production standard. Every role — PM, Voice of Customer, Architect, Cybersecurity Specialist, UX Designer, and all others — can be executed by a frontier model in a session scoped to that role's remit.

Jim's authority remains non-delegable. His *execution* is not. The distinction is: Jim holds three authorities that cannot be transferred — roadmap and scope decisions, risk acceptance sign-offs, and final merge approval. He does not need to personally execute every task those authorities oversee. Every role produces an artifact; every artifact requires Jim's review and approval before it is acted upon. The frontier model executes; Jim governs.

**Implications:**
- TEAM.md is updated to v2, replacing the "cannot be delegated" framing with the authority/execution distinction.
- New specialist roles added to TEAM.md v2: Cybersecurity Specialist, DevOps/Systems Administrator, UX/Interaction Designer, and Supply-Chain Auditor — each executable by a frontier model in a scoped session.
- PM_BRIEF.md is updated to v2, incorporating session trigger prompts for all new specialist roles and sequencing the security and UX streams alongside the original development streams.

---

## Decision 28: Security Strengthening Document as Canonical Project Document (April 2026)

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
- F-9 requires a PM risk-acceptance decision (Decision 29 below) before any MCP-declaring skill ships.
- F-10 has a Phase 1 component (npm audit policy, container image pinning) and a Phase 2 component (Rust crate dependency minimisation as acceptance criterion).

---

## Decision 29: F-9 Risk Acceptance — MCP Permission Tier Enforcement Deferred to Phase 2 (April 2026)

**Question:** The `.intent.md` schema includes a `min_permission_tier` field for MCP server declarations, but enforcement is deferred to Phase 2. During Phase 1, a lower-tier team member can trigger MCP calls to enterprise systems for which they would not otherwise have authorisation. Is this risk accepted for Phase 1?

**Decision:** Accepted for Phase 1, with the following documented interim control: MCP-declaring skills are restricted to administrator-only groups until Phase 2 permission tier enforcement is implemented. This must be stated as explicit deployment guidance in the documentation, not left implicit.

**Conditions:** The risk acceptance is contingent on the interim control being documented before any MCP-declaring skill ships. A skill that declares MCP servers may not be published without this guidance in place. The risk is automatically closed when Phase 2 permission tier enforcement is implemented and verified by the Security Reviewer.

**Implications:**
- Deployment documentation must include a "Phase 1 MCP limitation" notice before any MCP skill is published.
- The dashboard skill (Stream C sub-item) does not declare MCP servers and is not affected.
- Phase 2 scope must include permission tier enforcement as a named deliverable, not an open item.
