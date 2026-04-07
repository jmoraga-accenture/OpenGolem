import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

// Mock registry (registerChannel runs at import time)
vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));

// Mock env reader (used by the factory, not needed in unit tests)
vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));

// Mock config
const telegramConfigMock = vi.hoisted(() => ({ allowGroups: false }));

vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Alef',
  TRIGGER_PATTERN: /^@Alef\b/i,
  isTelegramAllowGroupsEnabled: () => telegramConfigMock.allowGroups,
}));

// Mock logger
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock group-folder (used by downloadFile)
vi.mock('../group-folder.js', () => ({
  resolveGroupFolderPath: vi.fn(
    (folder: string) => `/tmp/test-groups/${folder}`,
  ),
}));

// --- Grammy mock ---

type Handler = (...args: any[]) => any;

const botRef = vi.hoisted(() => ({ current: null as any }));

vi.mock('grammy', () => ({
  Bot: class MockBot {
    token: string;
    commandHandlers = new Map<string, Handler>();
    filterHandlers = new Map<string, Handler[]>();
    errorHandler: Handler | null = null;

    api = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      getFile: vi.fn().mockResolvedValue({ file_path: 'photos/file_0.jpg' }),
    };

    constructor(token: string) {
      this.token = token;
      botRef.current = this;
    }

    command(name: string, handler: Handler) {
      this.commandHandlers.set(name, handler);
    }

    on(filter: string, handler: Handler) {
      const existing = this.filterHandlers.get(filter) || [];
      existing.push(handler);
      this.filterHandlers.set(filter, existing);
    }

    catch(handler: Handler) {
      this.errorHandler = handler;
    }

    start(opts: { onStart: (botInfo: any) => void }) {
      opts.onStart({ username: 'andy_ai_bot', id: 12345 });
    }

    stop() {}
  },
}));

import fs from 'fs';
import path from 'path';
import {
  isTelegramPrivateChatId,
  shouldPrependAssistantTriggerForBotMention,
  TelegramChannel,
  TelegramChannelOpts,
} from './telegram.js';
import { logger } from '../logger.js';

// --- Test helpers ---

function createTestOpts(
  overrides?: Partial<TelegramChannelOpts>,
): TelegramChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'tg:100200300': {
        name: 'Test Group',
        folder: 'test-group',
        trigger: '@Alef',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    onAutoRegisterGroup: vi.fn(),
    ...overrides,
  };
}

function createTextCtx(overrides: {
  chatId?: number;
  chatType?: string;
  chatTitle?: string;
  text: string;
  fromId?: number;
  firstName?: string;
  username?: string;
  messageId?: number;
  date?: number;
  entities?: any[];
  reply_to_message?: any;
}) {
  const chatId = overrides.chatId ?? 100200300;
  const chatType = overrides.chatType ?? 'private';
  return {
    chat: {
      id: chatId,
      type: chatType,
      title: overrides.chatTitle ?? 'Test Group',
    },
    from: {
      id: overrides.fromId ?? 99001,
      first_name: overrides.firstName ?? 'Alice',
      username: overrides.username ?? 'alice_user',
    },
    message: {
      text: overrides.text,
      date: overrides.date ?? Math.floor(Date.now() / 1000),
      message_id: overrides.messageId ?? 1,
      entities: overrides.entities ?? [],
      reply_to_message: overrides.reply_to_message,
    },
    me: { username: 'andy_ai_bot' },
    reply: vi.fn(),
  };
}

function createMediaCtx(overrides: {
  chatId?: number;
  chatType?: string;
  fromId?: number;
  firstName?: string;
  date?: number;
  messageId?: number;
  caption?: string;
  extra?: Record<string, any>;
}) {
  const chatId = overrides.chatId ?? 100200300;
  return {
    chat: {
      id: chatId,
      type: overrides.chatType ?? 'private',
      title: 'Test Group',
    },
    from: {
      id: overrides.fromId ?? 99001,
      first_name: overrides.firstName ?? 'Alice',
      username: 'alice_user',
    },
    message: {
      date: overrides.date ?? Math.floor(Date.now() / 1000),
      message_id: overrides.messageId ?? 1,
      caption: overrides.caption,
      ...(overrides.extra || {}),
    },
    me: { username: 'andy_ai_bot' },
  };
}

function currentBot() {
  return botRef.current;
}

async function triggerTextMessage(ctx: ReturnType<typeof createTextCtx>) {
  const handlers = currentBot().filterHandlers.get('message:text') || [];
  for (const h of handlers) await h(ctx);
}

async function triggerMediaMessage(
  filter: string,
  ctx: ReturnType<typeof createMediaCtx>,
) {
  const handlers = currentBot().filterHandlers.get(filter) || [];
  for (const h of handlers) await h(ctx);
}

// --- Tests ---

// Helper: flush pending microtasks (for async downloadFile().then() chains)
const flushPromises = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('TelegramChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    telegramConfigMock.allowGroups = false;

    // Mock fs operations used by downloadFile
    vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
    vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined);

    // Mock global fetch for file downloads
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('resolves connect() when bot starts', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      await channel.connect();

      expect(channel.isConnected()).toBe(true);
    });

    it('registers command and message handlers on connect', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      await channel.connect();

      expect(currentBot().commandHandlers.has('chatid')).toBe(true);
      expect(currentBot().commandHandlers.has('ping')).toBe(true);
      expect(currentBot().filterHandlers.has('message:text')).toBe(true);
      expect(currentBot().filterHandlers.has('message:photo')).toBe(true);
      expect(currentBot().filterHandlers.has('message:video')).toBe(true);
      expect(currentBot().filterHandlers.has('message:voice')).toBe(true);
      expect(currentBot().filterHandlers.has('message:audio')).toBe(true);
      expect(currentBot().filterHandlers.has('message:document')).toBe(true);
      expect(currentBot().filterHandlers.has('message:sticker')).toBe(true);
      expect(currentBot().filterHandlers.has('message:location')).toBe(true);
      expect(currentBot().filterHandlers.has('message:contact')).toBe(true);
    });

    it('registers error handler on connect', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      await channel.connect();

      expect(currentBot().errorHandler).not.toBeNull();
    });

    it('disconnects cleanly', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      await channel.connect();
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });

    it('isConnected() returns false before connect', () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      expect(channel.isConnected()).toBe(false);
    });
  });

  // --- Text message handling ---

  describe('text message handling', () => {
    it('delivers message for registered private chat', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'Hello everyone' });
      await triggerTextMessage(ctx);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'tg:100200300',
        expect.any(String),
        'Alice',
        'telegram',
        false,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          id: '1',
          chat_jid: 'tg:100200300',
          sender: '99001',
          sender_name: 'Alice',
          content: 'Hello everyone',
          is_from_me: false,
        }),
      );
    });

    it('auto-registers and delivers messages from previously unregistered chats', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ chatId: 999999, text: 'Unknown chat' });
      await triggerTextMessage(ctx);

      // Auto-registration should fire
      expect(opts.onAutoRegisterGroup).toHaveBeenCalledWith(
        'tg:999999',
        'Alice',
        false,
      );
      // Message should be delivered (not dropped)
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:999999',
        expect.objectContaining({ content: 'Unknown chat' }),
      );
    });

    it('skips bot commands (/chatid, /ping) but passes other / messages through', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      // Bot commands should be skipped
      const ctx1 = createTextCtx({ text: '/chatid' });
      await triggerTextMessage(ctx1);
      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(opts.onChatMetadata).not.toHaveBeenCalled();

      const ctx2 = createTextCtx({ text: '/ping' });
      await triggerTextMessage(ctx2);
      expect(opts.onMessage).not.toHaveBeenCalled();

      // Non-bot /commands should flow through
      const ctx3 = createTextCtx({ text: '/remote-control' });
      await triggerTextMessage(ctx3);
      expect(opts.onMessage).toHaveBeenCalledTimes(1);
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '/remote-control' }),
      );
    });

    it('extracts sender name from first_name', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'Hi', firstName: 'Bob' });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ sender_name: 'Bob' }),
      );
    });

    it('falls back to username when first_name missing', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'Hi' });
      ctx.from.first_name = undefined as any;
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ sender_name: 'alice_user' }),
      );
    });

    it('falls back to user ID when name and username missing', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'Hi', fromId: 42 });
      ctx.from.first_name = undefined as any;
      ctx.from.username = undefined as any;
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ sender_name: '42' }),
      );
    });

    it('uses sender name as chat name for private chats', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'tg:100200300': {
            name: 'Private',
            folder: 'private',
            trigger: '@Alef',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: 'Hello',
        chatType: 'private',
        firstName: 'Alice',
      });
      await triggerTextMessage(ctx);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'tg:100200300',
        expect.any(String),
        'Alice', // Private chats use sender name
        'telegram',
        false,
      );
    });

    it('ignores supergroup messages when TELEGRAM_ALLOW_GROUPS is off', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: 'Hello',
        chatType: 'supergroup',
        chatTitle: 'Project Team',
      });
      await triggerTextMessage(ctx);

      expect(opts.onChatMetadata).not.toHaveBeenCalled();
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('delivers supergroup messages when TELEGRAM_ALLOW_GROUPS is on', async () => {
      telegramConfigMock.allowGroups = true;
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: 'Hello',
        chatType: 'supergroup',
        chatTitle: 'Project Team',
      });
      await triggerTextMessage(ctx);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'tg:100200300',
        expect.any(String),
        'Project Team',
        'telegram',
        true,
      );
      expect(opts.onMessage).toHaveBeenCalled();
    });

    it('converts message.date to ISO timestamp', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const unixTime = 1704067200; // 2024-01-01T00:00:00.000Z
      const ctx = createTextCtx({ text: 'Hello', date: unixTime });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          timestamp: '2024-01-01T00:00:00.000Z',
        }),
      );
    });
  });

  // --- @mention translation ---

  describe('@mention translation', () => {
    it('translates @bot_username mention to trigger format', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: '@andy_ai_bot what time is it?',
        entities: [{ type: 'mention', offset: 0, length: 12 }],
      });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '@Alef @andy_ai_bot what time is it?',
        }),
      );
    });

    it('does not translate if message already matches trigger', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: '@Alef @andy_ai_bot hello',
        entities: [{ type: 'mention', offset: 6, length: 12 }],
      });
      await triggerTextMessage(ctx);

      // Should NOT double-prepend — already starts with @Alef
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '@Alef @andy_ai_bot hello',
        }),
      );
    });

    it('does not translate mentions of other bots', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: '@some_other_bot hi',
        entities: [{ type: 'mention', offset: 0, length: 15 }],
      });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '@some_other_bot hi', // No translation
        }),
      );
    });

    it('handles mention in middle of message', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: 'hey @andy_ai_bot check this',
        entities: [{ type: 'mention', offset: 4, length: 12 }],
      });
      await triggerTextMessage(ctx);

      // Bot is mentioned, message doesn't match trigger → prepend trigger
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '@Alef hey @andy_ai_bot check this',
        }),
      );
    });

    it('handles message with no entities', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'plain message' });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: 'plain message',
        }),
      );
    });

    it('ignores non-mention entities', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: 'check https://example.com',
        entities: [{ type: 'url', offset: 6, length: 19 }],
      });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: 'check https://example.com',
        }),
      );
    });
  });

  // --- Reply context ---

  describe('reply context', () => {
    it('extracts reply_to fields when replying to a text message', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: 'Yes, on my way!',
        reply_to_message: {
          message_id: 42,
          text: 'Are you coming tonight?',
          from: { id: 777, first_name: 'Bob', username: 'bob_user' },
        },
      });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: 'Yes, on my way!',
          reply_to_message_id: '42',
          reply_to_message_content: 'Are you coming tonight?',
          reply_to_sender_name: 'Bob',
        }),
      );
    });

    it('uses caption when reply has no text (media reply)', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: 'Nice photo!',
        reply_to_message: {
          message_id: 50,
          caption: 'Check this out',
          from: { id: 888, first_name: 'Carol' },
        },
      });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          reply_to_message_content: 'Check this out',
        }),
      );
    });

    it('falls back to Unknown when reply sender has no from', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: 'Interesting',
        reply_to_message: {
          message_id: 60,
          text: 'Channel post',
        },
      });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          reply_to_message_id: '60',
          reply_to_sender_name: 'Unknown',
        }),
      );
    });

    it('does not set reply fields when no reply_to_message', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'Just a normal message' });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          reply_to_message_id: undefined,
          reply_to_message_content: undefined,
          reply_to_sender_name: undefined,
        }),
      );
    });
  });

  // --- Non-text messages ---

  describe('non-text messages', () => {
    it('downloads photo and includes path in content', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({
        extra: {
          photo: [
            { file_id: 'small_id', width: 90 },
            { file_id: 'large_id', width: 800 },
          ],
        },
      });
      await triggerMediaMessage('message:photo', ctx);
      await flushPromises();

      expect(currentBot().api.getFile).toHaveBeenCalledWith('large_id');
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '[Photo] (/workspace/group/attachments/photo_1.jpg)',
        }),
      );
    });

    it('downloads photo with caption', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({
        caption: 'Look at this',
        extra: { photo: [{ file_id: 'photo_id', width: 800 }] },
      });
      await triggerMediaMessage('message:photo', ctx);
      await flushPromises();

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content:
            '[Photo] (/workspace/group/attachments/photo_1.jpg) Look at this',
        }),
      );
    });

    it('falls back to placeholder when download fails', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      // Make getFile reject
      currentBot().api.getFile.mockRejectedValueOnce(new Error('API error'));

      const ctx = createMediaCtx({
        caption: 'Check this',
        extra: { photo: [{ file_id: 'bad_id', width: 800 }] },
      });
      await triggerMediaMessage('message:photo', ctx);
      await flushPromises();

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Photo] Check this' }),
      );
    });

    it('downloads document and includes filename and path', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.getFile.mockResolvedValueOnce({
        file_path: 'documents/file_0.pdf',
      });

      const ctx = createMediaCtx({
        extra: { document: { file_name: 'report.pdf', file_id: 'doc_id' } },
      });
      await triggerMediaMessage('message:document', ctx);
      await flushPromises();

      expect(currentBot().api.getFile).toHaveBeenCalledWith('doc_id');
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content:
            '[Document: report.pdf] (/workspace/group/attachments/report.pdf)',
        }),
      );
    });

    it('downloads video', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.getFile.mockResolvedValueOnce({
        file_path: 'videos/file_0.mp4',
      });

      const ctx = createMediaCtx({
        extra: { video: { file_id: 'vid_id' } },
      });
      await triggerMediaMessage('message:video', ctx);
      await flushPromises();

      expect(currentBot().api.getFile).toHaveBeenCalledWith('vid_id');
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '[Video] (/workspace/group/attachments/video_1.mp4)',
        }),
      );
    });

    it('downloads voice message', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.getFile.mockResolvedValueOnce({
        file_path: 'voice/file_0.oga',
      });

      const ctx = createMediaCtx({
        extra: { voice: { file_id: 'voice_id' } },
      });
      await triggerMediaMessage('message:voice', ctx);
      await flushPromises();

      expect(currentBot().api.getFile).toHaveBeenCalledWith('voice_id');
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '[Voice message] (/workspace/group/attachments/voice_1.oga)',
        }),
      );
    });

    it('downloads audio with original filename', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.getFile.mockResolvedValueOnce({
        file_path: 'audio/file_0.mp3',
      });

      const ctx = createMediaCtx({
        extra: { audio: { file_id: 'audio_id', file_name: 'song.mp3' } },
      });
      await triggerMediaMessage('message:audio', ctx);
      await flushPromises();

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '[Audio] (/workspace/group/attachments/song.mp3)',
        }),
      );
    });

    it('stores sticker with emoji (no download)', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({
        extra: { sticker: { emoji: '😂' } },
      });
      await triggerMediaMessage('message:sticker', ctx);

      expect(currentBot().api.getFile).not.toHaveBeenCalled();
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Sticker 😂]' }),
      );
    });

    it('stores location with placeholder (no download)', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({});
      await triggerMediaMessage('message:location', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Location]' }),
      );
    });

    it('stores contact with placeholder (no download)', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({});
      await triggerMediaMessage('message:contact', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Contact]' }),
      );
    });

    it('auto-registers and delivers media from previously unregistered chats', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({ chatId: 999999 });
      await triggerMediaMessage('message:photo', ctx);
      await flushPromises();

      expect(opts.onAutoRegisterGroup).toHaveBeenCalledWith(
        'tg:999999',
        expect.any(String),
        false,
      );
      expect(opts.onMessage).toHaveBeenCalled();
    });

    it('stores document with fallback name when filename missing', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.getFile.mockResolvedValueOnce({
        file_path: 'documents/file_0.bin',
      });

      const ctx = createMediaCtx({
        extra: { document: { file_id: 'doc_id' } },
      });
      await triggerMediaMessage('message:document', ctx);
      await flushPromises();

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '[Document: file] (/workspace/group/attachments/file.bin)',
        }),
      );
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('sends message via bot API', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.sendMessage('tg:100200300', 'Hello');

      expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
        '100200300',
        'Hello',
        { parse_mode: 'Markdown' },
      );
    });

    it('does not send to group chat ids when TELEGRAM_ALLOW_GROUPS is off', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.sendMessage('tg:-1001234567890', 'Group message');

      expect(currentBot().api.sendMessage).not.toHaveBeenCalled();
    });

    it('sends to supergroup id when TELEGRAM_ALLOW_GROUPS is on', async () => {
      telegramConfigMock.allowGroups = true;
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.sendMessage('tg:-1001234567890', 'Group message');

      expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
        '-1001234567890',
        'Group message',
        { parse_mode: 'Markdown' },
      );
    });

    it('splits messages exceeding 4096 characters', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const longText = 'x'.repeat(5000);
      await channel.sendMessage('tg:100200300', longText);

      expect(currentBot().api.sendMessage).toHaveBeenCalledTimes(2);
      expect(currentBot().api.sendMessage).toHaveBeenNthCalledWith(
        1,
        '100200300',
        'x'.repeat(4096),
        { parse_mode: 'Markdown' },
      );
      expect(currentBot().api.sendMessage).toHaveBeenNthCalledWith(
        2,
        '100200300',
        'x'.repeat(904),
        { parse_mode: 'Markdown' },
      );
    });

    it('sends exactly one message at 4096 characters', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const exactText = 'y'.repeat(4096);
      await channel.sendMessage('tg:100200300', exactText);

      expect(currentBot().api.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('handles send failure gracefully', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.sendMessage.mockRejectedValueOnce(
        new Error('Network error'),
      );

      // Should not throw
      await expect(
        channel.sendMessage('tg:100200300', 'Will fail'),
      ).resolves.toBeUndefined();
    });

    it('does nothing when bot is not initialized', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      // Don't connect — bot is null
      await channel.sendMessage('tg:100200300', 'No bot');

      // No error, no API call
    });
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('owns tg: JIDs', () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      expect(channel.ownsJid('tg:123456')).toBe(true);
    });

    it('owns tg: JIDs with negative IDs (groups)', () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      expect(channel.ownsJid('tg:-1001234567890')).toBe(true);
    });

    it('does not own WhatsApp group JIDs', () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });

    it('does not own WhatsApp DM JIDs', () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      expect(channel.ownsJid('12345@s.whatsapp.net')).toBe(false);
    });

    it('does not own unknown JID formats', () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      expect(channel.ownsJid('random-string')).toBe(false);
    });
  });

  // --- setTyping ---

  describe('setTyping', () => {
    it('sends typing action when isTyping is true', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.setTyping('tg:100200300', true);

      expect(currentBot().api.sendChatAction).toHaveBeenCalledWith(
        '100200300',
        'typing',
      );
    });

    it('does nothing when isTyping is false', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.setTyping('tg:100200300', false);

      expect(currentBot().api.sendChatAction).not.toHaveBeenCalled();
    });

    it('does not send typing to group chat ids when TELEGRAM_ALLOW_GROUPS is off', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.setTyping('tg:-1001234567890', true);

      expect(currentBot().api.sendChatAction).not.toHaveBeenCalled();
    });

    it('sends typing to group id when TELEGRAM_ALLOW_GROUPS is on', async () => {
      telegramConfigMock.allowGroups = true;
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.setTyping('tg:-1001234567890', true);

      expect(currentBot().api.sendChatAction).toHaveBeenCalledWith(
        '-1001234567890',
        'typing',
      );
    });

    it('does nothing when bot is not initialized', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      // Don't connect
      await channel.setTyping('tg:100200300', true);

      // No error, no API call
    });

    it('handles typing indicator failure gracefully', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.sendChatAction.mockRejectedValueOnce(
        new Error('Rate limited'),
      );

      await expect(
        channel.setTyping('tg:100200300', true),
      ).resolves.toBeUndefined();
    });
  });

  // --- Bot commands ---

  describe('bot commands', () => {
    it('/chatid replies with chat ID and metadata in private chat', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('chatid')!;
      const ctx = {
        chat: { id: 100200300, type: 'private' as const },
        from: { first_name: 'Alice' },
        reply: vi.fn(),
      };

      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('tg:100200300'),
        expect.objectContaining({ parse_mode: 'Markdown' }),
      );
    });

    it('/chatid does nothing in a group when TELEGRAM_ALLOW_GROUPS is off', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('chatid')!;
      const ctx = {
        chat: { id: 100200300, type: 'group' as const, title: 'Team' },
        from: { first_name: 'Alice' },
        reply: vi.fn(),
      };

      await handler(ctx);

      expect(ctx.reply).not.toHaveBeenCalled();
    });

    it('/chatid works in a group when TELEGRAM_ALLOW_GROUPS is on', async () => {
      telegramConfigMock.allowGroups = true;
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('chatid')!;
      const ctx = {
        chat: { id: -1001, type: 'supergroup' as const, title: 'Lab' },
        from: { first_name: 'Alice' },
        reply: vi.fn(),
      };

      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('tg:-1001'),
        expect.objectContaining({ parse_mode: 'Markdown' }),
      );
    });

    it('/chatid shows chat type', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('chatid')!;
      const ctx = {
        chat: { id: 555, type: 'private' as const },
        from: { first_name: 'Bob' },
        reply: vi.fn(),
      };

      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('private'),
        expect.any(Object),
      );
    });

    it('/ping replies with bot status in private chat', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('ping')!;
      const ctx = {
        chat: { id: 1, type: 'private' as const },
        reply: vi.fn(),
      };

      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith('Alef is online.');
    });
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "telegram"', () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      expect(channel.name).toBe('telegram');
    });
  });

  // --- Grammy error handler ---

  describe('Grammy error handler', () => {
    it('is registered after connect()', async () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      await channel.connect();
      expect(botRef.current.errorHandler).not.toBeNull();
    });

    it('logs errors via logger.error', async () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      await channel.connect();
      const err = { error: new Error('send failed'), message: 'send failed' };
      botRef.current.errorHandler!(err);
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        expect.objectContaining({ err: err.error }),
        'Telegram bot error',
      );
    });

    it('falls back to the outer error when .error is absent', async () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      await channel.connect();
      const err = new Error('raw error');
      botRef.current.errorHandler!(err);
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        expect.objectContaining({ err }),
        'Telegram bot error',
      );
    });
  });

  // --- async reply propagation ---

  describe('command handler async reply propagation', () => {
    it('/chatid propagates a rejected ctx.reply as a rejected promise', async () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      await channel.connect();
      const handler = botRef.current.commandHandlers.get('chatid')!;
      const replyError = new Error('network failure');
      const ctx = {
        chat: { id: 42, type: 'private' as const },
        from: { first_name: 'Jim' },
        reply: vi.fn().mockRejectedValue(replyError),
      };
      // Before the fix ctx.reply was not awaited, so errors were swallowed.
      // Now the handler is async and awaits ctx.reply — the rejection propagates.
      await expect(handler(ctx)).rejects.toThrow('network failure');
    });

    it('/ping propagates a rejected ctx.reply as a rejected promise', async () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      await channel.connect();
      const handler = botRef.current.commandHandlers.get('ping')!;
      const replyError = new Error('timeout');
      const ctx = {
        chat: { id: 42, type: 'private' as const },
        reply: vi.fn().mockRejectedValue(replyError),
      };
      await expect(handler(ctx)).rejects.toThrow('timeout');
    });
  });

  describe('shouldPrependAssistantTriggerForBotMention', () => {
    const me = { id: 42, username: 'alef-mark-01' };

    it('returns false when message already starts with assistant trigger', () => {
      expect(
        shouldPrependAssistantTriggerForBotMention('@Alef hi', [], me),
      ).toBe(false);
      expect(
        shouldPrependAssistantTriggerForBotMention('@alef ping', [], me),
      ).toBe(false);
    });

    it('returns true when mention entity matches bot username', () => {
      const text = 'hi @alef-mark-01 there';
      const at = text.indexOf('@');
      const len = '@alef-mark-01'.length;
      const entities = [{ type: 'mention', offset: at, length: len }];
      expect(
        shouldPrependAssistantTriggerForBotMention(text, entities, me),
      ).toBe(true);
    });

    it('returns true for text_mention with same bot user id', () => {
      const entities = [
        {
          type: 'text_mention',
          offset: 0,
          length: 4,
          user: { id: 42 },
        },
      ];
      expect(
        shouldPrependAssistantTriggerForBotMention('Alef do x', entities, me),
      ).toBe(true);
    });

    it('returns true when plain @username appears in text', () => {
      expect(
        shouldPrependAssistantTriggerForBotMention(
          'yo @alef-mark-01 please',
          [],
          me,
        ),
      ).toBe(true);
    });

    it('returns false without me username when only plain @handle in text', () => {
      expect(
        shouldPrependAssistantTriggerForBotMention('yo @alef-mark-01', [], {
          id: 42,
        }),
      ).toBe(false);
    });

    it('returns true for text_mention when username omitted but id matches', () => {
      const entities = [
        {
          type: 'text_mention',
          offset: 0,
          length: 4,
          user: { id: 42 },
        },
      ];
      expect(
        shouldPrependAssistantTriggerForBotMention('Nick', entities, {
          id: 42,
        }),
      ).toBe(true);
    });

    it('returns false when me is undefined', () => {
      expect(
        shouldPrependAssistantTriggerForBotMention('hi @alef-mark-01', []),
      ).toBe(false);
    });
  });

  describe('isTelegramPrivateChatId', () => {
    it('accepts positive decimal user ids', () => {
      expect(isTelegramPrivateChatId('12345')).toBe(true);
      expect(isTelegramPrivateChatId('100200300')).toBe(true);
    });

    it('rejects group/supergroup ids', () => {
      expect(isTelegramPrivateChatId('-1001234567890')).toBe(false);
      expect(isTelegramPrivateChatId('-1')).toBe(false);
    });

    it('rejects zero and non-numeric', () => {
      expect(isTelegramPrivateChatId('0')).toBe(false);
      expect(isTelegramPrivateChatId('')).toBe(false);
      expect(isTelegramPrivateChatId('abc')).toBe(false);
    });
  });
});

// =============================================================================
// M26 — Telegram Channel Adapter Test Suite
//
// Spec: docs/specs/channel-adapters-spec.md
// UX decisions: docs/ux/ux-review-tui-cli.md (groups are per-channel)
// Written against the spec acceptance criteria (AC-1 through AC-18).
// All tests in this suite are INITIALLY FAILING — implementation does not yet
// satisfy all requirements below. The Developer implements against these tests.
//
// Four tiers:
//   Tier 1 — Unit
//   Tier 2 — Contract
//   Tier 3 — Integration
//   Tier 4 — Stub detection
// =============================================================================

describe('M26 — Telegram channel adapter (spec-compliance)', () => {
  // ---------------------------------------------------------------------------
  // Tier 1: Unit
  // AC-3: Inbound message normalized to InboundMessage format
  // AC-4: Language metadata preserved
  // AC-5: Adapter does not filter messages by sender identity
  // AC-17 / AC-18: senderId hashed; raw not logged
  // ---------------------------------------------------------------------------

  describe('Tier 1 — Unit', () => {
    // -------------------------------------------------------------------------
    // AC-3 / Unit-1: Telegram update event normalized to canonical InboundMessage
    //
    // The spec (§ External Interface — Inbound) defines InboundMessage with:
    //   channel, contextId, senderId, text, receivedAt, raw
    // The current implementation calls onMessage with a legacy shape
    // {id, chat_jid, sender, content, timestamp}. These tests verify the spec
    // shape, which will initially fail until the adapter is updated.
    // -------------------------------------------------------------------------

    it('[AC-3 / Unit-1a] delivered object has required field: channel = "telegram"', async () => {
      const deliveredMessages: unknown[] = [];
      const opts = createTestOpts({
        onMessage: vi.fn((_jid: string, msg: unknown) => {
          deliveredMessages.push(msg);
        }),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'Hello spec' });
      await triggerTextMessage(ctx);

      expect(deliveredMessages).toHaveLength(1);
      expect(deliveredMessages[0]).toMatchObject({ channel: 'telegram' });
    });

    it('[AC-3 / Unit-1b] delivered object has required field: contextId (non-empty string)', async () => {
      const deliveredMessages: unknown[] = [];
      const opts = createTestOpts({
        onMessage: vi.fn((_jid: string, msg: unknown) => {
          deliveredMessages.push(msg);
        }),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'Hello spec', chatId: 100200300 });
      await triggerTextMessage(ctx);

      expect(deliveredMessages).toHaveLength(1);
      const msg = deliveredMessages[0] as Record<string, unknown>;
      expect(typeof msg.contextId).toBe('string');
      expect((msg.contextId as string).length).toBeGreaterThan(0);
    });

    it('[AC-3 / Unit-1c] delivered object has required field: text (equals message text)', async () => {
      const deliveredMessages: unknown[] = [];
      const opts = createTestOpts({
        onMessage: vi.fn((_jid: string, msg: unknown) => {
          deliveredMessages.push(msg);
        }),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'The canonical text field' });
      await triggerTextMessage(ctx);

      expect(deliveredMessages).toHaveLength(1);
      expect(deliveredMessages[0]).toMatchObject({
        text: 'The canonical text field',
      });
    });

    it('[AC-3 / Unit-1d] delivered object has required field: receivedAt (ISO-8601 string)', async () => {
      const deliveredMessages: unknown[] = [];
      const opts = createTestOpts({
        onMessage: vi.fn((_jid: string, msg: unknown) => {
          deliveredMessages.push(msg);
        }),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const unixTime = 1704067200; // 2024-01-01T00:00:00.000Z
      const ctx = createTextCtx({ text: 'timestamp test', date: unixTime });
      await triggerTextMessage(ctx);

      expect(deliveredMessages).toHaveLength(1);
      const msg = deliveredMessages[0] as Record<string, unknown>;
      expect(typeof msg.receivedAt).toBe('string');
      // Must parse as a valid date
      expect(new Date(msg.receivedAt as string).toISOString()).toBe(
        '2024-01-01T00:00:00.000Z',
      );
    });

    it('[AC-3 / Unit-1e] delivered object has required field: raw (unmodified event payload)', async () => {
      const deliveredMessages: unknown[] = [];
      const opts = createTestOpts({
        onMessage: vi.fn((_jid: string, msg: unknown) => {
          deliveredMessages.push(msg);
        }),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'raw field test' });
      await triggerTextMessage(ctx);

      expect(deliveredMessages).toHaveLength(1);
      const msg = deliveredMessages[0] as Record<string, unknown>;
      // raw must be present (the unmodified Telegram event payload)
      expect(msg).toHaveProperty('raw');
      expect(msg.raw).not.toBeUndefined();
    });

    // -------------------------------------------------------------------------
    // AC-17 / Unit-2: senderId hashed to opaque internal ID
    //
    // The spec states the audit log must store a sender identity hash, not the
    // raw Telegram user ID. The adapter's delivered message should present an
    // opaque (hashed) senderId, not the plain numeric Telegram user ID.
    // -------------------------------------------------------------------------

    it('[AC-17 / Unit-2a] senderId in delivered message is not the raw Telegram numeric user ID', async () => {
      const deliveredMessages: unknown[] = [];
      const opts = createTestOpts({
        onMessage: vi.fn((_jid: string, msg: unknown) => {
          deliveredMessages.push(msg);
        }),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const rawUserId = 99001;
      const ctx = createTextCtx({ text: 'hash test', fromId: rawUserId });
      await triggerTextMessage(ctx);

      expect(deliveredMessages).toHaveLength(1);
      const msg = deliveredMessages[0] as Record<string, unknown>;
      // senderId must NOT be the plain numeric ID string
      expect(msg.senderId).not.toBe(String(rawUserId));
      expect(msg.senderId).not.toBe(rawUserId);
    });

    it('[AC-17 / Unit-2b] senderId is a non-empty string (opaque token or hash)', async () => {
      const deliveredMessages: unknown[] = [];
      const opts = createTestOpts({
        onMessage: vi.fn((_jid: string, msg: unknown) => {
          deliveredMessages.push(msg);
        }),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'hash test 2', fromId: 12345 });
      await triggerTextMessage(ctx);

      expect(deliveredMessages).toHaveLength(1);
      const msg = deliveredMessages[0] as Record<string, unknown>;
      expect(typeof msg.senderId).toBe('string');
      expect((msg.senderId as string).length).toBeGreaterThan(0);
    });

    it('[AC-17 / Unit-2c] same sender always produces the same senderId (deterministic hash)', async () => {
      const deliveredMessages: unknown[] = [];
      const opts = createTestOpts({
        onMessage: vi.fn((_jid: string, msg: unknown) => {
          deliveredMessages.push(msg);
        }),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx1 = createTextCtx({ text: 'first', fromId: 55555 });
      const ctx2 = createTextCtx({ text: 'second', fromId: 55555 });
      await triggerTextMessage(ctx1);
      await triggerTextMessage(ctx2);

      expect(deliveredMessages).toHaveLength(2);
      const id1 = (deliveredMessages[0] as Record<string, unknown>).senderId;
      const id2 = (deliveredMessages[1] as Record<string, unknown>).senderId;
      expect(id1).toBe(id2);
    });

    // -------------------------------------------------------------------------
    // AC-4 / Unit-3: Language metadata preserved from message
    //
    // The spec requires detectedLanguage and languageSwitchDetected to be
    // included when available. Telegram's User object carries language_code.
    // -------------------------------------------------------------------------

    it('[AC-4 / Unit-3a] detectedLanguage set from Telegram user language_code when present', async () => {
      const deliveredMessages: unknown[] = [];
      const opts = createTestOpts({
        onMessage: vi.fn((_jid: string, msg: unknown) => {
          deliveredMessages.push(msg);
        }),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      // Create context with a language_code on from
      const ctx = createTextCtx({ text: 'Bonjour', fromId: 77001 });
      (ctx.from as Record<string, unknown>).language_code = 'fr';
      await triggerTextMessage(ctx);

      expect(deliveredMessages).toHaveLength(1);
      const msg = deliveredMessages[0] as Record<string, unknown>;
      expect(msg.detectedLanguage).toBe('fr');
    });

    it('[AC-4 / Unit-3b] detectedLanguage absent when user has no language_code', async () => {
      const deliveredMessages: unknown[] = [];
      const opts = createTestOpts({
        onMessage: vi.fn((_jid: string, msg: unknown) => {
          deliveredMessages.push(msg);
        }),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'Hello', fromId: 77002 });
      // Ensure no language_code
      delete (ctx.from as Record<string, unknown>).language_code;
      await triggerTextMessage(ctx);

      expect(deliveredMessages).toHaveLength(1);
      const msg = deliveredMessages[0] as Record<string, unknown>;
      // detectedLanguage should be absent or undefined when no language_code
      expect(msg.detectedLanguage).toBeUndefined();
    });

    it('[AC-4 / Unit-3c] languageSwitchDetected is true when consecutive messages from same sender switch language', async () => {
      const deliveredMessages: unknown[] = [];
      const opts = createTestOpts({
        onMessage: vi.fn((_jid: string, msg: unknown) => {
          deliveredMessages.push(msg);
        }),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const userId = 88001;
      const chatId = 100200300;

      const ctx1 = createTextCtx({ text: 'Hello', fromId: userId, chatId });
      (ctx1.from as Record<string, unknown>).language_code = 'en';
      await triggerTextMessage(ctx1);

      const ctx2 = createTextCtx({ text: 'Bonjour', fromId: userId, chatId });
      (ctx2.from as Record<string, unknown>).language_code = 'fr';
      await triggerTextMessage(ctx2);

      expect(deliveredMessages).toHaveLength(2);
      const second = deliveredMessages[1] as Record<string, unknown>;
      // The second message switches language → languageSwitchDetected must be true
      expect(second.languageSwitchDetected).toBe(true);
    });

    it('[AC-4 / Unit-3d] languageSwitchDetected is absent or false when language does not switch', async () => {
      const deliveredMessages: unknown[] = [];
      const opts = createTestOpts({
        onMessage: vi.fn((_jid: string, msg: unknown) => {
          deliveredMessages.push(msg);
        }),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const userId = 88002;
      const chatId = 100200300;

      const ctx1 = createTextCtx({ text: 'Hello', fromId: userId, chatId });
      (ctx1.from as Record<string, unknown>).language_code = 'en';
      await triggerTextMessage(ctx1);

      const ctx2 = createTextCtx({ text: 'Hi again', fromId: userId, chatId });
      (ctx2.from as Record<string, unknown>).language_code = 'en';
      await triggerTextMessage(ctx2);

      expect(deliveredMessages).toHaveLength(2);
      const second = deliveredMessages[1] as Record<string, unknown>;
      expect(second.languageSwitchDetected).toBeFalsy();
    });

    // -------------------------------------------------------------------------
    // AC-5 / Unit-4: Sender allowlist enforcement is orchestrator-level
    //
    // The adapter must pass every parseable inbound message to onMessage,
    // regardless of whether the sender is on TELEGRAM_VALID_USERS. The
    // orchestrator (index.ts) applies allowlist gating after delivery.
    // -------------------------------------------------------------------------

    it('[AC-5 / Unit-4a] adapter delivers message even when sender is not in TELEGRAM_VALID_USERS', async () => {
      // Simulate an env where TELEGRAM_VALID_USERS is set to a specific user
      // and the inbound message is from a different user. The adapter must still
      // call onMessage — the orchestrator gates it, not the adapter.
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const nonAllowlistedUserId = 99999; // not in any allowlist
      const ctx = createTextCtx({
        text: 'I should reach onMessage',
        fromId: nonAllowlistedUserId,
      });
      await triggerTextMessage(ctx);

      // Adapter must NOT drop the message — it must call onMessage
      expect(opts.onMessage).toHaveBeenCalledTimes(1);
      expect(opts.onMessage).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ text: 'I should reach onMessage' }),
      );
    });

    it('[AC-5 / Unit-4b] adapter delivers messages from ALL senders without filtering (invariant INV-1)', async () => {
      // The spec invariant: "No adapter gates, filters, or drops messages based
      // on sender identity." Deliver three messages from three different senders;
      // all three must reach onMessage.
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const senders = [11111, 22222, 33333];
      for (const fromId of senders) {
        const ctx = createTextCtx({ text: `Message from ${fromId}`, fromId });
        await triggerTextMessage(ctx);
      }

      expect(opts.onMessage).toHaveBeenCalledTimes(3);
    });
  });

  // ---------------------------------------------------------------------------
  // Tier 2: Contract
  // AC-15 / AC-16: .intent.md validated against skill-schema-spec.md rules
  // network.endpoints declares https://api.telegram.org/*
  // apply_permission is admin
  // InboundMessage schema compliance
  // ---------------------------------------------------------------------------

  describe('Tier 2 — Contract', () => {
    // -------------------------------------------------------------------------
    // AC-3 / Contract-1: InboundMessage schema compliance
    //
    // Every field the spec defines on InboundMessage must be present and typed
    // correctly when the adapter delivers a message.
    // -------------------------------------------------------------------------

    it('[AC-3 / Contract-1a] InboundMessage schema: all required fields present simultaneously', async () => {
      const deliveredMessages: unknown[] = [];
      const opts = createTestOpts({
        onMessage: vi.fn((_jid: string, msg: unknown) => {
          deliveredMessages.push(msg);
        }),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: 'Schema check',
        chatId: 100200300,
        fromId: 42001,
      });
      await triggerTextMessage(ctx);

      expect(deliveredMessages).toHaveLength(1);
      const msg = deliveredMessages[0] as Record<string, unknown>;

      // Required fields per spec §External Interface — Inbound
      expect(msg).toHaveProperty('channel');
      expect(msg).toHaveProperty('contextId');
      expect(msg).toHaveProperty('senderId');
      expect(msg).toHaveProperty('text');
      expect(msg).toHaveProperty('receivedAt');
      expect(msg).toHaveProperty('raw');

      // Type checks
      expect(typeof msg.channel).toBe('string');
      expect(typeof msg.contextId).toBe('string');
      expect(typeof msg.senderId).toBe('string');
      expect(typeof msg.text).toBe('string');
      expect(typeof msg.receivedAt).toBe('string');

      // Values non-empty
      expect((msg.channel as string).length).toBeGreaterThan(0);
      expect((msg.contextId as string).length).toBeGreaterThan(0);
      expect((msg.senderId as string).length).toBeGreaterThan(0);
      expect((msg.text as string).length).toBeGreaterThan(0);
      expect((msg.receivedAt as string).length).toBeGreaterThan(0);
    });

    it('[AC-3 / Contract-1b] InboundMessage schema: channel field is exactly "telegram"', async () => {
      const deliveredMessages: unknown[] = [];
      const opts = createTestOpts({
        onMessage: vi.fn((_jid: string, msg: unknown) => {
          deliveredMessages.push(msg);
        }),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'channel field' });
      await triggerTextMessage(ctx);

      const msg = deliveredMessages[0] as Record<string, unknown>;
      expect(msg.channel).toBe('telegram');
    });

    it('[AC-3 / Contract-1c] InboundMessage schema: contextId reflects the chat (tg: prefix)', async () => {
      const deliveredMessages: unknown[] = [];
      const opts = createTestOpts({
        onMessage: vi.fn((_jid: string, msg: unknown) => {
          deliveredMessages.push(msg);
        }),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'contextId test', chatId: 100200300 });
      await triggerTextMessage(ctx);

      const msg = deliveredMessages[0] as Record<string, unknown>;
      // contextId must identify the Telegram chat — tg:100200300
      expect(msg.contextId).toBe('tg:100200300');
    });

    it('[AC-3 / Contract-1d] InboundMessage schema: receivedAt is valid ISO-8601', async () => {
      const deliveredMessages: unknown[] = [];
      const opts = createTestOpts({
        onMessage: vi.fn((_jid: string, msg: unknown) => {
          deliveredMessages.push(msg);
        }),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'iso test', date: 1704067200 });
      await triggerTextMessage(ctx);

      const msg = deliveredMessages[0] as Record<string, unknown>;
      const parsed = new Date(msg.receivedAt as string);
      expect(Number.isNaN(parsed.getTime())).toBe(false);
      // Must round-trip through ISO-8601
      expect(parsed.toISOString()).toBe(msg.receivedAt);
    });

    // -------------------------------------------------------------------------
    // AC-15 / Contract-2: .intent.md validates against skill-schema-spec.md rules
    //
    // The Telegram channel adapter is a Feature skill. Its .intent.md must:
    //   - exist at src/channels/telegram.intent.md (or skills/telegram.intent.md)
    //   - be valid YAML frontmatter
    //   - declare type: feature
    //   - declare apply_permission: admin  (AC-16)
    //   - declare network.endpoints with https://api.telegram.org/*  (spec)
    //   - declare providers.compatible non-empty
    //   - declare token_scopes.skills including "telegram"
    // These tests read the file — they fail until the file is created.
    // -------------------------------------------------------------------------

    const INTENT_MD_CANDIDATES = [
      path.resolve(process.cwd(), 'src/channels/telegram.intent.md'),
      path.resolve(process.cwd(), 'skills/telegram/telegram.intent.md'),
      path.resolve(process.cwd(), 'skills/telegram.intent.md'),
    ];

    function findIntentMd(): string | null {
      for (const candidate of INTENT_MD_CANDIDATES) {
        if (fs.existsSync(candidate)) return candidate;
      }
      return null;
    }

    it('[AC-15 / Contract-2a] telegram.intent.md file exists', () => {
      const found = findIntentMd();
      expect(found).not.toBeNull();
    });

    it('[AC-15 / Contract-2b] telegram.intent.md declares type: feature', () => {
      const found = findIntentMd();
      if (!found) {
        // File missing — fail with helpful message
        throw new Error(
          'telegram.intent.md not found. Expected at: ' +
            INTENT_MD_CANDIDATES.join(', '),
        );
      }
      const content = fs.readFileSync(found, 'utf8');
      expect(content).toMatch(/^\s*type:\s*feature\s*$/m);
    });

    it('[AC-16 / Contract-2c] telegram.intent.md declares apply_permission: admin', () => {
      const found = findIntentMd();
      if (!found) {
        throw new Error(
          'telegram.intent.md not found. Expected at: ' +
            INTENT_MD_CANDIDATES.join(', '),
        );
      }
      const content = fs.readFileSync(found, 'utf8');
      expect(content).toMatch(/^\s*apply_permission:\s*admin\s*$/m);
    });

    it('[Contract-2d] telegram.intent.md declares network.endpoints with https://api.telegram.org/*', () => {
      const found = findIntentMd();
      if (!found) {
        throw new Error(
          'telegram.intent.md not found. Expected at: ' +
            INTENT_MD_CANDIDATES.join(', '),
        );
      }
      const content = fs.readFileSync(found, 'utf8');
      // The endpoint pattern must appear in the file
      expect(content).toContain('https://api.telegram.org/*');
    });

    it('[Contract-2e] telegram.intent.md declares providers.compatible as non-empty list', () => {
      const found = findIntentMd();
      if (!found) {
        throw new Error(
          'telegram.intent.md not found. Expected at: ' +
            INTENT_MD_CANDIDATES.join(', '),
        );
      }
      const content = fs.readFileSync(found, 'utf8');
      // providers: block with compatible: list must be present
      expect(content).toMatch(/providers:/);
      expect(content).toMatch(/compatible:/);
      // At least one entry ("any" or a specific provider)
      expect(content).toMatch(/- (any|anthropic|openrouter|ollama)/);
    });

    it('[Contract-2f] telegram.intent.md declares token_scopes.skills including "telegram"', () => {
      const found = findIntentMd();
      if (!found) {
        throw new Error(
          'telegram.intent.md not found. Expected at: ' +
            INTENT_MD_CANDIDATES.join(', '),
        );
      }
      const content = fs.readFileSync(found, 'utf8');
      expect(content).toMatch(/token_scopes:/);
      expect(content).toMatch(/skills:/);
      expect(content).toMatch(/- telegram/);
    });

    it('[Contract-2g] network.endpoints entry declares protocol: https and direction: outbound', () => {
      const found = findIntentMd();
      if (!found) {
        throw new Error(
          'telegram.intent.md not found. Expected at: ' +
            INTENT_MD_CANDIDATES.join(', '),
        );
      }
      const content = fs.readFileSync(found, 'utf8');
      // Both protocol: https and direction: outbound must appear in the endpoints block
      expect(content).toMatch(/protocol:\s*https/);
      expect(content).toMatch(/direction:\s*outbound/);
    });
  });

  // ---------------------------------------------------------------------------
  // Tier 3: Integration
  // AC-1: Self-registers with channel registry at startup
  // AC-7: Outbound message formats to Telegram Markdown and routes
  // ---------------------------------------------------------------------------

  describe('Tier 3 — Integration', () => {
    // -------------------------------------------------------------------------
    // AC-1 / Integration-1: Adapter self-registers with channel registry at startup
    //
    // When telegram.ts is imported (it runs registerChannel at module load),
    // the registry must contain a factory for "telegram". The factory must return
    // a Channel instance (not null) when TELEGRAM_BOT_TOKEN is set.
    //
    // Note: the mock at the top of this file intercepts registerChannel. We test
    // through a fresh module import with a real registry mock that captures calls.
    // -------------------------------------------------------------------------

    it('[AC-1 / Integration-1a] importing telegram.ts calls registerChannel("telegram", ...)', async () => {
      // The vi.mock at the top of this file captures registerChannel calls.
      // Importing telegram.ts triggers the module-level registerChannel call.
      // We verify the mock was called with "telegram" as the first argument.
      const { registerChannel } = await import('./registry.js');
      expect(vi.mocked(registerChannel)).toHaveBeenCalledWith(
        'telegram',
        expect.any(Function),
      );
    });

    it('[AC-1 / Integration-1b] registered factory returns a Channel instance when token is set', async () => {
      // Re-import registry and obtain the factory registered for "telegram"
      const { registerChannel } = await import('./registry.js');
      const calls = vi.mocked(registerChannel).mock.calls;
      const telegramEntry = calls.find(([name]) => name === 'telegram');
      expect(telegramEntry).toBeDefined();

      const factory = telegramEntry![1];
      // Factory is called with ChannelOpts — provide minimal stubs
      const opts = createTestOpts();
      // Set env token so factory does not return null for missing token
      const originalToken = process.env.TELEGRAM_BOT_TOKEN;
      process.env.TELEGRAM_BOT_TOKEN = 'integration-test-token';
      try {
        const instance = factory(opts);
        // With a token set, factory must return a Channel (not null)
        expect(instance).not.toBeNull();
        expect(instance).toHaveProperty('name', 'telegram');
      } finally {
        if (originalToken === undefined) {
          delete process.env.TELEGRAM_BOT_TOKEN;
        } else {
          process.env.TELEGRAM_BOT_TOKEN = originalToken;
        }
      }
    });

    it('[AC-11 / Integration-1c] registered factory returns null when TELEGRAM_BOT_TOKEN is absent', async () => {
      const { registerChannel } = await import('./registry.js');
      const calls = vi.mocked(registerChannel).mock.calls;
      const telegramEntry = calls.find(([name]) => name === 'telegram');
      expect(telegramEntry).toBeDefined();

      const factory = telegramEntry![1];
      const opts = createTestOpts();

      // Ensure token is absent
      const originalToken = process.env.TELEGRAM_BOT_TOKEN;
      delete process.env.TELEGRAM_BOT_TOKEN;
      try {
        const instance = factory(opts);
        // Missing credential → factory returns null (adapter does not register)
        expect(instance).toBeNull();
      } finally {
        if (originalToken !== undefined) {
          process.env.TELEGRAM_BOT_TOKEN = originalToken;
        }
      }
    });

    // -------------------------------------------------------------------------
    // AC-7 / Integration-2: Outbound message formats to Telegram Markdown
    //
    // sendMessage must use Telegram Markdown parse mode (Markdown or MarkdownV2).
    // The spec: "convert Markdown to Telegram MarkdownV2 or HTML (per deployment config)"
    // -------------------------------------------------------------------------

    it('[AC-7 / Integration-2a] sendMessage sends with a Telegram Markdown parse mode', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.sendMessage('tg:100200300', '**Bold text**');

      expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
        '100200300',
        expect.any(String),
        expect.objectContaining({
          parse_mode: expect.stringMatching(/^(Markdown|MarkdownV2|HTML)$/),
        }),
      );
    });

    it('[AC-7 / Integration-2b] sendMessage returns a success indicator (no throw) on successful delivery', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      // Should resolve without throwing
      await expect(
        channel.sendMessage('tg:100200300', 'Hello'),
      ).resolves.not.toThrow();
    });

    it('[AC-8 / Integration-2c] sendMessage propagates delivery failure as a distinguishable error', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      // Make sendMessage fail permanently (both primary and fallback)
      currentBot().api.sendMessage.mockRejectedValue(
        new Error('API unavailable'),
      );

      // The spec: "the adapter throws or returns an error value with a human-readable reason"
      // The current implementation catches and logs — but spec requires the error be
      // distinguishable (returned or thrown). This test will fail if the adapter silently
      // swallows the error without surfacing it to the orchestrator.
      const result = channel.sendMessage('tg:100200300', 'Will fail');
      // Either: the promise rejects (throws) or it resolves to an error-type value.
      // The spec says "throws or returns an error value". Current implementation returns
      // undefined silently — this test enforces the spec contract.
      await expect(result).rejects.toThrow();
    });

    it('[AC-9 / Integration-2d] adapter reports health status via isConnected()', async () => {
      // The spec defines AdapterHealthStatus {channel, status, since}.
      // The current implementation exposes isConnected() but not a full health
      // status object. This test verifies a getHealthStatus() method exists and
      // returns the spec-required shape.
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      // Spec-required: adapter exposes a health status function returning
      // { channel, status, since } after connection.
      const channelAsAny = channel as unknown as Record<string, unknown>;
      // getHealthStatus must exist and return spec-shaped object
      expect(typeof channelAsAny.getHealthStatus).toBe('function');
      const health = (channelAsAny.getHealthStatus as () => unknown)();
      expect(health).toMatchObject({
        channel: 'telegram',
        status: expect.stringMatching(
          /^(connected|connecting|disconnected|error)$/,
        ),
        since: expect.any(String),
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Tier 4: Stub detection
  // AC-5 / Invariant INV-1: Verify sender NOT on allowlist results in message
  // being dropped at ORCHESTRATOR level — adapter still delivers.
  //
  // This tier catches a stubbed or over-eager adapter that drops messages on its
  // own without forwarding to the orchestrator.
  // ---------------------------------------------------------------------------

  describe('Tier 4 — Stub detection', () => {
    // -------------------------------------------------------------------------
    // AC-5 / Stub-1: Adapter must NOT implement sender filtering itself
    //
    // The spec invariant INV-1: "No adapter gates, filters, or drops messages
    // based on sender identity." A stubbed adapter that always delivers would
    // pass Tier 1 Unit-4. A stubbed adapter that always drops would fail here.
    //
    // We verify the adapter delivers to onMessage even when the orchestrator
    // would subsequently drop it — proving the adapter is doing pass-through.
    // -------------------------------------------------------------------------

    it('[AC-5 / Stub-1a] message from unknown sender reaches onMessage (adapter passes through)', async () => {
      // This test would fail if the adapter implemented its own allowlist check.
      // A stub that always delivers would pass this too — see Stub-1b for the
      // complement.
      const receivedBySink: unknown[] = [];
      const opts = createTestOpts({
        onMessage: vi.fn((_jid: string, msg: unknown) => {
          receivedBySink.push(msg);
        }),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      // Sender with no known allowlist entry
      const ctx = createTextCtx({
        text: 'unlisted sender message',
        fromId: 777888999,
      });
      await triggerTextMessage(ctx);

      // The ADAPTER must call onMessage. The ORCHESTRATOR would gate it.
      expect(receivedBySink).toHaveLength(1);
      expect(opts.onMessage).toHaveBeenCalledTimes(1);
    });

    it('[AC-5 / Stub-1b] message from listed sender also reaches onMessage (adapter is not the gate)', async () => {
      // Complement of Stub-1a: an adapter that selectively passes only allowlisted
      // senders would fail Stub-1a but might pass Stub-1b. Both together confirm
      // the adapter delivers all messages unconditionally.
      const receivedBySink: unknown[] = [];
      const opts = createTestOpts({
        onMessage: vi.fn((_jid: string, msg: unknown) => {
          receivedBySink.push(msg);
        }),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      // "Known" sender ID (same as the mock default)
      const ctx = createTextCtx({
        text: 'listed sender message',
        fromId: 99001,
      });
      await triggerTextMessage(ctx);

      expect(receivedBySink).toHaveLength(1);
      expect(opts.onMessage).toHaveBeenCalledTimes(1);
    });

    it('[AC-5 / Stub-1c] both allowlisted and non-allowlisted senders reach onMessage in same session', async () => {
      // Definitive stub-detection: if the adapter filters by sender, one of these
      // two messages will not arrive. Both must arrive.
      const receivedBySink: unknown[] = [];
      const opts = createTestOpts({
        onMessage: vi.fn((_jid: string, msg: unknown) => {
          receivedBySink.push(msg);
        }),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      // Sender 1 — "known" (same as default test fixtures use)
      const ctx1 = createTextCtx({ text: 'from known', fromId: 99001 });
      // Sender 2 — completely unknown
      const ctx2 = createTextCtx({ text: 'from unknown', fromId: 123456789 });

      await triggerTextMessage(ctx1);
      await triggerTextMessage(ctx2);

      // Both must arrive at onMessage — the adapter does not gate
      expect(receivedBySink).toHaveLength(2);
      const texts = receivedBySink.map(
        (m) =>
          (m as Record<string, unknown>).text ??
          (m as Record<string, unknown>).content,
      );
      expect(texts).toContain('from known');
      expect(texts).toContain('from unknown');
    });

    it('[Stub-1d] [stub-detection] orchestrator-level gating can drop a message that adapter delivered', async () => {
      // This test verifies the ORCHESTRATOR can gate messages after adapter
      // delivery. We simulate this by wrapping onMessage in an orchestrator-like
      // allowlist check and confirming a non-listed sender is dropped by the
      // wrapper while the adapter still called onMessage.
      //
      // This proves: adapter = pass-through, orchestrator = policy enforcer.

      const orchestratorSink: unknown[] = [];
      const adapterDelivered: unknown[] = [];

      // Simulate orchestrator-level allowlist: only userId 99001 is allowed
      const VALID_USERS = new Set(['99001']);

      const opts = createTestOpts({
        onMessage: vi.fn((_jid: string, msg: unknown) => {
          // Record that the ADAPTER delivered the message
          adapterDelivered.push(msg);

          // Orchestrator-level gating (simulate what index.ts does)
          const senderId =
            ((msg as Record<string, unknown>).sender as string) ?? '';
          if (!VALID_USERS.has(senderId)) {
            // Orchestrator drops it — does not add to orchestratorSink
            return;
          }
          orchestratorSink.push(msg);
        }),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      // Non-allowlisted sender
      const ctx = createTextCtx({
        text: 'drop me at orchestrator',
        fromId: 888888,
      });
      await triggerTextMessage(ctx);

      // Adapter delivered to onMessage (pass-through)
      expect(adapterDelivered).toHaveLength(1);
      // Orchestrator dropped it (not in orchestratorSink)
      expect(orchestratorSink).toHaveLength(0);
    });

    it('[Stub-1e] [stub-detection] adapter does not inspect or act on TELEGRAM_VALID_USERS env var', async () => {
      // If the adapter reads TELEGRAM_VALID_USERS itself and filters — it is
      // violating the spec. Set TELEGRAM_VALID_USERS to exclude all senders
      // and verify the adapter STILL delivers to onMessage.
      const originalValidUsers = process.env.TELEGRAM_VALID_USERS;
      process.env.TELEGRAM_VALID_USERS = '00000'; // an ID that no test sender uses

      try {
        const opts = createTestOpts();
        const channel = new TelegramChannel('test-token', opts);
        await channel.connect();

        const ctx = createTextCtx({
          text: 'should still arrive',
          fromId: 99001,
        });
        await triggerTextMessage(ctx);

        // Adapter must not have read TELEGRAM_VALID_USERS to gate this message
        expect(opts.onMessage).toHaveBeenCalledTimes(1);
      } finally {
        if (originalValidUsers === undefined) {
          delete process.env.TELEGRAM_VALID_USERS;
        } else {
          process.env.TELEGRAM_VALID_USERS = originalValidUsers;
        }
      }
    });
  });
});
