import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _initTestDatabase,
  createTask,
  getAllTasks,
  getRegisteredGroup,
  getTaskById,
  setRegisteredGroup,
} from './db.js';
import { processTaskIpc, type IpcDeps } from './ipc.js';
import type { RegisteredGroup } from './types.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const MAIN: RegisteredGroup = {
  name: 'Main',
  folder: 'main-group',
  trigger: 'always',
  added_at: '2026-01-01T00:00:00.000Z',
  isMain: true,
};

const GROUP_A: RegisteredGroup = {
  name: 'Group A',
  folder: 'group-a',
  trigger: '@Alef',
  added_at: '2026-01-01T00:00:00.000Z',
};

const GROUP_B: RegisteredGroup = {
  name: 'Group B',
  folder: 'group-b',
  trigger: '@Alef',
  added_at: '2026-01-01T00:00:00.000Z',
};

let groups: Record<string, RegisteredGroup>;
let deps: IpcDeps;

beforeEach(() => {
  _initTestDatabase();

  groups = {
    'main@g.us': MAIN,
    'a@g.us': GROUP_A,
    'b@g.us': GROUP_B,
  };

  setRegisteredGroup('main@g.us', MAIN);
  setRegisteredGroup('a@g.us', GROUP_A);
  setRegisteredGroup('b@g.us', GROUP_B);

  deps = {
    sendMessage: vi.fn(async () => {}),
    registeredGroups: () => groups,
    registerGroup: (jid, group) => {
      groups[jid] = group;
      setRegisteredGroup(jid, group);
    },
    syncGroups: vi.fn(async () => {}),
    getAvailableGroups: () => [],
    writeGroupsSnapshot: vi.fn(),
    onTasksChanged: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// schedule_task — authorization
// ---------------------------------------------------------------------------

describe('schedule_task authorization', () => {
  it('main group can schedule a task for another group', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'do work',
        schedule_type: 'once',
        schedule_value: '2027-01-01T00:00:00.000Z',
        targetJid: 'a@g.us',
      },
      'main-group',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].group_folder).toBe('group-a');
  });

  it('non-main group can schedule a task for itself', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'self task',
        schedule_type: 'once',
        schedule_value: '2027-01-01T00:00:00.000Z',
        targetJid: 'a@g.us',
      },
      'group-a',
      false,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].group_folder).toBe('group-a');
  });

  it('non-main group cannot schedule a task for another group', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'cross-group',
        schedule_type: 'once',
        schedule_value: '2027-01-01T00:00:00.000Z',
        targetJid: 'main@g.us',
      },
      'group-a',
      false,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
  });

  it('rejects schedule_task with an unregistered target JID', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'no target',
        schedule_type: 'once',
        schedule_value: '2027-01-01T00:00:00.000Z',
        targetJid: 'unknown@g.us',
      },
      'main-group',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
  });

  it('rejects schedule_task with missing required fields', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        // missing prompt, schedule_type, schedule_value, targetJid
      },
      'main-group',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
  });

  it('rejects schedule_value longer than 200 characters', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'overflow',
        schedule_type: 'once',
        schedule_value: '2027-01-01T00:00:00.000Z' + 'x'.repeat(200),
        targetJid: 'a@g.us',
      },
      'main-group',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// schedule_task — schedule types
// ---------------------------------------------------------------------------

describe('schedule_task schedule types', () => {
  it('creates a cron task with computed next_run', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'daily',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *',
        targetJid: 'a@g.us',
      },
      'main-group',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].schedule_type).toBe('cron');
    expect(tasks[0].next_run).toBeTruthy();
    expect(new Date(tasks[0].next_run!).getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it('rejects an invalid cron expression', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'bad cron',
        schedule_type: 'cron',
        schedule_value: 'not-a-cron',
        targetJid: 'a@g.us',
      },
      'main-group',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
  });

  it('rejects a cron expression with interval under 5 minutes', async () => {
    // Every minute — too frequent
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'too frequent',
        schedule_type: 'cron',
        schedule_value: '* * * * *',
        targetJid: 'a@g.us',
      },
      'main-group',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
  });

  it('creates an interval task with next_run ~interval ms from now', async () => {
    const intervalMs = 3_600_000; // 1 hour
    const before = Date.now();

    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'hourly',
        schedule_type: 'interval',
        schedule_value: String(intervalMs),
        targetJid: 'a@g.us',
      },
      'main-group',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].schedule_type).toBe('interval');
    const nextRun = new Date(tasks[0].next_run!).getTime();
    expect(nextRun).toBeGreaterThanOrEqual(before + intervalMs - 1000);
    expect(nextRun).toBeLessThanOrEqual(Date.now() + intervalMs + 1000);
  });

  it('rejects interval below 5 minutes (300000 ms)', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'too short interval',
        schedule_type: 'interval',
        schedule_value: '60000', // 1 min — below minimum
        targetJid: 'a@g.us',
      },
      'main-group',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
  });

  it('rejects non-numeric interval value', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'bad interval',
        schedule_type: 'interval',
        schedule_value: 'abc',
        targetJid: 'a@g.us',
      },
      'main-group',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
  });

  it('creates a once task with the provided timestamp', async () => {
    const isoTime = '2027-06-01T12:00:00.000Z';

    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'run once',
        schedule_type: 'once',
        schedule_value: isoTime,
        targetJid: 'a@g.us',
      },
      'main-group',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].schedule_type).toBe('once');
    expect(tasks[0].next_run).toBe(new Date(isoTime).toISOString());
  });

  it('rejects an invalid once timestamp', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'bad date',
        schedule_type: 'once',
        schedule_value: 'not-a-date',
        targetJid: 'a@g.us',
      },
      'main-group',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// schedule_task — context_mode
// ---------------------------------------------------------------------------

describe('schedule_task context_mode', () => {
  it('stores context_mode=group when explicitly set', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'group mode',
        schedule_type: 'once',
        schedule_value: '2027-01-01T00:00:00.000Z',
        context_mode: 'group',
        targetJid: 'a@g.us',
      },
      'main-group',
      true,
      deps,
    );

    expect(getAllTasks()[0].context_mode).toBe('group');
  });

  it('defaults context_mode to isolated when value is invalid', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'unknown mode',
        schedule_type: 'once',
        schedule_value: '2027-01-01T00:00:00.000Z',
        context_mode: 'bogus',
        targetJid: 'a@g.us',
      },
      'main-group',
      true,
      deps,
    );

    expect(getAllTasks()[0].context_mode).toBe('isolated');
  });

  it('defaults context_mode to isolated when omitted', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'no mode',
        schedule_type: 'once',
        schedule_value: '2027-01-01T00:00:00.000Z',
        targetJid: 'a@g.us',
      },
      'main-group',
      true,
      deps,
    );

    expect(getAllTasks()[0].context_mode).toBe('isolated');
  });
});

// ---------------------------------------------------------------------------
// pause_task / resume_task / cancel_task authorization
// ---------------------------------------------------------------------------

describe('pause_task authorization', () => {
  beforeEach(() => {
    createTask({
      id: 'main-task',
      group_folder: 'main-group',
      chat_jid: 'main@g.us',
      prompt: 'main',
      schedule_type: 'once',
      schedule_value: '2027-01-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2027-01-01T00:00:00.000Z',
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    createTask({
      id: 'a-task',
      group_folder: 'group-a',
      chat_jid: 'a@g.us',
      prompt: 'a',
      schedule_type: 'once',
      schedule_value: '2027-01-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2027-01-01T00:00:00.000Z',
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });
  });

  it('main group can pause any task', async () => {
    await processTaskIpc(
      { type: 'pause_task', taskId: 'a-task' },
      'main-group',
      true,
      deps,
    );
    expect(getTaskById('a-task')!.status).toBe('paused');
  });

  it('non-main group can pause its own task', async () => {
    await processTaskIpc(
      { type: 'pause_task', taskId: 'a-task' },
      'group-a',
      false,
      deps,
    );
    expect(getTaskById('a-task')!.status).toBe('paused');
  });

  it('non-main group cannot pause another group\'s task', async () => {
    await processTaskIpc(
      { type: 'pause_task', taskId: 'main-task' },
      'group-a',
      false,
      deps,
    );
    expect(getTaskById('main-task')!.status).toBe('active');
  });
});

describe('resume_task authorization', () => {
  beforeEach(() => {
    createTask({
      id: 'paused-task',
      group_folder: 'group-a',
      chat_jid: 'a@g.us',
      prompt: 'paused',
      schedule_type: 'once',
      schedule_value: '2027-01-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2027-01-01T00:00:00.000Z',
      status: 'paused',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    createTask({
      id: 'other-paused',
      group_folder: 'group-b',
      chat_jid: 'b@g.us',
      prompt: 'other',
      schedule_type: 'once',
      schedule_value: '2027-01-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2027-01-01T00:00:00.000Z',
      status: 'paused',
      created_at: '2026-01-01T00:00:00.000Z',
    });
  });

  it('main group can resume any task', async () => {
    await processTaskIpc(
      { type: 'resume_task', taskId: 'paused-task' },
      'main-group',
      true,
      deps,
    );
    expect(getTaskById('paused-task')!.status).toBe('active');
  });

  it('non-main group can resume its own task', async () => {
    await processTaskIpc(
      { type: 'resume_task', taskId: 'paused-task' },
      'group-a',
      false,
      deps,
    );
    expect(getTaskById('paused-task')!.status).toBe('active');
  });

  it('non-main group cannot resume another group\'s task', async () => {
    await processTaskIpc(
      { type: 'resume_task', taskId: 'other-paused' },
      'group-a',
      false,
      deps,
    );
    expect(getTaskById('other-paused')!.status).toBe('paused');
  });
});

describe('cancel_task authorization', () => {
  it('main group can cancel any task', async () => {
    createTask({
      id: 'cancel-me',
      group_folder: 'group-a',
      chat_jid: 'a@g.us',
      prompt: 'delete',
      schedule_type: 'once',
      schedule_value: '2027-01-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });

    await processTaskIpc(
      { type: 'cancel_task', taskId: 'cancel-me' },
      'main-group',
      true,
      deps,
    );
    expect(getTaskById('cancel-me')).toBeUndefined();
  });

  it('non-main group can cancel its own task', async () => {
    createTask({
      id: 'own-cancel',
      group_folder: 'group-a',
      chat_jid: 'a@g.us',
      prompt: 'mine',
      schedule_type: 'once',
      schedule_value: '2027-01-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });

    await processTaskIpc(
      { type: 'cancel_task', taskId: 'own-cancel' },
      'group-a',
      false,
      deps,
    );
    expect(getTaskById('own-cancel')).toBeUndefined();
  });

  it('non-main group cannot cancel another group\'s task', async () => {
    createTask({
      id: 'foreign-task',
      group_folder: 'main-group',
      chat_jid: 'main@g.us',
      prompt: 'not yours',
      schedule_type: 'once',
      schedule_value: '2027-01-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });

    await processTaskIpc(
      { type: 'cancel_task', taskId: 'foreign-task' },
      'group-a',
      false,
      deps,
    );
    expect(getTaskById('foreign-task')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// register_group authorization
// ---------------------------------------------------------------------------

describe('register_group authorization', () => {
  it('main group can register a new group', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'new@g.us',
        name: 'New Group',
        folder: 'new-group',
        trigger: '@Alef',
      },
      'main-group',
      true,
      deps,
    );

    const stored = getRegisteredGroup('new@g.us');
    expect(stored).toBeDefined();
    expect(stored!.name).toBe('New Group');
    expect(stored!.folder).toBe('new-group');
  });

  it('non-main group cannot register a group', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'sneaky@g.us',
        name: 'Sneaky',
        folder: 'sneaky',
        trigger: '@Alef',
      },
      'group-a',
      false,
      deps,
    );

    expect(getRegisteredGroup('sneaky@g.us')).toBeUndefined();
  });

  it('main group cannot register with an unsafe folder path', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'bad@g.us',
        name: 'Bad',
        folder: '../../etc',
        trigger: '@Alef',
      },
      'main-group',
      true,
      deps,
    );

    expect(getRegisteredGroup('bad@g.us')).toBeUndefined();
  });

  it('register_group rejects when required fields are missing', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'partial@g.us',
        name: 'Partial',
        // folder and trigger missing
      },
      'main-group',
      true,
      deps,
    );

    expect(getRegisteredGroup('partial@g.us')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// refresh_groups authorization
// ---------------------------------------------------------------------------

describe('refresh_groups authorization', () => {
  it('non-main group is silently blocked', async () => {
    // Should not throw, syncGroups should not be called
    await processTaskIpc(
      { type: 'refresh_groups' },
      'group-a',
      false,
      deps,
    );

    expect(deps.syncGroups).not.toHaveBeenCalled();
  });

  it('main group triggers syncGroups', async () => {
    await processTaskIpc(
      { type: 'refresh_groups' },
      'main-group',
      true,
      deps,
    );

    expect(deps.syncGroups).toHaveBeenCalledWith(true);
  });
});

// ---------------------------------------------------------------------------
// IPC message authorization model (white-box unit test of the rule)
// ---------------------------------------------------------------------------

describe('IPC message authorization rule', () => {
  // Inline the same rule from ipc.ts for focused unit testing
  function isAuthorized(
    sourceGroup: string,
    isMain: boolean,
    targetJid: string,
    registered: Record<string, RegisteredGroup>,
  ): boolean {
    const target = registered[targetJid];
    return isMain || (!!target && target.folder === sourceGroup);
  }

  it('main group is always authorized', () => {
    expect(isAuthorized('main-group', true, 'a@g.us', groups)).toBe(true);
    expect(isAuthorized('main-group', true, 'unknown@g.us', groups)).toBe(true);
  });

  it('non-main group is authorized for its own JID', () => {
    expect(isAuthorized('group-a', false, 'a@g.us', groups)).toBe(true);
  });

  it('non-main group is rejected for another group\'s JID', () => {
    expect(isAuthorized('group-a', false, 'b@g.us', groups)).toBe(false);
    expect(isAuthorized('group-a', false, 'main@g.us', groups)).toBe(false);
  });

  it('non-main group is rejected for an unregistered JID', () => {
    expect(isAuthorized('group-a', false, 'unknown@g.us', groups)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// onTasksChanged is called after mutations
// ---------------------------------------------------------------------------

describe('onTasksChanged callback', () => {
  it('is called after schedule_task', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'callback test',
        schedule_type: 'once',
        schedule_value: '2027-01-01T00:00:00.000Z',
        targetJid: 'a@g.us',
      },
      'main-group',
      true,
      deps,
    );

    expect(deps.onTasksChanged).toHaveBeenCalledTimes(1);
  });

  it('is called after pause_task', async () => {
    createTask({
      id: 'cb-task',
      group_folder: 'group-a',
      chat_jid: 'a@g.us',
      prompt: 'cb',
      schedule_type: 'once',
      schedule_value: '2027-01-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });

    await processTaskIpc(
      { type: 'pause_task', taskId: 'cb-task' },
      'main-group',
      true,
      deps,
    );

    expect(deps.onTasksChanged).toHaveBeenCalledTimes(1);
  });
});
