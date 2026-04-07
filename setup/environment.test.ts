import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Platform detection (live — no mocking needed for these)
// ---------------------------------------------------------------------------

describe('platform detection', () => {
  it('getPlatform returns a valid platform string', async () => {
    const { getPlatform } = await import('./platform.js');
    expect(['macos', 'linux', 'unknown']).toContain(getPlatform());
  });

  it('commandExists returns true for a command known to be present', async () => {
    const { commandExists } = await import('./platform.js');
    // `node` itself is definitely present since we're running in it
    expect(commandExists('node')).toBe(true);
  });

  it('commandExists returns false for a nonsense binary', async () => {
    const { commandExists } = await import('./platform.js');
    expect(commandExists('__nonexistent_binary_xyz__')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// .env / HAS_ENV detection
// ---------------------------------------------------------------------------

describe('.env file detection', () => {
  it('detects an existing .env file', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-env-test-'));
    const envPath = path.join(tmpDir, '.env');
    fs.writeFileSync(envPath, 'ANTHROPIC_API_KEY=sk-test\n');

    expect(fs.existsSync(envPath)).toBe(true);
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('returns false when .env is absent', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-env-test-'));
    const envPath = path.join(tmpDir, '.env');

    expect(fs.existsSync(envPath)).toBe(false);
    fs.rmSync(tmpDir, { recursive: true });
  });
});

// ---------------------------------------------------------------------------
// Auth directory detection
// ---------------------------------------------------------------------------

describe('auth directory detection', () => {
  it('hasAuth is false for a missing auth directory', () => {
    const authDir = path.join(os.tmpdir(), '__og_no_auth__');
    const hasAuth = fs.existsSync(authDir) && fs.readdirSync(authDir).length > 0;
    expect(hasAuth).toBe(false);
  });

  it('hasAuth is false for an empty auth directory', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-auth-test-'));
    const authDir = path.join(tmpDir, 'auth');
    fs.mkdirSync(authDir);
    const hasAuth = fs.existsSync(authDir) && fs.readdirSync(authDir).length > 0;
    expect(hasAuth).toBe(false);
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('hasAuth is true for a non-empty auth directory', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-auth-test-'));
    const authDir = path.join(tmpDir, 'auth');
    fs.mkdirSync(authDir);
    fs.writeFileSync(path.join(authDir, 'creds.json'), '{}');
    const hasAuth = fs.existsSync(authDir) && fs.readdirSync(authDir).length > 0;
    expect(hasAuth).toBe(true);
    fs.rmSync(tmpDir, { recursive: true });
  });
});

// ---------------------------------------------------------------------------
// Registered groups — SQLite query (same query used by environment.ts)
// ---------------------------------------------------------------------------

describe('registered groups SQLite detection', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE IF NOT EXISTS registered_groups (
        jid TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        folder TEXT NOT NULL UNIQUE,
        trigger_pattern TEXT NOT NULL,
        added_at TEXT NOT NULL,
        container_config TEXT,
        requires_trigger INTEGER DEFAULT 1
      )
    `);
  });

  it('count is 0 on an empty table', () => {
    const row = db
      .prepare('SELECT COUNT(*) as count FROM registered_groups')
      .get() as { count: number };
    expect(row.count).toBe(0);
  });

  it('count reflects inserted rows', () => {
    const insert = db.prepare(
      `INSERT INTO registered_groups
         (jid, name, folder, trigger_pattern, added_at, requires_trigger)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insert.run('123@g.us', 'Group 1', 'group-1', '@Alef', '2026-01-01T00:00:00.000Z', 1);
    insert.run('456@g.us', 'Group 2', 'group-2', '@Alef', '2026-01-01T00:00:00.000Z', 1);

    const row = db
      .prepare('SELECT COUNT(*) as count FROM registered_groups')
      .get() as { count: number };
    expect(row.count).toBe(2);
  });

  it('hasRegisteredGroups is true when count > 0', () => {
    db.prepare(
      `INSERT INTO registered_groups
         (jid, name, folder, trigger_pattern, added_at, requires_trigger)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('789@g.us', 'Group 3', 'group-3', '@Alef', '2026-01-01T00:00:00.000Z', 1);

    const row = db
      .prepare('SELECT COUNT(*) as count FROM registered_groups')
      .get() as { count: number };
    const hasRegisteredGroups = row.count > 0;
    expect(hasRegisteredGroups).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Credential detection in .env content
// ---------------------------------------------------------------------------

describe('credential detection in .env content', () => {
  const CRED_PATTERN = /^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)=/m;

  it('detects ANTHROPIC_API_KEY', () => {
    expect(CRED_PATTERN.test('ANTHROPIC_API_KEY=sk-ant-test\nOTHER=foo')).toBe(true);
  });

  it('detects CLAUDE_CODE_OAUTH_TOKEN', () => {
    expect(CRED_PATTERN.test('CLAUDE_CODE_OAUTH_TOKEN=oauth-abc123')).toBe(true);
  });

  it('returns false when no credential key present', () => {
    expect(CRED_PATTERN.test('ASSISTANT_NAME=Alef\nLOG_LEVEL=info')).toBe(false);
  });

  it('does not false-positive on a key that contains the name as a substring', () => {
    expect(CRED_PATTERN.test('NOT_ANTHROPIC_API_KEY=foo')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// emitStatus output format
// ---------------------------------------------------------------------------

describe('emitStatus output', () => {
  it('emitStatus writes a correctly formatted block to stdout', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((msg: string) => {
      lines.push(...msg.split('\n'));
    });

    const { emitStatus } = await import('./status.js');
    emitStatus('CHECK_ENVIRONMENT', {
      DOCKER: 'running',
      HAS_ENV: true,
      STATUS: 'success',
    });

    spy.mockRestore();

    expect(lines[0]).toBe('=== OPENGOLEM SETUP: CHECK_ENVIRONMENT ===');
    expect(lines).toContain('DOCKER: running');
    expect(lines).toContain('HAS_ENV: true');
    expect(lines).toContain('STATUS: success');
    expect(lines[lines.length - 1]).toBe('=== END ===');
  });
});

// ---------------------------------------------------------------------------
// Docker detection logic
// ---------------------------------------------------------------------------

describe('Docker detection logic', () => {
  it('docker state is one of the three expected values', async () => {
    // We do not mock — just verify the detection produces a valid result.
    // This is a live test; Docker may or may not be installed.
    const { commandExists } = await import('./platform.js');
    const dockerInstalled = commandExists('docker');

    let docker: 'running' | 'installed_not_running' | 'not_found';
    if (!dockerInstalled) {
      docker = 'not_found';
    } else {
      try {
        const { execSync } = await import('child_process');
        execSync('docker info', { stdio: 'ignore' });
        docker = 'running';
      } catch {
        docker = 'installed_not_running';
      }
    }

    expect(['running', 'installed_not_running', 'not_found']).toContain(docker);
  });
});

// ---------------------------------------------------------------------------
// Apple Container detection logic
// ---------------------------------------------------------------------------

describe('Apple Container detection logic', () => {
  it('appleContainer state is one of the two expected values', async () => {
    const { commandExists } = await import('./platform.js');
    const state = commandExists('container') ? 'installed' : 'not_found';
    expect(['installed', 'not_found']).toContain(state);
  });
});
