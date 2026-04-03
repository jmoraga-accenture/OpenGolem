/**
 * Token Broker — Unix socket server.
 *
 * Listens at DATA_DIR/broker.sock. Each connection sends one JSON request
 * (newline-terminated), receives one JSON response, then closes.
 *
 * Operations:
 *   ISSUE   { op, container_id, skills, scopes, ttl_seconds, budget }
 *           → { ok: true, token }
 *   VERIFY  { op, token }
 *           → { ok: true, valid, claims? }
 *   REVOKE  { op, token? | container_id? }
 *           → { ok: true, revoked }
 */
import fs from 'fs';
import net from 'net';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';
import { TokenStore } from './token.js';

export const BROKER_SOCKET_PATH = path.join(DATA_DIR, 'broker.sock');

interface IssueRequest {
  op: 'ISSUE';
  container_id: string;
  skills?: string[];
  scopes?: string[];
  ttl_seconds?: number;
  budget?: number;
}
interface VerifyRequest {
  op: 'VERIFY';
  token: string;
}
interface RevokeRequest {
  op: 'REVOKE';
  token?: string;
  container_id?: string;
}
type BrokerRequest = IssueRequest | VerifyRequest | RevokeRequest;

type BrokerResponse =
  | { ok: true; token: string }
  | { ok: true; valid: boolean; claims?: object }
  | { ok: true; revoked: number }
  | { ok: false; error: string };

function handleRequest(store: TokenStore, req: BrokerRequest): BrokerResponse {
  switch (req.op) {
    case 'ISSUE': {
      if (!req.container_id) {
        return { ok: false, error: 'container_id required' };
      }
      const token = store.issue({
        container_id: req.container_id,
        skills: req.skills ?? [],
        scopes: req.scopes ?? [],
        ttl_seconds: req.ttl_seconds ?? 3600,
        budget: req.budget ?? 100,
      });
      return { ok: true, token };
    }

    case 'VERIFY': {
      if (!req.token) return { ok: false, error: 'token required' };
      const result = store.verify(req.token);
      if (result.valid) {
        return { ok: true, valid: true, claims: result.claims };
      }
      return { ok: true, valid: false };
    }

    case 'REVOKE': {
      if (req.token) {
        const ok = store.revokeToken(req.token);
        return { ok: true, revoked: ok ? 1 : 0 };
      }
      if (req.container_id) {
        const n = store.revokeContainer(req.container_id);
        return { ok: true, revoked: n };
      }
      return { ok: false, error: 'token or container_id required' };
    }

    default:
      return { ok: false, error: 'unknown op' };
  }
}

export interface BrokerHandle {
  store: TokenStore;
  socketPath: string;
  close(): void;
}

export function startBroker(socketPath = BROKER_SOCKET_PATH): BrokerHandle {
  const store = new TokenStore();

  // Remove stale socket from previous run
  if (fs.existsSync(socketPath)) {
    fs.unlinkSync(socketPath);
  }
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });

  const server = net.createServer((socket) => {
    let buf = '';

    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl === -1) return;

      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);

      let req: BrokerRequest;
      try {
        req = JSON.parse(line);
      } catch {
        socket.write(
          JSON.stringify({ ok: false, error: 'invalid JSON' }) + '\n',
        );
        socket.end();
        return;
      }

      const response = handleRequest(store, req);
      logger.debug(
        { op: (req as { op: string }).op, ok: response.ok },
        'Broker request',
      );
      socket.write(JSON.stringify(response) + '\n');
      socket.end();
    });

    socket.on('error', (err) => {
      logger.debug({ err }, 'Broker socket connection error');
    });
  });

  server.listen(socketPath, () => {
    fs.chmodSync(socketPath, 0o600);
    logger.info({ socketPath }, 'Token Broker started');
  });

  server.on('error', (err) => {
    logger.error({ err }, 'Token Broker server error');
  });

  return {
    store,
    socketPath,
    close() {
      server.close();
      if (fs.existsSync(socketPath)) {
        fs.unlinkSync(socketPath);
      }
    },
  };
}
