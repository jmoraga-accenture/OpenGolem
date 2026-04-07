import path from 'path';

import { describe, it, expect } from 'vitest';

import {
  isValidGroupFolder,
  assertValidGroupFolder,
  resolveGroupFolderPath,
  resolveGroupIpcPath,
} from './group-folder.js';

describe('isValidGroupFolder', () => {
  describe('valid names', () => {
    it('accepts a simple lowercase word', () => {
      expect(isValidGroupFolder('main')).toBe(true);
    });

    it('accepts names with hyphens', () => {
      expect(isValidGroupFolder('family-chat')).toBe(true);
    });

    it('accepts names with underscores', () => {
      expect(isValidGroupFolder('work_team')).toBe(true);
    });

    it('accepts names with mixed case and digits', () => {
      expect(isValidGroupFolder('Team42')).toBe(true);
    });

    it('accepts a single alphanumeric character', () => {
      expect(isValidGroupFolder('a')).toBe(true);
    });

    it('accepts a 64-character name (max length)', () => {
      // pattern allows 1 leading char + up to 63 more = 64 total
      const name = 'a' + 'b'.repeat(63);
      expect(isValidGroupFolder(name)).toBe(true);
    });
  });

  describe('invalid names', () => {
    it('rejects an empty string', () => {
      expect(isValidGroupFolder('')).toBe(false);
    });

    it('rejects names with leading whitespace', () => {
      expect(isValidGroupFolder(' main')).toBe(false);
    });

    it('rejects names with trailing whitespace', () => {
      expect(isValidGroupFolder('main ')).toBe(false);
    });

    it('rejects names containing a forward slash', () => {
      expect(isValidGroupFolder('some/folder')).toBe(false);
    });

    it('rejects names containing a backslash', () => {
      expect(isValidGroupFolder('some\\folder')).toBe(false);
    });

    it('rejects dotdot traversal sequences', () => {
      expect(isValidGroupFolder('..')).toBe(false);
      expect(isValidGroupFolder('../../etc')).toBe(false);
    });

    it('rejects names starting with a dot', () => {
      expect(isValidGroupFolder('.hidden')).toBe(false);
    });

    it('rejects the reserved name "global" (case-insensitive)', () => {
      expect(isValidGroupFolder('global')).toBe(false);
      expect(isValidGroupFolder('GLOBAL')).toBe(false);
      expect(isValidGroupFolder('Global')).toBe(false);
    });

    it('rejects absolute paths', () => {
      expect(isValidGroupFolder('/tmp')).toBe(false);
    });

    it('rejects names longer than 64 characters', () => {
      const name = 'a' + 'b'.repeat(64); // 65 chars
      expect(isValidGroupFolder(name)).toBe(false);
    });

    it('rejects names with spaces in the middle', () => {
      expect(isValidGroupFolder('my group')).toBe(false);
    });
  });
});

describe('assertValidGroupFolder', () => {
  it('does not throw for a valid folder name', () => {
    expect(() => assertValidGroupFolder('valid-group')).not.toThrow();
  });

  it('throws for an empty string', () => {
    expect(() => assertValidGroupFolder('')).toThrow();
  });

  it('throws for a path traversal attempt', () => {
    expect(() => assertValidGroupFolder('../../secret')).toThrow();
  });

  it('throws for the reserved name "global"', () => {
    expect(() => assertValidGroupFolder('global')).toThrow();
  });

  it('throws an Error whose message references the bad folder', () => {
    expect(() => assertValidGroupFolder('bad folder!')).toThrowError(
      /bad folder!/,
    );
  });
});

describe('resolveGroupFolderPath', () => {
  it('returns a path ending with groups/<name>', () => {
    const result = resolveGroupFolderPath('my-group');
    expect(result.endsWith(`${path.sep}groups${path.sep}my-group`)).toBe(true);
  });

  it('returns an absolute path', () => {
    const result = resolveGroupFolderPath('my-group');
    expect(path.isAbsolute(result)).toBe(true);
  });

  it('throws for an invalid folder name', () => {
    expect(() => resolveGroupFolderPath('../../etc')).toThrow();
  });

  it('throws for the reserved folder "global"', () => {
    expect(() => resolveGroupFolderPath('global')).toThrow();
  });
});

describe('resolveGroupIpcPath', () => {
  it('returns a path ending with data/ipc/<name>', () => {
    const result = resolveGroupIpcPath('chat-room');
    expect(
      result.endsWith(`${path.sep}data${path.sep}ipc${path.sep}chat-room`),
    ).toBe(true);
  });

  it('returns an absolute path', () => {
    const result = resolveGroupIpcPath('chat-room');
    expect(path.isAbsolute(result)).toBe(true);
  });

  it('throws for an invalid folder name', () => {
    expect(() => resolveGroupIpcPath('/tmp')).toThrow();
  });

  it('throws for the reserved folder "global"', () => {
    expect(() => resolveGroupIpcPath('global')).toThrow();
  });
});
