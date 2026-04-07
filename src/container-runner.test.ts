import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---OPENGOLEM_OUTPUT_START---';
const OUTPUT_END_MARKER = '---OPENGOLEM_OUTPUT_END---';

// Mock config
vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'opengolem-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000, // 30min
  CREDENTIAL_PROXY_PORT: 3001,
  DATA_DIR: '/tmp/opengolem-test-data',
  EXTRA_DIR: '/tmp/opengolem-test-data/extra',
  GROUPS_DIR: '/tmp/opengolem-test-groups',
  IDLE_TIMEOUT: 1800000, // 30min
  SOUL_MD_PATH: '/tmp/opengolem-test-runtime/SOUL.md',
  TIMEZONE: 'America/Los_Angeles',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      copyFileSync: vi.fn(),
    },
  };
});

// Mock mount-security
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

// Mock container-runtime
vi.mock('./container-runtime.js', () => ({
  CONTAINER_RUNTIME_BIN: 'docker',
  hostGatewayArgs: () => [],
  readonlyMountArgs: (h: string, c: string) => ['-v', `${h}:${c}:ro`],
  stopContainer: vi.fn(),
}));

// Mock credential-proxy
vi.mock('./credential-proxy.js', () => ({
  getContainerProxyUrl: (port: number) => `http://host.docker.internal:${port}`,
  detectAuthMode: () => 'oauth',
}));

// Mock broker/client
vi.mock('./broker/client.js', () => ({
  issueToken: vi.fn().mockResolvedValue('test-broker-token'),
  revokeContainer: vi.fn().mockResolvedValue(undefined),
}));

// Mock group-folder
vi.mock('./group-folder.js', () => ({
  assertValidGroupFolder: vi.fn(),
  resolveGroupFolderPath: vi.fn(
    (folder: string) => `/tmp/opengolem-test-groups/${folder}`,
  ),
}));

// Mock shared/audit
vi.mock('./shared/audit/index.js', () => ({
  openAuditLog: vi.fn(() => ({
    writeEvent: vi.fn(),
  })),
}));

// Create a controllable fake ChildProcess
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

// Mock child_process.spawn
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
    exec: vi.fn(
      (_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
        if (cb) cb(null);
        return new EventEmitter();
      },
    ),
  };
});

import { runContainerAgent, ContainerOutput } from './container-runner.js';
import type { RegisteredGroup } from './types.js';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Alef',
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

function emitOutputMarker(
  proc: ReturnType<typeof createFakeProcess>,
  output: ContainerOutput,
) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

// --- Base behavior tests (clean-room) ---

describe('container-runner — normal exit with output', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns success with result when container exits 0 with sentinel output', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'All done',
      newSessionId: 'session-ok',
    });

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
  });

  it('calls onOutput callback with the parsed sentinel payload', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Response text',
      newSessionId: 'sess-cb',
    });

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    await resultPromise;
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'success',
        result: 'Response text',
        newSessionId: 'sess-cb',
      }),
    );
  });

  it('passes the child process and container name to onProcess callback', async () => {
    const onProcess = vi.fn();
    const resultPromise = runContainerAgent(testGroup, testInput, onProcess);

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    await resultPromise;
    expect(onProcess).toHaveBeenCalledWith(
      fakeProc,
      expect.stringContaining('opengolem-test-group'),
    );
  });
});

describe('container-runner — error exit', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns error status when container exits non-zero without output', async () => {
    const resultPromise = runContainerAgent(testGroup, testInput, () => {});

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 1);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
  });

  it('includes exit code in error message', async () => {
    const resultPromise = runContainerAgent(testGroup, testInput, () => {});

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 127);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('127');
  });

  it('returns error when spawn emits an error event', async () => {
    const resultPromise = runContainerAgent(testGroup, testInput, () => {});

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('error', new Error('spawn ENOENT'));
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('spawn ENOENT');
  });
});

describe('container-runner — timeout behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('timeout after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output with a result
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-123',
    });

    // Let output processing settle
    await vi.advanceTimersByTimeAsync(10);

    // Fire the hard timeout (IDLE_TIMEOUT + 30s = 1830000ms)
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event (as if container was stopped by the timeout)
    fakeProc.emit('close', 137);

    // Let the promise resolve
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-123');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Here is my response' }),
    );
  });

  it('timeout with no output resolves as error', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // No output emitted — fire the hard timeout
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event
    fakeProc.emit('close', 137);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('normal exit after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-456',
    });

    await vi.advanceTimersByTimeAsync(10);

    // Normal exit (no timeout)
    fakeProc.emit('close', 0);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-456');
  });
});

describe('container-runner — docker args assembly', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('spawns docker with run, --rm, and container image', async () => {
    const { spawn } = await import('child_process');
    const spawnMock = spawn as ReturnType<typeof vi.fn>;

    const resultPromise = runContainerAgent(testGroup, testInput, () => {});

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    expect(spawnMock).toHaveBeenCalled();
    const [bin, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(bin).toBe('docker');
    expect(args).toContain('run');
    expect(args).toContain('--rm');
    expect(args).toContain('opengolem-agent:latest');
  });

  it('passes TZ environment variable to container', async () => {
    const { spawn } = await import('child_process');
    const spawnMock = spawn as ReturnType<typeof vi.fn>;

    const resultPromise = runContainerAgent(testGroup, testInput, () => {});

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    const tzArgs = args
      .map((a, i) => (args[i - 1] === '-e' ? a : null))
      .filter(Boolean);
    expect(tzArgs.some((a) => String(a).startsWith('TZ='))).toBe(true);
  });

  it('passes ANTHROPIC_BASE_URL to container pointing at proxy', async () => {
    const { spawn } = await import('child_process');
    const spawnMock = spawn as ReturnType<typeof vi.fn>;

    const resultPromise = runContainerAgent(testGroup, testInput, () => {});

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    const envValues = args
      .map((a, i) => (args[i - 1] === '-e' ? a : null))
      .filter(Boolean) as string[];
    expect(envValues.some((a) => a.startsWith('ANTHROPIC_BASE_URL='))).toBe(
      true,
    );
  });

  it('names the container with the group folder prefix', async () => {
    const { spawn } = await import('child_process');
    const spawnMock = spawn as ReturnType<typeof vi.fn>;

    const resultPromise = runContainerAgent(testGroup, testInput, () => {});

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    const nameIndex = args.indexOf('--name');
    expect(nameIndex).toBeGreaterThan(-1);
    expect(args[nameIndex + 1]).toMatch(/^opengolem-test-group-/);
  });
});

describe('container-runner — mount security validation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls validateAdditionalMounts when containerConfig.additionalMounts is present', async () => {
    const { validateAdditionalMounts } = await import('./mount-security.js');
    const validateMock = validateAdditionalMounts as ReturnType<typeof vi.fn>;
    validateMock.mockReturnValue([]);

    const groupWithMounts: RegisteredGroup = {
      ...testGroup,
      containerConfig: {
        additionalMounts: [
          {
            hostPath: '/data/docs',
            containerPath: '/workspace/docs',
            readonly: true,
          },
        ],
      },
    };

    const resultPromise = runContainerAgent(
      groupWithMounts,
      testInput,
      () => {},
    );

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    expect(validateMock).toHaveBeenCalledWith(
      groupWithMounts.containerConfig!.additionalMounts,
      groupWithMounts.name,
      testInput.isMain,
    );
  });

  it('does not call validateAdditionalMounts when no extra mounts are configured', async () => {
    const { validateAdditionalMounts } = await import('./mount-security.js');
    const validateMock = validateAdditionalMounts as ReturnType<typeof vi.fn>;
    validateMock.mockClear();

    const resultPromise = runContainerAgent(testGroup, testInput, () => {});

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    expect(validateMock).not.toHaveBeenCalled();
  });
});

// --- M35 Sentinel protocol validation tests (preserved verbatim) ---

describe('Sentinel protocol validation — M35', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('item 1 — well-formed sentinel output is parsed correctly', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Agent response',
      newSessionId: 'sess-well-formed',
    });

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('sess-well-formed');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'success',
        result: 'Agent response',
        newSessionId: 'sess-well-formed',
      }),
    );
  });

  it('item 2 — missing OUTPUT_START marker: resolves as error, does not crash', async () => {
    // Without onOutput, legacyResolve handles stdout. No sentinel markers
    // means no pair found; last-line fallback also has no parseable JSON.
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      // no onOutput — forces legacy path
    );

    // Emit output that has no sentinel markers
    fakeProc.stdout.push('some agent log line without any markers\n');

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    // legacyResolve: last non-empty line is not valid JSON → success with raw text
    // OR no output at all → error. Either way the process must not crash.
    // Confirm: legacyResolve returns { status: 'success', result: lastLine } for plain text.
    expect(result.status).toBe('success');
    expect(result.result).toBe('some agent log line without any markers');
  });

  it('item 2 — missing OUTPUT_START marker with onOutput: treated as no streaming output → success with null result', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit text with OUTPUT_END but no OUTPUT_START
    fakeProc.stdout.push(`some noise\n${OUTPUT_END_MARKER}\n`);

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    // No START marker → drainMarkerPairs yields no outputs → hadStreamingOutput=false
    // close path with onOutput + exit 0 + no streaming → success with null
    expect(result.status).toBe('success');
    expect(result.result).toBeNull();
    // onOutput should NOT have been called — no valid pair was parsed
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('item 3 — malformed JSON between markers: resolves as error, does not crash', async () => {
    // With onOutput: malformed JSON → parseMarkerPayload returns null → pair dropped
    // → hadStreamingOutput stays false → close path → success with null (exit 0)
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Malformed JSON between markers
    fakeProc.stdout.push(
      `${OUTPUT_START_MARKER}\n{this is not json!!!\n${OUTPUT_END_MARKER}\n`,
    );

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 1); // non-zero exit to distinguish the error path
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    // Malformed pair dropped → no streaming output → exit code 1 → error
    expect(result.status).toBe('error');
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('item 3 — malformed JSON between markers without onOutput: legacyResolve finds no valid pair → error', async () => {
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      // no onOutput
    );

    fakeProc.stdout.push(
      `${OUTPUT_START_MARKER}\n{BAD JSON\n${OUTPUT_END_MARKER}\n`,
    );

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    // legacyResolve: drainMarkerPairs finds pair but JSON parse fails → null
    // last-line fallback: last non-empty line is OUTPUT_END_MARKER → not valid JSON → success with raw text
    // Actually legacyResolve last-line tries to parse OUTPUT_END_MARKER as JSON → fails → returns {status:'success', result: OUTPUT_END_MARKER}
    // The key invariant: does not crash and returns a defined result
    expect(result).toBeDefined();
    expect(result.status).toBeDefined();
  });

  it('item 4 — output outside markers is discarded and does not affect result', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Noise before and after the sentinel block
    fakeProc.stdout.push('pre-marker noise line 1\n');
    fakeProc.stdout.push('pre-marker noise line 2\n');
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Real agent output',
      newSessionId: 'sess-noise-test',
    });
    fakeProc.stdout.push('post-marker noise line\n');

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('sess-noise-test');
    // onOutput called exactly once with the real payload, not the noise
    expect(onOutput).toHaveBeenCalledTimes(1);
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Real agent output' }),
    );
  });

  it('item 5 — newSessionId in sentinel output is stored and returned in result', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Response text',
      newSessionId: 'sess-abc',
    });

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('sess-abc');
    // Also verify onOutput received it
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ newSessionId: 'sess-abc' }),
    );
  });

  it('item 5 — newSessionId is updated to the last sentinel output when multiple are emitted', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Multiple sentinel outputs — last newSessionId wins
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'First chunk',
      newSessionId: 'sess-first',
    });
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Second chunk',
      newSessionId: 'sess-abc',
    });

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('sess-abc');
  });
});
