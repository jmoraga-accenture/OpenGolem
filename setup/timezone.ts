/**
 * Setup step: detect, validate, and persist the timezone.
 */
import fs from 'fs';
import path from 'path';

import { isValidTimezone } from '../src/timezone.js';
import { logger } from '../src/logger.js';
import { emitStatus } from './status.js';

const projectRoot = process.cwd();
const envPath = path.join(projectRoot, '.env');

function readEnvFileTz(): string | undefined {
  if (!fs.existsSync(envPath)) return undefined;
  const content = fs.readFileSync(envPath, 'utf-8');
  const match = /^TZ=(.+)$/m.exec(content);
  return match?.[1]?.trim() || undefined;
}

function writeEnvFileTz(tz: string): void {
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf-8');
    if (/^TZ=.*/m.test(content)) {
      fs.writeFileSync(envPath, content.replace(/^TZ=.*$/m, `TZ=${tz}`));
    } else {
      fs.writeFileSync(envPath, content.trimEnd() + `\nTZ=${tz}\n`);
    }
  } else {
    fs.writeFileSync(envPath, `TZ=${tz}\n`);
  }
}

export async function run(args: string[]): Promise<void> {
  const SYSTEM_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const ENV_TZ = process.env.TZ ?? '';
  const ENV_FILE_TZ = readEnvFileTz() ?? '';

  // Parse --tz flag
  let flagTz: string | undefined;
  const tzIdx = args.indexOf('--tz');
  if (tzIdx !== -1 && args[tzIdx + 1]) {
    flagTz = args[tzIdx + 1];
  }

  // Resolve with priority: --tz > .env file > process.env.TZ > system TZ
  const candidates: Array<string | undefined> = [
    flagTz,
    ENV_FILE_TZ || undefined,
    ENV_TZ || undefined,
    SYSTEM_TZ || undefined,
  ];

  let RESOLVED_TZ = '';
  for (const candidate of candidates) {
    if (candidate && isValidTimezone(candidate)) {
      RESOLVED_TZ = candidate;
      break;
    }
  }

  const NEEDS_USER_INPUT = !RESOLVED_TZ;
  const STATUS = NEEDS_USER_INPUT ? 'needs_input' : 'success';

  if (RESOLVED_TZ && RESOLVED_TZ !== ENV_FILE_TZ) {
    writeEnvFileTz(RESOLVED_TZ);
    logger.info({ RESOLVED_TZ }, 'timezone written to .env');
  }

  logger.info({ SYSTEM_TZ, ENV_TZ, ENV_FILE_TZ, RESOLVED_TZ, STATUS }, 'timezone step complete');

  emitStatus('TIMEZONE', {
    SYSTEM_TZ,
    ENV_TZ,
    ENV_FILE_TZ,
    RESOLVED_TZ,
    NEEDS_USER_INPUT,
    STATUS,
  });
}
