# OpenGolem

Security-first personal AI assistant: self-hosted, auditable, and designed so agents run in isolated containers with mediated credentials — not raw API keys in the sandbox.

The host orchestrator is TypeScript/Node.js. Agents run the Claude Agent SDK inside Linux containers. Every outbound Anthropic API call passes through the Token Broker and Call Inspector before it reaches the network. Phase 2 is a clean-room TypeScript rewrite from first principles; a Rust decision point is deferred until after v2 stabilises. See [docs/SPECS.md](docs/SPECS.md) for the full architecture and [docs/PLAN.md](docs/PLAN.md) for milestone status.

## What you get today (M1–M4)

- **TUI by default** — `npm run dev` gives you an `opengolem> ` prompt; zero config, no cloud account needed to start
- **Per-group isolation** — each group gets its own filesystem, `CLAUDE.md` memory, and container; groups cannot read each other's files
- **Token Broker (M2)** — HMAC-SHA256 scoped tokens issued per container at spawn; revoked on exit; credentials never leave the host process. Three selectable credential backends: `.env` (dev), Bitwarden, OneCLI Agent Vault
- **Call Inspector (M3)** — five checks on every outbound API call (prompt injection, endpoint scope, call rate, skill whitelist, memory scope); append-only audit log in `data/audit.db`; three security modes: `golem_guard` (default), `supervised`, `power`
- **Telegram** — optional; **DMs by default**; set `TELEGRAM_ALLOW_GROUPS=1` for supergroups/groups (requires explicit allowlist per `tg:-…` chat). `TELEGRAM_VALID_USERS` and `sender-allowlist.json`; `TELEGRAM_BOT_TOKEN` in `.env`
- **Scheduled tasks** — cron and interval tasks created by agents via IPC

## Requirements

- **Node.js** ≥ 20
- **Docker** (or compatible runtime) for agent containers
- Anthropic credentials in `.env` — `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`

## Quick start

```bash
cp .env.example .env          # then add your Anthropic credential
npm install
npm run build
./container/build.sh          # build the agent container image (once)
npm test                      # 445 tests, all green
npm run dev                   # opengolem> prompt
```

Type anything at the prompt. Alef (the default assistant name) responds via a container running the Claude Agent SDK.

## Configuration reference

All settings are optional environment variables; copy `.env.example` to `.env` and uncomment what you need.

| Variable | Default | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Anthropic API key |
| `CLAUDE_CODE_OAUTH_TOKEN` | — | OAuth token from `claude setup-token` |
| `OPENGOLEM_CHANNELS` | `tui` | Comma-separated active channels (`tui`, `telegram`) |
| `OPENGOLEM_CREDENTIAL_BACKEND` | `env` | Credential backend: `env` \| `bitwarden` \| `onecli` |
| `OPENGOLEM_SECURITY_MODE` | `golem_guard` | Inspector mode: `golem_guard` \| `supervised` \| `power` |
| `INSPECTOR_RATE_LIMIT` | `60` | Max API calls per minute across all containers |
| `TELEGRAM_BOT_TOKEN` | — | Bot token from [@BotFather](https://t.me/botfather) |
| `TELEGRAM_ALLOW_GROUPS` | off | Set `1` / `true` / `yes` to allow supergroups/groups + negative `tg:` ids (needs explicit allowlist per group JID) |
| `TELEGRAM_VALID_USERS` | — | Comma-separated Telegram user IDs; unset = no env gate |
| `CREDENTIAL_PROXY_PORT` | `3001` | Port the credential proxy binds on |

For Bitwarden backend: `BW_SESSION`, `BW_ITEM_NAME`, `BW_FIELD_NAME`.
For OneCLI backend: `ONECLI_GATEWAY_URL`, `ONECLI_GATEWAY_TOKEN`.

## Channel notes

**TUI (default):** Active when `OPENGOLEM_CHANNELS` includes `tui` (the default). Under systemd/headless, TUI detects no TTY and stays silent; add Telegram for headless use. Host logs go to stderr so they don't interleave with the readline prompt.

**Telegram:** Defaults to **direct messages only**. For **groups/supergroups** (e.g. agent swarms), set `TELEGRAM_ALLOW_GROUPS=1` and configure `TELEGRAM_VALID_USERS` and/or `~/.config/opengolem/sender-allowlist.json` so each `tg:-100…` chat has an explicit `allow` list (not `*`). Non-allowlisted users are not stored and the agent does not respond to them. Send `/chatid` in the target chat for the JID to register.

**WhatsApp:** Merge-able skill (`skill/add-whatsapp` branch). Requires phone pairing.

**Microsoft Teams:** Not a packaged skill — the Azure Bot / webhook model is incompatible with self-hosted zero-infra deployment. Two bridging approaches (Power Automate flow, Graph API polling) are documented in [docs/PLAN.md](docs/PLAN.md).

## Shared context (`data/extra/`)

Drop files into `data/extra/` on the host and every agent container will find them at `/workspace/extra` (read-only). Use it for shared reference documents, instructions, or datasets that all groups should be able to access. Containers cannot write to this directory — the host owns its contents.

```bash
echo "Company: Acme Corp" > data/extra/context.md
# Agent can now: cat /workspace/extra/context.md
```

## Security model

Agents never hold real API credentials. The flow for every API call:

```
Container  →  Credential Proxy  →  Call Inspector  →  Anthropic API
                                         ↓
                                   audit.db (append-only)
```

- Credentials are resolved per-request by the selected backend and injected by the proxy; they are never written to disk or passed to containers
- Each container receives an HMAC-signed broker token (`OPENGOLEM_BROKER_TOKEN`) at spawn; it is revoked when the container exits
- The Call Inspector blocks prompt injection attempts, out-of-scope endpoints, and excessive call rates before they reach the network
- `.env` is bind-mounted as `/dev/null` inside every container; agents cannot read host secrets

See [docs/INTERNALS.md](docs/INTERNALS.md) for the full architecture walkthrough.

## Documentation

| Document | Purpose |
|---|---|
| [docs/INTERNALS.md](docs/INTERNALS.md) | Startup sequence, message flow, security layers, channel setup |
| [docs/SPECS.md](docs/SPECS.md) | Architecture and security model specification (v0.4) |
| [docs/PLAN.md](docs/PLAN.md) | Milestone status and roadmap |
| [docs/SECURITY_AUDIT.md](docs/SECURITY_AUDIT.md) | Security audit findings and fixes |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Architecture decision records |
| [CLAUDE.md](CLAUDE.md) | Developer quick reference for this repo |

## License

MIT — see [LICENSE](LICENSE).

## Credits

OpenGolem incorporates **NanoClaw** code as its TypeScript baseline and reflects **MicroClaw**-style concepts in its security and isolation goals. Upstream lineage is summarised in [docs/PLAN.md](docs/PLAN.md).

**(c) Jim Moraga <jim.moraga@pip.global>**

---

*Last updated: 3 April 2026 — M5 complete (SOUL.md, assertiveness dial, [FLAG] audit); 451 tests green.*
