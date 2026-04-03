/**
 * Token Broker — token signing and verification.
 *
 * Format: base64url(payload_json).base64url(hmac_sha256)
 * The signing key is generated fresh at broker startup and never persisted.
 * Revocation is tracked in-memory (jti set + container→jti index).
 */
import { createHmac, randomBytes, randomUUID } from 'crypto';

export interface TokenClaims {
  jti: string;
  container_id: string;
  skills: string[];
  scopes: string[];
  iat: number; // unix seconds
  exp: number; // unix seconds
  budget: number;
}

export interface IssueInput {
  container_id: string;
  skills: string[];
  scopes: string[];
  ttl_seconds: number;
  budget: number;
}

export type VerifyResult =
  | { valid: true; claims: TokenClaims }
  | { valid: false; reason: string };

function b64uEncode(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function b64uDecode(s: string): Buffer {
  const pad = s + '='.repeat((4 - (s.length % 4)) % 4);
  return Buffer.from(pad.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

export class TokenStore {
  private readonly key: Buffer;
  // jti → claims (for budget tracking in M3+)
  private readonly issued = new Map<string, TokenClaims>();
  // container_id → Set<jti>
  private readonly byContainer = new Map<string, Set<string>>();
  // revoked jtis
  private readonly revoked = new Set<string>();

  constructor() {
    this.key = randomBytes(32);
  }

  issue(input: IssueInput): string {
    const now = Math.floor(Date.now() / 1000);
    const claims: TokenClaims = {
      jti: randomUUID(),
      container_id: input.container_id,
      skills: input.skills,
      scopes: input.scopes,
      iat: now,
      exp: now + input.ttl_seconds,
      budget: input.budget,
    };

    const payload = b64uEncode(Buffer.from(JSON.stringify(claims)));
    const sig = b64uEncode(
      createHmac('sha256', this.key).update(payload).digest(),
    );
    const token = `${payload}.${sig}`;

    this.issued.set(claims.jti, claims);
    const existing = this.byContainer.get(claims.container_id) ?? new Set();
    existing.add(claims.jti);
    this.byContainer.set(claims.container_id, existing);

    return token;
  }

  verify(token: string): VerifyResult {
    const dot = token.lastIndexOf('.');
    if (dot === -1) return { valid: false, reason: 'malformed: no separator' };

    const payload = token.slice(0, dot);
    const sig = token.slice(dot + 1);

    const expected = b64uEncode(
      createHmac('sha256', this.key).update(payload).digest(),
    );
    if (sig !== expected) return { valid: false, reason: 'invalid signature' };

    let claims: TokenClaims;
    try {
      claims = JSON.parse(b64uDecode(payload).toString('utf8'));
    } catch {
      return { valid: false, reason: 'malformed payload' };
    }

    if (this.revoked.has(claims.jti))
      return { valid: false, reason: 'token revoked' };

    const now = Math.floor(Date.now() / 1000);
    if (now > claims.exp) return { valid: false, reason: 'token expired' };

    return { valid: true, claims };
  }

  /**
   * Revoke a specific token. Returns false if token is invalid/unknown.
   */
  revokeToken(token: string): boolean {
    const result = this.verify(token);
    if (!result.valid) return false;
    this.revoked.add(result.claims.jti);
    return true;
  }

  /**
   * Revoke all tokens issued to a container. Returns count revoked.
   */
  revokeContainer(containerId: string): number {
    const jtis = this.byContainer.get(containerId);
    if (!jtis) return 0;
    for (const jti of jtis) this.revoked.add(jti);
    return jtis.size;
  }

  /** Active (non-expired, non-revoked) token count. */
  activeCount(): number {
    const now = Math.floor(Date.now() / 1000);
    let count = 0;
    for (const claims of this.issued.values()) {
      if (!this.revoked.has(claims.jti) && now <= claims.exp) count++;
    }
    return count;
  }
}
