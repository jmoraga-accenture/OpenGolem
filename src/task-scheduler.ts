import { ChildProcess } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';
import { ASSISTANT_NAME, SCHEDULER_POLL_INTERVAL, TIMEZONE } from './config.js';
import { catoCheck } from './cato/inline.js';
import { ContainerOutput, runContainerAgent, writeTasksSnapshot } from './container-runner.js';
import { getAllTasks, getDueTasks, getTaskById, logTaskRun, updateTask, updateTaskAfterRun } from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup, ScheduledTask } from './types.js';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  queue: GroupQueue;
  onProcess: (groupJid: string, proc: ChildProcess, containerName: string, groupFolder: string) => void;
  sendMessage: (jid: string, text: string) => Promise<void>;
}

// ---------------------------------------------------------------------------
// computeNextRun
// ---------------------------------------------------------------------------

export function computeNextRun(task: ScheduledTask): string | null {
  if (task.schedule_type === 'once') {
    return null;
  }

  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, { tz: TIMEZONE });
    return interval.next().toISOString();
  }

  // interval
  const ms = parseInt(task.schedule_value, 10);
  if (isNaN(ms) || ms <= 0) {
    logger.warn(
      { taskId: task.id, scheduleValue: task.schedule_value },
      'Scheduler: invalid interval value, defaulting to 60s',
    );
    return new Date(Date.now() + 60_000).toISOString();
  }

  // Anchor to next_run and advance by ms until result is in the future (avoids drift)
  let anchor = task.next_run ? new Date(task.next_run).getTime() : Date.now();
  const now = Date.now();
  while (anchor <= now) {
    anchor += ms;
  }
  return new Date(anchor).toISOString();
}

// ---------------------------------------------------------------------------
// Scheduler loop
// ---------------------------------------------------------------------------

let loopRunning = false;

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (loopRunning) {
    logger.debug('Scheduler loop already running, skipping start');
    return;
  }
  loopRunning = true;
  scheduleNextPoll(deps);
}

/** Reset the running flag. Test helper only. */
export function _resetSchedulerLoopForTests(): void {
  loopRunning = false;
}

function scheduleNextPoll(deps: SchedulerDependencies): void {
  setTimeout(() => {
    runPoll(deps).catch((err) => {
      logger.error({ err }, 'Scheduler poll iteration failed');
    });
    scheduleNextPoll(deps);
  }, SCHEDULER_POLL_INTERVAL);
}

async function runPoll(deps: SchedulerDependencies): Promise<void> {
  let dueTasks: ScheduledTask[];
  try {
    dueTasks = getDueTasks();
  } catch (err) {
    logger.error({ err }, 'Scheduler: getDueTasks failed');
    return;
  }

  for (const dueTask of dueTasks) {
    const task = getTaskById(dueTask.id);
    if (!task || task.status !== 'active') {
      continue;
    }
    const capturedTask = task;
    deps.queue.enqueueTask(task.chat_jid, task.id, () => runTask(capturedTask, deps));
  }
}

// ---------------------------------------------------------------------------
// runTask
// ---------------------------------------------------------------------------

async function runTask(task: ScheduledTask, deps: SchedulerDependencies): Promise<void> {
  const startTime = Date.now();

  // 1. Resolve group directory
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(task.group_folder);
  } catch (err) {
    logger.error(
      { err, taskId: task.id, groupFolder: task.group_folder },
      'Scheduler: failed to resolve group folder — pausing task',
    );
    updateTask(task.id, { status: 'paused' });
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  // 2. Ensure group directory exists
  fs.mkdirSync(groupDir, { recursive: true });

  // 3. Find matching registered group
  const groups = deps.registeredGroups();
  const group = Object.values(groups).find((g) => g.folder === task.group_folder);
  if (!group) {
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder },
      'Scheduler: no registered group found for task',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: `No registered group for folder: ${task.group_folder}`,
    });
    return;
  }

  const isMain = group.isMain ?? false;

  // 4. Write tasks snapshot
  const allTasks = getAllTasks();
  writeTasksSnapshot(
    task.group_folder,
    isMain,
    allTasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script ?? null,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // 5. Cato check
  const catoResult = await catoCheck({
    type: 'check_action',
    groupFolder: task.group_folder,
    prompt: task.prompt,
  });

  if (!catoResult.allow) {
    logger.warn(
      { taskId: task.id, reason: catoResult.reason },
      'Scheduler: Cato blocked scheduled task',
    );
    await deps
      .sendMessage(
        task.chat_jid,
        `Scheduled task blocked by safety check: ${catoResult.reason ?? 'unknown'}`,
      )
      .catch((err) =>
        logger.error({ err }, 'Scheduler: failed to send Cato block notification'),
      );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: `Cato blocked: ${catoResult.reason ?? 'unknown'}`,
    });
    return;
  }

  // 6. Run container agent
  const sessionId =
    task.context_mode === 'group' ? deps.getSessions()[task.group_folder] : undefined;

  let resultSummary = '';
  let containerError: string | null = null;
  let firstResultReceived = false;

  const onProcess = (proc: ChildProcess, containerName: string): void => {
    deps.onProcess(task.chat_jid, proc, containerName, task.group_folder);
  };

  const streamCallback = async (output: ContainerOutput): Promise<void> => {
    if (output.result) {
      resultSummary = output.result;
      await deps
        .sendMessage(task.chat_jid, output.result)
        .catch((err) =>
          logger.error({ err, taskId: task.id }, 'Scheduler: failed to forward result to user'),
        );
      if (!firstResultReceived) {
        firstResultReceived = true;
        setTimeout(() => {
          deps.queue.closeStdin(task.chat_jid);
        }, 10_000);
      }
    }
  };

  try {
    const finalOutput = await runContainerAgent(
      group,
      {
        prompt: task.prompt,
        sessionId,
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
        isMain,
        isScheduledTask: true,
        assistantName: ASSISTANT_NAME,
        script: task.script ?? undefined,
      },
      onProcess,
      streamCallback,
    );
    if (!resultSummary && finalOutput.result) {
      resultSummary = finalOutput.result;
    }
    if (finalOutput.status === 'error') {
      containerError = finalOutput.error ?? 'Container returned error status';
    }
  } catch (err) {
    containerError = err instanceof Error ? err.message : String(err);
    logger.error({ err, taskId: task.id }, 'Scheduler: container agent run failed');
  }

  // 7. Log task run and advance schedule
  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: Date.now() - startTime,
    status: containerError ? 'error' : 'success',
    result: resultSummary || null,
    error: containerError,
  });

  updateTaskAfterRun(
    task.id,
    computeNextRun(task),
    resultSummary || containerError || '',
  );
}
