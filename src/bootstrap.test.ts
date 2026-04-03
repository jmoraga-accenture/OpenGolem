import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadConfigEnv, CONFIG_KEYS } from './bootstrap.js';

// Helpers
function writeTmpEnv(content: string): string {
  const p = path.join(os.tmpdir(), `bootstrap-test-${process.pid}-${Date.now()}.env`);
  fs.writeFileSync(p, content, 'utf-8');
  return p;
}

describe('loadConfigEnv', () => {
  let saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    // Snapshot all CONFIG_KEYS values so we can restore them after each test
    saved = {};
    for (const k of CONFIG_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of CONFIG_KEYS) {
      if (saved[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = saved[k];
      }
    }
  });

  it('populates whitelisted config keys from .env into process.env', () => {
    const p = writeTmpEnv('OPENGOLEM_CHANNELS=tui,telegram\nLOG_LEVEL=debug\n');
    loadConfigEnv(p);
    expect(process.env.OPENGOLEM_CHANNELS).toBe('tui,telegram');
    expect(process.env.LOG_LEVEL).toBe('debug');
    fs.unlinkSync(p);
  });

  it('strips double quotes from values', () => {
    const p = writeTmpEnv('OPENGOLEM_CHANNELS="tui,telegram"\n');
    loadConfigEnv(p);
    expect(process.env.OPENGOLEM_CHANNELS).toBe('tui,telegram');
    fs.unlinkSync(p);
  });

  it('strips single quotes from values', () => {
    const p = writeTmpEnv("OPENGOLEM_CHANNELS='tui,telegram'\n");
    loadConfigEnv(p);
    expect(process.env.OPENGOLEM_CHANNELS).toBe('tui,telegram');
    fs.unlinkSync(p);
  });

  it('does not overwrite existing process.env values', () => {
    process.env.OPENGOLEM_CHANNELS = 'tui';
    const p = writeTmpEnv('OPENGOLEM_CHANNELS=tui,telegram\n');
    loadConfigEnv(p);
    expect(process.env.OPENGOLEM_CHANNELS).toBe('tui');
    fs.unlinkSync(p);
  });

  it('ignores comment lines', () => {
    const p = writeTmpEnv('# OPENGOLEM_CHANNELS=tui,telegram\n');
    loadConfigEnv(p);
    expect(process.env.OPENGOLEM_CHANNELS).toBeUndefined();
    fs.unlinkSync(p);
  });

  it('silently does nothing when .env file is absent', () => {
    expect(() => loadConfigEnv('/nonexistent/path/.env')).not.toThrow();
    expect(process.env.OPENGOLEM_CHANNELS).toBeUndefined();
  });

  it('does not populate secret keys', () => {
    const secretKeys = [
      'ANTHROPIC_API_KEY',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'ANTHROPIC_AUTH_TOKEN',
      'TELEGRAM_BOT_TOKEN',
      'BW_SESSION',
      'ONECLI_GATEWAY_TOKEN',
    ];
    const lines = secretKeys.map((k) => `${k}=secret-value`).join('\n');
    const p = writeTmpEnv(lines + '\n');
    loadConfigEnv(p);
    for (const k of secretKeys) {
      expect(process.env[k]).toBeUndefined();
    }
    fs.unlinkSync(p);
  });

  it('CONFIG_KEYS contains no secret key names', () => {
    const forbidden = [
      'API_KEY',
      'TOKEN',
      'SESSION',
      'PASSWORD',
      'SECRET',
      'OAUTH',
    ];
    for (const k of CONFIG_KEYS) {
      for (const f of forbidden) {
        expect(k.toUpperCase()).not.toContain(f);
      }
    }
  });

  it('populates multiple config keys in a single .env', () => {
    const p = writeTmpEnv([
      'OPENGOLEM_CHANNELS=tui,telegram',
      'OPENGOLEM_SECURITY_MODE=golem_guard',
      'INSPECTOR_RATE_LIMIT=30',
      'TELEGRAM_ALLOW_GROUPS=1',
    ].join('\n') + '\n');
    loadConfigEnv(p);
    expect(process.env.OPENGOLEM_CHANNELS).toBe('tui,telegram');
    expect(process.env.OPENGOLEM_SECURITY_MODE).toBe('golem_guard');
    expect(process.env.INSPECTOR_RATE_LIMIT).toBe('30');
    expect(process.env.TELEGRAM_ALLOW_GROUPS).toBe('1');
    fs.unlinkSync(p);
  });
});
