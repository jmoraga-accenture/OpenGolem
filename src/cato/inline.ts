/**
 * Cato — Inline hook (Phase 1: deterministic stub).
 *
 * A Unix socket server called synchronously by the orchestrator before
 * any Alef container is dispatched. Returns { allow, reason? }.
 *
 * Phase 1 runs deterministic checks only. The socket boundary is preserved
 * so the LLM escalation path (Phase 2) can be dropped in without changing
 * the caller interface. See Decision 12 in docs/DECISIONS.md.
 *
 * Fail-closed: if the socket is unreachable or times out, the action is
 * blocked (Decision 6).
 */
import fs from 'fs';
import net from 'net';
import path from 'path';

import { CATO_SOCKET_PATH } from '../config.js';
import { logger } from '../logger.js';

export interface CatoCheckRequest {
  type: 'check_action';
  groupFolder: string;
  prompt: string;
  /** Container name, if already known */
  container?: string;
}

export interface CatoCheckResponse {
  allow: boolean;
  reason?: string;
}

// --- Deterministic checks (Phase 1) ----------------------------------------

const PATH_TRAVERSAL_RE = /\.\.(\/|\\)/;
const MAX_PROMPT_BYTES = 100_000; // 100 KB — oversized prompts may indicate context stuffing

function runDeterministicChecks(req: CatoCheckRequest): CatoCheckResponse {
  if (PATH_TRAVERSAL_RE.test(req.prompt)) {
    return { allow: false, reason: 'path_traversal_in_prompt' };
  }
  if (Buffer.byteLength(req.prompt, 'utf8') > MAX_PROMPT_BYTES) {
    return { allow: false, reason: 'prompt_exceeds_size_limit' };
  }
  return { allow: true };
}

// --- Socket server ----------------------------------------------------------

let catoServer: net.Server | null = null;

export function startCatoInlineHook(): net.Server {
  const socketPath = CATO_SOCKET_PATH;

  // Ensure the socket directory exists
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });

  // Clean up stale socket from a previous run
  try {
    if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
  } catch {
    // Non-fatal: socket may not exist on first run
  }

  catoServer = net.createServer((socket) => {
    let data = '';
    socket.on('data', (chunk) => {
      data += chunk.toString();
    });
    socket.on('end', () => {
      let response: CatoCheckResponse;
      try {
        const req: CatoCheckRequest = JSON.parse(data);
        response = runDeterministicChecks(req);
        if (!response.allow) {
          logger.warn(
            { groupFolder: req.groupFolder, reason: response.reason },
            'Cato: inline hook blocked action',
          );
        } else {
          logger.debug(
            { groupFolder: req.groupFolder },
            'Cato: inline check passed',
          );
        }
      } catch (err) {
        logger.error({ err }, 'Cato: inline hook request parse error');
        response = { allow: false, reason: 'parse_error' };
      }
      socket.write(JSON.stringify(response));
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
}

// --- Client -----------------------------------------------------------------

const CATO_CHECK_TIMEOUT_MS = 2000;

/**
 * Called by the orchestrator before dispatching any Alef container.
 * Fail-closed: socket unavailable → block.
 */
export async function catoCheck(
  req: CatoCheckRequest,
): Promise<CatoCheckResponse> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      client.destroy();
      logger.error('Cato: inline hook timeout — blocking action (fail-closed)');
      resolve({ allow: false, reason: 'cato_timeout' });
    }, CATO_CHECK_TIMEOUT_MS);

    const client = net.createConnection(CATO_SOCKET_PATH, () => {
      client.write(JSON.stringify(req));
      client.end();
    });

    let data = '';
    client.on('data', (chunk) => {
      data += chunk.toString();
    });
    client.on('end', () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(data) as CatoCheckResponse);
      } catch {
        resolve({ allow: false, reason: 'response_parse_error' });
      }
    });
    client.on('error', (err) => {
      clearTimeout(timer);
      logger.error({ err }, 'Cato: inline hook unreachable — blocking action (fail-closed)');
      resolve({ allow: false, reason: 'cato_unreachable' });
    });
  });
}
