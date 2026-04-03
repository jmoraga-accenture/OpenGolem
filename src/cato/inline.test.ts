import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import net from 'net';
import os from 'os';
import path from 'path';
import fs from 'fs';

vi.mock('../config.js', () => ({
  CATO_SOCKET_PATH: path.join(os.tmpdir(), `cato-test-${process.pid}.sock`),
  DATA_DIR: os.tmpdir(),
}));
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
import {
  startCatoInlineHook,
  stopCatoInlineHook,
  catoCheck,
  type CatoCheckRequest,
} from './inline.js';
import { CATO_SOCKET_PATH } from '../config.js';

function cleanSocket() {
  try {
    fs.unlinkSync(CATO_SOCKET_PATH);
  } catch {
    /* ok */
  }
}

describe('Cato inline hook — server lifecycle', () => {
  beforeEach(() => {
    cleanSocket();
  });
  afterEach(() => {
    stopCatoInlineHook();
    cleanSocket();
  });

  it('starts without throwing', () => {
    expect(() => startCatoInlineHook()).not.toThrow();
  });

  it('creates the socket file', async () => {
    startCatoInlineHook();
    // Give the server a tick to bind
    await new Promise((r) => setTimeout(r, 50));
    expect(fs.existsSync(CATO_SOCKET_PATH)).toBe(true);
  });

  it('stopCatoInlineHook is idempotent', () => {
    startCatoInlineHook();
    expect(() => {
      stopCatoInlineHook();
      stopCatoInlineHook();
    }).not.toThrow();
  });
});

describe('Cato inline hook — deterministic checks', () => {
  beforeEach(async () => {
    cleanSocket();
    startCatoInlineHook();
    await new Promise((r) => setTimeout(r, 50));
  });
  afterEach(() => {
    stopCatoInlineHook();
    cleanSocket();
  });

  function req(prompt: string): CatoCheckRequest {
    return { type: 'check_action', groupFolder: 'test-group', prompt };
  }

  it('allows a clean prompt', async () => {
    const result = await catoCheck(req('What is the capital of France?'));
    expect(result.allow).toBe(true);
  });

  it('blocks a prompt containing path traversal (../)', async () => {
    const result = await catoCheck(req('Read the file at ../../etc/passwd'));
    expect(result.allow).toBe(false);
    expect(result.reason).toBe('path_traversal_in_prompt');
  });

  it('blocks a prompt containing Windows path traversal (..\\)', async () => {
    const result = await catoCheck(req('Open ..\\..\\windows\\system32'));
    expect(result.allow).toBe(false);
    expect(result.reason).toBe('path_traversal_in_prompt');
  });

  it('blocks an oversized prompt (>100 KB)', async () => {
    const huge = 'a'.repeat(101_000);
    const result = await catoCheck(req(huge));
    expect(result.allow).toBe(false);
    expect(result.reason).toBe('prompt_exceeds_size_limit');
  });

  it('allows a prompt right at the size limit', async () => {
    const edge = 'a'.repeat(99_999);
    const result = await catoCheck(req(edge));
    expect(result.allow).toBe(true);
  });

  it('allows a multi-line prompt without traversal', async () => {
    const result = await catoCheck(
      req('Line one\nLine two with relative path ./config.js\nDone'),
    );
    expect(result.allow).toBe(true);
  });
});

describe('Cato inline hook — fail-closed', () => {
  it('returns allow:false when socket does not exist', async () => {
    cleanSocket(); // ensure no server
    const result = await catoCheck({
      type: 'check_action',
      groupFolder: 'test',
      prompt: 'hello',
    });
    expect(result.allow).toBe(false);
    expect(['cato_unreachable', 'cato_timeout']).toContain(result.reason);
  });
});

describe('Cato inline hook — raw socket protocol', () => {
  beforeEach(async () => {
    cleanSocket();
    startCatoInlineHook();
    await new Promise((r) => setTimeout(r, 50));
  });
  afterEach(() => {
    stopCatoInlineHook();
    cleanSocket();
  });

  it('returns valid JSON response for any well-formed request', async () => {
    const response = await new Promise<string>((resolve) => {
      const client = net.createConnection(CATO_SOCKET_PATH, () => {
        client.write(
          JSON.stringify({
            type: 'check_action',
            groupFolder: 'g',
            prompt: 'ok',
          }),
        );
        client.end();
      });
      let data = '';
      client.on('data', (c) => {
        data += c.toString();
      });
      client.on('end', () => resolve(data));
    });
    const parsed = JSON.parse(response);
    expect(typeof parsed.allow).toBe('boolean');
  });

  it('returns allow:false for malformed JSON', async () => {
    const response = await new Promise<string>((resolve) => {
      const client = net.createConnection(CATO_SOCKET_PATH, () => {
        client.write('not json at all');
        client.end();
      });
      let data = '';
      client.on('data', (c) => {
        data += c.toString();
      });
      client.on('end', () => resolve(data));
    });
    const parsed = JSON.parse(response);
    expect(parsed.allow).toBe(false);
    expect(parsed.reason).toBe('parse_error');
  });
});
