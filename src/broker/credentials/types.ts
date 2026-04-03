/**
 * CredentialBackend — interface for pluggable credential resolution.
 *
 * The Token Broker resolves API credentials through exactly one active
 * backend, selected by OPENGOLEM_CREDENTIAL_BACKEND. The backend is never
 * exposed to containers; only the Token Broker touches it.
 *
 * Backends:
 *   env      — reads from .env / process.env (M1 parity, dev default)
 *   bitwarden — invokes `bw` CLI to fetch items (recommended for self-host)
 *   onecli   — delegates to an OneCLI Agent Vault gateway (optional)
 */

export interface ResolvedCredential {
  /** HTTP header name to inject: 'Authorization' or 'x-api-key' */
  headerName: 'Authorization' | 'x-api-key';
  /** Full header value, e.g. 'Bearer sk-...' or the raw API key */
  headerValue: string;
}

export interface CredentialBackend {
  /** Human-readable name for logging */
  readonly name: string;

  /**
   * Resolve the active API credential.
   * Called once per token ISSUE request — not cached inside the broker,
   * so credential rotations take effect on the next issued token.
   * Throws if no credential is available.
   */
  resolve(): Promise<ResolvedCredential>;
}
