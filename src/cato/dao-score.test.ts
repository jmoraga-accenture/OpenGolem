import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import os from 'os';
import path from 'path';
import fs from 'fs';

vi.mock('../config.js', () => ({
  DATA_DIR: os.tmpdir(),
  DAO_SCORE_DB_PATH: path.join(os.tmpdir(), `dao-score-test-${process.pid}.db`),
}));

import { vi } from 'vitest';
import {
  computeDaoScore,
  saveDaoScore,
  getLatestDaoScore,
  initDaoScoreDb,
  _setDaoScoreDb,
} from './dao-score.js';
import { DAO_SCORE_DB_PATH } from '../config.js';

// ---------------------------------------------------------------------------
// Fixture: minimal audit.db schema
// ---------------------------------------------------------------------------

function makeAuditDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE calls (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      ts           INTEGER NOT NULL,
      jti          TEXT    NOT NULL DEFAULT '',
      container    TEXT    NOT NULL,
      skill        TEXT    NOT NULL DEFAULT 'anthropic.message',
      outcome      TEXT    NOT NULL,
      block_rule   TEXT,
      payload_hash TEXT    NOT NULL DEFAULT '',
      security_mode TEXT   NOT NULL DEFAULT 'golem_guard'
    );
  `);
  return db;
}

function insertCall(
  db: Database.Database,
  opts: {
    ts?: number;
    container?: string;
    outcome?: 'pass' | 'hard_block' | 'soft_block';
    block_rule?: string | null;
  } = {},
) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO calls (ts, container, outcome, block_rule)
     VALUES (?, ?, ?, ?)`,
  ).run(
    opts.ts ?? now,
    opts.container ?? 'opengolem-test-123',
    opts.outcome ?? 'pass',
    opts.block_rule ?? null,
  );
}

// ---------------------------------------------------------------------------

describe('computeDaoScore — empty audit log', () => {
  it('returns zero KPIs and BCR=1.0 when no calls', () => {
    const db = makeAuditDb();
    const score = computeDaoScore(db);
    expect(score.security_failures_per_call).toBe(0);
    expect(score.data_leaks_per_call).toBe(0);
    expect(score.behavioral_change_rate).toBe(1.0);
  });
});

describe('computeDaoScore — security_failures_per_call', () => {
  it('counts hard_block and soft_block', () => {
    const db = makeAuditDb();
    insertCall(db, { outcome: 'pass' });
    insertCall(db, { outcome: 'pass' });
    insertCall(db, { outcome: 'hard_block', block_rule: 'checkSkillWhitelist' });
    insertCall(db, { outcome: 'soft_block', block_rule: 'rateLimit' });
    const score = computeDaoScore(db);
    expect(score.security_failures_per_call).toBeCloseTo(2 / 4);
  });

  it('is 0 when all calls pass', () => {
    const db = makeAuditDb();
    for (let i = 0; i < 5; i++) insertCall(db, { outcome: 'pass' });
    expect(computeDaoScore(db).security_failures_per_call).toBe(0);
  });
});

describe('computeDaoScore — data_leaks_per_call', () => {
  it('counts only checkMemoryScope blocks', () => {
    const db = makeAuditDb();
    insertCall(db, { outcome: 'pass' });
    insertCall(db, { outcome: 'hard_block', block_rule: 'checkMemoryScope' });
    insertCall(db, { outcome: 'hard_block', block_rule: 'checkSkillWhitelist' });
    insertCall(db, { outcome: 'pass' });
    const score = computeDaoScore(db);
    expect(score.data_leaks_per_call).toBeCloseTo(1 / 4);
  });
});

describe('computeDaoScore — behavioral_change_rate', () => {
  it('is 1.0 when no blocks occurred', () => {
    const db = makeAuditDb();
    for (let i = 0; i < 5; i++) insertCall(db, { outcome: 'pass' });
    expect(computeDaoScore(db).behavioral_change_rate).toBe(1.0);
  });

  it('is 1.0 when a block rule did NOT re-fire in next 10 calls', () => {
    const db = makeAuditDb();
    const container = 'c1';
    insertCall(db, { container, outcome: 'hard_block', block_rule: 'checkSkillWhitelist' });
    // 10 subsequent passing calls — rule does not re-fire
    for (let i = 0; i < 10; i++) insertCall(db, { container, outcome: 'pass' });
    expect(computeDaoScore(db).behavioral_change_rate).toBe(1.0);
  });

  it('is 0 when every block rule re-fires within next 10 calls', () => {
    const db = makeAuditDb();
    const container = 'c2';
    insertCall(db, { container, outcome: 'hard_block', block_rule: 'checkSkillWhitelist' });
    // Re-fires in next 5 calls
    for (let i = 0; i < 4; i++) insertCall(db, { container, outcome: 'pass' });
    insertCall(db, { container, outcome: 'hard_block', block_rule: 'checkSkillWhitelist' });
    expect(computeDaoScore(db).behavioral_change_rate).toBe(0);
  });

  it('partial: some rules changed, some did not', () => {
    const db = makeAuditDb();
    const container = 'c3';
    // Rule A fired once, then does NOT re-fire → changed
    insertCall(db, { container, outcome: 'hard_block', block_rule: 'ruleA' });
    for (let i = 0; i < 10; i++) insertCall(db, { container, outcome: 'pass' });
    // Rule B fired, then re-fires within 10 → not changed
    insertCall(db, { container, outcome: 'hard_block', block_rule: 'ruleB' });
    insertCall(db, { container, outcome: 'hard_block', block_rule: 'ruleB' });
    const score = computeDaoScore(db);
    // 1 changed out of 2 distinct pairs
    expect(score.behavioral_change_rate).toBeCloseTo(0.5);
  });
});

describe('computeDaoScore — period filtering', () => {
  it('ignores calls outside the period window', () => {
    const db = makeAuditDb();
    const old = Date.now() - 10 * 60 * 60 * 1000; // 10h ago — outside 6h window
    insertCall(db, { ts: old, outcome: 'hard_block', block_rule: 'ruleX' });
    insertCall(db, { outcome: 'pass' }); // recent
    const score = computeDaoScore(db, 6 * 60 * 60 * 1000);
    expect(score.security_failures_per_call).toBe(0);
  });
});

describe('saveDaoScore / getLatestDaoScore', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `dao-rw-test-${Date.now()}.db`);
    _setDaoScoreDb(null);
  });

  afterEach(() => {
    _setDaoScoreDb(null);
    try { fs.unlinkSync(dbPath); } catch { /* ok */ }
  });

  it('round-trips a DaoScore', () => {
    const score = {
      period_start: 1000,
      period_end: 2000,
      security_failures_per_call: 0.03,
      data_leaks_per_call: 0.005,
      behavioral_change_rate: 0.8,
    };
    saveDaoScore(score, dbPath);
    const latest = getLatestDaoScore(dbPath);
    expect(latest).not.toBeNull();
    expect(latest!.security_failures_per_call).toBeCloseTo(0.03);
    expect(latest!.data_leaks_per_call).toBeCloseTo(0.005);
    expect(latest!.behavioral_change_rate).toBeCloseTo(0.8);
  });

  it('returns null when dao_score.db does not exist', () => {
    expect(getLatestDaoScore('/tmp/nonexistent-dao-score.db')).toBeNull();
  });

  it('returns the most recent snapshot when multiple exist', () => {
    saveDaoScore(
      { period_start: 0, period_end: 1, security_failures_per_call: 0.1, data_leaks_per_call: 0, behavioral_change_rate: 1 },
      dbPath,
    );
    saveDaoScore(
      { period_start: 0, period_end: 2, security_failures_per_call: 0.2, data_leaks_per_call: 0, behavioral_change_rate: 1 },
      dbPath,
    );
    const latest = getLatestDaoScore(dbPath);
    expect(latest!.security_failures_per_call).toBeCloseTo(0.2);
  });
});

describe('KPI field name contract', () => {
  it('DaoScore fields match PSYCHE.md names exactly', () => {
    const db = makeAuditDb();
    insertCall(db);
    const score = computeDaoScore(db);
    // These names are the contract between dao-score.ts and PSYCHE.md
    expect('security_failures_per_call' in score).toBe(true);
    expect('data_leaks_per_call' in score).toBe(true);
    expect('behavioral_change_rate' in score).toBe(true);
  });
});
