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
