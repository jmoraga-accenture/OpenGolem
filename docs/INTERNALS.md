# OpenGolem — Technical Internals
*Last updated: 2026-04-03*

This document explains what actually happens when OpenGolem runs: how the process starts, how channels plug in, how messages travel from a user to an agent and back, and what you need to do to connect each channel type.

---

## 1. Startup Sequence

Running `npm run dev` (or `node dist/index.js` in production) executes `src/index.ts → main()` in this order:

```
1. ensureContainerSystemRunning()
   └─ confirms Docker/Podman is running, kills orphaned containers

2. initDatabase()
   └─ opens SQLite at data/opengolem.db
   └─ runs any pending schema migrations

3. loadState()
   └─ reads last_timestamp, last_agent_timestamp, sessions, registered groups from DB

4. seedTuiGroupIfNeeded()
   └─ if OPENGOLEM_CHANNELS includes "tui" and tui:console is not yet registered,
      auto-registers groups/tui/ as the main group — zero setup for first run

5. startBroker()
   └─ starts the Token Broker (Unix socket at data/broker.sock)
   └─ generates an in-memory HMAC signing key (never persisted)
   └─ ready to ISSUE / VERIFY / REVOKE scoped tokens for containers

6. startCredentialProxy()
   └─ binds an HTTP reverse proxy on port 3001 (CREDENTIAL_PROXY_PORT)
   └─ credential backend resolves on every request (env / bitwarden / onecli)
   └─ containers call this proxy instead of api.anthropic.com directly

7. restoreRemoteControl()
   └─ if a /remote-control session was active before restart, reconnect it

8. Register shutdown handlers (SIGTERM / SIGINT)
   └─ drains the GroupQueue, disconnects all channels, closes broker, exits cleanly

9. Channel instantiation loop
   └─ for each name in the channel registry:
        factory(channelOpts) → Channel | null
        if null: skip (credentials missing or channel disabled)
        else: channel.connect()

10. startSchedulerLoop()   — fires scheduled tasks at their cron/interval
11. startIpcWatcher()      — polls data/ipc/ for JSON files written by containers
12. queue.setProcessMessagesFn(processGroupMessages)
13. recoverPendingMessages()  — re-enqueues any messages that survived a crash
14. startMessageLoop()    — the main polling loop (runs forever)
```

The process never exits after step 13 unless it receives a signal or `startMessageLoop` throws.

---

## 2. The Message Loop

`startMessageLoop()` polls the database every 2 seconds (`POLL_INTERVAL`):

```
while (true) {
  messages = getNewMessages(registeredJIDs, lastTimestamp)

  for each group with new messages:
    if group needs a trigger (@Alef) and no trigger present → skip
    if a container is already running for this group:
      pipe the formatted message to its stdin → agent processes it live
    else:
      enqueue a new container run via GroupQueue

  sleep(2000ms)
}
```

Key detail: messages accumulate in the DB regardless of whether a container is running. When a container eventually starts, it gets a batch of all messages since the last agent reply — not just the one that triggered it.

---

## 3. Channel Architecture

### How channels register

Every channel is a TypeScript module that calls `registerChannel(name, factory)` when it is imported. The barrel file `src/channels/index.ts` imports all channel modules, which triggers their self-registration side-effect:

```
src/channels/index.ts
├── import './tui.js'      → registers 'tui' factory
└── import './telegram.js' → registers 'telegram' factory
```

The orchestrator (`src/index.ts`) imports this barrel, then iterates `getRegisteredChannelNames()` and calls each factory.

### What a factory does

```typescript
registerChannel('telegram', (opts: ChannelOpts) => {
  if (!isChannelEnabled('telegram')) return null;   // check OPENGOLEM_CHANNELS
  const token = process.env.TELEGRAM_BOT_TOKEN || '';
  if (!token) { logger.warn(...); return null; }    // credential missing → skip
  return new TelegramChannel(token, opts);
});
```

A factory returns `null` when a channel should not start. The orchestrator skips `null` returns silently. This means unused channels add zero overhead.

### The Channel interface

```typescript
interface Channel {
  name: string;
  connect(): Promise<void>;        // called once at startup
  disconnect(): Promise<void>;     // called on shutdown
  isConnected(): boolean;
  ownsJid(jid: string): boolean;  // "does this channel own this chat ID?"
  sendMessage(jid: string, text: string): Promise<void>;
  setTyping?(jid: string, active: boolean): Promise<void>;  // optional
  syncGroups?(force: boolean): Promise<void>;               // optional
}
```

### Channel callbacks (ChannelOpts)

When a channel receives an inbound message, it calls:

```typescript
opts.onChatMetadata(chatJid, timestamp, name, channelName, isGroup)
  // Must be called BEFORE onMessage — creates the chats row (FK requirement)

opts.onMessage(chatJid, {
  id, chat_jid, sender, sender_name, content, timestamp, is_from_me
})
  // Stores the message in SQLite; the poll loop picks it up within 2s
```

### JID conventions

Each channel defines its own JID namespace:

| Channel | JID format | Example |
|---|---|---|
| TUI | `tui:<name>` | `tui:console` |
| Telegram | `tg:<numeric_chat_id>` | `tg:123456789` (private chat id = user id) |
| WhatsApp | `<phone>@s.whatsapp.net` or `<id>@g.us` | `447700900000@s.whatsapp.net` |

`channel.ownsJid(jid)` returns true if the JID belongs to that channel. The router uses this to find the right channel when sending outbound messages.

---

## 4. Container Execution

When a group has messages to process, `runContainerAgent()` spawns a container:

```
docker run \
  --rm \
  --network=bridge \
  -e ANTHROPIC_BASE_URL=http://host.docker.internal:3001  ← credential proxy
  -e ANTHROPIC_API_KEY=proxied                            ← placeholder (proxy replaces)
  -e OPENGOLEM_BROKER_TOKEN=<hmac-token>                  ← scoped identity token (M2)
  -v groups/tui:/workspace/group                          ← group files (r/w)
  -v data/ipc/tui:/workspace/ipc                          ← IPC directory (r/w)
  -v groups/main:/workspace/project:ro                    ← project root (r/o, main only)
  opengolem-agent:latest \
  '{"prompt":"...", "sessionId":"...", "groupFolder":"tui", ...}'
```

The container runs Claude Code (the agent runner) inside a minimal Linux image. Claude Code:
1. Reads the JSON prompt from `argv[1]`
2. Loads any existing session from `/workspace/group/.claude/`
3. Executes the agent with the prompt
4. Writes output to stdout using the sentinel protocol

### Sentinel Protocol

Container output is framed so the host can distinguish agent output from stderr noise:

```
---OPENGOLEM_OUTPUT_START---
{"status":"success","result":"Here is my response","newSessionId":"abc-123"}
---OPENGOLEM_OUTPUT_END---
```

`src/container-runner.ts` scans stdout for these markers. Everything outside the markers is discarded (or logged at debug level). The host parses the JSON and calls the `onOutput` callback, which sends the `result` text back to the originating channel.

### Session continuity

Each group has a session ID stored in SQLite (`sessions` table). On each run:
- If a session ID exists, it is passed to the container → Claude Code resumes the conversation
- If the container exits with a "no conversation found" error, the stale session is cleared and the next run starts fresh

### Container lifecycle (GroupQueue)

The `GroupQueue` manages one container per group:
- **Active**: container is running; new messages are piped to its stdin
- **Idle**: container has been idle for `IDLE_TIMEOUT` (30 min default); its stdin is closed; it exits gracefully, saving its session
- **Dead**: container exited; next message triggers a new container

This means a long conversation in Telegram keeps the same container alive, preserving full in-process context without re-loading from disk on each message.

---

## 5. Token Broker (M2)

The Token Broker (`src/broker/`) issues HMAC-SHA256 signed tokens to containers, establishing the foundation for per-container credential mediation and budget enforcement.

```
Host (broker.sock)           Container
──────────────────           ─────────
ISSUE { container_id,  ◄──  (at spawn time, from host)
        skills, budget }
  → { token }          ──►  OPENGOLEM_BROKER_TOKEN env var

VERIFY { token }        ◄── (future: container-to-host verification)
REVOKE { container_id } ◄── (on container exit, from host)
```

The signing key is generated fresh each startup and never written to disk. Tokens include `jti` (unique ID), `container_id`, `skills`, `scopes`, `budget`, `iat`, and `exp`. Revocation is in-memory only — a restart clears the revocation set (safe, since the signing key also changes).

Three credential backends are selectable via `OPENGOLEM_CREDENTIAL_BACKEND`:

| Backend | Description | Required env vars |
|---|---|---|
| `env` (default) | Reads `.env` on every request | `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` |
| `bitwarden` | Fetches from Bitwarden vault via `bw` CLI | `BW_SESSION`, `BW_ITEM_NAME`, `BW_FIELD_NAME` |
| `onecli` | HTTP POST to OneCLI Agent Vault gateway | `ONECLI_GATEWAY_URL`, `ONECLI_GATEWAY_TOKEN` |

---

## 6. Credential Proxy

Containers never hold real API credentials. The credential proxy (`src/credential-proxy.ts`) runs on the host:

```
Container                         Host proxy (port 3001)         Anthropic
──────────                        ─────────────────────          ────────
ANTHROPIC_BASE_URL=               Strip placeholder headers
  http://host.docker.internal:3001 ──────────────────────────────────────►
ANTHROPIC_API_KEY=proxied         Inject real x-api-key or       api.anthropic.com
                                  Authorization: Bearer ...
                              ◄───────────────────────────────────────────
```

The proxy calls `credentialBackend.resolve()` on every request (async), so credential rotations take effect without restarting the service. On Linux it binds to the `docker0` bridge IP; on macOS/Windows it binds to loopback and containers reach it via `host.docker.internal`.

---

## 7. Call Inspector (M3)

Every outbound Anthropic API request passes through the Call Inspector before reaching the upstream. The credential proxy buffers the request body, runs five checks in order, and either forwards or returns 403.

```
Container  →  Credential Proxy  →  Call Inspector  →  Anthropic API
                                         ↓
                                      audit.db  (append-only)
```

**Five checks (run in order):**

| # | Check | Phase 1 status |
|---|---|---|
| 1 | `checkSkillWhitelist` | Advisory — no container token in HTTP headers yet |
| 2 | `checkMemoryScope` | Advisory — same reason |
| 3 | `checkPromptInjection` | Active — scans body against injection signatures |
| 4 | `checkCallRate` | Active — sliding 60-second window, default 60 req/min |
| 5 | `checkEndpointScope` | Active — path must be a valid Anthropic API prefix |

**Security modes** (`OPENGOLEM_SECURITY_MODE`):

| Mode | On check failure |
|---|---|
| `golem_guard` (default) | Hard block (403), logged |
| `supervised` | Soft block — logged, forwarded in Phase 1; interactive pause in Phase 2 |
| `power` | Only `checkPromptInjection` hard-blocks; others advisory |

**Audit log** (`data/audit.db`): every request (pass or block) gets one row. `DELETE` is blocked at the SQLite trigger level — the table is append-only. The payload is never stored; only its SHA-256 hash is recorded.

---

## 8. IPC — Agent to Host Communication

Containers write JSON files to their `/workspace/ipc/` directory (mounted from `data/ipc/<groupFolder>/`). The IPC watcher (`src/ipc.ts`) polls this directory every second and processes commands:

| Command | Effect |
|---|---|
| `send_message` | Send text to a chat JID via its channel |
| `register_group` | Register a new group (adds DB row, creates folder) |
| `create_task` / `update_task` / `delete_task` | Manage scheduled tasks |
| `sync_groups` | Force WhatsApp-oriented group / metadata refresh |

This allows agents to autonomously send messages, schedule work, or register new groups without the host polling the container's stdout.

---

## 9. Connecting Each Channel

### TUI (console) — default, zero config

The TUI channel is active by default (`OPENGOLEM_CHANNELS=tui`). Run:

```bash
npm run dev
```

You get an `opengolem> ` prompt. Everything you type is routed to the `tui:console` group. On first run, that group is auto-registered pointing to `groups/tui/`. The agent's reply appears directly below your prompt.

**Logging**: Host logs go to **stderr** so they do not interleave with the readline prompt on stdout. When only the TUI channel is enabled and `LOG_LEVEL` is unset, the default level is **warn** (set `LOG_LEVEL=info` for verbose startup).

**Under systemd/headless**: TUI detects no TTY and stays silent. The process stays up so other channels can work. Add a real channel (e.g. Telegram) for headless operation.

### Telegram

**Default: direct messages only.** Without `TELEGRAM_ALLOW_GROUPS`, the adapter ignores groups/supergroups and only sends to **positive** `tg:` ids (private chats).

**Groups / supergroups (e.g. agent swarms):** set `TELEGRAM_ALLOW_GROUPS=1` (or `true` / `yes`). Then:

- Inbound and outbound work for **negative** `tg:` ids (`tg:-100…`).
- Each registered **supergroup/group** must have an **explicit** allowlist: non-empty `TELEGRAM_VALID_USERS` **or** a per-chat entry in `~/.config/opengolem/sender-allowlist.json` whose `allow` is **not** `*` for that JID. Otherwise messages from that chat are not stored.
- Users **not** on the allowlist never reach the agent (`TELEGRAM_VALID_USERS` drop mode, `filterMessagesForTelegramAllowlist`, and trigger checks still apply).

**Prerequisites**: a bot token from [@BotFather](https://t.me/botfather).

1. Add to `.env`:
   ```
   TELEGRAM_BOT_TOKEN=123456789:AABBccdd...
   OPENGOLEM_CHANNELS=tui,telegram     # or just: telegram
   ```
   Optional — comma-separated Telegram user ids (`from.id`); when set, only those users’ messages are stored on `tg:` chats (others dropped at ingest):
   ```
   TELEGRAM_VALID_USERS=123456789,987654321
   ```
   For groups, also set `TELEGRAM_ALLOW_GROUPS=1` and ensure explicit allowlist rules as above.

2. Restart OpenGolem. The Telegram channel connects via Grammy long-polling.

3. Send `/chatid` in the chat you want (private, or group if groups are enabled) to obtain the JID for registration.

4. Register via setup or IPC, for example (private):
   ```json
   {"type":"register_group","jid":"tg:123456789","name":"Alice DM","folder":"telegram_main","trigger":"@Alef"}
   ```
   Or supergroup (when `TELEGRAM_ALLOW_GROUPS` is on and allowlist configured):
   ```json
   {"type":"register_group","jid":"tg:-1001234567890","name":"Team","folder":"telegram_team","trigger":"@Alef"}
   ```

**Group privacy:** for the main bot to see all messages in a group (not only commands), disable **Group Privacy** for that bot in @BotFather if you use groups.

**`/remote-control` in Telegram** is restricted to allowlisted senders when `TELEGRAM_VALID_USERS` or sender-allowlist rules apply.

**Telegram Agent Swarm (bot pool):** see `.claude/skills/add-telegram-swarm` — IPC routes some sends through extra bot tokens. Use with `TELEGRAM_ALLOW_GROUPS=1`, allowlists, and pool bots added to the same group; read the skill’s **Policy** section.

### WhatsApp

WhatsApp support is a merge-able skill (`skill/add-whatsapp` branch). Once merged:

1. Run `npm run auth` — opens a QR code; scan with WhatsApp on your phone.
2. Add `OPENGOLEM_CHANNELS=tui,whatsapp` to `.env`.
3. Restart. Groups you are in appear in logs; register the ones you want.

WhatsApp uses the Baileys library and maintains its own session under `store/`.

### Microsoft Teams

Teams is not a packaged skill. The Azure Bot / webhook model is incompatible with OpenGolem's self-hosted zero-infrastructure design. Two bridging approaches are documented in `docs/PLAN.md` (the Teams note in M4) for anyone who needs it: a **Power Automate flow** (recommended — no public endpoint required) or **Microsoft Graph API polling** (AD app registration, no Bot Service). Neither is built-in; both are documented starting points for contributors.

---

## 10. Scheduled Tasks

The scheduler (`src/task-scheduler.ts`) polls every 60 seconds. Each task has a `schedule_type`:

| Type | Value format | Example |
|---|---|---|
| `cron` | Standard cron expression | `0 9 * * 1-5` (weekdays 9am) |
| `interval` | ISO 8601 duration | `PT15M` (every 15 minutes) |

When a task fires, it spawns a container with `isScheduledTask=true`. The agent reads its `prompt` (or runs its `script`) and the result is sent to the group's channel.

Agents create and manage tasks via IPC (`create_task`, `update_task`, `delete_task` commands).

---

## 11. Data Layout

```
OpenGolem/
├── data/
│   ├── opengolem.db         ← SQLite: messages, chats, groups, sessions, tasks
│   ├── broker.sock          ← Token Broker Unix socket (deleted on clean shutdown)
│   ├── audit.db             ← Call Inspector append-only audit log (never deleted)
│   └── ipc/
│       └── <groupFolder>/   ← JSON files from containers (processed and deleted)
├── groups/
│   ├── main/
│   │   └── CLAUDE.md        ← Main group agent identity and instructions
│   ├── tui/
│   │   ├── CLAUDE.md        ← TUI group agent identity
│   │   └── logs/
│   └── <name>/              ← One folder per registered group
└── store/                   ← WhatsApp session files (when WhatsApp skill is active)
```

Each group folder is the agent's writable workspace. The agent can create files, maintain notes, and access its own `CLAUDE.md` identity file. It cannot read other groups' folders (not mounted) or the host's `.env` (shadowed by an empty bind mount).
