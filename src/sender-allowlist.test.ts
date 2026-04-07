import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  filterMessagesForTelegramAllowlist,
  isSenderAllowed,
  isTelegramGroupSupergroupJid,
  isTriggerAllowed,
  loadSenderAllowlist,
  SenderAllowlistConfig,
  shouldDropMessage,
  telegramGroupHasExplicitAllowlist,
} from './sender-allowlist.js';

let tmpDir: string;

function cfgPath(name = 'sender-allowlist.json'): string {
  return path.join(tmpDir, name);
}

function writeConfig(config: unknown, name?: string): string {
  const p = cfgPath(name);
  fs.writeFileSync(p, JSON.stringify(config));
  return p;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'allowlist-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('loadSenderAllowlist', () => {
  it('returns allow-all defaults when file is missing', () => {
    const cfg = loadSenderAllowlist(cfgPath());
    expect(cfg.default.allow).toBe('*');
    expect(cfg.default.mode).toBe('trigger');
    expect(cfg.logDenied).toBe(true);
  });

  it('loads allow=* config', () => {
    const p = writeConfig({
      default: { allow: '*', mode: 'trigger' },
      chats: {},
      logDenied: false,
    });
    const cfg = loadSenderAllowlist(p);
    expect(cfg.default.allow).toBe('*');
    expect(cfg.logDenied).toBe(false);
  });

  it('loads allow=[] (deny all)', () => {
    const p = writeConfig({
      default: { allow: [], mode: 'trigger' },
      chats: {},
    });
    const cfg = loadSenderAllowlist(p);
    expect(cfg.default.allow).toEqual([]);
  });

  it('loads allow=[list]', () => {
    const p = writeConfig({
      default: { allow: ['alice', 'bob'], mode: 'drop' },
      chats: {},
    });
    const cfg = loadSenderAllowlist(p);
    expect(cfg.default.allow).toEqual(['alice', 'bob']);
    expect(cfg.default.mode).toBe('drop');
  });

  it('per-chat override beats default', () => {
    const p = writeConfig({
      default: { allow: '*', mode: 'trigger' },
      chats: { 'group-a': { allow: ['alice'], mode: 'drop' } },
    });
    const cfg = loadSenderAllowlist(p);
    expect(cfg.chats['group-a'].allow).toEqual(['alice']);
    expect(cfg.chats['group-a'].mode).toBe('drop');
  });

  it('returns allow-all on invalid JSON', () => {
    const p = cfgPath();
    fs.writeFileSync(p, '{ not valid json }}}');
    const cfg = loadSenderAllowlist(p);
    expect(cfg.default.allow).toBe('*');
  });

  it('returns allow-all on invalid schema', () => {
    const p = writeConfig({ default: { oops: true } });
    const cfg = loadSenderAllowlist(p);
    expect(cfg.default.allow).toBe('*');
  });

  it('rejects non-string allow array items', () => {
    const p = writeConfig({
      default: { allow: [123, null, true], mode: 'trigger' },
      chats: {},
    });
    const cfg = loadSenderAllowlist(p);
    expect(cfg.default.allow).toBe('*'); // falls back to default
  });

  it('skips invalid per-chat entries', () => {
    const p = writeConfig({
      default: { allow: '*', mode: 'trigger' },
      chats: {
        good: { allow: ['alice'], mode: 'trigger' },
        bad: { allow: 123 },
      },
    });
    const cfg = loadSenderAllowlist(p);
    expect(cfg.chats['good']).toBeDefined();
    expect(cfg.chats['bad']).toBeUndefined();
  });
});

describe('isSenderAllowed', () => {
  it('allow=* allows any sender', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: '*', mode: 'trigger' },
      chats: {},
      logDenied: true,
    };
    expect(isSenderAllowed('g1', 'anyone', cfg)).toBe(true);
  });

  it('allow=[] denies any sender', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: [], mode: 'trigger' },
      chats: {},
      logDenied: true,
    };
    expect(isSenderAllowed('g1', 'anyone', cfg)).toBe(false);
  });

  it('allow=[list] allows exact match only', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: ['alice', 'bob'], mode: 'trigger' },
      chats: {},
      logDenied: true,
    };
    expect(isSenderAllowed('g1', 'alice', cfg)).toBe(true);
    expect(isSenderAllowed('g1', 'eve', cfg)).toBe(false);
  });

  it('uses per-chat entry over default', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: '*', mode: 'trigger' },
      chats: { g1: { allow: ['alice'], mode: 'trigger' } },
      logDenied: true,
    };
    expect(isSenderAllowed('g1', 'bob', cfg)).toBe(false);
    expect(isSenderAllowed('g2', 'bob', cfg)).toBe(true);
  });
});

describe('shouldDropMessage', () => {
  it('returns false for trigger mode', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: '*', mode: 'trigger' },
      chats: {},
      logDenied: true,
    };
    expect(shouldDropMessage('g1', cfg)).toBe(false);
  });

  it('returns true for drop mode', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: '*', mode: 'drop' },
      chats: {},
      logDenied: true,
    };
    expect(shouldDropMessage('g1', cfg)).toBe(true);
  });

  it('per-chat mode override', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: '*', mode: 'trigger' },
      chats: { g1: { allow: '*', mode: 'drop' } },
      logDenied: true,
    };
    expect(shouldDropMessage('g1', cfg)).toBe(true);
    expect(shouldDropMessage('g2', cfg)).toBe(false);
  });
});

describe('isTriggerAllowed', () => {
  it('allows trigger for allowed sender', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: ['alice'], mode: 'trigger' },
      chats: {},
      logDenied: false,
    };
    expect(isTriggerAllowed('g1', 'alice', cfg)).toBe(true);
  });

  it('denies trigger for disallowed sender', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: ['alice'], mode: 'trigger' },
      chats: {},
      logDenied: false,
    };
    expect(isTriggerAllowed('g1', 'eve', cfg)).toBe(false);
  });

  it('logs when logDenied is true', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: ['alice'], mode: 'trigger' },
      chats: {},
      logDenied: true,
    };
    isTriggerAllowed('g1', 'eve', cfg);
    // Logger.debug is called — we just verify no crash; logger is a real pino instance
  });
});

describe('filterMessagesForTelegramAllowlist', () => {
  afterEach(() => {
    delete process.env.TELEGRAM_VALID_USERS;
  });

  const cfgOpen: SenderAllowlistConfig = {
    default: { allow: '*', mode: 'trigger' },
    chats: {},
    logDenied: true,
  };

  const cfgList: SenderAllowlistConfig = {
    default: { allow: ['111', '222'], mode: 'trigger' },
    chats: {},
    logDenied: true,
  };

  it('leaves non-Telegram JIDs unchanged', () => {
    const msgs = [
      { sender: 'eve', content: 'x' },
      { sender: 'alice', content: 'y' },
    ];
    expect(
      filterMessagesForTelegramAllowlist('g1@g.us', msgs, cfgList),
    ).toEqual(msgs);
  });

  it('with TELEGRAM_VALID_USERS set, keeps listed senders', () => {
    process.env.TELEGRAM_VALID_USERS = '1,2';
    const msgs = [{ sender: '1' }, { sender: '2' }];
    expect(
      filterMessagesForTelegramAllowlist('tg:-100', msgs, cfgOpen),
    ).toEqual(msgs);
  });

  it('with TELEGRAM_VALID_USERS unset, denies all Telegram senders', () => {
    delete process.env.TELEGRAM_VALID_USERS;
    const msgs = [{ sender: '1' }, { sender: '2' }];
    expect(
      filterMessagesForTelegramAllowlist('tg:-100', msgs, cfgOpen),
    ).toEqual([]);
  });

  it('filters Telegram to TELEGRAM_VALID_USERS, ignores per-chat allow list', () => {
    // TELEGRAM_VALID_USERS is the gate; per-chat cfg is not consulted for tg:
    process.env.TELEGRAM_VALID_USERS = '111';
    const msgs = [
      { sender: '111', content: 'ok' },
      { sender: '999', content: 'no' },
    ];
    expect(
      filterMessagesForTelegramAllowlist('tg:-100', msgs, cfgList),
    ).toEqual([msgs[0]]);
  });

  it('keeps is_from_me and is_bot_message regardless of TELEGRAM_VALID_USERS', () => {
    delete process.env.TELEGRAM_VALID_USERS;
    const msgs = [
      { sender: '999', is_from_me: true },
      { sender: '888', is_bot_message: true },
      { sender: '777' },
    ];
    expect(
      filterMessagesForTelegramAllowlist('tg:-100', msgs, cfgList),
    ).toEqual([msgs[0], msgs[1]]);
  });
});

describe('TELEGRAM_VALID_USERS', () => {
  const cfgOpen: SenderAllowlistConfig = {
    default: { allow: '*', mode: 'trigger' },
    chats: {},
    logDenied: true,
  };

  const cfgDenyAll: SenderAllowlistConfig = {
    default: { allow: [], mode: 'trigger' },
    chats: {},
    logDenied: true,
  };

  afterEach(() => {
    delete process.env.TELEGRAM_VALID_USERS;
  });

  it('gates tg: senders when set (overrides allow *)', () => {
    process.env.TELEGRAM_VALID_USERS = '111, 222';
    expect(isSenderAllowed('tg:-1', '111', cfgOpen)).toBe(true);
    expect(isSenderAllowed('tg:-1', '999', cfgOpen)).toBe(false);
  });

  it('does not gate non-Telegram JIDs', () => {
    process.env.TELEGRAM_VALID_USERS = '111';
    expect(isSenderAllowed('g@g.us', 'anyone', cfgDenyAll)).toBe(false);
    expect(isSenderAllowed('g@g.us', 'anyone', cfgOpen)).toBe(true);
  });

  it('enables drop behavior for tg: while active', () => {
    process.env.TELEGRAM_VALID_USERS = '111';
    expect(shouldDropMessage('tg:-1', cfgOpen)).toBe(true);
    expect(shouldDropMessage('g@g.us', cfgOpen)).toBe(false);
  });

  it('filterMessages uses env list for Telegram', () => {
    process.env.TELEGRAM_VALID_USERS = '111';
    const msgs = [{ sender: '111' }, { sender: '999' }];
    expect(
      filterMessagesForTelegramAllowlist('tg:-100', msgs, cfgOpen),
    ).toEqual([msgs[0]]);
  });
});

describe('isTelegramGroupSupergroupJid / telegramGroupHasExplicitAllowlist', () => {
  let origAllow: string | undefined;
  let origUsers: string | undefined;

  beforeEach(() => {
    origAllow = process.env.TELEGRAM_ALLOW_GROUPS;
    origUsers = process.env.TELEGRAM_VALID_USERS;
  });

  afterEach(() => {
    if (origAllow === undefined) delete process.env.TELEGRAM_ALLOW_GROUPS;
    else process.env.TELEGRAM_ALLOW_GROUPS = origAllow;
    if (origUsers === undefined) delete process.env.TELEGRAM_VALID_USERS;
    else process.env.TELEGRAM_VALID_USERS = origUsers;
  });

  const cfgAll: SenderAllowlistConfig = {
    default: { allow: '*', mode: 'trigger' },
    chats: {},
    logDenied: true,
  };

  it('detects group/supergroup jids', () => {
    expect(isTelegramGroupSupergroupJid('tg:-100')).toBe(true);
    expect(isTelegramGroupSupergroupJid('tg:123')).toBe(false);
    expect(isTelegramGroupSupergroupJid('g@g.us')).toBe(false);
  });

  it('private tg jids always pass explicit-allowlist check', () => {
    process.env.TELEGRAM_ALLOW_GROUPS = '1';
    process.env.TELEGRAM_VALID_USERS = '';
    expect(telegramGroupHasExplicitAllowlist('tg:99', cfgAll)).toBe(true);
  });

  it('when groups disabled, supergroup jid passes without env list', () => {
    process.env.TELEGRAM_ALLOW_GROUPS = '';
    process.env.TELEGRAM_VALID_USERS = '';
    expect(telegramGroupHasExplicitAllowlist('tg:-100', cfgAll)).toBe(true);
  });

  it('when groups enabled, supergroup needs TELEGRAM_VALID_USERS or non-* allow', () => {
    process.env.TELEGRAM_ALLOW_GROUPS = '1';
    process.env.TELEGRAM_VALID_USERS = '';
    expect(telegramGroupHasExplicitAllowlist('tg:-100', cfgAll)).toBe(false);

    process.env.TELEGRAM_VALID_USERS = '1';
    expect(telegramGroupHasExplicitAllowlist('tg:-100', cfgAll)).toBe(true);

    process.env.TELEGRAM_VALID_USERS = '';
    const cfgPerChat: SenderAllowlistConfig = {
      default: { allow: '*', mode: 'trigger' },
      chats: { 'tg:-100': { allow: ['42'], mode: 'drop' } },
      logDenied: true,
    };
    expect(telegramGroupHasExplicitAllowlist('tg:-100', cfgPerChat)).toBe(true);
  });
});
