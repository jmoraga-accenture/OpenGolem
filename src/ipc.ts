import { randomBytes } from 'crypto';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';
import path from 'path';

import type { AvailableGroup } from './container-runner.js';
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
import { DATA_DIR, IPC_POLL_INTERVAL, TIMEZONE } from './config.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import type { ContainerConfig, RegisteredGroup } from './types.js';

type ScheduleKind = 'cron' | 'interval' | 'once';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  onTasksChanged: () => void;
}

let ipcWatcherStarted = false;

function moveToErrors(sourceGroup: string, filepath: string): void {
  const errDir = path.join(DATA_DIR, 'ipc', 'errors');
  fs.mkdirSync(errDir, { recursive: true });
  const base = path.basename(filepath);
  const dest = path.join(errDir, `${sourceGroup}-${base}`);
  try {
    fs.renameSync(filepath, dest);
  } catch (err) {
    logger.error({ err, filepath, dest }, 'Failed to move IPC file to errors');
  }
}

function isMessageAuthorized(
  sourceGroup: string,
  isMain: boolean,
  targetChatJid: string,
  registered: Record<string, RegisteredGroup>,
): boolean {
  const targetGroup = registered[targetChatJid];
  return isMain || (!!targetGroup && targetGroup.folder === sourceGroup);
}

async function handleMessagePayload(
  data: Record<string, unknown>,
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
): Promise<void> {
  if (data.type !== 'message') return;
  const chatJid = data.chatJid;
  const text = data.text;
  if (typeof chatJid !== 'string' || typeof text !== 'string') return;

  const registered = deps.registeredGroups();
  if (!isMessageAuthorized(sourceGroup, isMain, chatJid, registered)) {
    logger.warn(
      { sourceGroup, chatJid },
      'IPC message rejected: not authorized for target chat',
    );
    return;
  }
  await deps.sendMessage(chatJid, text);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function validateScheduleValueLen(value: string): boolean {
  return value.length <= 200;
}

function validateCronInterval(expr: string): string | null {
  try {
    const interval = CronExpressionParser.parse(expr, { tz: TIMEZONE });
    const first = interval.next();
    const second = interval.next();
    if (second.getTime() - first.getTime() < 5 * 60 * 1000) {
      logger.warn({ expr }, 'IPC schedule_task: cron interval under 5 minutes');
      return null;
    }
    return first.toISOString();
  } catch {
    return null;
  }
}

function validateIntervalMs(raw: string): number | null {
  const ms = parseInt(raw, 10);
  if (Number.isNaN(ms) || ms < 300_000) return null;
  return ms;
}

function validateOnceIso(raw: string): string | null {
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString();
}

function sanitizeContainerConfig(raw: unknown): ContainerConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  if (o.additionalMounts !== undefined) {
    if (!Array.isArray(o.additionalMounts)) return undefined;
    for (const m of o.additionalMounts) {
      if (!m || typeof m !== 'object' || Array.isArray(m)) return undefined;
      const mo = m as Record<string, unknown>;
      if (typeof mo.hostPath !== 'string' || !mo.hostPath.trim()) {
        return undefined;
      }
      if (typeof mo.containerPath !== 'string' || !mo.containerPath.trim()) {
        return undefined;
      }
    }
  }
  return raw as ContainerConfig;
}

function resolveContextMode(raw: unknown): 'group' | 'isolated' {
  if (raw === 'group' || raw === 'isolated') return raw;
  return 'isolated';
}

function computeNextRunForUpdate(
  schedule_type: ScheduleKind,
  schedule_value: string,
): string | null {
  if (schedule_type === 'cron') {
    return validateCronInterval(schedule_value);
  }
  if (schedule_type === 'interval') {
    const ms = validateIntervalMs(schedule_value);
    return ms != null ? new Date(Date.now() + ms).toISOString() : null;
  }
  if (schedule_type === 'once') {
    return validateOnceIso(schedule_value);
  }
  return null;
}

export async function processTaskIpc(
  data: Record<string, unknown>,
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
): Promise<void> {
  const t = data.type;
  if (typeof t !== 'string') return;

  const registered = deps.registeredGroups();

  switch (t) {
    case 'schedule_task': {
      if (!isMain) {
        const targetJid = str(data.targetJid);
        if (!targetJid) return;
        const tg = registered[targetJid];
        if (!tg || tg.folder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetJid },
            'IPC schedule_task: non-main cannot schedule for other group',
          );
          return;
        }
      }

      const prompt = str(data.prompt);
      const schedule_type = str(data.schedule_type) as ScheduleKind | undefined;
      const schedule_value = str(data.schedule_value);
      const targetJid = str(data.targetJid);
      if (!prompt || !schedule_type || !schedule_value || !targetJid) return;
      if (!['cron', 'interval', 'once'].includes(schedule_type)) return;
      if (!validateScheduleValueLen(schedule_value)) {
        logger.warn('IPC schedule_task: schedule_value too long');
        return;
      }

      const targetGroup = registered[targetJid];
      if (!targetGroup) {
        logger.warn(
          { targetJid },
          'IPC schedule_task: unregistered target JID',
        );
        return;
      }

      let next_run: string | null = null;
      if (schedule_type === 'cron') {
        next_run = validateCronInterval(schedule_value);
        if (!next_run) return;
      } else if (schedule_type === 'interval') {
        const ms = validateIntervalMs(schedule_value);
        if (ms == null) return;
        next_run = new Date(Date.now() + ms).toISOString();
      } else {
        next_run = validateOnceIso(schedule_value);
        if (!next_run) return;
      }

      const context_mode = resolveContextMode(data.context_mode);
      const script =
        data.script === undefined || data.script === null
          ? null
          : typeof data.script === 'string'
            ? data.script
            : null;

      let id: string;
      if (typeof data.taskId === 'string' && data.taskId.trim()) {
        id = data.taskId.trim();
      } else {
        id = `task-${Date.now()}-${randomBytes(8).toString('hex')}`;
      }

      createTask({
        id,
        group_folder: targetGroup.folder,
        chat_jid: targetJid,
        prompt,
        script,
        schedule_type,
        schedule_value,
        context_mode,
        next_run,
        status: 'active',
        created_at: new Date().toISOString(),
      });
      deps.onTasksChanged();
      return;
    }

    case 'pause_task':
    case 'resume_task':
    case 'cancel_task': {
      const taskId = str(data.taskId);
      if (!taskId) return;
      const task = getTaskById(taskId);
      if (!task) return;
      if (!isMain && task.group_folder !== sourceGroup) {
        logger.warn(
          { sourceGroup, taskId },
          `IPC ${t}: not authorized for this task`,
        );
        return;
      }
      if (t === 'pause_task') {
        updateTask(taskId, { status: 'paused' });
      } else if (t === 'resume_task') {
        updateTask(taskId, { status: 'active' });
      } else {
        deleteTask(taskId);
      }
      deps.onTasksChanged();
      return;
    }

    case 'update_task': {
      const taskId = str(data.taskId);
      if (!taskId) return;
      const task = getTaskById(taskId);
      if (!task) return;
      if (!isMain && task.group_folder !== sourceGroup) {
        logger.warn(
          { sourceGroup, taskId },
          'IPC update_task: not authorized for this task',
        );
        return;
      }

      const updates: Parameters<typeof updateTask>[1] = {};
      if (typeof data.prompt === 'string') updates.prompt = data.prompt;
      if (data.script === null) updates.script = null;
      else if (typeof data.script === 'string') updates.script = data.script;
      if (typeof data.schedule_type === 'string') {
        const st = data.schedule_type as ScheduleKind;
        if (st === 'cron' || st === 'interval' || st === 'once') {
          updates.schedule_type = st;
        }
      }
      if (typeof data.schedule_value === 'string') {
        if (!validateScheduleValueLen(data.schedule_value)) {
          logger.warn('IPC update_task: schedule_value too long');
          return;
        }
        updates.schedule_value = data.schedule_value;
      }

      if (Object.keys(updates).length === 0) return;

      let nextExtra: { next_run?: string } = {};
      if (
        updates.schedule_type !== undefined ||
        updates.schedule_value !== undefined
      ) {
        const st = (updates.schedule_type ??
          task.schedule_type) as ScheduleKind;
        const sv = updates.schedule_value ?? task.schedule_value;
        const nr = computeNextRunForUpdate(st, sv);
        if (!nr) return;
        nextExtra = { next_run: nr };
      }

      updateTask(taskId, { ...updates, ...nextExtra });
      deps.onTasksChanged();
      return;
    }

    case 'refresh_groups': {
      if (!isMain) return;
      await deps.syncGroups(true);
      const available = deps.getAvailableGroups();
      const registeredJids = new Set(Object.keys(deps.registeredGroups()));
      deps.writeGroupsSnapshot(sourceGroup, true, available, registeredJids);
      return;
    }

    case 'register_group': {
      if (!isMain) return;
      const jid = str(data.jid);
      const name = str(data.name);
      const folder = str(data.folder);
      const trigger = str(data.trigger);
      if (!jid || !name || !folder || !trigger) {
        logger.warn('IPC register_group: missing required fields');
        return;
      }
      if (!isValidGroupFolder(folder)) {
        logger.warn({ folder }, 'IPC register_group: invalid folder');
        return;
      }

      let containerConfig: ContainerConfig | undefined;
      if (data.containerConfig !== undefined) {
        const sanitized = sanitizeContainerConfig(data.containerConfig);
        containerConfig = sanitized;
      }

      const existing = registered[jid];
      let requiresTrigger: boolean | undefined;
      if (typeof data.requiresTrigger === 'boolean') {
        requiresTrigger = data.requiresTrigger;
      }

      deps.registerGroup(jid, {
        name,
        folder,
        trigger,
        added_at: new Date().toISOString(),
        containerConfig,
        requiresTrigger,
        isMain: existing?.isMain,
      });
      return;
    }

    default:
      logger.warn({ type: t }, 'IPC: unknown task payload type');
  }
}

async function processJsonFile(
  filepath: string,
  sourceGroup: string,
  isMain: boolean,
  kind: 'message' | 'task',
  deps: IpcDeps,
): Promise<void> {
  try {
    const raw = fs.readFileSync(filepath, 'utf8');
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (kind === 'message') {
      await handleMessagePayload(data, sourceGroup, isMain, deps);
    } else {
      await processTaskIpc(data, sourceGroup, isMain, deps);
    }
    fs.unlinkSync(filepath);
  } catch (err) {
    logger.error({ err, filepath }, 'IPC file processing failed');
    moveToErrors(sourceGroup, filepath);
  }
}

function listGroupFolders(ipcRoot: string): string[] {
  if (!fs.existsSync(ipcRoot)) return [];
  const out: string[] = [];
  for (const ent of fs.readdirSync(ipcRoot, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    if (ent.name === 'errors') continue;
    out.push(ent.name);
  }
  return out;
}

function folderToIsMain(
  folder: string,
  registered: Record<string, RegisteredGroup>,
): boolean {
  for (const g of Object.values(registered)) {
    if (g.folder === folder) return g.isMain === true;
  }
  return false;
}

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherStarted) return;
  ipcWatcherStarted = true;

  const tick = () => {
    try {
      const ipcRoot = path.join(DATA_DIR, 'ipc');
      const folders = listGroupFolders(ipcRoot);
      const registered = deps.registeredGroups();

      for (const folder of folders) {
        const isMain = folderToIsMain(folder, registered);
        const msgDir = path.join(ipcRoot, folder, 'messages');
        const taskDir = path.join(ipcRoot, folder, 'tasks');

        if (fs.existsSync(msgDir)) {
          for (const f of fs.readdirSync(msgDir)) {
            if (!f.endsWith('.json')) continue;
            const fp = path.join(msgDir, f);
            if (!fs.statSync(fp).isFile()) continue;
            void processJsonFile(fp, folder, isMain, 'message', deps);
          }
        }

        if (fs.existsSync(taskDir)) {
          for (const f of fs.readdirSync(taskDir)) {
            if (!f.endsWith('.json')) continue;
            const fp = path.join(taskDir, f);
            if (!fs.statSync(fp).isFile()) continue;
            void processJsonFile(fp, folder, isMain, 'task', deps);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'IPC watcher iteration failed');
    } finally {
      setTimeout(tick, IPC_POLL_INTERVAL);
    }
  };

  tick();
}
