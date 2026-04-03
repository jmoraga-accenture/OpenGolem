import { describe, it, expect, vi } from 'vitest';

import { TuiChannel, TUI_CONSOLE_JID } from './tui.js';

describe('TuiChannel', () => {
  it('owns tui: JIDs', () => {
    const ch = new TuiChannel({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    });
    expect(ch.ownsJid(TUI_CONSOLE_JID)).toBe(true);
    expect(ch.ownsJid('tui:other')).toBe(true);
    expect(ch.ownsJid('tg:123')).toBe(false);
  });
});
