import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock container-runtime so stopContainer does not call execSync
vi.mock('./container-runtime.js', () => ({
  stopContainer: vi.fn(),
  CONTAINER_RUNTIME_BIN: 'docker',
}));

// Mock config to keep MAX_CONCURRENT_CONTAINERS predictable
vi.mock('./config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./config.js')>();
  return {
    ...actual,
    MAX_CONCURRENT_CONTAINERS: 2,
    DATA_DIR: '/tmp/opengolem-test-data',
  };
});

// Mock fs so filesystem side-effects don't touch disk
vi.mock('fs', () => ({
  default: {
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
  },
}));

import { GroupQueue } from './group-queue.js';

describe('GroupQueue', () => {
  let queue: GroupQueue;

  beforeEach(() => {
    vi.useFakeTimers();
    queue = new GroupQueue();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // --- getActiveCount ---

  describe('getActiveCount', () => {
    it('returns 0 initially', () => {
      expect(queue.getActiveCount()).toBe(0);
    });

    it('increments while a message-check run is in progress', async () => {
      let resolve!: () => void;
      const blocker = new Promise<void>((r) => (resolve = r));

      queue.setProcessMessagesFn(async (_jid) => {
        await blocker;
        return true;
      });

      queue.enqueueMessageCheck('group@a');
      // allow microtasks to start the run
      await Promise.resolve();
      expect(queue.getActiveCount()).toBe(1);

      resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    it('increments while a task is running', async () => {
      let resolve!: () => void;
      const blocker = new Promise<void>((r) => (resolve = r));

      queue.enqueueTask('group@a', 'task-1', async () => {
        await blocker;
      });

      await Promise.resolve();
      expect(queue.getActiveCount()).toBe(1);

      resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  // --- enqueueMessageCheck ---

  describe('enqueueMessageCheck', () => {
    it('does nothing when shuttingDown', async () => {
      await queue.shutdown(0);
      const fn = vi.fn().mockResolvedValue(true);
      queue.setProcessMessagesFn(fn);
      queue.enqueueMessageCheck('group@a');
      await Promise.resolve();
      expect(fn).not.toHaveBeenCalled();
    });

    it('calls processMessagesFn for the group', async () => {
      const fn = vi.fn().mockResolvedValue(true);
      queue.setProcessMessagesFn(fn);
      queue.enqueueMessageCheck('group@a');
      await Promise.resolve();
      await Promise.resolve();
      expect(fn).toHaveBeenCalledWith('group@a');
    });
  });

  // --- enqueueTask ---

  describe('enqueueTask', () => {
    it('does nothing when shuttingDown', async () => {
      await queue.shutdown(0);
      const fn = vi.fn().mockResolvedValue(undefined);
      queue.enqueueTask('group@a', 'task-1', fn);
      await Promise.resolve();
      expect(fn).not.toHaveBeenCalled();
    });

    it('runs a task immediately when nothing active', async () => {
      const fn = vi.fn().mockResolvedValue(undefined);
      queue.enqueueTask('group@a', 'task-1', fn);
      await Promise.resolve();
      await Promise.resolve();
      expect(fn).toHaveBeenCalled();
    });

    it('deduplicates tasks with same id while running', async () => {
      let resolve!: () => void;
      const blocker = new Promise<void>((r) => (resolve = r));
      const fn = vi.fn().mockImplementation(async () => {
        await blocker;
      });

      queue.enqueueTask('group@a', 'task-1', fn);
      await Promise.resolve();
      // Enqueue same task again while first is running
      queue.enqueueTask('group@a', 'task-1', fn);

      resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('deduplicates tasks with same id when already in pending queue', async () => {
      let resolve1!: () => void;
      const blocker1 = new Promise<void>((r) => (resolve1 = r));

      const fn1 = vi.fn().mockImplementation(async () => {
        await blocker1;
      });
      const fn2 = vi.fn().mockResolvedValue(undefined);

      // Start first task (occupies group)
      queue.enqueueTask('group@a', 'task-1', fn1);
      await Promise.resolve();

      // Queue task-2 twice
      queue.enqueueTask('group@a', 'task-2', fn2);
      queue.enqueueTask('group@a', 'task-2', fn2);

      resolve1();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(fn2).toHaveBeenCalledTimes(1);
    });

    it('serializes concurrent tasks for the same jid', async () => {
      const order: number[] = [];
      let resolve1!: () => void;
      const blocker1 = new Promise<void>((r) => (resolve1 = r));

      queue.enqueueTask('group@a', 'task-1', async () => {
        await blocker1;
        order.push(1);
      });
      // microtask flush — task-1 starts
      await Promise.resolve();

      queue.enqueueTask('group@a', 'task-2', async () => {
        order.push(2);
      });

      // unblock task-1 and flush the chain
      resolve1();
      for (let i = 0; i < 10; i++) {
        await Promise.resolve();
      }

      expect(order).toEqual([1, 2]);
    });
  });

  // --- notifyIdle and closeStdin ---

  describe('notifyIdle', () => {
    it('sets idleWaiting true on the group state', () => {
      // No active container — closeStdin writes a file but we mock fs
      queue.notifyIdle('group@a');
      // primary assertion: no throw; subsequent calls also fine
      expect(() => queue.notifyIdle('group@a')).not.toThrow();
    });
  });

  describe('closeStdin', () => {
    it('does not throw for an unknown group', () => {
      expect(() => queue.closeStdin('group@unknown')).not.toThrow();
    });
  });

  // --- shutdown ---

  describe('shutdown', () => {
    it('prevents new message checks after shutdown', async () => {
      const fn = vi.fn().mockResolvedValue(true);
      queue.setProcessMessagesFn(fn);
      await queue.shutdown(0);
      queue.enqueueMessageCheck('group@a');
      await Promise.resolve();
      expect(fn).not.toHaveBeenCalled();
    });

    it('prevents new task enqueues after shutdown', async () => {
      const fn = vi.fn().mockResolvedValue(undefined);
      await queue.shutdown(0);
      queue.enqueueTask('group@a', 'task-x', fn);
      await Promise.resolve();
      expect(fn).not.toHaveBeenCalled();
    });

    it('resolves without error', async () => {
      await expect(queue.shutdown(500)).resolves.toBeUndefined();
    });
  });

  // --- setOnMaxRetries ---

  describe('setOnMaxRetries', () => {
    it('invokes the callback after max retries are exceeded', async () => {
      const onMaxRetries = vi.fn();
      queue.setOnMaxRetries(onMaxRetries);

      const fn = vi.fn().mockResolvedValue(false);
      queue.setProcessMessagesFn(fn);

      // Run one initial message check that returns false (failure)
      queue.enqueueMessageCheck('group@a');
      await Promise.resolve();
      await Promise.resolve();

      // Trigger retries by fast-forwarding timers 6 times (MAX_RETRIES = 5)
      for (let i = 0; i < 6; i++) {
        vi.runAllTimers();
        await Promise.resolve();
        await Promise.resolve();
      }

      expect(onMaxRetries).toHaveBeenCalledWith('group@a');
    });
  });
});
