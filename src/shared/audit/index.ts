/**
 * Unified Audit Log — M16
 *
 * Single append-only SQLite file at data/audit.db shared by all three writers:
 * Orchestrator, Token Broker/Call Inspector, and Cato.
 *
 * Spec: docs/specs/audit-log-spec.md
 * Key invariants:
 *   - INSERT only — no UPDATE or DELETE through any write path
 *   - WAL mode mandatory; fail closed if WAL cannot be enabled
 *   - occurred_at = Unix timestamp in seconds (UTC)
 *   - payload_hash = SHA-256 hex; payload_size = byte count
 *   - details = JSON object with writer-specific fields
 *   - sequence_id monotonically increasing per writer per process run
 */
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AuditWriter = 'orchestrator' | 'broker' | 'cato';

export type AuditOutcome =
  | 'allow'
  | 'block'
  | 'soft_block'
  | 'revoked'
  | 'issued'
  | 'started'
  | 'completed'
  | 'timed_out'
  | 'error'
  | 'info';

export interface AuditEventParams {
  event_type: string;
  context_id?: string | null;
  occurred_at?: number; // Unix timestamp seconds UTC; defaults to Math.floor(Date.now()/1000)
  token_id?: string | null;
  check_id?: string | null;
  task_id?: string | null;
  container_id?: string | null;
  outcome?: AuditOutcome | null;
  risk_code?: string | null;
  payload_hash?: string | null;
  payload_size?: number | null;
  details?: Record<string, unknown>;
  hmac?: string | null;
}

export interface AuditLog {
  writeEvent(params: AuditEventParams): void;
  close(): void;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type   TEXT    NOT NULL,
  writer       TEXT    NOT NULL CHECK (writer IN ('orchestrator','broker','cato')),
  context_id   TEXT,
  occurred_at  INTEGER NOT NULL,
  token_id     TEXT,
  check_id     TEXT,
  task_id      TEXT,
  container_id TEXT,
  outcome      TEXT    CHECK (outcome IN (
                   'allow','block','soft_block','revoked','issued',
                   'started','completed','timed_out','error','info'
               )),
  risk_code    TEXT,
  payload_hash TEXT,
  payload_size INTEGER,
  details      TEXT    NOT NULL DEFAULT '{}',
  sequence_id  INTEGER NOT NULL,
  hmac         TEXT
);

CREATE INDEX IF NOT EXISTS events_context_id_occurred_at
  ON events (context_id, occurred_at)
  WHERE context_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS events_event_type_occurred_at
  ON events (event_type, occurred_at);

CREATE INDEX IF NOT EXISTS events_token_id
  ON events (token_id)
  WHERE token_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS events_check_id
  ON events (check_id)
  WHERE check_id IS NOT NULL;
`;

// ---------------------------------------------------------------------------
// Retry configuration
// ---------------------------------------------------------------------------

const MAX_RETRIES = 5;
const BASE_BACKOFF_MS = 10;

// ---------------------------------------------------------------------------
// openAuditLog
// ---------------------------------------------------------------------------

/**
 * Opens (or creates) the audit log database at `dbPath`.
 *
 * - Creates the parent directory if absent
 * - Applies the normative schema if the file is new
 * - Enables WAL mode; throws if WAL cannot be enabled (startup failure)
 * - The returned AuditLog is bound to `writer` — each call to writeEvent
 *   uses the per-writer sequence counter on this instance
 *
 * Throws an AuditInitError if the file cannot be opened or WAL fails.
 */
export function openAuditLog(dbPath: string, writer: AuditWriter): AuditLog {
  // Ensure directory exists
  try {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  } catch (err) {
    throw new AuditInitError(
      `Cannot create audit log directory: ${String(err)}`,
      err,
    );
  }

  let db: Database.Database;
  try {
    db = new Database(dbPath);
  } catch (err) {
    throw new AuditInitError(
      `Cannot open audit log at ${dbPath}: ${String(err)}`,
      err,
    );
  }

  // Enable WAL mode — mandatory; fail closed on failure
  try {
    const result = db.pragma('journal_mode=WAL', { simple: true });
    if (result !== 'wal') {
      db.close();
      throw new AuditInitError(
        `WAL mode could not be enabled on ${dbPath} (got: ${String(result)})`,
        null,
      );
    }
  } catch (err) {
    if (err instanceof AuditInitError) throw err;
    db.close();
    throw new AuditInitError(
      `WAL pragma failed on ${dbPath}: ${String(err)}`,
      err,
    );
  }

  // Apply schema (idempotent — CREATE TABLE IF NOT EXISTS)
  try {
    db.exec(SCHEMA_SQL);
  } catch (err) {
    db.close();
    throw new AuditInitError(
      `Schema initialization failed on ${dbPath}: ${String(err)}`,
      err,
    );
  }

  // Per-writer sequence counter — starts at 1, resets on process restart
  let sequenceCounter = 0;

  const insertStmt = db.prepare(`
    INSERT INTO events (
      event_type, writer, context_id, occurred_at,
      token_id, check_id, task_id, container_id,
      outcome, risk_code, payload_hash, payload_size,
      details, sequence_id, hmac
    ) VALUES (
      @event_type, @writer, @context_id, @occurred_at,
      @token_id, @check_id, @task_id, @container_id,
      @outcome, @risk_code, @payload_hash, @payload_size,
      @details, @sequence_id, @hmac
    )
  `);

  const writeInTransaction = db.transaction(
    (row: Record<string, unknown>) => {
      insertStmt.run(row);
    },
  );

  return {
    writeEvent(params: AuditEventParams): void {
      // Increment sequence counter atomically before INSERT
      const seqId = ++sequenceCounter;

      const row = {
        event_type: params.event_type,
        writer,
        context_id: params.context_id ?? null,
        occurred_at:
          params.occurred_at ?? Math.floor(Date.now() / 1000),
        token_id: params.token_id ?? null,
        check_id: params.check_id ?? null,
        task_id: params.task_id ?? null,
        container_id: params.container_id ?? null,
        outcome: params.outcome ?? null,
        risk_code: params.risk_code ?? null,
        payload_hash: params.payload_hash ?? null,
        payload_size: params.payload_size ?? null,
        details: JSON.stringify(params.details ?? {}),
        sequence_id: seqId,
        hmac: params.hmac ?? null,
      };

      let lastError: unknown;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          writeInTransaction(row);
          return;
        } catch (err) {
          lastError = err;
          const msg = err instanceof Error ? err.message : String(err);
          const isBusy =
            msg.includes('SQLITE_BUSY') || msg.includes('database is locked');
          if (!isBusy || attempt === MAX_RETRIES) {
            break;
          }
          // Synchronous exponential backoff — better-sqlite3 is synchronous so
          // we use a busy-spin with a short yielding pause.
          // For better-sqlite3 we can use db.pragma('busy_timeout') but the
          // spec calls for explicit retry with 10ms base exponential backoff.
          const backoff = BASE_BACKOFF_MS * Math.pow(2, attempt);
          // Synchronous sleep approximation using a tight loop (better-sqlite3
          // doesn't support async; this is called synchronously in the write path)
          const deadline = Date.now() + backoff;
          while (Date.now() < deadline) {
            /* busy wait */
          }
        }
      }

      throw new AuditWriteError(
        `Audit log write failed after ${MAX_RETRIES} retries: ${String(lastError)}`,
        lastError,
      );
    },

    close(): void {
      db.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class AuditInitError extends Error {
  constructor(
    message: string,
    public readonly cause: unknown,
  ) {
    super(message);
    this.name = 'AuditInitError';
  }
}

export class AuditWriteError extends Error {
  constructor(
    message: string,
    public readonly cause: unknown,
  ) {
    super(message);
    this.name = 'AuditWriteError';
  }
}
