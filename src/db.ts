import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR, STORE_DIR } from './config.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import type {
  NewMessage,
  RegisteredGroup,
  ScheduledTask,
  TaskRunLog,
} from './types.js';

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
}

let db: Database.Database | null = null;

function requireDb(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized');
  }
  return db;
}

function safeAddColumn(database: Database.Database, sql: string): void {
  try {
    database.exec(sql);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes('duplicate column name')) {
      throw e;
    }
  }
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS chats (
  jid TEXT PRIMARY KEY,
  name TEXT,
  last_message_time TEXT,
  channel TEXT,
  is_group INTEGER DEFAULT 0
);

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

CREATE TABLE IF NOT EXISTS router_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  group_folder TEXT PRIMARY KEY,
  session_id TEXT NOT NULL
);

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
`;

function applyMigrations(database: Database.Database): void {
  safeAddColumn(
    database,
    `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`,
  );
  safeAddColumn(database, `ALTER TABLE scheduled_tasks ADD COLUMN script TEXT`);

  safeAddColumn(
    database,
    `ALTER TABLE messages ADD COLUMN is_bot_message INTEGER DEFAULT 0`,
  );
  const botLike = `${ASSISTANT_NAME}:%`;
  database
    .prepare(`UPDATE messages SET is_bot_message = 1 WHERE content LIKE ?`)
    .run(botLike);

  safeAddColumn(
    database,
    `ALTER TABLE registered_groups ADD COLUMN is_main INTEGER DEFAULT 0`,
  );
  database
    .prepare(`UPDATE registered_groups SET is_main = 1 WHERE folder = 'main'`)
    .run();

  safeAddColumn(
    database,
    `ALTER TABLE registered_groups ADD COLUMN assertiveness_level INTEGER DEFAULT 10`,
  );

  safeAddColumn(database, `ALTER TABLE chats ADD COLUMN channel TEXT`);
  safeAddColumn(
    database,
    `ALTER TABLE chats ADD COLUMN is_group INTEGER DEFAULT 0`,
  );
  database
    .prepare(
      `UPDATE chats SET channel = 'telegram', is_group = 0 WHERE jid LIKE 'tg:%'`,
    )
    .run();

  safeAddColumn(
    database,
    `ALTER TABLE messages ADD COLUMN reply_to_message_id TEXT`,
  );
  safeAddColumn(
    database,
    `ALTER TABLE messages ADD COLUMN reply_to_message_content TEXT`,
  );
  safeAddColumn(
    database,
    `ALTER TABLE messages ADD COLUMN reply_to_sender_name TEXT`,
  );
}

function rowToNewMessage(row: Record<string, unknown>): NewMessage {
  return {
    id: row.id as string,
    chat_jid: row.chat_jid as string,
    sender: row.sender as string,
    sender_name: row.sender_name as string,
    content: row.content as string,
    timestamp: row.timestamp as string,
    is_from_me: Boolean(row.is_from_me),
    reply_to_message_id: (row.reply_to_message_id as string | null) ?? null,
    reply_to_message_content:
      (row.reply_to_message_content as string | null) ?? null,
    reply_to_sender_name: (row.reply_to_sender_name as string | null) ?? null,
  } as NewMessage;
}

function rowToScheduledTask(row: Record<string, unknown>): ScheduledTask {
  return {
    id: row.id as string,
    group_folder: row.group_folder as string,
    chat_jid: row.chat_jid as string,
    prompt: row.prompt as string,
    script: (row.script as string | null) ?? null,
    schedule_type: row.schedule_type as ScheduledTask['schedule_type'],
    schedule_value: row.schedule_value as string,
    context_mode:
      (row.context_mode as ScheduledTask['context_mode']) || 'isolated',
    next_run: (row.next_run as string | null) ?? null,
    last_run: (row.last_run as string | null) ?? null,
    last_result: (row.last_result as string | null) ?? null,
    status: row.status as ScheduledTask['status'],
    created_at: row.created_at as string,
  };
}

function mapRegisteredRow(
  jid: string,
  row: Record<string, unknown>,
): (RegisteredGroup & { jid: string }) | undefined {
  const folder = row.folder as string;
  if (!isValidGroupFolder(folder)) {
    logger.warn(
      { jid, folder },
      'Skipping registered group with invalid folder',
    );
    return undefined;
  }

  let containerConfig: RegisteredGroup['containerConfig'];
  const rawCfg = row.container_config as string | null;
  if (rawCfg) {
    try {
      containerConfig = JSON.parse(
        rawCfg,
      ) as RegisteredGroup['containerConfig'];
    } catch {
      containerConfig = undefined;
    }
  }

  const requiresRaw = row.requires_trigger as number | null;
  let requiresTrigger: boolean | undefined;
  if (requiresRaw === null || requiresRaw === undefined) {
    requiresTrigger = undefined;
  } else {
    requiresTrigger = requiresRaw === 1;
  }

  const isMainVal = row.is_main as number | null;
  const isMain = isMainVal === 1 ? true : undefined;

  const alRaw = row.assertiveness_level as number | null;
  const assertivenessLevel =
    alRaw === null || alRaw === undefined ? undefined : alRaw;

  const group: RegisteredGroup & { jid: string } = {
    jid,
    name: row.name as string,
    folder,
    trigger: row.trigger_pattern as string,
    added_at: row.added_at as string,
    containerConfig,
    requiresTrigger,
    isMain,
    assertivenessLevel,
  };
  return group;
}

function openAndPrepare(pathOrMemory: string): void {
  if (db) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    db = null;
  }
  db = new Database(pathOrMemory);
  db.exec(SCHEMA_SQL);
  applyMigrations(db);
}

export function initDatabase(): void {
  fs.mkdirSync(STORE_DIR, { recursive: true });
  const dbPath = path.join(STORE_DIR, 'messages.db');
  openAndPrepare(dbPath);
  migrateJsonState();
}

export function _initTestDatabase(): void {
  openAndPrepare(':memory:');
}

export function _closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

function migrateJsonState(): void {
  const d = requireDb();

  const migrateFile = (jsonName: string, migratedBase: string) => {
    const jsonPath = path.join(DATA_DIR, jsonName);
    if (!fs.existsSync(jsonPath)) return;
    const text = fs.readFileSync(jsonPath, 'utf8');
    const data = JSON.parse(text) as unknown;
    const dest = path.join(DATA_DIR, migratedBase);
    fs.renameSync(jsonPath, dest);
    return data;
  };

  const routerData = migrateFile('router_state.json', 'router_state.migrated');
  if (routerData && typeof routerData === 'object' && routerData !== null) {
    const o = routerData as Record<string, unknown>;
    if (typeof o.last_timestamp === 'string') {
      d.prepare(
        `INSERT INTO router_state (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run('last_timestamp', o.last_timestamp);
    }
    if (o.last_agent_timestamp !== undefined) {
      const v =
        typeof o.last_agent_timestamp === 'string'
          ? o.last_agent_timestamp
          : JSON.stringify(o.last_agent_timestamp);
      d.prepare(
        `INSERT INTO router_state (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run('last_agent_timestamp', v);
    }
  }

  const sessionsData = migrateFile('sessions.json', 'sessions.migrated');
  if (
    sessionsData &&
    typeof sessionsData === 'object' &&
    sessionsData !== null
  ) {
    const ins = d.prepare(
      `INSERT INTO sessions (group_folder, session_id) VALUES (?, ?)
       ON CONFLICT(group_folder) DO UPDATE SET session_id = excluded.session_id`,
    );
    for (const [folder, sessionId] of Object.entries(
      sessionsData as Record<string, string>,
    )) {
      if (typeof sessionId === 'string') {
        ins.run(folder, sessionId);
      }
    }
  }

  const regData = migrateFile(
    'registered_groups.json',
    'registered_groups.migrated',
  );
  if (regData && typeof regData === 'object' && regData !== null) {
    for (const [jid, group] of Object.entries(
      regData as Record<string, RegisteredGroup>,
    )) {
      if (!group?.folder || !isValidGroupFolder(group.folder)) {
        logger.warn(
          { jid, folder: group?.folder },
          'Skipping invalid registered group during JSON migration',
        );
        continue;
      }
      try {
        setRegisteredGroup(jid, group);
      } catch (e) {
        logger.warn(
          { jid, err: e instanceof Error ? e.message : String(e) },
          'Failed to migrate registered group',
        );
      }
    }
  }
}

export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): void {
  const d = requireDb();
  const ch = channel === undefined ? null : channel;
  const ig = isGroup === undefined ? null : isGroup ? 1 : 0;

  if (name !== undefined) {
    d.prepare(
      `INSERT INTO chats (jid, name, last_message_time, channel, is_group)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(jid) DO UPDATE SET
         name = excluded.name,
         last_message_time = MAX(chats.last_message_time, excluded.last_message_time),
         channel = COALESCE(excluded.channel, chats.channel),
         is_group = COALESCE(excluded.is_group, chats.is_group)`,
    ).run(chatJid, name, timestamp, ch, ig);
  } else {
    d.prepare(
      `INSERT INTO chats (jid, name, last_message_time, channel, is_group)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(jid) DO UPDATE SET
         last_message_time = MAX(chats.last_message_time, excluded.last_message_time),
         channel = COALESCE(excluded.channel, chats.channel),
         is_group = COALESCE(excluded.is_group, chats.is_group)`,
    ).run(chatJid, chatJid, timestamp, ch, ig);
  }
}

export function updateChatName(chatJid: string, name: string): void {
  const d = requireDb();
  const now = new Date().toISOString();
  d.prepare(
    `INSERT INTO chats (jid, name, last_message_time, channel, is_group)
     VALUES (?, ?, ?, NULL, 0)
     ON CONFLICT(jid) DO UPDATE SET name = excluded.name`,
  ).run(chatJid, name, now);
}

export function getAllChats(): ChatInfo[] {
  const d = requireDb();
  const rows = d
    .prepare(
      `SELECT jid, name, last_message_time, channel, is_group FROM chats
       ORDER BY last_message_time DESC`,
    )
    .all() as Record<string, unknown>[];
  return rows.map((r) => ({
    jid: r.jid as string,
    name: (r.name as string) ?? '',
    last_message_time: (r.last_message_time as string) ?? '',
    channel: (r.channel as string) ?? '',
    is_group: (r.is_group as number) ?? 0,
  }));
}

export function storeMessage(msg: NewMessage): void {
  const d = requireDb();
  d.prepare(
    `INSERT OR REPLACE INTO messages (
      id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message,
      reply_to_message_id, reply_to_message_content, reply_to_sender_name
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
    msg.reply_to_message_id ?? null,
    msg.reply_to_message_content ?? null,
    msg.reply_to_sender_name ?? null,
  );
}

export function storeMessageDirect(msg: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message?: boolean;
}): void {
  const d = requireDb();
  d.prepare(
    `INSERT OR REPLACE INTO messages (
      id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message,
      reply_to_message_id, reply_to_message_content, reply_to_sender_name
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
  );
}

export function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
  limit = 200,
): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) {
    return { messages: [], newTimestamp: '' };
  }
  const d = requireDb();
  const placeholders = jids.map(() => '?').join(', ');
  const likePat = `${botPrefix}:%`;
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me,
             reply_to_message_id, reply_to_message_content, reply_to_sender_name
      FROM messages
      WHERE timestamp > ?
        AND chat_jid IN (${placeholders})
        AND is_bot_message = 0
        AND content NOT LIKE ?
        AND content != ''
        AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp ASC`;
  const params: (string | number)[] = [lastTimestamp, ...jids, likePat, limit];
  const rows = d.prepare(sql).all(...params) as Record<string, unknown>[];
  const messages = rows.map(rowToNewMessage);
  if (messages.length === 0) {
    return { messages: [], newTimestamp: lastTimestamp };
  }
  let maxTs = messages[0].timestamp;
  for (const m of messages) {
    if (m.timestamp > maxTs) maxTs = m.timestamp;
  }
  return { messages, newTimestamp: maxTs };
}

export function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
  limit = 200,
): NewMessage[] {
  const d = requireDb();
  const likePat = `${botPrefix}:%`;
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me,
             reply_to_message_id, reply_to_message_content, reply_to_sender_name
      FROM messages
      WHERE chat_jid = ?
        AND timestamp > ?
        AND is_bot_message = 0
        AND content NOT LIKE ?
        AND content != ''
        AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp ASC`;
  const rows = d
    .prepare(sql)
    .all(chatJid, sinceTimestamp, likePat, limit) as Record<string, unknown>[];
  return rows.map(rowToNewMessage);
}

export function countMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
): number {
  const d = requireDb();
  const row = d
    .prepare(
      `SELECT COUNT(*) as cnt FROM messages
       WHERE chat_jid = ? AND timestamp > ? AND is_bot_message = 0
         AND content != '' AND content IS NOT NULL`,
    )
    .get(chatJid, sinceTimestamp) as { cnt: number } | undefined;
  return row?.cnt ?? 0;
}

export function getLastBotMessageTimestamp(
  chatJid: string,
  botPrefix: string,
): string | undefined {
  const d = requireDb();
  const likePat = `${botPrefix}:%`;
  const row = d
    .prepare(
      `SELECT MAX(timestamp) AS ts FROM messages
       WHERE chat_jid = ? AND (is_bot_message = 1 OR content LIKE ?)`,
    )
    .get(chatJid, likePat) as { ts: string | null } | undefined;
  const ts = row?.ts;
  return ts == null || ts === '' ? undefined : ts;
}

export function getSession(groupFolder: string): string | undefined {
  const d = requireDb();
  const row = d
    .prepare(`SELECT session_id FROM sessions WHERE group_folder = ?`)
    .get(groupFolder) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(groupFolder: string, sessionId: string): void {
  const d = requireDb();
  d.prepare(
    `INSERT INTO sessions (group_folder, session_id) VALUES (?, ?)
     ON CONFLICT(group_folder) DO UPDATE SET session_id = excluded.session_id`,
  ).run(groupFolder, sessionId);
}

export function deleteSession(groupFolder: string): void {
  const d = requireDb();
  d.prepare(`DELETE FROM sessions WHERE group_folder = ?`).run(groupFolder);
}

export function getAllSessions(): Record<string, string> {
  const d = requireDb();
  const rows = d
    .prepare(`SELECT group_folder, session_id FROM sessions`)
    .all() as { group_folder: string; session_id: string }[];
  const out: Record<string, string> = {};
  for (const r of rows) {
    out[r.group_folder] = r.session_id;
  }
  return out;
}

export function getRegisteredGroup(
  jid: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const d = requireDb();
  const row = d
    .prepare(`SELECT * FROM registered_groups WHERE jid = ?`)
    .get(jid) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return mapRegisteredRow(jid, row);
}

export function setRegisteredGroup(jid: string, group: RegisteredGroup): void {
  if (!isValidGroupFolder(group.folder)) {
    throw new Error(`Invalid group folder "${group.folder}"`);
  }
  const d = requireDb();
  const containerJson =
    group.containerConfig === undefined
      ? null
      : JSON.stringify(group.containerConfig);
  const req =
    group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0;
  const main = group.isMain ? 1 : 0;
  const al =
    group.assertivenessLevel === undefined ? 10 : group.assertivenessLevel;
  d.prepare(
    `INSERT INTO registered_groups (
      jid, name, folder, trigger_pattern, added_at, container_config,
      requires_trigger, is_main, assertiveness_level
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET
      name = excluded.name,
      folder = excluded.folder,
      trigger_pattern = excluded.trigger_pattern,
      added_at = excluded.added_at,
      container_config = excluded.container_config,
      requires_trigger = excluded.requires_trigger,
      is_main = excluded.is_main,
      assertiveness_level = excluded.assertiveness_level`,
  ).run(
    jid,
    group.name,
    group.folder,
    group.trigger,
    group.added_at,
    containerJson,
    req,
    main,
    al,
  );
}

export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const d = requireDb();
  const rows = d.prepare(`SELECT * FROM registered_groups`).all() as Record<
    string,
    unknown
  >[];
  const out: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    const jid = row.jid as string;
    const mapped = mapRegisteredRow(jid, row);
    if (mapped) {
      const { jid: _j, ...rest } = mapped;
      out[jid] = rest;
    }
  }
  return out;
}

export function getRouterState(key: string): string | undefined {
  const d = requireDb();
  const row = d
    .prepare(`SELECT value FROM router_state WHERE key = ?`)
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  const d = requireDb();
  d.prepare(
    `INSERT INTO router_state (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  const d = requireDb();
  d.prepare(
    `INSERT INTO scheduled_tasks (
      id, group_folder, chat_jid, prompt, script, schedule_type, schedule_value,
      next_run, status, created_at, context_mode, last_run, last_result
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
  ).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    task.prompt,
    task.script ?? null,
    task.schedule_type,
    task.schedule_value,
    task.next_run,
    task.status,
    task.created_at,
    task.context_mode,
  );
}

export function getTaskById(id: string): ScheduledTask | undefined {
  const d = requireDb();
  const row = d
    .prepare(`SELECT * FROM scheduled_tasks WHERE id = ?`)
    .get(id) as Record<string, unknown> | undefined;
  return row ? rowToScheduledTask(row) : undefined;
}

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  const d = requireDb();
  const rows = d
    .prepare(`SELECT * FROM scheduled_tasks WHERE group_folder = ?`)
    .all(groupFolder) as Record<string, unknown>[];
  return rows.map(rowToScheduledTask);
}

export function getAllTasks(): ScheduledTask[] {
  const d = requireDb();
  const rows = d.prepare(`SELECT * FROM scheduled_tasks`).all() as Record<
    string,
    unknown
  >[];
  return rows.map(rowToScheduledTask);
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      | 'prompt'
      | 'script'
      | 'schedule_type'
      | 'schedule_value'
      | 'next_run'
      | 'status'
    >
  >,
): void {
  const keys = Object.keys(updates) as (keyof typeof updates)[];
  if (keys.length === 0) return;
  const d = requireDb();
  const setParts: string[] = [];
  const vals: unknown[] = [];
  for (const k of keys) {
    setParts.push(`${k} = ?`);
    vals.push(updates[k] ?? null);
  }
  vals.push(id);
  d.prepare(
    `UPDATE scheduled_tasks SET ${setParts.join(', ')} WHERE id = ?`,
  ).run(...vals);
}

export function deleteTask(id: string): void {
  const d = requireDb();
  d.prepare(`DELETE FROM task_run_logs WHERE task_id = ?`).run(id);
  d.prepare(`DELETE FROM scheduled_tasks WHERE id = ?`).run(id);
}

export function getDueTasks(): ScheduledTask[] {
  const d = requireDb();
  const now = new Date().toISOString();
  const rows = d
    .prepare(
      `SELECT * FROM scheduled_tasks
       WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
       ORDER BY next_run ASC`,
    )
    .all(now) as Record<string, unknown>[];
  return rows.map(rowToScheduledTask);
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const d = requireDb();
  const now = new Date().toISOString();
  if (nextRun === null) {
    d.prepare(
      `UPDATE scheduled_tasks SET next_run = NULL, last_run = ?, last_result = ?, status = 'completed' WHERE id = ?`,
    ).run(now, lastResult, id);
  } else {
    d.prepare(
      `UPDATE scheduled_tasks SET next_run = ?, last_run = ?, last_result = ? WHERE id = ?`,
    ).run(nextRun, now, lastResult, id);
  }
}

export function logTaskRun(log: TaskRunLog): void {
  const d = requireDb();
  d.prepare(
    `INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    log.task_id,
    log.run_at,
    log.duration_ms,
    log.status,
    log.result,
    log.error,
  );
}
