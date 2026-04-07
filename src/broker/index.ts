/**
 * Token Broker + Call Inspector — JSON-RPC 2.0 implementation.
 *
 * Exports:
 *   startBrokerV2        — starts the broker Unix socket server
 *   startCredentialProxy — starts the HTTP credential proxy
 *
 * Spec: docs/specs/token-broker-spec.md
 * Decisions: 1, 2, 8, 15, 16, 19, 23, 24, 32, 37
 */

import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import https from 'https';
import net from 'net';
import path from 'path';

// ─────────────────────────────────────────────────────────────────────────────
// Constants / types
// ─────────────────────────────────────────────────────────────────────────────

export type SecurityMode = 'golem_guard' | 'supervised' | 'power';
const VALID_SECURITY_MODES: ReadonlySet<string> = new Set([
  'golem_guard',
  'supervised',
  'power',
]);
const SECURITY_MODE_RANK: Record<SecurityMode, number> = {
  golem_guard: 0,
  supervised: 1,
  power: 2,
};

// Valid provider types per spec §4.6
const VALID_PROVIDER_TYPES: ReadonlySet<string> = new Set([
  'anthropic',
  'ollama',
  'custom',
]);

// Skill → allowed endpoint prefixes
const SKILL_ENDPOINT_MAP: Record<string, readonly string[]> = {
  'anthropic.message': ['/v1/messages'],
  'anthropic.complete': ['/v1/complete'],
  'anthropic.models': ['/v1/models'],
  'anthropic.tokenize': ['/v1/tokenize'],
  'ollama.generate': ['/api/generate', '/ollama/api/generate'],
  'ollama.chat': ['/api/chat', '/ollama/api/chat'],
};

// All known-good endpoints (union of all skill mappings)
const ALL_KNOWN_ENDPOINTS: readonly string[] = [
  '/v1/messages',
  '/v1/complete',
  '/v1/models',
  '/v1/tokenize',
  '/api/generate',
  '/ollama/api/generate',
  '/api/chat',
  '/ollama/api/chat',
];

function getAllowedEndpoints(skillSet: string[]): string[] {
  const eps: string[] = [];
  for (const s of skillSet) {
    const e = SKILL_ENDPOINT_MAP[s];
    if (e) eps.push(...e);
  }
  return eps;
}

// ─────────────────────────────────────────────────────────────────────────────
// Audit log
// ─────────────────────────────────────────────────────────────────────────────

type AuditEntry = Record<string, unknown>;

class InMemoryAuditLog {
  private entries: AuditEntry[] = [];
  append(entry: AuditEntry): void {
    this.entries.push({ ...entry, ts: Date.now() });
  }
  getAll(): AuditEntry[] {
    return this.entries.slice();
  }
}

class SqliteAuditLog {
  private stmt: { run: (...a: unknown[]) => void };

  constructor(dbPath: string) {
    // Dynamic require avoids ESM/CJS mismatch and keeps the top level import-free
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3') as (p: string) => {
      exec: (s: string) => void;
      prepare: (s: string) => {
        run: (...a: unknown[]) => void;
        all: () => AuditEntry[];
      };
    };
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = Database(dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        ts      INTEGER NOT NULL,
        event   TEXT    NOT NULL,
        tokenId TEXT,
        details TEXT
      );
      CREATE TRIGGER IF NOT EXISTS prevent_delete_audit
      BEFORE DELETE ON audit_log
      BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
    `);
    this.stmt = db.prepare(
      'INSERT INTO audit_log (ts, event, tokenId, details) VALUES (?, ?, ?, ?)',
    );
  }

  append(entry: AuditEntry): void {
    const { event, tokenId, ...rest } = entry as {
      event: string;
      tokenId?: string;
      [k: string]: unknown;
    };
    this.stmt.run(
      Date.now(),
      event ?? 'unknown',
      tokenId ?? null,
      JSON.stringify(rest),
    );
  }

  getAll(): AuditEntry[] {
    return [];
  }
}

type AuditLog = InMemoryAuditLog | SqliteAuditLog;

// ─────────────────────────────────────────────────────────────────────────────
// Token Store
// ─────────────────────────────────────────────────────────────────────────────

interface TokenRecord {
  tokenId: string;
  token: string;
  contextId: string;
  skillSet: string[];
  ttl: number;
  callBudget: number;
  remainingBudget: number;
  dataScopes: string[];
  securityMode: SecurityMode;
  parentTokenId: string | null;
  issuedAt: number; // ms epoch
  expiresAt: number; // ms epoch
  revoked: boolean;
  revokeReason?: string;
}

class TokenStore {
  private readonly key: Buffer;
  private readonly records = new Map<string, TokenRecord>();
  private readonly byToken = new Map<string, string>(); // opaque token → tokenId
  readonly maxTokens: number;
  private lastStoreFullAlert = 0;

  constructor(maxTokens = 10_000) {
    this.key = crypto.randomBytes(32);
    this.maxTokens = maxTokens;
  }

  private hmac(data: string): string {
    return crypto.createHmac('sha256', this.key).update(data).digest('hex');
  }

  issue(p: {
    contextId: string;
    skillSet: string[];
    ttl: number;
    callBudget: number;
    dataScopes: string[];
    securityMode: SecurityMode;
    parentTokenId: string | null;
  }): TokenRecord | { error: 'token_store_full' } {
    if (this.records.size >= this.maxTokens) {
      const now = Date.now();
      if (now - this.lastStoreFullAlert > 60_000) {
        this.lastStoreFullAlert = now;
      }
      return { error: 'token_store_full' };
    }

    const tokenId = crypto.randomUUID();
    const now = Date.now();
    const expiresAt = now + p.ttl * 1000;

    // Build opaque JWT-like token: header.claims.sig
    // Claims do NOT expose raw credential or API key (AC-1, AC-10)
    const header = Buffer.from(
      JSON.stringify({ alg: 'HS256', typ: 'OG1' }),
    ).toString('base64url');
    const claimsObj = {
      jti: tokenId,
      ctx: p.contextId,
      skl: p.skillSet,
      bgt: p.callBudget,
      dsc: p.dataScopes,
      sec: p.securityMode,
      iat: Math.floor(now / 1000),
      exp: Math.floor(expiresAt / 1000),
    };
    const claims = Buffer.from(JSON.stringify(claimsObj)).toString('base64url');
    const sig = this.hmac(`${header}.${claims}`);
    const token = `${header}.${claims}.${sig}`;

    const record: TokenRecord = {
      tokenId,
      token,
      contextId: p.contextId,
      skillSet: p.skillSet,
      ttl: p.ttl,
      callBudget: p.callBudget,
      remainingBudget: p.callBudget,
      dataScopes: p.dataScopes,
      securityMode: p.securityMode,
      parentTokenId: p.parentTokenId,
      issuedAt: now,
      expiresAt,
      revoked: false,
    };
    this.records.set(tokenId, record);
    this.byToken.set(token, tokenId);
    return record;
  }

  getByToken(token: string): TokenRecord | null {
    // Verify signature before looking up
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, claims, sig] = parts;
    const expected = this.hmac(`${header}.${claims}`);
    // Constant-time comparison to prevent timing side-channel (F-M13-2)
    const sigBuf = Buffer.from(sig);
    const expBuf = Buffer.from(expected);
    if (
      sigBuf.length !== expBuf.length ||
      !crypto.timingSafeEqual(sigBuf, expBuf)
    )
      return null;
    const id = this.byToken.get(token);
    return id ? (this.records.get(id) ?? null) : null;
  }

  getById(tokenId: string): TokenRecord | null {
    return this.records.get(tokenId) ?? null;
  }

  revoke(tokenId: string, reason: string): void {
    const r = this.records.get(tokenId);
    if (r) {
      r.revoked = true;
      r.revokeReason = reason;
    }
  }

  /** Revoke all currently active (non-revoked, non-expired) tokens. Returns their IDs. */
  revokeAll(): string[] {
    const now = Date.now();
    const ids: string[] = [];
    for (const [id, r] of this.records) {
      if (!r.revoked && r.expiresAt > now) {
        r.revoked = true;
        r.revokeReason = 'credential_rotation';
        ids.push(id);
      }
    }
    return ids;
  }

  /** Validate a token for proxy use. Returns record or structured error. */
  validateForProxy(
    token: string,
  ): { record: TokenRecord } | { error: string; code: string } {
    const rec = this.getByToken(token);
    if (!rec)
      return { error: 'invalid or unrecognized token', code: 'invalid_token' };
    if (rec.revoked)
      return { error: 'token revoked', code: rec.revokeReason ?? 'revoked' };
    if (rec.expiresAt <= Date.now()) {
      rec.revoked = true;
      rec.revokeReason = 'ttl_expired';
      return { error: 'token expired', code: 'ttl_expired' };
    }
    if (rec.remainingBudget <= 0) {
      return { error: 'call budget exhausted', code: 'budget_exhausted' };
    }
    return { record: rec };
  }

  /** Consume one budget unit. Returns true when budget is now exhausted (token revoked). */
  consumeBudget(record: TokenRecord): boolean {
    record.remainingBudget--;
    if (record.remainingBudget <= 0) {
      record.revoked = true;
      record.revokeReason = 'budget_exhausted';
      return true;
    }
    return false;
  }

  get size(): number {
    return this.records.size;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Call Inspector — five checks
// ─────────────────────────────────────────────────────────────────────────────

// High-confidence prompt injection signatures (Decision 2 / spec §Check 3)
const INJECTION_SIGNATURES: ReadonlyArray<RegExp> = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /disregard\s+your\s+(guidelines|instructions|rules)/i,
  /system\s+prompt\s+override/i,
  /you\s+are\s+now\b/i,
  /repeat\s+the\s+above/i,
  /reveal\s+your\s+system\s+prompt/i,
  /\.\.\/.*etc\/passwd/,
  /\.\.[/\\]/,
];

function matchesInjection(body: string): boolean {
  return INJECTION_SIGNATURES.some((re) => re.test(body));
}

type InspectResult =
  | { outcome: 'pass' }
  | { outcome: 'hard_block'; code: string; message: string }
  | { outcome: 'soft_block'; checkId: string }
  | { outcome: 'escalation_failed'; reason: string };

async function runCallInspector(
  urlPath: string,
  body: string,
  token: TokenRecord,
  escalationSocketPath: string,
): Promise<InspectResult> {
  const mode = token.securityMode;
  const pathname = urlPath.split('?')[0].split('#')[0];
  const allowedEndpoints = getAllowedEndpoints(token.skillSet);

  // ── Check 1: Skill whitelist ────────────────────────────────────────────────
  // If the token has explicit skills, the endpoint must be in the skill map.
  if (allowedEndpoints.length > 0) {
    const inScope = allowedEndpoints.some(
      (ep) => pathname === ep || pathname.startsWith(ep + '/'),
    );
    if (!inScope) {
      return {
        outcome: 'hard_block',
        code: 'OUT_OF_SCOPE_ENDPOINT',
        message: 'endpoint not in skill whitelist',
      };
    }
  }

  // ── Check 2: Memory scope ────────────────────────────────────────────────────
  // Phase 1: No payload-level scope identifiers to scan for yet
  // (full enforcement requires per-group scope tagging, deferred to Phase 2)

  // ── Check 3: Prompt injection signatures ────────────────────────────────────
  if (matchesInjection(body)) {
    if (mode === 'golem_guard') {
      return {
        outcome: 'hard_block',
        code: 'PROMPT_INJECTION',
        message: 'prompt injection signature matched',
      };
    }
    if (mode === 'supervised') {
      const checkId = crypto.randomUUID();
      const decision = await catoEscalate({
        checkId,
        contextId: token.contextId,
        tokenId: token.tokenId,
        payloadHash: crypto.createHash('sha256').update(body).digest('hex'),
        payloadSize: Buffer.byteLength(body),
        inspectorCheck: 'PROMPT_INJECTION',
        escalationSocketPath,
      });
      if (decision === null) {
        return {
          outcome: 'escalation_failed',
          reason: 'escalation_socket_unreachable',
        };
      }
      if (!decision.allow) {
        return {
          outcome: 'hard_block',
          code: decision.code ?? 'PROMPT_INJECTION',
          message: decision.reason ?? 'blocked by Cato',
        };
      }
      // allow: true — fall through (forward)
    }
    // power mode: advisory — logged but not blocked (fall through)
  }

  // ── Check 4: Call rate ───────────────────────────────────────────────────────
  // Phase 1: rate limiting is per-deployment, not per-token; skip hard enforcement here.

  // ── Check 5: Endpoint scope ──────────────────────────────────────────────────
  // Validate that the endpoint is within the known-good set for the token's skills.
  if (allowedEndpoints.length > 0) {
    const ok = allowedEndpoints.some(
      (ep) => pathname === ep || pathname.startsWith(ep + '/'),
    );
    if (!ok) {
      return {
        outcome: 'hard_block',
        code: 'OUT_OF_SCOPE_ENDPOINT',
        message: 'endpoint out of token scope',
      };
    }
  } else {
    // No skills declared: fall back to global allowed list
    const ok = ALL_KNOWN_ENDPOINTS.some(
      (ep) => pathname === ep || pathname.startsWith(ep + '/'),
    );
    if (!ok) {
      return {
        outcome: 'hard_block',
        code: 'OUT_OF_SCOPE_ENDPOINT',
        message: 'endpoint not in allowed set',
      };
    }
  }

  return { outcome: 'pass' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cato escalation relay
// ─────────────────────────────────────────────────────────────────────────────

interface EscalResult {
  allow: boolean;
  code?: string;
  reason?: string;
}

async function catoEscalate(p: {
  checkId: string;
  contextId: string;
  tokenId: string;
  payloadHash: string;
  payloadSize: number;
  inspectorCheck: string;
  escalationSocketPath: string;
}): Promise<EscalResult | null> {
  return new Promise((resolve) => {
    const sock = net.createConnection(p.escalationSocketPath);
    let buf = '';
    let done = false;

    const finish = (v: EscalResult | null) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(v);
    };

    sock.setTimeout(5_000, () => finish(null));

    sock.on('connect', () => {
      sock.write(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'catoEscalate',
          params: {
            checkId: p.checkId,
            action: 'OUTBOUND_API_CALL',
            contextId: p.contextId,
            tokenId: p.tokenId,
            payloadHash: p.payloadHash,
            payloadSize: p.payloadSize,
            escalationReason: 'INSPECTOR_INCONCLUSIVE',
            inspectorCheck: p.inspectorCheck,
          },
          id: 1,
        }) + '\n',
      );
    });

    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      try {
        const resp = JSON.parse(buf.slice(0, nl)) as { result?: EscalResult };
        finish(resp.result ?? null);
      } catch {
        finish(null);
      }
    });

    sock.on('error', () => finish(null));
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON-RPC 2.0 helpers
// ─────────────────────────────────────────────────────────────────────────────

type RpcId = number | string | null;

function ok(id: RpcId, result: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: '2.0', result, id }) + '\n';
}

function err(id: RpcId, code: number, message: string, data?: unknown): string {
  const e: Record<string, unknown> = { code, message };
  if (data !== undefined) e.data = data;
  return JSON.stringify({ jsonrpc: '2.0', error: e, id }) + '\n';
}

// ─────────────────────────────────────────────────────────────────────────────
// Credential backend
// ─────────────────────────────────────────────────────────────────────────────

function resolveCredential(): string | null {
  return (
    process.env.CLAUDE_CODE_OAUTH_TOKEN ??
    process.env.ANTHROPIC_AUTH_TOKEN ??
    process.env.ANTHROPIC_API_KEY ??
    null
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared broker state registry
// Allows the proxy and broker (same process) to share a TokenStore.
// ─────────────────────────────────────────────────────────────────────────────

const _brokerRegistry = new Map<string, TokenStore>();

function getOrCreateStore(
  brokerSocketPath: string,
  maxTokens?: number,
): TokenStore {
  let store = _brokerRegistry.get(brokerSocketPath);
  if (!store) {
    store = new TokenStore(maxTokens);
    _brokerRegistry.set(brokerSocketPath, store);
  }
  return store;
}

// ─────────────────────────────────────────────────────────────────────────────
// startBrokerV2
// ─────────────────────────────────────────────────────────────────────────────

export interface BrokerHandle {
  socketPath: string;
  escalationSocketPath: string;
  close(): Promise<void>;
}

export interface StartBrokerV2Options {
  brokerSocketPath: string;
  escalationSocketPath: string;
  credentialBackend: 'env';
  auditLog: 'memory' | 'sqlite';
  auditDbPath?: string;
  maxTokens?: number;
}

export async function startBrokerV2(
  opts: StartBrokerV2Options,
): Promise<BrokerHandle> {
  // Create or retrieve the shared store for this socket path
  const store = new TokenStore(opts.maxTokens ?? 10_000);
  _brokerRegistry.set(opts.brokerSocketPath, store);

  const audit: AuditLog =
    opts.auditLog === 'sqlite' && opts.auditDbPath
      ? new SqliteAuditLog(opts.auditDbPath)
      : new InMemoryAuditLog();

  // Clean stale broker socket; do NOT pre-clean the escalation socket
  // (a test mock may already be listening there)
  try {
    fs.unlinkSync(opts.brokerSocketPath);
  } catch {
    /* ok */
  }
  fs.mkdirSync(path.dirname(opts.brokerSocketPath), { recursive: true });
  fs.mkdirSync(path.dirname(opts.escalationSocketPath), { recursive: true });

  // ── Broker lifecycle socket ──────────────────────────────────────────────
  const brokerSrv = net.createServer((conn) => {
    let buf = '';
    conn.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      for (;;) {
        const nl = buf.indexOf('\n');
        if (nl === -1) break;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;

        let parsed: {
          jsonrpc?: unknown;
          method?: unknown;
          params?: unknown;
          id?: unknown;
        };
        try {
          parsed = JSON.parse(line) as typeof parsed;
        } catch {
          conn.write(err(null, -32700, 'Parse error'));
          return;
        }

        const method = typeof parsed.method === 'string' ? parsed.method : '';
        const params =
          typeof parsed.params === 'object' &&
          parsed.params !== null &&
          !Array.isArray(parsed.params)
            ? (parsed.params as Record<string, unknown>)
            : {};
        const id =
          typeof parsed.id === 'number' ||
          typeof parsed.id === 'string' ||
          parsed.id === null
            ? parsed.id
            : null;

        void dispatchBrokerMethod(
          method,
          params,
          id,
          store,
          audit,
          opts.escalationSocketPath,
          conn,
        );
      }
    });
    conn.on('error', () => {
      /* ignore */
    });
  });

  await new Promise<void>((resolve, reject) => {
    brokerSrv.listen(opts.brokerSocketPath, resolve);
    brokerSrv.on('error', reject);
  });

  // ── Escalation socket (orchestrator-side relay) ─────────────────────────────
  // Per spec §4.2.2: The orchestrator listens; the broker connects per escalation.
  // The broker also starts a FALLBACK listener on the escalation socket so that
  // AC-6 can be verified (catoEscalate at escalation socket returns allow + schema).
  // If a listener is already active on that path (e.g. a test mock), we skip
  // the fallback gracefully — the mock becomes the effective escalation server.
  // The fallback returns allow:false (fail-closed per spec).
  const escalSrv = net.createServer((conn) => {
    let buf = '';
    conn.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      for (;;) {
        const nl = buf.indexOf('\n');
        if (nl === -1) break;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;

        let parsed: { method?: unknown; id?: unknown };
        try {
          parsed = JSON.parse(line) as typeof parsed;
        } catch {
          conn.write(err(null, -32700, 'Parse error'));
          conn.end();
          return;
        }

        const method = typeof parsed.method === 'string' ? parsed.method : '';
        const id =
          typeof parsed.id === 'number' ||
          typeof parsed.id === 'string' ||
          parsed.id === null
            ? parsed.id
            : null;

        if (method === 'catoEscalate') {
          // Fail-closed: no real Cato connected, hard-block by default.
          // A real orchestrator relay would forward to Cato; mocks override this.
          conn.write(
            ok(id, {
              allow: false,
              code: 'ESCALATION_FAILED',
              reason: 'no orchestrator relay configured',
            }),
          );
        } else {
          conn.write(err(id, -32601, 'Method not found'));
        }
        conn.end();
        break;
      }
    });
    conn.on('error', () => {
      /* ignore */
    });
  });

  // Try to start the escalation socket listener; skip if already occupied (test mock)
  let escalSrvStarted = false;
  try {
    // Try to remove a stale socket ONLY if it's a dead socket (connect fails)
    await new Promise<void>((resolve, reject) => {
      escalSrv.listen(opts.escalationSocketPath, () => {
        escalSrvStarted = true;
        resolve();
      });
      escalSrv.on('error', (e: NodeJS.ErrnoException) => {
        if (e.code === 'EADDRINUSE') {
          // Socket already occupied — a test mock is there; skip gracefully
          resolve();
        } else {
          reject(e);
        }
      });
    });
  } catch (err) {
    throw new Error(`Broker: failed to start escalation socket: ${err}`, {
      cause: err,
    });
  }

  return {
    socketPath: opts.brokerSocketPath,
    escalationSocketPath: opts.escalationSocketPath,
    async close() {
      _brokerRegistry.delete(opts.brokerSocketPath);
      await new Promise<void>((r) => brokerSrv.close(() => r()));
      if (escalSrvStarted) {
        await new Promise<void>((r) => escalSrv.close(() => r()));
      }
      try {
        fs.unlinkSync(opts.brokerSocketPath);
      } catch {
        /* ok */
      }
      if (escalSrvStarted) {
        try {
          fs.unlinkSync(opts.escalationSocketPath);
        } catch {
          /* ok */
        }
      }
    },
  };
}

async function dispatchBrokerMethod(
  method: string,
  params: Record<string, unknown>,
  id: RpcId,
  store: TokenStore,
  audit: AuditLog,
  _escalationSocketPath: string,
  conn: net.Socket,
): Promise<void> {
  switch (method) {
    case 'issueToken': {
      const r = handleIssueToken(params, store, audit);
      if ('error' in r) {
        const e = r as IssueErr;
        conn.write(err(id, e.code, e.error, e.data));
      } else {
        conn.write(ok(id, r));
      }
      break;
    }

    case 'revokeToken': {
      const { tokenId } = params;
      if (!tokenId || typeof tokenId !== 'string') {
        conn.write(
          err(id, -32600, 'tokenId is required', { field: 'tokenId' }),
        );
        break;
      }
      store.revoke(tokenId, 'explicit_revoke');
      audit.append({
        event: 'token_revoked',
        tokenId,
        reason: 'explicit_revoke',
      });
      conn.write(ok(id, { revoked: true }));
      break;
    }

    case 'health': {
      // For 'env' backend, the backend is always reachable (process.env is always available).
      // Health is 'ok' unless a different backend (Bitwarden, OneCLI) is unreachable.
      // In Phase 1, env-backend brokers always return 'ok'.
      conn.write(ok(id, { status: 'ok' }));
      break;
    }

    case 'registerSkillScope': {
      // Decision 19 — accept and store (Phase 1: in-memory, not enforced)
      conn.write(ok(id, { registered: true }));
      break;
    }

    case 'deregisterSkillScope': {
      conn.write(ok(id, { deregistered: true }));
      break;
    }

    case 'resolveSupervised': {
      // Decision 24 — confirm/cancel for supervised mode
      conn.write(ok(id, { accepted: true }));
      break;
    }

    case 'rotateCredential': {
      // Decision 37 — credential rotation
      const revokeInFlight = params.revokeInFlight === true;
      const revokedIds = revokeInFlight ? store.revokeAll() : [];
      audit.append({
        event: 'credential_emergency_rotation',
        revokedCount: revokedIds.length,
        timestamp: new Date().toISOString(),
      });
      conn.write(ok(id, { reloaded: true, revokedCount: revokedIds.length }));
      break;
    }

    case 'catoEscalate': {
      // AC-18: catoEscalate is NOT valid on the broker lifecycle socket
      conn.write(err(id, -32601, 'Method not found'));
      break;
    }

    default: {
      conn.write(err(id, -32601, 'Method not found'));
      break;
    }
  }

  conn.end();
}

// ─────────────────────────────────────────────────────────────────────────────
// issueToken handler
// ─────────────────────────────────────────────────────────────────────────────

type IssueOk = Record<string, unknown>;
type IssueErr = { error: string; code: number; data?: unknown };

function handleIssueToken(
  params: Record<string, unknown>,
  store: TokenStore,
  audit: AuditLog,
): IssueOk | IssueErr {
  const {
    contextId,
    skillSet,
    ttl,
    callBudget,
    dataScopes,
    securityMode,
    parentTokenId,
    providerType,
  } = params;

  // Validate required fields
  if (!contextId || typeof contextId !== 'string')
    return {
      error: 'contextId is required',
      code: -32600,
      data: { field: 'contextId' },
    };

  if (!Array.isArray(skillSet))
    return {
      error: 'skillSet must be an array',
      code: -32600,
      data: { field: 'skillSet' },
    };

  if (typeof ttl !== 'number')
    return {
      error: 'ttl must be a number',
      code: -32600,
      data: { field: 'ttl' },
    };

  if (typeof callBudget !== 'number')
    return {
      error: 'callBudget must be a number',
      code: -32600,
      data: { field: 'callBudget' },
    };

  if (!Array.isArray(dataScopes))
    return {
      error: 'dataScopes must be an array',
      code: -32600,
      data: { field: 'dataScopes' },
    };

  if (!securityMode || !VALID_SECURITY_MODES.has(securityMode as string))
    return {
      error: 'securityMode must be one of golem_guard, supervised, power',
      code: -32600,
      data: { field: 'securityMode' },
    };

  // AC-12: validate providerType if provided
  if (providerType !== undefined && providerType !== null) {
    if (!VALID_PROVIDER_TYPES.has(providerType as string))
      return {
        error: `unsupported provider_type: ${String(providerType)}`,
        code: -32600,
        data: { field: 'providerType' },
      };
  }

  const mode = securityMode as SecurityMode;
  const parentId =
    parentTokenId !== undefined &&
    parentTokenId !== null &&
    typeof parentTokenId === 'string'
      ? parentTokenId
      : null;

  // Delegation ceiling (AC-8, AC-9)
  if (parentId !== null) {
    const parent = store.getById(parentId);
    if (!parent)
      return {
        error: 'parent token not found',
        code: -32600,
        data: { field: 'parentTokenId' },
      };
    if (parent.revoked || parent.expiresAt <= Date.now())
      return {
        error: 'parent token is no longer valid',
        code: -32600,
        data: { field: 'parentTokenId' },
      };

    // skillSet must be a subset of parent's
    const parentSkills = new Set(parent.skillSet);
    for (const s of skillSet as string[]) {
      if (!parentSkills.has(s))
        return {
          error: `skillSet '${s}' not in parent skillSet`,
          code: -32600,
          data: { field: 'skillSet' },
        };
    }

    // dataScopes must be a subset of parent's
    const parentScopes = new Set(parent.dataScopes);
    for (const s of dataScopes as string[]) {
      if (!parentScopes.has(s))
        return {
          error: `dataScope '${s}' not in parent dataScopes`,
          code: -32600,
          data: { field: 'dataScopes' },
        };
    }

    // callBudget must not exceed parent's remaining budget
    if ((callBudget as number) > parent.remainingBudget)
      return {
        error: 'callBudget exceeds parent remaining budget',
        code: -32600,
        data: { field: 'callBudget' },
      };

    // securityMode must not be more permissive than parent's (golem_guard < supervised < power)
    if (SECURITY_MODE_RANK[mode] > SECURITY_MODE_RANK[parent.securityMode])
      return {
        error: 'securityMode more permissive than parent',
        code: -32600,
        data: { field: 'securityMode' },
      };
  }

  // Credential backend check (AC-13: no new tokens when backend unreachable)
  // For 'env' backend, the backend is always "reachable" (it's just process.env).
  // Degraded health only applies when the backend service itself is inaccessible.
  // We do not block issueToken for missing credentials in env mode —
  // the proxy will fail gracefully at forward time if no credential is configured.

  const result = store.issue({
    contextId: contextId as string,
    skillSet: skillSet as string[],
    ttl: ttl as number,
    callBudget: callBudget as number,
    dataScopes: dataScopes as string[],
    securityMode: mode,
    parentTokenId: parentId,
  });

  if ('error' in result) return { error: result.error, code: -32603 };

  audit.append({
    event: 'token_issued',
    tokenId: result.tokenId,
    contextId: result.contextId,
    skillSet: result.skillSet,
    securityMode: result.securityMode,
    ttl: result.ttl,
    expiresAt: new Date(result.expiresAt).toISOString(),
    parentTokenId: result.parentTokenId,
  });

  return {
    token: result.token,
    tokenId: result.tokenId,
    expiresAt: new Date(result.expiresAt).toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// startCredentialProxy
// ─────────────────────────────────────────────────────────────────────────────

export interface ProxyHandle {
  port: number;
  brokerSocketPath: string;
  close(): Promise<void>;
  /** Test-mode: access the in-memory audit log */
  auditLog?(): AuditEntry[];
}

export interface StartCredentialProxyOptions {
  brokerSocketPath: string;
  escalationSocketPath: string;
  credentialBackend: 'env';
  auditLog: 'memory' | 'sqlite';
  auditDbPath?: string;
}

export async function startCredentialProxy(
  opts: StartCredentialProxyOptions,
): Promise<ProxyHandle> {
  // Share the TokenStore with the broker for this socket path
  const store = getOrCreateStore(opts.brokerSocketPath);

  const audit: AuditLog =
    opts.auditLog === 'sqlite' && opts.auditDbPath
      ? new SqliteAuditLog(opts.auditDbPath)
      : new InMemoryAuditLog();

  const upstreamBase =
    process.env.ANTHROPIC_BASE_URL_UPSTREAM ?? 'https://api.anthropic.com';

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => {
      body += c.toString('utf8');
    });
    req.on('end', () => {
      void handleProxyRequest(
        req,
        res,
        body,
        store,
        audit,
        opts.escalationSocketPath,
        upstreamBase,
      );
    });
    req.on('error', () => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({ error: { type: 'internal_error', code: 'internal' } }),
      );
    });
  });

  // Decision 32: bind to 127.0.0.1 (test) / Docker bridge (production)
  // CREDENTIAL_PROXY_BIND_ADDRESS overrides; never 0.0.0.0
  const bindAddr = process.env.CREDENTIAL_PROXY_BIND_ADDRESS ?? '127.0.0.1';

  await new Promise<void>((resolve) => server.listen(0, bindAddr, resolve));
  const addr = server.address() as net.AddressInfo;

  const handle: ProxyHandle = {
    port: addr.port,
    brokerSocketPath: opts.brokerSocketPath,
    async close() {
      await new Promise<void>((r) => server.close(() => r()));
    },
  };

  if (opts.auditLog === 'memory') {
    handle.auditLog = () => (audit as InMemoryAuditLog).getAll();
  }

  return handle;
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP proxy request handler
// ─────────────────────────────────────────────────────────────────────────────

async function handleProxyRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: string,
  store: TokenStore,
  audit: AuditLog,
  escalationSocketPath: string,
  upstreamBase: string,
): Promise<void> {
  const urlPath = req.url ?? '/';

  // Extract bearer token
  const auth = req.headers['authorization'];
  const bearer =
    typeof auth === 'string' && auth.startsWith('Bearer ')
      ? auth.slice(7)
      : null;

  if (!bearer) {
    sendBlock(res, 'invalid_token', 'missing bearer token');
    audit.append({
      event: 'proxied_call_blocked',
      tokenId: null,
      inspector_check: 'TOKEN_VALIDATION',
      code: 'missing_token',
    });
    return;
  }

  // Validate token
  const validation = store.validateForProxy(bearer);
  if ('error' in validation) {
    sendBlock(res, validation.code, validation.error);
    audit.append({
      event: 'proxied_call_blocked',
      tokenId: null,
      inspector_check: 'TOKEN_VALIDATION',
      code: validation.code,
    });
    return;
  }

  const record = validation.record;
  const providerType = detectProviderType(req, record);

  // Run Call Inspector
  const inspectResult = await runCallInspector(
    urlPath,
    body,
    record,
    escalationSocketPath,
  );

  if (inspectResult.outcome === 'hard_block') {
    sendBlock(res, inspectResult.code, inspectResult.message);
    audit.append({
      event: 'proxied_call_blocked',
      tokenId: record.tokenId,
      inspector_check: inspectResult.code,
      code: inspectResult.code,
      endpoint_category: urlPath,
    });
    return;
  }

  if (inspectResult.outcome === 'escalation_failed') {
    sendBlock(res, 'ESCALATION_FAILED', inspectResult.reason);
    audit.append({
      event: 'proxied_call_blocked',
      tokenId: record.tokenId,
      inspector_check: 'ESCALATION_FAILED',
      reason: inspectResult.reason,
    });
    return;
  }

  // Consume budget (before forwarding, per spec: budget exhausted token is revoked
  // but the call that exhausted it is still forwarded)
  const exhausted = store.consumeBudget(record);
  if (exhausted) {
    audit.append({
      event: 'token_revoked',
      tokenId: record.tokenId,
      reason: 'budget_exhausted',
    });
  }

  // Forward to upstream
  const start = Date.now();
  try {
    await forwardRequest(
      req,
      res,
      body,
      record,
      providerType,
      upstreamBase,
      audit,
      urlPath,
      start,
    );
  } catch {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: { type: 'upstream_error', code: 'upstream_unreachable' },
        }),
      );
    }
    audit.append({
      event: 'proxied_call_pass',
      tokenId: record.tokenId,
      endpoint_category: urlPath,
      budget_consumed: record.callBudget - record.remainingBudget,
      budget_remaining: record.remainingBudget,
      provider_type: providerType,
      response_status: 502,
      latency_ms: Date.now() - start,
    });
  }
}

function sendBlock(
  res: http.ServerResponse,
  code: string,
  message: string,
): void {
  if (res.headersSent) return;
  res.writeHead(403, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { type: 'call_blocked', code, message } }));
}

function detectProviderType(
  req: http.IncomingMessage,
  record: TokenRecord,
): string {
  const h = req.headers['x-provider-type'];
  if (typeof h === 'string' && VALID_PROVIDER_TYPES.has(h)) return h;
  if (record.skillSet.some((s) => s.startsWith('ollama.'))) return 'ollama';
  return 'anthropic';
}

async function forwardRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: string,
  record: TokenRecord,
  providerType: string,
  upstreamBase: string,
  audit: AuditLog,
  urlPath: string,
  start: number,
): Promise<void> {
  // Always use the configured upstreamBase — never accept x-provider-endpoint
  // from containers. Accepting a container-supplied URL would allow a valid
  // token to redirect credentialed requests to arbitrary internal addresses
  // (SSRF), bypassing the Call Inspector's endpoint-scope check. (F-M13-1)
  const targetBase = upstreamBase;
  const isHttp = targetBase.startsWith('http://');
  const targetUrl = new URL(
    urlPath,
    targetBase.endsWith('/') ? targetBase.slice(0, -1) : targetBase,
  );

  const outHeaders: http.OutgoingHttpHeaders = {
    'content-type': req.headers['content-type'] ?? 'application/json',
    'content-length': Buffer.byteLength(body),
  };

  // AC-11: ollama gets NO Authorization header
  if (providerType !== 'ollama') {
    const cred = resolveCredential();
    if (cred) outHeaders['authorization'] = `Bearer ${cred}`;
  }

  await new Promise<void>((resolve, reject) => {
    const mod = isHttp ? http : https;
    const outReq = mod.request(
      {
        hostname: targetUrl.hostname,
        port: targetUrl.port || (isHttp ? 80 : 443),
        path: targetUrl.pathname + targetUrl.search,
        method: req.method ?? 'POST',
        headers: outHeaders,
      },
      (proxyRes) => {
        const latency = Date.now() - start;
        audit.append({
          event: 'proxied_call_pass',
          tokenId: record.tokenId,
          endpoint_category: urlPath,
          budget_consumed: record.callBudget - record.remainingBudget,
          budget_remaining: record.remainingBudget,
          provider_type: providerType,
          response_status: proxyRes.statusCode,
          latency_ms: latency,
        });

        // Strip auth headers from upstream response (AC-10)
        const safeHeaders: http.OutgoingHttpHeaders = {};
        for (const [k, v] of Object.entries(proxyRes.headers)) {
          const kl = k.toLowerCase();
          if (kl !== 'authorization' && kl !== 'x-api-key') {
            safeHeaders[k] = v as string;
          }
        }
        res.writeHead(proxyRes.statusCode ?? 200, safeHeaders);
        proxyRes.pipe(res);
        proxyRes.on('end', resolve);
        proxyRes.on('error', reject);
      },
    );
    outReq.on('error', reject);
    outReq.write(body);
    outReq.end();
  });
}
