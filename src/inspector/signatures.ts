/**
 * Call Inspector — static signature lists.
 *
 * INJECTION_SIGNATURES: high-confidence prompt injection patterns.
 * ALLOWED_ENDPOINT_PREFIXES: valid Anthropic API paths; anything else is out of scope.
 */

export const INJECTION_SIGNATURES: readonly string[] = [
  'ignore previous instructions',
  'disregard your guidelines',
  'system prompt override',
  'you are now',
  'repeat the above',
];

export const ALLOWED_ENDPOINT_PREFIXES: readonly string[] = [
  '/v1/messages',
  '/v1/complete',
  '/v1/models',
  '/v1/tokenize',
];
