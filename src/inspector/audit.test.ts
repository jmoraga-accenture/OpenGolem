import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  _setAuditDb,
  hashPayload,
  initAuditDb,
  logCall,
  logFlagEvent,
  getRecentCalls,
  getRecentFlagEvents,
  type AuditRecord,
  type FlagEvent,
} from './audit.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opengolem-audit-test-'));
  const db = initAuditDb(path.join(tmpDir, 'audit.db'));
  _setAuditDb(db);
});

afterEach(() => {
  _setAuditDb(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('initAuditDb', () => {
  it('creates the calls table', () => {
    const db = initAuditDb(path.join(tmpDir, 'audit2.db'));
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toContain('calls');
  });

  it('creates the append-only trigger', () => {
    const db = initAuditDb(path.join(tmpDir, 'audit3.db'));
    const triggers = db
      .prepare("SELECT name FROM sqlite_master WHERE type='trigger'")
      .all() as { name: string }[];
    expect(triggers.map((t) => t.name)).toContain('prevent_delete');
  });

  it('blocks DELETE on calls table', () => {
    const db = initAuditDb(path.join(tmpDir, 'audit4.db'));
    db.prepare(
      `INSERT INTO calls (ts,jti,container,skill,outcome,block_rule,payload_hash,security_mode)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(1, 'jti1', 'c1', '/v1/messages', 'pass', null, 'abc', 'golem_guard');
    expect(() => db.prepare('DELETE FROM calls WHERE id=1').run()).toThrow(
      'append-only',
    );
  });

  it('is idempotent — calling twice returns usable db', () => {
    const db1 = initAuditDb(path.join(tmpDir, 'idem.db'));
    const db2 = initAuditDb(path.join(tmpDir, 'idem.db'));
    expect(() =>
      db1
        .prepare(
          `INSERT INTO calls (ts,jti,container,skill,outcome,block_rule,payload_hash,security_mode)
           VALUES (?,?,?,?,?,?,?,?)`,
        )
        .run(1, 'j', 'c', '/v1/messages', 'pass', null, 'h', 'golem_guard'),
    ).not.toThrow();
    const rows = db2.prepare('SELECT COUNT(*) as n FROM calls').get() as {
      n: number;
    };
    expect(rows.n).toBe(1);
  });
});

describe('logCall', () => {
  it('inserts a record with correct fields', () => {
    const record: AuditRecord = {
      jti: 'jti-abc',
      container: 'opengolem-tui-123',
      skill: '/v1/messages',
      outcome: 'pass',
      blockRule: null,
      payloadHash: 'deadbeef',
      securityMode: 'golem_guard',
    };
    logCall(record);
    const rows = getRecentCalls(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].jti).toBe('jti-abc');
    expect(rows[0].outcome).toBe('pass');
    expect(rows[0].blockRule).toBeNull();
  });

  it('inserts hard_block record with block_rule', () => {
    logCall({
      jti: 'jti-1',
      container: 'c1',
      skill: '/v1/messages',
      outcome: 'hard_block',
      blockRule: 'checkPromptInjection',
      payloadHash: 'abc',
      securityMode: 'golem_guard',
    });
    const rows = getRecentCalls(1);
    expect(rows[0].outcome).toBe('hard_block');
    expect(rows[0].blockRule).toBe('checkPromptInjection');
  });

  it('can insert multiple records', () => {
    logCall({
      jti: 'a',
      container: 'c',
      skill: '/v1/messages',
      outcome: 'pass',
      blockRule: null,
      payloadHash: 'h1',
      securityMode: 'golem_guard',
    });
    logCall({
      jti: 'b',
      container: 'c',
      skill: '/v1/messages',
      outcome: 'pass',
      blockRule: null,
      payloadHash: 'h2',
      securityMode: 'golem_guard',
    });
    expect(getRecentCalls(10)).toHaveLength(2);
  });
});

describe('logFlagEvent', () => {
  const makeFlag = (overrides: Partial<FlagEvent> = {}): FlagEvent => ({
    groupJid: 'tg:12345',
    groupFolder: 'tg-12345',
    assertivenessLevel: 10,
    responseSnippet: '[FLAG] I need to push back on this.',
    ...overrides,
  });

  it('inserts a flag event with correct fields', () => {
    logFlagEvent(makeFlag());
    const rows = getRecentFlagEvents(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].groupJid).toBe('tg:12345');
    expect(rows[0].groupFolder).toBe('tg-12345');
    expect(rows[0].assertivenessLevel).toBe(10);
    expect(rows[0].responseSnippet).toBe('[FLAG] I need to push back on this.');
  });

  it('stores assertiveness_level correctly', () => {
    logFlagEvent(makeFlag({ assertivenessLevel: 5 }));
    expect(getRecentFlagEvents(1)[0].assertivenessLevel).toBe(5);
  });

  it('can insert multiple flag events', () => {
    logFlagEvent(makeFlag({ responseSnippet: '[FLAG] first' }));
    logFlagEvent(makeFlag({ responseSnippet: '[FLAG] second' }));
    expect(getRecentFlagEvents(10)).toHaveLength(2);
  });

  it('returns most recent first', () => {
    logFlagEvent(makeFlag({ responseSnippet: '[FLAG] older' }));
    logFlagEvent(makeFlag({ responseSnippet: '[FLAG] newer' }));
    const rows = getRecentFlagEvents(2);
    expect(rows[0].responseSnippet).toBe('[FLAG] newer');
  });

  it('blocks DELETE on flag_events table', () => {
    const db = initAuditDb(path.join(tmpDir, 'flag-audit.db'));
    db.prepare(
      `INSERT INTO flag_events (ts, group_jid, group_folder, assertiveness_level, response_snippet)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(Date.now(), 'tg:1', 'tg-1', 10, '[FLAG] test');
    expect(() =>
      db.prepare('DELETE FROM flag_events WHERE id=1').run(),
    ).toThrow('append-only');
  });
});

describe('hashPayload', () => {
  it('returns a 64-char hex string', () => {
    expect(hashPayload('test body')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic', () => {
    expect(hashPayload('same input')).toBe(hashPayload('same input'));
  });

  it('produces different hashes for different inputs', () => {
    expect(hashPayload('aaa')).not.toBe(hashPayload('bbb'));
  });

  it('handles empty string', () => {
    expect(hashPayload('')).toMatch(/^[0-9a-f]{64}$/);
  });
});
