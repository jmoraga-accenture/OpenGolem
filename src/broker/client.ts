/**
 * Token Broker — in-process client helper.
 *
 * Used by the orchestrator and credential proxy (same process) to talk to
 * the broker without going through the Unix socket. For external callers
 * (future tooling, monitoring) the socket is the interface.
 */
import net from 'net';

import { BROKER_SOCKET_PATH } from './server.js';
import type { TokenClaims } from './token.js';

type SocketResponse =
  | { ok: true; token: string }
  | { ok: true; valid: boolean; claims?: TokenClaims }
  | { ok: true; revoked: number }
  | { ok: false; error: string };

function request(payload: object): Promise<SocketResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(BROKER_SOCKET_PATH);
    let buf = '';
    let settled = false;

    const detach = () => {
      socket.setTimeout(0);
      socket.off('connect', onConnect);
      socket.off('data', onData);
      socket.off('error', onError);
    };

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      detach();
      socket.destroy();
      fn();
    };

    function onConnect() {
      socket.write(JSON.stringify(payload) + '\n');
    }

    function onData(chunk: Buffer | string) {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      try {
        settle(() => resolve(JSON.parse(buf.slice(0, nl))));
      } catch {
        settle(() => reject(new Error('Broker returned invalid JSON')));
      }
    }

    function onError(err: Error) {
      settle(() => reject(err));
    }

    socket.on('connect', onConnect);
    socket.on('data', onData);
    socket.on('error', onError);
    socket.setTimeout(5000, () => {
      settle(() => reject(new Error('Broker request timed out')));
    });
  });
}

export interface IssueOptions {
  containerId: string;
  skills?: string[];
  scopes?: string[];
  ttlSeconds?: number;
  budget?: number;
}

export async function issueToken(opts: IssueOptions): Promise<string> {
  const res = await request({
    op: 'ISSUE',
    container_id: opts.containerId,
    skills: opts.skills ?? [],
    scopes: opts.scopes ?? [],
    ttl_seconds: opts.ttlSeconds ?? 3600,
    budget: opts.budget ?? 100,
  });
  if (!res.ok || !('token' in res)) {
    throw new Error(`Broker ISSUE failed: ${(res as { error: string }).error}`);
  }
  return res.token;
}

export async function verifyToken(
  token: string,
): Promise<
  { valid: true; claims: TokenClaims } | { valid: false; reason?: string }
> {
  const res = await request({ op: 'VERIFY', token });
  if (!res.ok)
    throw new Error(
      `Broker VERIFY failed: ${(res as { error: string }).error}`,
    );
  const r = res as { ok: true; valid: boolean; claims?: TokenClaims };
  if (r.valid && r.claims) return { valid: true, claims: r.claims };
  return { valid: false };
}

export async function revokeToken(token: string): Promise<number> {
  const res = await request({ op: 'REVOKE', token });
  if (!res.ok)
    throw new Error(
      `Broker REVOKE failed: ${(res as { error: string }).error}`,
    );
  return (res as { ok: true; revoked: number }).revoked;
}

export async function revokeContainer(containerId: string): Promise<number> {
  const res = await request({ op: 'REVOKE', container_id: containerId });
  if (!res.ok)
    throw new Error(
      `Broker REVOKE failed: ${(res as { error: string }).error}`,
    );
  return (res as { ok: true; revoked: number }).revoked;
}