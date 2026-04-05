/**
 * Skill Schema and Lifecycle — Test Suite
 *
 * Source of truth: docs/specs/skill-schema-spec.md
 * Component under test: src/skills/skill-schema.ts (to be implemented)
 *
 * Test tiers:
 *   Unit        — validation logic in isolation; broker and fs stubbed
 *   Contract    — JSON-RPC wire format for registerSkillScope / deregisterSkillScope
 *   Integration — full apply/remove lifecycle with real stub broker + real temp fs
 *   Stub detect — one test per tier that verifies a known failure causes test failure
 *
 * Every test is written to fail if no implementation exists.
 */

import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module under test
// The implementation does not exist yet; every import will produce a type
// error until skill-schema.ts is written. The test runner will report each
// failing test individually once the module is present.
// ---------------------------------------------------------------------------
import {
  applySkill,
  removeSkill,
  listInstalledSkills,
  type SkillApplyResult,
  type SkillRemoveResult,
  type InstalledSkill,
} from './skill-schema.js';

// ---------------------------------------------------------------------------
// Shared logger mock (project convention)
// ---------------------------------------------------------------------------
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Write a YAML .intent.md to a temp directory and return the directory path. */
function makeSkillDir(yaml: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-skill-test-'));
  fs.writeFileSync(path.join(dir, '.intent.md'), `---\n${yaml}\n---\n`);
  return dir;
}

/** A minimal valid .intent.md YAML (all required fields, no optional blocks). */
const MINIMAL_VALID_YAML = `\
skill: test-skill
version: 1.0.0
type: feature
description: A minimal test skill
providers:
  compatible:
    - anthropic
apply_permission: admin
`;

/** The Telegram example from AC-11 (exact text from the spec). */
const TELEGRAM_YAML = `\
skill: telegram
version: 1.0.0
type: feature
description: Telegram channel adapter — delivers and receives messages via the Telegram Bot API

token_scopes:
  skills:
    - telegram

filesystem:
  host_reads: []
  host_writes: []
  container_mounts: []

network:
  endpoints:
    - pattern: "https://api.telegram.org/*"
      protocol: https
      direction: outbound

mcp: {}

providers:
  compatible:
    - anthropic
    - openrouter
    - any

apply_permission: admin
`;

// ---------------------------------------------------------------------------
// Broker socket stub helpers
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: string;
  method: string;
  params: unknown;
  id: number | string;
}

interface JsonRpcResponse {
  jsonrpc: string;
  result?: unknown;
  error?: unknown;
  id: number | string;
}

/**
 * Start a minimal Unix-socket server that records JSON-RPC requests and
 * responds with success. Returns the socket path and a list of received
 * requests, plus a close() function.
 */
function startBrokerStub(socketPath: string): {
  received: JsonRpcRequest[];
  close: () => void;
} {
  const received: JsonRpcRequest[] = [];
  const server = net.createServer((conn) => {
    let buf = '';
    conn.on('data', (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf('\n');
      if (nl !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          const req = JSON.parse(line) as JsonRpcRequest;
          received.push(req);
          let result: JsonRpcResponse['result'];
          if (req.method === 'registerSkillScope') {
            result = { registered: true };
          } else if (req.method === 'deregisterSkillScope') {
            result = { deregistered: true };
          } else {
            const errResp: JsonRpcResponse = {
              jsonrpc: '2.0',
              error: { code: -32601, message: 'Method not found' },
              id: req.id,
            };
            conn.write(JSON.stringify(errResp) + '\n');
            return;
          }
          const resp: JsonRpcResponse = {
            jsonrpc: '2.0',
            result,
            id: req.id,
          };
          conn.write(JSON.stringify(resp) + '\n');
        } catch {
          /* malformed — ignore */
        }
      }
    });
  });
  server.listen(socketPath);
  return {
    received,
    close: () => server.close(),
  };
}

/**
 * Start a broker stub that always responds with a JSON-RPC error (simulates
 * broker unavailability / failure).
 */
function startErrorBrokerStub(socketPath: string): { close: () => void } {
  const server = net.createServer((conn) => {
    let buf = '';
    conn.on('data', (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf('\n');
      if (nl !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          const req = JSON.parse(line) as JsonRpcRequest;
          const errResp: JsonRpcResponse = {
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Broker unavailable' },
            id: req.id,
          };
          conn.write(JSON.stringify(errResp) + '\n');
        } catch {
          /* malformed */
        }
      }
    });
  });
  server.listen(socketPath);
  return { close: () => server.close() };
}

// ---------------------------------------------------------------------------
// Convenience: wait briefly for async socket I/O
// ---------------------------------------------------------------------------
const tick = (ms = 30) => new Promise<void>((r) => setTimeout(r, ms));

// ===========================================================================
// UNIT TESTS
// Broker and filesystem are stubbed via vi.mock / vi.spyOn.
// Each test verifies isolation-level behaviour.
// ===========================================================================

describe('Unit — AC-1: Valid .intent.md accepted and skill registered', () => {
  it('AC-1: applySkill returns success with declared id and version', async () => {
    const dir = makeSkillDir(MINIMAL_VALID_YAML);
    const result: SkillApplyResult = await applySkill(dir, {
      brokerSocketPath: null, // null → unit mode: skip real broker I/O
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skillId).toBe('test-skill');
    expect(result.version).toBe('1.0.0');
    fs.rmSync(dir, { recursive: true });
  });

  it('AC-1: registered skill appears in listInstalledSkills', async () => {
    const dir = makeSkillDir(MINIMAL_VALID_YAML);
    await applySkill(dir, { brokerSocketPath: null });
    const list: InstalledSkill[] = await listInstalledSkills();
    const found = list.find((s) => s.skillId === 'test-skill');
    expect(found).toBeDefined();
    expect(found?.version).toBe('1.0.0');
    expect(found?.type).toBe('feature');
    // cleanup
    await removeSkill('test-skill', { brokerSocketPath: null });
    fs.rmSync(dir, { recursive: true });
  });
});

describe('Unit — AC-2: Invalid .intent.md rejected with field-level error', () => {
  it('AC-2: missing apply_permission returns error naming the field', async () => {
    // Remove apply_permission from the YAML
    const yaml = MINIMAL_VALID_YAML.replace(/^apply_permission:.*\n/m, '');
    const dir = makeSkillDir(yaml);
    const result: SkillApplyResult = await applySkill(dir, {
      brokerSocketPath: null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe('apply_permission');
    expect(result.reason).toBeTruthy();
    fs.rmSync(dir, { recursive: true });
  });

  it('AC-2: rejected skill does not appear in listInstalledSkills', async () => {
    const yaml = MINIMAL_VALID_YAML.replace(/^apply_permission:.*\n/m, '');
    const dir = makeSkillDir(yaml);
    await applySkill(dir, { brokerSocketPath: null });
    const list = await listInstalledSkills();
    expect(list.find((s) => s.skillId === 'test-skill')).toBeUndefined();
    fs.rmSync(dir, { recursive: true });
  });
});

// ---------------------------------------------------------------------------
// AC-3: All seven validation rules individually enforced
// ---------------------------------------------------------------------------

describe('Unit — AC-3: Individual validation rules', () => {
  // AC-3a: skill ID collision
  it('AC-3a: skill ID collision rejected; error identifies collision', async () => {
    // Install the skill once
    const dir1 = makeSkillDir(MINIMAL_VALID_YAML);
    await applySkill(dir1, { brokerSocketPath: null });

    // Attempt to install a second skill with the same ID
    const dir2 = makeSkillDir(MINIMAL_VALID_YAML);
    const result = await applySkill(dir2, { brokerSocketPath: null });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe('skill');
    expect(result.reason).toMatch(/collision|already installed/i);

    // cleanup
    await removeSkill('test-skill', { brokerSocketPath: null });
    fs.rmSync(dir1, { recursive: true });
    fs.rmSync(dir2, { recursive: true });
  });

  // AC-3b: token_scopes.skills entry must be syntactically valid kebab-case
  it('AC-3b: invalid token_scopes.skills entry (not kebab-case) is rejected', async () => {
    const yaml = `\
skill: scope-test-skill
version: 1.0.0
type: utility
description: Scope test
token_scopes:
  skills:
    - INVALID SCOPE ID WITH SPACES
providers:
  compatible:
    - anthropic
apply_permission: admin
`;
    const dir = makeSkillDir(yaml);
    const result = await applySkill(dir, { brokerSocketPath: null });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toMatch(/token_scopes/);
    fs.rmSync(dir, { recursive: true });
  });

  // AC-3c: container_mounts[].host_path must exist on the host
  it('AC-3c: non-existent host_path rejected; error identifies path', async () => {
    const yaml = `\
skill: mount-test-skill
version: 1.0.0
type: feature
description: Mount test
filesystem:
  container_mounts:
    - host_path: /this/path/does/not/exist/og-test-xyz
      container_path: /workspace/data
      access: read
providers:
  compatible:
    - anthropic
apply_permission: admin
`;
    const dir = makeSkillDir(yaml);
    const result = await applySkill(dir, { brokerSocketPath: null });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe('filesystem.container_mounts[0].host_path');
    expect(result.reason).toMatch(/does not exist/i);
    fs.rmSync(dir, { recursive: true });
  });

  // AC-3d: container_mounts[].host_path must be within permitted mount roots
  it('AC-3d: host_path outside permitted mount roots rejected', async () => {
    // /etc is universally outside permitted mount roots for OpenGolem
    const yaml = `\
skill: mount-outside-skill
version: 1.0.0
type: feature
description: Outside root test
filesystem:
  container_mounts:
    - host_path: /etc/passwd
      container_path: /workspace/passwd
      access: read
providers:
  compatible:
    - anthropic
apply_permission: admin
`;
    const dir = makeSkillDir(yaml);
    const result = await applySkill(dir, { brokerSocketPath: null });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe('filesystem.container_mounts[0].host_path');
    expect(result.reason).toMatch(/permitted mount roots|outside/i);
    fs.rmSync(dir, { recursive: true });
  });

  // AC-3e: network.endpoints[].pattern must be a valid, non-empty URL pattern
  it('AC-3e: empty network endpoint pattern rejected', async () => {
    const yaml = `\
skill: net-test-skill
version: 1.0.0
type: feature
description: Network test
network:
  endpoints:
    - pattern: ""
      protocol: https
      direction: outbound
providers:
  compatible:
    - anthropic
apply_permission: admin
`;
    const dir = makeSkillDir(yaml);
    const result = await applySkill(dir, { brokerSocketPath: null });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toMatch(/network\.endpoints\[0\]\.pattern/);
    fs.rmSync(dir, { recursive: true });
  });

  // AC-3f: mcp.servers entry must include min_permission_tier
  it('AC-3f: mcp.servers entry missing min_permission_tier rejected', async () => {
    const yaml = `\
skill: mcp-test-skill
version: 1.0.0
type: feature
description: MCP test
mcp:
  servers:
    - id: my-server
      url: https://mcp.example.com
      scopes:
        - read
providers:
  compatible:
    - anthropic
apply_permission: admin
`;
    const dir = makeSkillDir(yaml);
    const result = await applySkill(dir, { brokerSocketPath: null });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toMatch(/mcp\.servers\[0\]\.min_permission_tier/);
    fs.rmSync(dir, { recursive: true });
  });

  // AC-3g: providers.compatible must be non-empty
  it('AC-3g: empty providers.compatible rejected', async () => {
    const yaml = `\
skill: provider-test-skill
version: 1.0.0
type: feature
description: Provider test
providers:
  compatible: []
apply_permission: admin
`;
    const dir = makeSkillDir(yaml);
    const result = await applySkill(dir, { brokerSocketPath: null });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe('providers.compatible');
    expect(result.reason).toMatch(/empty|non-empty|must not be empty/i);
    fs.rmSync(dir, { recursive: true });
  });
});

// ---------------------------------------------------------------------------
// AC-8: Skill ID collision (unit perspective)
// ---------------------------------------------------------------------------

describe('Unit — AC-8: Skill ID collision rejected', () => {
  it('AC-8: second apply with same ID leaves installed set unchanged', async () => {
    const dir1 = makeSkillDir(`\
skill: collision-skill
version: 1.0.0
type: feature
description: First install
providers:
  compatible:
    - anthropic
apply_permission: admin
`);
    const dir2 = makeSkillDir(`\
skill: collision-skill
version: 2.0.0
type: feature
description: Second install — should be rejected
providers:
  compatible:
    - anthropic
apply_permission: admin
`);

    await applySkill(dir1, { brokerSocketPath: null });
    const result = await applySkill(dir2, { brokerSocketPath: null });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/collision|already installed/i);

    // The installed set still reflects the first version
    const list = await listInstalledSkills();
    const found = list.find((s) => s.skillId === 'collision-skill');
    expect(found?.version).toBe('1.0.0');

    await removeSkill('collision-skill', { brokerSocketPath: null });
    fs.rmSync(dir1, { recursive: true });
    fs.rmSync(dir2, { recursive: true });
  });
});

// ---------------------------------------------------------------------------
// AC-9: No partial application on any validation failure (unit)
// ---------------------------------------------------------------------------

describe('Unit — AC-9: No partial application on failure', () => {
  it('AC-9: no token scopes, endpoints, or MCP servers registered on failure', async () => {
    // A YAML that fails on providers.compatible being empty, but declares
    // network endpoints, token scopes, and MCP servers — none should apply.
    const yaml = `\
skill: partial-fail-skill
version: 1.0.0
type: feature
description: Partial failure test
token_scopes:
  skills:
    - partial-fail-skill
network:
  endpoints:
    - pattern: "https://api.example.com/*"
      protocol: https
      direction: outbound
mcp:
  servers:
    - id: partial-server
      url: https://mcp.example.com
      scopes:
        - read
      min_permission_tier: admin
providers:
  compatible: []
apply_permission: admin
`;
    const dir = makeSkillDir(yaml);
    const result = await applySkill(dir, { brokerSocketPath: null });
    expect(result.ok).toBe(false);

    // The skill must not be in the registry
    const list = await listInstalledSkills();
    expect(list.find((s) => s.skillId === 'partial-fail-skill')).toBeUndefined();

    // The token scopes from this skill must not appear in any installed skill
    const scopes = list.flatMap((s) => s.tokenScopes ?? []);
    expect(scopes).not.toContain('partial-fail-skill');

    // The endpoint pattern must not appear in any installed skill's endpoints
    const endpoints = list.flatMap((s) => s.networkEndpoints ?? []);
    expect(endpoints.map((e) => e.pattern)).not.toContain(
      'https://api.example.com/*',
    );

    fs.rmSync(dir, { recursive: true });
  });
});

// ---------------------------------------------------------------------------
// AC-12: Operational skills (no .intent.md) rejected
// ---------------------------------------------------------------------------

describe('Unit — AC-12: Operational skills are not processed', () => {
  it('AC-12: directory with no .intent.md returns correct error message', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-skill-op-test-'));
    // Write a SKILL.md but no .intent.md
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      '# Operational Skill\nThis is instruction-only.\n',
    );
    const result = await applySkill(dir, { brokerSocketPath: null });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/no \.intent\.md found|skill not applied/i);

    // No state changes
    const list = await listInstalledSkills();
    expect(list.length).toBe(0);
    fs.rmSync(dir, { recursive: true });
  });
});

// ---------------------------------------------------------------------------
// Unit — Stub detection test
// Verifies the unit test harness catches a known failure.
// ---------------------------------------------------------------------------

describe('Unit — Stub detection', () => {
  it('stub detect: applySkill with invalid YAML fails (harness works)', async () => {
    const yaml = MINIMAL_VALID_YAML.replace(/^apply_permission:.*\n/m, '');
    const dir = makeSkillDir(yaml);
    const result = await applySkill(dir, { brokerSocketPath: null });
    // If a no-op stub returned ok:true, this test would fail — proving the
    // harness catches implementations that blindly return success.
    expect(result.ok).toBe(false);
    fs.rmSync(dir, { recursive: true });
  });
});

// ===========================================================================
// CONTRACT TESTS
// Verify the exact JSON-RPC wire format for registerSkillScope and
// deregisterSkillScope (Decision 15, Decision 19).
// ===========================================================================

describe('Contract — broker notification wire format', () => {
  let socketPath: string;
  let stub: ReturnType<typeof startBrokerStub>;

  beforeEach(async () => {
    socketPath = path.join(
      os.tmpdir(),
      `og-broker-contract-${Date.now()}.sock`,
    );
    stub = startBrokerStub(socketPath);
    await tick(40); // let the server bind
  });

  afterEach(() => {
    stub.close();
    try {
      fs.unlinkSync(socketPath);
    } catch {
      /* already gone */
    }
  });

  it('Contract AC-4: registerSkillScope uses jsonrpc 2.0 method name', async () => {
    const dir = makeSkillDir(MINIMAL_VALID_YAML);
    await applySkill(dir, { brokerSocketPath: socketPath });
    await tick();

    expect(stub.received.length).toBeGreaterThanOrEqual(1);
    const req = stub.received.find((r) => r.method === 'registerSkillScope');
    expect(req).toBeDefined();
    expect(req?.jsonrpc).toBe('2.0');
    fs.rmSync(dir, { recursive: true });
  });

  it('Contract AC-4: registerSkillScope params include skillId', async () => {
    const dir = makeSkillDir(MINIMAL_VALID_YAML);
    await applySkill(dir, { brokerSocketPath: socketPath });
    await tick();

    const req = stub.received.find((r) => r.method === 'registerSkillScope');
    expect(req).toBeDefined();
    const params = req?.params as Record<string, unknown>;
    expect(params.skillId).toBe('test-skill');
    fs.rmSync(dir, { recursive: true });
  });

  it('Contract AC-4: registerSkillScope params include tokenScopes array', async () => {
    const yaml = `\
skill: scoped-skill
version: 1.0.0
type: feature
description: Has token scopes
token_scopes:
  skills:
    - scoped-skill
providers:
  compatible:
    - anthropic
apply_permission: admin
`;
    const dir = makeSkillDir(yaml);
    await applySkill(dir, { brokerSocketPath: socketPath });
    await tick();

    const req = stub.received.find((r) => r.method === 'registerSkillScope');
    expect(req).toBeDefined();
    const params = req?.params as { tokenScopes: string[] };
    expect(Array.isArray(params.tokenScopes)).toBe(true);
    expect(params.tokenScopes).toContain('scoped-skill');

    await removeSkill('scoped-skill', { brokerSocketPath: socketPath });
    fs.rmSync(dir, { recursive: true });
  });

  it('Contract AC-4: registerSkillScope params include networkEndpoints array', async () => {
    const yaml = `\
skill: net-skill
version: 1.0.0
type: feature
description: Has network endpoints
network:
  endpoints:
    - pattern: "https://api.example.com/*"
      protocol: https
      direction: outbound
providers:
  compatible:
    - anthropic
apply_permission: admin
`;
    const dir = makeSkillDir(yaml);
    await applySkill(dir, { brokerSocketPath: socketPath });
    await tick();

    const req = stub.received.find((r) => r.method === 'registerSkillScope');
    expect(req).toBeDefined();
    const params = req?.params as {
      networkEndpoints: { pattern: string; protocol: string; direction: string }[];
    };
    expect(Array.isArray(params.networkEndpoints)).toBe(true);
    expect(params.networkEndpoints[0].pattern).toBe('https://api.example.com/*');
    expect(params.networkEndpoints[0].protocol).toBe('https');
    expect(params.networkEndpoints[0].direction).toBe('outbound');

    await removeSkill('net-skill', { brokerSocketPath: socketPath });
    fs.rmSync(dir, { recursive: true });
  });

  it('Contract AC-6: deregisterSkillScope uses jsonrpc 2.0 method name', async () => {
    const dir = makeSkillDir(MINIMAL_VALID_YAML);
    await applySkill(dir, { brokerSocketPath: socketPath });
    stub.received.length = 0; // clear registration call

    await removeSkill('test-skill', { brokerSocketPath: socketPath });
    await tick();

    expect(stub.received.length).toBeGreaterThanOrEqual(1);
    const req = stub.received.find((r) => r.method === 'deregisterSkillScope');
    expect(req).toBeDefined();
    expect(req?.jsonrpc).toBe('2.0');
    fs.rmSync(dir, { recursive: true });
  });

  it('Contract AC-6: deregisterSkillScope params include skillId', async () => {
    const dir = makeSkillDir(MINIMAL_VALID_YAML);
    await applySkill(dir, { brokerSocketPath: socketPath });
    stub.received.length = 0;

    await removeSkill('test-skill', { brokerSocketPath: socketPath });
    await tick();

    const req = stub.received.find((r) => r.method === 'deregisterSkillScope');
    expect(req).toBeDefined();
    const params = req?.params as { skillId: string };
    expect(params.skillId).toBe('test-skill');
    fs.rmSync(dir, { recursive: true });
  });

  it('Contract: registerSkillScope and deregisterSkillScope carry a numeric id field', async () => {
    const dir = makeSkillDir(MINIMAL_VALID_YAML);
    await applySkill(dir, { brokerSocketPath: socketPath });
    await tick();

    const regReq = stub.received.find((r) => r.method === 'registerSkillScope');
    expect(typeof regReq?.id).toBe('number');

    await removeSkill('test-skill', { brokerSocketPath: socketPath });
    await tick();

    const deregReq = stub.received.find(
      (r) => r.method === 'deregisterSkillScope',
    );
    expect(typeof deregReq?.id).toBe('number');
    fs.rmSync(dir, { recursive: true });
  });

  // Contract — stub detection
  it('Contract stub detect: broker not called for invalid skill (harness catches missed calls)', async () => {
    // Invalid YAML — no broker call should occur
    const yaml = MINIMAL_VALID_YAML.replace(/^apply_permission:.*\n/m, '');
    const dir = makeSkillDir(yaml);
    await applySkill(dir, { brokerSocketPath: socketPath });
    await tick();

    const regCall = stub.received.find((r) => r.method === 'registerSkillScope');
    // If an implementation incorrectly calls the broker for a failed validation,
    // this expect will catch it.
    expect(regCall).toBeUndefined();
    fs.rmSync(dir, { recursive: true });
  });
});

// ===========================================================================
// INTEGRATION TESTS
// Real broker stub socket + real filesystem.
// Uses describe("Integration", ...) per convention.
// ===========================================================================

describe('Integration', () => {
  let socketPath: string;
  let stub: ReturnType<typeof startBrokerStub>;

  beforeEach(async () => {
    socketPath = path.join(
      os.tmpdir(),
      `og-broker-int-${Date.now()}.sock`,
    );
    stub = startBrokerStub(socketPath);
    await tick(40);
  });

  afterEach(async () => {
    // Clean up any lingering installed skills between tests
    const list = await listInstalledSkills();
    for (const skill of list) {
      await removeSkill(skill.skillId, { brokerSocketPath: socketPath });
    }
    stub.close();
    try {
      fs.unlinkSync(socketPath);
    } catch {
      /* already gone */
    }
  });

  // AC-1 (Integration)
  it('Integration AC-1: valid skill applied → appears in registry + broker notified', async () => {
    const dir = makeSkillDir(MINIMAL_VALID_YAML);
    const result = await applySkill(dir, { brokerSocketPath: socketPath });
    await tick();

    expect(result.ok).toBe(true);

    const list = await listInstalledSkills();
    expect(list.find((s) => s.skillId === 'test-skill')).toBeDefined();

    const brokerCall = stub.received.find(
      (r) => r.method === 'registerSkillScope',
    );
    expect(brokerCall).toBeDefined();
    fs.rmSync(dir, { recursive: true });
  });

  // AC-4 (Integration): broker confirms receipt before orchestrator reports success
  it('Integration AC-4: applySkill awaits broker acknowledgement before reporting success', async () => {
    // Use a broker stub that introduces a delay — the orchestrator must wait
    // for the ack, not report success immediately and notify async.
    const delaySocketPath = path.join(
      os.tmpdir(),
      `og-delay-broker-${Date.now()}.sock`,
    );
    const delayedAck: JsonRpcRequest[] = [];
    const delayServer = net.createServer((conn) => {
      let buf = '';
      conn.on('data', (chunk) => {
        buf += chunk.toString();
        const nl = buf.indexOf('\n');
        if (nl !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          try {
            const req = JSON.parse(line) as JsonRpcRequest;
            // Delay 80 ms before responding
            setTimeout(() => {
              delayedAck.push(req);
              conn.write(
                JSON.stringify({
                  jsonrpc: '2.0',
                  result: { registered: true },
                  id: req.id,
                }) + '\n',
              );
            }, 80);
          } catch {
            /* ignore */
          }
        }
      });
    });
    delayServer.listen(delaySocketPath);
    await tick(40);

    const dir = makeSkillDir(MINIMAL_VALID_YAML);
    const result = await applySkill(dir, { brokerSocketPath: delaySocketPath });

    // When applySkill resolves, the broker must already have acknowledged
    expect(result.ok).toBe(true);
    expect(delayedAck.find((r) => r.method === 'registerSkillScope')).toBeDefined();

    delayServer.close();
    try {
      fs.unlinkSync(delaySocketPath);
    } catch {
      /* ok */
    }
    fs.rmSync(dir, { recursive: true });
  });

  // AC-5 (Integration): inspector endpoint list updated
  it('Integration AC-5: network endpoints from skill are exposed in installed skill record', async () => {
    const yaml = `\
skill: endpoint-skill
version: 1.0.0
type: feature
description: Endpoint test
network:
  endpoints:
    - pattern: "https://api.telegram.org/*"
      protocol: https
      direction: outbound
providers:
  compatible:
    - anthropic
apply_permission: admin
`;
    const dir = makeSkillDir(yaml);
    await applySkill(dir, { brokerSocketPath: socketPath });

    const list = await listInstalledSkills();
    const skill = list.find((s) => s.skillId === 'endpoint-skill');
    expect(skill).toBeDefined();
    expect(skill?.networkEndpoints?.map((e) => e.pattern)).toContain(
      'https://api.telegram.org/*',
    );
    fs.rmSync(dir, { recursive: true });
  });

  // AC-6 (Integration): removal removes scope from future tokens
  it('Integration AC-6: removeSkill sends deregisterSkillScope; skill no longer in registry', async () => {
    const dir = makeSkillDir(MINIMAL_VALID_YAML);
    await applySkill(dir, { brokerSocketPath: socketPath });

    stub.received.length = 0; // reset to watch only the removal call
    await removeSkill('test-skill', { brokerSocketPath: socketPath });
    await tick();

    expect(stub.received.find((r) => r.method === 'deregisterSkillScope')).toBeDefined();

    const list = await listInstalledSkills();
    expect(list.find((s) => s.skillId === 'test-skill')).toBeUndefined();
    fs.rmSync(dir, { recursive: true });
  });

  // AC-7 (Integration): removal does not invalidate previously issued tokens
  it('Integration AC-7: removeSkill does NOT send REVOKE for existing tokens', async () => {
    const dir = makeSkillDir(MINIMAL_VALID_YAML);
    await applySkill(dir, { brokerSocketPath: socketPath });
    stub.received.length = 0;

    await removeSkill('test-skill', { brokerSocketPath: socketPath });
    await tick();

    // The broker may receive deregisterSkillScope but must NOT receive any
    // REVOKE/invalidation call for already-issued tokens.
    const revokeCall = stub.received.find(
      (r) =>
        r.method !== 'deregisterSkillScope' &&
        String(r.method).toLowerCase().includes('revoke'),
    );
    expect(revokeCall).toBeUndefined();
    fs.rmSync(dir, { recursive: true });
  });

  // AC-10 (Integration): broker unavailability causes clean failure + rollback
  it('Integration AC-10: broker error → skill application fails; skill not in registry', async () => {
    const errSocketPath = path.join(
      os.tmpdir(),
      `og-err-broker-${Date.now()}.sock`,
    );
    const errStub = startErrorBrokerStub(errSocketPath);
    await tick(40);

    const dir = makeSkillDir(MINIMAL_VALID_YAML);
    const result = await applySkill(dir, { brokerSocketPath: errSocketPath });
    await tick();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/broker|unavailable/i);

    // Rollback: skill must not be present
    const list = await listInstalledSkills();
    expect(list.find((s) => s.skillId === 'test-skill')).toBeUndefined();

    errStub.close();
    try {
      fs.unlinkSync(errSocketPath);
    } catch {
      /* ok */
    }
    fs.rmSync(dir, { recursive: true });
  });

  it('Integration AC-10: broker unreachable (no socket) → application fails cleanly', async () => {
    // Point at a socket that has no server behind it
    const noServer = path.join(
      os.tmpdir(),
      `og-no-broker-${Date.now()}.sock`,
    );

    const dir = makeSkillDir(MINIMAL_VALID_YAML);
    const result = await applySkill(dir, { brokerSocketPath: noServer });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/broker|unreachable|unavailable|ENOENT|ECONNREFUSED/i);

    const list = await listInstalledSkills();
    expect(list.find((s) => s.skillId === 'test-skill')).toBeUndefined();
    fs.rmSync(dir, { recursive: true });
  });

  // AC-11 (Integration): Telegram .intent.md example validates correctly
  it('Integration AC-11: Telegram example .intent.md is accepted', async () => {
    const dir = makeSkillDir(TELEGRAM_YAML);
    const result = await applySkill(dir, { brokerSocketPath: socketPath });
    await tick();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skillId).toBe('telegram');
    expect(result.version).toBe('1.0.0');

    const brokerCall = stub.received.find(
      (r) => r.method === 'registerSkillScope',
    );
    expect(brokerCall).toBeDefined();
    const params = brokerCall?.params as {
      skillId: string;
      tokenScopes: string[];
      networkEndpoints: { pattern: string }[];
    };
    expect(params.skillId).toBe('telegram');
    expect(params.tokenScopes).toContain('telegram');
    expect(params.networkEndpoints.map((e) => e.pattern)).toContain(
      'https://api.telegram.org/*',
    );
    fs.rmSync(dir, { recursive: true });
  });

  it('Integration AC-11 negative: Telegram example without apply_permission is rejected', async () => {
    const yaml = TELEGRAM_YAML.replace(/^apply_permission:.*\n/m, '');
    const dir = makeSkillDir(yaml);
    const result = await applySkill(dir, { brokerSocketPath: socketPath });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe('apply_permission');
    expect(result.reason).toBeTruthy();

    // Broker must not have been called
    const brokerCall = stub.received.find(
      (r) => r.method === 'registerSkillScope',
    );
    expect(brokerCall).toBeUndefined();
    fs.rmSync(dir, { recursive: true });
  });

  // AC-12 (Integration): operational skills have no .intent.md
  it('Integration AC-12: no .intent.md → error "no .intent.md found; skill not applied"', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-op-int-'));
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '# Operational skill\n');

    const result = await applySkill(dir, { brokerSocketPath: socketPath });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/no \.intent\.md found|skill not applied/i);

    // No broker interaction
    expect(
      stub.received.find((r) => r.method === 'registerSkillScope'),
    ).toBeUndefined();

    const list = await listInstalledSkills();
    expect(list.length).toBe(0);
    fs.rmSync(dir, { recursive: true });
  });

  // Integration — Stub detection
  it('Integration stub detect: test harness catches incorrect success response', async () => {
    // Apply an invalid skill and confirm the result is not ok.
    // If the implementation blindly returned ok:true, this test would fail,
    // proving the integration tier catches unimplemented or broken behaviour.
    const yaml = MINIMAL_VALID_YAML.replace(/^apply_permission:.*\n/m, '');
    const dir = makeSkillDir(yaml);
    const result = await applySkill(dir, { brokerSocketPath: socketPath });
    expect(result.ok).toBe(false);
    expect(
      stub.received.find((r) => r.method === 'registerSkillScope'),
    ).toBeUndefined();
    fs.rmSync(dir, { recursive: true });
  });
});
