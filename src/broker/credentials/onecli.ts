/**
 * OneCLI credential backend.
 *
 * Delegates credential resolution to an OneCLI Agent Vault gateway.
 * Supported only when the gateway is bound to loopback (or equivalent
 * vetted network posture). This is the same security model as NanoClaw's
 * original credential proxy.
 *
 * Required env vars:
 *   ONECLI_GATEWAY_URL   — base URL of the OneCLI gateway
 *                          (e.g. http://127.0.0.1:4000)
 *   ONECLI_VAULT_TOKEN   — bearer token for gateway authentication
 *
 * The gateway must expose:
 *   POST /v1/credential
 *   Body: { "service": "anthropic" }
 *   Response: { "header_name": "...", "header_value": "..." }
 */
import { readEnvFile } from '../../env.js';
import type { CredentialBackend, ResolvedCredential } from './types.js';

export class OneCLICredentialBackend implements CredentialBackend {
  readonly name = 'onecli';

  async resolve(): Promise<ResolvedCredential> {
    const env = readEnvFile(['ONECLI_GATEWAY_URL', 'ONECLI_VAULT_TOKEN']);

    const gatewayUrl = process.env.ONECLI_GATEWAY_URL || env.ONECLI_GATEWAY_URL;
    const vaultToken = process.env.ONECLI_VAULT_TOKEN || env.ONECLI_VAULT_TOKEN;

    if (!gatewayUrl) {
      throw new Error('OneCLICredentialBackend: ONECLI_GATEWAY_URL not set.');
    }
    if (!vaultToken) {
      throw new Error('OneCLICredentialBackend: ONECLI_VAULT_TOKEN not set.');
    }

    const url = `${gatewayUrl.replace(/\/$/, '')}/v1/credential`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${vaultToken}`,
        },
        body: JSON.stringify({ service: 'anthropic' }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch (err) {
      throw new Error(
        `OneCLICredentialBackend: request to ${url} failed: ${err}`,
      );
    }

    if (!res.ok) {
      throw new Error(
        `OneCLICredentialBackend: gateway returned ${res.status} from ${url}`,
      );
    }

    let raw: unknown;
    try {
      raw = await res.json();
    } catch {
      throw new Error(
        `OneCLICredentialBackend: could not parse gateway response from ${url}`,
      );
    }

    if (
      typeof raw !== 'object' ||
      raw === null ||
      typeof (raw as { header_name?: unknown }).header_name !== 'string' ||
      typeof (raw as { header_value?: unknown }).header_value !== 'string'
    ) {
      throw new Error(
        `OneCLICredentialBackend: gateway response missing header_name or header_value`,
      );
    }

    const body = raw as { header_name: string; header_value: string };

    return {
      headerName: body.header_name as 'Authorization' | 'x-api-key',
      headerValue: body.header_value,
    };
  }
}
