import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { startBroker, type BrokerHandle } from './server.js';

// Each test suite gets its own socket in a temp dir
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opengolem-broker-test-'));

function send(socketPath: string, payload: object): Promise<object> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    let buf = '';
    sock.on('connect', () => sock.write(JSON.stringify(payload) + '\n'));
    sock.on('data', (d) => {
      buf += d.toString();
      const nl = buf.indexOf('\n');
      if (nl !== -1) resolve(JSON.parse(buf.slice(0, nl)));
    });
    sock.on('error', reject);
    sock.setTimeout(3000, () => {
      sock.destroy();
      reject(new Error('timeout'));
    });
  });
}

describe('Broker server', () => {
  let broker: BrokerHandle;
  let socketPath: string;

  beforeEach(async () => {
    socketPath = path.join(tmpDir, `broker-${Date.now()}.sock`);
    broker = startBroker(socketPath);
    // Wait for socket to be ready
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  afterEach(() => {
    broker.close();
  });

  it('issues a token', async () => {
    const res = (await send(broker.socketPath, {
      op: 'ISSUE',
      container_id: 'c1',
      skills: ['anthropic.message'],
      scopes: ['context:home'],
      ttl_seconds: 60,
      budget: 50,
    })) as { ok: boolean; token?: string };

    expect(res.ok).toBe(true);
    expect(typeof res.token).toBe('string');
    expect(res.token!.includes('.')).toBe(true);
  });

  it('verifies a valid token', async () => {
    const issueRes = (await send(broker.socketPath, {
      op: 'ISSUE',
      container_id: 'c2',
      skills: [],
      scopes: [],
      ttl_seconds: 60,
      budget: 10,
    })) as { ok: boolean; token: string };

    const verifyRes = (await send(broker.socketPath, {
      op: 'VERIFY',
      token: issueRes.token,
    })) as { ok: boolean; valid: boolean; claims?: { container_id: string } };

    expect(verifyRes.ok).toBe(true);
    expect(verifyRes.valid).toBe(true);
    expect(verifyRes.claims?.container_id).toBe('c2');
  });

  it('verify returns valid:false for garbage token', async () => {
    const res = (await send(broker.socketPath, {
      op: 'VERIFY',
      token: 'not.a.valid.token',
    })) as { ok: boolean; valid: boolean };

    expect(res.ok).toBe(true);
    expect(res.valid).toBe(false);
  });

  it('revokes a token by token value', async () => {
    const { token } = (await send(broker.socketPath, {
      op: 'ISSUE',
      container_id: 'c3',
      skills: [],
      scopes: [],
      ttl_seconds: 60,
      budget: 10,
    })) as { token: string };

    const revokeRes = (await send(broker.socketPath, {
      op: 'REVOKE',
      token,
    })) as { ok: boolean; revoked: number };
    expect(revokeRes.revoked).toBe(1);

    const verifyRes = (await send(broker.socketPath, {
      op: 'VERIFY',
      token,
    })) as { valid: boolean };
    expect(verifyRes.valid).toBe(false);
  });

  it('revokes all tokens for a container', async () => {
    await send(broker.socketPath, {
      op: 'ISSUE',
      container_id: 'c4',
      skills: [],
      scopes: [],
      ttl_seconds: 60,
      budget: 10,
    });
    await send(broker.socketPath, {
      op: 'ISSUE',
      container_id: 'c4',
      skills: [],
      scopes: [],
      ttl_seconds: 60,
      budget: 10,
    });

    const res = (await send(broker.socketPath, {
      op: 'REVOKE',
      container_id: 'c4',
    })) as { ok: boolean; revoked: number };
    expect(res.ok).toBe(true);
    expect(res.revoked).toBe(2);
  });

  it('returns error for missing container_id on ISSUE', async () => {
    const res = (await send(broker.socketPath, { op: 'ISSUE' })) as {
      ok: boolean;
      error: string;
    };
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
  });

  it('returns error for invalid JSON', async () => {
    const res = await new Promise<object>((resolve, reject) => {
      const sock = net.createConnection(broker.socketPath);
      let buf = '';
      sock.on('connect', () => sock.write('not json\n'));
      sock.on('data', (d) => {
        buf += d.toString();
        if (buf.includes('\n')) resolve(JSON.parse(buf.split('\n')[0]));
      });
      sock.on('error', reject);
    });
    expect((res as { ok: boolean }).ok).toBe(false);
  });

  it('returns error for unknown op', async () => {
    const res = (await send(broker.socketPath, { op: 'UNKNOWN' })) as {
      ok: boolean;
      error: string;
    };
    expect(res.ok).toBe(false);
    expect(res.error).toContain('unknown op');
  });

  it('budget exhaustion: issued token carries the budget', async () => {
    const { token } = (await send(broker.socketPath, {
      op: 'ISSUE',
      container_id: 'c5',
      skills: [],
      scopes: [],
      ttl_seconds: 60,
      budget: 0,
    })) as { token: string };

    const res = (await send(broker.socketPath, {
      op: 'VERIFY',
      token,
    })) as { valid: boolean; claims?: { budget: number } };
    expect(res.valid).toBe(true);
    expect(res.claims?.budget).toBe(0);
  });

  it('container-binding: token issued to c6 shows c6 in claims', async () => {
    const { token } = (await send(broker.socketPath, {
      op: 'ISSUE',
      container_id: 'c6',
      skills: ['s1'],
      scopes: ['ctx:a'],
      ttl_seconds: 60,
      budget: 5,
    })) as { token: string };

    const res = (await send(broker.socketPath, {
      op: 'VERIFY',
      token,
    })) as {
      valid: boolean;
      claims?: { container_id: string; skills: string[]; scopes: string[] };
    };
    expect(res.valid).toBe(true);
    expect(res.claims?.container_id).toBe('c6');
    expect(res.claims?.skills).toEqual(['s1']);
    expect(res.claims?.scopes).toEqual(['ctx:a']);
  });
});
