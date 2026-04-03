/**
 * Bootstrap: populate non-secret config vars from .env into process.env
 * before any other module loads.
 *
 * Must be the first import in src/index.ts so it runs before logger.ts
 * evaluates getEnabledChannelIds() at module load time.
 *
 * IMPORTANT: Only non-secret configuration keys are listed here.
 * Secret keys (API keys, tokens, passwords) must NEVER appear in this list —
 * they must stay out of process.env so they are not inherited by child
 * processes (Docker containers, subshells).
 */

import fs from 'fs';
import path from 'path';

/**
 * Keys that are safe to populate into process.env from .env.
 * These are configuration values, not secrets.
 * Secrets (ANTHROPIC_API_KEY, TELEGRAM_BOT_TOKEN, BW_SESSION, etc.)
 * must never appear here — they are read via readEnvFile() at point of use.
 */
export const CONFIG_KEYS = new Set([
  'OPENGOLEM_CHANNELS',
  'OPENGOLEM_SECURITY_MODE',
  'OPENGOLEM_CREDENTIAL_BACKEND',
  'INSPECTOR_RATE_LIMIT',
  'CREDENTIAL_PROXY_PORT',
  'LOG_LEVEL',
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'TZ',
  'TELEGRAM_VALID_USERS',
  'TELEGRAM_ALLOW_GROUPS',
]);

/**
 * Read the given .env file and populate whitelisted config keys into
 * process.env. Existing process.env values are never overwritten (env
 * vars set by the shell or systemd take precedence).
 *
 * Exported for testing; called once at module load time below.
 */
export function loadConfigEnv(envFilePath: string): void {
  let content: string;
  try {
    content = fs.readFileSync(envFilePath, 'utf-8');
  } catch {
    // .env absent — normal in CI, Docker, and fresh installs
    return;
  }

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!CONFIG_KEYS.has(key) || process.env[key] !== undefined) continue;
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (value) process.env[key] = value;
  }
}

// Run at module load time — must happen before logger.ts loads.
loadConfigEnv(path.join(process.cwd(), '.env'));
