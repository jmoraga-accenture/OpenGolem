import { describe, it, expect, vi } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('./timezone.js', () => ({
  formatLocalTime: (_ts: string, _tz: string) => '2026-01-01 12:00 PM',
}));

import {
  escapeXml,
  formatMessages,
  stripInternalTags,
  formatOutbound,
  findChannel,
} from './router.js';
import type { NewMessage, Channel } from './types.js';

// --- escapeXml ---

describe('escapeXml', () => {
  it('escapes ampersand', () => {
    expect(escapeXml('a & b')).toBe('a &amp; b');
  });

  it('escapes less-than', () => {
    expect(escapeXml('1 < 2')).toBe('1 &lt; 2');
  });

  it('escapes greater-than', () => {
    expect(escapeXml('1 > 2')).toBe('1 &gt; 2');
  });

  it('escapes double-quote', () => {
    expect(escapeXml('"hello"')).toBe('&quot;hello&quot;');
  });

  it('returns empty string for empty input', () => {
    expect(escapeXml('')).toBe('');
  });

  it('handles all special chars in one string', () => {
    expect(escapeXml('a & <b> "c"')).toBe('a &amp; &lt;b&gt; &quot;c&quot;');
  });
});

// --- formatMessages ---

function makeMessage(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    id: 'msg-1',
    chat_jid: 'group@test',
    sender: 'user1',
    sender_name: 'Alice',
    content: 'Hello world',
    timestamp: '2026-01-01T12:00:00Z',
    ...overrides,
  };
}

describe('formatMessages', () => {
  it('includes context header with timezone', () => {
    const result = formatMessages([makeMessage()], 'America/New_York');
    expect(result).toContain('<context timezone="America/New_York" />');
  });

  it('wraps messages in <messages> block', () => {
    const result = formatMessages([makeMessage()], 'UTC');
    expect(result).toContain('<messages>');
    expect(result).toContain('</messages>');
  });

  it('includes sender and time attributes', () => {
    const result = formatMessages([makeMessage({ sender_name: 'Bob' })], 'UTC');
    expect(result).toContain('sender="Bob"');
    expect(result).toContain('time=');
  });

  it('escapes special chars in sender_name', () => {
    const result = formatMessages(
      [makeMessage({ sender_name: 'A & B' })],
      'UTC',
    );
    expect(result).toContain('sender="A &amp; B"');
  });

  it('escapes message content', () => {
    const result = formatMessages(
      [makeMessage({ content: '<script>' })],
      'UTC',
    );
    expect(result).toContain('&lt;script&gt;');
  });

  it('does not include reply_to attribute when no reply', () => {
    const result = formatMessages([makeMessage()], 'UTC');
    expect(result).not.toContain('reply_to=');
  });

  it('includes reply_to attribute when reply_to_message_id present', () => {
    const result = formatMessages(
      [makeMessage({ reply_to_message_id: 'msg-999' })],
      'UTC',
    );
    expect(result).toContain('reply_to="msg-999"');
  });

  it('does not include quoted_message when reply content is absent', () => {
    const result = formatMessages(
      [makeMessage({ reply_to_message_id: 'msg-999' })],
      'UTC',
    );
    expect(result).not.toContain('<quoted_message');
  });

  it('includes quoted_message when reply content and sender name are present', () => {
    const result = formatMessages(
      [
        makeMessage({
          reply_to_message_id: 'msg-999',
          reply_to_message_content: 'original text',
          reply_to_sender_name: 'Carol',
        }),
      ],
      'UTC',
    );
    expect(result).toContain(
      '<quoted_message from="Carol">original text</quoted_message>',
    );
  });

  it('escapes quoted_message sender name and content', () => {
    const result = formatMessages(
      [
        makeMessage({
          reply_to_message_id: 'msg-999',
          reply_to_message_content: '<b>bold</b>',
          reply_to_sender_name: '"Dave"',
        }),
      ],
      'UTC',
    );
    expect(result).toContain('from="&quot;Dave&quot;"');
    expect(result).toContain('&lt;b&gt;bold&lt;/b&gt;');
  });

  it('renders multiple messages in order', () => {
    const msgs = [
      makeMessage({ id: '1', sender_name: 'Alpha', content: 'first' }),
      makeMessage({ id: '2', sender_name: 'Beta', content: 'second' }),
    ];
    const result = formatMessages(msgs, 'UTC');
    const alphaPos = result.indexOf('sender="Alpha"');
    const betaPos = result.indexOf('sender="Beta"');
    expect(alphaPos).toBeLessThan(betaPos);
  });
});

// --- stripInternalTags ---

describe('stripInternalTags', () => {
  it('removes a simple internal block', () => {
    expect(stripInternalTags('hello <internal>secret</internal> world')).toBe(
      'hello  world',
    );
  });

  it('removes multiline internal block', () => {
    const input = 'before\n<internal>\nline1\nline2\n</internal>\nafter';
    const result = stripInternalTags(input);
    expect(result).not.toContain('<internal>');
    expect(result).toContain('before');
    expect(result).toContain('after');
  });

  it('trims whitespace after removal leaving empty string', () => {
    expect(stripInternalTags('  <internal>x</internal>  ')).toBe('');
  });

  it('removes multiple internal blocks', () => {
    const result = stripInternalTags(
      '<internal>a</internal> visible <internal>b</internal>',
    );
    expect(result).toBe('visible');
  });

  it('returns original trimmed text when no internal tags', () => {
    expect(stripInternalTags('no tags here')).toBe('no tags here');
  });
});

// --- formatOutbound ---

describe('formatOutbound', () => {
  it('strips internal tags from text', () => {
    const result = formatOutbound('hi <internal>hidden</internal> there');
    expect(result).not.toContain('<internal>');
    expect(result).toContain('hi');
    expect(result).toContain('there');
  });

  it('returns empty string when result is empty after stripping', () => {
    expect(formatOutbound('<internal>all hidden</internal>')).toBe('');
  });

  it('returns empty string for empty input', () => {
    expect(formatOutbound('')).toBe('');
  });

  it('returns text unchanged when no internal tags', () => {
    expect(formatOutbound('clean text')).toBe('clean text');
  });
});

// --- findChannel ---

describe('findChannel', () => {
  function makeChannel(ownsResult: boolean): Channel {
    return {
      name: 'test',
      connect: vi.fn(),
      sendMessage: vi.fn(),
      isConnected: vi.fn(() => true),
      ownsJid: vi.fn(() => ownsResult),
      disconnect: vi.fn(),
    };
  }

  it('returns the channel whose ownsJid returns true', () => {
    const ch1 = makeChannel(false);
    const ch2 = makeChannel(true);
    expect(findChannel([ch1, ch2], 'some-jid')).toBe(ch2);
  });

  it('returns undefined when no channel owns the jid', () => {
    const ch1 = makeChannel(false);
    const ch2 = makeChannel(false);
    expect(findChannel([ch1, ch2], 'unknown-jid')).toBeUndefined();
  });

  it('calls ownsJid with the provided jid', () => {
    const ch = makeChannel(true);
    findChannel([ch], 'my-jid');
    expect(ch.ownsJid).toHaveBeenCalledWith('my-jid');
  });

  it('returns undefined for empty channel list', () => {
    expect(findChannel([], 'jid')).toBeUndefined();
  });
});
