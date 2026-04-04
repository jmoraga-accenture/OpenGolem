import { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, MAX_CONCURRENT_CONTAINERS } from './config.js';
import { stopContainer } from './container-runtime.js';
import { logger } from './logger.js';

interface QueuedTask {
  id: string;
  groupJid: string;
  fn: () => Promise<void>;
}

interface GroupState {
  active: boolean;
  idleWaiting: boolean;
  isTaskContainer: boolean;
  runningTaskId: string | null;
  pendingMessages: boolean;
  pendingTasks: QueuedTask[];
  process: ChildProcess | null;
  containerName: string | null;
  groupFolder: string | null;
  retryCount: number;
}

const MAX_RETRIES = 5;
const BASE_RETRY_MS = 5000;

function emptyGroupState(): GroupState {
  return {
    active: false,
    idleWaiting: false,
    isTaskContainer: false,
    runningTaskId: null,
    pendingMessages: false,
    pendingTasks: [],
    process: null,
    containerName: null,
    groupFolder: null,
    retryCount: 0,
  };
}

export class GroupQueue {
  private groups = new Map<string, GroupState>();
  private activeCount = 0;
  private waitingGroups: string[] = [];
  private processMessagesFn: ((groupJid: string) => Promise<boolean>) | null =
    null;
  private shuttingDown = false;
  private onMaxRetriesFn: ((groupJid: string) => void) | null = null;

  private getGroup(groupJid: string): GroupState {
    let state = this.groups.get(groupJid);
    if (!state) {
      state = emptyGroupState();
      this.groups.set(groupJid, state);
    }
    return state;
  }

  setProcessMessagesFn(fn: (groupJid: string) => Promise<boolean>): void {
    this.processMessagesFn = fn;
  }

  setOnMaxRetries(fn: (groupJid: string) => void): void {
    this.onMaxRetriesFn = fn;
  }

  stopCurrentContainer(groupJid: string): boolean {
    const state = this.groups.get(groupJid);
    if (!state?.process || state.process.killed || !state.containerName) {
      return false;
    }
    logger.info(
      { groupJid, containerName: state.containerName },
      'Stopping container on user request (/new or /reset)',
    );
    stopContainer(state.containerName);
    return true;
  }

  enqueueMessageCheck(groupJid: string): void {
    if (this.shuttingDown) {
      return;
    }
    const state = this.getGroup(groupJid);
    if (state.active) {
      state.pendingMessages = true;
      logger.debug({ groupJid }, 'Container active, message queued');
      return;
    }
    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingMessages = true;
      if (!this.waitingGroups.includes(groupJid)) {
        this.waitingGroups.push(groupJid);
      }
      logger.debug(
        { groupJid, activeCount: this.activeCount },
        'At concurrency limit, message queued',
      );
      return;
    }
    void this.runForGroup(groupJid, 'messages').catch((err) => {
      logger.error({ groupJid, err }, 'Unhandled error in runForGroup');
    });
  }

  enqueueTask(groupJid: string, taskId: string, fn: () => Promise<void>): void {
    if (this.shuttingDown) {
      return;
    }
    const state = this.getGroup(groupJid);
    if (state.runningTaskId === taskId) {
      logger.debug({ groupJid, taskId }, 'Task already running, skipping');
      return;
    }
    if (state.pendingTasks.some((t) => t.id === taskId)) {
      logger.debug({ groupJid, taskId }, 'Task already queued, skipping');
      return;
    }
    const task: QueuedTask = { id: taskId, groupJid, fn };
    if (state.active) {
      state.pendingTasks.push(task);
      if (state.idleWaiting) {
        this.closeStdin(groupJid);
      }
      logger.debug({ groupJid, taskId }, 'Container active, task queued');
      return;
    }
    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingTasks.push(task);
      if (!this.waitingGroups.includes(groupJid)) {
        this.waitingGroups.push(groupJid);
      }
      logger.debug(
        { groupJid, taskId, activeCount: this.activeCount },
        'At concurrency limit, task queued',
      );
      return;
    }
    void this.runTask(groupJid, task).catch((err) => {
      logger.error({ groupJid, taskId, err }, 'Unhandled error in runTask');
    });
  }

  registerProcess(
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder?: string,
  ): void {
    const state = this.getGroup(groupJid);
    state.process = proc;
    state.containerName = containerName;
    if (groupFolder) {
      state.groupFolder = groupFolder;
    }
  }

  notifyIdle(groupJid: string): void {
    const state = this.getGroup(groupJid);
    state.idleWaiting = true;
    if (state.pendingTasks.length > 0) {
      this.closeStdin(groupJid);
    }
  }

  sendMessage(groupJid: string, text: string): boolean {
    const state = this.getGroup(groupJid);
    if (!state.active || !state.groupFolder || state.isTaskContainer) {
      return false;
    }
    state.idleWaiting = false;
    const inputDir = path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      const baseName = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
      const filepath = path.join(inputDir, baseName);
      const tmpPath = `${filepath}.tmp`;
      const payload = JSON.stringify({ type: 'message', text });
      fs.writeFileSync(tmpPath, payload, 'utf8');
      fs.renameSync(tmpPath, filepath);
      return true;
    } catch {
      return false;
    }
  }

  closeStdin(groupJid: string): void {
    const state = this.getGroup(groupJid);
    if (!state.active || !state.groupFolder) {
      return;
    }
    const inputDir = path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      fs.writeFileSync(path.join(inputDir, '_close'), '');
    } catch {
      /* ignore */
    }
  }

  getActiveCount(): number {
    return this.activeCount;
  }

  async shutdown(_gracePeriodMs: number): Promise<void> {
    this.shuttingDown = true;
    const detachedContainers: string[] = [];
    for (const [, st] of this.groups) {
      if (st.active && st.containerName) {
        detachedContainers.push(st.containerName);
      }
    }
    logger.info(
      {
        activeCount: this.activeCount,
        detachedContainers,
      },
      'GroupQueue shutting down (containers detached, not killed)',
    );
  }

  private async runForGroup(
    groupJid: string,
    reason: 'messages' | 'drain',
  ): Promise<void> {
    const state = this.getGroup(groupJid);
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = false;
    state.pendingMessages = false;
    this.activeCount++;
    logger.debug(
      { groupJid, reason, activeCount: this.activeCount },
      'Starting container for group',
    );
    try {
      if (this.processMessagesFn) {
        const ok = await this.processMessagesFn(groupJid);
        if (ok) {
          state.retryCount = 0;
        } else {
          this.scheduleRetry(groupJid, state);
        }
      }
    } catch (err) {
      logger.error({ groupJid, err }, 'Error processing messages for group');
      this.scheduleRetry(groupJid, state);
    } finally {
      state.active = false;
      state.process = null;
      state.containerName = null;
      state.groupFolder = null;
      this.activeCount--;
      this.drainGroup(groupJid);
    }
  }

  private async runTask(groupJid: string, task: QueuedTask): Promise<void> {
    const state = this.getGroup(groupJid);
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = true;
    state.runningTaskId = task.id;
    this.activeCount++;
    logger.debug(
      { groupJid, taskId: task.id, activeCount: this.activeCount },
      'Running queued task',
    );
    try {
      await task.fn();
    } catch (err) {
      logger.error({ groupJid, taskId: task.id, err }, 'Error running task');
    } finally {
      state.active = false;
      state.isTaskContainer = false;
      state.runningTaskId = null;
      state.process = null;
      state.containerName = null;
      state.groupFolder = null;
      this.activeCount--;
      this.drainGroup(groupJid);
    }
  }

  private scheduleRetry(groupJid: string, state: GroupState): void {
    state.retryCount++;
    if (state.retryCount > MAX_RETRIES) {
      logger.error(
        { groupJid, retryCount: state.retryCount },
        'Max retries exceeded, dropping messages (will retry on next incoming message)',
      );
      state.retryCount = 0;
      this.onMaxRetriesFn?.(groupJid);
      return;
    }
    const delayMs = BASE_RETRY_MS * Math.pow(2, state.retryCount - 1);
    logger.info(
      { groupJid, retryCount: state.retryCount, delayMs },
      'Scheduling retry with backoff',
    );
    setTimeout(() => {
      if (!this.shuttingDown) {
        this.enqueueMessageCheck(groupJid);
      }
    }, delayMs);
  }

  private drainGroup(groupJid: string): void {
    if (this.shuttingDown) {
      return;
    }
    const state = this.getGroup(groupJid);
    if (state.pendingTasks.length > 0) {
      const next = state.pendingTasks.shift()!;
      void this.runTask(groupJid, next).catch((err) => {
        logger.error(
          { groupJid, taskId: next.id, err },
          'Unhandled error in runTask (drain)',
        );
      });
      return;
    }
    if (state.pendingMessages) {
      void this.runForGroup(groupJid, 'drain').catch((err) => {
        logger.error(
          { groupJid, err },
          'Unhandled error in runForGroup (drain)',
        );
      });
      return;
    }
    this.drainWaiting();
  }

  private drainWaiting(): void {
    while (
      this.waitingGroups.length > 0 &&
      this.activeCount < MAX_CONCURRENT_CONTAINERS
    ) {
      const nextJid = this.waitingGroups.shift()!;
      const st = this.getGroup(nextJid);
      if (st.pendingTasks.length > 0) {
        const task = st.pendingTasks.shift()!;
        void this.runTask(nextJid, task).catch((err) => {
          logger.error(
            { groupJid: nextJid, taskId: task.id, err },
            'Unhandled error in runTask (waiting)',
          );
        });
      } else if (st.pendingMessages) {
        void this.runForGroup(nextJid, 'drain').catch((err) => {
          logger.error(
            { groupJid: nextJid, err },
            'Unhandled error in runForGroup (waiting)',
          );
        });
      }
    }
  }
}
