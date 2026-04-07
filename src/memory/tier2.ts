/**
 * Tier 2 — Episodic Memory
 *
 * Manages per-group messages.db SQLite databases.
 * Source of truth: docs/specs/memory-tiers-spec.md
 *
 * Rules:
 * - One messages.db per group at groups/{name}/messages.db
 * - WAL mode mandatory (Decision 21)
 * - Auto-create with normative schema when file is missing (Decision 21)
 * - messages.db is NEVER in any container mount set (INV-3, T2-6)
 * - No cross-group messages database (INV-6)
 */

import Database from 'better-sqlite3';
import path from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Mount {
  hostPath: string;
  containerPath: string;
  readOnly: boolean;
}

export type TaskStatus = 'running' | 'completed' | 'timed_out' | 'blocked';

// ---------------------------------------------------------------------------
// Normative schema (Decision 21)
// ---------------------------------------------------------------------------

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT    NOT NULL,
  role        TEXT    NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content     TEXT    NOT NULL,
  channel     TEXT,
  sender_id   TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT    PRIMARY KEY,
  context_id  TEXT    NOT NULL,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  task_count  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tasks (
  id            TEXT    PRIMARY KEY,
  session_id    TEXT    NOT NULL REFERENCES sessions(id),
  container_id  TEXT,
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER,
  status        TEXT    NOT NULL CHECK (status IN ('running', 'completed', 'timed_out', 'blocked')),
  token_id      TEXT,
  check_id      TEXT
);
`;

// ---------------------------------------------------------------------------
// openGroupDb
//
// Opens (or creates) the messages.db for the given absolute path.
// Sets WAL mode unconditionally (Decision 21).
// Returns an open better-sqlite3 Database instance.
// ---------------------------------------------------------------------------

export function openGroupDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);

  // WAL mode is mandatory (Decision 21, T2-7)
  db.exec('PRAGMA journal_mode=WAL');

  // Apply normative schema (auto-create all tables)
  db.exec(SCHEMA_SQL);

  return db;
}

// ---------------------------------------------------------------------------
// getMountsForGroup
//
// Returns the container bind-mount set for a given group.
// messages.db must NEVER appear in this set (INV-3, AC-T2-3).
// ---------------------------------------------------------------------------

export function getMountsForGroup(
  groupName: string,
  groupsDir: string,
): Mount[] {
  // Mount only CLAUDE.md (Tier 1) — messages.db is excluded entirely.
  const groupDir = path.resolve(groupsDir, groupName);
  return [
    {
      hostPath: path.join(groupDir, 'CLAUDE.md'),
      containerPath: '/workspace/group/CLAUDE.md',
      readOnly: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// writeInboundMessage
//
// Writes an inbound message to the messages table synchronously.
// This must complete before any container is spawned (AC-T2-1).
// ---------------------------------------------------------------------------

export function writeInboundMessage(
  db: Database.Database,
  params: {
    sessionId: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    channel?: string;
    senderId?: string;
  },
): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO messages (session_id, role, content, channel, sender_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    params.sessionId,
    params.role,
    params.content,
    params.channel ?? null,
    params.senderId ?? null,
    now,
  );
}

// ---------------------------------------------------------------------------
// createTaskRecord
//
// Inserts a tasks row with status='running' at container spawn time (AC-T2-4).
// ---------------------------------------------------------------------------

export function createTaskRecord(
  db: Database.Database,
  params: {
    id: string;
    sessionId: string;
    containerId?: string;
    tokenId?: string;
    checkId?: string;
  },
): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO tasks (id, session_id, container_id, started_at, status, token_id, check_id)
     VALUES (?, ?, ?, ?, 'running', ?, ?)`,
  ).run(
    params.id,
    params.sessionId,
    params.containerId ?? null,
    now,
    params.tokenId ?? null,
    params.checkId ?? null,
  );
}

// ---------------------------------------------------------------------------
// completeTaskRecord
//
// Updates a tasks row with terminal status and ended_at timestamp (AC-T2-4/5/6).
// ---------------------------------------------------------------------------

export function completeTaskRecord(
  db: Database.Database,
  params: {
    id: string;
    status: TaskStatus;
  },
): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`UPDATE tasks SET status = ?, ended_at = ? WHERE id = ?`).run(
    params.status,
    now,
    params.id,
  );
}
