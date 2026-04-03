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

5. startCredentialProxy()
   └─ binds an HTTP reverse proxy on port 3001 (CREDENTIAL_PROXY_PORT)
   └─ reads credentials from .env (ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN)
   └─ containers call this proxy instead of api.anthropic.com directly

6. restoreRemoteControl()
   └─ if a /remote-control session was active before restart, reconnect it

7. Register shutdown handlers (SIGTERM / SIGINT)
   └─ drains the GroupQueue, disconnects all channels, exits cleanly

8. Channel instantiation loop
   └─ for each name in the channel registry:
        factory(channelOpts) → Channel | null
        if null: skip (credentials missing or channel disabled)
        else: channel.connect()

9. startSchedulerLoop()   — fires scheduled tasks at their cron/interval
10. startIpcWatcher()     — polls data/ipc/ for JSON files written by containers
11. queue.setProcessMessagesFn(processGroupMessages)
12. recoverPendingMessages()  — re-enqueues any messages that survived a crash
13. startMessageLoop()    — the main polling loop (runs forever)
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
| Telegram | `<chat_id>@telegram` | `-1001234567890@telegram` |
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

## 5. Credential Proxy

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

The proxy re-reads `.env` on every request, so credential rotations take effect without restarting the service. On Linux it binds to the `docker0` bridge IP; on macOS/Windows it binds to loopback and containers reach it via `host.docker.internal`.

---

## 6. IPC — Agent to Host Communication

Containers write JSON files to their `/workspace/ipc/` directory (mounted from `data/ipc/<groupFolder>/`). The IPC watcher (`src/ipc.ts`) polls this directory every second and processes commands:

| Command | Effect |
|---|---|
| `send_message` | Send text to a chat JID via its channel |
| `register_group` | Register a new group (adds DB row, creates folder) |
| `create_task` / `update_task` / `delete_task` | Manage scheduled tasks |
| `sync_groups` | Force WhatsApp/Telegram group list refresh |

This allows agents to autonomously send messages, schedule work, or register new groups without the host polling the container's stdout.

---

## 7. Connecting Each Channel

### TUI (console) — default, zero config

The TUI channel is active by default (`OPENGOLEM_CHANNELS=tui`). Run:

```bash
npm run dev
```

You get an `opengolem> ` prompt. Everything you type is routed to the `tui:console` group. On first run, that group is auto-registered pointing to `groups/tui/`. The agent's reply appears directly below your prompt.

**Under systemd/headless**: TUI detects no TTY and stays silent. The process stays up so other channels can work. Add a real channel (e.g. Telegram) for headless operation.

### Telegram

**Prerequisites**: a bot token from [@BotFather](https://t.me/botfather).

1. Add to `.env`:
   ```
   TELEGRAM_BOT_TOKEN=123456789:AABBccdd...
   OPENGOLEM_CHANNELS=tui,telegram     # or just: telegram
   ```
2. Restart OpenGolem. The Telegram channel connects via Grammy long-polling.
3. Send a message to your bot. The bot's chat ID (e.g. `-1001234567890@telegram`) appears in logs.
4. Register it as a group via the main channel or IPC:
   ```json
   {"type":"register_group","jid":"-1001234567890@telegram","name":"My Group","folder":"my-group","trigger":"@Alef"}
   ```

Messages from that chat are then routed to the agent in `groups/my-group/`.

**Group vs DM**: Telegram group chats require `@BotFather → Group Privacy → disabled` (or add the bot as admin) so it can read all messages, not just commands.

### WhatsApp

WhatsApp support is a merge-able skill (`skill/add-whatsapp` branch). Once merged:

1. Run `npm run auth` — opens a QR code; scan with WhatsApp on your phone.
2. Add `OPENGOLEM_CHANNELS=tui,whatsapp` to `.env`.
3. Restart. Groups you are in appear in logs; register the ones you want.

WhatsApp uses the Baileys library and maintains its own session under `store/`.

### Microsoft Teams

Teams is a planned skill (M3/M4). The channel adapter will use the Bot Framework SDK. When available, the setup flow will be:
1. Register an Azure Bot resource and get `TEAMS_APP_ID` + `TEAMS_APP_PASSWORD`.
2. Set `OPENGOLEM_CHANNELS=tui,teams`.
3. Restart and install the bot into your Teams tenant.

---

## 8. Scheduled Tasks

The scheduler (`src/task-scheduler.ts`) polls every 60 seconds. Each task has a `schedule_type`:

| Type | Value format | Example |
|---|---|---|
| `cron` | Standard cron expression | `0 9 * * 1-5` (weekdays 9am) |
| `interval` | ISO 8601 duration | `PT15M` (every 15 minutes) |

When a task fires, it spawns a container with `isScheduledTask=true`. The agent reads its `prompt` (or runs its `script`) and the result is sent to the group's channel.

Agents create and manage tasks via IPC (`create_task`, `update_task`, `delete_task` commands).

---

## 9. Data Layout

```
OpenGolem/
├── data/
│   ├── opengolem.db         ← SQLite: messages, chats, groups, sessions, tasks
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
