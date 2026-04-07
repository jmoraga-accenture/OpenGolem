import fs from 'fs';
import path from 'path';

/**
 * Reads the `.env` file at `process.cwd()/.env` and returns values for the
 * requested keys. Does NOT mutate `process.env` — safe to call at bootstrap
 * without side-effects on the running process environment. Has no imports
 * from this codebase to avoid circular dependencies at startup.
 */
export function readEnvFile(keys: string[]): Record<string, string> {
  const envPath = path.join(process.cwd(), '.env');

  let raw: string;
  try {
    raw = fs.readFileSync(envPath, 'utf8');
  } catch {
    return {};
  }

  const keySet = new Set(keys);
  const result: Record<string, string> = {};

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;

    const key = trimmed.slice(0, eqIdx).trim();
    if (!keySet.has(key)) continue;

    let value = trimmed.slice(eqIdx + 1).trim();

    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }

    if (!value) continue;

    result[key] = value;
  }

  return result;
}
