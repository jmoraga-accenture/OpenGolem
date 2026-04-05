# Spec: Database Layer (`src/db.ts`)

> Clean-room spec. Do not read the existing implementation before writing the replacement.

## Responsibility

All SQLite access for the host process. One module-level database handle (opened by `initDatabase`). Provides typed read/write functions; no business logic. Handles schema creation, additive migrations, and one-time JSON-to-SQLite migration.

---

## Database Location

`data/store/messages.db` (path constructed from `STORE_DIR` config constant).

---

## Public API

```typescript
// Lifecycle
export function initDatabase(): void           // open DB at configured path, run schema + migrations
export function _initTestDatabase(): void      // @internal — open in-memory DB for tests
export function _closeDatabase(): void         // @internal — close DB handle for tests

// Chats
export function storeChatMetadata(chatJid, timestamp, name?, channel?, isGroup?): void
export function updateChatName(chatJid, name): void
export function getAllChats(): ChatInfo[]

// Messages
export function storeMessage(msg: NewMessage): void
export function storeMessageDirect(msg: DirectMessageInput): void
export function getNewMessages(jids, lastTimestamp, botPrefix, limit?): { messages: NewMessage[], newTimestamp: string }
export function getMessagesSince(chatJid, sinceTimestamp, botPrefix, limit?): NewMessage[]
export function getLastBotMessageTimestamp(chatJid, botPrefix): string | undefined

// Sessions
export function getSession(groupFolder): string | undefined
export function setSession(groupFolder, sessionId): void
export function deleteSession(groupFolder): void
export function getAllSessions(): Record<string, string>

// Registered groups
export function getRegisteredGroup(jid): (RegisteredGroup & { jid: string }) | undefined
export function setRegisteredGroup(jid, group: RegisteredGroup): void
export function getAllRegisteredGroups(): Record<string, RegisteredGroup>

// Router state (key-value store for cursor persistence)
export function getRouterState(key): string | undefined
export function setRouterState(key, value): void

// Scheduled tasks
export function createTask(task): void
export function getTaskById(id): ScheduledTask | undefined
export function getTasksForGroup(groupFolder): ScheduledTask[]
export function getAllTasks(): ScheduledTask[]
export function updateTask(id, updates): void
export function deleteTask(id): void
export function getDueTasks(): ScheduledTask[]
export function updateTaskAfterRun(id, nextRun, lastResult): void
export function logTaskRun(log: TaskRunLog): void
```

---

## Schema

### `chats`
```sql
CREATE TABLE IF NOT EXISTS chats (
  jid TEXT PRIMARY KEY,
  name TEXT,
  last_message_time TEXT,
  channel TEXT,
  is_group INTEGER DEFAULT 0
);
```

### `messages`
```sql
CREATE TABLE IF NOT EXISTS messages (
  id TEXT,
  chat_jid TEXT,
  sender TEXT,
  sender_name TEXT,
  content TEXT,
  timestamp TEXT,
  is_from_me INTEGER,
  is_bot_message INTEGER DEFAULT 0,
  reply_to_message_id TEXT,
  reply_to_message_content TEXT,
  reply_to_sender_name TEXT,
  PRIMARY KEY (id, chat_jid),
  FOREIGN KEY (chat_jid) REFERENCES chats(jid)
);
CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);
```

### `scheduled_tasks`
```sql
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id TEXT PRIMARY KEY,
  group_folder TEXT NOT NULL,
  chat_jid TEXT NOT NULL,
  prompt TEXT NOT NULL,
  schedule_type TEXT NOT NULL,
  schedule_value TEXT NOT NULL,
  next_run TEXT,
  last_run TEXT,
  last_result TEXT,
  status TEXT DEFAULT 'active',
  created_at TEXT NOT NULL,
  context_mode TEXT DEFAULT 'isolated',
  script TEXT
);
CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);
```

### `task_run_logs`
```sql
CREATE TABLE IF NOT EXISTS task_run_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  run_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  status TEXT NOT NULL,
  result TEXT,
  error TEXT,
  FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
);
CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);
```

### `router_state`
```sql
CREATE TABLE IF NOT EXISTS router_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

### `sessions`
```sql
CREATE TABLE IF NOT EXISTS sessions (
  group_folder TEXT PRIMARY KEY,
  session_id TEXT NOT NULL
);
```

### `registered_groups`
```sql
CREATE TABLE IF NOT EXISTS registered_groups (
  jid TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  folder TEXT NOT NULL UNIQUE,
  trigger_pattern TEXT NOT NULL,
  added_at TEXT NOT NULL,
  container_config TEXT,
  requires_trigger INTEGER DEFAULT 1,
  is_main INTEGER DEFAULT 0,
  assertiveness_level INTEGER DEFAULT 10
);
```

---

## Additive Migrations

For databases created before the full schema existed, apply these column additions inside individual `try/catch` blocks (silently ignore "column already exists" errors):

1. `scheduled_tasks` ← `ADD COLUMN context_mode TEXT DEFAULT 'isolated'`
2. `scheduled_tasks` ← `ADD COLUMN script TEXT`
3. `messages` ← `ADD COLUMN is_bot_message INTEGER DEFAULT 0`
   - After adding: backfill `is_bot_message = 1` for rows where `content LIKE '<ASSISTANT_NAME>:%'`
4. `registered_groups` ← `ADD COLUMN is_main INTEGER DEFAULT 0`
   - After adding: backfill `is_main = 1` WHERE `folder = 'main'`
5. `registered_groups` ← `ADD COLUMN assertiveness_level INTEGER DEFAULT 10`
6. `chats` ← `ADD COLUMN channel TEXT`, `ADD COLUMN is_group INTEGER DEFAULT 0`
   - After adding: backfill `channel = 'telegram', is_group = 0` WHERE `jid LIKE 'tg:%'`
7. `messages` ← `ADD COLUMN reply_to_message_id TEXT`, `ADD COLUMN reply_to_message_content TEXT`, `ADD COLUMN reply_to_sender_name TEXT`

---

## JSON Migration (`migrateJsonState`)

Called once during `initDatabase`. For each of these files in `DATA_DIR`, if present: parse JSON, import rows into SQLite, rename file to `<name>.migrated`.

- `router_state.json` → `{ last_timestamp?, last_agent_timestamp? }` → `setRouterState` calls
- `sessions.json` → `Record<string, string>` → `setSession` calls
- `registered_groups.json` → `Record<string, RegisteredGroup>` → `setRegisteredGroup` calls (skip rows with invalid folder, log warn)

---

## Function Behaviours

### `storeChatMetadata`

Upsert into `chats`. On conflict:
- If `name` provided: update name, `last_message_time = MAX(existing, new)`, `channel` and `is_group` only if new value is not null.
- If no `name`: update only `last_message_time = MAX(...)`, `channel`, `is_group`.

### `updateChatName`

Upsert: on conflict, update only `name`. New rows get `last_message_time = now`.

### `getAllChats`

Return all chats ordered by `last_message_time DESC`.

### `storeMessage`

`INSERT OR REPLACE` with all columns including reply context fields (null if not provided).

### `storeMessageDirect`

`INSERT OR REPLACE` with base columns only (no reply context).

### `getNewMessages`

Returns messages where `timestamp > lastTimestamp` and `chat_jid IN (jids)`.

Excludes:
- `is_bot_message = 1`
- `content LIKE '<botPrefix>:%'` (backstop for pre-migration rows)
- Empty or null content

Uses a subquery pattern: inner query selects the N most recent (DESC), outer query re-sorts ASC. Default `limit = 200`.

Also returns `newTimestamp`: the highest timestamp seen in the result set (or `lastTimestamp` if empty).

### `getMessagesSince`

Same filters as `getNewMessages` but for a single `chatJid`. Same subquery/limit pattern. Default `limit = 200`.

### `getLastBotMessageTimestamp`

Returns `MAX(timestamp)` for messages in `chatJid` where `is_bot_message = 1 OR content LIKE '<botPrefix>:%'`. Returns `undefined` if none.

### `getRegisteredGroup`

Parse `container_config` JSON if present. Validate `folder` via `isValidGroupFolder`; return `undefined` with a warn log if invalid.

Type mappings from DB integers to TypeScript:
- `requires_trigger`: `null → undefined`, `1 → true`, `0 → false`
- `is_main`: `1 → true`, anything else → `undefined`
- `assertiveness_level`: `null → undefined`, else the number

### `setRegisteredGroup`

Throws if `group.folder` fails `isValidGroupFolder` validation. Serialises `containerConfig` to JSON string (or null). Stores `requiresTrigger` as `1/0` (undefined defaults to `1`). Stores `isMain` as `1/0`. Stores `assertivenessLevel` (undefined defaults to `10`).

### `getAllRegisteredGroups`

Returns `Record<jid, RegisteredGroup>`. Skips rows with invalid folder (log warn).

### `getDueTasks`

Returns tasks where `status = 'active'` AND `next_run IS NOT NULL` AND `next_run <= now`, ordered by `next_run ASC`.

### `updateTaskAfterRun`

Updates `next_run`, `last_run = now`, `last_result`. If `nextRun` is null, also sets `status = 'completed'`.

### `deleteTask`

Delete `task_run_logs` for the task first (FK constraint), then delete the task.

### `updateTask`

Build `SET` clause dynamically from the provided partial update. No-op if no fields provided.

---

## Types

```typescript
export interface ChatInfo {
  jid: string
  name: string
  last_message_time: string
  channel: string
  is_group: number
}
```

`NewMessage`, `RegisteredGroup`, `ScheduledTask`, `TaskRunLog` are defined in `src/types.ts`.
