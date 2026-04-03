# OpenGolem

Security-first personal AI assistant: self-hosted, auditable, and designed so agents run in isolated containers with mediated credentials—not raw API keys in the sandbox.

Phase 1 is a TypeScript/Node.js orchestrator (Milestone 1: security-hardened baseline, tests green). Phase 2 targets a Rust core while keeping the same IPC and container boundaries. See [docs/SPECS.md](docs/SPECS.md) for the full architecture (v0.4) and [docs/PLAN.md](docs/PLAN.md) for milestone status.

## What you get today

- Single-process host orchestrator: channels, queues, SQLite state, scheduled tasks
- Per-group isolation: filesystem, `CLAUDE.md` memory, and agent containers
- Claude Agent SDK inside Linux containers; host mediates Anthropic traffic (credential proxy today; Token Broker and Call Inspector are planned in the roadmap)
- Optional channels (e.g. Telegram, WhatsApp) via self-registering channel modules and Claude Code skills under `.claude/skills/`

## Requirements

- **Node.js** ≥ 20  
- **Docker** (or compatible runtime) for agent containers  
- Anthropic credentials via `.env` (see [CLAUDE.md](CLAUDE.md) for keys and [docs/SPECS.md](docs/SPECS.md) for the long-term credential model)

## Quick start

```bash
npm install
npm run build
npm test
npm run dev
```

Rebuild the agent image when container contents change:

```bash
./container/build.sh
```

First-time setup and channel wiring are guided by the operational skills documented in [CLAUDE.md](CLAUDE.md) (for example `/setup`, `/customize`, `/debug`).

## Documentation

| Document | Purpose |
|----------|---------|
| [docs/SPECS.md](docs/SPECS.md) | Architecture and security model |
| [docs/PLAN.md](docs/PLAN.md) | Implementation plan and milestones |
| [docs/SECURITY_AUDIT.md](docs/SECURITY_AUDIT.md) | Security audit notes |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Architecture decision records |
| [CLAUDE.md](CLAUDE.md) | Developer quick reference for this repo |
| [CURSOR.md](CURSOR.md) | Where Cursor rules and pointers live |

## License

This repository is released under the MIT License; see [LICENSE](LICENSE).

## Credits and copyright

OpenGolem incorporates **NanoClaw** code as its TypeScript baseline and reflects **MicroClaw**-style concepts in its security and isolation goals. Upstream lineage and design references are summarized in [docs/PLAN.md](docs/PLAN.md).

**Original project direction and new files and code in this repository** are credited to:

**(c) Jim Moraga <jim.moraga@pip.global>**

---

*README refreshed: 3 April 2026 (repository state and `docs/PLAN.md` as of that date).*
