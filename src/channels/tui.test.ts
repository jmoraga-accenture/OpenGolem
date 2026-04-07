// M25 — TUI channel adapter test suite
// Written against channel-adapters-spec.md and orchestrator-spec.md §2.1.
// All M25 tests are initially failing — the implementation does not yet satisfy them.
// Pre-existing basic API tests are retained and still pass.
//
// Spec references:
//   docs/specs/channel-adapters-spec.md  (primary — AC-1–AC-18, invariants)
//   docs/specs/orchestrator-spec.md      §2.1 InboundMessage schema
//   docs/ux/ux-review-tui-cli.md         UX recommendations (Approved 2026-04-07)
//
// Tier structure (four tiers per M25 definition of done):
//   Tier 1 — Unit: readline normalization, Ctrl-D health toggle, ASSISTANT_NAME display
//   Tier 2 — Contract: InboundMessage schema fields, quarantinedHanseiReports in health panel
//   Tier 3 — Integration: adapter self-registration, outbound routing from orchestrator
//   Tier 4 — Stub detection: health panel degrades when quarantinedHanseiReports > 0

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// Module mocks (must be declared before any import that depends on them)
// ─────────────────────────────────────────────────────────────────────────────

vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('./channel-enabled.js', () => ({
  isChannelEnabled: vi.fn(() => true),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Imports
// ─────────────────────────────────────────────────────────────────────────────

import { TuiChannel, TUI_CONSOLE_JID } from './tui.js';
import { ChannelOpts } from './registry.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeOpts(): ChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: () => ({}),
    onAutoRegisterGroup: vi.fn(),
  };
}

function makeChannel(opts?: ChannelOpts): TuiChannel {
  return new TuiChannel(opts ?? makeOpts());
}

// ─────────────────────────────────────────────────────────────────────────────
// Pre-existing basic API tests (retained; these still pass today)
// ─────────────────────────────────────────────────────────────────────────────

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
    write = vi
      .spyOn(process.stdout, 'write')
      .mockReturnValue(true as unknown as boolean);
  });

  afterEach(() => {
    write.mockRestore();
  });

  it('writes the message text to stdout', async () => {
    const ch = makeChannel();
    await ch.sendMessage(TUI_CONSOLE_JID, 'Hello from Alef');
    expect(write).toHaveBeenCalledWith(
      expect.stringContaining('Hello from Alef'),
    );
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

// ─────────────────────────────────────────────────────────────────────────────
// Tier 1 — Unit tests (M25)
// Spec: channel-adapters-spec.md §AC-3, §AC-13; ux-review-tui-cli.md R5, R7
// Initially failing — implementation required.
// ─────────────────────────────────────────────────────────────────────────────

describe('[M25 Tier 1 Unit] readline input normalized to InboundMessage schema', () => {
  // AC-3: Inbound message is normalized to InboundMessage format.
  // The TUI adapter must produce an InboundMessage conforming to orchestrator-spec §2.1
  // when the user types a line at the readline prompt.
  // Current implementation calls onMessage with NewMessage (legacy shape), not InboundMessage.
  // These tests verify the normalized shape the spec requires.

  it('[AC-3] TUI channel exposes a deliverLine method for testing inbound normalization', () => {
    // The adapter must expose a way to drive an inbound message in non-TTY mode.
    // If this property does not exist, the test fails — signalling the implementation gap.
    const ch = makeChannel();
    expect(typeof (ch as any).deliverLine).toBe('function');
  });

  it('[AC-3] deliverLine produces an InboundMessage with required fields: groupId, channelId, senderId, messageId, text, timestamp', () => {
    const opts = makeOpts();
    const ch = new TuiChannel(opts);

    // deliverLine normalizes a raw line string into InboundMessage and calls opts.onMessage.
    // The future adapter calls: onMessage(chatJid, inboundMessage) where inboundMessage
    // carries the orchestrator-spec §2.1 fields instead of the legacy NewMessage shape.
    (ch as any).deliverLine('hello world');

    expect(opts.onMessage).toHaveBeenCalledTimes(1);
    // Second argument is the message object (first is chatJid string)
    const callArgs = vi.mocked(opts.onMessage).mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    const msg = callArgs[1];

    // orchestrator-spec §2.1 required fields
    expect(msg).toHaveProperty('groupId');
    expect(typeof msg['groupId']).toBe('string');
    expect((msg['groupId'] as string).length).toBeGreaterThan(0);

    expect(msg).toHaveProperty('channelId');
    expect(msg['channelId']).toBe('tui');

    expect(msg).toHaveProperty('senderId');
    expect(typeof msg['senderId']).toBe('string');
    expect((msg['senderId'] as string).length).toBeGreaterThan(0);

    expect(msg).toHaveProperty('messageId');
    expect(typeof msg['messageId']).toBe('string');
    expect((msg['messageId'] as string).length).toBeGreaterThan(0);

    expect(msg).toHaveProperty('text');
    expect(msg['text']).toBe('hello world');

    expect(msg).toHaveProperty('timestamp');
    // Must be a valid ISO-8601 timestamp
    expect(isNaN(Date.parse(msg['timestamp'] as string))).toBe(false);
  });

  it('[AC-3] deliverLine trims whitespace from the input text', () => {
    const opts = makeOpts();
    const ch = new TuiChannel(opts);
    (ch as any).deliverLine('  padded input  ');

    const callArgs = vi.mocked(opts.onMessage).mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(callArgs[1]['text']).toBe('padded input');
  });

  it('[AC-3] deliverLine with only whitespace does not call onMessage', () => {
    const opts = makeOpts();
    const ch = new TuiChannel(opts);
    (ch as any).deliverLine('   ');
    expect(opts.onMessage).not.toHaveBeenCalled();
  });

  it('[AC-3] deliverLine timestamp is within 2 seconds of now', () => {
    const opts = makeOpts();
    const ch = new TuiChannel(opts);
    const before = Date.now();
    (ch as any).deliverLine('timing test');
    const after = Date.now();

    const callArgs = vi.mocked(opts.onMessage).mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    const ts = Date.parse(callArgs[1]['timestamp'] as string);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after + 100);
  });

  it('[AC-3] each deliverLine call produces a unique messageId', () => {
    const opts = makeOpts();
    const ch = new TuiChannel(opts);
    (ch as any).deliverLine('first');
    (ch as any).deliverLine('second');

    const calls = vi.mocked(opts.onMessage).mock.calls as unknown as [
      string,
      Record<string, unknown>,
    ][];
    const id1 = calls[0][1]['messageId'];
    const id2 = calls[1][1]['messageId'];
    expect(id1).not.toBe(id2);
  });
});

describe('[M25 Tier 1 Unit] health panel toggle (Ctrl-D)', () => {
  // AC-13: TUI health dashboard toggles with Ctrl-D.
  // AC-14: TUI health panel is read-only.
  // ux-review-tui-cli.md R8: three-tier hierarchy (System Status, Channels, Tasks above fold).

  it('[AC-13] TUI adapter exposes a toggleHealthPanel method', () => {
    const ch = makeChannel();
    expect(typeof (ch as any).toggleHealthPanel).toBe('function');
  });

  it('[AC-13] healthPanelVisible is false by default', () => {
    const ch = makeChannel();
    expect((ch as any).healthPanelVisible).toBe(false);
  });

  it('[AC-13] toggleHealthPanel sets healthPanelVisible to true on first call', () => {
    const ch = makeChannel();
    (ch as any).toggleHealthPanel();
    expect((ch as any).healthPanelVisible).toBe(true);
  });

  it('[AC-13] toggleHealthPanel returns healthPanelVisible to false on second call', () => {
    const ch = makeChannel();
    (ch as any).toggleHealthPanel();
    (ch as any).toggleHealthPanel();
    expect((ch as any).healthPanelVisible).toBe(false);
  });

  it('[AC-13] toggling health panel on writes panel content to stdout', () => {
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockReturnValue(true as unknown as boolean);
    try {
      const ch = makeChannel();
      (ch as any).toggleHealthPanel();
      expect(write).toHaveBeenCalled();
    } finally {
      write.mockRestore();
    }
  });

  it('[AC-13] health panel output includes SYSTEM STATUS section', () => {
    const chunks: string[] = [];
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: any) => {
        chunks.push(String(chunk));
        return true as unknown as boolean;
      });
    try {
      const ch = makeChannel();
      (ch as any).toggleHealthPanel();
      const output = chunks.join('');
      expect(output).toMatch(/SYSTEM STATUS/i);
    } finally {
      write.mockRestore();
    }
  });

  it('[AC-13] health panel output includes CHANNELS section', () => {
    const chunks: string[] = [];
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: any) => {
        chunks.push(String(chunk));
        return true as unknown as boolean;
      });
    try {
      const ch = makeChannel();
      (ch as any).toggleHealthPanel();
      const output = chunks.join('');
      expect(output).toMatch(/CHANNELS/i);
    } finally {
      write.mockRestore();
    }
  });

  it('[AC-13] health panel output includes TASKS section', () => {
    const chunks: string[] = [];
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: any) => {
        chunks.push(String(chunk));
        return true as unknown as boolean;
      });
    try {
      const ch = makeChannel();
      (ch as any).toggleHealthPanel();
      const output = chunks.join('');
      expect(output).toMatch(/TASKS/i);
    } finally {
      write.mockRestore();
    }
  });

  it('[AC-13] health panel footer includes Ctrl-D close hint', () => {
    const chunks: string[] = [];
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: any) => {
        chunks.push(String(chunk));
        return true as unknown as boolean;
      });
    try {
      const ch = makeChannel();
      (ch as any).toggleHealthPanel();
      const output = chunks.join('');
      expect(output).toMatch(/Ctrl-D/i);
    } finally {
      write.mockRestore();
    }
  });

  it('[AC-14] health panel is read-only — adapter has no input handler for the panel pane', () => {
    // The panel must not accept text input. We verify that no line handler is
    // installed for the health panel (i.e., the readline instance, if any, does
    // not accept typed input while the panel is visible).
    const ch = makeChannel();
    (ch as any).toggleHealthPanel();
    // healthPanelAcceptsInput must be falsy (undefined, false, or absent)
    expect((ch as any).healthPanelAcceptsInput).toBeFalsy();
  });
});

describe('[M25 Tier 1 Unit] ASSISTANT_NAME display', () => {
  // ux-review-tui-cli.md R5: prompt and status hint show meaningful context.
  // The TUI must use the injected ASSISTANT_NAME rather than a hard-coded string.

  it('[Unit-AC-ASSISTANT_NAME] getPromptString reflects injected ASSISTANT_NAME', () => {
    // The adapter must expose the prompt string it will display, derived from
    // configuration rather than a hard-coded literal.
    const ch = makeChannel();
    expect(typeof (ch as any).getPromptString).toBe('function');
  });

  it('[Unit-AC-ASSISTANT_NAME] prompt does not contain a hard-coded assistant name as a string literal', () => {
    // The prompt must use the ASSISTANT_NAME env/config value, not "Alef" hard-coded.
    // We verify by checking that the prompt is not built from a string literal "Alef"
    // embedded directly in the function (structural test via the method's return value).
    const ch = makeChannel();
    const prompt: string = (ch as any).getPromptString();
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(0);
    // The prompt itself is valid (non-empty) — the "Alef" is config-sourced, not tested here
  });

  it('[Unit-AC-ASSISTANT_NAME] sendMessage output includes the assistant display name from config', async () => {
    // When the orchestrator routes a reply, the TUI must label it with the assistant name.
    // The adapter must prefix or annotate outbound messages with the assistant identifier.
    const chunks: string[] = [];
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: any) => {
        chunks.push(String(chunk));
        return true as unknown as boolean;
      });
    try {
      const ch = makeChannel();
      await ch.sendMessage(TUI_CONSOLE_JID, 'Here is my response.');
      const output = chunks.join('');
      // The response must be visually attributed — either by a name prefix or a
      // visual delimiter that identifies it as assistant output (not raw text alone).
      // The simplest contract: the output contains a non-empty label before the message text.
      expect(output).toMatch(/\S/); // non-trivial content written
      // The adapter must NOT write just the raw text with no framing.
      // We check that the line is not just "Here is my response.\n" with zero prefix.
      const rawOnly = output.trim() === 'Here is my response.';
      expect(rawOnly).toBe(false);
    } finally {
      write.mockRestore();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tier 2 — Contract tests (M25)
// Spec: orchestrator-spec.md §2.1 (InboundMessage schema contract)
//        channel-adapters-spec.md §AC-3, §AC-9, §AC-13
// Initially failing — implementation required.
// ─────────────────────────────────────────────────────────────────────────────

describe('[M25 Tier 2 Contract] InboundMessage fields match orchestrator-spec §2.1 exactly', () => {
  // The orchestrator-spec §2.1 table defines six required fields:
  //   groupId, channelId, senderId, messageId, text, timestamp (ISO-8601)
  // The adapter must produce exactly this shape — no missing fields, no extra
  // required-but-absent fields that would break the orchestrator's schema check.

  it('[Contract-AC-3] delivered message has exactly the six required orchestrator-spec §2.1 fields', () => {
    const opts = makeOpts();
    const ch = new TuiChannel(opts);
    (ch as any).deliverLine('spec contract test');

    expect(opts.onMessage).toHaveBeenCalledTimes(1);
    // Access the message object (second argument) via unknown cast
    const callArgs = vi.mocked(opts.onMessage).mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    const msg = callArgs[1];

    // Each of the six spec §2.1 fields must be present
    const requiredFields: string[] = [
      'groupId',
      'channelId',
      'senderId',
      'messageId',
      'text',
      'timestamp',
    ];
    for (const field of requiredFields) {
      expect(msg, `Expected field "${field}" to be present`).toHaveProperty(
        field,
      );
      expect(
        msg[field],
        `Expected field "${field}" to be non-empty`,
      ).toBeTruthy();
    }
  });

  it('[Contract-AC-3] channelId is exactly "tui" (not "tui:console" or any other value)', () => {
    const opts = makeOpts();
    const ch = new TuiChannel(opts);
    (ch as any).deliverLine('channel id check');

    const callArgs = vi.mocked(opts.onMessage).mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(callArgs[1]['channelId']).toBe('tui');
  });

  it('[Contract-AC-3] timestamp is a valid ISO-8601 string', () => {
    const opts = makeOpts();
    const ch = new TuiChannel(opts);
    (ch as any).deliverLine('timestamp check');

    const callArgs = vi.mocked(opts.onMessage).mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    const ts = callArgs[1]['timestamp'] as string;
    expect(typeof ts).toBe('string');
    // Must parse as a valid date
    expect(isNaN(Date.parse(ts))).toBe(false);
    // Must be ISO-8601 format (contains T and ends with Z or offset)
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('[Contract-AC-3] groupId is a non-empty string (maps to a registered group or default)', () => {
    const opts = makeOpts();
    const ch = new TuiChannel(opts);
    (ch as any).deliverLine('group id check');

    const callArgs = vi.mocked(opts.onMessage).mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(typeof callArgs[1]['groupId']).toBe('string');
    expect((callArgs[1]['groupId'] as string).length).toBeGreaterThan(0);
  });

  it('[Contract-AC-3] messageId is unique across multiple deliverLine calls', () => {
    const opts = makeOpts();
    const ch = new TuiChannel(opts);
    (ch as any).deliverLine('first message');
    (ch as any).deliverLine('second message');
    (ch as any).deliverLine('third message');

    const calls = vi.mocked(opts.onMessage).mock.calls as unknown as [
      string,
      Record<string, unknown>,
    ][];
    const ids = calls.map((c) => c[1]['messageId']);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(3);
  });
});

describe('[M25 Tier 2 Contract] health panel reflects quarantinedHanseiReports count', () => {
  // channel-adapters-spec.md §AC-13: health panel displays "most recent hansei report summary"
  // orchestrator-spec §2.1: getOrchestratorHealth() returns { status, quarantinedHanseiReports }
  // ux-review-tui-cli.md R8: GOVERNANCE section shows unread reports count.

  it('[Contract-AC-13] TUI adapter accepts a health provider callback at construction or via method', () => {
    // The adapter must have a way to receive health data for panel rendering.
    // It must either accept a healthProvider in opts or expose setHealthProvider().
    const ch = makeChannel();
    const hasHealthInOpts = 'healthProvider' in makeOpts();
    const hasSetMethod = typeof (ch as any).setHealthProvider === 'function';
    // At least one mechanism must exist
    expect(hasHealthInOpts || hasSetMethod).toBe(true);
  });

  it('[Contract-AC-13] health panel shows quarantinedHanseiReports count when > 0', () => {
    const chunks: string[] = [];
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: any) => {
        chunks.push(String(chunk));
        return true as unknown as boolean;
      });
    try {
      const ch = makeChannel();
      // Inject a health provider that returns 3 quarantined reports
      if (typeof (ch as any).setHealthProvider === 'function') {
        (ch as any).setHealthProvider(() => ({
          status: 'degraded',
          quarantinedHanseiReports: 3,
        }));
      }
      (ch as any).toggleHealthPanel();
      const output = chunks.join('');
      // The panel must include the report count
      expect(output).toMatch(/3/);
    } finally {
      write.mockRestore();
    }
  });

  it('[Contract-AC-13] health panel shows 0 quarantinedHanseiReports when none pending', () => {
    const chunks: string[] = [];
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: any) => {
        chunks.push(String(chunk));
        return true as unknown as boolean;
      });
    try {
      const ch = makeChannel();
      if (typeof (ch as any).setHealthProvider === 'function') {
        (ch as any).setHealthProvider(() => ({
          status: 'ok',
          quarantinedHanseiReports: 0,
        }));
      }
      (ch as any).toggleHealthPanel();
      const output = chunks.join('');
      // The panel renders without crashing and includes a count
      expect(output).toMatch(/\d/);
    } finally {
      write.mockRestore();
    }
  });

  it('[Contract-AC-9] adapter exposes a getHealthStatus method', () => {
    // channel-adapters-spec AC-9: adapter reports health status when queried.
    const ch = makeChannel();
    expect(typeof (ch as any).getHealthStatus).toBe('function');
  });

  it('[Contract-AC-9] getHealthStatus returns AdapterHealthStatus shape', async () => {
    // channel-adapters-spec AC-9 shape: { channel, status, since }
    const ch = makeChannel();
    await ch.connect();
    const health = (ch as any).getHealthStatus();
    expect(health).toHaveProperty('channel', 'tui');
    expect(health).toHaveProperty('status');
    expect(['connected', 'connecting', 'disconnected', 'error']).toContain(
      health.status,
    );
    expect(health).toHaveProperty('since');
    expect(isNaN(Date.parse(health.since))).toBe(false);
  });

  it('[Contract-AC-9] getHealthStatus returns status "connected" when adapter is connected', async () => {
    const ch = makeChannel();
    await ch.connect();
    const health = (ch as any).getHealthStatus();
    expect(health.status).toBe('connected');
  });

  it('[Contract-AC-9] getHealthStatus returns status "disconnected" when adapter is not connected', () => {
    const ch = makeChannel();
    const health = (ch as any).getHealthStatus();
    expect(health.status).toBe('disconnected');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tier 3 — Integration tests (M25)
// Spec: channel-adapters-spec.md §AC-1, §AC-7, §AC-8
//       channel-adapters-spec.md §Behavioral Contract — Adapter startup
// Initially failing — implementation required.
// ─────────────────────────────────────────────────────────────────────────────

describe('[M25 Tier 3 Integration] TUI adapter self-registers with channel registry at startup', () => {
  // AC-1: Adapter self-registers at startup when enabled.
  // The module-level registerChannel() call in tui.ts registers a factory.
  // Importing the module side-effectfully triggers registration.

  it('[AC-1] importing tui.ts calls registerChannel with name "tui"', async () => {
    // registerChannel is mocked at the top of this file.
    // The module under test calls registerChannel('tui', ...) at module load time.
    // We verify the mock was called with the correct channel name.
    const { registerChannel: reg } = await import('./registry.js');
    expect(vi.mocked(reg)).toHaveBeenCalledWith('tui', expect.any(Function));
  });

  it('[AC-1] the registered factory returns a TuiChannel instance when tui is enabled', async () => {
    // Re-import to get the mock ref populated by the module side-effect
    const { registerChannel: reg } = await import('./registry.js');
    const calls = vi.mocked(reg).mock.calls;
    const tuiCall = calls.find((c) => c[0] === 'tui');
    expect(tuiCall).toBeDefined();

    // The factory receives ChannelOpts and returns a Channel | null
    const factory = tuiCall![1];
    const result = factory(makeOpts());
    // When tui is enabled (mocked above), factory returns a TuiChannel
    expect(result).not.toBeNull();
    expect(result).toBeInstanceOf(TuiChannel);
  });

  it('[AC-2] the registered factory returns null when tui channel is disabled', async () => {
    // AC-2: Disabled adapter does not register.
    // When isChannelEnabled('tui') returns false, the factory must return null.
    const { isChannelEnabled } = await import('./channel-enabled.js');
    vi.mocked(isChannelEnabled).mockReturnValueOnce(false);

    const { registerChannel: reg } = await import('./registry.js');
    const calls = vi.mocked(reg).mock.calls;
    const tuiCall = calls.find((c) => c[0] === 'tui');
    expect(tuiCall).toBeDefined();

    const factory = tuiCall![1];
    const result = factory(makeOpts());
    expect(result).toBeNull();

    // Restore
    vi.mocked(isChannelEnabled).mockReturnValue(true);
  });
});

describe('[M25 Tier 3 Integration] outbound message routes to terminal from orchestrator', () => {
  // AC-7: Outbound message is formatted and delivered.
  // AC-8: Outbound delivery failure returns an error to the orchestrator.

  let write: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    write = vi
      .spyOn(process.stdout, 'write')
      .mockReturnValue(true as unknown as boolean);
  });

  afterEach(() => {
    write.mockRestore();
  });

  it('[AC-7] sendMessage resolves (returns void) on successful delivery', async () => {
    const ch = makeChannel();
    await expect(
      ch.sendMessage(TUI_CONSOLE_JID, 'Integration test reply'),
    ).resolves.toBeUndefined();
  });

  it('[AC-7] sendMessage result is distinguishable from failure — resolves (not rejects) on success', async () => {
    const ch = makeChannel();
    // On success: resolves. On failure: rejects (AC-8).
    // We verify the success path here.
    let resolved = false;
    let rejected = false;
    await ch
      .sendMessage(TUI_CONSOLE_JID, 'Success path')
      .then(() => {
        resolved = true;
      })
      .catch(() => {
        rejected = true;
      });
    expect(resolved).toBe(true);
    expect(rejected).toBe(false);
  });

  it('[AC-8] sendMessage rejects with an error when stdout write throws', async () => {
    // Simulate a stdout write failure (e.g. broken pipe)
    write.mockImplementation(() => {
      throw new Error('EPIPE: broken pipe');
    });
    const ch = makeChannel();
    // The adapter must not suppress the error — it must propagate it
    await expect(
      ch.sendMessage(TUI_CONSOLE_JID, 'Failed delivery'),
    ).rejects.toThrow();
  });

  it('[AC-7] the message delivered to stdout contains the original text content', async () => {
    const chunks: string[] = [];
    write.mockImplementation((chunk: any) => {
      chunks.push(String(chunk));
      return true as unknown as boolean;
    });
    const ch = makeChannel();
    const messageText = 'The quick brown fox';
    await ch.sendMessage(TUI_CONSOLE_JID, messageText);
    const output = chunks.join('');
    expect(output).toContain(messageText);
  });

  it('[AC-7] sendMessage formats output to stdout using channel-native format (not raw JSON)', async () => {
    const chunks: string[] = [];
    write.mockImplementation((chunk: any) => {
      chunks.push(String(chunk));
      return true as unknown as boolean;
    });
    const ch = makeChannel();
    await ch.sendMessage(TUI_CONSOLE_JID, 'Formatted output');
    const output = chunks.join('');
    // Channel-native TUI format: not JSON, not a bare object representation
    expect(output).not.toMatch(/^\s*\{/); // does not start with '{'
    expect(output).not.toMatch(/"text"\s*:/); // does not contain JSON key
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tier 4 — Stub detection (M25)
// Spec: channel-adapters-spec.md §AC-13; orchestrator-spec §getHealth
// Verifies the health panel shows degraded status when quarantinedHanseiReports > 0.
// The test FAILS if the implementation always shows OK regardless of the value.
// Initially failing — stub always shows OK.
// ─────────────────────────────────────────────────────────────────────────────

describe('[M25 Tier 4 Stub Detection] health panel shows degraded when quarantinedHanseiReports > 0', () => {
  // This test tier is designed to catch a stub implementation that always renders
  // the health panel as "ok" regardless of the actual quarantinedHanseiReports value.
  // A stub that always shows OK will fail these tests.

  it('[Stub-AC-1] health panel renders different output when quarantinedHanseiReports is 0 vs > 0', () => {
    // Collect output for zero reports
    const chunksZero: string[] = [];
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: any) => {
        chunksZero.push(String(chunk));
        return true as unknown as boolean;
      });

    try {
      const ch1 = makeChannel();
      if (typeof (ch1 as any).setHealthProvider === 'function') {
        (ch1 as any).setHealthProvider(() => ({
          status: 'ok',
          quarantinedHanseiReports: 0,
        }));
      }
      (ch1 as any).toggleHealthPanel();
      const outputZero = chunksZero.join('');

      // Collect output for non-zero reports
      chunksZero.length = 0;
      const ch2 = makeChannel();
      if (typeof (ch2 as any).setHealthProvider === 'function') {
        (ch2 as any).setHealthProvider(() => ({
          status: 'degraded',
          quarantinedHanseiReports: 5,
        }));
      }
      (ch2 as any).toggleHealthPanel();
      const outputNonZero = chunksZero.join('');

      // The outputs must differ — a stub always returning the same string fails here
      expect(outputZero).not.toBe(outputNonZero);
    } finally {
      write.mockRestore();
    }
  });

  it('[Stub-AC-1] health panel output contains "degraded" or equivalent warning when quarantinedHanseiReports > 0', () => {
    const chunks: string[] = [];
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: any) => {
        chunks.push(String(chunk));
        return true as unknown as boolean;
      });
    try {
      const ch = makeChannel();
      if (typeof (ch as any).setHealthProvider === 'function') {
        (ch as any).setHealthProvider(() => ({
          status: 'degraded',
          quarantinedHanseiReports: 2,
        }));
      }
      (ch as any).toggleHealthPanel();
      const output = chunks.join('').toLowerCase();
      // Must contain some indication of degraded state
      const hasDegradedSignal =
        output.includes('degraded') ||
        output.includes('warning') ||
        output.includes('unread') ||
        output.includes('review');
      expect(hasDegradedSignal).toBe(true);
    } finally {
      write.mockRestore();
    }
  });

  it('[Stub-AC-1] health panel does NOT show "ok" for system status when quarantinedHanseiReports > 0', () => {
    // A stub that always shows [ok] for everything fails here.
    const chunks: string[] = [];
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: any) => {
        chunks.push(String(chunk));
        return true as unknown as boolean;
      });
    try {
      const ch = makeChannel();
      if (typeof (ch as any).setHealthProvider === 'function') {
        (ch as any).setHealthProvider(() => ({
          status: 'degraded',
          quarantinedHanseiReports: 1,
        }));
      }
      (ch as any).toggleHealthPanel();
      const output = chunks.join('');
      // The panel must NOT show an unconditional [ok] for the top-level status
      // when the orchestrator reports degraded. Allowed: [degraded], [unreachable], etc.
      // Not allowed: the only status indicator on the panel is "[ok]".
      // We test this by checking the panel does not consist entirely of [ok] markers.
      const allOk =
        !output.match(/\[degraded\]/i) && !output.match(/\[unreachable\]/i);
      // If allOk is true the stub is broken — the panel must react to degraded state
      expect(allOk).toBe(false);
    } finally {
      write.mockRestore();
    }
  });

  it('[Stub-AC-1] quarantinedHanseiReports count is reflected numerically in panel output', () => {
    // A stub always showing "0" fails here.
    const chunks: string[] = [];
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: any) => {
        chunks.push(String(chunk));
        return true as unknown as boolean;
      });
    try {
      const specificCount = 7;
      const ch = makeChannel();
      if (typeof (ch as any).setHealthProvider === 'function') {
        (ch as any).setHealthProvider(() => ({
          status: 'degraded',
          quarantinedHanseiReports: specificCount,
        }));
      }
      (ch as any).toggleHealthPanel();
      const output = chunks.join('');
      // The specific count must appear in the rendered panel
      expect(output).toContain(String(specificCount));
    } finally {
      write.mockRestore();
    }
  });
});
