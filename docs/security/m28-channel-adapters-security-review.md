# M28 Channel Adapter Security Review

Date: 2026-04-07
Reviewer: Automated (M28)
Status: PASS

---

## Summary

Both adapters are largely well-structured. No hardcoded credentials, business logic is clean, and sender-ID hashing is correctly implemented in the Telegram adapter. Two findings require attention before v0.3: `INBOUND_RATE_LIMIT_PER_SENDER` and `INBOUND_QUEUE_MAX_DEPTH` are declared in bootstrap but are never consumed anywhere in the codebase (dead config, no enforcement), and the `telegram.intent.md` intent file is missing required fields mandated by the channel-adapters-spec (the `skill`, `version`, `description`, and `filesystem` blocks). One additional low-severity observation: the bot token is interpolated into a file-download URL string in-memory but is never logged or written to disk, which is acceptable under the current spec but warrants a note.

---

## TUI Adapter

### Invariant Results

| Invariant | Status | Notes |
|-----------|--------|-------|
| No hardcoded credentials | PASS | No credentials exist for the TUI adapter. It reads only `ASSISTANT_NAME` from config. No API keys or tokens appear anywhere in `src/channels/tui.ts`. |
| Credential lifetime | PASS | N/A — TUI has no credentials. No disk writes of any config values occur. |
| No business logic | PASS | Adapter normalizes lines to `InboundMessage` and calls `opts.onMessage`. No routing decisions, no skill invocations, no content modification for business reasons. The `shouldPrepend` trigger normalization in Telegram has no analogue here — TUI passes content as-is. |
| Input sanitization | PASS | The TUI sender ID is hardcoded as the constant `'tui-local'` (line 89) and the group JID as `TUI_CONSOLE_JID = 'tui:console'` (line 19). Neither is user-supplied, so there is no path traversal or log injection surface. |
| Rate limiting | FAIL | `INBOUND_RATE_LIMIT_PER_SENDER` is declared in `src/bootstrap.ts` line 37 and documented in `CLAUDE.md` and `.env` but is never read or enforced in any source file. The TUI adapter (and the orchestrator's inbound path) impose no per-sender rate limit. This is a missing enforcement gap — the config key is a no-op. |

---

## Telegram Adapter

### Invariant Results

| Invariant | Status | Notes |
|-----------|--------|-------|
| No hardcoded credentials | PASS | Token sourced exclusively via `process.env.TELEGRAM_BOT_TOKEN` or `readEnvFile(['TELEGRAM_BOT_TOKEN'])`. No string literals resembling a token appear in the source. See `src/channels/telegram.ts` lines 258–259 (factory) and lines 708–710 (`telegramChannelFactory`). |
| Credential lifetime | WARN | The bot token is held as `this.botToken` (line 173, class field) for the connection lifetime — correct per spec invariant 4. It is never written to disk. However, at line 228 the token is interpolated into a `fileUrl` string for Telegram file downloads: `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`. The URL itself is not logged (the adjacent `logger.warn` at line 231 logs only `{ fileId, status }` and the `logger.info` at line 241 logs only `{ fileId, dest }`). The token is not exposed to logs or disk. Status is WARN rather than FAIL: the token-in-URL pattern is the Telegram Bot API's documented mechanism for file downloads and is unavoidable; the absence of URL logging confirms no credential leak. Recommend adding a code comment at line 228 to document this intentional pattern so future reviewers do not miss it. |
| No business logic | PASS | Adapter normalizes inbound events to `InboundMessage` and calls `opts.onMessage`. Routing, allowlist gating, and trigger evaluation are all delegated to the orchestrator. The `shouldPrependAssistantTriggerForBotMention` function (lines 62–103) normalizes `@bot` mentions so the orchestrator's trigger pattern can match — this is inbound normalization, not routing logic, and is consistent with spec §Responsibilities item 2. |
| `.intent.md` accuracy | FAIL | `src/channels/telegram.intent.md` is missing multiple fields required by `docs/specs/channel-adapters-spec.md` §Skill Declaration. Specifically: `skill`, `version`, `description`, `filesystem` (with `host_reads`, `host_writes`, `container_mounts`), and `mcp` blocks are absent. The spec template (channel-adapters-spec.md lines 66–95) requires all of these. What is present (`type: feature`, `apply_permission: admin`, `network.endpoints`, `providers.compatible`, `token_scopes.skills`) is accurate and correct — the declared endpoint `https://api.telegram.org/*` matches all outbound calls in code (`Bot` polling, `sendMessage`, `getFile`, file fetch). The direction declaration (`outbound`) is accurate — the adapter uses long-poll (Grammy), presenting no inbound TCP listener per invariant 11. The security note claiming "Credentials are mediated via the Token Broker; the adapter never handles raw API keys directly" is inaccurate: the adapter holds `TELEGRAM_BOT_TOKEN` directly (not via the Token Broker), consistent with the spec but contradicting the `.intent.md` prose. |
| Input sanitization | PASS | Raw Telegram user IDs are hashed via `hashSenderId()` (lines 37–43) using SHA-256 with a `tg:` prefix, truncated to 16 hex chars. The hashed value is used as `senderId` in `InboundMessage` (line 457). The raw numeric ID is passed through the legacy `sender` field (line 444) for DB layer compatibility, but it is a numeric ID string — not user-controlled free-form text — and is not used as a filesystem path. Group folder names are derived from JIDs via `telegramFolderFromJid` in `src/index.ts` (line 243), not from any user-supplied content. Attachment filenames are sanitized at line 224: `filename.replace(/[^a-zA-Z0-9._-]/g, '_')`. |
| Rate limiting | FAIL | Same finding as TUI. `INBOUND_RATE_LIMIT_PER_SENDER` and `INBOUND_QUEUE_MAX_DEPTH` appear only in `src/bootstrap.ts` lines 37–38 (allowlist of config keys to copy into `process.env`) and are never consumed. The Telegram adapter delivers every inbound message to `opts.onMessage` without any per-sender throttle. The `GroupQueue` (`src/group-queue.ts`) enforces concurrency limits via `MAX_CONCURRENT_CONTAINERS` but does not implement inbound rate limiting per sender. |
| Allowlist enforcement | PASS | The Telegram adapter correctly does NOT enforce the allowlist itself (AC-5, spec invariant 1 — enforcement is the orchestrator's responsibility). Allowlist filtering is applied in `src/index.ts` via `filterMessagesForTelegramAllowlist` (lines 526, 618, 650), which calls into `src/sender-allowlist.ts`. `getTelegramValidUserSet()` returns `null` (deny-all) when `TELEGRAM_VALID_USERS` is unset or empty (fail-secure, `src/config.ts` lines 145–157). The adapter itself correctly ignores `TELEGRAM_VALID_USERS` — confirmed by the stub-detection test at `src/channels/telegram.test.ts` lines 2320–2344. |

---

## Findings

### F-1 (FAIL): Rate limiting is declared but not enforced — affects both adapters

**Severity:** Medium

**Files:** `src/bootstrap.ts:37-38`, `src/group-queue.ts` (entire file), `src/channels/tui.ts`, `src/channels/telegram.ts`

**Description:** `INBOUND_RATE_LIMIT_PER_SENDER` and `INBOUND_QUEUE_MAX_DEPTH` are listed in the bootstrap CONFIG_KEYS allowlist and documented in `CLAUDE.md` as operational environment variables, but no code in the codebase reads or acts on these values. A high-volume sender can generate unlimited inbound messages with no throttling. The `GroupQueue` enforces container concurrency (`MAX_CONCURRENT_CONTAINERS`) but that is a downstream resource limit, not an inbound rate gate.

**Remediation:** Implement a per-sender sliding-window rate limiter (configurable via `INBOUND_RATE_LIMIT_PER_SENDER`, default 10 per 60 s) in the orchestrator's inbound message path (`src/index.ts`) before messages are queued. Implement a per-group queue depth cap (configurable via `INBOUND_QUEUE_MAX_DEPTH`, default 100) in `GroupQueue.enqueueMessageCheck`. Exceeding either limit should drop the message and log a warning with sender identity hash — never the raw sender ID.

---

### F-2 (FAIL): `telegram.intent.md` is incomplete relative to spec

**Severity:** Low (structural compliance gap, not a runtime security risk)

**File:** `src/channels/telegram.intent.md`

**Description:** The intent file is missing `skill`, `version`, `description`, `filesystem`, and `mcp` fields required by the channel-adapters-spec template (docs/specs/channel-adapters-spec.md §Skill Declaration, lines 66–95). Additionally, the prose states "Credentials are mediated via the Token Broker" — this is incorrect. The adapter reads `TELEGRAM_BOT_TOKEN` directly from the environment/`.env`, not via the Token Broker.

**Remediation:** Rewrite `src/channels/telegram.intent.md` to match the template in the spec. Correct the credential mediation prose. The `filesystem.host_writes` block should note that the adapter writes to `{groupFolder}/attachments/` on the host when downloading Telegram file attachments (line 239: `fs.writeFileSync(destPath, buffer)`).

---

### F-3 (WARN): Bot token interpolated into file-download URL — no logging present, comment recommended

**Severity:** Low (observation only, no active leak)

**File:** `src/channels/telegram.ts:228`

**Description:** `const fileUrl = \`https://api.telegram.org/file/bot${this.botToken}/${file.file_path}\`` embeds the bot token in a URL string. The URL is used only for the `fetch()` call and is not passed to any logger. Future refactoring that adds request-level debug logging (e.g. logging the URL on fetch failure) could inadvertently expose the token.

**Remediation:** Add a comment at line 228 documenting that `fileUrl` contains the bot token and must never be logged. Consider extracting only the `file.file_path` segment for log output if request-level logging is added in future.

---

## Verdict

PASS — all findings resolved.

- **F-1** (resolved): Per-sender sliding-window rate limiter implemented in `src/index.ts` `onMessage` using `INBOUND_RATE_LIMIT_PER_SENDER` (default 10/60s). Per-group queue depth cap implemented using `INBOUND_QUEUE_MAX_DEPTH` (default 100). Both config exports added to `src/config.ts`. `countMessagesSince()` helper added to `src/db.ts`. Violations log a warning with hashed sender ID — raw ID never logged.
- **F-2** (resolved): `src/channels/telegram.intent.md` rewritten to match spec template (added `skill`, `version`, `description`, `filesystem`, `mcp` blocks). Corrected credential mediation prose. Added `filesystem.host_writes` for `{groupFolder}/attachments/*`.
- **F-3** (resolved): Comment added at `src/channels/telegram.ts:228` documenting that `fileUrl` contains the bot token and must never be logged.

867 tests passing, 0 lint errors, 0 type errors.
