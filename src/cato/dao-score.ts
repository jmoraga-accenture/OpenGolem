/**
 * dao_score — KPI computation pipeline.
 *
 * Reads from audit.db, computes the three Phase 1 KPIs defined in
 * PSYCHE.md and Decision 5, writes snapshots to dao_score.db.
 *
 * KPI field names must match PSYCHE.md exactly (enforced by the M6 gate test).
 */
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { DAO_SCORE_DB_PATH } from '../config.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DaoScore {
  period_start: number; // epoch ms
  period_end: number; // epoch ms
  /** (hard_blocks + soft_blocks) / total_calls */
  security_failures_per_call: number;
  /** checkMemoryScope blocks / total_calls */
  data_leaks_per_call: number;
  /**
   * Fraction of distinct (container, block_rule) pairs that did NOT re-fire
   * within the next 10 calls from the same container. Higher = better.
   * 1.0 when no blocks occurred (perfect).
   */
  behavioral_change_rate: number;
}

// ---------------------------------------------------------------------------
// Database init
// ---------------------------------------------------------------------------

let daoDb: Database.Database | null = null;

export function initDaoScoreDb(dbPath?: string): Database.Database {
  const resolvedPath = dbPath ?? DAO_SCORE_DB_PATH;
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  const db = new Database(resolvedPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS kpi_snapshots (
      id                          INTEGER PRIMARY KEY,
      computed_at                 INTEGER NOT NULL,
      period_start                INTEGER NOT NULL,
      period_end                  INTEGER NOT NULL,
      security_failures_per_call  REAL    NOT NULL,
      data_leaks_per_call         REAL    NOT NULL,
      behavioral_change_rate      REAL    NOT NULL
    );
  `);
  return db;
}

export function getDaoScoreDb(): Database.Database {
  if (!daoDb) daoDb = initDaoScoreDb();
  return daoDb;
}

/** For tests: inject a pre-initialised database instance. */
export function _setDaoScoreDb(db: Database.Database | null): void {
  daoDb = db;
}

// ---------------------------------------------------------------------------
// KPI computation
// ---------------------------------------------------------------------------

type CallRow = {
  id: number;
  ts: number;
  container: string;
  skill: string;
  outcome: 'pass' | 'hard_block' | 'soft_block';
  block_rule: string | null;
};

/**
 * Compute dao_score KPIs from the audit database for the given time window.
 * Default window: last 6 hours.
 */
export function computeDaoScore(
  auditDb: Database.Database,
  periodMs: number = 6 * 60 * 60 * 1000,
): DaoScore {
  const now = Date.now();
  const start = now - periodMs;

  const rows = auditDb
    .prepare(
      'SELECT id, ts, container, skill, outcome, block_rule FROM calls WHERE ts >= ? AND ts <= ? ORDER BY id ASC',
    )
    .all(start, now) as CallRow[];

  const total = rows.length;

  if (total === 0) {
    return {
      period_start: start,
      period_end: now,
      security_failures_per_call: 0,
      data_leaks_per_call: 0,
      behavioral_change_rate: 1.0,
    };
  }

  // KPI 1: security_failures_per_call
  const blockCount = rows.filter(
    (r) => r.outcome === 'hard_block' || r.outcome === 'soft_block',
  ).length;
  const security_failures_per_call = blockCount / total;

  // KPI 2: data_leaks_per_call
  const memoryLeakCount = rows.filter(
    (r) => r.block_rule === 'checkMemoryScope',
  ).length;
  const data_leaks_per_call = memoryLeakCount / total;

  // KPI 3: behavioral_change_rate
  // For each distinct (container, block_rule) pair that fired:
  //   - find the first occurrence
  //   - look at the next 10 calls from the same container after that occurrence
  //   - if the same rule did NOT re-fire in those 10 calls → pair "changed"
  // BCR = changed_pairs / total_distinct_pairs  (1.0 when no blocks → perfect)

  const blockedRows = rows.filter((r) => r.block_rule !== null);

  if (blockedRows.length === 0) {
    return {
      period_start: start,
      period_end: now,
      security_failures_per_call,
      data_leaks_per_call,
      behavioral_change_rate: 1.0,
    };
  }

  // Build per-container ordered call list
  const byContainer = new Map<string, CallRow[]>();
  for (const row of rows) {
    const list = byContainer.get(row.container) ?? [];
    list.push(row);
    byContainer.set(row.container, list);
  }

  // Distinct (container, rule) pairs (first occurrence only)
  const seenPairs = new Set<string>();
  const distinctPairs: Array<{
    container: string;
    rule: string;
    firstId: number;
  }> = [];
  for (const row of blockedRows) {
    const key = `${row.container}:::${row.block_rule}`;
    if (!seenPairs.has(key)) {
      seenPairs.add(key);
      distinctPairs.push({
        container: row.container,
        rule: row.block_rule!,
        firstId: row.id,
      });
    }
  }

  let changedPairs = 0;
  for (const { container, rule, firstId } of distinctPairs) {
    const containerCalls = byContainer.get(container) ?? [];
    const afterFirst = containerCalls
      .filter((r) => r.id > firstId)
      .slice(0, 10);
    const refired = afterFirst.some((r) => r.block_rule === rule);
    if (!refired) changedPairs++;
  }

  const behavioral_change_rate =
    distinctPairs.length > 0 ? changedPairs / distinctPairs.length : 1.0;

  return {
    period_start: start,
    period_end: now,
    security_failures_per_call,
    data_leaks_per_call,
    behavioral_change_rate,
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export function saveDaoScore(score: DaoScore, dbPath?: string): void {
  const db = dbPath ? initDaoScoreDb(dbPath) : getDaoScoreDb();
  db.prepare(
    `INSERT INTO kpi_snapshots
       (computed_at, period_start, period_end,
        security_failures_per_call, data_leaks_per_call, behavioral_change_rate)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    Date.now(),
    score.period_start,
    score.period_end,
    score.security_failures_per_call,
    score.data_leaks_per_call,
    score.behavioral_change_rate,
  );
}

export function getLatestDaoScore(dbPath?: string): DaoScore | null {
  const resolvedPath = dbPath ?? DAO_SCORE_DB_PATH;
  if (!fs.existsSync(resolvedPath)) return null;
  const db = new Database(resolvedPath);
  const row = db
    .prepare('SELECT * FROM kpi_snapshots ORDER BY computed_at DESC LIMIT 1')
    .get() as
    | {
        period_start: number;
        period_end: number;
        security_failures_per_call: number;
        data_leaks_per_call: number;
        behavioral_change_rate: number;
      }
    | undefined;
  if (!row) return null;
  return {
    period_start: row.period_start,
    period_end: row.period_end,
    security_failures_per_call: row.security_failures_per_call,
    data_leaks_per_call: row.data_leaks_per_call,
    behavioral_change_rate: row.behavioral_change_rate,
  };
}
