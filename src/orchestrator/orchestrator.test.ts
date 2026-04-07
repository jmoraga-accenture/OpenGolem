// M22 — Orchestrator test suite
// Written against orchestrator-spec.md — no implementation dependency.
// All tests initially failing; Developer implements against these.

/**
 * Orchestrator v2 behavioral test suite.
 *
 * Spec references:
 *   - docs/specs/orchestrator-spec.md  (primary — §2–§4, invariants, AC-1–AC-30)
 *   - docs/specs/token-broker-spec.md  (broker interface)
 *   - docs/specs/cato-spec.md          (Cato inline check interface)
 *   - docs/DECISIONS.md                (13, 20, 23, 24, 25, 26)
 *   - docs/ARCHITECTURE.md             §1.3, §4.1–§4.4, §4.7–§4.8
 *
 * Socket paths (Decision 15):
 *   broker.sock      — Token Broker (Orchestrator connects as client)
 *   escalation.sock  — Escalation relay (Orchestrator listens)
 *   cato.sock        — Cato inline check (Orchestrator connects as client)
 *
 * Mocking strategy:
 *   - Broker socket → vi.mock() / fake net.Server that speaks JSON-RPC 2.0
 *   - Cato socket   → vi.mock() / fake net.Server that speaks newline-delimited JSON
 *   - Escalation socket handled by the Orchestrator itself (we connect to it as the broker would)
 *   - Container runner → vi.mock() returns a fake spawn result
 *   - Audit log → in-memory stub that captures INSERTs
 *   - Filesystem → tmp directory per test; real fs calls where spec requires them
 */

import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// Types (spec-derived; independent of implementation)
// ─────────────────────────────────────────────────────────────────────────────

/** Spec §2.1 — Normalized inbound message delivered by a channel adapter. */
interface InboundMessage {
  groupId: string;
  channelId: string;
  senderId: string;
  messageId: string;
  text: string;
  timestamp: string; // ISO-8601
}

/** Spec §2.2 — issueToken request params. */
interface IssueTokenParams {
  contextId: string;
  skillSet: string[];
  ttl: number;
  callBudget: number;
  dataScopes: string[];
  securityMode: 'golem_guard' | 'supervised' | 'power';
  parentTokenId: string | null;
}

/** Spec §2.2 — issueToken response. */
interface IssueTokenResult {
  token: string;
  tokenId: string;
  expiresAt: string;
}

/** Spec §2.4 — Cato inline check request. */
interface CatoCheckRequest {
  checkId: string;
  action:
    | 'AGENT_PROMPT'
    | 'OUTBOUND_API_CALL'
    | 'FILESYSTEM_WRITE'
    | 'CREDENTIAL_REQUEST'
    | 'MEMORY_WRITE';
  contextId: string;
  tokenId: string;
  payloadHash: string;
  payloadSize: number;
  contentExcerpt: string | null;
}

/** Spec §2.4 — Cato inline check response. */
interface CatoCheckResponse {
  checkId: string;
  allow: boolean;
  code: string | null;
  reason: string | null;
}

/** Spec §2.6 — Audit log entry shape (minimum required fields). */
interface AuditEntry {
  eventType: string;
  groupId?: string;
  taskId?: string;
  tokenId?: string;
  [key: string]: unknown;
}

/** Spec §2.3 — catoEscalate inbound params from broker. */
interface CatoEscalateParams {
  checkId: string;
  action: string;
  contextId: string;
  tokenId: string;
  payloadHash: string;
  payloadSize: number;
  escalationReason: string;
  inspectorCheck: string;
  contentExcerpt: string | null;
}

/** Per-group config (spec §3.9, Decision 25). */
interface GroupConfig {
  securityMode: 'golem_guard' | 'supervised' | 'power';
  assertiveness_level: number;
  flag_display_tag?: string;
  blocked_display_tag?: string;
  skill_set_override?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a temp directory for each test and cleans it up after.
 * Returns absolute paths for sockets and group directories.
 */
function makeTmpEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-orch-test-'));
  const sockDir = path.join(dir, 'data', 'sockets');
  const hanseiDir = path.join(dir, 'data', 'hansei', 'inbox');
  const quarantineDir = path.join(dir, 'data', 'hansei', 'quarantine');
  const groupsDir = path.join(dir, 'groups');
  fs.mkdirSync(sockDir, { recursive: true });
  fs.mkdirSync(hanseiDir, { recursive: true });
  fs.mkdirSync(quarantineDir, { recursive: true });
  fs.mkdirSync(groupsDir, { recursive: true });

  return {
    root: dir,
    sockDir,
    hanseiInboxDir: hanseiDir,
    quarantineDir,
    groupsDir,
    brokerSock: path.join(sockDir, 'broker.sock'),
    escalationSock: path.join(sockDir, 'escalation.sock'),
    catoSock: path.join(sockDir, 'cato.sock'),
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Creates a minimal valid InboundMessage. */
function makeMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    groupId: 'test-group',
    channelId: 'tui',
    senderId: 'user-1',
    messageId: `msg-${Date.now()}`,
    text: 'Hello agent',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

/** Creates a valid group config JSON. */
function makeGroupConfig(overrides: Partial<GroupConfig> = {}): GroupConfig {
  return {
    securityMode: 'golem_guard',
    assertiveness_level: 3,
    ...overrides,
  };
}

/**
 * Starts a minimal fake broker server on the given Unix socket.
 * Returns a control object to inspect calls and set return values.
 */
function startFakeBroker(sockPath: string) {
  const issued: IssueTokenParams[] = [];
  const revoked: string[] = [];
  const registered: unknown[] = [];
  const resolved: Array<{ checkId: string; decision: string }> = [];
  let issueResult:
    | IssueTokenResult
    | { error: { code: number; message: string } } = {
    token: 'tok-abc',
    tokenId: 'tid-001',
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
  };

  const server = net.createServer((socket) => {
    let buf = '';
    socket.on('data', (d) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let req: {
          jsonrpc: string;
          method: string;
          params: unknown;
          id: number;
        };
        try {
          req = JSON.parse(line);
        } catch {
          continue;
        }

        if (req.method === 'issueToken') {
          issued.push(req.params as IssueTokenParams);
          if ('error' in issueResult) {
            socket.write(
              JSON.stringify({
                jsonrpc: '2.0',
                error: (issueResult as { error: unknown }).error,
                id: req.id,
              }) + '\n',
            );
          } else {
            socket.write(
              JSON.stringify({
                jsonrpc: '2.0',
                result: issueResult,
                id: req.id,
              }) + '\n',
            );
          }
        } else if (req.method === 'revokeToken') {
          const p = req.params as { tokenId: string };
          revoked.push(p.tokenId);
          socket.write(
            JSON.stringify({
              jsonrpc: '2.0',
              result: { revoked: true },
              id: req.id,
            }) + '\n',
          );
        } else if (req.method === 'health') {
          socket.write(
            JSON.stringify({
              jsonrpc: '2.0',
              result: { status: 'ok' },
              id: req.id,
            }) + '\n',
          );
        } else if (req.method === 'registerSkillScope') {
          registered.push(req.params);
          socket.write(
            JSON.stringify({
              jsonrpc: '2.0',
              result: { registered: true },
              id: req.id,
            }) + '\n',
          );
        } else if (req.method === 'deregisterSkillScope') {
          socket.write(
            JSON.stringify({
              jsonrpc: '2.0',
              result: { deregistered: true },
              id: req.id,
            }) + '\n',
          );
        } else if (req.method === 'resolveSupervised') {
          const p = req.params as { checkId: string; decision: string };
          resolved.push(p);
          socket.write(
            JSON.stringify({
              jsonrpc: '2.0',
              result: { accepted: true },
              id: req.id,
            }) + '\n',
          );
        }
      }
    });
  });

  server.listen(sockPath);
  return {
    server,
    issued,
    revoked,
    registered,
    resolved,
    setIssueResult(r: typeof issueResult) {
      issueResult = r;
    },
    close: () => new Promise<void>((res) => server.close(() => res())),
  };
}

/**
 * Starts a minimal fake Cato server on the given Unix socket.
 * Protocol: newline-delimited JSON (not JSON-RPC).
 * Returns a control object to inspect received checks and set return values.
 */
function startFakeCato(sockPath: string) {
  const received: CatoCheckRequest[] = [];
  let allowAll = true;
  const blockCode = 'BLOCKED_BY_TEST';

  const server = net.createServer((socket) => {
    let buf = '';
    socket.on('data', (d) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let req: CatoCheckRequest;
        try {
          req = JSON.parse(line);
        } catch {
          continue;
        }
        received.push(req);
        const resp: CatoCheckResponse = allowAll
          ? { checkId: req.checkId, allow: true, code: null, reason: null }
          : {
              checkId: req.checkId,
              allow: false,
              code: blockCode,
              reason: 'Blocked by test',
            };
        socket.write(JSON.stringify(resp) + '\n');
      }
    });
  });

  server.listen(sockPath);
  return {
    server,
    received,
    blockAll() {
      allowAll = false;
    },
    allowAll() {
      allowAll = true;
    },
    close: () => new Promise<void>((res) => server.close(() => res())),
  };
}

/** Captures audit log entries emitted by the Orchestrator (in-memory stub). */
class AuditCapture {
  entries: AuditEntry[] = [];
  append(entry: AuditEntry) {
    this.entries.push(entry);
  }
  ofType(eventType: string) {
    return this.entries.filter((e) => e.eventType === eventType);
  }
  hasType(eventType: string) {
    return this.ofType(eventType).length > 0;
  }
}

/** In-memory stub channel adapter for routing tests. */
class FakeChannel {
  sent: string[] = [];
  sendMessage(_jid: string, text: string) {
    this.sent.push(text);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The Orchestrator under test — imported lazily so mocks apply first.
// The developer must export these from src/orchestrator/index.ts.
// ─────────────────────────────────────────────────────────────────────────────

// NOTE: vi.mock() hoisting means these must be declared at module scope.
// The actual import is deferred inside each test via dynamic import to ensure
// fresh instances and correct mock injection.

vi.mock('../container-runner.js', () => ({
  runContainerAgent: vi.fn().mockResolvedValue({
    status: 'success',
    result: 'done',
    newSessionId: 'sess-001',
  }),
}));

// ─────────────────────────────────────────────────────────────────────────────
// 1. UNIT TESTS
// ─────────────────────────────────────────────────────────────────────────────

describe('Unit — Per-group inbound message queue (INV-1, spec §3.2)', () => {
  let env: ReturnType<typeof makeTmpEnv>;

  beforeEach(() => {
    env = makeTmpEnv();
  });
  afterEach(() => {
    env.cleanup();
  });

  it('dispatches immediately when no task is active for the group', async () => {
    // Given: a group with no active task
    // When: a message arrives
    // Then: dispatch begins synchronously (no queuing delay)
    const { Orchestrator } = await import('./index.js');
    const audit = new AuditCapture();
    const orch = new Orchestrator({ rootDir: env.root, audit });
    const dispatched: string[] = [];
    orch.onDispatch((msg: InboundMessage) => {
      dispatched.push(msg.messageId);
    });

    const msg = makeMessage({ groupId: 'grp-a' });
    orch.deliver(msg);

    // Dispatch should start; check queue depth is 0 (message went straight to active)
    expect(orch.getQueueDepth('grp-a')).toBe(0);
    expect(dispatched).toContain(msg.messageId);
  });

  it('queues second message while first task is active (INV-1)', async () => {
    // Given: group grp-a has an active task in progress
    // When: a second message arrives
    // Then: it enters the queue; no second container is spawned; queue depth = 1
    const { Orchestrator } = await import('./index.js');
    const audit = new AuditCapture();
    const orch = new Orchestrator({ rootDir: env.root, audit });

    // Artificially mark group as active
    orch.markGroupActive('grp-b');

    const msg = makeMessage({ groupId: 'grp-b', messageId: 'msg-2' });
    orch.deliver(msg);

    expect(orch.getQueueDepth('grp-b')).toBe(1);
    // No dispatch should have occurred for the second message
    const spawns = audit.ofType('container_spawn');
    expect(spawns.length).toBe(0);
  });

  it('drains queue after first task completes (spec §3.4 step 8)', async () => {
    // Given: grp-c has one active task and one queued message
    // When: the active task completes
    // Then: queue drains; the second message is dispatched
    const { Orchestrator } = await import('./index.js');
    const audit = new AuditCapture();
    const orch = new Orchestrator({ rootDir: env.root, audit });

    orch.markGroupActive('grp-c');
    const msg2 = makeMessage({ groupId: 'grp-c', messageId: 'msg-queued' });
    orch.deliver(msg2);
    expect(orch.getQueueDepth('grp-c')).toBe(1);

    // Simulate task completion
    orch.markGroupIdle('grp-c');

    // Queue should now drain
    expect(orch.getQueueDepth('grp-c')).toBe(0);
  });

  it('never silently drops a message (INV-10)', async () => {
    // Given: multiple messages arrive for a group
    // When: some overlap with an active task
    // Then: every message is either dispatched or present in the queue
    const { Orchestrator } = await import('./index.js');
    const audit = new AuditCapture();
    const orch = new Orchestrator({ rootDir: env.root, audit });

    const messages = Array.from({ length: 5 }, (_, i) =>
      makeMessage({ groupId: 'grp-d', messageId: `m${i}` }),
    );
    orch.markGroupActive('grp-d');
    messages.forEach((m) => orch.deliver(m));

    const queued = orch.getQueueDepth('grp-d');
    expect(queued).toBe(5); // all queued, none dropped
  });
});

describe('Unit — Security mode loading from group config (spec §3.9, Decision 25)', () => {
  let env: ReturnType<typeof makeTmpEnv>;

  beforeEach(() => {
    env = makeTmpEnv();
  });
  afterEach(() => {
    env.cleanup();
  });

  it('reads securityMode from groups/{name}/config.json', async () => {
    const { loadGroupConfig } = await import('./index.js');

    const groupDir = path.join(env.groupsDir, 'my-group');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(
      path.join(groupDir, 'config.json'),
      JSON.stringify(
        makeGroupConfig({ securityMode: 'supervised', assertiveness_level: 4 }),
      ),
    );

    const cfg = await loadGroupConfig(groupDir);
    expect(cfg.securityMode).toBe('supervised');
    expect(cfg.assertiveness_level).toBe(4);
  });

  it('returns deployment defaults when config.json is absent (Decision 25)', async () => {
    const { loadGroupConfig, DEPLOYMENT_DEFAULTS } = await import('./index.js');

    const groupDir = path.join(env.groupsDir, 'no-config-group');
    fs.mkdirSync(groupDir, { recursive: true });
    // No config.json created

    const cfg = await loadGroupConfig(groupDir);
    expect(cfg.securityMode).toBe(DEPLOYMENT_DEFAULTS.securityMode);
    expect(cfg.assertiveness_level).toBe(
      DEPLOYMENT_DEFAULTS.assertiveness_level,
    );
  });

  it('falls back to defaults on malformed config.json and logs config_parse_error', async () => {
    const { loadGroupConfig, DEPLOYMENT_DEFAULTS } = await import('./index.js');
    const audit = new AuditCapture();

    const groupDir = path.join(env.groupsDir, 'bad-config-group');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(path.join(groupDir, 'config.json'), '{ invalid json :::');

    const cfg = await loadGroupConfig(groupDir, { audit });
    expect(cfg.securityMode).toBe(DEPLOYMENT_DEFAULTS.securityMode);
    expect(audit.hasType('config_parse_error')).toBe(true);
    const entry = audit.ofType('config_parse_error')[0];
    expect(entry.groupId).toBeDefined();
    // File content must not be in the audit entry (INV-7 analogue for config)
    expect(JSON.stringify(entry)).not.toContain('invalid json');
  });

  it('falls back to defaults when required field securityMode is missing', async () => {
    const { loadGroupConfig, DEPLOYMENT_DEFAULTS } = await import('./index.js');
    const audit = new AuditCapture();

    const groupDir = path.join(env.groupsDir, 'missing-field-group');
    fs.mkdirSync(groupDir, { recursive: true });
    // assertiveness_level present but securityMode missing
    fs.writeFileSync(
      path.join(groupDir, 'config.json'),
      JSON.stringify({ assertiveness_level: 2 }),
    );

    const cfg = await loadGroupConfig(groupDir, { audit });
    expect(cfg.securityMode).toBe(DEPLOYMENT_DEFAULTS.securityMode);
    expect(audit.hasType('config_parse_error')).toBe(true);
  });

  it('falls back to defaults when securityMode value is out of range', async () => {
    const { loadGroupConfig, DEPLOYMENT_DEFAULTS } = await import('./index.js');
    const audit = new AuditCapture();

    const groupDir = path.join(env.groupsDir, 'bad-mode-group');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(
      path.join(groupDir, 'config.json'),
      JSON.stringify({
        securityMode: 'ultra_paranoid',
        assertiveness_level: 3,
      }),
    );

    const cfg = await loadGroupConfig(groupDir, { audit });
    expect(cfg.securityMode).toBe(DEPLOYMENT_DEFAULTS.securityMode);
    expect(audit.hasType('config_parse_error')).toBe(true);
  });
});

describe('Unit — issueToken carries correct securityMode (spec §3.3, AC-5)', () => {
  let env: ReturnType<typeof makeTmpEnv>;

  beforeEach(() => {
    env = makeTmpEnv();
  });
  afterEach(() => {
    env.cleanup();
  });

  it('passes securityMode from group config to issueToken params', async () => {
    const { Orchestrator } = await import('./index.js');
    const broker = startFakeBroker(env.brokerSock);
    const cato = startFakeCato(env.catoSock);
    const audit = new AuditCapture();

    const groupDir = path.join(env.groupsDir, 'sup-group');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(
      path.join(groupDir, 'config.json'),
      JSON.stringify(makeGroupConfig({ securityMode: 'supervised' })),
    );

    const orch = new Orchestrator({
      rootDir: env.root,
      audit,
      brokerSocketPath: env.brokerSock,
      catoSocketPath: env.catoSock,
    });

    const msg = makeMessage({ groupId: 'sup-group' });
    await orch.deliver(msg);

    expect(broker.issued.length).toBeGreaterThanOrEqual(1);
    expect(broker.issued[0].securityMode).toBe('supervised');

    await broker.close();
    await cato.close();
  });

  it('passes golem_guard securityMode when config is absent', async () => {
    const { Orchestrator, DEPLOYMENT_DEFAULTS } = await import('./index.js');
    const broker = startFakeBroker(env.brokerSock);
    const cato = startFakeCato(env.catoSock);
    const audit = new AuditCapture();

    const groupDir = path.join(env.groupsDir, 'default-group');
    fs.mkdirSync(groupDir, { recursive: true });
    // No config.json

    const orch = new Orchestrator({
      rootDir: env.root,
      audit,
      brokerSocketPath: env.brokerSock,
      catoSocketPath: env.catoSock,
    });

    const msg = makeMessage({ groupId: 'default-group' });
    await orch.deliver(msg);

    expect(broker.issued[0].securityMode).toBe(
      DEPLOYMENT_DEFAULTS.securityMode,
    );

    await broker.close();
    await cato.close();
  });
});

describe('Unit — revokeToken lifecycle (spec §3.4, §3.5, §3.3, AC-6)', () => {
  let env: ReturnType<typeof makeTmpEnv>;

  beforeEach(() => {
    env = makeTmpEnv();
  });
  afterEach(() => {
    env.cleanup();
  });

  it('revokes token on task completion (spec §3.4 step 5)', async () => {
    const { Orchestrator } = await import('./index.js');
    const broker = startFakeBroker(env.brokerSock);
    const cato = startFakeCato(env.catoSock);
    const audit = new AuditCapture();

    const groupDir = path.join(env.groupsDir, 'revoke-group');
    fs.mkdirSync(groupDir, { recursive: true });

    const orch = new Orchestrator({
      rootDir: env.root,
      audit,
      brokerSocketPath: env.brokerSock,
      catoSocketPath: env.catoSock,
    });
    const msg = makeMessage({ groupId: 'revoke-group' });
    await orch.deliver(msg);

    expect(broker.revoked).toContain('tid-001');
    expect(audit.hasType('token_revoke')).toBe(true);

    await broker.close();
    await cato.close();
  });

  it('revokes token when TTL expires (spec §3.5 step 2, AC-14)', async () => {
    const { Orchestrator } = await import('./index.js');
    const broker = startFakeBroker(env.brokerSock);
    const cato = startFakeCato(env.catoSock);
    const audit = new AuditCapture();

    const groupDir = path.join(env.groupsDir, 'ttl-group');
    fs.mkdirSync(groupDir, { recursive: true });

    // Use a very short TTL override for the test
    const orch = new Orchestrator({
      rootDir: env.root,
      audit,
      brokerSocketPath: env.brokerSock,
      catoSocketPath: env.catoSock,
      defaultTtlMs: 50, // 50 ms TTL — expires almost immediately
    });

    // Hang the container runner so TTL fires
    const { runContainerAgent } = await import('../container-runner.js');
    (runContainerAgent as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () =>
        new Promise((_res) => {
          /* never resolves */
        }),
    );

    const msg = makeMessage({ groupId: 'ttl-group' });
    const deliveryPromise = orch.deliver(msg);
    await new Promise((res) => setTimeout(res, 200)); // wait for TTL to fire

    expect(broker.revoked).toContain('tid-001');
    expect(audit.hasType('container_ttl_expired')).toBe(true);

    await deliveryPromise.catch(() => {
      /* TTL teardown may reject */
    });
    await broker.close();
    await cato.close();
  });

  it('revokes token when Cato blocks the action (spec §3.3 step 3)', async () => {
    const { Orchestrator } = await import('./index.js');
    const broker = startFakeBroker(env.brokerSock);
    const cato = startFakeCato(env.catoSock);
    cato.blockAll();
    const audit = new AuditCapture();

    const groupDir = path.join(env.groupsDir, 'block-revoke-group');
    fs.mkdirSync(groupDir, { recursive: true });

    const orch = new Orchestrator({
      rootDir: env.root,
      audit,
      brokerSocketPath: env.brokerSock,
      catoSocketPath: env.catoSock,
    });
    const msg = makeMessage({ groupId: 'block-revoke-group' });
    await orch.deliver(msg);

    expect(broker.revoked).toContain('tid-001');

    await broker.close();
    await cato.close();
  });
});

describe('Unit — Hansei inbox poll (spec §2.8, Decision 26)', () => {
  let env: ReturnType<typeof makeTmpEnv>;

  beforeEach(() => {
    env = makeTmpEnv();
  });
  afterEach(() => {
    env.cleanup();
  });

  it('ingests a valid report from data/hansei/inbox/ (spec §2.8)', async () => {
    const { Orchestrator } = await import('./index.js');
    const audit = new AuditCapture();

    const orch = new Orchestrator({ rootDir: env.root, audit });

    const reportId = crypto.randomUUID();
    const reportName = `hansei-20260407T120000-${reportId}.json`;
    const report = {
      reportId,
      timestamp: new Date().toISOString(),
      periodCovered: {
        from: '2026-04-07T00:00:00Z',
        to: '2026-04-07T06:00:00Z',
      },
      kpis: {
        security_failures_per_call: 0.01,
        data_leaks_per_call: 0,
        behavioral_change_rate: 0.5,
      },
      anomalyFindings: [],
      recommendationFlags: [],
    };

    fs.writeFileSync(
      path.join(env.hanseiInboxDir, reportName),
      JSON.stringify(report),
    );

    await orch.pollHanseiInbox();

    expect(audit.hasType('hansei_report_ingested')).toBe(true);
    const entry = audit.ofType('hansei_report_ingested')[0];
    expect(entry.reportId).toBe(reportId);
  });

  it('moves malformed report to quarantine and emits hansei_parse_error (Decision 26)', async () => {
    const { Orchestrator } = await import('./index.js');
    const audit = new AuditCapture();

    const orch = new Orchestrator({ rootDir: env.root, audit });

    const badName = `hansei-20260407T130000-${crypto.randomUUID()}.json`;
    fs.writeFileSync(
      path.join(env.hanseiInboxDir, badName),
      '{ not valid json :::',
    );

    await orch.pollHanseiInbox();

    // File must be moved to quarantine
    expect(fs.existsSync(path.join(env.hanseiInboxDir, badName))).toBe(false);
    const quarantined = fs.readdirSync(env.quarantineDir);
    expect(quarantined.length).toBeGreaterThanOrEqual(1);

    // Audit entry must exist
    expect(audit.hasType('hansei_parse_error')).toBe(true);

    // File content must not appear in audit entry
    const entry = audit.ofType('hansei_parse_error')[0];
    expect(JSON.stringify(entry)).not.toContain('not valid json');
  });

  it('increments quarantinedHanseiReports health count after parse error (Decision 26)', async () => {
    const { Orchestrator } = await import('./index.js');
    const orch = new Orchestrator({
      rootDir: env.root,
      audit: new AuditCapture(),
    });

    fs.writeFileSync(
      path.join(env.hanseiInboxDir, 'hansei-bad.json'),
      'completely broken',
    );

    await orch.pollHanseiInbox();

    const health = orch.getHealth();
    expect(health.quarantinedHanseiReports).toBeGreaterThanOrEqual(1);
    expect(health.status).toBe('degraded');
  });

  it('does not re-ingest a report already processed in this session', async () => {
    const { Orchestrator } = await import('./index.js');
    const audit = new AuditCapture();
    const orch = new Orchestrator({ rootDir: env.root, audit });

    const reportName = `hansei-20260407T140000-${crypto.randomUUID()}.json`;
    const report = {
      reportId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      periodCovered: {
        from: '2026-04-07T08:00:00Z',
        to: '2026-04-07T14:00:00Z',
      },
      kpis: {},
      anomalyFindings: [],
      recommendationFlags: [],
    };
    fs.writeFileSync(
      path.join(env.hanseiInboxDir, reportName),
      JSON.stringify(report),
    );

    await orch.pollHanseiInbox();
    const countAfterFirst = audit.ofType('hansei_report_ingested').length;

    await orch.pollHanseiInbox(); // second poll — same file
    const countAfterSecond = audit.ofType('hansei_report_ingested').length;

    expect(countAfterSecond).toBe(countAfterFirst); // not ingested again
  });
});

describe('Unit — Remote-control surface fails closed when bridge unreachable (spec §2.7, Decision 13)', () => {
  let env: ReturnType<typeof makeTmpEnv>;

  beforeEach(() => {
    env = makeTmpEnv();
  });
  afterEach(() => {
    env.cleanup();
  });

  it('returns error and does not create a task record when bridge errors (AC-28, spec §2.7)', async () => {
    const { Orchestrator } = await import('./index.js');
    const audit = new AuditCapture();
    const orch = new Orchestrator({ rootDir: env.root, audit });

    // Simulate bridge invocation with a broken connection
    let errorThrown = false;
    try {
      await orch.handleRemoteControlInvocation({
        groupId: 'remote-group',
        taskDescription: 'Do something',
        bridgeStatus: 'unreachable', // test-only flag to simulate bridge failure
      });
    } catch {
      errorThrown = true;
    }

    expect(errorThrown).toBe(true);
    // No task_start entry must have been created
    expect(audit.hasType('task_start')).toBe(false);
  });

  it('does not queue the task when bridge is unreachable (fail-closed)', async () => {
    const { Orchestrator } = await import('./index.js');
    const orch = new Orchestrator({
      rootDir: env.root,
      audit: new AuditCapture(),
    });

    try {
      await orch.handleRemoteControlInvocation({
        groupId: 'remote-group-2',
        taskDescription: 'Another task',
        bridgeStatus: 'unreachable',
      });
    } catch {
      /* expected */
    }

    expect(orch.getQueueDepth('remote-group-2')).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. CONTRACT TESTS (IPC wire)
// ─────────────────────────────────────────────────────────────────────────────

describe('Contract — Normalized InboundMessage schema (spec §2.1)', () => {
  it('rejects delivery of a message missing groupId', async () => {
    const { Orchestrator } = await import('./index.js');
    const orch = new Orchestrator({
      rootDir: '/tmp',
      audit: new AuditCapture(),
    });

    const bad = {
      channelId: 'tui',
      senderId: 'u',
      messageId: 'm',
      text: 'hi',
      timestamp: new Date().toISOString(),
    };
    // @ts-expect-error — intentionally missing groupId
    await expect(orch.deliver(bad)).rejects.toThrow();
  });

  it('rejects delivery of a message missing senderId', async () => {
    const { Orchestrator } = await import('./index.js');
    const orch = new Orchestrator({
      rootDir: '/tmp',
      audit: new AuditCapture(),
    });

    const bad = {
      groupId: 'g',
      channelId: 'tui',
      messageId: 'm',
      text: 'hi',
      timestamp: new Date().toISOString(),
    };
    // @ts-expect-error — intentionally missing senderId
    await expect(orch.deliver(bad)).rejects.toThrow();
  });

  it('rejects delivery of a message missing content/text', async () => {
    const { Orchestrator } = await import('./index.js');
    const orch = new Orchestrator({
      rootDir: '/tmp',
      audit: new AuditCapture(),
    });

    const bad = {
      groupId: 'g',
      channelId: 'tui',
      senderId: 'u',
      messageId: 'm',
      timestamp: new Date().toISOString(),
    };
    // @ts-expect-error — intentionally missing text
    await expect(orch.deliver(bad)).rejects.toThrow();
  });

  it('rejects delivery of a message missing timestamp', async () => {
    const { Orchestrator } = await import('./index.js');
    const orch = new Orchestrator({
      rootDir: '/tmp',
      audit: new AuditCapture(),
    });

    const bad = {
      groupId: 'g',
      channelId: 'tui',
      senderId: 'u',
      messageId: 'm',
      text: 'hi',
    };
    // @ts-expect-error — intentionally missing timestamp
    await expect(orch.deliver(bad)).rejects.toThrow();
  });

  it('logs message_received with hashed senderId — not raw senderId (spec §2.1)', async () => {
    const { Orchestrator } = await import('./index.js');
    const audit = new AuditCapture();
    const orch = new Orchestrator({ rootDir: '/tmp', audit });
    orch.markGroupActive('g'); // prevent actual dispatch

    const msg = makeMessage({ groupId: 'g', senderId: 'sensitive-user-id' });
    await orch.deliver(msg);

    expect(audit.hasType('message_received')).toBe(true);
    const entry = audit.ofType('message_received')[0];
    // Raw senderId must not appear in the audit entry
    expect(JSON.stringify(entry)).not.toContain('sensitive-user-id');
    // A hash should be present instead
    expect(entry.senderHash).toBeDefined();
    expect(typeof entry.senderHash).toBe('string');
    expect((entry.senderHash as string).length).toBeGreaterThan(0);
  });
});

describe('Contract — Sentinel protocol parsing (spec §2.5)', () => {
  it('extracts JSON payload between sentinel markers correctly', async () => {
    const { parseSentinelOutput } = await import('./index.js');

    const raw = [
      'some noise before',
      '---OPENGOLEM_OUTPUT_START---',
      JSON.stringify({
        status: 'success',
        result: 'hello',
        newSessionId: 'sess-123',
      }),
      '---OPENGOLEM_OUTPUT_END---',
      'some noise after',
    ].join('\n');

    const result = parseSentinelOutput(raw);
    expect(result).not.toBeNull();
    expect(result!.status).toBe('success');
    expect(result!.newSessionId).toBe('sess-123');
  });

  it('returns null and records error when start marker is missing', async () => {
    const { parseSentinelOutput } = await import('./index.js');

    const errors: string[] = [];
    const raw = [
      JSON.stringify({ status: 'success', result: 'oops' }),
      '---OPENGOLEM_OUTPUT_END---',
    ].join('\n');

    const result = parseSentinelOutput(raw, {
      onError: (e: string) => errors.push(e),
    });
    expect(result).toBeNull();
    expect(errors.length).toBeGreaterThan(0);
  });

  it('returns null and records error when JSON between markers is malformed', async () => {
    const { parseSentinelOutput } = await import('./index.js');

    const errors: string[] = [];
    const raw = [
      '---OPENGOLEM_OUTPUT_START---',
      '{ bad json :::',
      '---OPENGOLEM_OUTPUT_END---',
    ].join('\n');

    const result = parseSentinelOutput(raw, {
      onError: (e: string) => errors.push(e),
    });
    expect(result).toBeNull();
    expect(errors.length).toBeGreaterThan(0);
  });

  it('discards all content outside sentinel markers', async () => {
    const { parseSentinelOutput } = await import('./index.js');

    const outside = 'this content is outside and must be ignored';
    const raw = [
      outside,
      '---OPENGOLEM_OUTPUT_START---',
      JSON.stringify({ status: 'success', result: 'real', newSessionId: 's1' }),
      '---OPENGOLEM_OUTPUT_END---',
      outside,
    ].join('\n');

    const result = parseSentinelOutput(raw);
    expect(result).not.toBeNull();
    expect(result!.result).toBe('real');
    // The "outside" string must not appear in the result
    expect(JSON.stringify(result)).not.toContain(outside);
  });
});

describe('Contract — Sentinel parse error: token revoked, no crash (spec §2.5, AC-6)', () => {
  let env: ReturnType<typeof makeTmpEnv>;

  beforeEach(() => {
    env = makeTmpEnv();
  });
  afterEach(() => {
    env.cleanup();
  });

  it('revokes token when start sentinel is missing from container output', async () => {
    const { Orchestrator } = await import('./index.js');
    const broker = startFakeBroker(env.brokerSock);
    const cato = startFakeCato(env.catoSock);
    const audit = new AuditCapture();

    // Simulate container returning an error (runContainerAgent has already parsed output)
    const { runContainerAgent } = await import('../container-runner.js');
    (runContainerAgent as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      status: 'error',
      result: null,
      error: 'missing sentinel markers',
    });

    const groupDir = path.join(env.groupsDir, 'bad-sentinel-group');
    fs.mkdirSync(groupDir, { recursive: true });

    const orch = new Orchestrator({
      rootDir: env.root,
      audit,
      brokerSocketPath: env.brokerSock,
      catoSocketPath: env.catoSock,
    });
    await orch.deliver(makeMessage({ groupId: 'bad-sentinel-group' }));

    // Token must be revoked despite the parse error
    expect(broker.revoked).toContain('tid-001');
    expect(audit.hasType('token_revoke')).toBe(true);

    await broker.close();
    await cato.close();
  });

  it('revokes token when JSON between markers is malformed', async () => {
    const { Orchestrator } = await import('./index.js');
    const broker = startFakeBroker(env.brokerSock);
    const cato = startFakeCato(env.catoSock);
    const audit = new AuditCapture();

    const { runContainerAgent } = await import('../container-runner.js');
    (runContainerAgent as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      status: 'error',
      result: null,
      error: 'malformed JSON in output',
    });

    const groupDir = path.join(env.groupsDir, 'malformed-json-group');
    fs.mkdirSync(groupDir, { recursive: true });

    const orch = new Orchestrator({
      rootDir: env.root,
      audit,
      brokerSocketPath: env.brokerSock,
      catoSocketPath: env.catoSock,
    });
    await orch.deliver(makeMessage({ groupId: 'malformed-json-group' }));

    expect(broker.revoked).toContain('tid-001');

    await broker.close();
    await cato.close();
  });

  it('does not crash when container output has no markers at all', async () => {
    const { Orchestrator } = await import('./index.js');
    const broker = startFakeBroker(env.brokerSock);
    const cato = startFakeCato(env.catoSock);
    const audit = new AuditCapture();

    const { runContainerAgent } = await import('../container-runner.js');
    (runContainerAgent as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      status: 'error',
      result: null,
      error: 'no output',
    });

    const groupDir = path.join(env.groupsDir, 'no-markers-group');
    fs.mkdirSync(groupDir, { recursive: true });

    const orch = new Orchestrator({
      rootDir: env.root,
      audit,
      brokerSocketPath: env.brokerSock,
      catoSocketPath: env.catoSock,
    });

    // Must not throw
    await expect(
      orch.deliver(makeMessage({ groupId: 'no-markers-group' })),
    ).resolves.not.toThrow();

    await broker.close();
    await cato.close();
  });
});

describe('Contract — catoEscalate relay (spec §3.6, Decision 23)', () => {
  let env: ReturnType<typeof makeTmpEnv>;

  beforeEach(() => {
    env = makeTmpEnv();
  });
  afterEach(() => {
    env.cleanup();
  });

  it('forwards catoEscalate to cato.sock after stripping escalationReason and inspectorCheck', async () => {
    const { Orchestrator } = await import('./index.js');
    const broker = startFakeBroker(env.brokerSock);
    const cato = startFakeCato(env.catoSock);
    const audit = new AuditCapture();

    const orch = new Orchestrator({
      rootDir: env.root,
      audit,
      brokerSocketPath: env.brokerSock,
      catoSocketPath: env.catoSock,
      escalationSocketPath: env.escalationSock,
    });
    await orch.start();

    // Connect to escalation socket as broker would
    const checkId = crypto.randomUUID();
    const escalateParams: CatoEscalateParams = {
      checkId,
      action: 'OUTBOUND_API_CALL',
      contextId: 'ctx-1',
      tokenId: 'tid-esc',
      payloadHash: 'abc123',
      payloadSize: 1000,
      escalationReason: 'INSPECTOR_INCONCLUSIVE',
      inspectorCheck: 'PROMPT_INJECTION',
      contentExcerpt: Buffer.from('hello world').toString('base64'),
    };

    const response = await sendJsonRpcToSocket(
      env.escalationSock,
      'catoEscalate',
      escalateParams,
      42,
    );

    // catoEscalate forwarded to Cato
    expect(cato.received.length).toBeGreaterThanOrEqual(1);
    const catoReq = cato.received.find((r) => r.checkId === checkId);
    expect(catoReq).toBeDefined();

    // Broker-only fields must NOT be in the Cato request
    expect(JSON.stringify(catoReq)).not.toContain('escalationReason');
    expect(JSON.stringify(catoReq)).not.toContain('inspectorCheck');

    // contentExcerpt must be passed through unchanged (Decision 23)
    expect(catoReq!.contentExcerpt).toBe(escalateParams.contentExcerpt);

    // checkId must be preserved
    expect(catoReq!.checkId).toBe(checkId);

    // Response returned to broker caller
    expect(response.result).toBeDefined();
    expect(typeof (response.result as { allow?: boolean }).allow).toBe('boolean');

    // Audit entry written
    expect(audit.hasType('cato_check_relayed')).toBe(true);

    await orch.stop();
    await broker.close();
    await cato.close();
  });

  it('returns allow:false to broker when Cato is unreachable during escalation (AC-18)', async () => {
    const { Orchestrator } = await import('./index.js');
    const broker = startFakeBroker(env.brokerSock);
    const audit = new AuditCapture();
    // No Cato server started — socket unreachable

    const orch = new Orchestrator({
      rootDir: env.root,
      audit,
      brokerSocketPath: env.brokerSock,
      catoSocketPath: env.catoSock, // nothing listening
      escalationSocketPath: env.escalationSock,
    });
    await orch.start();

    const checkId = crypto.randomUUID();
    const response = await sendJsonRpcToSocket(
      env.escalationSock,
      'catoEscalate',
      {
        checkId,
        action: 'OUTBOUND_API_CALL',
        contextId: 'ctx-2',
        tokenId: 'tid-esc2',
        payloadHash: 'def456',
        payloadSize: 500,
        escalationReason: 'INSPECTOR_INCONCLUSIVE',
        inspectorCheck: 'SKILL_WHITELIST',
        contentExcerpt: null,
      },
      43,
    );

    expect((response.result as { allow?: boolean }).allow).toBe(false);
    expect(audit.hasType('cato_check_relayed')).toBe(true);
    const entry = audit.ofType('cato_check_relayed')[0];
    expect(entry.outcome).toBe('blocked');

    await orch.stop();
    await broker.close();
  });

  it('writes cato_check_relayed audit entry with checkId, outcome, and code (spec §3.6 step 4)', async () => {
    const { Orchestrator } = await import('./index.js');
    const broker = startFakeBroker(env.brokerSock);
    const cato = startFakeCato(env.catoSock);
    cato.blockAll();
    const audit = new AuditCapture();

    const orch = new Orchestrator({
      rootDir: env.root,
      audit,
      brokerSocketPath: env.brokerSock,
      catoSocketPath: env.catoSock,
      escalationSocketPath: env.escalationSock,
    });
    await orch.start();

    const checkId = crypto.randomUUID();
    await sendJsonRpcToSocket(
      env.escalationSock,
      'catoEscalate',
      {
        checkId,
        action: 'OUTBOUND_API_CALL',
        contextId: 'ctx-3',
        tokenId: 'tid-esc3',
        payloadHash: 'ghi789',
        payloadSize: 200,
        escalationReason: 'INSPECTOR_INCONCLUSIVE',
        inspectorCheck: 'ENDPOINT_SCOPE',
        contentExcerpt: null,
      },
      44,
    );

    expect(audit.hasType('cato_check_relayed')).toBe(true);
    const entry = audit.ofType('cato_check_relayed')[0];
    expect(entry.checkId).toBe(checkId);
    expect(entry.outcome).toBeDefined();
    expect(entry.code).toBeDefined();

    await orch.stop();
    await broker.close();
    await cato.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. INTEGRATION TESTS
// ─────────────────────────────────────────────────────────────────────────────

describe('Integration — Full task lifecycle (spec §3.2–§3.4)', () => {
  let env: ReturnType<typeof makeTmpEnv>;

  beforeEach(() => {
    env = makeTmpEnv();
  });
  afterEach(() => {
    env.cleanup();
  });

  it('completes the full lifecycle: message in → token issued → container spawned → sentinel parsed → token revoked → outbound routed (AC-5, AC-6, AC-13, AC-15)', async () => {
    const { Orchestrator } = await import('./index.js');
    const broker = startFakeBroker(env.brokerSock);
    const cato = startFakeCato(env.catoSock);
    const audit = new AuditCapture();
    const channel = new FakeChannel();

    const { runContainerAgent } = await import('../container-runner.js');
    (runContainerAgent as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      status: 'success',
      result: 'Task complete!',
      newSessionId: 'sess-xyz',
    });

    const groupDir = path.join(env.groupsDir, 'lifecycle-group');
    fs.mkdirSync(groupDir, { recursive: true });

    const orch = new Orchestrator({
      rootDir: env.root,
      audit,
      brokerSocketPath: env.brokerSock,
      catoSocketPath: env.catoSock,
      channel,
    });

    const msg = makeMessage({ groupId: 'lifecycle-group' });
    await orch.deliver(msg);

    // 1. Token issued
    expect(broker.issued.length).toBeGreaterThanOrEqual(1);
    expect(audit.hasType('token_request')).toBe(true);

    // 2. Container spawned
    expect(runContainerAgent).toHaveBeenCalled();
    expect(audit.hasType('container_spawn')).toBe(true);

    // 3. Sentinel parsed — task_complete logged
    expect(audit.hasType('task_complete')).toBe(true);
    const completeEntry = audit.ofType('task_complete')[0];
    expect(completeEntry.newSessionId).toBe('sess-xyz');

    // 4. Token revoked
    expect(broker.revoked).toContain('tid-001');
    expect(audit.hasType('token_revoke')).toBe(true);

    // 5. Result routed to channel
    expect(channel.sent.some((s) => s.includes('Task complete!'))).toBe(true);

    await broker.close();
    await cato.close();
  });

  it('creates messages.db with WAL mode if absent before spawn (Decision 21, AC-25)', async () => {
    const { Orchestrator } = await import('./index.js');
    const broker = startFakeBroker(env.brokerSock);
    const cato = startFakeCato(env.catoSock);

    const groupDir = path.join(env.groupsDir, 'new-db-group');
    fs.mkdirSync(groupDir, { recursive: true });
    // No messages.db

    const orch = new Orchestrator({
      rootDir: env.root,
      audit: new AuditCapture(),
      brokerSocketPath: env.brokerSock,
      catoSocketPath: env.catoSock,
    });

    await orch.deliver(makeMessage({ groupId: 'new-db-group' }));

    const dbPath = path.join(groupDir, 'messages.db');
    expect(fs.existsSync(dbPath)).toBe(true);

    await broker.close();
    await cato.close();
  });

  it('creates empty CLAUDE.md if absent before spawn (Decision 22, AC-26)', async () => {
    const { Orchestrator } = await import('./index.js');
    const broker = startFakeBroker(env.brokerSock);
    const cato = startFakeCato(env.catoSock);

    const groupDir = path.join(env.groupsDir, 'new-claude-group');
    fs.mkdirSync(groupDir, { recursive: true });
    // No CLAUDE.md

    const orch = new Orchestrator({
      rootDir: env.root,
      audit: new AuditCapture(),
      brokerSocketPath: env.brokerSock,
      catoSocketPath: env.catoSock,
    });

    await orch.deliver(makeMessage({ groupId: 'new-claude-group' }));

    const claudePath = path.join(groupDir, 'CLAUDE.md');
    expect(fs.existsSync(claudePath)).toBe(true);

    await broker.close();
    await cato.close();
  });

  it('container_spawn audit entry includes containerId, mountPaths, and tokenId (AC-13)', async () => {
    const { Orchestrator } = await import('./index.js');
    const broker = startFakeBroker(env.brokerSock);
    const cato = startFakeCato(env.catoSock);
    const audit = new AuditCapture();

    const groupDir = path.join(env.groupsDir, 'audit-spawn-group');
    fs.mkdirSync(groupDir, { recursive: true });

    const orch = new Orchestrator({
      rootDir: env.root,
      audit,
      brokerSocketPath: env.brokerSock,
      catoSocketPath: env.catoSock,
    });

    await orch.deliver(makeMessage({ groupId: 'audit-spawn-group' }));

    expect(audit.hasType('container_spawn')).toBe(true);
    const entry = audit.ofType('container_spawn')[0];
    expect(entry.containerId).toBeDefined();
    expect(entry.mountPaths).toBeDefined();
    expect(Array.isArray(entry.mountPaths)).toBe(true);
    expect(entry.tokenId).toBeDefined();

    await broker.close();
    await cato.close();
  });
});

describe('Integration — Supervised mode soft-block and timeout (spec §3.7, Decision 24)', () => {
  let env: ReturnType<typeof makeTmpEnv>;

  beforeEach(() => {
    env = makeTmpEnv();
  });
  afterEach(() => {
    env.cleanup();
  });

  it.skip('routes soft-block signal to channel for user confirmation (Phase 2 — supervised mode)', async () => {
    // Phase 2: The broker returns a soft-block signal.
    // The Orchestrator routes a confirmation prompt to the channel adapter.
    // Verified by checking channel.sent contains a prompt for confirm/cancel.
  });

  it('fires resolveSupervised(cancel) with supervised_timeout audit reason after 60s (Decision 24)', async () => {
    const { Orchestrator } = await import('./index.js');
    const broker = startFakeBroker(env.brokerSock);
    const cato = startFakeCato(env.catoSock);
    const audit = new AuditCapture();
    const channel = new FakeChannel();

    const groupDir = path.join(env.groupsDir, 'supervised-timeout-group');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(
      path.join(groupDir, 'config.json'),
      JSON.stringify(makeGroupConfig({ securityMode: 'supervised' })),
    );

    // Use very short timeout for test purposes
    const orch = new Orchestrator({
      rootDir: env.root,
      audit,
      brokerSocketPath: env.brokerSock,
      catoSocketPath: env.catoSock,
      channel,
      supervisedConfirmTimeoutMs: 50, // 50ms for test speed
    });

    const checkId = crypto.randomUUID();
    // Simulate the orchestrator receiving a soft-block signal and waiting for user
    await orch.startSupervisedWait({
      checkId,
      groupId: 'supervised-timeout-group',
    });

    // Wait for timeout
    await new Promise((res) => setTimeout(res, 200));

    // resolveSupervised must have been called with cancel
    const resolved = broker.resolved.find((r) => r.checkId === checkId);
    expect(resolved).toBeDefined();
    expect(resolved!.decision).toBe('cancel');

    // Audit log must have cato_block with reason supervised_timeout
    expect(audit.hasType('cato_block')).toBe(true);
    const blockEntry = audit
      .ofType('cato_block')
      .find((e) => e.reason === 'supervised_timeout');
    expect(blockEntry).toBeDefined();
    expect(blockEntry!.code).toBeNull();

    await broker.close();
    await cato.close();
  });

  it.skip('sends resolveSupervised(confirm) when user confirms within timeout (Phase 2)', async () => {
    // Phase 2: full confirm/cancel interactive flow.
    // Simulates user responding "confirm" within the 60-second window.
    // Verified by broker.resolved containing decision: "confirm".
  });
});

describe('Integration — Cato block halts task dispatch, token revoked, [BLOCKED] routed (spec §3.3 step 3, INV-3)', () => {
  let env: ReturnType<typeof makeTmpEnv>;

  beforeEach(() => {
    env = makeTmpEnv();
  });
  afterEach(() => {
    env.cleanup();
  });

  it('does not spawn container when Cato blocks AGENT_PROMPT (AC-8)', async () => {
    const { Orchestrator } = await import('./index.js');
    const broker = startFakeBroker(env.brokerSock);
    const cato = startFakeCato(env.catoSock);
    cato.blockAll();
    const audit = new AuditCapture();
    const channel = new FakeChannel();

    const { runContainerAgent } = await import('../container-runner.js');
    (runContainerAgent as ReturnType<typeof vi.fn>).mockClear();

    const groupDir = path.join(env.groupsDir, 'cato-block-group');
    fs.mkdirSync(groupDir, { recursive: true });

    const orch = new Orchestrator({
      rootDir: env.root,
      audit,
      brokerSocketPath: env.brokerSock,
      catoSocketPath: env.catoSock,
      channel,
    });

    await orch.deliver(makeMessage({ groupId: 'cato-block-group' }));

    // Container must NOT be spawned
    expect(runContainerAgent).not.toHaveBeenCalled();

    // Token must be revoked
    expect(broker.revoked).toContain('tid-001');

    // Audit entry for cato_block
    expect(audit.hasType('cato_block')).toBe(true);

    // [BLOCKED] explanation routed to channel
    expect(
      channel.sent.some(
        (s) => s.includes('[BLOCKED]') || s.toLowerCase().includes('block'),
      ),
    ).toBe(true);

    await broker.close();
    await cato.close();
  });

  it('routes [BLOCKED] to channel when Cato socket is unreachable (AC-9)', async () => {
    const { Orchestrator } = await import('./index.js');
    const broker = startFakeBroker(env.brokerSock);
    // No Cato server started
    const audit = new AuditCapture();
    const channel = new FakeChannel();

    const { runContainerAgent } = await import('../container-runner.js');
    (runContainerAgent as ReturnType<typeof vi.fn>).mockClear();

    const groupDir = path.join(env.groupsDir, 'cato-unreachable-group');
    fs.mkdirSync(groupDir, { recursive: true });

    const orch = new Orchestrator({
      rootDir: env.root,
      audit,
      brokerSocketPath: env.brokerSock,
      catoSocketPath: env.catoSock, // nothing listening
      channel,
    });

    await orch.deliver(makeMessage({ groupId: 'cato-unreachable-group' }));

    expect(runContainerAgent).not.toHaveBeenCalled();
    expect(broker.revoked).toContain('tid-001');
    expect(channel.sent.length).toBeGreaterThan(0);

    await broker.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. STUB DETECTION TESTS
// ─────────────────────────────────────────────────────────────────────────────

describe('Stub detection — Cato block actually stops container spawn (INV-3)', () => {
  let env: ReturnType<typeof makeTmpEnv>;

  beforeEach(() => {
    env = makeTmpEnv();
  });
  afterEach(() => {
    env.cleanup();
  });

  it('FAILS if Cato block does not prevent container spawn (runContainerAgent must not be called)', async () => {
    // This test is designed to FAIL if the implementation has a stub that always spawns.
    // It sets Cato to block, then asserts runContainerAgent was never called.
    // A stub implementation that ignores Cato and always spawns will cause this test to fail.
    const { Orchestrator } = await import('./index.js');
    const broker = startFakeBroker(env.brokerSock);
    const cato = startFakeCato(env.catoSock);
    cato.blockAll(); // Cato will block every AGENT_PROMPT check

    const { runContainerAgent } = await import('../container-runner.js');
    const callCount = (runContainerAgent as ReturnType<typeof vi.fn>).mock.calls
      .length;

    const groupDir = path.join(env.groupsDir, 'stub-detect-cato');
    fs.mkdirSync(groupDir, { recursive: true });

    const orch = new Orchestrator({
      rootDir: env.root,
      audit: new AuditCapture(),
      brokerSocketPath: env.brokerSock,
      catoSocketPath: env.catoSock,
    });

    await orch.deliver(makeMessage({ groupId: 'stub-detect-cato' }));

    // Assert: runContainerAgent was NOT called after the Cato block
    const newCallCount = (runContainerAgent as ReturnType<typeof vi.fn>).mock.calls
      .length;
    expect(newCallCount).toBe(callCount); // no new spawns

    await broker.close();
    await cato.close();
  });

  it('FAILS if Cato allow=true path incorrectly blocks container spawn (positive check)', async () => {
    // Ensures the positive path (Cato allows) does actually spawn.
    // A stub that always blocks would fail this test.
    const { Orchestrator } = await import('./index.js');
    const broker = startFakeBroker(env.brokerSock);
    const cato = startFakeCato(env.catoSock);
    cato.allowAll(); // Cato will allow everything

    const { runContainerAgent } = await import('../container-runner.js');
    const callCount = (runContainerAgent as ReturnType<typeof vi.fn>).mock.calls
      .length;

    const groupDir = path.join(env.groupsDir, 'stub-detect-allow');
    fs.mkdirSync(groupDir, { recursive: true });

    const orch = new Orchestrator({
      rootDir: env.root,
      audit: new AuditCapture(),
      brokerSocketPath: env.brokerSock,
      catoSocketPath: env.catoSock,
    });

    await orch.deliver(makeMessage({ groupId: 'stub-detect-allow' }));

    const newCallCount = (runContainerAgent as ReturnType<typeof vi.fn>).mock.calls
      .length;
    expect(newCallCount).toBeGreaterThan(callCount); // at least one spawn

    await broker.close();
    await cato.close();
  });
});

describe('Stub detection — Missing broker socket queues messages, does not dispatch (AC-7, Decision 6)', () => {
  let env: ReturnType<typeof makeTmpEnv>;

  beforeEach(() => {
    env = makeTmpEnv();
  });
  afterEach(() => {
    env.cleanup();
  });

  it('FAILS if implementation spawns a container when broker socket is absent', async () => {
    // This test is designed to FAIL if the implementation dispatches without a broker.
    // A stub that ignores broker unavailability and spawns anyway will cause this test to fail.
    const { Orchestrator } = await import('./index.js');
    // No broker server started — broker.sock does not exist
    const { runContainerAgent } = await import('../container-runner.js');
    const callCount = (runContainerAgent as ReturnType<typeof vi.fn>).mock.calls
      .length;

    const audit = new AuditCapture();
    const channel = new FakeChannel();

    const groupDir = path.join(env.groupsDir, 'no-broker-group');
    fs.mkdirSync(groupDir, { recursive: true });

    const orch = new Orchestrator({
      rootDir: env.root,
      audit,
      brokerSocketPath: env.brokerSock, // nothing listening here
      catoSocketPath: env.catoSock,
      channel,
    });

    await orch.deliver(makeMessage({ groupId: 'no-broker-group' }));

    // Container must NOT have been spawned
    const newCallCount = (runContainerAgent as ReturnType<typeof vi.fn>).mock.calls
      .length;
    expect(newCallCount).toBe(callCount);

    // Message should be queued (queue depth 1) or at least not dispatched
    // The user must be notified about the error
    expect(channel.sent.length).toBeGreaterThan(0);
  });

  it('FAILS if implementation proceeds with task when issueToken returns token_store_full', async () => {
    // A stub that ignores token_store_full and spawns anyway will cause this test to fail.
    const { Orchestrator } = await import('./index.js');
    const broker = startFakeBroker(env.brokerSock);
    broker.setIssueResult({
      error: { code: -32603, message: 'token_store_full' },
    });

    const { runContainerAgent } = await import('../container-runner.js');
    const callCount = (runContainerAgent as ReturnType<typeof vi.fn>).mock.calls
      .length;

    const channel = new FakeChannel();
    const groupDir = path.join(env.groupsDir, 'store-full-group');
    fs.mkdirSync(groupDir, { recursive: true });

    const orch = new Orchestrator({
      rootDir: env.root,
      audit: new AuditCapture(),
      brokerSocketPath: env.brokerSock,
      catoSocketPath: env.catoSock,
      channel,
    });

    await orch.deliver(makeMessage({ groupId: 'store-full-group' }));

    const newCallCount = (runContainerAgent as ReturnType<typeof vi.fn>).mock.calls
      .length;
    expect(newCallCount).toBe(callCount); // no new spawn

    // User notified
    expect(channel.sent.length).toBeGreaterThan(0);

    await broker.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. INVARIANT VERIFICATION TESTS
// ─────────────────────────────────────────────────────────────────────────────

describe('Invariants — contentExcerpt presence matches action type (INV-12, Decision 17)', () => {
  let env: ReturnType<typeof makeTmpEnv>;

  beforeEach(() => {
    env = makeTmpEnv();
  });
  afterEach(() => {
    env.cleanup();
  });

  it('includes non-null contentExcerpt in AGENT_PROMPT Cato check (AC-10)', async () => {
    const { Orchestrator } = await import('./index.js');
    const broker = startFakeBroker(env.brokerSock);
    const cato = startFakeCato(env.catoSock);
    const audit = new AuditCapture();

    const groupDir = path.join(env.groupsDir, 'excerpt-group');
    fs.mkdirSync(groupDir, { recursive: true });

    const orch = new Orchestrator({
      rootDir: env.root,
      audit,
      brokerSocketPath: env.brokerSock,
      catoSocketPath: env.catoSock,
    });

    await orch.deliver(
      makeMessage({ groupId: 'excerpt-group', text: 'some prompt text' }),
    );

    const agentPromptChecks = cato.received.filter(
      (r) => r.action === 'AGENT_PROMPT',
    );
    expect(agentPromptChecks.length).toBeGreaterThanOrEqual(1);
    for (const check of agentPromptChecks) {
      expect(check.contentExcerpt).not.toBeNull();
      expect(typeof check.contentExcerpt).toBe('string');
    }

    await broker.close();
    await cato.close();
  });

  it('includes non-null contentExcerpt in MEMORY_WRITE Cato check (AC-10)', async () => {
    const { Orchestrator } = await import('./index.js');
    const broker = startFakeBroker(env.brokerSock);
    const cato = startFakeCato(env.catoSock);
    const audit = new AuditCapture();

    const groupDir = path.join(env.groupsDir, 'memwrite-group');
    fs.mkdirSync(groupDir, { recursive: true });

    const orch = new Orchestrator({
      rootDir: env.root,
      audit,
      brokerSocketPath: env.brokerSock,
      catoSocketPath: env.catoSock,
    });

    // Directly invoke the memory write gate
    const proposal = 'User prefers concise responses.';
    await orch.applyMemoryWriteProposal({
      groupId: 'memwrite-group',
      taskId: 'task-1',
      tokenId: 'tid-001',
      proposedDelta: proposal,
    });

    const memWriteChecks = cato.received.filter(
      (r) => r.action === 'MEMORY_WRITE',
    );
    expect(memWriteChecks.length).toBeGreaterThanOrEqual(1);
    for (const check of memWriteChecks) {
      expect(check.contentExcerpt).not.toBeNull();
    }

    await broker.close();
    await cato.close();
  });

  it('omits or nulls contentExcerpt for FILESYSTEM_WRITE and CREDENTIAL_REQUEST (AC-10)', async () => {
    const { Orchestrator } = await import('./index.js');
    const broker = startFakeBroker(env.brokerSock);
    const cato = startFakeCato(env.catoSock);

    const orch = new Orchestrator({
      rootDir: env.root,
      audit: new AuditCapture(),
      brokerSocketPath: env.brokerSock,
      catoSocketPath: env.catoSock,
    });

    await orch.performCatoCheck({
      action: 'FILESYSTEM_WRITE',
      contextId: 'ctx-fs',
      tokenId: 'tid-fs',
      payloadHash: 'aabbcc',
      payloadSize: 100,
    });

    await orch.performCatoCheck({
      action: 'CREDENTIAL_REQUEST',
      contextId: 'ctx-cred',
      tokenId: 'tid-cred',
      payloadHash: 'ddeeff',
      payloadSize: 50,
    });

    const fsChecks = cato.received.filter(
      (r) => r.action === 'FILESYSTEM_WRITE',
    );
    const credChecks = cato.received.filter(
      (r) => r.action === 'CREDENTIAL_REQUEST',
    );

    for (const check of [...fsChecks, ...credChecks]) {
      // Must be null or absent (not a non-null string)
      expect(
        check.contentExcerpt === null || check.contentExcerpt === undefined,
      ).toBe(true);
    }

    await broker.close();
    await cato.close();
  });

  it('AC-11: MEMORY_WRITE approved — delta written to CLAUDE.md and memory_write_approved audit event emitted', async () => {
    const { Orchestrator } = await import('./index.js');
    const env = makeTmpEnv();
    const broker = startFakeBroker(env.brokerSock);
    const cato = startFakeCato(env.catoSock); // default: allow:true
    const audit = new AuditCapture();

    const groupDir = path.join(env.groupsDir, 'ac11-group');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(path.join(groupDir, 'CLAUDE.md'), '', 'utf8');

    const orch = new Orchestrator({
      rootDir: env.root,
      audit,
      brokerSocketPath: env.brokerSock,
      catoSocketPath: env.catoSock,
    });

    const delta = 'User prefers bullet points.';
    await orch.applyMemoryWriteProposal({
      groupId: 'ac11-group',
      taskId: 'task-ac11',
      tokenId: 'tid-ac11',
      proposedDelta: delta,
    });

    // Delta must be written to CLAUDE.md
    const written = fs.readFileSync(path.join(groupDir, 'CLAUDE.md'), 'utf8');
    expect(written).toBe(delta);

    // Audit event must use the spec name
    expect(
      audit.entries.some((e) => e.eventType === 'memory_write_approved'),
    ).toBe(true);
    expect(
      audit.entries.some((e) => e.eventType === 'memory_write_allowed'),
    ).toBe(false);

    await broker.close();
    await cato.close();
  });

  it('AC-12: MEMORY_WRITE blocked — CLAUDE.md unchanged and memory_write_blocked audit event emitted', async () => {
    const { Orchestrator } = await import('./index.js');
    const env = makeTmpEnv();
    const broker = startFakeBroker(env.brokerSock);
    const cato = startFakeCato(env.catoSock);
    cato.blockAll(); // Cato blocks all checks
    const audit = new AuditCapture();

    const groupDir = path.join(env.groupsDir, 'ac12-group');
    fs.mkdirSync(groupDir, { recursive: true });
    const originalContent = 'original content';
    fs.writeFileSync(path.join(groupDir, 'CLAUDE.md'), originalContent, 'utf8');

    const orch = new Orchestrator({
      rootDir: env.root,
      audit,
      brokerSocketPath: env.brokerSock,
      catoSocketPath: env.catoSock,
    });

    await orch.applyMemoryWriteProposal({
      groupId: 'ac12-group',
      taskId: 'task-ac12',
      tokenId: 'tid-ac12',
      proposedDelta: 'malicious override',
    });

    // CLAUDE.md must be unchanged
    const content = fs.readFileSync(path.join(groupDir, 'CLAUDE.md'), 'utf8');
    expect(content).toBe(originalContent);

    // Audit event must use the spec name
    expect(
      audit.entries.some((e) => e.eventType === 'memory_write_blocked'),
    ).toBe(true);
    expect(
      audit.entries.some((e) => e.eventType === 'memory_write_allowed'),
    ).toBe(false);

    await broker.close();
    await cato.close();
  });
});

describe('Invariants — No raw credentials in orchestrator memory (INV-7)', () => {
  it('issueToken params contain no API key, OAuth token, or raw credential fields', async () => {
    const { Orchestrator } = await import('./index.js');
    const env = makeTmpEnv();
    const broker = startFakeBroker(env.brokerSock);
    const cato = startFakeCato(env.catoSock);

    const groupDir = path.join(env.groupsDir, 'nocred-group');
    fs.mkdirSync(groupDir, { recursive: true });

    const orch = new Orchestrator({
      rootDir: env.root,
      audit: new AuditCapture(),
      brokerSocketPath: env.brokerSock,
      catoSocketPath: env.catoSock,
    });

    await orch.deliver(makeMessage({ groupId: 'nocred-group' }));

    for (const issued of broker.issued) {
      const serialized = JSON.stringify(issued);
      // Common credential field names must not appear
      expect(serialized).not.toMatch(/api[-_]?key/i);
      expect(serialized).not.toMatch(/oauth[-_]?token/i);
      expect(serialized).not.toMatch(/ANTHROPIC_API_KEY/);
      expect(serialized).not.toMatch(/CLAUDE_CODE_OAUTH_TOKEN/);
      expect(serialized).not.toMatch(/BW_SESSION/);
    }

    await broker.close();
    await cato.close();
    env.cleanup();
  });
});

describe('Invariants — Audit log is append-only (INV-9, AC-21)', () => {
  it('Orchestrator write interface issues only INSERT statements — no UPDATE or DELETE', async () => {
    const { Orchestrator: _Orchestrator, getAuditWriteStatements } =
      await import('./index.js');
    // getAuditWriteStatements must return the list of SQL statements used by the orchestrator.
    // The developer must export this for testability.
    const statements = getAuditWriteStatements();
    for (const stmt of statements) {
      expect(stmt.trim().toUpperCase()).toMatch(/^INSERT/);
      expect(stmt.trim().toUpperCase()).not.toMatch(/^UPDATE/);
      expect(stmt.trim().toUpperCase()).not.toMatch(/^DELETE/);
    }
  });
});

describe('Invariants — Remote-control tasks audited identically to channel tasks (INV-11, AC-27)', () => {
  let env: ReturnType<typeof makeTmpEnv>;

  beforeEach(() => {
    env = makeTmpEnv();
  });
  afterEach(() => {
    env.cleanup();
  });

  it('task_start entry includes sourceChannel: "remote-control" for remote-control tasks (AC-27)', async () => {
    const { Orchestrator } = await import('./index.js');
    const broker = startFakeBroker(env.brokerSock);
    const cato = startFakeCato(env.catoSock);
    const audit = new AuditCapture();

    const groupDir = path.join(env.groupsDir, 'remote-ctrl-audit-group');
    fs.mkdirSync(groupDir, { recursive: true });

    const orch = new Orchestrator({
      rootDir: env.root,
      audit,
      brokerSocketPath: env.brokerSock,
      catoSocketPath: env.catoSock,
    });

    await orch.handleRemoteControlInvocation({
      groupId: 'remote-ctrl-audit-group',
      taskDescription: 'Run a remote task',
      bridgeStatus: 'ok',
    });

    expect(audit.hasType('task_start')).toBe(true);
    const taskStart = audit.ofType('task_start')[0];
    expect(taskStart.sourceChannel).toBe('remote-control');

    await broker.close();
    await cato.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Helper — send a JSON-RPC 2.0 request to a Unix socket and await response
// ─────────────────────────────────────────────────────────────────────────────

function sendJsonRpcToSocket(
  sockPath: string,
  method: string,
  params: unknown,
  id: number,
): Promise<{ result?: Record<string, unknown>; error?: unknown }> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(sockPath);
    let buf = '';
    socket.on('data', (d) => {
      buf += d.toString();
      const nl = buf.indexOf('\n');
      if (nl !== -1) {
        const line = buf.slice(0, nl).trim();
        try {
          resolve(JSON.parse(line));
        } catch (e) {
          reject(e);
        } finally {
          socket.destroy();
        }
      }
    });
    socket.on('error', reject);
    socket.on('connect', () => {
      socket.write(
        JSON.stringify({ jsonrpc: '2.0', method, params, id }) + '\n',
      );
    });
    // Timeout for test safety
    setTimeout(() => {
      socket.destroy();
      reject(new Error('sendJsonRpcToSocket timeout'));
    }, 5000);
  });
}
