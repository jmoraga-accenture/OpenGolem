import { describe, it, expect } from 'vitest';
import { seedTelegramDmGroups, type SeedDeps } from './seed-groups.js';
import type { RegisteredGroup } from './types.js';

function makeDeps(overrides: Partial<SeedDeps> = {}): SeedDeps & {
  registered: Record<string, RegisteredGroup>;
  calls: Array<{ jid: string; group: RegisteredGroup }>;
} {
  const registered: Record<string, RegisteredGroup> = {};
  const calls: Array<{ jid: string; group: RegisteredGroup }> = [];
  return {
    isChannelEnabled: () => true,
    getTelegramValidUserSet: () => new Set(['111', '222']),
    registeredGroups: () => registered,
    registerGroup: (jid, group) => {
      calls.push({ jid, group });
      registered[jid] = group;
    },
    defaultTrigger: '@Alef',
    registered,
    calls,
    ...overrides,
  };
}

describe('seedTelegramDmGroups', () => {
  it('registers tg:{userId} for each user in TELEGRAM_VALID_USERS', () => {
    const deps = makeDeps();
    seedTelegramDmGroups(deps);
    expect(deps.calls).toHaveLength(2);
    expect(deps.calls[0].jid).toBe('tg:111');
    expect(deps.calls[1].jid).toBe('tg:222');
  });

  it('uses folder tg-{userId}', () => {
    const deps = makeDeps();
    seedTelegramDmGroups(deps);
    expect(deps.calls[0].group.folder).toBe('tg-111');
    expect(deps.calls[1].group.folder).toBe('tg-222');
  });

  it('sets requiresTrigger=false', () => {
    const deps = makeDeps();
    seedTelegramDmGroups(deps);
    expect(deps.calls[0].group.requiresTrigger).toBe(false);
  });

  it('sets isMain=false', () => {
    const deps = makeDeps();
    seedTelegramDmGroups(deps);
    expect(deps.calls[0].group.isMain).toBe(false);
  });

  it('uses the provided defaultTrigger', () => {
    const deps = makeDeps({ defaultTrigger: '@Bot' });
    seedTelegramDmGroups(deps);
    expect(deps.calls[0].group.trigger).toBe('@Bot');
  });

  it('skips JIDs that are already registered', () => {
    const deps = makeDeps();
    deps.registered['tg:111'] = {
      name: 'existing',
      folder: 'tg-111',
      trigger: '@Alef',
      added_at: '',
      requiresTrigger: false,
    };
    seedTelegramDmGroups(deps);
    expect(deps.calls).toHaveLength(1);
    expect(deps.calls[0].jid).toBe('tg:222');
  });

  it('does nothing when telegram channel is disabled', () => {
    const deps = makeDeps({ isChannelEnabled: () => false });
    seedTelegramDmGroups(deps);
    expect(deps.calls).toHaveLength(0);
  });

  it('does nothing when TELEGRAM_VALID_USERS is null', () => {
    const deps = makeDeps({ getTelegramValidUserSet: () => null });
    seedTelegramDmGroups(deps);
    expect(deps.calls).toHaveLength(0);
  });

  it('does nothing when TELEGRAM_VALID_USERS is an empty set', () => {
    const deps = makeDeps({ getTelegramValidUserSet: () => new Set() });
    seedTelegramDmGroups(deps);
    expect(deps.calls).toHaveLength(0);
  });

  it('registers a single user correctly', () => {
    const deps = makeDeps({
      getTelegramValidUserSet: () => new Set(['7448431705']),
    });
    seedTelegramDmGroups(deps);
    expect(deps.calls).toHaveLength(1);
    expect(deps.calls[0].jid).toBe('tg:7448431705');
    expect(deps.calls[0].group.name).toBe('Telegram DM 7448431705');
    expect(deps.calls[0].group.folder).toBe('tg-7448431705');
  });
});
