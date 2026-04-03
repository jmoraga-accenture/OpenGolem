import fs from 'fs';

import {
  getTelegramValidUserSet,
  isTelegramAllowGroupsEnabled,
  SENDER_ALLOWLIST_PATH,
} from './config.js';
import { logger } from './logger.js';
import type { NewMessage } from './types.js';

export interface ChatAllowlistEntry {
  allow: '*' | string[];
  mode: 'trigger' | 'drop';
}

export interface SenderAllowlistConfig {
  default: ChatAllowlistEntry;
  chats: Record<string, ChatAllowlistEntry>;
  logDenied: boolean;
}

const DEFAULT_CONFIG: SenderAllowlistConfig = {
  default: { allow: '*', mode: 'trigger' },
  chats: {},
  logDenied: true,
};

function isValidEntry(entry: unknown): entry is ChatAllowlistEntry {
  if (!entry || typeof entry !== 'object') return false;
  const e = entry as Record<string, unknown>;
  const validAllow =
    e.allow === '*' ||
    (Array.isArray(e.allow) && e.allow.every((v) => typeof v === 'string'));
  const validMode = e.mode === 'trigger' || e.mode === 'drop';
  return validAllow && validMode;
}

export function loadSenderAllowlist(
  pathOverride?: string,
): SenderAllowlistConfig {
  const filePath = pathOverride ?? SENDER_ALLOWLIST_PATH;

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return DEFAULT_CONFIG;
    logger.warn(
      { err, path: filePath },
      'sender-allowlist: cannot read config',
    );
    return DEFAULT_CONFIG;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.warn({ path: filePath }, 'sender-allowlist: invalid JSON');
    return DEFAULT_CONFIG;
  }

  const obj = parsed as Record<string, unknown>;

  if (!isValidEntry(obj.default)) {
    logger.warn(
      { path: filePath },
      'sender-allowlist: invalid or missing default entry',
    );
    return DEFAULT_CONFIG;
  }

  const chats: Record<string, ChatAllowlistEntry> = {};
  if (obj.chats && typeof obj.chats === 'object') {
    for (const [jid, entry] of Object.entries(
      obj.chats as Record<string, unknown>,
    )) {
      if (isValidEntry(entry)) {
        chats[jid] = entry;
      } else {
        logger.warn(
          { jid, path: filePath },
          'sender-allowlist: skipping invalid chat entry',
        );
      }
    }
  }

  return {
    default: obj.default as ChatAllowlistEntry,
    chats,
    logDenied: obj.logDenied !== false,
  };
}

function getEntry(
  chatJid: string,
  cfg: SenderAllowlistConfig,
): ChatAllowlistEntry {
  return cfg.chats[chatJid] ?? cfg.default;
}

/** Supergroups/groups use negative numeric ids in `tg:` JIDs. */
export function isTelegramGroupSupergroupJid(jid: string): boolean {
  if (!jid.startsWith('tg:')) return false;
  const rest = jid.slice(3);
  return rest.startsWith('-');
}

/**
 * When group Telegram is enabled, every supergroup/group must have an explicit
 * allowlist so random members cannot drive the agent. Satisfied by non-empty
 * `TELEGRAM_VALID_USERS` or a per-chat entry whose `allow` is not `*`.
 */
export function telegramGroupHasExplicitAllowlist(
  chatJid: string,
  cfg: SenderAllowlistConfig,
): boolean {
  if (!isTelegramGroupSupergroupJid(chatJid)) return true;
  if (!isTelegramAllowGroupsEnabled()) return true;
  if (getTelegramValidUserSet()) return true;
  return getEntry(chatJid, cfg).allow !== '*';
}

export function isSenderAllowed(
  chatJid: string,
  sender: string,
  cfg: SenderAllowlistConfig,
): boolean {
  const tgSet = getTelegramValidUserSet();
  if (chatJid.startsWith('tg:') && tgSet) {
    return tgSet.has(sender);
  }
  const entry = getEntry(chatJid, cfg);
  if (entry.allow === '*') return true;
  return entry.allow.includes(sender);
}

export function shouldDropMessage(
  chatJid: string,
  cfg: SenderAllowlistConfig,
): boolean {
  if (chatJid.startsWith('tg:') && getTelegramValidUserSet()) {
    return true;
  }
  return getEntry(chatJid, cfg).mode === 'drop';
}

export function isTriggerAllowed(
  chatJid: string,
  sender: string,
  cfg: SenderAllowlistConfig,
): boolean {
  const allowed = isSenderAllowed(chatJid, sender, cfg);
  if (!allowed && cfg.logDenied) {
    logger.debug(
      { chatJid, sender },
      'sender-allowlist: trigger denied for sender',
    );
  }
  return allowed;
}

/** Inbound fields used when applying the allowlist to stored messages. */
export type AllowlistMessageSlice = Pick<
  NewMessage,
  'sender' | 'is_from_me' | 'is_bot_message'
>;

/**
 * Telegram only: inbound messages from non-allowlisted users must not reach
 * the agent or trigger processing (main groups previously skipped this).
 * Other channels are unchanged. For Telegram you can set `TELEGRAM_VALID_USERS`
 * in `.env` (comma-separated IDs) or use `sender-allowlist.json`.
 */
export function filterMessagesForTelegramAllowlist<T extends AllowlistMessageSlice>(
  chatJid: string,
  messages: T[],
  cfg: SenderAllowlistConfig,
): T[] {
  if (!chatJid.startsWith('tg:')) return messages;
  return messages.filter(
    (m) =>
      m.is_from_me ||
      m.is_bot_message ||
      isSenderAllowed(chatJid, m.sender, cfg),
  );
}
