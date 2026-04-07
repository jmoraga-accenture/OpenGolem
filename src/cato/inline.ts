/**
 * Cato — Inline hook (Phase 1: deterministic).
 *
 * A Unix socket server called synchronously by the orchestrator before
 * any significant action. Returns a binary allow/block decision.
 *
 * Protocol: newline-delimited JSON (one complete JSON object per line).
 * Each request produces exactly one response. Fail-closed on all error paths.
 *
 * Request schema (spec §2.1):
 *   { checkId, action, contextId, tokenId, payloadHash, payloadSize, contentExcerpt? }
 *
 * Response schema (spec §2.1):
 *   { checkId, allow, code, reason }
 *
 * Phase 1 checks: PATH_TRAVERSAL (from contentExcerpt), OVERSIZED_PAYLOAD.
 * Unknown action values are rejected with allow: false.
 *
 * Audit log: a cato_check event is written to the unified audit log before
 * the response is sent. If the write fails after retries, returns allow: false
 * with reason: 'audit_write_failed' (spec §3.6).
 *
 * See Decision 12 in docs/DECISIONS.md.
 */
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import path from 'path';

import { CATO_SOCKET_PATH, DATA_DIR } from '../config.js';
import { logger } from '../logger.js';
import {
  openAuditLog,
  AuditInitError,
  AuditWriteError,
  type AuditLog,
} from '../shared/audit/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Valid action values from cato-spec.md §2.1. */
const VALID_ACTIONS = new Set([
  'AGENT_PROMPT',
  'OUTBOUND_API_CALL',
  'FILESYSTEM_WRITE',
  'CREDENTIAL_REQUEST',
  'MEMORY_WRITE',
]);

/** Required fields on every inbound request. */
const REQUIRED_FIELDS = [
  'checkId',
  'action',
  'contextId',
  'tokenId',
  'payloadHash',
  'payloadSize',
] as const;

export interface CatoCheckRequest {
  checkId: string;
  action: string;
  contextId: string;
  tokenId: string;
  payloadHash: string;
  payloadSize: number;
  contentExcerpt?: string | null;
}

export interface CatoCheckResponse {
  checkId: string;
  allow: boolean;
  code: string | null;
  reason: string | null;
}

// ---------------------------------------------------------------------------
// Deterministic checks (Phase 1)
// ---------------------------------------------------------------------------

const PATH_TRAVERSAL_RE = /\.\.(\/|\\)/;
const MAX_PAYLOAD_BYTES = 100_000; // 100 KB

function runDeterministicChecks(req: CatoCheckRequest): CatoCheckResponse {
  // Missing required fields → fail-closed
  for (const field of REQUIRED_FIELDS) {
    if (req[field] === undefined || req[field] === null) {
      return {
        checkId: String(req.checkId ?? ''),
        allow: false,
        code: null,
        reason: 'malformed request',
      };
    }
  }

  // Unknown action → fail-closed (spec §2.1: unknown action treated as error)
  if (!VALID_ACTIONS.has(req.action)) {
    return {
      checkId: req.checkId,
      allow: false,
      code: null,
      reason: 'malformed request',
    };
  }

  // Oversized payload check (does not require contentExcerpt)
  if (req.payloadSize > MAX_PAYLOAD_BYTES) {
    return {
      checkId: req.checkId,
      allow: false,
      code: 'OVERSIZED_PAYLOAD',
      reason: 'Payload exceeds size limit',
    };
  }

  // Path traversal check (only when contentExcerpt is provided)
  if (req.contentExcerpt) {
    let decoded: string;
    try {
      decoded = Buffer.from(req.contentExcerpt, 'base64').toString('utf8');
    } catch {
      decoded = req.contentExcerpt;
    }
    if (PATH_TRAVERSAL_RE.test(decoded)) {
      return {
        checkId: req.checkId,
        allow: false,
        code: 'PATH_TRAVERSAL',
        reason: 'Prompt contains filesystem escape sequence',
      };
    }
  }

  return { checkId: req.checkId, allow: true, code: null, reason: null };
}

// ---------------------------------------------------------------------------
// Audit log instance (singleton for the inline hook server process)
// ---------------------------------------------------------------------------

let _auditLog: AuditLog | null = null;
let _auditLogError: Error | null = null;

function getAuditLog(): AuditLog | null {
  if (_auditLogError) return null;
  if (_auditLog) return _auditLog;
  try {
    const dbPath = path.join(DATA_DIR, 'audit.db');
    _auditLog = openAuditLog(dbPath, 'cato');
    return _auditLog;
  } catch (err) {
    _auditLogError = err instanceof Error ? err : new Error(String(err));
    logger.error(
      { err },
      'Cato: failed to open audit log — audit writes will fail closed',
    );
    return null;
  }
}

/** For tests: inject a pre-initialised audit log (or null to simulate failure). */
export function _setAuditLog(log: AuditLog | null): void {
  _auditLog = log;
  _auditLogError = null;
}

/**
 * Write a cato_check audit event. Returns true on success, false on failure.
 * Per spec §3.6: if the write fails, the caller must return allow: false.
 */
function writeAuditEvent(
  req: CatoCheckRequest,
  response: CatoCheckResponse,
): boolean {
  const auditLog = getAuditLog();
  if (!auditLog) return false;

  try {
    auditLog.writeEvent({
      event_type: 'cato_check',
      context_id: req.contextId,
      check_id: req.checkId,
      token_id: req.tokenId,
      outcome: response.allow ? 'allow' : 'block',
      risk_code: response.code ?? null,
      payload_hash: req.payloadHash,
      payload_size: req.payloadSize,
      details: {
        check_id: req.checkId,
        action: req.action,
        context_id: req.contextId,
        token_id: req.tokenId,
        payload_hash: req.payloadHash,
        payload_size: req.payloadSize,
        allow: response.allow,
        ...(response.code ? { risk_code: response.code } : {}),
        ...(response.reason && !response.allow
          ? { reason: response.reason }
          : {}),
      },
    });
    return true;
  } catch (err) {
    if (err instanceof AuditWriteError || err instanceof AuditInitError) {
      logger.error({ err }, 'Cato: audit write failed');
    } else {
      logger.error({ err }, 'Cato: unexpected audit write error');
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Socket server
// ---------------------------------------------------------------------------

let catoServer: net.Server | null = null;

export function startCatoInlineHook(): net.Server {
  const socketPath = CATO_SOCKET_PATH;

  // Ensure the socket directory exists (data/sockets/)
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });

  // Also ensure data/ exists for audit.db
  fs.mkdirSync(DATA_DIR, { recursive: true });

  // Clean up stale socket from a previous run
  try {
    if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
  } catch {
    // Non-fatal
  }

  // Pre-initialize audit log at startup so the first check doesn't pay for init
  getAuditLog();

  catoServer = net.createServer((socket) => {
    let buf = '';

    socket.on('data', (chunk) => {
      buf += chunk.toString();
      // Process complete lines
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        processLine(socket, trimmed);
      }
    });

    // When the client half-closes, process any remaining buffered data
    socket.on('end', () => {
      const trimmed = buf.trim();
      buf = '';
      if (!trimmed) return;
      processLine(socket, trimmed);
      socket.end();
    });

    socket.on('error', (err) => {
      logger.debug({ err }, 'Cato: inline hook socket client error');
    });
  });

  catoServer.listen(socketPath, () => {
    logger.info({ socketPath }, 'Cato: inline hook listening');
  });

  catoServer.on('error', (err) => {
    logger.error({ err }, 'Cato: inline hook server error');
  });

  return catoServer;
}

function processLine(socket: net.Socket, trimmed: string): void {
  let req: CatoCheckRequest;
  try {
    req = JSON.parse(trimmed) as CatoCheckRequest;
  } catch {
    // Non-JSON line: discard per spec §4 — no response sent for that line
    logger.warn('Cato: received non-JSON line on socket — discarding');
    return;
  }

  // Compute the check result
  const response = runDeterministicChecks(req);

  // Write audit log BEFORE sending response (spec invariant §3.6.3)
  const auditOk = writeAuditEvent(req, response);
  if (!auditOk) {
    // Audit write failed — return allow: false (fail-closed per spec §3.6)
    const failResponse: CatoCheckResponse = {
      checkId: response.checkId,
      allow: false,
      code: null,
      reason: 'audit_write_failed',
    };
    logger.error(
      { checkId: response.checkId },
      'Cato: audit write failed — returning allow:false (fail-closed)',
    );
    socket.write(JSON.stringify(failResponse) + '\n');
    return;
  }

  if (!response.allow) {
    logger.warn(
      { checkId: req.checkId, action: req.action, code: response.code },
      'Cato: inline hook blocked action',
    );
  } else {
    logger.debug(
      { checkId: req.checkId, action: req.action },
      'Cato: inline check passed',
    );
  }

  socket.write(JSON.stringify(response) + '\n');
}

export function stopCatoInlineHook(): void {
  if (catoServer) {
    catoServer.close();
    catoServer = null;
    try {
      fs.unlinkSync(CATO_SOCKET_PATH);
    } catch {
      // Socket may already be gone
    }
  }
  if (_auditLog) {
    try {
      _auditLog.close();
    } catch {
      /* ok */
    }
    _auditLog = null;
    _auditLogError = null;
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

const CATO_CHECK_TIMEOUT_MS = 2000;

/**
 * Called by the orchestrator before dispatching any action.
 * Fail-closed: socket unavailable or timeout → block.
 */
export async function catoCheck(
  req: CatoCheckRequest,
): Promise<CatoCheckResponse> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      client.destroy();
      logger.error('Cato: inline hook timeout — blocking action (fail-closed)');
      resolve({
        checkId: req.checkId,
        allow: false,
        code: null,
        reason: 'cato_timeout',
      });
    }, CATO_CHECK_TIMEOUT_MS);

    const client = net.createConnection(CATO_SOCKET_PATH, () => {
      // newline-delimited JSON — one object per line
      client.write(JSON.stringify(req) + '\n', () => {
        client.end();
      });
    });

    let data = '';
    client.on('data', (chunk) => {
      data += chunk.toString();
      // Resolve as soon as we have a complete JSON line
      const line = data.split('\n').find((l) => l.trim().length > 0);
      if (line) {
        clearTimeout(timer);
        try {
          const parsed = JSON.parse(line) as CatoCheckResponse;
          client.destroy();
          resolve(parsed);
        } catch {
          // incomplete JSON — wait for more data
        }
      }
    });
    client.on('end', () => {
      clearTimeout(timer);
      const line = data.split('\n').find((l) => l.trim().length > 0);
      if (!line) {
        resolve({
          checkId: req.checkId,
          allow: false,
          code: null,
          reason: 'empty_response',
        });
        return;
      }
      try {
        resolve(JSON.parse(line) as CatoCheckResponse);
      } catch {
        resolve({
          checkId: req.checkId,
          allow: false,
          code: null,
          reason: 'response_parse_error',
        });
      }
    });
    client.on('error', (err) => {
      clearTimeout(timer);
      logger.error(
        { err },
        'Cato: inline hook unreachable — blocking action (fail-closed)',
      );
      resolve({
        checkId: req.checkId,
        allow: false,
        code: null,
        reason: 'cato_unreachable',
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Utility: compute payload hash and size from a string (for callers)
// ---------------------------------------------------------------------------

export function computePayloadHashAndSize(content: string): {
  payloadHash: string;
  payloadSize: number;
} {
  const buf = Buffer.from(content, 'utf8');
  return {
    payloadHash: crypto.createHash('sha256').update(buf).digest('hex'),
    payloadSize: buf.byteLength,
  };
}
