# OpenGolem

Security-first personal AI assistant. See `docs/ARCHITECTURE.md` for architecture. See `docs/PLAN_V1.md` for implementation status. Human-facing overview: `README.md`. Cursor layout: `CURSOR.md` and `.cursor/rules/opengolem.mdc`.

## Quick Context

Single Node.js process (v1.0-dev branch, Phase 2 development in progress). Channels: **TUI + Telegram** (v1.0 defaults, Decision 30). Messages route to Claude Agent SDK running in isolated Linux containers. Each group has its own filesystem, memory, and container sandbox. Credentials are mediated via Token Broker — agents never see raw API keys.

**Current phase:** M12/M18/M20/M23 developer implementations complete (Token Broker, Skill Schema, Memory Tiers, Orchestrator). 783 tests passing. Plan approved 2026-04-07. See `docs/PLAN_V1.md` for milestone status and `docs/PM_BRIEF.md` for open decisions.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/broker/index.ts` | Token Broker — JSON-RPC 2.0, Call Inspector, credential proxy |
| `src/memory/tier1.ts` | Tier 1: CLAUDE.md per-group memory with Cato gate |
| `src/memory/tier2.ts` | Tier 2: messages.db episodic memory (WAL, per-group) |
| `src/memory/tier3.ts` | Tier 3: memory.db strategic memory with Inspector gate |
| `src/skills/skill-schema.ts` | Skill schema validation and lifecycle |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `runtime/SOUL.md` | Alef's character, commitments, and [FLAG]/[BLOCKED] protocol |
| `runtime/PSYCHE.md` | Cato's operating contract, PSY-NN criteria, dao_score thresholds |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/skills/` | Skills loaded inside agent containers (browser, status) |
| `docs/ARCHITECTURE.md` | Architecture specification (v1.0) |
| `docs/PLAN_V1.md` | Implementation plan with milestone status |
| `docs/DECISIONS.md` | Architecture decision records (ADR-1 through ADR-39) |
| `docs/SECURITY_STRENGTHENING.md` | Security findings F-1–F-10 and closure status |
| `docs/PM_BRIEF.md` | PM operating document — open decisions and stream status |
| `docs/specs/` | Behavioral specs for all components |
| `docs/deployment/` | Hardening, credential rotation, broker recovery runbooks |
| `README.md` | Overview, quick start, credits (lineage vs new work) |
| `.cursor/rules/opengolem.mdc` | Cursor IDE always-on project rules |

## Secrets / Credentials

**Target (see `docs/ARCHITECTURE.md` §5.1, `docs/DECISIONS.md` Decision 8):** three selectable backends behind the Token Broker — **`.env`** (dev), **Bitwarden** (recommended production), **OneCLI** Agent Vault (optional).

**Current implementation:** Token Broker (`src/broker/index.ts`) reads from `.env` credential backend and issues derivative tokens to containers. Containers never receive raw credentials — they call the credential proxy which injects the real credential per-call after Call Inspector checks.

**`.env` keys:**
- `CLAUDE_CODE_OAUTH_TOKEN` — Enterprise/Pro OAuth token (from `claude setup-token`)
- `ANTHROPIC_API_KEY` — API key from console.anthropic.com
- `ANTHROPIC_BASE_URL_UPSTREAM` — custom Enterprise endpoint (optional)
- `CREDENTIAL_PROXY_PORT` — proxy port (default: 3001)
- `CREDENTIAL_PROXY_BIND_ADDRESS` — override Docker bridge bind address (default: `172.17.0.1`)
- `OPENGOLEM_CHANNELS` — e.g. `tui`, `tui,telegram` (see `src/channels/channel-enabled.ts`)
- `TELEGRAM_BOT_TOKEN` — when using Telegram (bot from @BotFather)
- `TELEGRAM_ALLOW_GROUPS` — `1` / `true` / `yes` to allow supergroups/groups
- `TELEGRAM_VALID_USERS` — **mandatory** comma-separated Telegram user IDs; empty or unset = no access from anyone (fail-secure)
- `LOG_LEVEL` — `debug` | `info` | `warn` | `error` | `fatal` (TUI-only default is `warn` when unset)
- `INBOUND_RATE_LIMIT_PER_SENDER` — max messages per sender per 60s window (default: 10)
- `INBOUND_QUEUE_MAX_DEPTH` — max pending messages per group queue (default: 100)
- `CREDENTIAL_RELOAD_INTERVAL` — credential backend poll interval ms (default: 300000)

## Skills

Four types of skills exist in OpenGolem:

- **Feature skills** — merge a `skill/*` branch to add capabilities (e.g. `/add-telegram`, `/add-whatsapp`)
- **Utility skills** — ship code files alongside SKILL.md (e.g. `/claw`)
- **Operational skills** — instruction-only workflows, always on `main` (e.g. `/setup`, `/debug`)
- **Container skills** — loaded inside agent containers at runtime (`container/skills/`)

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |

## Development

Run commands directly — don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
npm test             # Run test suite (563 tests)
./container/build.sh # Rebuild agent container image
```

Service management:
```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.opengolem.plist
launchctl unload ~/Library/LaunchAgents/com.opengolem.plist
launchctl kickstart -k gui/$(id -u)/com.opengolem  # restart

# Linux (systemd)
systemctl --user start opengolem
systemctl --user stop opengolem
systemctl --user restart opengolem

# WSL / no systemd
bash start-opengolem.sh
```

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.

## Sentinel Protocol

Host and container communicate via stdout markers:
```
---OPENGOLEM_OUTPUT_START---
{ "status": "success"|"error", "result": "...", "newSessionId": "..." }
---OPENGOLEM_OUTPUT_END---
```
Both sides must use the same marker strings. If you change one, change both (`src/container-runner.ts` and `container/agent-runner/src/index.ts`).
