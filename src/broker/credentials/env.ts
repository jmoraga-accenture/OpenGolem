/**
 * Env credential backend.
 *
 * Reads from .env / process.env. Same credential resolution order as the
 * M1 credential proxy. Suitable for local dev; document as non-default for
 * production (secrets on disk).
 *
 * Resolution order:
 *   1. CLAUDE_CODE_OAUTH_TOKEN  → Authorization: Bearer <token>
 *   2. ANTHROPIC_AUTH_TOKEN     → Authorization: Bearer <token>
 *   3. ANTHROPIC_API_KEY        → x-api-key: <key>
 */
import { readEnvFile } from '../../env.js';
import type { CredentialBackend, ResolvedCredential } from './types.js';

export class EnvCredentialBackend implements CredentialBackend {
  readonly name = 'env';

  resolve(): Promise<ResolvedCredential> {
    const env = readEnvFile([
      'CLAUDE_CODE_OAUTH_TOKEN',
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_API_KEY',
    ]);

    const oauthToken =
      process.env.CLAUDE_CODE_OAUTH_TOKEN || env.CLAUDE_CODE_OAUTH_TOKEN;
    if (oauthToken) {
      return Promise.resolve({
        headerName: 'Authorization',
        headerValue: `Bearer ${oauthToken}`,
      });
    }

    const authToken =
      process.env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_AUTH_TOKEN;
    if (authToken) {
      return Promise.resolve({
        headerName: 'Authorization',
        headerValue: `Bearer ${authToken}`,
      });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY;
    if (apiKey) {
      return Promise.resolve({
        headerName: 'x-api-key',
        headerValue: apiKey,
      });
    }

    return Promise.reject(
      new Error(
        'EnvCredentialBackend: no credential found. ' +
          'Set ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, or ANTHROPIC_AUTH_TOKEN in .env.',
      ),
    );
  }
}
