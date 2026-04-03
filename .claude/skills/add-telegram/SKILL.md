---
name: add-telegram
description: Add Telegram as a channel. Defaults to DMs only; TELEGRAM_ALLOW_GROUPS=1 enables supergroups/groups with required allowlists. Uses TELEGRAM_BOT_TOKEN, optional TELEGRAM_VALID_USERS, TELEGRAM_ALLOW_GROUPS in .env.
---

# Add Telegram Channel

This skill adds Telegram support to OpenGolem, then walks through interactive setup.

## Phase 1: Pre-flight

### Check if already applied

Check if `src/channels/telegram.ts` exists. If it does, skip to Phase 3 (Setup). The code changes are already in place.

### Ask the user

Use `AskUserQuestion` to collect configuration:

AskUserQuestion: Do you have a Telegram bot token, or do you need to create one?

If they have one, collect it now. If not, we'll create one in Phase 3.

## Phase 2: Apply Code Changes

### Ensure channel remote

```bash
git remote -v
```

If `telegram` is missing, add it:

```bash
git remote add telegram https://github.com/qwibitai/nanoclaw-telegram.git
```

### Merge the skill branch

```bash
git fetch telegram main
git merge telegram/main || {
  git checkout --theirs package-lock.json
  git add package-lock.json
  git merge --continue
}
```

This merges in:
- `src/channels/telegram.ts` (TelegramChannel class with self-registration via `registerChannel`)
- `src/channels/telegram.test.ts` (unit tests with grammy mock)
- `import './telegram.js'` appended to the channel barrel file `src/channels/index.ts`
- `grammy` npm dependency in `package.json`
- `TELEGRAM_BOT_TOKEN` in `.env.example`

If the merge reports conflicts, resolve them by reading the conflicted files and understanding the intent of both sides.

### Validate code changes

```bash
npm install
npm run build
npx vitest run src/channels/telegram.test.ts
```

All tests must pass (including the new Telegram tests) and build must be clean before proceeding.

## Phase 3: Setup

### Create Telegram Bot (if needed)

If the user doesn't have a bot token, tell them:

> I need you to create a Telegram bot:
>
> 1. Open Telegram and search for `@BotFather`
> 2. Send `/newbot` and follow prompts:
>    - Bot name: Something friendly (e.g., "Alef Assistant")
>    - Bot username: Must end with "bot" (e.g., "alef_ai_bot")
> 3. Copy the bot token (looks like `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`)

Wait for the user to provide the token.

### Configure environment

Add to `.env`:

```bash
TELEGRAM_BOT_TOKEN=<their-token>
```

Optional — only allow specific Telegram user ids (numeric `from.id`, comma-separated):

```bash
TELEGRAM_VALID_USERS=123456789,987654321
```

When set, other users cannot have messages stored; see `docs/INTERNALS.md` (Telegram section).

Channels auto-enable when their credentials are present — add `OPENGOLEM_CHANNELS=tui,telegram` (or `telegram` alone) if needed.

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

The container reads environment from `data/env/env`, not `.env` directly.

### Direct messages by default; groups are opt-in

Tell the user:

> **Default:** only **private** chats with the bot are processed. Groups and supergroups are ignored unless you set **`TELEGRAM_ALLOW_GROUPS=1`** in `.env`.
>
> **If you enable groups:** you must also set **`TELEGRAM_VALID_USERS`** (comma-separated `from.id` values) and/or per-chat rules in `~/.config/opengolem/sender-allowlist.json` for each **`tg:-100…`** JID, with `allow` **not** `*`. Otherwise group messages are not stored. Only allowlisted users can drive the agent.
>
> Get a chat id by sending **`/chatid`** in that chat, then register the returned JID (`tg:…`).

### Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.opengolem  # macOS
# Linux: systemctl --user restart opengolem
```

## Phase 4: Registration

### Get Chat ID

Tell the user:

> 1. Open the chat you want (private, or group/supergroup if `TELEGRAM_ALLOW_GROUPS=1`)
> 2. Send `/chatid` — it replies with the JID (e.g. `tg:123456789` or `tg:-100…`)

Wait for the user to provide the chat ID (`tg:…`). Private ids are positive; supergroups use negative ids.

### Register the chat

The chat ID, name, and folder name are needed. Use `npx tsx setup/index.ts --step register` with the appropriate flags.

For a main chat (responds to all messages):

```bash
npx tsx setup/index.ts --step register -- --jid "tg:<chat-id>" --name "<chat-name>" --folder "telegram_main" --trigger "@${ASSISTANT_NAME}" --channel telegram --no-trigger-required --is-main
```

For additional chats (trigger-only):

```bash
npx tsx setup/index.ts --step register -- --jid "tg:<chat-id>" --name "<chat-name>" --folder "telegram_<group-name>" --trigger "@${ASSISTANT_NAME}" --channel telegram
```

## Phase 5: Verify

### Test the connection

Tell the user:

> Send a message in the **private** chat you registered:
> - For main chat: Any message works (if `requiresTrigger` is false)
> - For non-main: include the trigger (e.g. `@Alef hello`)
>
> The bot should respond within a few seconds.

### Check logs if needed

```bash
tail -f logs/opengolem.log
```

## Troubleshooting

### Bot not responding

Check:
1. `TELEGRAM_BOT_TOKEN` is set in `.env` AND synced to `data/env/env`
2. Chat is registered in SQLite (check with: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'tg:%'"`)
3. For non-main chats: message includes trigger pattern
4. Service is running: `launchctl list | grep opengolem` (macOS) or `systemctl --user status opengolem` (Linux)

### Wrong chat type

If groups are **disabled** (default), only **private** chats work. If you enabled **`TELEGRAM_ALLOW_GROUPS`** but messages do nothing, confirm allowlists are set for that **`tg:-…`** JID (see `docs/INTERNALS.md`).

### Getting chat ID

If `/chatid` doesn't work:
- Verify token: `curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe"`
- Check bot is started: `tail -f logs/opengolem.log`

## After Setup

If running `npm run dev` while the service is active:
```bash
# macOS:
launchctl unload ~/Library/LaunchAgents/com.opengolem.plist
npm run dev
# When done testing:
launchctl load ~/Library/LaunchAgents/com.opengolem.plist
# Linux:
# systemctl --user stop opengolem
# npm run dev
# systemctl --user start opengolem
```

## Removal

To remove Telegram integration:

1. Delete `src/channels/telegram.ts` and `src/channels/telegram.test.ts`
2. Remove `import './telegram.js'` from `src/channels/index.ts`
3. Remove `TELEGRAM_BOT_TOKEN` from `.env`
4. Remove Telegram registrations from SQLite: `sqlite3 store/messages.db "DELETE FROM registered_groups WHERE jid LIKE 'tg:%'"`
5. Uninstall: `npm uninstall grammy`
6. Rebuild: `npm run build && launchctl kickstart -k gui/$(id -u)/com.opengolem` (macOS) or `npm run build && systemctl --user restart opengolem` (Linux)
