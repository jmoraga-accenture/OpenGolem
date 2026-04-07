import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Clean-room tests for setup/register.ts run() function.
 *
 * Tests argument parsing, validation, DB registration, filesystem operations,
 * and status emission via mocked dependencies.
 */

// --- Mocks ---
// vi.mock factories are hoisted, so we use vi.hoisted() for shared mock state.

const { mockSetRegisteredGroup, mockInitDatabase, mockIsValidGroupFolder,
        mockEmitStatus, mockFs } = vi.hoisted(() => {
  const mockFs = {
    mkdirSync: vi.fn(),
    existsSync: vi.fn(() => false),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(() => ''),
    readdirSync: vi.fn(() => [] as string[]),
    copyFileSync: vi.fn(),
  };
  return {
    mockSetRegisteredGroup: vi.fn(),
    mockInitDatabase: vi.fn(),
    mockIsValidGroupFolder: vi.fn(() => true),
    mockEmitStatus: vi.fn(),
    mockFs,
  };
});

vi.mock('../src/db.js', () => ({
  initDatabase: mockInitDatabase,
  setRegisteredGroup: mockSetRegisteredGroup,
}));

vi.mock('../src/group-folder.js', () => ({
  isValidGroupFolder: mockIsValidGroupFolder,
}));

vi.mock('../src/config.js', () => ({
  STORE_DIR: '/tmp/test-store',
}));

vi.mock('../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('./status.js', () => ({
  emitStatus: mockEmitStatus,
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: mockFs.mkdirSync,
      existsSync: mockFs.existsSync,
      writeFileSync: mockFs.writeFileSync,
      readFileSync: mockFs.readFileSync,
      readdirSync: mockFs.readdirSync,
      copyFileSync: mockFs.copyFileSync,
    },
  };
});

import { run } from './register.js';

// --- Helpers ---

const validArgs = [
  '--jid', '123@g.us',
  '--name', 'Test Group',
  '--trigger', '@Alef',
  '--folder', 'test-group',
];

vi.spyOn(process, 'exit').mockImplementation(() => {
  throw new Error('process.exit');
});

beforeEach(() => {
  vi.clearAllMocks();
  mockIsValidGroupFolder.mockReturnValue(true);
  mockFs.existsSync.mockReturnValue(false);
  mockFs.readdirSync.mockReturnValue([]);
  mockFs.readFileSync.mockReturnValue('');
});

afterEach(() => {
  vi.restoreAllMocks();
});

// --- Tests ---

describe('register.run() — missing required args', () => {
  it('exits with failure when --jid is missing', async () => {
    await expect(
      run(['--name', 'Group', '--trigger', '@Alef', '--folder', 'my-group']),
    ).rejects.toThrow('process.exit');
    expect(mockEmitStatus).toHaveBeenCalledWith(
      'REGISTER_CHANNEL',
      expect.objectContaining({ STATUS: 'failed', ERROR: 'missing_required_args' }),
    );
  });

  it('exits with failure when --name is missing', async () => {
    await expect(
      run(['--jid', '123@g.us', '--trigger', '@Alef', '--folder', 'my-group']),
    ).rejects.toThrow('process.exit');
    expect(mockEmitStatus).toHaveBeenCalledWith(
      'REGISTER_CHANNEL',
      expect.objectContaining({ STATUS: 'failed' }),
    );
  });

  it('exits with failure when --trigger is missing', async () => {
    await expect(
      run(['--jid', '123@g.us', '--name', 'Group', '--folder', 'my-group']),
    ).rejects.toThrow('process.exit');
    expect(mockEmitStatus).toHaveBeenCalledWith(
      'REGISTER_CHANNEL',
      expect.objectContaining({ STATUS: 'failed' }),
    );
  });

  it('exits with failure when --folder is missing', async () => {
    await expect(
      run(['--jid', '123@g.us', '--name', 'Group', '--trigger', '@Alef']),
    ).rejects.toThrow('process.exit');
    expect(mockEmitStatus).toHaveBeenCalledWith(
      'REGISTER_CHANNEL',
      expect.objectContaining({ STATUS: 'failed' }),
    );
  });

  it('does not call setRegisteredGroup when args are missing', async () => {
    await expect(run(['--jid', '123@g.us'])).rejects.toThrow();
    expect(mockSetRegisteredGroup).not.toHaveBeenCalled();
  });
});

describe('register.run() — invalid folder name', () => {
  it('exits with failure when folder name fails validation', async () => {
    mockIsValidGroupFolder.mockReturnValue(false);
    await expect(run(validArgs)).rejects.toThrow('process.exit');
    expect(mockEmitStatus).toHaveBeenCalledWith(
      'REGISTER_CHANNEL',
      expect.objectContaining({ STATUS: 'failed', ERROR: 'invalid_folder' }),
    );
  });

  it('does not call setRegisteredGroup when folder is invalid', async () => {
    mockIsValidGroupFolder.mockReturnValue(false);
    await expect(run(validArgs)).rejects.toThrow();
    expect(mockSetRegisteredGroup).not.toHaveBeenCalled();
  });
});

describe('register.run() — valid args baseline', () => {
  it('calls initDatabase on valid registration', async () => {
    await run(validArgs);
    expect(mockInitDatabase).toHaveBeenCalledOnce();
  });

  it('calls setRegisteredGroup with correct jid and group data', async () => {
    await run(validArgs);
    expect(mockSetRegisteredGroup).toHaveBeenCalledWith(
      '123@g.us',
      expect.objectContaining({
        name: 'Test Group',
        folder: 'test-group',
        trigger: '@Alef',
      }),
    );
  });

  it('creates group logs directory', async () => {
    await run(validArgs);
    const mkdirCalls = mockFs.mkdirSync.mock.calls.map((c) => String(c[0]));
    expect(mkdirCalls.some((p) => p.includes('test-group') && p.includes('logs'))).toBe(true);
  });

  it('emits success status on completion', async () => {
    await run(validArgs);
    expect(mockEmitStatus).toHaveBeenCalledWith(
      'REGISTER_CHANNEL',
      expect.objectContaining({ STATUS: 'success', JID: '123@g.us' }),
    );
  });

  it('defaults requiresTrigger to true when flag is absent', async () => {
    await run(validArgs);
    expect(mockSetRegisteredGroup).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ requiresTrigger: true }),
    );
  });

  it('defaults isMain to false when flag is absent', async () => {
    await run(validArgs);
    expect(mockSetRegisteredGroup).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ isMain: false }),
    );
  });
});

describe('register.run() — --no-trigger-required flag', () => {
  it('sets requiresTrigger=false in DB call', async () => {
    await run([...validArgs, '--no-trigger-required']);
    expect(mockSetRegisteredGroup).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ requiresTrigger: false }),
    );
  });

  it('emits REQUIRES_TRIGGER: false in success status', async () => {
    await run([...validArgs, '--no-trigger-required']);
    expect(mockEmitStatus).toHaveBeenCalledWith(
      'REGISTER_CHANNEL',
      expect.objectContaining({ REQUIRES_TRIGGER: false }),
    );
  });
});

describe('register.run() — --is-main flag', () => {
  it('sets isMain=true in DB call', async () => {
    await run([...validArgs, '--is-main']);
    expect(mockSetRegisteredGroup).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ isMain: true }),
    );
  });

  it('uses main template (not global) when copying CLAUDE.md for main group', async () => {
    // CLAUDE.md doesn't exist yet (false), but main template exists
    mockFs.existsSync.mockImplementation((p: unknown) => {
      const s = String(p);
      return s.includes('groups/main/CLAUDE.md');
    });
    await run([...validArgs, '--is-main']);
    // Should attempt copyFileSync with main template
    const copyCalls = mockFs.copyFileSync.mock.calls;
    expect(copyCalls.some((c) => String(c[0]).includes('groups/main/CLAUDE.md'))).toBe(true);
  });
});

describe('register.run() — --assistant-name flag', () => {
  it('updates ASSISTANT_NAME in .env when custom name is given', async () => {
    mockFs.existsSync.mockImplementation((p: unknown) => {
      return String(p).endsWith('.env');
    });
    mockFs.readFileSync.mockImplementation((p: unknown) => {
      if (String(p).endsWith('.env')) return 'ASSISTANT_NAME="Alef"\n';
      return '';
    });
    mockFs.readdirSync.mockReturnValue([]);

    await run([...validArgs, '--assistant-name', 'Nova']);

    const writeCalls = mockFs.writeFileSync.mock.calls;
    const envWrite = writeCalls.find((c) => String(c[0]).endsWith('.env'));
    expect(envWrite).toBeDefined();
    expect(String(envWrite![1])).toContain('ASSISTANT_NAME="Nova"');
  });

  it('creates .env with ASSISTANT_NAME when .env does not exist', async () => {
    mockFs.existsSync.mockReturnValue(false);
    mockFs.readdirSync.mockReturnValue([]);

    await run([...validArgs, '--assistant-name', 'Luna']);

    const writeCalls = mockFs.writeFileSync.mock.calls;
    const envWrite = writeCalls.find((c) => String(c[0]).endsWith('.env'));
    expect(envWrite).toBeDefined();
    expect(String(envWrite![1])).toContain('ASSISTANT_NAME="Luna"');
  });

  it('emits NAME_UPDATED: true when assistant name differs from default', async () => {
    mockFs.existsSync.mockReturnValue(false);
    mockFs.readdirSync.mockReturnValue([]);

    await run([...validArgs, '--assistant-name', 'Orion']);

    expect(mockEmitStatus).toHaveBeenCalledWith(
      'REGISTER_CHANNEL',
      expect.objectContaining({ NAME_UPDATED: true }),
    );
  });

  it('does not update .env when assistant name is the default Alef', async () => {
    await run([...validArgs, '--assistant-name', 'Alef']);
    const writeCalls = mockFs.writeFileSync.mock.calls;
    const envWrite = writeCalls.find((c) => String(c[0]).endsWith('.env'));
    expect(envWrite).toBeUndefined();
  });
});

describe('register.run() — CLAUDE.md creation', () => {
  it('copies template CLAUDE.md when it does not exist and template is present', async () => {
    mockFs.existsSync.mockImplementation((p: unknown) => {
      const s = String(p);
      // Template exists, destination does not
      return s.includes('groups/global/CLAUDE.md');
    });

    await run(validArgs);

    expect(mockFs.copyFileSync).toHaveBeenCalled();
  });

  it('does not overwrite CLAUDE.md when it already exists', async () => {
    mockFs.existsSync.mockImplementation((p: unknown) => {
      const s = String(p);
      // Both destination and template exist
      return s.includes('CLAUDE.md');
    });

    await run(validArgs);

    expect(mockFs.copyFileSync).not.toHaveBeenCalled();
  });
});
