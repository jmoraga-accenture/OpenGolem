---
skill: telegram
version: 1.0.0
type: feature
description: Telegram channel adapter — delivers and receives messages via the Telegram Bot API

token_scopes:
  skills:
    - telegram

filesystem:
  host_reads: []
  host_writes:
    - "{groupFolder}/attachments/*"
  container_mounts: []

network:
  endpoints:
    - pattern: "https://api.telegram.org/*"
      protocol: https
      direction: outbound

mcp: {}

providers:
  compatible:
    - anthropic

apply_permission: admin
---

# Telegram Channel Adapter

Feature skill that adds Telegram as a messaging channel for OpenGolem.

Connects to the Telegram Bot API to receive and send messages. Uses the Grammy
bot framework for long-poll updates. The bot token (`TELEGRAM_BOT_TOKEN`) is read
directly from the environment or `.env` file at startup and held in-process for the
connection lifetime only — it is never written to disk or exported.

## Requirements

- `TELEGRAM_BOT_TOKEN` — bot token from @BotFather
- `TELEGRAM_VALID_USERS` — mandatory comma-separated list of allowed user IDs (fail-secure)
- `TELEGRAM_ALLOW_GROUPS` — set to `1` to enable group/supergroup support

## Security

- `apply_permission: admin` — only admins may apply this skill
- All network traffic goes outbound to `https://api.telegram.org/*`
- Sender IDs are hashed (SHA-256, `tg:` prefix, 16-hex-char truncation) before delivery to the orchestrator (AC-17)
- Sender allowlist enforcement (`TELEGRAM_VALID_USERS`) is handled by the orchestrator, not this adapter
- The bot token is interpolated into Telegram file-download URLs in-memory; these URLs are never logged
- Received file attachments are saved to `{groupFolder}/attachments/` on the host filesystem
