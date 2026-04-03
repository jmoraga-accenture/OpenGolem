/**
 * Bitwarden credential backend.
 *
 * Invokes the Bitwarden CLI (`bw`) to fetch a stored item by name.
 * Recommended for self-hosted production installs — credentials live in a
 * user-owned vault, not on disk.
 *
 * Required env vars:
 *   BW_SESSION        — unlocked Bitwarden session token (from `bw unlock`)
 *   BW_ITEM_NAME      — name of the Bitwarden item holding the credential
 *                        (default: "OpenGolem API Key")
 *   BW_FIELD_NAME     — custom field name within the item holding the key
 *                        (default: "api_key")
 *
 * The item is expected to have a custom field matching BW_FIELD_NAME whose
 * value is the raw API key or OAuth token. The backend auto-detects the
 * credential type by prefix:
 *   starts with "sk-ant-"  → ANTHROPIC_API_KEY  (x-api-key header)
 *   anything else          → OAuth token         (Authorization: Bearer)
 */
import { execFile } from 'child_process';
import { promisify } from 'util';

import { readEnvFile } from '../../env.js';
import type { CredentialBackend, ResolvedCredential } from './types.js';

const execFileAsync = promisify(execFile);

export class BitwardenCredentialBackend implements CredentialBackend {
  readonly name = 'bitwarden';

  async resolve(): Promise<ResolvedCredential> {
    const env = readEnvFile(['BW_SESSION', 'BW_ITEM_NAME', 'BW_FIELD_NAME']);

    const session = process.env.BW_SESSION || env.BW_SESSION;
    if (!session) {
      throw new Error(
        'BitwardenCredentialBackend: BW_SESSION not set. ' +
          'Run `bw unlock` and set BW_SESSION to the output.',
      );
    }

    const itemName =
      process.env.BW_ITEM_NAME || env.BW_ITEM_NAME || 'OpenGolem API Key';
    const fieldName =
      process.env.BW_FIELD_NAME || env.BW_FIELD_NAME || 'api_key';

    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(
        'bw',
        ['get', 'item', itemName, '--session', session],
        { timeout: 10_000 },
      ));
    } catch (err) {
      throw new Error(
        `BitwardenCredentialBackend: failed to fetch item "${itemName}": ${err}`,
      );
    }

    let item: { fields?: Array<{ name: string; value: string }> };
    try {
      item = JSON.parse(stdout);
    } catch {
      throw new Error(
        `BitwardenCredentialBackend: could not parse bw output for item "${itemName}"`,
      );
    }

    const field = item.fields?.find((f) => f.name === fieldName);
    if (!field?.value) {
      throw new Error(
        `BitwardenCredentialBackend: field "${fieldName}" not found in item "${itemName}". ` +
          'Add a custom field with that name containing the API key or OAuth token.',
      );
    }

    const value = field.value.trim();
    if (value.startsWith('sk-ant-')) {
      return { headerName: 'x-api-key', headerValue: value };
    }
    return { headerName: 'Authorization', headerValue: `Bearer ${value}` };
  }
}
