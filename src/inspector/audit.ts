/**
 * Call Inspector — append-only audit log.
 *
 * Stored in data/audit.db (separate from the main opengolem.db so it can be
 * independently preserved, rotated, or exported without touching message data).
 * A BEFORE DELETE trigger makes the table append-only at the SQLite level.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { DATA_DIR } from '../config.js';

let auditDb: Database.Database | null = null;

export function initAuditDb(dbPath?: string): Database.Database {
  const resolvedPath = dbPath ?? path.join(DATA_DIR, 'audit.db');
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });

  const db = new Database(resolvedPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS calls (
      id            INTEGER PRIMARY KEY,
      ts            INTEGER NOT NULL,
      jti           TEXT    NOT NULL,
      container     TEXT    NOT NULL,
      skill         TEXT    NOT NULL,
      outcome       TEXT    NOT NULL,
      block_rule    TEXT,
      payload_hash  TEXT    NOT NULL,
      security_mode TEXT    NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS prevent_delete
    BEFORE DELETE ON calls
    BEGIN
      SELECT RAISE(ABORT, 'audit log is append-only');
    END;
  `);
  return db;
}

export function getAuditDb(): Database.Database {
  if (!auditDb) auditDb = initAuditDb();
  return auditDb;
}

/** For tests: inject a pre-initialised database instance. */
export function _setAuditDb(db: Database.Database | null): void {
  auditDb = db;
}

export interface AuditRecord {
  jti: string;
  container: string;
  skill: string;
  outcome: 'pass' | 'hard_block' | 'soft_block';
  blockRule: string | null;
  payloadHash: string;
  securityMode: string;
}

const insertStmt = `
  INSERT INTO calls (ts, jti, container, skill, outcome, block_rule, payload_hash, security_mode)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`;

export function logCall(record: AuditRecord): void {
  getAuditDb()
    .prepare(insertStmt)
    .run(
      Date.now(),
      record.jti,
      record.container,
      record.skill,
      record.outcome,
      record.blockRule,
      record.payloadHash,
      record.securityMode,
    );
}

export function hashPayload(body: string): string {
  return crypto.createHash('sha256').update(body, 'utf8').digest('hex');
}

type CallRow = {
  id: number;
  ts: number;
  jti: string;
  container: string;
  skill: string;
  outcome: 'pass' | 'hard_block' | 'soft_block';
  block_rule: string | null;
  payload_hash: string;
  security_mode: string;
};

export function getRecentCalls(limit = 10): AuditRecord[] {
  return (
    getAuditDb()
      .prepare('SELECT * FROM calls ORDER BY ts DESC LIMIT ?')
      .all(limit) as CallRow[]
  ).map((row) => ({
    jti: row.jti,
    container: row.container,
    skill: row.skill,
    outcome: row.outcome,
    blockRule: row.block_rule,
    payloadHash: row.payload_hash,
    securityMode: row.security_mode,
  }));
}
