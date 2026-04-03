/**
 * M7 — /health HTTP endpoint.
 *
 * GET /health  → JSON system snapshot (active containers, broker/cato socket
 *                presence, latest dao_score KPIs, recent audit blocks).
 * GET /        → 404
 *
 * Binds to 127.0.0.1 only (not exposed to the network by default).
 * Port: HEALTH_PORT env var (default 3003).
 *
 * Called by `npm run status` (scripts/status.ts) and external monitoring.
 */
import fs from 'fs';
import http from 'http';
import path from 'path';

import Database from 'better-sqlite3';

import { getLatestDaoScore } from './cato/dao-score.js';
import { CATO_SOCKET_PATH, DATA_DIR, HEALTH_PORT } from './config.js';
import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HealthDeps {
  /** Return the number of actively-running agent containers. */
  getActiveContainerCount: () => number;
}

export interface HealthSnapshot {
  status: 'ok';
  uptime_seconds: number;
  active_containers: number;
  broker_socket: 'present' | 'absent';
  cato_socket: 'present' | 'absent';
  dao_score: {
    security_failures_per_call: number;
    data_leaks_per_call: number;
    behavioral_change_rate: number;
  } | null;
  /** Most recent audit blocks (non-pass calls), newest first, up to 10. */
  recent_blocks: Array<{
    ts: string;
    container: string;
    outcome: string;
    block_rule: string | null;
  }>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const BROKER_SOCKET_PATH = path.join(DATA_DIR, 'broker.sock');
const AUDIT_DB_PATH = path.join(DATA_DIR, 'audit.db');

function socketPresence(socketPath: string): 'present' | 'absent' {
  try {
    fs.accessSync(socketPath);
    return 'present';
  } catch {
    return 'absent';
  }
}

type BlockRow = {
  ts: number;
  container: string;
  outcome: string;
  block_rule: string | null;
};

function getRecentBlocks(limit = 10): BlockRow[] {
  if (!fs.existsSync(AUDIT_DB_PATH)) return [];
  try {
    const db = new Database(AUDIT_DB_PATH, { readonly: true });
    return db
      .prepare(
        "SELECT ts, container, outcome, block_rule FROM calls WHERE outcome != 'pass' ORDER BY ts DESC LIMIT ?",
      )
      .all(limit) as BlockRow[];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Snapshot builder
// ---------------------------------------------------------------------------

const serverStart = Date.now();

function buildSnapshot(deps: HealthDeps): HealthSnapshot {
  const daoScore = getLatestDaoScore();
  const blocks = getRecentBlocks(10);

  return {
    status: 'ok',
    uptime_seconds: Math.floor((Date.now() - serverStart) / 1000),
    active_containers: deps.getActiveContainerCount(),
    broker_socket: socketPresence(BROKER_SOCKET_PATH),
    cato_socket: socketPresence(CATO_SOCKET_PATH),
    dao_score: daoScore
      ? {
          security_failures_per_call: daoScore.security_failures_per_call,
          data_leaks_per_call: daoScore.data_leaks_per_call,
          behavioral_change_rate: daoScore.behavioral_change_rate,
        }
      : null,
    recent_blocks: blocks.map((b) => ({
      ts: new Date(b.ts).toISOString(),
      container: b.container,
      outcome: b.outcome,
      block_rule: b.block_rule,
    })),
  };
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let server: http.Server | null = null;

export function startHealthServer(
  deps: HealthDeps,
  port = HEALTH_PORT,
): http.Server {
  if (server) return server;

  server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      try {
        const snapshot = buildSnapshot(deps);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(snapshot, null, 2));
      } catch (err) {
        logger.error({ err }, 'Health server: failed to build snapshot');
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal_error' }));
      }
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
    }
  });

  server.listen(port, '127.0.0.1', () => {
    logger.info({ port }, 'Health server listening');
  });

  server.on('error', (err) => {
    logger.error({ err }, 'Health server error');
  });

  return server;
}

export function stopHealthServer(): void {
  if (server) {
    server.close();
    server = null;
  }
}
