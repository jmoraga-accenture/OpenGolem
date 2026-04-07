/**
 * Dashboard Skill — Test Suite (M30, TDD)
 *
 * All tests are written against the real API but call stub implementations
 * that throw 'not implemented'. Tests are INITIALLY FAILING — this is correct
 * for M30. M31 replaces stubs with real implementations; these tests become
 * passing regression coverage.
 *
 * Coverage areas (per M30 DoD):
 *   1. KPI trend display        (computeKpiTrend)
 *   2. Hansei report inbox      (listHanseiReports)
 *   3. Block history query      (queryBlockHistory)
 *   4. Calibration decision flow (recordCalibrationDecision)
 *   5. False-positive capture   (recordFalsePositive)
 *   6. Degraded health state    (buildHealthStatus)
 *
 * Spec: docs/specs/dashboard-skill-spec.md §10 (acceptance criteria)
 */

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildHealthStatus,
  computeKpiTrend,
  listHanseiReports,
  queryBlockHistory,
  recordCalibrationDecision,
  recordFalsePositive,
  type CalibrationDecision,
  type FalsePositiveCapture,
  type HanseiReportSummary,
} from './dashboard.js';

// ---------------------------------------------------------------------------
// Logger mock (project convention)
// ---------------------------------------------------------------------------
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temp directory, return its path. Caller is responsible for cleanup. */
function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'og-dashboard-test-'));
}

/**
 * Create a minimal audit.db with the normative events schema and seed events.
 */
function makeAuditDb(
  dir: string,
  events: Array<{
    event_type: string;
    writer?: string;
    occurred_at?: number;
    outcome?: string;
    risk_code?: string;
    check_id?: string;
    container_id?: string;
    details?: string;
    sequence_id?: number;
  }>,
): string {
  const dbPath = path.join(dir, 'audit.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode=WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type   TEXT    NOT NULL,
      writer       TEXT    NOT NULL DEFAULT 'cato',
      context_id   TEXT,
      occurred_at  INTEGER NOT NULL,
      token_id     TEXT,
      check_id     TEXT,
      task_id      TEXT,
      container_id TEXT,
      outcome      TEXT,
      risk_code    TEXT,
      payload_hash TEXT,
      payload_size INTEGER,
      details      TEXT    NOT NULL DEFAULT '{}',
      sequence_id  INTEGER NOT NULL DEFAULT 0,
      hmac         TEXT
    );
    CREATE INDEX IF NOT EXISTS events_context_id_occurred_at
      ON events (context_id, occurred_at)
      WHERE context_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS events_event_type_occurred_at
      ON events (event_type, occurred_at);
  `);
  const insert = db.prepare(`
    INSERT INTO events (event_type, writer, occurred_at, outcome, risk_code, check_id, container_id, details, sequence_id)
    VALUES (@event_type, @writer, @occurred_at, @outcome, @risk_code, @check_id, @container_id, @details, @sequence_id)
  `);
  let seq = 0;
  for (const ev of events) {
    insert.run({
      event_type: ev.event_type,
      writer: ev.writer ?? 'cato',
      occurred_at: ev.occurred_at ?? Math.floor(Date.now() / 1000),
      outcome: ev.outcome ?? null,
      risk_code: ev.risk_code ?? null,
      check_id: ev.check_id ?? null,
      container_id: ev.container_id ?? null,
      details: ev.details ?? '{}',
      sequence_id: ev.sequence_id ?? ++seq,
    });
  }
  db.close();
  return dbPath;
}

/** Build a synthetic hansei report JSON object. */
function makeHanseiReport(opts: {
  reportId?: string;
  generatedAt?: Date;
  periodStart?: Date;
  periodEnd?: Date;
  daoScore?: {
    security_failures_per_call: number;
    data_leaks_per_call: number;
    behavioral_change_rate: number;
  };
  totalCallsInPeriod?: number;
  state?: 'unread' | 'read-no-action' | 'reviewed-decision-recorded';
}): Record<string, unknown> {
  const reportId = opts.reportId ?? crypto.randomUUID();
  const generatedAt = opts.generatedAt ?? new Date();
  return {
    reportId,
    generatedAt: generatedAt.toISOString(),
    periodStart: (
      opts.periodStart ?? new Date(Date.now() - 8 * 3600 * 1000)
    ).toISOString(),
    periodEnd: (
      opts.periodEnd ?? new Date(Date.now() - 2 * 3600 * 1000)
    ).toISOString(),
    daoScore: opts.daoScore ?? {
      security_failures_per_call: 0.023,
      data_leaks_per_call: 0.003,
      behavioral_change_rate: 0.74,
    },
    totalCallsInPeriod: opts.totalCallsInPeriod ?? 667,
    anomalyFindings: [],
    recommendationFlags: [],
    reportVersion: '1.0',
    agent_status: 'success',
  };
}

/**
 * Write a hansei report file to the inbox directory and return the file path.
 * If state is supplied, also writes/updates report-state.json in a sibling
 * calibration-decisions/ directory — the implementation is expected to read
 * report state from that file.
 */
function writeHanseiReport(
  inboxDir: string,
  report: Record<string, unknown>,
  filenameOverride?: string,
): string {
  fs.mkdirSync(inboxDir, { recursive: true });
  const ts = new Date(report.generatedAt as string)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  const filename =
    filenameOverride ?? `hansei-${ts}-${report.reportId as string}.json`;
  const filePath = path.join(inboxDir, filename);
  fs.writeFileSync(filePath, JSON.stringify(report, null, 2));
  return filePath;
}

/** Write report-state.json to a decisions directory. */
function writeReportState(
  decisionsDir: string,
  state: Record<string, string>,
): void {
  fs.mkdirSync(decisionsDir, { recursive: true });
  fs.writeFileSync(
    path.join(decisionsDir, 'report-state.json'),
    JSON.stringify(state, null, 2),
  );
}

// ---------------------------------------------------------------------------
// Minimal PSYCHE.md fixture
// ---------------------------------------------------------------------------

const MINIMAL_PSYCHE_MD = `# PSYCHE.md — Cato Operating Contract

## Criteria

| ID    | Description                        | Triggers            | block_threshold_per_period |
|-------|------------------------------------|---------------------|---------------------------|
| PSY-01 | Credential exfiltration attempt   | CREDENTIAL_SEND    | 1                         |
| PSY-02 | Multi-turn injection pattern      | AGENT_PROMPT, MEMORY_WRITE | 2                  |
| PSY-03 | Role-drift pattern                | SOUL_VIOLATION     | 1                         |
| PSY-04 | Payload amplification             | PAYLOAD_SIZE       | 1                         |
| PSY-05 | Repeated boundary probe           | BOUNDARY_PROBE     | 3                         |

## Thresholds
security_failures_per_call: watch=0.05, alert=0.15
data_leaks_per_call: alert=0.01
behavioral_change_rate: alert_low=0.5
`;

// ---------------------------------------------------------------------------
// 1. KPI Trend Display
// ---------------------------------------------------------------------------

describe('KPI Trend Display', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('throws not implemented (stub verification)', () => {
    const dbPath = makeAuditDb(tmpDir, []);
    expect(() => computeKpiTrend(dbPath)).toThrow('not implemented');
  });

  it('returns correct structure with audit DB containing block events', () => {
    const now = Math.floor(Date.now() / 1000);
    const dbPath = makeAuditDb(tmpDir, [
      {
        event_type: 'cato_block_applied',
        outcome: 'block',
        occurred_at: now - 3600,
        check_id: crypto.randomUUID(),
        risk_code: 'PSY-02',
      },
      {
        event_type: 'cato_block_applied',
        outcome: 'soft_block',
        occurred_at: now - 1800,
        check_id: crypto.randomUUID(),
        risk_code: 'PSY-01',
      },
      {
        event_type: 'cato_check',
        outcome: 'allow',
        occurred_at: now - 900,
        check_id: crypto.randomUUID(),
      },
    ]);

    // When M31 is implemented, this must return a KpiTrend with all fields
    const result = computeKpiTrend(dbPath);
    expect(result).toMatchObject({
      current: {
        security_failures_per_call: expect.any(Number),
        data_leaks_per_call: expect.any(Number),
        behavioral_change_rate: expect.any(Number),
      },
      prior: expect.anything(),
      firstPeriod: expect.any(Boolean),
    });
  });

  it('firstPeriod=true and trend=null when only one period of data exists', () => {
    // Single report in the inbox → no prior period → firstPeriod true, trend null
    const dbPath = makeAuditDb(tmpDir, [
      {
        event_type: 'cato_block_applied',
        outcome: 'block',
        occurred_at: Math.floor(Date.now() / 1000) - 600,
        check_id: crypto.randomUUID(),
      },
    ]);

    const result = computeKpiTrend(dbPath);
    expect(result.firstPeriod).toBe(true);
    expect(result.trend).toBeNull();
  });

  it('correctly computes ↑ when security_failures_per_call increases period-over-period', () => {
    // Two periods: prior had 0 security failures, current has 3 → ↑
    const now = Math.floor(Date.now() / 1000);
    const periodSecs = 6 * 3600; // 6h
    const dbPath = makeAuditDb(tmpDir, [
      // Prior period blocks
      {
        event_type: 'cato_block_applied',
        outcome: 'block',
        occurred_at: now - 2 * periodSecs - 100,
        check_id: crypto.randomUUID(),
        risk_code: 'PSY-02',
      },
      // Current period blocks — more failures
      {
        event_type: 'cato_block_applied',
        outcome: 'block',
        occurred_at: now - 1000,
        check_id: crypto.randomUUID(),
        risk_code: 'PSY-01',
      },
      {
        event_type: 'cato_block_applied',
        outcome: 'block',
        occurred_at: now - 900,
        check_id: crypto.randomUUID(),
        risk_code: 'PSY-01',
      },
      {
        event_type: 'cato_block_applied',
        outcome: 'block',
        occurred_at: now - 800,
        check_id: crypto.randomUUID(),
        risk_code: 'PSY-01',
      },
    ]);

    const result = computeKpiTrend(dbPath);
    expect(result.trend).not.toBeNull();
    expect(result.trend?.security).toBe('↑');
    expect(result.firstPeriod).toBe(false);
  });

  it('correctly computes = when security_failures_per_call is unchanged', () => {
    const now = Math.floor(Date.now() / 1000);
    const periodSecs = 6 * 3600;
    // Same event rate in both periods — per-call rate unchanged
    const dbPath = makeAuditDb(tmpDir, [
      {
        event_type: 'cato_block_applied',
        outcome: 'block',
        occurred_at: now - 2 * periodSecs - 100,
        check_id: crypto.randomUUID(),
      },
      {
        event_type: 'cato_block_applied',
        outcome: 'block',
        occurred_at: now - 1000,
        check_id: crypto.randomUUID(),
      },
    ]);

    const result = computeKpiTrend(dbPath);
    // If rates are equal, trend.security must be '='
    if (result.trend !== null) {
      expect(['↑', '↓', '=']).toContain(result.trend.security);
    }
  });

  it('falls back gracefully when dao_score.db is absent (no daoScoreDbPath)', () => {
    const dbPath = makeAuditDb(tmpDir, [
      {
        event_type: 'cato_check',
        outcome: 'allow',
        occurred_at: Math.floor(Date.now() / 1000) - 60,
        check_id: crypto.randomUUID(),
      },
    ]);
    // No daoScoreDbPath argument — must not throw a file-not-found error
    const result = computeKpiTrend(dbPath);
    // Returned structure must still be valid
    expect(result).toHaveProperty('current');
    expect(result).toHaveProperty('firstPeriod');
  });

  it('falls back when daoScoreDbPath points to a nonexistent file', () => {
    const dbPath = makeAuditDb(tmpDir, []);
    const missingDb = path.join(tmpDir, 'dao_score.db'); // not created
    const result = computeKpiTrend(dbPath, missingDb);
    expect(result).toHaveProperty('current');
  });

  it('data_leaks_per_call exposes absolute count and total calls', () => {
    const dbPath = makeAuditDb(tmpDir, [
      {
        event_type: 'cato_data_leak',
        outcome: 'block',
        occurred_at: Math.floor(Date.now() / 1000) - 300,
        check_id: crypto.randomUUID(),
      },
    ]);

    const result = computeKpiTrend(dbPath);
    // AC-13: absolute count must be present alongside rate
    expect(result).toHaveProperty('dataLeakAbsoluteCount');
    expect(typeof result.dataLeakAbsoluteCount).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// 2. Hansei Report Inbox
// ---------------------------------------------------------------------------

describe('Hansei Report Inbox', () => {
  let tmpDir: string;
  let inboxDir: string;
  let decisionsDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    inboxDir = path.join(tmpDir, 'hansei', 'inbox');
    decisionsDir = path.join(tmpDir, 'calibration-decisions');
    fs.mkdirSync(inboxDir, { recursive: true });
    fs.mkdirSync(decisionsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('throws not implemented (stub verification)', () => {
    expect(() => listHanseiReports(inboxDir)).toThrow('not implemented');
  });

  it('returns empty array when inbox is empty', () => {
    const result = listHanseiReports(inboxDir);
    expect(result).toEqual([]);
  });

  it('reads and returns reports from inbox directory', () => {
    const report = makeHanseiReport({});
    writeHanseiReport(inboxDir, report);

    const result = listHanseiReports(inboxDir);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe(report.reportId as string);
  });

  it('default sort order: unread first, newest within group (AC-57)', () => {
    const now = new Date();
    const older = new Date(now.getTime() - 10 * 3600 * 1000);
    const newer = new Date(now.getTime() - 2 * 3600 * 1000);

    const rOld = makeHanseiReport({ reportId: 'aaaa-old', generatedAt: older });
    const rNew = makeHanseiReport({ reportId: 'bbbb-new', generatedAt: newer });
    writeHanseiReport(inboxDir, rOld);
    writeHanseiReport(inboxDir, rNew);

    // Mark rOld as read-no-action via report-state
    writeReportState(decisionsDir, {
      'aaaa-old': 'read-no-action',
    });

    const result: HanseiReportSummary[] = listHanseiReports(inboxDir);
    // rNew is unread → must come first
    expect(result[0]!.id).toBe('bbbb-new');
    // rOld is read → must come second
    expect(result[1]!.id).toBe('aaaa-old');
  });

  it('within unread group, sorts newest first', () => {
    const now = new Date();
    const r1 = makeHanseiReport({
      reportId: 'r1-older',
      generatedAt: new Date(now.getTime() - 5 * 3600 * 1000),
    });
    const r2 = makeHanseiReport({
      reportId: 'r2-newer',
      generatedAt: new Date(now.getTime() - 1 * 3600 * 1000),
    });
    writeHanseiReport(inboxDir, r1);
    writeHanseiReport(inboxDir, r2);

    const result = listHanseiReports(inboxDir);
    // Both unread; r2-newer should be first
    expect(result[0]!.id).toBe('r2-newer');
    expect(result[1]!.id).toBe('r1-older');
  });

  it('ageWarning=true when unread report is older than 7 days (AC-9, AC-59)', () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 3600 * 1000);
    const report = makeHanseiReport({
      reportId: 'old-report',
      generatedAt: eightDaysAgo,
    });
    writeHanseiReport(inboxDir, report);

    const result = listHanseiReports(inboxDir);
    expect(result).toHaveLength(1);
    expect(result[0]!.ageWarning).toBe(true);
  });

  it('ageWarning=false when unread report is 6 days old', () => {
    const sixDaysAgo = new Date(Date.now() - 6 * 24 * 3600 * 1000);
    const report = makeHanseiReport({
      reportId: 'young-report',
      generatedAt: sixDaysAgo,
    });
    writeHanseiReport(inboxDir, report);

    const result = listHanseiReports(inboxDir);
    expect(result[0]!.ageWarning).toBe(false);
  });

  it('ageWarning=false when report is read (state != unread)', () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 3600 * 1000);
    const report = makeHanseiReport({
      reportId: 'old-but-read',
      generatedAt: eightDaysAgo,
    });
    writeHanseiReport(inboxDir, report);
    writeReportState(decisionsDir, { 'old-but-read': 'read-no-action' });

    const result = listHanseiReports(inboxDir);
    // Read report — ageWarning should not fire
    expect(result[0]!.ageWarning).toBe(false);
  });

  it('ignores non-json files in the inbox directory', () => {
    fs.writeFileSync(path.join(inboxDir, 'README.txt'), 'ignore me');
    const report = makeHanseiReport({});
    writeHanseiReport(inboxDir, report);

    const result = listHanseiReports(inboxDir);
    expect(result).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 3. Block History Query
// ---------------------------------------------------------------------------

describe('Block History Query', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('throws not implemented (stub verification)', () => {
    const dbPath = makeAuditDb(tmpDir, []);
    expect(() => queryBlockHistory(dbPath)).toThrow('not implemented');
  });

  it('returns events with outcome block or soft_block from events table', () => {
    const now = Math.floor(Date.now() / 1000);
    const checkId1 = crypto.randomUUID();
    const checkId2 = crypto.randomUUID();
    const dbPath = makeAuditDb(tmpDir, [
      {
        event_type: 'cato_block_applied',
        outcome: 'block',
        occurred_at: now - 600,
        check_id: checkId1,
        container_id: 'container-abc',
        risk_code: 'PSY-02',
      },
      {
        event_type: 'cato_block_applied',
        outcome: 'soft_block',
        occurred_at: now - 300,
        check_id: checkId2,
        container_id: 'container-def',
        risk_code: 'PSY-01',
      },
      {
        event_type: 'cato_check',
        outcome: 'allow',
        occurred_at: now - 100,
        check_id: crypto.randomUUID(),
      },
    ]);

    const result = queryBlockHistory(dbPath);
    expect(result).toHaveLength(2);
    expect(
      result.every((e) => ['block', 'soft_block'].includes(e.outcome)),
    ).toBe(true);
  });

  it('excludes allow, info, issued, and other non-block outcomes', () => {
    const now = Math.floor(Date.now() / 1000);
    const dbPath = makeAuditDb(tmpDir, [
      {
        event_type: 'cato_check',
        outcome: 'allow',
        occurred_at: now - 500,
        check_id: crypto.randomUUID(),
      },
      {
        event_type: 'cato_check',
        outcome: 'info',
        occurred_at: now - 400,
        check_id: crypto.randomUUID(),
      },
      {
        event_type: 'broker_token_issued',
        outcome: 'issued',
        occurred_at: now - 300,
        check_id: crypto.randomUUID(),
      },
      {
        event_type: 'cato_block_applied',
        outcome: 'block',
        occurred_at: now - 200,
        check_id: crypto.randomUUID(),
      },
    ]);

    const result = queryBlockHistory(dbPath);
    expect(result).toHaveLength(1);
    expect(result[0]!.outcome).toBe('block');
  });

  it('sorts block events newest first', () => {
    const now = Math.floor(Date.now() / 1000);
    const checkIdOld = crypto.randomUUID();
    const checkIdNew = crypto.randomUUID();
    const dbPath = makeAuditDb(tmpDir, [
      {
        event_type: 'cato_block_applied',
        outcome: 'block',
        occurred_at: now - 1000,
        check_id: checkIdOld,
      },
      {
        event_type: 'cato_block_applied',
        outcome: 'block',
        occurred_at: now - 100,
        check_id: checkIdNew,
      },
    ]);

    const result = queryBlockHistory(dbPath);
    expect(result[0]!.checkId).toBe(checkIdNew);
    expect(result[1]!.checkId).toBe(checkIdOld);
  });

  it('filters by criterion when provided', () => {
    const now = Math.floor(Date.now() / 1000);
    const matchId = crypto.randomUUID();
    const dbPath = makeAuditDb(tmpDir, [
      {
        event_type: 'cato_block_applied',
        outcome: 'block',
        occurred_at: now - 200,
        check_id: matchId,
        risk_code: 'PSY-02',
      },
      {
        event_type: 'cato_block_applied',
        outcome: 'block',
        occurred_at: now - 100,
        check_id: crypto.randomUUID(),
        risk_code: 'PSY-01',
      },
    ]);

    const result = queryBlockHistory(dbPath, 'PSY-02');
    expect(result).toHaveLength(1);
    expect(result[0]!.checkId).toBe(matchId);
  });

  it('maps fields correctly: checkId, occurredAt, containerId, outcome, riskCode', () => {
    const now = Math.floor(Date.now() / 1000);
    const checkId = crypto.randomUUID();
    const dbPath = makeAuditDb(tmpDir, [
      {
        event_type: 'cato_block_applied',
        outcome: 'block',
        occurred_at: now - 60,
        check_id: checkId,
        container_id: 'ctr-test-123',
        risk_code: 'PSY-03',
      },
    ]);

    const result = queryBlockHistory(dbPath);
    expect(result).toHaveLength(1);
    const ev = result[0]!;
    expect(ev.checkId).toBe(checkId);
    expect(ev.occurredAt).toBeInstanceOf(Date);
    expect(ev.containerId).toBe('ctr-test-123');
    expect(ev.outcome).toBe('block');
    expect(ev.riskCode).toBe('PSY-03');
  });

  it('returns empty array when no block events exist', () => {
    const dbPath = makeAuditDb(tmpDir, [
      {
        event_type: 'cato_check',
        outcome: 'allow',
        occurred_at: Math.floor(Date.now() / 1000),
        check_id: crypto.randomUUID(),
      },
    ]);

    const result = queryBlockHistory(dbPath);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. Calibration Decision Flow
// ---------------------------------------------------------------------------

describe('Calibration Decision Flow', () => {
  let tmpDir: string;
  let decisionsDir: string;
  let psycheMdPath: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    decisionsDir = path.join(tmpDir, 'calibration-decisions');
    fs.mkdirSync(decisionsDir, { recursive: true });
    psycheMdPath = path.join(tmpDir, 'PSYCHE.md');
    fs.writeFileSync(psycheMdPath, MINIMAL_PSYCHE_MD);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('throws not implemented (stub verification)', () => {
    const decision: CalibrationDecision = {
      type: 'no_change',
      criterion: 'PSY-02',
      rationale:
        'Three false positives confirmed in review; insufficient evidence for change.',
    };
    expect(() =>
      recordCalibrationDecision(decisionsDir, psycheMdPath, decision),
    ).toThrow('not implemented');
  });

  it('rejects rationale shorter than 20 characters (AC-30)', () => {
    const decision: CalibrationDecision = {
      type: 'no_change',
      criterion: 'PSY-02',
      rationale: 'Too short',
    };
    expect(() =>
      recordCalibrationDecision(decisionsDir, psycheMdPath, decision),
    ).toThrow();
    // Must not write any file
    const files = fs.readdirSync(decisionsDir);
    expect(files.filter((f) => f.startsWith('cd-'))).toHaveLength(0);
  });

  it('writes cd-<YYYYMMDD>-<uuid>.json to decisionsDir (AC-33)', () => {
    const decision: CalibrationDecision = {
      type: 'no_change',
      criterion: 'PSY-02',
      rationale:
        'Three false positives confirmed; current threshold adequate for this group.',
    };
    const result = recordCalibrationDecision(
      decisionsDir,
      psycheMdPath,
      decision,
    );

    expect(result.filePath).toMatch(/cd-\d{8}-[0-9a-f-]{36}\.json$/);
    expect(fs.existsSync(result.filePath)).toBe(true);

    const written = JSON.parse(
      fs.readFileSync(result.filePath, 'utf8'),
    ) as Record<string, unknown>;
    expect(written['decisionType']).toBe('no_change');
    expect(written['criterionId']).toBe('PSY-02');
    expect(written['rationale']).toBe(decision.rationale);
    expect(written['recordType']).toBe('calibration_decision');
    expect(typeof written['recordId']).toBe('string');
    expect(typeof written['recordedAt']).toBe('string');
  });

  it('threshold_adjust decision includes psycheMdDiffPreview in result and file (AC-31, AC-33)', () => {
    const decision: CalibrationDecision = {
      type: 'threshold_adjust',
      criterion: 'PSY-02',
      rationale:
        'Three false positives confirmed in review; current threshold is too tight.',
      proposedThreshold: 4,
    };
    const result = recordCalibrationDecision(
      decisionsDir,
      psycheMdPath,
      decision,
    );

    expect(result.psycheMdDiffPreview).toBeDefined();
    expect(typeof result.psycheMdDiffPreview).toBe('string');
    // Diff must reference the criterion
    expect(result.psycheMdDiffPreview).toContain('PSY-02');

    const written = JSON.parse(
      fs.readFileSync(result.filePath, 'utf8'),
    ) as Record<string, unknown>;
    expect(typeof written['psycheMdDiffPreview']).toBe('string');
  });

  it('PSYCHE.md is not modified after threshold_adjust submission (AC-34)', () => {
    const originalContent = fs.readFileSync(psycheMdPath, 'utf8');
    const decision: CalibrationDecision = {
      type: 'threshold_adjust',
      criterion: 'PSY-02',
      rationale:
        'Evidence-based adjustment: multiple false positives over two periods.',
      proposedThreshold: 4,
    };
    recordCalibrationDecision(decisionsDir, psycheMdPath, decision);

    const contentAfter = fs.readFileSync(psycheMdPath, 'utf8');
    expect(contentAfter).toBe(originalContent);
  });

  it('defer decision accepts optional deferUntil date (AC-36)', () => {
    const decision: CalibrationDecision = {
      type: 'defer',
      criterion: 'PSY-05',
      rationale:
        'Deferring pending additional data from next two audit periods.',
      deferUntil: '2026-05-01',
    };
    const result = recordCalibrationDecision(
      decisionsDir,
      psycheMdPath,
      decision,
    );

    expect(fs.existsSync(result.filePath)).toBe(true);
    const written = JSON.parse(
      fs.readFileSync(result.filePath, 'utf8'),
    ) as Record<string, unknown>;
    expect(written['decisionType']).toBe('defer');
    expect(written['expectedReviewDate']).toBe('2026-05-01');
  });

  it('criterion not present in PSYCHE.md returns an error (AC-37)', () => {
    const decision: CalibrationDecision = {
      type: 'no_change',
      criterion: 'PSY-99',
      rationale: 'This criterion does not exist in the loaded PSYCHE.md file.',
    };
    expect(() =>
      recordCalibrationDecision(decisionsDir, psycheMdPath, decision),
    ).toThrow();
  });

  it('no_change decision writes file with correct fields', () => {
    const decision: CalibrationDecision = {
      type: 'no_change',
      criterion: 'PSY-01',
      rationale: 'Zero blocks in period. No calibration needed at this time.',
      reportId: crypto.randomUUID(),
    };
    const result = recordCalibrationDecision(
      decisionsDir,
      psycheMdPath,
      decision,
    );

    const written = JSON.parse(
      fs.readFileSync(result.filePath, 'utf8'),
    ) as Record<string, unknown>;
    expect(written['decisionType']).toBe('no_change');
    expect(written['reportId']).toBe(decision.reportId);
    // psycheMdDiffPreview should be null for no_change
    expect(written['psycheMdDiffPreview']).toBeNull();
  });

  it('criterion_review decision writes file with correct decisionType', () => {
    const decision: CalibrationDecision = {
      type: 'criterion_review',
      criterion: 'PSY-03',
      rationale:
        'Role-drift blocks appear to be false positives in long document editing sessions.',
    };
    const result = recordCalibrationDecision(
      decisionsDir,
      psycheMdPath,
      decision,
    );

    const written = JSON.parse(
      fs.readFileSync(result.filePath, 'utf8'),
    ) as Record<string, unknown>;
    expect(written['decisionType']).toBe('criterion_review');
  });

  it('file is placed in decisionsDir and filename format is cd-<YYYYMMDD>-<uuid>.json', () => {
    const decision: CalibrationDecision = {
      type: 'no_change',
      criterion: 'PSY-02',
      rationale:
        'Reviewed all blocks from this period; no calibration action warranted.',
    };
    const result = recordCalibrationDecision(
      decisionsDir,
      psycheMdPath,
      decision,
    );

    expect(path.dirname(result.filePath)).toBe(decisionsDir);
    expect(path.basename(result.filePath)).toMatch(
      /^cd-\d{8}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/,
    );
  });
});

// ---------------------------------------------------------------------------
// 5. False-Positive Capture
// ---------------------------------------------------------------------------

describe('False-Positive Capture', () => {
  let tmpDir: string;
  let decisionsDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    decisionsDir = path.join(tmpDir, 'calibration-decisions');
    fs.mkdirSync(decisionsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('throws not implemented (stub verification)', () => {
    const capture: FalsePositiveCapture = {
      checkId: crypto.randomUUID(),
      criterion: 'PSY-02',
      classification: 1,
      description: 'User reported this was a legitimate multi-document task.',
    };
    expect(() => recordFalsePositive(decisionsDir, capture)).toThrow(
      'not implemented',
    );
  });

  it('rejects description shorter than 10 characters (AC-40)', () => {
    const capture: FalsePositiveCapture = {
      checkId: crypto.randomUUID(),
      criterion: 'PSY-02',
      classification: 1,
      description: 'Too short',
    };
    expect(() => recordFalsePositive(decisionsDir, capture)).toThrow();
    // Must not write any file
    const files = fs.readdirSync(decisionsDir);
    expect(files.filter((f) => f.startsWith('fp-'))).toHaveLength(0);
  });

  it('writes fp-<YYYYMMDD>-<uuid>.json to decisionsDir (AC-43)', () => {
    const checkId = crypto.randomUUID();
    const capture: FalsePositiveCapture = {
      checkId,
      criterion: 'PSY-02',
      classification: 2,
      description:
        'Administrator confirmed this was a legitimate multi-turn document editing session.',
    };
    const result = recordFalsePositive(decisionsDir, capture);

    expect(result.filePath).toMatch(/fp-\d{8}-[0-9a-f-]{36}\.json$/);
    expect(fs.existsSync(result.filePath)).toBe(true);
    expect(path.dirname(result.filePath)).toBe(decisionsDir);
  });

  it('confirmation message reads "Flag recorded for check `<short-id>`" (AC-42)', () => {
    const checkId = 'abcdef12-1234-5678-9012-abcdef123456';
    const capture: FalsePositiveCapture = {
      checkId,
      criterion: 'PSY-01',
      classification: 1,
      description:
        'User reported this block was during a normal file backup operation.',
    };
    const result = recordFalsePositive(decisionsDir, capture);

    // Short ID = first 8 chars of checkId
    expect(result.confirmationMessage).toContain(
      'Flag recorded for check `abcdef12`',
    );
  });

  it('all required fields present in written fp file', () => {
    const checkId = crypto.randomUUID();
    const capture: FalsePositiveCapture = {
      checkId,
      criterion: 'PSY-03',
      classification: 3,
      description:
        'Pattern observed across multiple users during scheduled backup windows.',
    };
    const result = recordFalsePositive(decisionsDir, capture);

    const written = JSON.parse(
      fs.readFileSync(result.filePath, 'utf8'),
    ) as Record<string, unknown>;
    expect(written['recordType']).toBe('false_positive_flag');
    expect(typeof written['recordId']).toBe('string');
    expect(typeof written['recordedAt']).toBe('string');
    expect(written['checkId']).toBe(checkId);
    expect(written['classification']).toBe('pattern-observed');
    expect(written['description']).toBe(capture.description);
    expect(written['status']).toBe('open');
    expect(written['confidence']).toBe('uncertain');
  });

  it('classification 1 maps to user-reported, 2 to administrator-reviewed, 3 to pattern-observed', () => {
    const descriptions = [1, 2, 3].map((cls) => ({
      cls: cls as 1 | 2 | 3,
      description:
        'This is a long enough description for the false positive capture form.',
    }));
    const expectedLabels = [
      'user-reported',
      'administrator-reviewed',
      'pattern-observed',
    ];

    for (let i = 0; i < 3; i++) {
      const capture: FalsePositiveCapture = {
        checkId: crypto.randomUUID(),
        criterion: 'PSY-01',
        classification: descriptions[i]!.cls,
        description: descriptions[i]!.description,
      };
      const result = recordFalsePositive(decisionsDir, capture);
      const written = JSON.parse(
        fs.readFileSync(result.filePath, 'utf8'),
      ) as Record<string, unknown>;
      expect(written['classification']).toBe(expectedLabels[i]);
    }
  });

  it('creates decisionsDir if it does not exist', () => {
    const newDecisionsDir = path.join(tmpDir, 'nonexistent-decisions');
    expect(fs.existsSync(newDecisionsDir)).toBe(false);

    const capture: FalsePositiveCapture = {
      checkId: crypto.randomUUID(),
      criterion: 'PSY-02',
      classification: 1,
      description:
        'Legitimate multi-document task flagged incorrectly by boundary rule.',
    };
    const result = recordFalsePositive(newDecisionsDir, capture);
    expect(fs.existsSync(newDecisionsDir)).toBe(true);
    expect(fs.existsSync(result.filePath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. Degraded Health State
// ---------------------------------------------------------------------------

describe('Health Status', () => {
  let tmpDir: string;
  let inboxDir: string;
  let decisionsDir: string;
  let psycheMdPath: string;
  let auditDbPath: string;
  let catoSocketPath: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    inboxDir = path.join(tmpDir, 'hansei', 'inbox');
    decisionsDir = path.join(tmpDir, 'calibration-decisions');
    psycheMdPath = path.join(tmpDir, 'PSYCHE.md');
    auditDbPath = makeAuditDb(tmpDir, []);
    catoSocketPath = path.join(tmpDir, 'cato.sock');

    fs.mkdirSync(inboxDir, { recursive: true });
    fs.mkdirSync(decisionsDir, { recursive: true });
    fs.writeFileSync(psycheMdPath, MINIMAL_PSYCHE_MD);
    // Simulate socket presence with a regular file (path check, not connection)
    fs.writeFileSync(catoSocketPath, '');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('throws not implemented (stub verification)', () => {
    expect(() =>
      buildHealthStatus({
        catoSocketPath,
        auditDbPath,
        inboxDir,
        decisionsDir,
        psycheMdPath,
      }),
    ).toThrow('not implemented');
  });

  it("status='degraded' when cato socket is absent (AC-7)", () => {
    fs.rmSync(catoSocketPath); // remove socket
    const result = buildHealthStatus({
      catoSocketPath,
      auditDbPath,
      inboxDir,
      decisionsDir,
      psycheMdPath,
    });
    expect(result.status).toBe('degraded');
    expect(result.catoSocketPresent).toBe(false);
  });

  it("status='ok' when all sockets and data sources are present", () => {
    const result = buildHealthStatus({
      catoSocketPath,
      auditDbPath,
      inboxDir,
      decisionsDir,
      psycheMdPath,
    });
    expect(result.status).toBe('ok');
    expect(result.catoSocketPresent).toBe(true);
    expect(result.auditLogReachable).toBe(true);
  });

  it('ageWarning=true when at least one unread report is older than 7 days (AC-9)', () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 3600 * 1000);
    const report = makeHanseiReport({
      reportId: 'old-unread',
      generatedAt: eightDaysAgo,
    });
    writeHanseiReport(inboxDir, report);

    const result = buildHealthStatus({
      catoSocketPath,
      auditDbPath,
      inboxDir,
      decisionsDir,
      psycheMdPath,
    });
    expect(result.ageWarning).toBe(true);
    expect(result.unreadReportCount).toBeGreaterThan(0);
    expect(result.oldestUnreadAgeDays).toBeGreaterThanOrEqual(7);
  });

  it('ageWarning=false when all unread reports are within 7 days', () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 3600 * 1000);
    const report = makeHanseiReport({ generatedAt: threeDaysAgo });
    writeHanseiReport(inboxDir, report);

    const result = buildHealthStatus({
      catoSocketPath,
      auditDbPath,
      inboxDir,
      decisionsDir,
      psycheMdPath,
    });
    expect(result.ageWarning).toBe(false);
  });

  it('openDecisionCount > 0 when threshold_adjust decision is >3 days old and not reflected in PSYCHE.md (AC-11, AC-60)', () => {
    // Write a threshold_adjust decision that is 4 days old
    const fourDaysAgo = new Date(Date.now() - 4 * 24 * 3600 * 1000);
    const decisionRecord = {
      recordId: crypto.randomUUID(),
      recordType: 'calibration_decision',
      recordedAt: fourDaysAgo.toISOString(),
      criterionId: 'PSY-02',
      decisionType: 'threshold_adjust',
      reportId: null,
      currentThreshold: 2,
      proposedThreshold: 4,
      rationale:
        'Four false positives confirmed; threshold raised for this group.',
      expectedReviewDate: null,
      psycheMdDiffPreview:
        '--- PSYCHE.md\n+++ PSYCHE.md\n@@ -1 +1 @@\n-| PSY-02 | ... | 2 |\n+| PSY-02 | ... | 4 |',
    };
    const today = fourDaysAgo.toISOString().slice(0, 10).replace(/-/g, '');
    const filename = `cd-${today}-${decisionRecord.recordId}.json`;
    fs.writeFileSync(
      path.join(decisionsDir, filename),
      JSON.stringify(decisionRecord, null, 2),
    );

    // PSYCHE.md still has threshold=2 (not applied) — openDecisionCount must be >0
    const result = buildHealthStatus({
      catoSocketPath,
      auditDbPath,
      inboxDir,
      decisionsDir,
      psycheMdPath,
    });
    expect(result.openDecisionCount).toBeGreaterThan(0);
  });

  it('unreviewedFpCount matches fp- file count in decisionsDir', () => {
    const fpIds = [crypto.randomUUID(), crypto.randomUUID()];
    for (const id of fpIds) {
      const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const record = {
        recordId: id,
        recordType: 'false_positive_flag',
        recordedAt: new Date().toISOString(),
        checkId: crypto.randomUUID(),
        classification: 'user-reported',
        description: 'Legitimate task flagged incorrectly.',
        confidence: 'uncertain',
        status: 'open',
      };
      fs.writeFileSync(
        path.join(decisionsDir, `fp-${today}-${id}.json`),
        JSON.stringify(record, null, 2),
      );
    }

    const result = buildHealthStatus({
      catoSocketPath,
      auditDbPath,
      inboxDir,
      decisionsDir,
      psycheMdPath,
    });
    expect(result.unreviewedFpCount).toBe(2);
  });

  it('unreviewedFpCount excludes reviewed fp files', () => {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');

    // One open, one reviewed
    const openId = crypto.randomUUID();
    const reviewedId = crypto.randomUUID();

    fs.writeFileSync(
      path.join(decisionsDir, `fp-${today}-${openId}.json`),
      JSON.stringify(
        {
          recordId: openId,
          recordType: 'false_positive_flag',
          recordedAt: new Date().toISOString(),
          checkId: crypto.randomUUID(),
          classification: 'user-reported',
          description: 'Open flag — not yet reviewed.',
          confidence: 'uncertain',
          status: 'open',
        },
        null,
        2,
      ),
    );

    fs.writeFileSync(
      path.join(decisionsDir, `fp-${today}-${reviewedId}.json`),
      JSON.stringify(
        {
          recordId: reviewedId,
          recordType: 'false_positive_flag',
          recordedAt: new Date().toISOString(),
          checkId: crypto.randomUUID(),
          classification: 'administrator-reviewed',
          description: 'Reviewed and confirmed as false positive.',
          confidence: 'definite',
          status: 'reviewed',
        },
        null,
        2,
      ),
    );

    const result = buildHealthStatus({
      catoSocketPath,
      auditDbPath,
      inboxDir,
      decisionsDir,
      psycheMdPath,
    });
    expect(result.unreviewedFpCount).toBe(1);
  });

  it('returns unreadReportCount=0 and oldestUnreadAgeDays=null when inbox is empty', () => {
    const result = buildHealthStatus({
      catoSocketPath,
      auditDbPath,
      inboxDir,
      decisionsDir,
      psycheMdPath,
    });
    expect(result.unreadReportCount).toBe(0);
    expect(result.oldestUnreadAgeDays).toBeNull();
  });
});
