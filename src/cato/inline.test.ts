import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import net from 'net';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';

vi.mock('../config.js', () => ({
  CATO_SOCKET_PATH: path.join(os.tmpdir(), `cato-test-${process.pid}.sock`),
  DATA_DIR: os.tmpdir(),
}));
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
// Mock audit log so inline tests don't need a real SQLite DB
vi.mock('../shared/audit/index.js', () => ({
  openAuditLog: vi.fn(() => ({
    writeEvent: vi.fn(),
    close: vi.fn(),
  })),
  AuditInitError: class AuditInitError extends Error {},
  AuditWriteError: class AuditWriteError extends Error {},
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

/** Build a well-formed spec-compliant CatoCheckRequest. */
function makeRequest(
  overrides: Partial<CatoCheckRequest> = {},
): CatoCheckRequest {
  return {
    checkId: randomUUID(),
    action: 'AGENT_PROMPT',
    contextId: 'group-test-001',
    tokenId: 'tok-test-001',
    payloadHash: 'a'.repeat(64),
    payloadSize: 1024,
    contentExcerpt: null,
    ...overrides,
  };
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

  it('allows a clean prompt', async () => {
    const result = await catoCheck(
      makeRequest({ action: 'AGENT_PROMPT', payloadSize: 100 }),
    );
    expect(result.allow).toBe(true);
  });

  it('blocks contentExcerpt containing path traversal (../)', async () => {
    // Path traversal is checked in the base64-decoded contentExcerpt
    const excerpt = Buffer.from('Read the file at ../../etc/passwd').toString(
      'base64',
    );
    const result = await catoCheck(makeRequest({ contentExcerpt: excerpt }));
    expect(result.allow).toBe(false);
    expect(result.code).toBe('PATH_TRAVERSAL');
  });

  it('blocks contentExcerpt containing Windows path traversal (..\\)', async () => {
    const excerpt = Buffer.from('Open ..\\..\\windows\\system32').toString(
      'base64',
    );
    const result = await catoCheck(makeRequest({ contentExcerpt: excerpt }));
    expect(result.allow).toBe(false);
    expect(result.code).toBe('PATH_TRAVERSAL');
  });

  it('blocks an oversized payload (payloadSize > 100 KB)', async () => {
    const result = await catoCheck(makeRequest({ payloadSize: 101_000 }));
    expect(result.allow).toBe(false);
    expect(result.code).toBe('OVERSIZED_PAYLOAD');
  });

  it('allows a payload right at the size limit (100 000 bytes)', async () => {
    const result = await catoCheck(makeRequest({ payloadSize: 100_000 }));
    expect(result.allow).toBe(true);
  });

  it('allows a request without contentExcerpt', async () => {
    const result = await catoCheck(
      makeRequest({ action: 'CREDENTIAL_REQUEST', contentExcerpt: null }),
    );
    expect(result.allow).toBe(true);
  });

  it('blocks unknown action values', async () => {
    const result = await catoCheck(makeRequest({ action: 'UNKNOWN_VALUE' }));
    expect(result.allow).toBe(false);
  });

  it('blocks when required field is missing', async () => {
    const req = makeRequest();
    const bad = { ...req } as Partial<CatoCheckRequest>;
    delete bad.action;
    const result = await catoCheck(bad as CatoCheckRequest);
    expect(result.allow).toBe(false);
  });

  it('echoes checkId in response', async () => {
    const checkId = randomUUID();
    const result = await catoCheck(makeRequest({ checkId }));
    expect(result.checkId).toBe(checkId);
  });

  it('response has code: null on allow', async () => {
    const result = await catoCheck(makeRequest({ payloadSize: 100 }));
    expect(result.allow).toBe(true);
    expect(result.code).toBeNull();
    expect(result.reason).toBeNull();
  });
});

describe('Cato inline hook — fail-closed', () => {
  it('returns allow:false when socket does not exist', async () => {
    cleanSocket(); // ensure no server
    const result = await catoCheck(makeRequest());
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
        const req = makeRequest();
        client.write(JSON.stringify(req) + '\n');
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
    expect(typeof parsed.checkId).toBe('string');
  });

  it('does not respond for malformed JSON lines (no response sent per spec §4)', async () => {
    // Non-JSON lines are discarded; the server does not send a response for them.
    // The test sends a non-JSON line followed by a valid request and verifies
    // that the valid request still gets a response (connection is not dropped).
    const checkId = randomUUID();
    const validReq = makeRequest({ checkId });
    const response = await new Promise<string>((resolve) => {
      const client = net.createConnection(CATO_SOCKET_PATH, () => {
        client.write('not json at all\n');
        client.write(JSON.stringify(validReq) + '\n');
        client.end();
      });
      let data = '';
      client.on('data', (c) => {
        data += c.toString();
        // Resolve when we have the valid response
        const line = data.split('\n').find((l) => l.trim().length > 0);
        if (line) {
          try {
            JSON.parse(line);
            client.destroy();
            resolve(data);
          } catch {
            /* wait for more */
          }
        }
      });
      client.on('end', () => resolve(data));
    });
    // We should get a response for the valid request
    const lines = response.split('\n').filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(lines[0]!) as { checkId: string; allow: boolean };
    expect(parsed.checkId).toBe(checkId);
  });
});
