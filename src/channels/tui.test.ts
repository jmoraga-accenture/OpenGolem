import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { TuiChannel, TUI_CONSOLE_JID } from './tui.js';
import { ChannelOpts } from './registry.js';

function makeOpts(): ChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: () => ({}),
  };
}

function makeChannel(opts?: ChannelOpts): TuiChannel {
  return new TuiChannel(opts ?? makeOpts());
}

describe('TuiChannel — ownsJid', () => {
  it('owns tui:console', () => {
    expect(makeChannel().ownsJid(TUI_CONSOLE_JID)).toBe(true);
  });

  it('owns any tui: prefixed JID', () => {
    expect(makeChannel().ownsJid('tui:other')).toBe(true);
    expect(makeChannel().ownsJid('tui:')).toBe(true);
  });

  it('does not own non-tui JIDs', () => {
    const ch = makeChannel();
    expect(ch.ownsJid('tg:123')).toBe(false);
    expect(ch.ownsJid('12345@telegram')).toBe(false);
    expect(ch.ownsJid('')).toBe(false);
  });
});

describe('TuiChannel — name', () => {
  it('is "tui"', () => {
    expect(makeChannel().name).toBe('tui');
  });
});

describe('TuiChannel — isConnected', () => {
  it('returns false before connect', () => {
    expect(makeChannel().isConnected()).toBe(false);
  });

  it('returns true after connect in non-TTY environment', async () => {
    const ch = makeChannel();
    await ch.connect(); // non-TTY path in test runner
    expect(ch.isConnected()).toBe(true);
  });

  it('returns false after disconnect', async () => {
    const ch = makeChannel();
    await ch.connect();
    await ch.disconnect();
    expect(ch.isConnected()).toBe(false);
  });
});

describe('TuiChannel — connect / disconnect lifecycle', () => {
  it('connect is idempotent in non-TTY (no readline)', async () => {
    const ch = makeChannel();
    await ch.connect();
    await ch.connect(); // second call should not throw
    expect(ch.isConnected()).toBe(true);
  });

  it('disconnect when not connected does not throw', async () => {
    const ch = makeChannel();
    await expect(ch.disconnect()).resolves.toBeUndefined();
  });

  it('disconnect after connect marks as disconnected', async () => {
    const ch = makeChannel();
    await ch.connect();
    expect(ch.isConnected()).toBe(true);
    await ch.disconnect();
    expect(ch.isConnected()).toBe(false);
  });
});

describe('TuiChannel — sendMessage', () => {
  let write: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    write = vi.spyOn(process.stdout, 'write').mockReturnValue(true as unknown as boolean);
  });

  afterEach(() => {
    write.mockRestore();
  });

  it('writes the message text to stdout', async () => {
    const ch = makeChannel();
    await ch.sendMessage(TUI_CONSOLE_JID, 'Hello from Alef');
    expect(write).toHaveBeenCalledWith(expect.stringContaining('Hello from Alef'));
  });

  it('is a no-op for JIDs it does not own', async () => {
    const ch = makeChannel();
    await ch.sendMessage('telegram:123', 'Should not appear');
    expect(write).not.toHaveBeenCalled();
  });

  it('works for any tui: JID', async () => {
    const ch = makeChannel();
    await ch.sendMessage('tui:secondary', 'A message');
    expect(write).toHaveBeenCalledWith(expect.stringContaining('A message'));
  });
});

describe('TuiChannel — onMessage callback (non-TTY)', () => {
  it('is not triggered automatically (no stdin in test runner)', async () => {
    const opts = makeOpts();
    const ch = makeChannel(opts);
    await ch.connect();
    // In non-TTY mode no readline is created, so onMessage is never called passively
    expect(vi.mocked(opts.onMessage)).not.toHaveBeenCalled();
  });
});
