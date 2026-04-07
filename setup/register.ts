/**
 * Step: register — Parse CLI args and register a messaging channel group into the SQLite database.
 */
import fs from 'fs';
import path from 'path';

import { STORE_DIR } from '../src/config.js';
import { initDatabase, setRegisteredGroup } from '../src/db.js';
import { isValidGroupFolder } from '../src/group-folder.js';
import { logger } from '../src/logger.js';
import { emitStatus } from './status.js';

interface RegisterArgs {
  jid: string;
  name: string;
  trigger: string;
  folder: string;
  channel: string;
  requiresTrigger: boolean;
  isMain: boolean;
  assistantName: string;
}

function parseArgs(args: string[]): RegisterArgs {
  let jid = '';
  let name = '';
  let trigger = '';
  let folder = '';
  let channel = 'whatsapp';
  let requiresTrigger = true;
  let isMain = false;
  let assistantName = 'Alef';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--jid' && args[i + 1]) {
      jid = args[++i];
    } else if (args[i] === '--name' && args[i + 1]) {
      name = args[++i];
    } else if (args[i] === '--trigger' && args[i + 1]) {
      trigger = args[++i];
    } else if (args[i] === '--folder' && args[i + 1]) {
      folder = args[++i];
    } else if (args[i] === '--channel' && args[i + 1]) {
      channel = args[++i];
    } else if (args[i] === '--no-trigger-required') {
      requiresTrigger = false;
    } else if (args[i] === '--is-main') {
      isMain = true;
    } else if (args[i] === '--assistant-name' && args[i + 1]) {
      assistantName = args[++i];
    }
  }

  return { jid, name, trigger, folder, channel, requiresTrigger, isMain, assistantName };
}

export async function run(args: string[]): Promise<void> {
  const { jid, name, trigger, folder, channel, requiresTrigger, isMain, assistantName } =
    parseArgs(args);

  if (!jid || !name || !trigger || !folder) {
    logger.warn('Missing required args for register');
    emitStatus('REGISTER_CHANNEL', {
      STATUS: 'failed',
      ERROR: 'missing_required_args',
      LOG: 'logs/setup.log',
    });
    return;
  }

  if (!isValidGroupFolder(folder)) {
    logger.warn({ folder }, 'Invalid group folder');
    emitStatus('REGISTER_CHANNEL', {
      STATUS: 'failed',
      ERROR: 'invalid_folder',
      LOG: 'logs/setup.log',
    });
    return;
  }

  initDatabase();

  setRegisteredGroup(jid, {
    name,
    folder,
    trigger,
    added_at: new Date().toISOString(),
    requiresTrigger,
    isMain,
  });

  const groupDir = path.join(STORE_DIR, 'groups', folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const claudeMdPath = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(claudeMdPath)) {
    fs.writeFileSync(claudeMdPath, '', 'utf-8');
  }

  let nameUpdated = false;

  if (assistantName !== 'Alef') {
    // Update any existing CLAUDE.md content that references the old assistant name
    const existing = fs.readFileSync(claudeMdPath, 'utf-8');
    if (existing.includes('Alef')) {
      const updated = existing.replace(/Alef/g, assistantName);
      fs.writeFileSync(claudeMdPath, updated, 'utf-8');
      nameUpdated = true;
    }

    // Update .env with the assistant name
    const envPath = path.join(process.cwd(), '.env');
    const envLine = `ASSISTANT_NAME="${assistantName}"`;
    if (fs.existsSync(envPath)) {
      const envContent = fs.readFileSync(envPath, 'utf-8');
      if (/^ASSISTANT_NAME=/m.test(envContent)) {
        const updated = envContent.replace(/^ASSISTANT_NAME=.*/m, envLine);
        fs.writeFileSync(envPath, updated, 'utf-8');
      } else {
        fs.appendFileSync(envPath, `\n${envLine}\n`, 'utf-8');
      }
    } else {
      fs.writeFileSync(envPath, `${envLine}\n`, 'utf-8');
    }
  }

  logger.info({ jid, name, folder, channel }, 'Channel registered');

  emitStatus('REGISTER_CHANNEL', {
    JID: jid,
    NAME: name,
    FOLDER: folder,
    CHANNEL: channel,
    TRIGGER: trigger,
    REQUIRES_TRIGGER: requiresTrigger,
    ASSISTANT_NAME: assistantName,
    NAME_UPDATED: nameUpdated,
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}
