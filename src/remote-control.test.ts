import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';

// Everything that vi.mock factories reference must be hoisted
const { TEST_DATA_DIR, TEST_STATE_FILE, TEST_STDOUT_FILE, TEST_STDERR_FILE, mockSpawn, mockChild } =
  vi.hoisted(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const _os = require('os') as typeof import('os');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const _path = require('path') as typeof import('path');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const _fs = require('fs') as typeof import('fs');

    const dir = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'og-rc-test-'));
    const mockStdin = { write: vi.fn(), end: vi.fn() };
    const mockChild = { pid: 99999, stdin: mockStdin, unref: vi.fn() };
    const mockSpawn = vi.fn(() => mockChild);

    return {
      TEST_DATA_DIR: dir,
      TEST_STATE_FILE: _path.join(dir, 'remote-control.json'),
      TEST_STDOUT_FILE: _path.join(dir, 'remote-control.stdout'),
      TEST_STDERR_FILE: _path.join(dir, 'remote-control.stderr'),
      mockSpawn,
      mockChild,
    };
  });

vi.mock('./config.js', () => ({
  DATA_DIR: TEST_DATA_DIR,
  STORE_DIR: TEST_DATA_DIR,
}));

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('child_process', () => ({
  spawn: mockSpawn,
}));

import {
  _getStateFilePath,
  _resetForTesting,
  getActiveSession,
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';

function writeStateFile(session: object): void {
  fs.writeFileSync(TEST_STATE_FILE, JSON.stringify(session), 'utf8');
}

function cleanFiles(): void {
  for (const f of [TEST_STATE_FILE, TEST_STDOUT_FILE, TEST_STDERR_FILE]) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* ok */
    }
  }
}

beforeEach(() => {
  _resetForTesting();
  cleanFiles();
  vi.clearAllMocks();
});

afterEach(() => {
  cleanFiles();
});

// ---------------------------------------------------------------------------
// _getStateFilePath
// ---------------------------------------------------------------------------

describe('_getStateFilePath', () => {
  it('is within DATA_DIR', () => {
    const p = _getStateFilePath();
    expect(p.startsWith(TEST_DATA_DIR)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// restoreRemoteControl
// ---------------------------------------------------------------------------

describe('restoreRemoteControl', () => {
  it('restores a live session from the state file', () => {
    const session = {
      pid: process.pid, // current process is definitely alive
      url: 'https://claude.ai/code/test-abc',
      startedBy: 'user1',
      startedInChat: 'chat@test',
      startedAt: new Date().toISOString(),
    };
    writeStateFile(session);

    restoreRemoteControl();

    const active = getActiveSession();
    expect(active).not.toBeNull();
    expect(active?.pid).toBe(process.pid);
    expect(active?.url).toBe(session.url);
  });

  it('clears state file when process is dead', () => {
    const session = {
      pid: 999999999, // almost certainly not a live PID
      url: 'https://claude.ai/code/test-dead',
      startedBy: 'user1',
      startedInChat: 'chat@test',
      startedAt: new Date().toISOString(),
    };
    writeStateFile(session);

    restoreRemoteControl();

    expect(getActiveSession()).toBeNull();
    expect(fs.existsSync(TEST_STATE_FILE)).toBe(false);
  });

  it('does nothing when no state file exists', () => {
    restoreRemoteControl();
    expect(getActiveSession()).toBeNull();
  });

  it('does nothing when state file contains invalid JSON', () => {
    fs.writeFileSync(TEST_STATE_FILE, 'not-json', 'utf8');
    restoreRemoteControl();
    expect(getActiveSession()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getActiveSession
// ---------------------------------------------------------------------------

describe('getActiveSession', () => {
  it('returns null when no session is active', () => {
    expect(getActiveSession()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// startRemoteControl
// ---------------------------------------------------------------------------

describe('startRemoteControl', () => {
  it('returns existing session URL when process is alive', async () => {
    const session = {
      pid: process.pid,
      url: 'https://claude.ai/code/existing-session',
      startedBy: 'user1',
      startedInChat: 'chat@test',
      startedAt: new Date().toISOString(),
    };
    writeStateFile(session);
    restoreRemoteControl();

    const result = await startRemoteControl('user1', 'chat@test', '/tmp');
    expect(result).toEqual({ ok: true, url: 'https://claude.ai/code/existing-session' });
    // Should not have spawned a new process
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('spawns a new process and polls stdout file for URL', async () => {
    // Use process.pid so isProcessAlive() returns true during polling
    mockSpawn.mockImplementation(() => {
      // Write URL immediately so the first poll picks it up
      fs.writeFileSync(
        TEST_STDOUT_FILE,
        'Starting...\nhttps://claude.ai/code/new-session-url\n',
        'utf8',
      );
      return { ...mockChild, pid: process.pid };
    });

    const result = await startRemoteControl('user2', 'chat2@test', '/tmp');

    expect(mockSpawn).toHaveBeenCalledWith(
      'claude',
      ['remote-control', '--name', 'OpenGolem Remote'],
      expect.objectContaining({ detached: true }),
    );
    expect(result).toEqual({ ok: true, url: 'https://claude.ai/code/new-session-url' });

    const active = getActiveSession();
    expect(active?.url).toBe('https://claude.ai/code/new-session-url');
    expect(active?.startedBy).toBe('user2');

    // State file should be persisted
    expect(fs.existsSync(TEST_STATE_FILE)).toBe(true);
    const persisted = JSON.parse(fs.readFileSync(TEST_STATE_FILE, 'utf8')) as {
      url: string;
    };
    expect(persisted.url).toBe('https://claude.ai/code/new-session-url');
  });

  it('returns error on timeout when no URL appears in stdout', async () => {
    vi.useFakeTimers();

    // Use a fake PID that won't exist; spy on process.kill so:
    //  - signal 0 (liveness check) succeeds → polling continues to deadline
    //  - SIGTERM at timeout is swallowed instead of killing the test worker
    const FAKE_PID = 77777;
    mockSpawn.mockReturnValue({ ...mockChild, pid: FAKE_PID });

    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);

    const resultPromise = startRemoteControl('user3', 'chat3@test', '/tmp');

    // Advance past the 30-second deadline
    await vi.runAllTimersAsync();

    const result = await resultPromise;

    vi.useRealTimers();
    killSpy.mockRestore();

    expect(result).toEqual({
      ok: false,
      error: 'Timed out waiting for Remote Control URL',
    });
  });

  it('returns error when spawn throws', async () => {
    mockSpawn.mockImplementation(() => {
      throw new Error('spawn ENOENT');
    });

    const result = await startRemoteControl('user4', 'chat4@test', '/tmp');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/Failed to start/);
    }
  });
});

// ---------------------------------------------------------------------------
// stopRemoteControl
// ---------------------------------------------------------------------------

describe('stopRemoteControl', () => {
  it('returns error when no session is active', () => {
    const result = stopRemoteControl();
    expect(result).toEqual({ ok: false, error: 'No active Remote Control session' });
  });

  it('sends SIGTERM and clears state when session is active', () => {
    const session = {
      pid: process.pid,
      url: 'https://claude.ai/code/to-stop',
      startedBy: 'user1',
      startedInChat: 'chat@test',
      startedAt: new Date().toISOString(),
    };
    writeStateFile(session);
    restoreRemoteControl();
    expect(getActiveSession()).not.toBeNull();

    // Recreate the state file so rmSync has something to remove
    writeStateFile(session);

    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);

    const result = stopRemoteControl();

    expect(result).toEqual({ ok: true });
    expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGTERM');
    expect(getActiveSession()).toBeNull();
    expect(fs.existsSync(TEST_STATE_FILE)).toBe(false);

    killSpy.mockRestore();
  });

  it('still clears state when SIGTERM throws (process already dead)', () => {
    const session = {
      pid: process.pid,
      url: 'https://claude.ai/code/already-dead',
      startedBy: 'user1',
      startedInChat: 'chat@test',
      startedAt: new Date().toISOString(),
    };
    writeStateFile(session);
    restoreRemoteControl();

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH');
    });

    const result = stopRemoteControl();

    expect(result).toEqual({ ok: true });
    expect(getActiveSession()).toBeNull();

    killSpy.mockRestore();
  });
});
