import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { logger } from './logger.js';

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('./config.js', () => ({
  MOUNT_ALLOWLIST_PATH: '/test/mount-allowlist.json',
}));

const allowlistJson = (extra?: Partial<{ roots: unknown[]; patterns: string[] }>) =>
  JSON.stringify({
    allowedRoots: extra?.roots ?? [
      { path: '/allowed/proj', allowReadWrite: true, description: 'dev' },
    ],
    blockedPatterns: extra?.patterns ?? [],
    nonMainReadOnly: true,
  });

describe('mount-security', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.spyOn(fs, 'existsSync');
    vi.spyOn(fs, 'readFileSync');
    vi.spyOn(fs, 'realpathSync');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('generateAllowlistTemplate returns pretty-printed MountAllowlist JSON', async () => {
    const { generateAllowlistTemplate } = await import('./mount-security.js');
    const raw = generateAllowlistTemplate();
    const parsed = JSON.parse(raw) as {
      allowedRoots: unknown[];
      blockedPatterns: unknown[];
      nonMainReadOnly: boolean;
    };
    expect(parsed.allowedRoots.length).toBe(3);
    expect(Array.isArray(parsed.blockedPatterns)).toBe(true);
    expect(parsed.nonMainReadOnly).toBe(true);
    expect(raw).toContain('\n  "allowedRoots"');
  });

  it('loadMountAllowlist warns and returns null when file is missing', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const { loadMountAllowlist } = await import('./mount-security.js');
    expect(loadMountAllowlist()).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      { path: '/test/mount-allowlist.json' },
      expect.stringContaining('Mount allowlist not found'),
    );
  });

  it('loadMountAllowlist can succeed on a later call after file appears', async () => {
    vi.mocked(fs.existsSync)
      .mockReturnValueOnce(false)
      .mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(allowlistJson());

    const { loadMountAllowlist } = await import('./mount-security.js');
    expect(loadMountAllowlist()).toBeNull();
    const list = loadMountAllowlist();
    expect(list).not.toBeNull();
    expect(list!.blockedPatterns).toContain('.ssh');
  });

  it('loadMountAllowlist merges default blocked patterns', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      allowlistJson({ patterns: ['custom-block'] }),
    );

    const { loadMountAllowlist } = await import('./mount-security.js');
    const list = loadMountAllowlist();
    expect(list!.blockedPatterns).toContain('custom-block');
    expect(list!.blockedPatterns).toContain('.ssh');
    expect(list!.blockedPatterns).toContain('credentials');
  });

  it('loadMountAllowlist does not re-read the file after a successful cache hit', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(allowlistJson());

    const { loadMountAllowlist } = await import('./mount-security.js');
    const first = loadMountAllowlist();
    const second = loadMountAllowlist();
    expect(second).toBe(first);
    expect(fs.readFileSync).toHaveBeenCalledTimes(1);
  });

  it('loadMountAllowlist caches parse errors and returns null without re-reading', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('not json {{{');

    const { loadMountAllowlist } = await import('./mount-security.js');
    expect(loadMountAllowlist()).toBeNull();
    expect(loadMountAllowlist()).toBeNull();
    expect(fs.readFileSync).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalled();
  });

  it('validateMount rejects when allowlist is missing', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const { validateMount } = await import('./mount-security.js');
    const r = validateMount({ hostPath: '/any' }, true);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('No mount allowlist configured');
  });

  it('validateMount rejects invalid container paths', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(allowlistJson());
    const { validateMount } = await import('./mount-security.js');
    const r = validateMount(
      { hostPath: '/allowed/proj/x', containerPath: 'evil:rw' },
      true,
    );
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('Invalid container path');
  });

  it('validateMount rejects non-existent host paths', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(allowlistJson());
    vi.mocked(fs.realpathSync).mockImplementation(() => {
      throw new Error('ENOENT');
    });
    const { loadMountAllowlist, validateMount } = await import(
      './mount-security.js'
    );
    loadMountAllowlist();
    const r = validateMount({ hostPath: '/allowed/proj/nope' }, true);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('Host path does not exist');
  });

  it('validateMount rejects paths matching blocked patterns', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(allowlistJson());
    vi.mocked(fs.realpathSync).mockImplementation((p) => String(p));
    const { loadMountAllowlist, validateMount } = await import(
      './mount-security.js'
    );
    loadMountAllowlist();
    const r = validateMount({ hostPath: '/allowed/proj/.ssh/keys' }, true);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('blocked pattern');
  });

  it('validateMount rejects paths outside allowed roots', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(allowlistJson());
    vi.mocked(fs.realpathSync).mockImplementation((p) => String(p));
    const { loadMountAllowlist, validateMount } = await import(
      './mount-security.js'
    );
    loadMountAllowlist();
    const r = validateMount({ hostPath: '/etc/passwd' }, true);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('not under any allowed root');
  });

  it('validateMount allows mounts under an allowed root', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(allowlistJson());
    vi.mocked(fs.realpathSync).mockImplementation((p) => String(p));
    const { loadMountAllowlist, validateMount } = await import(
      './mount-security.js'
    );
    loadMountAllowlist();
    const r = validateMount({ hostPath: '/allowed/proj/repo' }, true);
    expect(r.allowed).toBe(true);
    expect(r.realHostPath).toBe('/allowed/proj/repo');
    expect(r.resolvedContainerPath).toBe('repo');
    expect(r.effectiveReadonly).toBe(true);
  });

  it('validateMount allows read-write for main group when root permits it', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(allowlistJson());
    vi.mocked(fs.realpathSync).mockImplementation((p) => String(p));
    const { loadMountAllowlist, validateMount } = await import(
      './mount-security.js'
    );
    loadMountAllowlist();
    vi.clearAllMocks();
    const r = validateMount(
      { hostPath: '/allowed/proj/writable-tree', readonly: false },
      true,
    );
    expect(r.allowed).toBe(true);
    expect(r.effectiveReadonly).toBe(false);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('validateMount forces read-only for non-main when nonMainReadOnly is true', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      allowlistJson({ roots: [{ path: '/allowed', allowReadWrite: true }] }),
    );
    vi.mocked(fs.realpathSync).mockImplementation((p) => String(p));
    const { loadMountAllowlist, validateMount } = await import(
      './mount-security.js'
    );
    loadMountAllowlist();
    const r = validateMount(
      { hostPath: '/allowed/x', readonly: false },
      false,
    );
    expect(r.allowed).toBe(true);
    expect(r.effectiveReadonly).toBe(true);
    expect(logger.info).toHaveBeenCalledWith(
      { mount: '/allowed/x' },
      'Mount forced to read-only for non-main group',
    );
  });

  it('validateAdditionalMounts collects allowed mounts and logs rejected ones', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(allowlistJson());
    vi.mocked(fs.realpathSync).mockImplementation((p) => String(p));
    const { loadMountAllowlist, validateAdditionalMounts } = await import(
      './mount-security.js'
    );
    loadMountAllowlist();
    const out = validateAdditionalMounts(
      [
        { hostPath: '/allowed/proj/good' },
        { hostPath: '/etc/secret' },
      ],
      'g1',
      true,
    );
    expect(out).toHaveLength(1);
    expect(out[0].containerPath).toBe('/workspace/extra/good');
    expect(out[0].readonly).toBe(true);
    expect(logger.debug).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });
});
