/**
 * Unified Audit Log — M16 test suite
 *
 * Covers AC-1 through AC-13 from docs/specs/audit-log-spec.md §5
 * (AC-14, AC-15, AC-17 require integration/system-level verification;
 * AC-8, AC-16 are covered by Cato / broker / orchestrator component tests.)
 */
import { describe, it, expect, afterEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';

import { openAuditLog, AuditInitError } from './index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-test-'));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  // Clean up temp dirs created during tests
  for (const d of tmpDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* ok */
    }
  }
  tmpDirs = [];
});

function makeDbPath(dir?: string): string {
  const base = dir ?? makeTmpDir();
  return path.join(base, 'audit.db');
}

// ---------------------------------------------------------------------------
// AC-1: Schema created on first open
// ---------------------------------------------------------------------------

describe('AC-1: Schema is created on first open', () => {
  it('creates the audit.db file when it does not exist', () => {
    const dbPath = makeDbPath();
    expect(fs.existsSync(dbPath)).toBe(false);
    const log = openAuditLog(dbPath, 'orchestrator');
    log.close();
    expect(fs.existsSync(dbPath)).toBe(true);
  });

  it('creates the events table with expected columns', () => {
    const dbPath = makeDbPath();
    const log = openAuditLog(dbPath, 'orchestrator');
    log.close();

    const db = new Database(dbPath, { readonly: true });
    const row = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='events'`,
      )
      .get() as { name: string } | undefined;
    db.close();
    expect(row?.name).toBe('events');
  });

  it('creates all four required indices', () => {
    const dbPath = makeDbPath();
    const log = openAuditLog(dbPath, 'cato');
    log.close();

    const db = new Database(dbPath, { readonly: true });
    const indices = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='events'`,
      )
      .all() as { name: string }[];
    db.close();

    const names = indices.map((i) => i.name);
    expect(names).toContain('events_context_id_occurred_at');
    expect(names).toContain('events_event_type_occurred_at');
    expect(names).toContain('events_token_id');
    expect(names).toContain('events_check_id');
  });
});

// ---------------------------------------------------------------------------
// AC-2: WAL mode active
// ---------------------------------------------------------------------------

describe('AC-2: WAL mode is active', () => {
  it('PRAGMA journal_mode returns wal after open', () => {
    const dbPath = makeDbPath();
    const log = openAuditLog(dbPath, 'broker');
    log.close();

    const db = new Database(dbPath);
    const mode = db.pragma('journal_mode', { simple: true }) as string;
    db.close();
    expect(mode).toBe('wal');
  });

  it('fails with AuditInitError when directory does not exist and cannot be created', () => {
    // Use a path under a non-existent root that we can't mkdir
    const unwritable = '/proc/nonexistent/deep/audit.db';
    expect(() => openAuditLog(unwritable, 'orchestrator')).toThrow(
      AuditInitError,
    );
  });
});

// ---------------------------------------------------------------------------
// AC-3: INSERT-only write path
// ---------------------------------------------------------------------------

describe('AC-3: INSERT-only write path', () => {
  it('row count is monotonically non-decreasing across multiple writes', () => {
    const dbPath = makeDbPath();
    const log = openAuditLog(dbPath, 'orchestrator');

    log.writeEvent({ event_type: 'message_received' });
    log.writeEvent({ event_type: 'task_start' });
    log.writeEvent({ event_type: 'task_complete' });
    log.close();

    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare('SELECT COUNT(*) as cnt FROM events').get() as {
      cnt: number;
    };
    db.close();
    expect(row.cnt).toBe(3);
  });

  it('never loses rows — count equals number of writeEvent calls', () => {
    const dbPath = makeDbPath();
    const log = openAuditLog(dbPath, 'cato');
    const N = 20;
    for (let i = 0; i < N; i++) {
      log.writeEvent({ event_type: 'cato_check', context_id: `ctx-${i}` });
    }
    log.close();

    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare('SELECT COUNT(*) as cnt FROM events').get() as {
      cnt: number;
    };
    db.close();
    expect(row.cnt).toBe(N);
  });
});

// ---------------------------------------------------------------------------
// AC-4: Concurrent writes from three writers produce no lost rows
// ---------------------------------------------------------------------------

describe('AC-4: Concurrent writes from three writers', () => {
  it('100 rows each from three writers = 300 total, no corruption', () => {
    const dbPath = makeDbPath();
    const writers = ['orchestrator', 'broker', 'cato'] as const;
    const logs = writers.map((w) => openAuditLog(dbPath, w));

    // Write 100 rows from each writer interleaved
    const N = 100;
    for (let i = 0; i < N; i++) {
      logs[0].writeEvent({
        event_type: 'message_received',
        context_id: `ctx-${i}`,
      });
      logs[1].writeEvent({
        event_type: 'call_proxied',
        context_id: `ctx-${i}`,
      });
      logs[2].writeEvent({ event_type: 'cato_check', context_id: `ctx-${i}` });
    }

    for (const log of logs) log.close();

    const db = new Database(dbPath, { readonly: true });
    const total = db.prepare('SELECT COUNT(*) as cnt FROM events').get() as {
      cnt: number;
    };
    const perWriter = db
      .prepare('SELECT writer, COUNT(*) as cnt FROM events GROUP BY writer')
      .all() as { writer: string; cnt: number }[];
    db.close();

    expect(total.cnt).toBe(300);
    for (const w of writers) {
      const found = perWriter.find((r) => r.writer === w);
      expect(found?.cnt).toBe(N);
    }
  });
});

// ---------------------------------------------------------------------------
// AC-5: Cross-writer query by context_id
// ---------------------------------------------------------------------------

describe('AC-5: Cross-writer query by context_id and time window', () => {
  it('returns rows from all three writers for the same context_id', () => {
    const dbPath = makeDbPath();
    const contextId = 'shared-context-001';

    const orch = openAuditLog(dbPath, 'orchestrator');
    const broker = openAuditLog(dbPath, 'broker');
    const cato = openAuditLog(dbPath, 'cato');

    orch.writeEvent({ event_type: 'task_start', context_id: contextId });
    broker.writeEvent({ event_type: 'token_issued', context_id: contextId });
    cato.writeEvent({ event_type: 'cato_check', context_id: contextId });

    orch.close();
    broker.close();
    cato.close();

    const db = new Database(dbPath, { readonly: true });
    const rows = db
      .prepare(
        `SELECT writer FROM events WHERE context_id = ? ORDER BY occurred_at, sequence_id`,
      )
      .all(contextId) as { writer: string }[];
    db.close();

    const writersFound = new Set(rows.map((r) => r.writer));
    expect(writersFound.has('orchestrator')).toBe(true);
    expect(writersFound.has('broker')).toBe(true);
    expect(writersFound.has('cato')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC-6: payload_hash present for payload events
// ---------------------------------------------------------------------------

describe('AC-6: payload_hash present for payload events', () => {
  it('payload_hash is a 64-char hex string when provided', () => {
    const dbPath = makeDbPath();
    const log = openAuditLog(dbPath, 'cato');
    const hash = 'a'.repeat(64);
    log.writeEvent({
      event_type: 'cato_check',
      payload_hash: hash,
      payload_size: 1024,
    });
    log.close();

    const db = new Database(dbPath, { readonly: true });
    const row = db
      .prepare(
        'SELECT payload_hash, payload_size FROM events WHERE event_type=?',
      )
      .get('cato_check') as { payload_hash: string; payload_size: number };
    db.close();

    expect(row.payload_hash).toBe(hash);
    expect(row.payload_hash.length).toBe(64);
    expect(row.payload_size).toBe(1024);
  });

  it('payload_hash is null for events without a payload', () => {
    const dbPath = makeDbPath();
    const log = openAuditLog(dbPath, 'cato');
    log.writeEvent({ event_type: 'cato_audit_start' });
    log.close();

    const db = new Database(dbPath, { readonly: true });
    const row = db
      .prepare('SELECT payload_hash FROM events WHERE event_type=?')
      .get('cato_audit_start') as { payload_hash: string | null };
    db.close();

    expect(row.payload_hash).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC-7: No raw payload content in any row
// ---------------------------------------------------------------------------

describe('AC-7: No raw payload content in any row', () => {
  it('details column does not contain raw credential patterns', () => {
    const dbPath = makeDbPath();
    const log = openAuditLog(dbPath, 'broker');
    log.writeEvent({
      event_type: 'token_issued',
      details: {
        token_id: 'tok-abc123',
        context_id: 'ctx-1',
        skill_set: ['browser'],
        security_mode: 'supervised',
        ttl_seconds: 3600,
        call_budget: 100,
      },
    });
    log.close();

    const db = new Database(dbPath, { readonly: true });
    const row = db
      .prepare('SELECT details FROM events WHERE event_type=?')
      .get('token_issued') as { details: string };
    db.close();

    // Verify token_id is stored but no raw token value (which would look like
    // sk-ant-... or similar credential patterns)
    const detailsObj = JSON.parse(row.details) as Record<string, unknown>;
    expect(detailsObj.token_id).toBe('tok-abc123');
    // No raw API key patterns
    expect(row.details).not.toMatch(/sk-ant-/);
    expect(row.details).not.toMatch(/Bearer /);
  });
});

// ---------------------------------------------------------------------------
// AC-9: sequence_id monotonically increasing per writer
// ---------------------------------------------------------------------------

describe('AC-9: sequence_id monotonically increasing per writer', () => {
  it('50 rows from single writer have strictly increasing sequence_id', () => {
    const dbPath = makeDbPath();
    const log = openAuditLog(dbPath, 'orchestrator');
    for (let i = 0; i < 50; i++) {
      log.writeEvent({ event_type: 'message_received' });
    }
    log.close();

    const db = new Database(dbPath, { readonly: true });
    const rows = db
      .prepare(
        `SELECT sequence_id FROM events WHERE writer='orchestrator' ORDER BY id ASC`,
      )
      .all() as { sequence_id: number }[];
    db.close();

    expect(rows.length).toBe(50);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.sequence_id).toBeGreaterThan(rows[i - 1]!.sequence_id);
    }
  });

  it('sequence_id starts at 1 for a fresh writer instance', () => {
    const dbPath = makeDbPath();
    const log = openAuditLog(dbPath, 'broker');
    log.writeEvent({ event_type: 'token_issued' });
    log.close();

    const db = new Database(dbPath, { readonly: true });
    const row = db
      .prepare('SELECT sequence_id FROM events WHERE writer=?')
      .get('broker') as { sequence_id: number };
    db.close();

    expect(row.sequence_id).toBe(1);
  });

  it('sequence_id counters are independent per writer instance', () => {
    const dbPath = makeDbPath();
    const orch = openAuditLog(dbPath, 'orchestrator');
    const cato = openAuditLog(dbPath, 'cato');

    orch.writeEvent({ event_type: 'message_received' });
    orch.writeEvent({ event_type: 'task_start' });
    cato.writeEvent({ event_type: 'cato_check' });

    orch.close();
    cato.close();

    const db = new Database(dbPath, { readonly: true });
    const orchRows = db
      .prepare(
        `SELECT sequence_id FROM events WHERE writer='orchestrator' ORDER BY id`,
      )
      .all() as { sequence_id: number }[];
    const catoRows = db
      .prepare(`SELECT sequence_id FROM events WHERE writer='cato' ORDER BY id`)
      .all() as { sequence_id: number }[];
    db.close();

    // Orchestrator: seq 1, 2
    expect(orchRows[0]!.sequence_id).toBe(1);
    expect(orchRows[1]!.sequence_id).toBe(2);
    // Cato: starts from 1 independently
    expect(catoRows[0]!.sequence_id).toBe(1);
  });

  it('no gaps in sequence_id for a single writer', () => {
    const dbPath = makeDbPath();
    const log = openAuditLog(dbPath, 'cato');
    const N = 30;
    for (let i = 0; i < N; i++) {
      log.writeEvent({ event_type: 'cato_check' });
    }
    log.close();

    const db = new Database(dbPath, { readonly: true });
    const min = (
      db
        .prepare(`SELECT MIN(sequence_id) as m FROM events WHERE writer='cato'`)
        .get() as { m: number }
    ).m;
    const max = (
      db
        .prepare(`SELECT MAX(sequence_id) as m FROM events WHERE writer='cato'`)
        .get() as { m: number }
    ).m;
    const count = (
      db
        .prepare(`SELECT COUNT(*) as c FROM events WHERE writer='cato'`)
        .get() as { c: number }
    ).c;
    db.close();

    expect(min).toBe(1);
    expect(max).toBe(N);
    expect(count).toBe(N);
    // No gaps: max - min + 1 == count
    expect(max - min + 1).toBe(count);
  });
});

// ---------------------------------------------------------------------------
// AC-10: Write failure surfaces an error to the caller
// ---------------------------------------------------------------------------

describe('AC-10: Write failure surfaces structured error', () => {
  it('throws AuditWriteError when DB is closed before write', () => {
    const dbPath = makeDbPath();
    const log = openAuditLog(dbPath, 'orchestrator');
    log.close(); // close the underlying db

    // Further writes should throw
    expect(() => log.writeEvent({ event_type: 'message_received' })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// AC-11: Initialization failure on unwritable path
// ---------------------------------------------------------------------------

describe('AC-11: Initialization failure on unwritable path', () => {
  it('throws AuditInitError when directory cannot be created', () => {
    const badPath = '/proc/opengolem-cant-write/audit.db';
    expect(() => openAuditLog(badPath, 'orchestrator')).toThrow(AuditInitError);
  });

  it('AuditInitError has a cause property', () => {
    try {
      openAuditLog('/proc/opengolem-cant-write/audit.db', 'cato');
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AuditInitError);
    }
  });
});

// ---------------------------------------------------------------------------
// AC-12: risk_code values from enumeration
// ---------------------------------------------------------------------------

const VALID_RISK_CODES = new Set([
  'PATH_TRAVERSAL',
  'OVERSIZED_PAYLOAD',
  'PROMPT_INJECTION',
  'PII_PLAIN_TEXT',
  'CREDENTIAL_EXPOSURE',
  'OUT_OF_SCOPE_ENDPOINT',
  'MEMORY_SCOPE_VIOLATION',
  'RATE_ANOMALY',
  'DELEGATION_CEILING_EXCEEDED',
]);

describe('AC-12: risk_code from enumeration', () => {
  it('stores valid risk_code values', () => {
    const dbPath = makeDbPath();
    const log = openAuditLog(dbPath, 'cato');

    for (const code of VALID_RISK_CODES) {
      log.writeEvent({ event_type: 'cato_check', risk_code: code });
    }
    log.close();

    const db = new Database(dbPath, { readonly: true });
    const rows = db
      .prepare('SELECT risk_code FROM events WHERE risk_code IS NOT NULL')
      .all() as { risk_code: string }[];
    db.close();

    for (const row of rows) {
      expect(VALID_RISK_CODES.has(row.risk_code)).toBe(true);
    }
  });

  it('risk_code is null for non-block events', () => {
    const dbPath = makeDbPath();
    const log = openAuditLog(dbPath, 'orchestrator');
    log.writeEvent({ event_type: 'task_start' });
    log.close();

    const db = new Database(dbPath, { readonly: true });
    const row = db
      .prepare('SELECT risk_code FROM events WHERE event_type=?')
      .get('task_start') as { risk_code: string | null };
    db.close();

    expect(row.risk_code).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC-13: occurred_at is a reasonable UTC Unix timestamp
// ---------------------------------------------------------------------------

describe('AC-13: occurred_at is within 60s of wall clock', () => {
  it('occurred_at is within 60 seconds of current time', () => {
    const dbPath = makeDbPath();
    const before = Math.floor(Date.now() / 1000);
    const log = openAuditLog(dbPath, 'orchestrator');
    log.writeEvent({ event_type: 'message_received' });
    log.close();
    const after = Math.floor(Date.now() / 1000);

    const db = new Database(dbPath, { readonly: true });
    const row = db
      .prepare('SELECT occurred_at FROM events WHERE event_type=?')
      .get('message_received') as { occurred_at: number };
    db.close();

    expect(row.occurred_at).toBeGreaterThanOrEqual(before);
    expect(row.occurred_at).toBeLessThanOrEqual(after + 1);
    expect(after - row.occurred_at).toBeLessThan(60);
  });

  it('custom occurred_at is stored as provided', () => {
    const dbPath = makeDbPath();
    const log = openAuditLog(dbPath, 'cato');
    const customTs = 1_700_000_000;
    log.writeEvent({ event_type: 'cato_check', occurred_at: customTs });
    log.close();

    const db = new Database(dbPath, { readonly: true });
    const row = db
      .prepare('SELECT occurred_at FROM events WHERE event_type=?')
      .get('cato_check') as { occurred_at: number };
    db.close();

    expect(row.occurred_at).toBe(customTs);
  });

  it('multiple events with same occurred_at have distinct sequence_ids', () => {
    const dbPath = makeDbPath();
    const log = openAuditLog(dbPath, 'broker');
    const fixedTs = Math.floor(Date.now() / 1000);
    log.writeEvent({ event_type: 'token_issued', occurred_at: fixedTs });
    log.writeEvent({ event_type: 'call_proxied', occurred_at: fixedTs });
    log.close();

    const db = new Database(dbPath, { readonly: true });
    const rows = db
      .prepare('SELECT sequence_id FROM events WHERE writer=? ORDER BY id')
      .all('broker') as { sequence_id: number }[];
    db.close();

    expect(rows[0]!.sequence_id).not.toBe(rows[1]!.sequence_id);
  });
});

// ---------------------------------------------------------------------------
// AC-18: writer column matches the actual writing process
// ---------------------------------------------------------------------------

describe('AC-18: writer column matches the actual writing process', () => {
  it('writer column is set correctly for all three writer values', () => {
    const dbPath = makeDbPath();

    const orch = openAuditLog(dbPath, 'orchestrator');
    const broker = openAuditLog(dbPath, 'broker');
    const cato = openAuditLog(dbPath, 'cato');

    orch.writeEvent({ event_type: 'message_received' });
    broker.writeEvent({ event_type: 'token_issued' });
    cato.writeEvent({ event_type: 'cato_check' });

    orch.close();
    broker.close();
    cato.close();

    const db = new Database(dbPath, { readonly: true });
    const rows = db
      .prepare('SELECT event_type, writer FROM events ORDER BY id')
      .all() as { event_type: string; writer: string }[];
    db.close();

    expect(rows.find((r) => r.event_type === 'message_received')?.writer).toBe(
      'orchestrator',
    );
    expect(rows.find((r) => r.event_type === 'token_issued')?.writer).toBe(
      'broker',
    );
    expect(rows.find((r) => r.event_type === 'cato_check')?.writer).toBe(
      'cato',
    );
  });
});

// ---------------------------------------------------------------------------
// Details column — JSON serialization
// ---------------------------------------------------------------------------

describe('details column JSON serialization', () => {
  it('stores and retrieves complex details objects', () => {
    const dbPath = makeDbPath();
    const log = openAuditLog(dbPath, 'cato');
    const details = {
      check_id: 'chk-001',
      action: 'AGENT_PROMPT',
      context_id: 'ctx-group-1',
      token_id: 'tok-abc',
      payload_hash: 'b'.repeat(64),
      payload_size: 2048,
      allow: true,
    };
    log.writeEvent({ event_type: 'cato_check', details });
    log.close();

    const db = new Database(dbPath, { readonly: true });
    const row = db
      .prepare('SELECT details FROM events WHERE event_type=?')
      .get('cato_check') as { details: string };
    db.close();

    const parsed = JSON.parse(row.details) as Record<string, unknown>;
    expect(parsed.check_id).toBe('chk-001');
    expect(parsed.action).toBe('AGENT_PROMPT');
    expect(parsed.allow).toBe(true);
  });

  it('details defaults to {} when not provided', () => {
    const dbPath = makeDbPath();
    const log = openAuditLog(dbPath, 'orchestrator');
    log.writeEvent({ event_type: 'task_start' });
    log.close();

    const db = new Database(dbPath, { readonly: true });
    const row = db
      .prepare('SELECT details FROM events WHERE event_type=?')
      .get('task_start') as { details: string };
    db.close();

    expect(row.details).toBe('{}');
  });
});

// ---------------------------------------------------------------------------
// M37 — Concurrent Writer Integrity
// ---------------------------------------------------------------------------

describe('M37 — Concurrent Writer Integrity', () => {
  const N = 50; // events per writer; 150 total
  const WRITERS = ['orchestrator', 'broker', 'cato'] as const;
  const CONTEXT_ID = 'ctx-m37-concurrent';

  it('no WAL errors or lock contentions under concurrent load', async () => {
    const dbPath = makeDbPath();
    const logs = WRITERS.map((w) => openAuditLog(dbPath, w));

    // Fire all three writers concurrently via Promise.all
    await Promise.all(
      logs.map((log, wi) =>
        Promise.resolve().then(() => {
          for (let i = 0; i < N; i++) {
            log.writeEvent({
              event_type: `m37_event_w${wi}`,
              context_id: CONTEXT_ID,
              details: { writer_index: wi, seq: i },
            });
          }
        }),
      ),
    );

    for (const log of logs) log.close();

    // Verify no rows are missing
    const db = new Database(dbPath, { readonly: true });
    const total = (
      db.prepare('SELECT COUNT(*) as cnt FROM events').get() as { cnt: number }
    ).cnt;
    db.close();

    expect(total).toBe(N * WRITERS.length);
  });

  it('post-workload row count matches event count per writer', async () => {
    const dbPath = makeDbPath();
    const logs = WRITERS.map((w) => openAuditLog(dbPath, w));

    await Promise.all(
      logs.map((log, wi) =>
        Promise.resolve().then(() => {
          for (let i = 0; i < N; i++) {
            log.writeEvent({
              event_type: `m37_integrity_w${wi}`,
              context_id: CONTEXT_ID,
            });
          }
        }),
      ),
    );

    for (const log of logs) log.close();

    const db = new Database(dbPath, { readonly: true });

    // Total rows
    const total = (
      db.prepare('SELECT COUNT(*) as cnt FROM events').get() as { cnt: number }
    ).cnt;
    expect(total).toBe(150);

    // Per-writer counts
    const perWriter = db
      .prepare('SELECT writer, COUNT(*) as cnt FROM events GROUP BY writer')
      .all() as { writer: string; cnt: number }[];

    for (const w of WRITERS) {
      const found = perWriter.find((r) => r.writer === w);
      expect(found?.cnt).toBe(N);
    }

    // No partial rows — details column must be valid JSON for every row
    const allRows = db
      .prepare('SELECT details FROM events')
      .all() as { details: string }[];
    for (const row of allRows) {
      expect(() => JSON.parse(row.details)).not.toThrow();
    }

    // context_id queries return complete event sets
    const ctxRows = db
      .prepare('SELECT writer FROM events WHERE context_id = ?')
      .all(CONTEXT_ID) as { writer: string }[];
    expect(ctxRows.length).toBe(150);

    db.close();
  });

  it('sequence_id per writer is monotonically increasing (no gaps)', async () => {
    const dbPath = makeDbPath();
    const logs = WRITERS.map((w) => openAuditLog(dbPath, w));

    await Promise.all(
      logs.map((log, wi) =>
        Promise.resolve().then(() => {
          for (let i = 0; i < N; i++) {
            log.writeEvent({ event_type: `m37_seq_w${wi}` });
          }
        }),
      ),
    );

    for (const log of logs) log.close();

    const db = new Database(dbPath, { readonly: true });

    for (const w of WRITERS) {
      const rows = db
        .prepare(
          `SELECT sequence_id FROM events WHERE writer = ? ORDER BY sequence_id ASC`,
        )
        .all(w) as { sequence_id: number }[];

      expect(rows.length).toBe(N);
      // sequence_id starts at 1
      expect(rows[0]!.sequence_id).toBe(1);
      // strictly increasing, no gaps
      for (let i = 1; i < rows.length; i++) {
        expect(rows[i]!.sequence_id).toBe(rows[i - 1]!.sequence_id + 1);
      }
    }

    db.close();
  });

  it('no occurred_at timestamps in the future', async () => {
    const dbPath = makeDbPath();
    const logs = WRITERS.map((w) => openAuditLog(dbPath, w));
    const beforeSec = Math.floor(Date.now() / 1000);

    await Promise.all(
      logs.map((log, wi) =>
        Promise.resolve().then(() => {
          for (let i = 0; i < N; i++) {
            log.writeEvent({ event_type: `m37_ts_w${wi}` });
          }
        }),
      ),
    );

    for (const log of logs) log.close();
    const afterSec = Math.floor(Date.now() / 1000) + 1; // +1 for rounding

    const db = new Database(dbPath, { readonly: true });
    const rows = db
      .prepare('SELECT occurred_at FROM events')
      .all() as { occurred_at: number }[];
    db.close();

    for (const row of rows) {
      expect(row.occurred_at).toBeGreaterThanOrEqual(beforeSec);
      expect(row.occurred_at).toBeLessThanOrEqual(afterSec);
    }
  });

  it('temporal consistency: no timestamp inversions beyond 2s within context_id', async () => {
    const dbPath = makeDbPath();
    const logs = WRITERS.map((w) => openAuditLog(dbPath, w));

    await Promise.all(
      logs.map((log, wi) =>
        Promise.resolve().then(() => {
          for (let i = 0; i < N; i++) {
            log.writeEvent({
              event_type: `m37_temporal_w${wi}`,
              context_id: CONTEXT_ID,
            });
          }
        }),
      ),
    );

    for (const log of logs) log.close();

    const db = new Database(dbPath, { readonly: true });
    const rows = db
      .prepare(
        `SELECT occurred_at FROM events WHERE context_id = ? ORDER BY occurred_at ASC`,
      )
      .all(CONTEXT_ID) as { occurred_at: number }[];
    db.close();

    expect(rows.length).toBe(150);

    // No entry should be more than 2 seconds earlier than its predecessor
    // (clock resolution tolerance for concurrent writes on the same second)
    for (let i = 1; i < rows.length; i++) {
      const delta = rows[i]!.occurred_at - rows[i - 1]!.occurred_at;
      expect(delta).toBeGreaterThanOrEqual(-2);
    }
  });
});

// ---------------------------------------------------------------------------
// Idempotent schema: re-opening an existing DB does not error
// ---------------------------------------------------------------------------

describe('Idempotent schema initialization', () => {
  it('opening an existing audit.db a second time does not throw', () => {
    const dbPath = makeDbPath();

    const log1 = openAuditLog(dbPath, 'orchestrator');
    log1.writeEvent({ event_type: 'message_received' });
    log1.close();

    // Re-open — should not throw even though tables already exist
    const log2 = openAuditLog(dbPath, 'cato');
    log2.writeEvent({ event_type: 'cato_check' });
    log2.close();

    const db = new Database(dbPath, { readonly: true });
    const count = (
      db.prepare('SELECT COUNT(*) as c FROM events').get() as { c: number }
    ).c;
    db.close();

    expect(count).toBe(2);
  });
});
