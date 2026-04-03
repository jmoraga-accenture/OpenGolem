/**
 * Credential backend factory.
 *
 * Selects the active backend from OPENGOLEM_CREDENTIAL_BACKEND.
 * Defaults to 'env' for backwards compatibility with M1.
 */
import { logger } from '../../logger.js';
import { BitwardenCredentialBackend } from './bitwarden.js';
import { EnvCredentialBackend } from './env.js';
import { OneCLICredentialBackend } from './onecli.js';
import type { CredentialBackend } from './types.js';

export type BackendName = 'env' | 'bitwarden' | 'onecli';

export function createCredentialBackend(): CredentialBackend {
  const name = (
    process.env.OPENGOLEM_CREDENTIAL_BACKEND || 'env'
  ).toLowerCase() as BackendName;

  switch (name) {
    case 'env':
      logger.info('Token Broker credential backend: env');
      return new EnvCredentialBackend();
    case 'bitwarden':
      logger.info('Token Broker credential backend: bitwarden');
      return new BitwardenCredentialBackend();
    case 'onecli':
      logger.info('Token Broker credential backend: onecli');
      return new OneCLICredentialBackend();
    default:
      logger.warn(
        { name },
        'Unknown OPENGOLEM_CREDENTIAL_BACKEND; falling back to env',
      );
      return new EnvCredentialBackend();
  }
}
