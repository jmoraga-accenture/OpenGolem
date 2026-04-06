# OpenGolem — Ecosystem Context
*Produced: April 2026*

---

## The "Claw" Ecosystem

OpenGolem is part of a 2026 wave of "Agentic AI Assistants" — minimalist, self-hosted software that allows AI models (like Claude) to live inside chat apps (WhatsApp, Telegram, Discord, Teams) with the power to execute code, manage files, and perform tasks.

The ecosystem originates with **OpenClaw**, a large, full-featured Node.js reference implementation created by Peter Steinberger in November 2025. It became one of the fastest-growing open-source projects in GitHub history (247k+ stars, 47k+ forks by March 2026). **NanoClaw** and **MicroClaw** were created as reactions to OpenClaw's complexity, each focusing on reducing surface area while increasing security. **PicoClaw** went further still — a Go binary targeting sub-10MB RAM on $10 hardware.

OpenGolem draws architectural DNA from both NanoClaw and MicroClaw, but is not a fork of either. It adds a security layer — the Token Broker and Call Inspector — that none of the other projects have.

---

## OpenClaw

**Repository:** [openclaw/openclaw](https://github.com/openclaw/openclaw)
**Language:** Node.js
**Author:** Peter Steinberger (PSPDFKit founder)
**License:** MIT
**Stars:** ~247k (March 2026) — one of the fastest-growing open-source projects in GitHub history

### Philosophy

The reference implementation. Full-featured, no surface area compromises. Launched November 2025 as a single developer's experiment; went viral and spawned the entire ecosystem. Runs as a long-running Node.js service that executes real-world tasks — shell commands, browser automation, file management, calendar, email — via an LLM.

### Architecture

- Long-running Node.js service
- "Skills" plugin system for extensibility
- Direct LLM calls (no container isolation)
- No credential mediation model

### Channels

22+ messaging platforms including WhatsApp, Telegram, Slack, Discord, Signal, iMessage, WeChat, Teams, Matrix, and others. Channel breadth is a design goal.

### What OpenClaw Does Not Provide

No container isolation, no credential mediation, no call inspection, no safety/governance layer. These gaps are what NanoClaw, MicroClaw, and OpenGolem each address in different ways.

---

## NanoClaw

**Repository:** [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw)
**Language:** TypeScript / Node.js 20
**Author:** Gavriel Cohen (Qwibit)
**License:** MIT
**Stars:** ~26k (April 2026)

### Philosophy

"Small enough to understand." The core is roughly 500–4,500 lines of TypeScript, intentionally kept auditable. No dashboard, no installation wizard — management is through Claude Code. Customization means forking and modifying code, not editing config files.

### Architecture

- Single Node.js orchestrator process
- Agents run in Linux containers (Docker or Apple Container) — one container per agent group
- Filesystem-based IPC: host writes commands to a file; container reads, executes, writes result back
- Sentinel protocol: stdout wrapped in marker lines around JSON `ContainerOutput` objects (NanoClaw historically used `---NANOCLAW_OUTPUT_*---`; **OpenGolem** uses `---OPENGOLEM_OUTPUT_START---` / `---OPENGOLEM_OUTPUT_END---`)
- Per-group `CLAUDE.md` memory files mounted read-only into containers
- SQLite (`better-sqlite3`) for messages, sessions, state
- Uses Anthropic Claude Agent SDK directly inside containers (not a custom agent loop)
- Agent swarms via `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1'`

### Credential Security (OneCLI)

NanoClaw's key security innovation: credentials never enter containers. The **OneCLI** external proxy intercepts HTTPS traffic from within the container and injects API keys at the proxy level, with per-agent rate limits and access policies. The container holds only a gateway URL, not a real API key.

OpenGolem internalizes this principle as the **Token Broker** plus **Call Inspector** — agents never hold raw credentials. The broker can source secrets from **Bitwarden**, a **`.env`** file (dev), or optionally **reuse OneCLI’s Agent Vault** when configured securely (local gateway), so NanoClaw operators are not forced to migrate vaults on day one.

### Channels

Channels are not in the core — they are added via Claude Code skills (`/add-telegram`, `/add-whatsapp`, etc.). Core: WhatsApp, Telegram, Discord, Slack, Gmail.

### What OpenGolem Takes from NanoClaw

- Container isolation as the security foundation (not application-level permission checks)
- Filesystem-based IPC and the sentinel protocol
- Per-context `CLAUDE.md` memory files
- Skills over configuration (no config file sprawl)
- Fork-and-own model
- SQLite + filesystem IPC
- The credential proxy concept (re-implemented as the Token Broker)

---

## MicroClaw

**Repository:** [microclaw/microclaw](https://github.com/microclaw/microclaw)
**Language:** Rust 2021
**License:** MIT
**Stars:** ~620 (April 2026)

### Philosophy

"One runtime, many channels." A single high-performance binary deployable anywhere. Focuses on being a reliable "execution surface" with consistent behavior across channels and long-running stability.

### Architecture

- Rust workspace: `microclaw-core`, `microclaw-storage`, `microclaw-tools`, `microclaw-channels`, `microclaw-app`, `microclaw-observability`
- Own agentic loop (`process_with_agent`): call provider → if tool_use → execute → loop (up to `max_tool_iterations`)
- Provider-agnostic LLM layer: Anthropic, OpenAI, Ollama, OpenRouter, DeepSeek, Google
- Built-in channel adapters: Telegram (teloxide), Discord (serenity), Slack, Feishu/Lark, Matrix, Web UI, WhatsApp, IRC
- Sessions persisted as full `Vec<Message>` in SQLite, including tool_use/tool_result blocks
- Context compaction: when `> max_session_messages`, older messages summarized, recent kept verbatim
- Optional semantic KNN via `sqlite-vec` feature flag

### Memory Architecture

Three-tier memory: `groups/AGENTS.md` (global), `groups/{channel}/AGENTS.md` (per-channel bot memory), `groups/{channel}/{chat_id}/AGENTS.md` (per-chat).

### Skill System

`activate_skill` / `sync_skills` tools. Skills are modular plugins. ClawHub registry (not used by OpenGolem).

### SOUL.md

MicroClaw supports an optional `SOUL.md` personality file injected into the system prompt. Per-chat overrides are supported. OpenGolem adopted and formalized this pattern.

### Sandbox

Optional Docker sandbox (`ubuntu:25.10`). `path_guard` module blocks `.ssh`, `.aws`, `.env`, credentials in file tools. `SandboxMode`: Off | All.

### Web Control Plane

Built-in React+Vite UI embedded in the binary, served at `127.0.0.1:10961`. OpenGolem deliberately does not include a web UI — management is through the Executive Assistant via natural language (TUI only).

### What OpenGolem Takes from MicroClaw

- Rust as the rewrite target language
- Rust workspace crate structure pattern
- Tool trait pattern (`name()`, `definition()`, `execute()`)
- `AppState` in `Arc` shared state pattern
- Session resume pattern (full message history persisted in SQLite)
- `sqlite-vec` for semantic memory (under evaluation)
- Scheduler pattern (tokio::spawn + DB polling)
- SOUL.md concept (formalized and made non-optional in OpenGolem)

---

## PicoClaw

**Repository:** [sipeed/picoclaw](https://github.com/sipeed/picoclaw)
**Language:** Go
**License:** MIT
**Stars:** ~12k in first week (launched February 9, 2026)

### Philosophy

"Zero overhead, anywhere." A single self-contained Go binary — no runtime, no VM, no package manager. Targets sub-10MB RAM and sub-1-second startup. Designed to run on $10 hardware: RISC-V, ARM64, and x86. Achieved roughly 99% memory reduction versus OpenClaw. Architecture was 95% AI-generated through self-bootstrapping with human-in-the-loop refinement.

### Architecture

- Single Go binary, zero runtime dependencies
- Provider-agnostic LLM layer
- Gateway component model for channel integrations

### Channels

Telegram, Discord (via gateway components).

### What OpenGolem Takes from PicoClaw

Nothing directly — PicoClaw post-dates OpenGolem's core design decisions. But it validates the Phase 2 Rust rewrite motivation: a compiled binary with a minimal dependency graph is a structurally different security posture than a Node.js process with a large npm tree.

---

## Comparison

| Feature | OpenClaw | NanoClaw | MicroClaw | PicoClaw | OpenGolem |
|---|---|---|---|---|---|
| Language | Node.js | TypeScript | Rust | Go | TypeScript → Rust (Phase 2) |
| Agent runtime | Direct LLM calls | Claude Agent SDK in containers | Own agentic loop | Provider-agnostic | Claude Agent SDK in containers (Phase 1) |
| Credential model | None | OneCLI external proxy | env vars / config | Config | Token Broker + backends (`.env` / Bitwarden / OneCLI) |
| Channels | 22+ (WhatsApp, Telegram, Slack, Discord, Signal, iMessage, WeChat, Teams, Matrix…) | WhatsApp, Telegram, Slack, Discord, Gmail (skills-based) | Telegram, Discord, Slack, Feishu/Lark, Matrix, Web UI, WhatsApp, IRC | Telegram, Discord | **TUI, Telegram** (Teams + WhatsApp as optional skills) |
| Memory | None specified | Per-group CLAUDE.md | AGENTS.md 3-tier + SQLite | Minimal | CLAUDE.md + semantic graph (SQLite+vec) |
| Config model | Skills plugin | Fork-and-own, no config files | YAML config file | Single binary | Fork-and-own, no config files |
| Web UI | None | None | Built-in at :10961 | None | None (TUI only) |
| Container isolation | None | Yes (one per group) | Optional Docker | None | Yes (one per group) |
| Safety/Security agents | None | None | None | None | First-class infrastructure |
| Governance | None | None | SOUL.md (optional) | None | SOUL.md + PSYCHE.md + dao_score |
| Call inspection | None | None (OneCLI rate limits only) | path_guard for file tools | None | Full Call Inspector (5 checks + audit log) |
| Security modes | None | None | `high_risk_tool_user_confirmation` flag | None | Golem Guard / Supervised / Power |
