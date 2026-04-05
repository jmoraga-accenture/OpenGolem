# Spec: Orchestrator (`src/index.ts`)

> Clean-room spec. Do not read the existing implementation before writing the replacement.
> Write against this document and the type definitions in `src/types.ts` only.

## Responsibility

The orchestrator is the single entry point of the host process. It owns:

- Startup sequencing (DB → channels → subsystems)
- The message poll loop (DB → GroupQueue → agent)
- Group registration (in-memory + persisted)
- Message cursor state (what has been processed per group)
- Graceful shutdown

It wires together every subsystem but contains no subsystem logic itself.

---

## Startup Sequence

Run in this order on `main()`:

1. `ensureContainerSystemRunning()` — verify container runtime, clean up orphan containers
2. `initDatabase()` — open SQLite, run migrations
3. `loadState()` — read `last_timestamp`, `last_agent_timestamp`, sessions, registered groups from DB
4. `seedTuiGroupIfNeeded()` — auto-register `tui:console` if TUI channel is enabled and not yet registered
5. `seedTelegramDmGroupsIfNeeded()` — auto-register groups for users in `TELEGRAM_VALID_USERS`
6. Start Cato inline hook
7. Start Cato scheduled audit
8. Start health server
9. Start Token Broker
10. Start credential proxy
11. Restore remote control state
12. Register SIGTERM and SIGINT shutdown handlers
13. Instantiate channels (via registry factories), connect each
14. Start scheduler loop
15. Start IPC watcher
16. Set `processGroupMessages` as the GroupQueue processor function
17. `recoverPendingMessages()` — enqueue any groups with unprocessed messages
18. Start message loop (must not return; crash = fatal + exit 1)

---

## Module-level State

These live at module scope (not exported, except test helpers):

- `lastTimestamp: string` — global poll cursor; highest timestamp of messages seen across all groups
- `lastAgentTimestamp: Record<string, string>` — per-group cursor; highest timestamp of messages handed to the agent for that group
- `sessions: Record<string, string>` — `groupFolder → sessionId` (Claude conversation continuity)
- `registeredGroups: Record<string, RegisteredGroup>` — `jid → group` (source of truth for routing)
- `channels: Channel[]` — connected channel instances
- `queue: GroupQueue` — serialises per-group agent runs
- `broker: BrokerHandle | null` — Token Broker handle for shutdown

---

## `loadState()`

Reads from DB into module-level state:
- `lastTimestamp` ← `getRouterState('last_timestamp')` or `''`
- `lastAgentTimestamp` ← parse `getRouterState('last_agent_timestamp')` JSON, or `{}` on missing/corrupt
- `sessions` ← `getAllSessions()`
- `registeredGroups` ← `getAllRegisteredGroups()`

---

## `saveState()`

Persists module-level cursors:
- `setRouterState('last_timestamp', lastTimestamp)`
- `setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp))`

---

## `getOrRecoverCursor(chatJid): string`

Returns the message cursor for a group. Recovery path:

1. If `lastAgentTimestamp[chatJid]` exists, return it.
2. Otherwise, query `getLastBotMessageTimestamp(chatJid, ASSISTANT_NAME)`.
3. If found, store it in `lastAgentTimestamp[chatJid]`, call `saveState()`, return it.
4. If not found, return `''`.

Purpose: survive restarts where `lastAgentTimestamp` was lost but message history is intact.

---

## `registerGroup(jid, group)`

1. Validate `group.folder` via `resolveGroupFolderPath` — reject with `logger.warn` if invalid.
2. Store in `registeredGroups[jid]` and call `setRegisteredGroup(jid, group)`.
3. Create `<groupDir>/logs/` directory.
4. Copy CLAUDE.md template into `<groupDir>/CLAUDE.md` if not already present:
   - Main group uses `groups/main/CLAUDE.md` template; all others use `groups/global/CLAUDE.md`.
   - If `ASSISTANT_NAME !== 'Alef'`, replace `# Alef` and `You are Alef` strings.

---

## `seedTuiGroupIfNeeded()`

Only runs if:
- TUI channel is enabled (`isChannelEnabled('tui')`)
- `registeredGroups[TUI_CONSOLE_JID]` does not exist

If both conditions hold, call `registerGroup(TUI_CONSOLE_JID, { name: 'Console', folder: 'tui', trigger: DEFAULT_TRIGGER, requiresTrigger: false, isMain: true, ... })`.

---

## `seedTelegramDmGroupsIfNeeded()`

Delegates entirely to `seedTelegramDmGroups(...)` with deps injected. No logic here beyond wiring.

---

## `getAvailableGroups(): AvailableGroup[]`

Returns all chats from DB that:
- Are not the `__group_sync__` sentinel
- Have `is_group = true`

Each entry: `{ jid, name, lastActivity, isRegistered: jid in registeredGroups }`.

---

## Message Poll Loop (`startMessageLoop`)

Guards against duplicate start with a module-level flag. Runs forever (while true).

Each iteration:

1. Query `getNewMessages(jids, lastTimestamp, ASSISTANT_NAME)` for all registered group JIDs.
2. If messages found:
   a. Advance `lastTimestamp` to `newTimestamp` and `saveState()`.
   b. Group messages by `chat_jid`.
   c. For each group:
      - Skip if group not in `registeredGroups` or no channel owns the JID.
      - Apply Telegram sender allowlist filtering to the new batch.
      - If Telegram group and all messages filtered: advance `lastAgentTimestamp` for this JID, skip.
      - For non-main groups with `requiresTrigger`, check if any filtered message contains the group trigger and is from an allowed sender — skip if not.
      - Fetch full pending batch via `getMessagesSince(chatJid, getOrRecoverCursor(chatJid), ...)`.
      - Apply allowlist filter to full pending batch too; handle the all-filtered edge case same as above.
      - If an active container exists for this group (queue has one): pipe the formatted messages to its stdin, advance `lastAgentTimestamp`, `saveState()`, set typing indicator. Done.
      - Otherwise: enqueue the group for a new container run.
3. Sleep `POLL_INTERVAL` ms, repeat.

---

## `processGroupMessages(chatJid): Promise<boolean>`

Called by GroupQueue when it is a group's turn. Returns `true` on success or skip, `false` on retryable error.

Steps:

1. Look up group and channel; return `true` (skip) if either missing.
2. Fetch messages since `getOrRecoverCursor(chatJid)` up to `MAX_MESSAGES_PER_PROMPT`.
3. Return `true` if no messages.
4. Apply Telegram sender allowlist. If all filtered: advance cursor to end of batch, `saveState()`, return `true`.
5. For non-main groups with `requiresTrigger`: check trigger presence; return `true` if absent.
6. Format filtered messages into prompt string.
7. Advance `lastAgentTimestamp[chatJid]` to the last message in the full (pre-filter) batch and `saveState()`. Record `previousCursor` for rollback.
8. **Cato inline check** — call `catoCheck({ type: 'check_action', groupFolder, prompt })`.
   - If blocked: notify user via channel, return `true` (cursor already advanced, no retry).
9. Set typing indicator.
10. Call `runAgent(group, prompt, chatJid, streamingCallback)`.
    - Streaming callback: strip `<internal>` blocks; detect `[FLAG]` prefix and call `logFlagEvent`; send text to channel.
    - Track `outputSentToUser` and `hadError` flags from callbacks.
11. Clear typing indicator and idle timer.
12. On error:
    - If `outputSentToUser`: log warning, return `true` (no rollback — response was delivered).
    - Else: roll back `lastAgentTimestamp[chatJid]` to `previousCursor`, `saveState()`, return `false`.
13. Return `true`.

---

## `runAgent(group, prompt, chatJid, onOutput?): Promise<'success' | 'error'>`

Prepares and dispatches to `runContainerAgent`. Steps:

1. Write tasks snapshot for the group via `writeTasksSnapshot`.
2. Write available groups snapshot via `writeGroupsSnapshot` (main sees all; others see nothing).
3. Wrap `onOutput` to intercept `newSessionId` and persist it via `setSession`.
4. Call `runContainerAgent(group, { prompt, sessionId, groupFolder, chatJid, isMain, assistantName }, onProcess, wrappedOnOutput)`.
5. Persist `newSessionId` from the final output if present.
6. On `status: 'error'`: detect stale session signal via error message pattern, clear `sessions[group.folder]` and `deleteSession` if detected. Return `'error'`.
7. On success: return `'success'`.

**Stale session pattern:** `/no conversation found|ENOENT.*\.jsonl|session.*not found/i`

---

## `recoverPendingMessages()`

On startup, for each registered group: call `getMessagesSince(chatJid, getOrRecoverCursor(chatJid), ...)`. If any messages pending, call `queue.enqueueMessageCheck(chatJid)`.

---

## `handleRemoteControl(command, chatJid, msg)`

Only executes for main group. Commands: `/remote-control` (start) and `/remote-control-end` (stop). Result URL or error message sent to the channel.

---

## Channel Callbacks (`channelOpts`)

Shared callback object passed to all channel factories:

### `onMessage(chatJid, msg)`

1. If Telegram group/supergroup and `TELEGRAM_ALLOW_GROUPS` enabled: verify the chat has an explicit allowlist (not `*`). Drop message silently if not.
2. If `/new` or `/reset`: clear session for the chat's group, send confirmation, return.
3. If `/remote-control` or `/remote-control-end`:
   - Telegram: verify sender is in allowlist. Drop if not.
   - Dispatch `handleRemoteControl(...)`.
   - Return (do not store).
4. If message is not from self, not a bot message, and group is registered: apply sender allowlist drop mode — drop if sender not allowed.
5. Call `storeMessage(msg)`.

### `onChatMetadata(chatJid, timestamp, name?, channel?, isGroup?)`

Call `storeChatMetadata(...)` directly.

### `registeredGroups()`

Return the current `registeredGroups` map.

### `onAutoRegisterGroup(jid, name, isGroup)`

Auto-register a Telegram chat on first contact. Skip if already registered (race guard).

Folder naming from JID:
- `tg:12345` → folder `tg-12345`
- `tg:-1001234567` → folder `tg-g-1001234567` (strip leading `-`, prefix `g-`)

`requiresTrigger` = `isGroup` (groups require trigger, DMs do not). `isMain = false`.

---

## Graceful Shutdown

On SIGTERM or SIGINT:
1. Stop Cato scheduled audit
2. Stop Cato inline hook
3. Stop health server
4. `queue.shutdown(10000)` (10s timeout)
5. Disconnect all channels
6. Close broker
7. `process.exit(0)`

---

## Exports

- `getAvailableGroups()` — used by IPC watcher
- `_setRegisteredGroups(groups)` — test helper only
- Re-export `escapeXml`, `formatMessages` from `src/router.ts` for backwards compatibility during refactor

---

## Entry Guard

Only call `main()` when the module is executed directly (`process.argv[1]` matches `import.meta.url`). Tests import the module without triggering startup.

---

## Security Invariants

- Credentials are never passed to agents; only proxied via the credential proxy.
- `.env` is shadowed to `/dev/null` in container mounts.
- Group folders are validated before use.
- The Cato inline check runs before every `runContainerAgent` call.
- Remote control is restricted to the main group.
- Telegram sender allowlist is enforced at both the new-message path and the processing path.
