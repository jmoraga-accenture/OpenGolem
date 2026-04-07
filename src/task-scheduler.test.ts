import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase, createTask, getTaskById } from './db.js';
import {
  _resetSchedulerLoopForTests,
  computeNextRun,
  startSchedulerLoop,
  type SchedulerDependencies,
} from './task-scheduler.js';
import type { ScheduledTask } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: `task-${Math.random().toString(36).slice(2)}`,
    group_folder: 'test-group',
    chat_jid: 'test@g.us',
    prompt: 'test prompt',
    script: null,
    schedule_type: 'interval',
    schedule_value: '60000',
    context_mode: 'isolated',
    next_run: new Date(Date.now() - 1000).toISOString(),
    last_run: null,
    last_result: null,
    status: 'active',
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeDeps(
  enqueueTask: SchedulerDependencies['queue']['enqueueTask'] = vi.fn(),
): SchedulerDependencies {
  return {
    registeredGroups: () => ({}),
    getSessions: () => ({}),
    queue: {
      enqueueTask,
      closeStdin: vi.fn(),
      notifyIdle: vi.fn(),
    } as unknown as SchedulerDependencies['queue'],
    onProcess: vi.fn(),
    sendMessage: vi.fn(async () => {}),
  };
}

// ---------------------------------------------------------------------------
// computeNextRun
// ---------------------------------------------------------------------------

describe('computeNextRun', () => {
  it('returns null for once tasks', () => {
    expect(computeNextRun(makeTask({ schedule_type: 'once' }))).toBeNull();
  });

  it('returns a future ISO string for cron tasks', () => {
    const task = makeTask({
      schedule_type: 'cron',
      schedule_value: '* * * * *', // every minute
    });
    const result = computeNextRun(task);
    expect(result).not.toBeNull();
    expect(new Date(result!).getTime()).toBeGreaterThan(Date.now() - 1000);
  });

  it('anchors interval next run to scheduled time, not wall clock', () => {
    const intervalMs = 60_000;
    const anchor = Date.now() - 2_000; // 2 s in the past
    const task = makeTask({
      schedule_type: 'interval',
      schedule_value: String(intervalMs),
      next_run: new Date(anchor).toISOString(),
    });
    const result = computeNextRun(task);
    expect(result).not.toBeNull();
    // Expected: anchor + 60s (not Date.now() + 60s)
    const expected = anchor + intervalMs;
    expect(Math.abs(new Date(result!).getTime() - expected)).toBeLessThan(100);
  });

  it('skips missed intervals so result is always in the future', () => {
    const intervalMs = 60_000;
    // Anchor is 10 intervals ago
    const anchor = Date.now() - intervalMs * 10;
    const task = makeTask({
      schedule_type: 'interval',
      schedule_value: String(intervalMs),
      next_run: new Date(anchor).toISOString(),
    });
    const result = computeNextRun(task);
    expect(result).not.toBeNull();
    expect(new Date(result!).getTime()).toBeGreaterThan(Date.now());
    // Result is on the schedule grid anchored from the original time
    const offset = (new Date(result!).getTime() - anchor) % intervalMs;
    expect(offset).toBe(0);
  });

  it('falls back to +60 s for non-numeric interval value', () => {
    const task = makeTask({
      schedule_type: 'interval',
      schedule_value: 'not-a-number',
    });
    const before = Date.now();
    const result = computeNextRun(task);
    expect(result).not.toBeNull();
    const ts = new Date(result!).getTime();
    expect(ts).toBeGreaterThanOrEqual(before + 59_000);
    expect(ts).toBeLessThanOrEqual(Date.now() + 61_000);
  });

  it('falls back to +60 s for zero interval value', () => {
    const task = makeTask({
      schedule_type: 'interval',
      schedule_value: '0',
    });
    const before = Date.now();
    const result = computeNextRun(task);
    expect(result).not.toBeNull();
    expect(new Date(result!).getTime()).toBeGreaterThanOrEqual(before + 59_000);
  });

  it('falls back to +60 s for negative interval value', () => {
    const task = makeTask({
      schedule_type: 'interval',
      schedule_value: '-1000',
    });
    const before = Date.now();
    const result = computeNextRun(task);
    expect(result).not.toBeNull();
    expect(new Date(result!).getTime()).toBeGreaterThanOrEqual(before + 59_000);
  });
});

// ---------------------------------------------------------------------------
// startSchedulerLoop
// ---------------------------------------------------------------------------

describe('startSchedulerLoop', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetSchedulerLoopForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    _resetSchedulerLoopForTests();
  });

  it('is idempotent — calling twice does not double-enqueue', async () => {
    const task = makeTask({ id: 'task-idempotent' });
    createTask(task);

    const enqueueTask = vi.fn();
    const deps = makeDeps(enqueueTask);

    startSchedulerLoop(deps);
    startSchedulerLoop(deps); // second call should be a no-op

    // Advance just past one synchronous loop tick (initial call is immediate)
    await vi.advanceTimersByTimeAsync(10);

    // getDueTasks returns one task; enqueueTask should fire exactly once
    expect(enqueueTask).toHaveBeenCalledTimes(1);
  });

  it('calls queue.enqueueTask for due active tasks', async () => {
    const task = makeTask({ id: 'task-due' });
    createTask(task);

    const enqueueTask = vi.fn();
    const deps = makeDeps(enqueueTask);

    startSchedulerLoop(deps);
    await vi.advanceTimersByTimeAsync(10);

    expect(enqueueTask).toHaveBeenCalledWith(
      task.chat_jid,
      task.id,
      expect.any(Function),
    );
  });

  it('skips tasks whose status changed to paused before they run', async () => {
    const task = makeTask({
      id: 'task-paused-recheck',
      next_run: new Date(Date.now() - 1000).toISOString(),
      status: 'active',
    });
    createTask(task);

    // Pause the task in the DB before the scheduler loop fires
    const { updateTask } = await import('./db.js');
    updateTask(task.id, { status: 'paused' });

    const enqueueTask = vi.fn();
    const deps = makeDeps(enqueueTask);

    startSchedulerLoop(deps);
    await vi.advanceTimersByTimeAsync(10);

    expect(enqueueTask).not.toHaveBeenCalled();
  });

  it('pauses tasks with invalid group folders to prevent retry churn', async () => {
    createTask({
      id: 'task-bad-folder',
      group_folder: '../../outside',
      chat_jid: 'bad@g.us',
      prompt: 'run me',
      schedule_type: 'once',
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });

    const enqueueTask = vi.fn(
      (_jid: string, _id: string, fn: () => Promise<void>) => {
        void fn();
      },
    );
    const deps = makeDeps(enqueueTask);

    startSchedulerLoop(deps);
    await vi.advanceTimersByTimeAsync(50);

    const task = getTaskById('task-bad-folder');
    expect(task?.status).toBe('paused');
  });
});
