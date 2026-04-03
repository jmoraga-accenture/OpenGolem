# OpenGolem — Ecosystem Context
*Produced: April 2026*

---

## The "Claw" Ecosystem

OpenGolem is part of a 2026 wave of "Agentic AI Assistants" — minimalist, self-hosted software that allows AI models (like Claude) to live inside chat apps (WhatsApp, Telegram, Discord, Teams) with the power to execute code, manage files, and perform tasks.

The ecosystem originates with **OpenClaw**, a large, full-featured reference implementation. **NanoClaw** and **MicroClaw** were created as reactions to OpenClaw's complexity, each focusing on reducing the surface area while increasing security.

OpenGolem draws architectural DNA from both NanoClaw and MicroClaw, but is not a fork of either. It adds a security layer — the Token Broker and Call Inspector — that neither project has.

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
- Sentinel protocol: stdout wrapped in `---NANOCLAW_OUTPUT_START---` / `---NANOCLAW_OUTPUT_END---` markers containing JSON `ContainerOutput` objects
- Per-group `CLAUDE.md` memory files mounted read-only into containers
- SQLite (`better-sqlite3`) for messages, sessions, state
- Uses Anthropic Claude Agent SDK directly inside containers (not a custom agent loop)
- Agent swarms via `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1'`

### Credential Security (OneCLI)

NanoClaw's key security innovation: credentials never enter containers. The **OneCLI** external proxy intercepts HTTPS traffic from within the container and injects API keys at the proxy level, with per-agent rate limits and access policies. The container holds only a gateway URL, not a real API key.

OpenGolem internalizes this concept as the **Token Broker** — same principle (agents never hold raw credentials), but implemented natively in Rust rather than relying on an external service.

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

## Comparison

| Feature | NanoClaw | MicroClaw | OpenGolem |
|---|---|---|---|
| Language | TypeScript | Rust | Rust (Phase 2); TypeScript fork (Phase 1) |
| Agent runtime | Claude Agent SDK in containers | Own agentic loop | Claude Agent SDK in containers (Phase 1) |
| Credential model | OneCLI external proxy | env vars / config | Token Broker (internal, native) |
| Channels | Skills-based (not in core) | Built-in adapters | TUI, Teams, Telegram, WhatsApp |
| Memory | Per-group CLAUDE.md | AGENTS.md 3-tier + SQLite | CLAUDE.md + semantic graph (SQLite+vec) |
| Config model | Fork-and-own, no config files | YAML config file | Fork-and-own, no config files |
| Web UI | None | Built-in at :10961 | None (TUI only) |
| Safety/Security agents | None | None | First-class infrastructure |
| Governance | None | SOUL.md (optional) | SOUL.md + PSYCHE.md + dao_score |
| Call inspection | None (OneCLI rate limits only) | path_guard for file tools | Full Call Inspector (5 checks + audit log) |
| Security modes | None | `high_risk_tool_user_confirmation` flag | Golem Guard / Supervised / Power |
