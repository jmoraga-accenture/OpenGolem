/**
 * Setup step: fetch/list group metadata.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { STORE_DIR } from '../src/config.js';
import { logger } from '../src/logger.js';
import { emitStatus } from './status.js';

const projectRoot = process.cwd();

function listGroups(limit: number): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  if (!fs.existsSync(dbPath)) {
    console.error('No messages.db found.');
    return;
  }

  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .prepare(
        `SELECT jid, name FROM chats
         WHERE jid LIKE '%@g.us'
           AND jid <> '__group_sync__'
           AND name <> jid
         ORDER BY last_message_time DESC
         LIMIT ?`,
      )
      .all(limit) as Array<{ jid: string; name: string }>;

    for (const row of rows) {
      console.log(`${row.jid} | ${row.name}`);
    }
  } finally {
    db.close();
  }
}

function syncGroups(): void {
  const syncBin = path.join(projectRoot, 'scripts', 'sync-groups');
  if (!fs.existsSync(syncBin)) {
    logger.info('WhatsApp sync binary not found; skipping group sync');
    emitStatus('SYNC_GROUPS', {
      STATUS: 'skipped',
      REASON: 'sync_binary_not_found',
    });
    return;
  }

  try {
    execSync(syncBin, { stdio: 'inherit' });
    logger.info('group sync complete');
    emitStatus('SYNC_GROUPS', { STATUS: 'success' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err }, 'group sync failed');
    emitStatus('SYNC_GROUPS', { STATUS: 'failed', ERROR: message });
    process.exit(1);
  }
}

export async function run(args: string[]): Promise<void> {
  const listFlag = args.includes('--list');

  const limitIdx = args.indexOf('--limit');
  const limit =
    limitIdx !== -1 && args[limitIdx + 1]
      ? parseInt(args[limitIdx + 1], 10) || 30
      : 30;

  if (listFlag) {
    listGroups(limit);
    return;
  }

  syncGroups();
}
