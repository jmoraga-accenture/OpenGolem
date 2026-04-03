import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'http';
import os from 'os';
import path from 'path';

// Use an ephemeral port for tests so we don't collide with a running service
const TEST_PORT = 0; // 0 = OS assigns a free port

vi.mock('./config.js', () => ({
  HEALTH_PORT: 0,
  CATO_SOCKET_PATH: path.join(os.tmpdir(), `cato-health-test-${process.pid}.sock`),
  DATA_DIR: os.tmpdir(),
  DAO_SCORE_DB_PATH: path.join(os.tmpdir(), `dao-health-test-${process.pid}.db`),
}));
vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('./cato/dao-score.js', () => ({
  getLatestDaoScore: vi.fn(() => null),
}));

import { startHealthServer, stopHealthServer, type HealthSnapshot } from './health.js';

function getAssignedPort(srv: http.Server): number {
  const addr = srv.address();
  if (!addr || typeof addr === 'string') throw new Error('No address');
  return addr.port;
}

function httpGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c.toString()));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
  });
}

describe('Health server — lifecycle', () => {
  afterEach(() => stopHealthServer());

  it('starts without throwing', () => {
    expect(() =>
      startHealthServer({ getActiveContainerCount: () => 0 }, TEST_PORT),
    ).not.toThrow();
  });

  it('returns the same server instance on duplicate start', () => {
    const deps = { getActiveContainerCount: () => 0 };
    const s1 = startHealthServer(deps, TEST_PORT);
    const s2 = startHealthServer(deps, TEST_PORT);
    expect(s1).toBe(s2);
  });

  it('stopHealthServer is idempotent', () => {
    startHealthServer({ getActiveContainerCount: () => 0 }, TEST_PORT);
    expect(() => {
      stopHealthServer();
      stopHealthServer();
    }).not.toThrow();
  });
});

describe('Health server — GET /health', () => {
  let port: number;

  beforeEach(async () => {
    const srv = startHealthServer({ getActiveContainerCount: () => 3 }, TEST_PORT);
    await new Promise<void>((resolve) => srv.once('listening', resolve));
    port = getAssignedPort(srv);
  });

  afterEach(() => stopHealthServer());

  it('returns HTTP 200', async () => {
    const { status } = await httpGet(port, '/health');
    expect(status).toBe(200);
  });

  it('returns valid JSON with required fields', async () => {
    const { body } = await httpGet(port, '/health');
    const json = JSON.parse(body) as HealthSnapshot;
    expect(json.status).toBe('ok');
    expect(typeof json.uptime_seconds).toBe('number');
    expect(typeof json.active_containers).toBe('number');
    expect(['present', 'absent']).toContain(json.broker_socket);
    expect(['present', 'absent']).toContain(json.cato_socket);
    expect(Array.isArray(json.recent_blocks)).toBe(true);
  });

  it('reflects active_containers from deps', async () => {
    const { body } = await httpGet(port, '/health');
    const json = JSON.parse(body) as HealthSnapshot;
    expect(json.active_containers).toBe(3);
  });

  it('returns HTTP 404 for unknown path', async () => {
    const { status } = await httpGet(port, '/unknown');
    expect(status).toBe(404);
  });
});
