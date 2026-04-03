import { describe, it, expect, beforeEach } from 'vitest';
import { TokenStore } from './token.js';

describe('TokenStore — issue', () => {
  let store: TokenStore;

  beforeEach(() => {
    store = new TokenStore();
  });

  it('issues a token that verifies successfully', () => {
    const token = store.issue({
      container_id: 'c1',
      skills: ['anthropic.message'],
      scopes: ['context:home'],
      ttl_seconds: 60,
      budget: 50,
    });
    const result = store.verify(token);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.claims.container_id).toBe('c1');
      expect(result.claims.skills).toEqual(['anthropic.message']);
      expect(result.claims.scopes).toEqual(['context:home']);
      expect(result.claims.budget).toBe(50);
      expect(result.claims.jti).toBeTruthy();
    }
  });

  it('each token has a unique jti', () => {
    const t1 = store.issue({ container_id: 'c1', skills: [], scopes: [], ttl_seconds: 60, budget: 10 });
    const t2 = store.issue({ container_id: 'c1', skills: [], scopes: [], ttl_seconds: 60, budget: 10 });
    const r1 = store.verify(t1);
    const r2 = store.verify(t2);
    expect(r1.valid && r2.valid).toBe(true);
    if (r1.valid && r2.valid) {
      expect(r1.claims.jti).not.toBe(r2.claims.jti);
    }
  });

  it('different stores cannot verify each other\'s tokens', () => {
    const store2 = new TokenStore();
    const token = store.issue({ container_id: 'c1', skills: [], scopes: [], ttl_seconds: 60, budget: 10 });
    const result = store2.verify(token);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('invalid signature');
  });
});

describe('TokenStore — verify', () => {
  let store: TokenStore;

  beforeEach(() => {
    store = new TokenStore();
  });

  it('rejects a tampered payload', () => {
    const token = store.issue({ container_id: 'c1', skills: [], scopes: [], ttl_seconds: 60, budget: 10 });
    const [payload, sig] = token.split('.');
    // Flip a character in the payload
    const tampered = payload.slice(0, -1) + (payload.slice(-1) === 'a' ? 'b' : 'a');
    const result = store.verify(`${tampered}.${sig}`);
    expect(result.valid).toBe(false);
  });

  it('rejects a malformed token', () => {
    expect(store.verify('notavalidtoken').valid).toBe(false);
    expect(store.verify('').valid).toBe(false);
    expect(store.verify('a.b.c').valid).toBe(false);
  });

  it('rejects an expired token', async () => {
    const token = store.issue({ container_id: 'c1', skills: [], scopes: [], ttl_seconds: -1, budget: 10 });
    const result = store.verify(token);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('token expired');
  });
});

describe('TokenStore — revoke by token', () => {
  let store: TokenStore;

  beforeEach(() => {
    store = new TokenStore();
  });

  it('revokeToken makes the token invalid', () => {
    const token = store.issue({ container_id: 'c1', skills: [], scopes: [], ttl_seconds: 60, budget: 10 });
    expect(store.verify(token).valid).toBe(true);
    expect(store.revokeToken(token)).toBe(true);
    const result = store.verify(token);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('token revoked');
  });

  it('revokeToken returns false for an invalid token', () => {
    expect(store.revokeToken('garbage')).toBe(false);
  });

  it('revoking one token does not affect others', () => {
    const t1 = store.issue({ container_id: 'c1', skills: [], scopes: [], ttl_seconds: 60, budget: 10 });
    const t2 = store.issue({ container_id: 'c1', skills: [], scopes: [], ttl_seconds: 60, budget: 10 });
    store.revokeToken(t1);
    expect(store.verify(t1).valid).toBe(false);
    expect(store.verify(t2).valid).toBe(true);
  });
});

describe('TokenStore — revoke by container', () => {
  let store: TokenStore;

  beforeEach(() => {
    store = new TokenStore();
  });

  it('revokeContainer revokes all tokens for that container', () => {
    const t1 = store.issue({ container_id: 'c1', skills: [], scopes: [], ttl_seconds: 60, budget: 10 });
    const t2 = store.issue({ container_id: 'c1', skills: [], scopes: [], ttl_seconds: 60, budget: 10 });
    const t3 = store.issue({ container_id: 'c2', skills: [], scopes: [], ttl_seconds: 60, budget: 10 });

    const count = store.revokeContainer('c1');
    expect(count).toBe(2);
    expect(store.verify(t1).valid).toBe(false);
    expect(store.verify(t2).valid).toBe(false);
    expect(store.verify(t3).valid).toBe(true); // c2 unaffected
  });

  it('revokeContainer returns 0 for unknown container', () => {
    expect(store.revokeContainer('unknown')).toBe(0);
  });
});

describe('TokenStore — budget', () => {
  let store: TokenStore;

  beforeEach(() => {
    store = new TokenStore();
  });

  it('issues token with the requested budget', () => {
    const token = store.issue({ container_id: 'c1', skills: [], scopes: [], ttl_seconds: 60, budget: 42 });
    const result = store.verify(token);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.claims.budget).toBe(42);
  });
});

describe('TokenStore — activeCount', () => {
  let store: TokenStore;

  beforeEach(() => {
    store = new TokenStore();
  });

  it('counts active tokens', () => {
    expect(store.activeCount()).toBe(0);
    const t1 = store.issue({ container_id: 'c1', skills: [], scopes: [], ttl_seconds: 60, budget: 10 });
    const t2 = store.issue({ container_id: 'c2', skills: [], scopes: [], ttl_seconds: 60, budget: 10 });
    expect(store.activeCount()).toBe(2);
    store.revokeToken(t1);
    expect(store.activeCount()).toBe(1);
    store.revokeToken(t2);
    expect(store.activeCount()).toBe(0);
  });

  it('does not count expired tokens', () => {
    store.issue({ container_id: 'c1', skills: [], scopes: [], ttl_seconds: -1, budget: 10 });
    expect(store.activeCount()).toBe(0);
  });
});
