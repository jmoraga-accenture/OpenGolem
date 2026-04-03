/**
 * Call Inspector — the five checks.
 *
 * Each function returns { pass, rule, advisory }.
 * advisory=true: log but never block (Phase 1 limitation noted inline).
 * advisory=false: eligible for hard/soft block depending on security mode.
 */
import {
  ALLOWED_ENDPOINT_PREFIXES,
  INJECTION_SIGNATURES,
} from './signatures.js';

export interface CheckResult {
  pass: boolean;
  rule: string;
  advisory: boolean;
}

/**
 * Check 1 — Skill Whitelist.
 * In Phase 1 the container's broker token is not forwarded in HTTP headers,
 * so we cannot verify which skills the calling container was granted.
 * Advisory until Phase 2 adds X-Golem-Token header support.
 */
export function checkSkillWhitelist(
  _endpoint: string,
  _jti: string,
): CheckResult {
  return { pass: true, rule: 'checkSkillWhitelist', advisory: true };
}

/**
 * Check 2 — Memory Scope.
 * In Phase 1 container identity is unknown; cross-group scope enforcement
 * requires the jti to look up declared scopes in the broker.
 * Advisory until Phase 2.
 */
export function checkMemoryScope(_body: string, _jti: string): CheckResult {
  return { pass: true, rule: 'checkMemoryScope', advisory: true };
}

/**
 * Check 3 — Prompt Injection.
 * Case-insensitive scan against INJECTION_SIGNATURES.
 * Always a hard check (never advisory).
 */
export function checkPromptInjection(body: string): CheckResult {
  const lower = body.toLowerCase();
  for (const sig of INJECTION_SIGNATURES) {
    if (lower.includes(sig)) {
      return { pass: false, rule: 'checkPromptInjection', advisory: false };
    }
  }
  return { pass: true, rule: 'checkPromptInjection', advisory: false };
}

/**
 * Check 4 — Call Rate.
 * Caller supplies the count of calls in the current sliding window and
 * the per-minute threshold; this function is a pure predicate.
 */
export function checkCallRate(
  callsInWindow: number,
  threshold: number,
): CheckResult {
  if (callsInWindow >= threshold) {
    return { pass: false, rule: 'checkCallRate', advisory: false };
  }
  return { pass: true, rule: 'checkCallRate', advisory: false };
}

/**
 * Check 5 — Endpoint Scope.
 * Validates the request path against the allowed Anthropic API prefix list.
 * Query string and fragment are stripped before comparison.
 */
export function checkEndpointScope(urlPath: string): CheckResult {
  const pathname = urlPath.split('?')[0].split('#')[0];
  const allowed = ALLOWED_ENDPOINT_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(prefix + '/'),
  );
  return { pass: allowed, rule: 'checkEndpointScope', advisory: false };
}
