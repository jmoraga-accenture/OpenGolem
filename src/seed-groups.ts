/**
 * Auto-registration helpers for seeding default groups on startup.
 * Extracted as pure functions for testability.
 */

import type { RegisteredGroup } from './types.js';

export interface SeedDeps {
  isChannelEnabled: (channel: string) => boolean;
  getTelegramValidUserSet: () => Set<string> | null;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  defaultTrigger: string;
}

/**
 * Auto-register private Telegram DM chats for each user listed in
 * TELEGRAM_VALID_USERS, if not already registered.
 * Mirrors TUI auto-registration: personal assistants shouldn't require a
 * setup step to receive messages from their owner.
 * Groups/supergroups are NOT auto-registered — they must be added explicitly.
 */
export function seedTelegramDmGroups(deps: SeedDeps): void {
  if (!deps.isChannelEnabled('telegram')) return;
  const validUsers = deps.getTelegramValidUserSet();
  if (!validUsers) return;
  for (const userId of validUsers) {
    const jid = `tg:${userId}`;
    if (deps.registeredGroups()[jid]) continue;
    deps.registerGroup(jid, {
      name: `Telegram DM ${userId}`,
      folder: `tg-${userId}`,
      trigger: deps.defaultTrigger,
      added_at: new Date().toISOString(),
      requiresTrigger: false,
      isMain: false,
    });
  }
}
