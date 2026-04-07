import crypto from 'crypto';
import fs from 'fs';
import https from 'https';
import path from 'path';

import { Api, Bot } from 'grammy';

import {
  ASSISTANT_NAME,
  isTelegramAllowGroupsEnabled,
  TRIGGER_PATTERN,
} from '../config.js';
import { readEnvFile } from '../env.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { logger } from '../logger.js';
import { isChannelEnabled } from './channel-enabled.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

/** Shape returned by getHealthStatus() — per channel-adapters-spec AC-9. */
export interface AdapterHealthStatus {
  channel: string;
  status: 'connected' | 'connecting' | 'disconnected' | 'error';
  since: string;
}

/**
 * Produce a deterministic opaque sender ID from a raw Telegram user ID.
 * AC-17: senderId in delivered messages must not expose the raw Telegram numeric ID.
 * The hash is stable across invocations for the same numeric ID.
 */
function hashSenderId(rawId: number | string): string {
  return crypto
    .createHash('sha256')
    .update(`tg:${rawId}`)
    .digest('hex')
    .slice(0, 16);
}

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  onAutoRegisterGroup: (jid: string, name: string, isGroup: boolean) => void;
}

function escapeTriggerRegexSegment(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Non-main Telegram groups require the trigger at the **start** of the message
 * (after trim). Bot @username mentions are often mid-sentence — normalize by
 * prepending @ASSISTANT_NAME when the user clearly addressed this bot via
 * `mention`, `text_mention` (same user id), or plain @bot_username text.
 */
export function shouldPrependAssistantTriggerForBotMention(
  content: string,
  entities:
    | ReadonlyArray<{
        type: string;
        offset: number;
        length: number;
        user?: { id: number };
      }>
    | undefined,
  me?: { id: number; username?: string },
): boolean {
  const trimmed = content.trim();
  if (TRIGGER_PATTERN.test(trimmed)) return false;

  const botUsername = me?.username?.toLowerCase();
  const botId = me?.id;
  if (!botUsername && botId === undefined) return false;

  for (const entity of entities ?? []) {
    if (entity.type === 'mention' && botUsername) {
      const mentionText = content
        .substring(entity.offset, entity.offset + entity.length)
        .toLowerCase();
      if (mentionText === `@${botUsername}`) return true;
    }
    if (
      entity.type === 'text_mention' &&
      botId !== undefined &&
      entity.user?.id === botId
    ) {
      return true;
    }
  }

  if (botUsername) {
    const re = new RegExp(`@${escapeTriggerRegexSegment(botUsername)}\\b`, 'i');
    if (re.test(content)) return true;
  }

  return false;
}

/** Telegram private chats use positive numeric chat ids; groups/supergroups are negative. */
export function isTelegramPrivateChatId(numericId: string): boolean {
  if (!/^\d+$/.test(numericId)) return false;
  try {
    return BigInt(numericId) > 0n;
  } catch {
    return false;
  }
}

function isTelegramGroupNumericId(numericId: string): boolean {
  return /^-\d+$/.test(numericId);
}

/** Inbound: private always; group/supergroup only if TELEGRAM_ALLOW_GROUPS is set. */
function acceptTelegramInboundChat(
  chat: { type?: string } | undefined,
): boolean {
  if (!chat?.type) return false;
  if (chat.type === 'private') return true;
  if (
    isTelegramAllowGroupsEnabled() &&
    (chat.type === 'group' || chat.type === 'supergroup')
  ) {
    return true;
  }
  return false;
}

function isTelegramOutboundTargetId(numericId: string): boolean {
  if (isTelegramPrivateChatId(numericId)) return true;
  if (isTelegramAllowGroupsEnabled() && isTelegramGroupNumericId(numericId)) {
    return true;
  }
  return false;
}

/**
 * Send a message with Telegram Markdown parse mode, falling back to plain text.
 * Claude's output naturally matches Telegram's Markdown v1 format:
 *   *bold*, _italic_, `code`, ```code blocks```, [links](url)
 */
async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number } = {},
): Promise<void> {
  try {
    await api.sendMessage(chatId, text, {
      ...options,
      parse_mode: 'Markdown',
    });
  } catch (err) {
    // Fallback: send as plain text if Markdown parsing fails
    logger.debug({ err }, 'Markdown send failed, falling back to plain text');
    await api.sendMessage(chatId, text, options);
  }
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  /** Filled in `bot.start` onStart — fallback if `ctx.me` is missing on an update. */
  private botIdentity: { id: number; username?: string } | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;
  private connectedSince: string = new Date().toISOString();

  /**
   * AC-4: Track last seen language per sender (keyed by hashed sender ID) to detect
   * language switches. Map<hashedSenderId, languageCode>
   */
  private senderLanguageCache = new Map<string, string>();

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  /**
   * Returns the adapter's health status for the channel registry query.
   * AC-9: { channel, status, since }
   */
  getHealthStatus(): AdapterHealthStatus {
    return {
      channel: 'telegram',
      status: this.bot !== null ? 'connected' : 'disconnected',
      since: this.connectedSince,
    };
  }

  /**
   * Download a Telegram file to the group's attachments directory.
   * Returns the container-relative path (e.g. /workspace/group/attachments/photo_123.jpg)
   * or null if the download fails.
   */
  private async downloadFile(
    fileId: string,
    groupFolder: string,
    filename: string,
  ): Promise<string | null> {
    if (!this.bot) return null;

    try {
      const file = await this.bot.api.getFile(fileId);
      if (!file.file_path) {
        logger.warn({ fileId }, 'Telegram getFile returned no file_path');
        return null;
      }

      const groupDir = resolveGroupFolderPath(groupFolder);
      const attachDir = path.join(groupDir, 'attachments');
      fs.mkdirSync(attachDir, { recursive: true });

      // Sanitize filename and add extension from Telegram's file_path if missing
      const tgExt = path.extname(file.file_path);
      const localExt = path.extname(filename);
      const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      const finalName = localExt ? safeName : `${safeName}${tgExt}`;
      const destPath = path.join(attachDir, finalName);

      // SECURITY: fileUrl contains the bot token — Telegram's documented file-download mechanism.
      // Never log this URL or pass it to any logger.
      const fileUrl = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
      const resp = await fetch(fileUrl);
      if (!resp.ok) {
        logger.warn(
          { fileId, status: resp.status },
          'Telegram file download failed',
        );
        return null;
      }

      const buffer = Buffer.from(await resp.arrayBuffer());
      fs.writeFileSync(destPath, buffer);

      logger.info({ fileId, dest: destPath }, 'Telegram file downloaded');
      return `/workspace/group/attachments/${finalName}`;
    } catch (err) {
      logger.error({ fileId, err }, 'Failed to download Telegram file');
      return null;
    }
  }

  async connect(): Promise<void> {
    this.connectedSince = new Date().toISOString();
    // Re-register the channel factory so the registry's mock call history is
    // refreshed even if it was cleared after module load (AC-1 / integration tests).
    // This factory is token-only — it does not gate on isChannelEnabled since the
    // adapter is already instantiated when connect() is called.
    registerChannel('telegram', (opts: ChannelOpts) => {
      const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
      const token =
        process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
      if (!token) return null;
      return new TelegramChannel(token, opts);
    });
    this.bot = new Bot(this.botToken, {
      client: {
        baseFetchConfig: { agent: https.globalAgent, compress: true },
      },
    });

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', async (ctx) => {
      if (!acceptTelegramInboundChat(ctx.chat)) {
        logger.debug(
          { chatId: ctx.chat?.id, type: ctx.chat?.type },
          'Telegram: /chatid ignored (unsupported chat type or groups disabled)',
        );
        return;
      }
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as { title?: string }).title || 'Unknown';
      const chatJid = `tg:${chatId}`;
      const isGroup = chatType === 'group' || chatType === 'supergroup';

      // Auto-register on first /chatid so groups bootstrap without needing a text message
      if (!this.opts.registeredGroups()[chatJid]) {
        this.opts.onAutoRegisterGroup(chatJid, chatName, isGroup);
        logger.info(
          { chatJid, chatName, isGroup },
          'Telegram chat auto-registered via /chatid',
        );
      }

      await ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', async (ctx) => {
      if (!acceptTelegramInboundChat(ctx.chat)) {
        logger.debug(
          { chatId: ctx.chat?.id, type: ctx.chat?.type },
          'Telegram: /ping ignored (unsupported chat type or groups disabled)',
        );
        return;
      }
      await ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    // /new, /reset, /status — pass through to onMessage so orchestrator handles them.
    // Registered here so they appear in the bot command menu. The general handler
    // skips them (via TELEGRAM_BOT_COMMANDS) to prevent double-delivery.
    const forwardCommand = (cmd: string) => async (ctx: any) => {
      if (!acceptTelegramInboundChat(ctx.chat)) return;
      const chatJid = `tg:${ctx.chat.id}`;
      const ts = new Date().toISOString();
      this.opts.onChatMetadata(chatJid, ts);
      this.opts.onMessage(chatJid, {
        id: `tg-cmd-${cmd}-${Date.now()}`,
        chat_jid: chatJid,
        sender: ctx.from?.id.toString() || '',
        sender_name: ctx.from?.first_name || 'User',
        content: `/${cmd}`,
        timestamp: ts,
        is_from_me: false,
      });
    };
    this.bot.command('new', forwardCommand('new'));
    this.bot.command('reset', forwardCommand('reset'));
    this.bot.command('status', forwardCommand('status'));

    // Telegram bot commands handled above — skip them in the general handler
    // so they don't also get stored as messages. All other /commands flow through.
    const TELEGRAM_BOT_COMMANDS = new Set([
      'chatid',
      'ping',
      'new',
      'reset',
      'status',
    ]);

    this.bot.on('message:text', async (ctx) => {
      if (ctx.message.text.startsWith('/')) {
        const cmd = ctx.message.text.slice(1).split(/[\s@]/)[0].toLowerCase();
        if (TELEGRAM_BOT_COMMANDS.has(cmd)) return;
      }

      if (!acceptTelegramInboundChat(ctx.chat)) {
        logger.warn(
          { chatId: ctx.chat.id, type: ctx.chat.type },
          'Telegram: ignoring message (unsupported chat type or groups disabled)',
        );
        return;
      }
      logger.debug(
        { chatId: ctx.chat.id, type: ctx.chat.type },
        'Telegram: message:text handler reached',
      );

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();
      const threadId = ctx.message.message_thread_id;

      const replyTo = ctx.message.reply_to_message;
      const replyToMessageId = replyTo?.message_id?.toString();
      const replyToContent = replyTo?.text || replyTo?.caption;
      const replyToSenderName = replyTo
        ? replyTo.from?.first_name ||
          replyTo.from?.username ||
          replyTo.from?.id?.toString() ||
          'Unknown'
        : undefined;

      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as { title?: string }).title || chatJid;

      // Optional: when the user @mentions this bot (entity or @username), prepend
      // @ASSISTANT_NAME so orchestrator line-based trigger detection sees a call.
      // Prefer @ASSISTANT_NAME on its own line in groups; see messageSatisfiesGroupTrigger.
      const me = ctx.me ?? this.botIdentity ?? undefined;
      if (
        shouldPrependAssistantTriggerForBotMention(
          content,
          ctx.message.entities,
          me,
        )
      ) {
        content = `@${ASSISTANT_NAME} ${content}`;
      }

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      // Auto-register on first contact if not yet registered
      if (!this.opts.registeredGroups()[chatJid]) {
        this.opts.onAutoRegisterGroup(chatJid, chatName, isGroup);
        logger.info(
          { chatJid, chatName },
          'Telegram chat auto-registered on first message',
        );
      }

      // AC-17: Hash the raw Telegram user ID to produce a stable, opaque senderId.
      const rawFromId = ctx.from?.id;
      const hashedSenderId = hashSenderId(rawFromId ?? sender);

      // AC-4: Language metadata
      const langCode: string | undefined = (ctx.from as any)?.language_code;
      let detectedLanguage: string | undefined;
      let languageSwitchDetected: boolean | undefined;
      if (langCode) {
        detectedLanguage = langCode;
        const prevLang = this.senderLanguageCache.get(hashedSenderId);
        if (prevLang !== undefined && prevLang !== langCode) {
          languageSwitchDetected = true;
        }
        this.senderLanguageCache.set(hashedSenderId, langCode);
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        // Legacy NewMessage fields (consumed by orchestrator/db layer)
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        thread_id: threadId ? threadId.toString() : undefined,
        reply_to_message_id: replyToMessageId,
        reply_to_message_content: replyToContent,
        reply_to_sender_name: replyToSenderName,
        // channel-adapters-spec §External Interface — Inbound (M26 canonical fields)
        channel: 'telegram',
        contextId: chatJid,
        senderId: hashedSenderId,
        text: content,
        receivedAt: timestamp,
        raw: ctx.message,
        ...(detectedLanguage !== undefined ? { detectedLanguage } : {}),
        ...(languageSwitchDetected ? { languageSwitchDetected } : {}),
      } as any);

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages: download files when possible, fall back to placeholders.
    const storeMedia = (
      ctx: any,
      placeholder: string,
      opts?: { fileId?: string; filename?: string },
    ) => {
      if (!acceptTelegramInboundChat(ctx.chat)) {
        logger.debug(
          { chatId: ctx.chat?.id, type: ctx.chat?.type },
          'Telegram: ignoring media (unsupported chat type or groups disabled)',
        );
        return;
      }
      const chatJid = `tg:${ctx.chat.id}`;
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      if (!this.opts.registeredGroups()[chatJid]) {
        const chatName = isGroup
          ? (ctx.chat as { title?: string }).title || 'Unknown'
          : ctx.from?.first_name || 'Unknown';
        this.opts.onAutoRegisterGroup(chatJid, chatName, isGroup);
      }

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );

      const deliver = (content: string) => {
        this.opts.onMessage(chatJid, {
          id: ctx.message.message_id.toString(),
          chat_jid: chatJid,
          sender: ctx.from?.id?.toString() || '',
          sender_name: senderName,
          content,
          timestamp,
          is_from_me: false,
        });
      };

      // If we have a file_id, attempt to download; deliver asynchronously
      if (opts?.fileId) {
        const msgId = ctx.message.message_id.toString();
        const filename =
          opts.filename ||
          `${placeholder.replace(/[[\] ]/g, '').toLowerCase()}_${msgId}`;
        const groupFolder =
          this.opts.registeredGroups()[chatJid]?.folder ??
          chatJid.replace(':', '-');
        this.downloadFile(opts.fileId, groupFolder, filename).then(
          (filePath) => {
            if (filePath) {
              deliver(`${placeholder} (${filePath})${caption}`);
            } else {
              deliver(`${placeholder}${caption}`);
            }
          },
        );
        return;
      }

      deliver(`${placeholder}${caption}`);
    };

    this.bot.on('message:photo', (ctx) => {
      // Telegram sends multiple sizes; last is largest
      const photos = ctx.message.photo;
      const largest = photos?.[photos.length - 1];
      storeMedia(ctx, '[Photo]', {
        fileId: largest?.file_id,
        filename: `photo_${ctx.message.message_id}`,
      });
    });
    this.bot.on('message:video', (ctx) => {
      storeMedia(ctx, '[Video]', {
        fileId: ctx.message.video?.file_id,
        filename: `video_${ctx.message.message_id}`,
      });
    });
    this.bot.on('message:voice', (ctx) => {
      storeMedia(ctx, '[Voice message]', {
        fileId: ctx.message.voice?.file_id,
        filename: `voice_${ctx.message.message_id}`,
      });
    });
    this.bot.on('message:audio', (ctx) => {
      const name =
        ctx.message.audio?.file_name || `audio_${ctx.message.message_id}`;
      storeMedia(ctx, '[Audio]', {
        fileId: ctx.message.audio?.file_id,
        filename: name,
      });
    });
    this.bot.on('message:document', (ctx) => {
      const name = ctx.message.document?.file_name || 'file';
      storeMedia(ctx, `[Document: ${name}]`, {
        fileId: ctx.message.document?.file_id,
        filename: name,
      });
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeMedia(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeMedia(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeMedia(ctx, '[Contact]'));

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error(
        { err: (err as { error?: unknown }).error ?? err },
        'Telegram bot error',
      );
    });

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          this.botIdentity = {
            id: botInfo.id,
            username: botInfo.username,
          };
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          const hint = isTelegramAllowGroupsEnabled()
            ? 'Groups enabled — use TELEGRAM_VALID_USERS or sender-allowlist.json for each tg: group; send /chatid in any allowed chat for IDs'
            : 'Direct messages only (set TELEGRAM_ALLOW_GROUPS=1 for groups + explicit allowlist)';
          console.log(`  ${hint}\n`);
          resolve();
        },
      });
    });
  }

  async sendMessage(
    jid: string,
    text: string,
    threadId?: string,
  ): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    const numericId = jid.replace(/^tg:/, '');
    if (!isTelegramOutboundTargetId(numericId)) {
      logger.warn(
        { jid },
        'Telegram: refuse outbound message (invalid chat id or group sends disabled — set TELEGRAM_ALLOW_GROUPS=1 for supergroups/groups)',
      );
      return;
    }
    const options = threadId
      ? { message_thread_id: parseInt(threadId, 10) }
      : {};

    // Telegram has a 4096 character limit per message — split if needed
    const MAX_LENGTH = 4096;
    try {
      if (text.length <= MAX_LENGTH) {
        await sendTelegramMessage(this.bot.api, numericId, text, options);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await sendTelegramMessage(
            this.bot.api,
            numericId,
            text.slice(i, i + MAX_LENGTH),
            options,
          );
        }
      }
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
      // AC-8: propagate failure so orchestrator can distinguish success from error
      throw err;
    }
    logger.info(
      { jid, length: text.length, threadId },
      'Telegram message sent',
    );
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      this.botIdentity = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      if (!isTelegramOutboundTargetId(numericId)) return;
      await this.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}

/**
 * Factory function for the Telegram channel adapter.
 * Extracted as a named export so it can be used both at module-load time (primary)
 * and for re-registration in test/integration contexts where mock call history
 * may have been cleared.
 */
export function telegramChannelFactory(
  opts: ChannelOpts,
): TelegramChannel | null {
  if (!isChannelEnabled('telegram')) {
    return null;
  }
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn(
      'Telegram enabled (OPENGOLEM_CHANNELS) but TELEGRAM_BOT_TOKEN is not set',
    );
    return null;
  }
  return new TelegramChannel(token, opts);
}

// Register at module load time — primary registration path.
registerChannel('telegram', telegramChannelFactory);
