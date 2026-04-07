import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import './bootstrap.js';
import './channels/index.js';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  DEFAULT_TRIGGER,
  GROUPS_DIR,
  INBOUND_QUEUE_MAX_DEPTH,
  INBOUND_RATE_LIMIT_PER_SENDER,
  MAX_MESSAGES_PER_PROMPT,
  messageSatisfiesGroupTrigger,
  POLL_INTERVAL,
  TIMEZONE,
  getTelegramValidUserSet,
  isTelegramAllowGroupsEnabled,
} from './config.js';
import {
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
  type AvailableGroup,
  type ContainerOutput,
} from './container-runner.js';
import {
  startCredentialProxy,
  stopCredentialProxy,
} from './credential-proxy.js';
import {
  ensureContainerRuntimeRunning,
  cleanupOrphans,
} from './container-runtime.js';
import {
  catoCheck,
  startCatoInlineHook,
  stopCatoInlineHook,
} from './cato/inline.js';
import {
  ensureCatoGroupFolder,
  startCatoScheduledAudit,
  stopCatoScheduledAudit,
} from './cato/scheduled-audit.js';
import {
  countMessagesSince,
  deleteSession,
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getLastBotMessageTimestamp,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { startHealthServer, stopHealthServer } from './health.js';
import { logFlagEvent } from './inspector/audit.js';
import { startIpcWatcher, type IpcDeps } from './ipc.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import { startBroker, type BrokerHandle } from './broker/server.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import { isChannelEnabled } from './channels/channel-enabled.js';
import { TUI_CONSOLE_JID } from './channels/tui.js';
import type { Channel, NewMessage, RegisteredGroup } from './types.js';
import { seedTelegramDmGroups } from './seed-groups.js';
import {
  filterMessagesForTelegramAllowlist,
  isSenderAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
  telegramGroupHasExplicitAllowlist,
  isTelegramGroupSupergroupJid,
} from './sender-allowlist.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import { startSchedulerLoop } from './task-scheduler.js';

export { escapeXml, formatMessages } from './router.js';

const STALE_SESSION_RE =
  /no conversation found|ENOENT.*\.jsonl|session.*not found/i;

// Patterns from the Claude Code CLI that indicate a credential/auth problem
// in the container. These must never reach the end user verbatim — they expose
// internal tooling details and the suggested action (run /login) is impossible
// from a Telegram DM or any external channel.
const CREDENTIAL_ERROR_RE =
  /not logged in|please run \/login|invalid api key|unauthorized|authentication failed/i;
const CREDENTIAL_ERROR_USER_MSG =
  "I'm unable to respond right now — my credentials need attention. " +
  'Please ask an administrator to check the API key configuration.';

let lastTimestamp = '';
let lastAgentTimestamp: Record<string, string> = {};
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
const channels: Channel[] = [];
const queue = new GroupQueue();
let broker: BrokerHandle | null = null;

let messageLoopStarted = false;

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') ?? '';
  const raw = getRouterState('last_agent_timestamp');
  if (raw) {
    try {
      lastAgentTimestamp = JSON.parse(raw) as Record<string, string>;
    } catch {
      lastAgentTimestamp = {};
    }
  } else {
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = { ...groups };
}

export function getAvailableGroups(): AvailableGroup[] {
  return getAllChats()
    .filter((c) => c.jid !== '__group_sync__' && Number(c.is_group) === 1)
    .map((c) => ({
      jid: c.jid,
      name: c.name || c.jid,
      lastActivity: c.last_message_time,
      isRegistered: c.jid in registeredGroups,
    }));
}

// Per-sender sliding-window timestamps for rate limiting (F-1, M28).
// Key: senderId (hashed). Value: array of arrival timestamps (ms).
const senderRateWindows = new Map<string, number[]>();
const RATE_WINDOW_MS = 60_000;

function getOrRecoverCursor(chatJid: string): string {
  const existing = lastAgentTimestamp[chatJid];
  if (existing) return existing;
  const recovered = getLastBotMessageTimestamp(chatJid, ASSISTANT_NAME);
  if (recovered) {
    lastAgentTimestamp[chatJid] = recovered;
    saveState();
    return recovered;
  }
  return '';
}

function copyClaudeTemplate(groupDir: string, group: RegisteredGroup): void {
  const dest = path.join(groupDir, 'CLAUDE.md');
  if (fs.existsSync(dest)) return;
  const templatePath =
    group.isMain === true
      ? path.join(GROUPS_DIR, 'main', 'CLAUDE.md')
      : path.join(GROUPS_DIR, 'global', 'CLAUDE.md');
  let body: string;
  try {
    body = fs.readFileSync(templatePath, 'utf8');
  } catch {
    return;
  }
  if (ASSISTANT_NAME !== 'Alef') {
    body = body
      .replace(/# Alef/g, `# ${ASSISTANT_NAME}`)
      .replace(/You are Alef/g, `You are ${ASSISTANT_NAME}`);
  }
  fs.writeFileSync(dest, body, 'utf8');
}

export function registerGroup(jid: string, group: RegisteredGroup): void {
  try {
    const groupDir = resolveGroupFolderPath(group.folder);
    fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });
    copyClaudeTemplate(groupDir, group);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'registerGroup: invalid folder, skipping filesystem setup',
    );
    return;
  }
  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);
}

function seedTuiGroupIfNeeded(): void {
  if (!isChannelEnabled('tui')) return;
  if (registeredGroups[TUI_CONSOLE_JID]) return;
  registerGroup(TUI_CONSOLE_JID, {
    name: 'Console',
    folder: 'tui',
    trigger: DEFAULT_TRIGGER,
    added_at: new Date().toISOString(),
    requiresTrigger: false,
    isMain: true,
  });
}

function seedTelegramDmGroupsIfNeeded(): void {
  seedTelegramDmGroups({
    isChannelEnabled,
    getTelegramValidUserSet,
    registeredGroups: () => registeredGroups,
    registerGroup,
    defaultTrigger: DEFAULT_TRIGGER,
  });
}

function mapTasksForSnapshot() {
  return getAllTasks().map((t) => ({
    id: t.id,
    groupFolder: t.group_folder,
    prompt: t.prompt,
    script: t.script,
    schedule_type: t.schedule_type,
    schedule_value: t.schedule_value,
    status: t.status,
    next_run: t.next_run,
  }));
}

function onTasksChanged(): void {
  const rows = mapTasksForSnapshot();
  for (const g of Object.values(registeredGroups)) {
    writeTasksSnapshot(g.folder, g.isMain === true, rows);
  }
}

function telegramFolderFromJid(jid: string): string {
  const rest = jid.slice(3);
  return rest.startsWith('-') ? `tg-g-${rest.slice(1)}` : `tg-${rest}`;
}

function onAutoRegisterGroup(
  jid: string,
  name: string,
  isGroup: boolean,
): void {
  if (registeredGroups[jid]) return;
  if (!jid.startsWith('tg:')) return;
  registerGroup(jid, {
    name,
    folder: telegramFolderFromJid(jid),
    trigger: DEFAULT_TRIGGER,
    added_at: new Date().toISOString(),
    requiresTrigger: isGroup,
    isMain: false,
  });
}

async function handleRemoteControl(
  cmd: 'start' | 'stop',
  chatJid: string,
  channel: Channel,
  sender: string,
): Promise<void> {
  const group = registeredGroups[chatJid];
  if (!group?.isMain) return;

  if (cmd === 'stop') {
    const r = stopRemoteControl();
    await channel.sendMessage(
      chatJid,
      r.ok ? 'Remote control stopped.' : (r as { error: string }).error,
    );
    return;
  }

  let workDir: string;
  try {
    workDir = resolveGroupFolderPath(group.folder);
  } catch {
    await channel.sendMessage(chatJid, 'Remote control: invalid group folder.');
    return;
  }

  const r = await startRemoteControl(sender, chatJid, workDir);
  await channel.sendMessage(
    chatJid,
    r.ok ? `Remote control: ${r.url}` : r.error,
  );
}

function buildChannelOpts() {
  return {
    onMessage: async (chatJid: string, msg: NewMessage) => {
      const cfg = loadSenderAllowlist();

      if (
        isTelegramGroupSupergroupJid(chatJid) &&
        isTelegramAllowGroupsEnabled() &&
        !telegramGroupHasExplicitAllowlist(chatJid, cfg)
      ) {
        return;
      }

      const text = msg.content?.trim() ?? '';
      if (text === '/new' || text === '/reset') {
        const g = registeredGroups[chatJid];
        if (g) {
          delete sessions[g.folder];
          deleteSession(g.folder);
          saveState();
          queue.stopCurrentContainer(chatJid);
        }
        const ch = findChannel(channels, chatJid);
        if (ch)
          await ch.sendMessage(
            chatJid,
            `Session cleared. Next message starts a fresh conversation with ${ASSISTANT_NAME}.`,
          );
        return;
      }

      if (text === '/status') {
        const g = registeredGroups[chatJid];
        const sid = g ? sessions[g.folder] : undefined;
        const lines = [
          `${ASSISTANT_NAME} is running.`,
          `Active containers: ${queue.getActiveCount()}`,
          `Session: ${sid ? 'active' : 'none (next message starts fresh)'}`,
        ];
        if (g?.isMain)
          lines.push(
            `Registered groups: ${Object.keys(registeredGroups).length}`,
          );
        const ch = findChannel(channels, chatJid);
        if (ch) await ch.sendMessage(chatJid, lines.join('\n'));
        return;
      }

      if (text.startsWith('/remote-control-end')) {
        const g = registeredGroups[chatJid];
        if (!g?.isMain) return;
        if (
          chatJid.startsWith('tg:') &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          return;
        }
        const ch = findChannel(channels, chatJid);
        if (ch) await handleRemoteControl('stop', chatJid, ch, msg.sender);
        return;
      }
      if (text.startsWith('/remote-control')) {
        const g = registeredGroups[chatJid];
        if (!g?.isMain) return;
        if (
          chatJid.startsWith('tg:') &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          return;
        }
        const ch = findChannel(channels, chatJid);
        if (ch) await handleRemoteControl('start', chatJid, ch, msg.sender);
        return;
      }

      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          return;
        }
      }

      // F-1 (M28): per-sender sliding-window rate limit
      if (!msg.is_from_me && !msg.is_bot_message) {
        const senderId = msg.sender ?? 'unknown';
        const now = Date.now();
        const window = (senderRateWindows.get(senderId) ?? []).filter(
          (t) => now - t < RATE_WINDOW_MS,
        );
        if (window.length >= INBOUND_RATE_LIMIT_PER_SENDER) {
          logger.warn(
            { senderId: senderId.slice(0, 16), chatJid },
            'inbound rate limit exceeded — message dropped',
          );
          return;
        }
        window.push(now);
        senderRateWindows.set(senderId, window);
      }

      // F-1 (M28): per-group queue depth cap
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cursor = getOrRecoverCursor(chatJid);
        const pending = countMessagesSince(chatJid, cursor);
        if (pending >= INBOUND_QUEUE_MAX_DEPTH) {
          logger.warn(
            { chatJid, pending, limit: INBOUND_QUEUE_MAX_DEPTH },
            'queue depth limit exceeded — message dropped',
          );
          return;
        }
      }

      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channelMeta?: string,
      isGroup?: boolean,
    ) => {
      storeChatMetadata(chatJid, timestamp, name, channelMeta, isGroup);
    },
    registeredGroups: () => registeredGroups,
    onAutoRegisterGroup,
  };
}

function recoverPendingMessages(): void {
  for (const jid of Object.keys(registeredGroups)) {
    const pending = getMessagesSince(
      jid,
      getOrRecoverCursor(jid),
      ASSISTANT_NAME,
      MAX_MESSAGES_PER_PROMPT,
    );
    if (pending.length > 0) queue.enqueueMessageCheck(jid);
  }
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onStream?: (text: string) => Promise<void>,
): Promise<'success' | 'error'> {
  const rows = mapTasksForSnapshot();
  writeTasksSnapshot(group.folder, group.isMain === true, rows);
  const registeredJids = new Set(Object.keys(registeredGroups));
  writeGroupsSnapshot(
    group.folder,
    group.isMain === true,
    getAvailableGroups(),
    registeredJids,
  );

  // Guard: clear sessions over 300KB before spawning — large sessions cause
  // API requests to exceed the credential proxy's upstream timeout (empirical:
  // 467KB/136 turns caused repeated 30-min container timeouts with no output).
  const MAX_SESSION_BYTES = 300_000;
  const sessionId = sessions[group.folder];
  if (sessionId) {
    const sessionFile = path.join(
      DATA_DIR,
      'sessions',
      group.folder,
      '.claude',
      'projects',
      '-workspace-group',
      `${sessionId}.jsonl`,
    );
    try {
      const { size } = fs.statSync(sessionFile);
      if (size > MAX_SESSION_BYTES) {
        logger.warn(
          { group: group.name, sessionSizeBytes: size, sessionId },
          'Session too large — clearing before spawn to prevent proxy timeout',
        );
        delete sessions[group.folder];
        deleteSession(group.folder);
      }
    } catch {
      // File not found — stale session detection in container-runner handles this
    }
  }

  const wrappedOnOutput = onStream
    ? async (out: ContainerOutput) => {
        if (out.newSessionId) {
          sessions[group.folder] = out.newSessionId;
          setSession(group.folder, out.newSessionId);
          saveState();
        }
        if (out.result) {
          const raw = formatOutbound(out.result);
          const isCredentialError = CREDENTIAL_ERROR_RE.test(raw);
          if (isCredentialError) {
            logger.error(
              { chatJid, groupFolder: group.folder },
              'Container returned credential error — check ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN in .env',
            );
          }
          const t = isCredentialError ? CREDENTIAL_ERROR_USER_MSG : raw;
          if (t.trimStart().startsWith('[FLAG]')) {
            logFlagEvent({
              groupJid: chatJid,
              groupFolder: group.folder,
              assertivenessLevel: group.assertivenessLevel ?? 10,
              responseSnippet: t.slice(0, 200),
            });
          }
          await onStream(t);
        }
      }
    : undefined;

  const result = await runContainerAgent(
    group,
    {
      prompt,
      sessionId,
      groupFolder: group.folder,
      chatJid,
      isMain: group.isMain === true,
      assistantName: ASSISTANT_NAME,
    },
    (proc, containerName) => {
      queue.registerProcess(chatJid, proc, containerName, group.folder);
    },
    wrappedOnOutput,
  );

  if (result.newSessionId) {
    sessions[group.folder] = result.newSessionId;
    setSession(group.folder, result.newSessionId);
    saveState();
  }

  if (result.status === 'error') {
    const err = result.error ?? '';
    if (STALE_SESSION_RE.test(err)) {
      delete sessions[group.folder];
      deleteSession(group.folder);
      saveState();
    }
    return 'error';
  }
  return 'success';
}

async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  const channel = findChannel(channels, chatJid);
  if (!group || !channel) return true;

  const fullBatch = getMessagesSince(
    chatJid,
    getOrRecoverCursor(chatJid),
    ASSISTANT_NAME,
    MAX_MESSAGES_PER_PROMPT,
  );
  if (fullBatch.length === 0) return true;

  const cfg = loadSenderAllowlist();
  const filtered = filterMessagesForTelegramAllowlist(chatJid, fullBatch, cfg);
  if (filtered.length === 0) {
    lastAgentTimestamp[chatJid] = fullBatch[fullBatch.length - 1]!.timestamp;
    saveState();
    return true;
  }

  const needsTrigger = !group.isMain && group.requiresTrigger !== false;
  if (
    needsTrigger &&
    !filtered.some((m) =>
      messageSatisfiesGroupTrigger(chatJid, m.content, group.trigger),
    )
  ) {
    return true;
  }

  const previousCursor = lastAgentTimestamp[chatJid] ?? '';
  const lastTs = fullBatch[fullBatch.length - 1]!.timestamp;
  lastAgentTimestamp[chatJid] = lastTs;
  saveState();

  const prompt = formatMessages(filtered, TIMEZONE);
  const cato = await catoCheck({
    type: 'check_action',
    groupFolder: group.folder,
    prompt,
  });
  if (!cato.allow) {
    await channel.sendMessage(
      chatJid,
      `[Cato] Blocked (${cato.reason ?? 'policy'}).`,
    );
    return true;
  }

  await channel.setTyping?.(chatJid, true);

  let outputSentToUser = false;

  const status = await runAgent(group, prompt, chatJid, async (text) => {
    if (text.trim()) outputSentToUser = true;
    await channel.sendMessage(chatJid, text);
  });

  await channel.setTyping?.(chatJid, false);

  if (status === 'error') {
    if (outputSentToUser) {
      logger.warn({ chatJid }, 'Agent error after output was sent');
      return true;
    }
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    return false;
  }

  return true;
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopStarted) return;
  messageLoopStarted = true;

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages: newMsgs, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (newMsgs.length > 0) {
        lastTimestamp = newTimestamp;
        saveState();
      }

      const byChat = new Map<string, NewMessage[]>();
      for (const m of newMsgs) {
        const arr = byChat.get(m.chat_jid) ?? [];
        arr.push(m);
        byChat.set(m.chat_jid, arr);
      }

      for (const [chatJid, batch] of byChat) {
        const group = registeredGroups[chatJid];
        if (!group) continue;
        const channel = findChannel(channels, chatJid);
        if (!channel) continue;

        const cfg = loadSenderAllowlist();
        const filteredNew = filterMessagesForTelegramAllowlist(
          chatJid,
          batch,
          cfg,
        );
        if (filteredNew.length === 0) {
          const maxTs = batch.reduce(
            (a, m) => (m.timestamp > a ? m.timestamp : a),
            batch[0]!.timestamp,
          );
          lastAgentTimestamp[chatJid] = maxTs;
          saveState();
          continue;
        }

        const needsTrigger = !group.isMain && group.requiresTrigger !== false;
        if (
          needsTrigger &&
          !filteredNew.some((m) =>
            messageSatisfiesGroupTrigger(chatJid, m.content, group.trigger),
          )
        ) {
          continue;
        }

        const cursor = getOrRecoverCursor(chatJid);
        const full = getMessagesSince(
          chatJid,
          cursor,
          ASSISTANT_NAME,
          MAX_MESSAGES_PER_PROMPT,
        );
        const filteredFull = filterMessagesForTelegramAllowlist(
          chatJid,
          full,
          cfg,
        );
        if (filteredFull.length === 0) {
          if (full.length > 0) {
            lastAgentTimestamp[chatJid] = full[full.length - 1]!.timestamp;
            saveState();
          }
          continue;
        }
        if (
          needsTrigger &&
          !filteredFull.some((m) =>
            messageSatisfiesGroupTrigger(chatJid, m.content, group.trigger),
          )
        ) {
          continue;
        }

        const lastTs = full[full.length - 1]!.timestamp;
        const formatted = formatMessages(filteredFull, TIMEZONE);
        if (queue.sendMessage(chatJid, formatted)) {
          lastAgentTimestamp[chatJid] = lastTs;
          saveState();
          await channel.setTyping?.(chatJid, true);
        } else {
          queue.enqueueMessageCheck(chatJid);
        }
      }
    } catch (err) {
      logger.error({ err }, 'Message loop iteration error');
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
  }
}

function buildIpcDeps(): IpcDeps {
  return {
    sendMessage: async (jid, text) => {
      const ch = findChannel(channels, jid);
      if (ch) await ch.sendMessage(jid, formatOutbound(text));
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      for (const ch of channels) {
        await ch.syncGroups?.(force);
      }
    },
    getAvailableGroups,
    writeGroupsSnapshot,
    onTasksChanged,
  };
}

async function schedulerSendMessage(jid: string, raw: string): Promise<void> {
  const ch = findChannel(channels, jid);
  if (ch) await ch.sendMessage(jid, formatOutbound(raw));
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  loadState();
  seedTuiGroupIfNeeded();
  seedTelegramDmGroupsIfNeeded();

  startCatoInlineHook();
  ensureCatoGroupFolder();
  startCatoScheduledAudit();

  startHealthServer({ getActiveContainerCount: () => queue.getActiveCount() });
  broker = startBroker();
  startCredentialProxy();
  restoreRemoteControl();

  const shutdown = async () => {
    stopCatoScheduledAudit();
    stopCatoInlineHook();
    stopHealthServer();
    await queue.shutdown(10_000);
    for (const ch of channels) {
      await ch.disconnect();
    }
    broker?.close();
    broker = null;
    stopCredentialProxy();
    process.exit(0);
  };

  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());

  const opts = buildChannelOpts();
  for (const name of getRegisteredChannelNames()) {
    if (!isChannelEnabled(name)) continue;
    const factory = getChannelFactory(name);
    const ch = factory?.(opts) ?? null;
    if (ch) {
      await ch.connect();
      channels.push(ch);
    }
  }

  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) => {
      queue.registerProcess(groupJid, proc, containerName, groupFolder);
    },
    sendMessage: schedulerSendMessage,
  });

  startIpcWatcher(buildIpcDeps());

  queue.setProcessMessagesFn(processGroupMessages);
  queue.setOnMaxRetries((groupJid: string) => {
    const ch = findChannel(channels, groupJid);
    ch?.sendMessage(
      groupJid,
      `${ASSISTANT_NAME} is having trouble responding. Send /new to reset the session and try again.`,
    ).catch((err) =>
      logger.error({ err, groupJid }, 'Max retries notification failed'),
    );
  });

  recoverPendingMessages();

  await startMessageLoop();
}

function isExecutedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fileURLToPath(import.meta.url) === path.resolve(entry);
  } catch {
    return false;
  }
}

if (isExecutedDirectly()) {
  main().catch((err) => {
    logger.fatal({ err }, 'Fatal startup error');
    process.exit(1);
  });
}
