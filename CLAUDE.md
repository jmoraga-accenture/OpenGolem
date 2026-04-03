# OpenGolem

Security-first personal AI assistant. See `docs/SPECS.md` for architecture. See `docs/PLAN.md` for implementation status.

## Quick Context

Single Node.js process (Phase 1 TypeScript baseline). Channels (Telegram, WhatsApp, Teams, TUI) are skills that self-register at startup. Messages route to Claude Agent SDK running in isolated Linux containers. Each group has its own filesystem, memory, and container sandbox. Credentials are mediated — agents never see raw API keys.

**Current phase:** M1 complete. Security-hardened TypeScript baseline. See `docs/SECURITY_AUDIT.md` and `docs/PLAN.md` for lineage.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/credential-proxy.ts` | Native credential proxy (M1 placeholder for Token Broker) |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/skills/` | Skills loaded inside agent containers (browser, status) |
| `docs/SPECS.md` | Architecture specification (v0.4) |
| `docs/PLAN.md` | Implementation plan with milestone status |
| `docs/SECURITY_AUDIT.md` | Security audit findings and fixes |
| `docs/DECISIONS.md` | Architecture decision records |

## Secrets / Credentials

**Target (see `docs/SPECS.md` §5.1, `docs/DECISIONS.md` Decision 8):** three selectable backends behind the Token Broker — **`.env`** (dev), **Bitwarden** (recommended production), **OneCLI** Agent Vault (optional; same gateway pattern as the upstream stack when configured on a secure local bind).

**Current implementation (M1):** native credential proxy (`src/credential-proxy.ts`) reads from `.env` and injects into container API requests via `ANTHROPIC_BASE_URL`. Supports `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, and `ANTHROPIC_AUTH_TOKEN`. Token Broker (M2) will replace this with opaque scoped tokens + pluggable backends.

**`.env` keys:**
- `CLAUDE_CODE_OAUTH_TOKEN` — Enterprise/Pro OAuth token (from `claude setup-token`)
- `ANTHROPIC_API_KEY` — API key from console.anthropic.com
- `ANTHROPIC_BASE_URL_UPSTREAM` — custom Enterprise endpoint (optional)
- `CREDENTIAL_PROXY_PORT` — proxy port (default: 3001)

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
npm test             # Run test suite (246 tests)
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
