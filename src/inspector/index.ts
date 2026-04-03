/**
 * Call Inspector — M3
 *
 * Runs on every outbound Anthropic API request through the credential proxy.
 * Five checks in order; all outcomes (pass and block) are written to audit.db.
 *
 * Security modes (OPENGOLEM_SECURITY_MODE):
 *   golem_guard (default) — hard block on any non-advisory check failure
 *   supervised            — soft block (log + forward in Phase 1; interactive
 *                           pause planned for Phase 2)
 *   power                 — only checkPromptInjection is a hard block;
 *                           all others are advisory
 *
 * Phase 1 limitations (see checks.ts for details):
 *   - checkSkillWhitelist and checkMemoryScope are advisory: container identity
 *     (broker token) is not forwarded in HTTP headers by the Claude Code SDK.
 *   - supervised mode forwards the request after logging (Phase 2 will pause it).
 */
import { logger } from '../logger.js';
import { hashPayload, logCall } from './audit.js';
import {
  checkCallRate,
  checkEndpointScope,
  checkMemoryScope,
  checkPromptInjection,
  checkSkillWhitelist,
} from './checks.js';

export type SecurityMode = 'golem_guard' | 'supervised' | 'power';

export function getSecurityMode(): SecurityMode {
  const raw = (
    process.env.OPENGOLEM_SECURITY_MODE ?? 'golem_guard'
  ).toLowerCase();
  if (raw === 'supervised' || raw === 'power') return raw as SecurityMode;
  return 'golem_guard';
}

// Calls-per-minute threshold (across all containers sharing this proxy process)
const RATE_LIMIT = parseInt(process.env.INSPECTOR_RATE_LIMIT ?? '60', 10);

// Sliding 60-second window — module-level to persist across requests
const callTimestamps: number[] = [];

function recordAndCount(): number {
  const now = Date.now();
  const cutoff = now - 60_000;
  let i = 0;
  while (i < callTimestamps.length && callTimestamps[i] < cutoff) i++;
  if (i > 0) callTimestamps.splice(0, i);
  callTimestamps.push(now);
  return callTimestamps.length;
}

/** Reset rate-limit window — for tests only. */
export function _resetCallTimestamps(): void {
  callTimestamps.length = 0;
}

export interface InspectResult {
  allow: boolean;
  outcome: 'pass' | 'hard_block' | 'soft_block';
  blockRule?: string;
}

/**
 * Inspect an outbound API request.
 *
 * @param urlPath   - request path (including query string)
 * @param body      - request body as a UTF-8 string
 * @param jti       - broker token jti for the calling container ('unknown' in Phase 1)
 * @param container - container name ('unknown' in Phase 1)
 */
export function inspectRequest(
  urlPath: string,
  body: string,
  jti = 'unknown',
  container = 'unknown',
): InspectResult {
  const mode = getSecurityMode();
  const skill = urlPath.split('?')[0];
  const payloadHash = hashPayload(body);
  const callsInWindow = recordAndCount();

  const checks = [
    checkSkillWhitelist(skill, jti),
    checkMemoryScope(body, jti),
    checkPromptInjection(body),
    checkCallRate(callsInWindow, RATE_LIMIT),
    checkEndpointScope(urlPath),
  ];

  for (const result of checks) {
    if (result.pass) continue;

    // Advisory checks: log but never block regardless of mode
    if (result.advisory) {
      logger.warn(
        { rule: result.rule, container, mode },
        'Inspector advisory check failed (not blocking)',
      );
      continue;
    }

    // Power mode: only checkPromptInjection hard-blocks
    if (mode === 'power' && result.rule !== 'checkPromptInjection') {
      logger.warn(
        { rule: result.rule, container, mode },
        'Inspector check failed (advisory in power mode)',
      );
      continue;
    }

    // Supervised mode: soft block — log, forward for now, Phase 2 will pause
    if (mode === 'supervised') {
      logger.warn(
        { rule: result.rule, container, mode },
        'Inspector soft block (supervised — forwarding in Phase 1)',
      );
      logCall({
        jti,
        container,
        skill,
        outcome: 'soft_block',
        blockRule: result.rule,
        payloadHash,
        securityMode: mode,
      });
      return { allow: true, outcome: 'soft_block', blockRule: result.rule };
    }

    // Golem Guard: hard block
    logger.warn({ rule: result.rule, container, mode }, 'Inspector hard block');
    logCall({
      jti,
      container,
      skill,
      outcome: 'hard_block',
      blockRule: result.rule,
      payloadHash,
      securityMode: mode,
    });
    return { allow: false, outcome: 'hard_block', blockRule: result.rule };
  }

  logCall({
    jti,
    container,
    skill,
    outcome: 'pass',
    blockRule: null,
    payloadHash,
    securityMode: mode,
  });
  return { allow: true, outcome: 'pass' };
}
