import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Clean-room tests for setup/service.ts run() function.
 *
 * Tests build-first gate, service manager selection, plist/unit/nohup file
 * generation, and status emission — without actually loading any system service.
 */

// --- Hoisted mock state (vi.mock factories are hoisted before variable declarations) ---

const {
  mockEmitStatus,
  mockFs,
  mockGetPlatform,
  mockGetNodePath,
  mockGetServiceManager,
  mockHasSystemd,
  mockIsRoot,
  mockIsWSL,
  mockExecSync,
  mockExecFileSync,
} = vi.hoisted(() => {
  const mockFs = {
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    existsSync: vi.fn(() => false),
  };
  return {
    mockEmitStatus: vi.fn(),
    mockFs,
    mockGetPlatform: vi.fn(() => 'linux' as const),
    mockGetNodePath: vi.fn(() => '/usr/bin/node'),
    mockGetServiceManager: vi.fn(() => 'systemd' as const),
    mockHasSystemd: vi.fn(() => true),
    mockIsRoot: vi.fn(() => false),
    mockIsWSL: vi.fn(() => false),
    mockExecSync: vi.fn(() => ''),
    mockExecFileSync: vi.fn(() => ''),
  };
});

vi.mock('./status.js', () => ({
  emitStatus: mockEmitStatus,
}));

vi.mock('../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: mockFs.mkdirSync,
      writeFileSync: mockFs.writeFileSync,
      existsSync: mockFs.existsSync,
    },
  };
});

vi.mock('./platform.js', () => ({
  getPlatform: mockGetPlatform,
  getNodePath: mockGetNodePath,
  getServiceManager: mockGetServiceManager,
  hasSystemd: mockHasSystemd,
  isRoot: mockIsRoot,
  isWSL: mockIsWSL,
}));

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execSync: mockExecSync,
    execFileSync: mockExecFileSync,
  };
});

vi.spyOn(process, 'exit').mockImplementation(() => {
  throw new Error('process.exit');
});

import { run } from './service.js';

beforeEach(() => {
  vi.clearAllMocks();
  // Default happy-path: linux + systemd + non-root + build succeeds
  mockGetPlatform.mockReturnValue('linux');
  mockGetNodePath.mockReturnValue('/usr/bin/node');
  mockGetServiceManager.mockReturnValue('systemd');
  mockHasSystemd.mockReturnValue(true);
  mockIsRoot.mockReturnValue(false);
  mockIsWSL.mockReturnValue(false);
  mockFs.existsSync.mockReturnValue(false);
  mockExecSync.mockReturnValue('');
  mockExecFileSync.mockReturnValue('');
});

afterEach(() => {
  vi.restoreAllMocks();
});

// --- Tests ---

describe('service.run() — build failure gate', () => {
  it('emits failed status and exits when npm build fails', async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('npm run build')) throw new Error('Build error');
      return '';
    });

    await expect(run([])).rejects.toThrow('process.exit');
    expect(mockEmitStatus).toHaveBeenCalledWith(
      'SETUP_SERVICE',
      expect.objectContaining({ STATUS: 'failed', ERROR: 'build_failed' }),
    );
  });

  it('does not write any service file when build fails', async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('npm run build')) throw new Error('Build error');
      return '';
    });

    await expect(run([])).rejects.toThrow();
    expect(mockFs.writeFileSync).not.toHaveBeenCalled();
  });
});

describe('service.run() — unsupported platform', () => {
  it('emits failed status and exits on unknown platform', async () => {
    mockGetPlatform.mockReturnValue('unknown' as 'macos');

    await expect(run([])).rejects.toThrow('process.exit');
    expect(mockEmitStatus).toHaveBeenCalledWith(
      'SETUP_SERVICE',
      expect.objectContaining({ STATUS: 'failed', ERROR: 'unsupported_platform' }),
    );
  });
});

describe('service.run() — macOS launchd path', () => {
  beforeEach(() => {
    mockGetPlatform.mockReturnValue('macos');
    mockGetServiceManager.mockReturnValue('launchd');
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('npm run build')) return '';
      if (cmd.includes('launchctl list')) return 'com.opengolem\tsomething';
      return '';
    });
  });

  it('writes a plist file', async () => {
    await run([]);
    const calls = mockFs.writeFileSync.mock.calls;
    const plistCall = calls.find((c) => String(c[0]).endsWith('.plist'));
    expect(plistCall).toBeDefined();
  });

  it('plist content includes com.opengolem label', async () => {
    await run([]);
    const calls = mockFs.writeFileSync.mock.calls;
    const plistCall = calls.find((c) => String(c[0]).endsWith('.plist'));
    expect(String(plistCall![1])).toContain('com.opengolem');
  });

  it('plist content includes node path and dist/index.js', async () => {
    await run([]);
    const calls = mockFs.writeFileSync.mock.calls;
    const plistCall = calls.find((c) => String(c[0]).endsWith('.plist'));
    const content = String(plistCall![1]);
    expect(content).toContain('/usr/bin/node');
    expect(content).toContain('dist/index.js');
  });

  it('emits success status with SERVICE_TYPE=launchd', async () => {
    await run([]);
    expect(mockEmitStatus).toHaveBeenCalledWith(
      'SETUP_SERVICE',
      expect.objectContaining({ STATUS: 'success', SERVICE_TYPE: 'launchd' }),
    );
  });

  it('calls launchctl load with the plist path', async () => {
    await run([]);
    const execFileCalls = mockExecFileSync.mock.calls;
    const loadCall = execFileCalls.find(
      (c) => c[0] === 'launchctl' && Array.isArray(c[1]) && (c[1] as string[])[0] === 'load',
    );
    expect(loadCall).toBeDefined();
  });
});

describe('service.run() — Linux systemd (user) path', () => {
  it('writes a systemd unit file', async () => {
    await run([]);
    const calls = mockFs.writeFileSync.mock.calls;
    const unitCall = calls.find((c) => String(c[0]).endsWith('.service'));
    expect(unitCall).toBeDefined();
  });

  it('systemd unit includes ExecStart with node and dist/index.js', async () => {
    await run([]);
    const calls = mockFs.writeFileSync.mock.calls;
    const unitCall = calls.find((c) => String(c[0]).endsWith('.service'));
    const content = String(unitCall![1]);
    expect(content).toContain('ExecStart=/usr/bin/node');
    expect(content).toContain('dist/index.js');
  });

  it('user unit uses default.target', async () => {
    mockIsRoot.mockReturnValue(false);
    await run([]);
    const calls = mockFs.writeFileSync.mock.calls;
    const unitCall = calls.find((c) => String(c[0]).endsWith('.service'));
    expect(String(unitCall![1])).toContain('WantedBy=default.target');
  });

  it('system unit (root) uses multi-user.target', async () => {
    mockIsRoot.mockReturnValue(true);
    await run([]);
    const calls = mockFs.writeFileSync.mock.calls;
    const unitCall = calls.find((c) => String(c[0]).endsWith('.service'));
    expect(String(unitCall![1])).toContain('WantedBy=multi-user.target');
  });

  it('emits success status with SERVICE_TYPE=systemd-user', async () => {
    mockIsRoot.mockReturnValue(false);
    await run([]);
    expect(mockEmitStatus).toHaveBeenCalledWith(
      'SETUP_SERVICE',
      expect.objectContaining({ STATUS: 'success', SERVICE_TYPE: 'systemd-user' }),
    );
  });

  it('emits success status with SERVICE_TYPE=systemd-system when root', async () => {
    mockIsRoot.mockReturnValue(true);
    await run([]);
    expect(mockEmitStatus).toHaveBeenCalledWith(
      'SETUP_SERVICE',
      expect.objectContaining({ STATUS: 'success', SERVICE_TYPE: 'systemd-system' }),
    );
  });

  it('calls systemctl daemon-reload, enable, and start', async () => {
    await run([]);
    const execFileCalls = mockExecFileSync.mock.calls;
    const getCmd = (call: unknown[]) => {
      const args = call[1] as string[];
      return args.filter((a) => a !== '--user').join(' ');
    };
    const cmds = execFileCalls
      .filter((c) => c[0] === 'systemctl')
      .map(getCmd);
    expect(cmds).toContain('daemon-reload');
    expect(cmds).toContain('enable opengolem');
    expect(cmds).toContain('start opengolem');
  });

  it('falls back to nohup when systemd user session is unavailable', async () => {
    mockIsRoot.mockReturnValue(false);
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('npm run build')) return '';
      // Simulate systemctl --user daemon-reload check failing → triggers nohup fallback
      if (cmd.includes('systemctl') && cmd.includes('daemon-reload')) {
        throw new Error('systemd user session unavailable');
      }
      return '';
    });

    await run([]);

    const writeCalls = mockFs.writeFileSync.mock.calls;
    const wrapperCall = writeCalls.find((c) =>
      String(c[0]).endsWith('start-opengolem.sh'),
    );
    expect(wrapperCall).toBeDefined();
    expect(mockEmitStatus).toHaveBeenCalledWith(
      'SETUP_SERVICE',
      expect.objectContaining({ STATUS: 'success', SERVICE_TYPE: 'nohup' }),
    );
  });
});

describe('service.run() — nohup fallback (no systemd)', () => {
  beforeEach(() => {
    mockGetPlatform.mockReturnValue('linux');
    mockGetServiceManager.mockReturnValue('none');
    mockHasSystemd.mockReturnValue(false);
    // systemctl --user daemon-reload throws (no user session)
    mockExecFileSync.mockImplementation((bin: string, args: string[]) => {
      if (bin === 'systemctl' && args.includes('daemon-reload')) {
        throw new Error('no systemd');
      }
      return '';
    });
  });

  it('writes start-opengolem.sh wrapper', async () => {
    await run([]);
    const calls = mockFs.writeFileSync.mock.calls;
    const wrapperCall = calls.find((c) =>
      String(c[0]).endsWith('start-opengolem.sh'),
    );
    expect(wrapperCall).toBeDefined();
  });

  it('wrapper script contains bash shebang', async () => {
    await run([]);
    const calls = mockFs.writeFileSync.mock.calls;
    const wrapperCall = calls.find((c) =>
      String(c[0]).endsWith('start-opengolem.sh'),
    );
    expect(String(wrapperCall![1])).toContain('#!/bin/bash');
  });

  it('wrapper script contains nohup', async () => {
    await run([]);
    const calls = mockFs.writeFileSync.mock.calls;
    const wrapperCall = calls.find((c) =>
      String(c[0]).endsWith('start-opengolem.sh'),
    );
    expect(String(wrapperCall![1])).toContain('nohup');
  });

  it('emits success status with SERVICE_TYPE=nohup', async () => {
    await run([]);
    expect(mockEmitStatus).toHaveBeenCalledWith(
      'SETUP_SERVICE',
      expect.objectContaining({ STATUS: 'success', SERVICE_TYPE: 'nohup' }),
    );
  });
});
