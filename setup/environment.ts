/**
 * Setup step: detect OS, Node, container runtimes, and existing config.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { STORE_DIR } from '../src/config.js';
import { logger } from '../src/logger.js';
import { commandExists, getPlatform, isHeadless, isWSL } from './platform.js';
import { emitStatus } from './status.js';

const projectRoot = process.cwd();

type DockerStatus = 'running' | 'installed_not_running' | 'not_found';

function getDockerStatus(): DockerStatus {
  if (!commandExists('docker')) return 'not_found';
  try {
    execSync('docker info', { stdio: 'ignore' });
    return 'running';
  } catch {
    return 'installed_not_running';
  }
}

function checkRegisteredGroups(): boolean {
  const jsonPath = path.join(projectRoot, 'data', 'registered_groups.json');
  if (fs.existsSync(jsonPath)) return true;

  const dbPath = path.join(STORE_DIR, 'messages.db');
  if (!fs.existsSync(dbPath)) return false;

  try {
    const db = new Database(dbPath, { readonly: true });
    const row = db
      .prepare('SELECT COUNT(*) as count FROM registered_groups')
      .get() as { count: number };
    db.close();
    return row.count > 0;
  } catch {
    return false;
  }
}

export async function run(_args: string[]): Promise<void> {
  const PLATFORM = getPlatform();
  const IS_WSL = isWSL();
  const IS_HEADLESS = isHeadless();
  const APPLE_CONTAINER = commandExists('container');
  const DOCKER = getDockerStatus();

  const HAS_ENV = fs.existsSync(path.join(projectRoot, '.env'));

  const authDir = path.join(projectRoot, 'store', 'auth');
  const HAS_AUTH =
    fs.existsSync(authDir) && fs.readdirSync(authDir).length > 0;

  const HAS_REGISTERED_GROUPS = checkRegisteredGroups();

  logger.info(
    {
      PLATFORM,
      IS_WSL,
      IS_HEADLESS,
      APPLE_CONTAINER,
      DOCKER,
      HAS_ENV,
      HAS_AUTH,
      HAS_REGISTERED_GROUPS,
    },
    'environment check complete',
  );

  emitStatus('CHECK_ENVIRONMENT', {
    PLATFORM,
    IS_WSL,
    IS_HEADLESS,
    APPLE_CONTAINER,
    DOCKER,
    HAS_ENV,
    HAS_AUTH,
    HAS_REGISTERED_GROUPS,
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}
