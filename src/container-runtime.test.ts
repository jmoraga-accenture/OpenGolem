import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock child_process before importing the module under test
vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

// Mock os so we can control platform
vi.mock('os', () => ({
  default: {
    platform: vi.fn(() => 'linux'),
  },
}));

import { execSync } from 'child_process';
import os from 'os';
import {
  hostGatewayArgs,
  readonlyMountArgs,
  stopContainer,
  ensureContainerRuntimeRunning,
  CONTAINER_RUNTIME_BIN,
} from './container-runtime.js';

const mockExecSync = vi.mocked(execSync);
const mockPlatform = vi.mocked(os.platform);

beforeEach(() => {
  vi.clearAllMocks();
});

// --- hostGatewayArgs ---

describe('hostGatewayArgs', () => {
  it('returns host-gateway arg on linux', () => {
    mockPlatform.mockReturnValue('linux');
    const args = hostGatewayArgs();
    expect(args).toContain('--add-host=host.docker.internal:host-gateway');
  });

  it('returns empty array on non-linux platforms', () => {
    mockPlatform.mockReturnValue('darwin');
    const args = hostGatewayArgs();
    expect(args).toEqual([]);
  });
});

// --- readonlyMountArgs ---

describe('readonlyMountArgs', () => {
  it('returns a -v flag followed by host:container:ro', () => {
    const args = readonlyMountArgs('/host/path', '/container/path');
    expect(args).toEqual(['-v', '/host/path:/container/path:ro']);
  });

  it('first element is -v', () => {
    const args = readonlyMountArgs('/a', '/b');
    expect(args[0]).toBe('-v');
  });

  it('second element contains :ro suffix', () => {
    const args = readonlyMountArgs('/foo', '/bar');
    expect(args[1]).toMatch(/:ro$/);
  });
});

// --- stopContainer ---

describe('stopContainer', () => {
  it('calls execSync with the correct docker stop command', () => {
    mockExecSync.mockReturnValue(Buffer.from(''));
    stopContainer('opengolem-abc123');
    expect(mockExecSync).toHaveBeenCalledWith(
      `${CONTAINER_RUNTIME_BIN} stop -t 1 opengolem-abc123`,
      { stdio: 'pipe' },
    );
  });

  it('throws for invalid container name', () => {
    expect(() => stopContainer('bad name!')).toThrow('Invalid container name');
  });

  it('throws for container name starting with special char', () => {
    expect(() => stopContainer('-bad')).toThrow('Invalid container name');
  });

  it('accepts alphanumeric names with dots and underscores', () => {
    mockExecSync.mockReturnValue(Buffer.from(''));
    expect(() => stopContainer('container_name.1')).not.toThrow();
  });
});

// --- ensureContainerRuntimeRunning ---

describe('ensureContainerRuntimeRunning', () => {
  it('does not throw when docker info succeeds', () => {
    mockExecSync.mockReturnValue(Buffer.from('Server: Docker Engine'));
    expect(() => ensureContainerRuntimeRunning()).not.toThrow();
  });

  it('calls docker info', () => {
    mockExecSync.mockReturnValue(Buffer.from(''));
    ensureContainerRuntimeRunning();
    expect(mockExecSync).toHaveBeenCalledWith(
      `${CONTAINER_RUNTIME_BIN} info`,
      expect.objectContaining({ stdio: 'pipe' }),
    );
  });

  it('throws when docker info fails', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('docker daemon not running');
    });
    expect(() => ensureContainerRuntimeRunning()).toThrow(
      'Container runtime is required but failed to start',
    );
  });

  it('includes the original error as cause when docker info fails', () => {
    const cause = new Error('daemon down');
    mockExecSync.mockImplementation(() => {
      throw cause;
    });
    let thrown: unknown;
    expect(() => {
      try {
        ensureContainerRuntimeRunning();
      } catch (err: unknown) {
        thrown = err;
        throw err;
      }
    }).toThrow();
    expect((thrown as { cause?: unknown }).cause).toBe(cause);
  });
});
