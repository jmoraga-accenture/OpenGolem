import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _closeDatabase,
  _initTestDatabase,
  createTask,
  getAllRegisteredGroups,
  getAllTasks,
  getDueTasks,
  getMessagesSince,
  getNewMessages,
  setRegisteredGroup,
  storeChatMetadata,
  storeMessage,
  updateTask,
} from './db.js';
import type { NewMessage, RegisteredGroup, ScheduledTask } from './types.js';

vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/og-db-test',
  STORE_DIR: '/tmp/og-db-test/store',
  ASSISTANT_NAME: 'Alef',
}));

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// group-folder validation: allow alphanumeric + hyphens, min 1 char
vi.mock('./group-folder.js', () => ({
  isValidGroupFolder: (folder: string) => /^[a-z0-9][a-z0-9-]*$/.test(folder),
}));

beforeEach(() => {
  _initTestDatabase();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessage(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    id: 'msg-1',
    chat_jid: 'chat@test',
    sender: 'sender@test',
    sender_name: 'Alice',
    content: 'Hello world',
    timestamp: new Date().toISOString(),
    is_from_me: false,
    is_bot_message: false,
    reply_to_message_id: undefined,
    reply_to_message_content: undefined,
    reply_to_sender_name: undefined,
    ...overrides,
  };
}

function makeGroup(overrides: Partial<RegisteredGroup> = {}): RegisteredGroup {
  return {
    name: 'Test Group',
    folder: 'test-group',
    trigger: '@Alef',
    added_at: new Date().toISOString(),
    requiresTrigger: true,
    isMain: false,
    assertivenessLevel: 10,
    ...overrides,
  };
}

function makeTask(
  overrides: Partial<Omit<ScheduledTask, 'last_run' | 'last_result'>> = {},
): Omit<ScheduledTask, 'last_run' | 'last_result'> {
  return {
    id: 'task-1',
    group_folder: 'test-group',
    chat_jid: 'chat@test',
    prompt: 'Send a daily summary',
    script: null,
    schedule_type: 'cron',
    schedule_value: '0 9 * * *',
    context_mode: 'isolated',
    next_run: new Date(Date.now() + 60_000).toISOString(),
    status: 'active',
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// initDatabase / _initTestDatabase
// ---------------------------------------------------------------------------

describe('_initTestDatabase', () => {
  it('initialises without throwing', () => {
    // _initTestDatabase() was already called in beforeEach — no error means pass
    expect(true).toBe(true);
  });

  it('can be called multiple times (re-opens cleanly)', () => {
    _initTestDatabase();
    _initTestDatabase();
    // Should be functional after double init
    expect(() => getAllTasks()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// storeChatMetadata
// ---------------------------------------------------------------------------

describe('storeChatMetadata', () => {
  it('inserts a new chat row', () => {
    const ts = new Date().toISOString();
    expect(() =>
      storeChatMetadata('jid@test', ts, 'Test Chat', 'telegram', false),
    ).not.toThrow();
  });

  it('upserts — updating name and channel on conflict', () => {
    const ts1 = '2025-01-01T00:00:00.000Z';
    const ts2 = '2025-01-02T00:00:00.000Z';
    storeChatMetadata('jid@test', ts1, 'Old Name', 'telegram', false);
    storeChatMetadata('jid@test', ts2, 'New Name', 'telegram', false);
    // Calling again should not throw
    expect(() =>
      storeChatMetadata('jid@test', ts2, 'New Name', 'telegram', false),
    ).not.toThrow();
  });

  it('accepts undefined name and channel', () => {
    const ts = new Date().toISOString();
    expect(() => storeChatMetadata('jid2@test', ts)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// storeMessage / getMessagesSince
// ---------------------------------------------------------------------------

describe('storeMessage', () => {
  it('stores a message without error', () => {
    storeChatMetadata('chat@test', new Date().toISOString());
    expect(() => storeMessage(makeMessage())).not.toThrow();
  });

  it('replaces an existing message with the same id+chat_jid', () => {
    storeChatMetadata('chat@test', new Date().toISOString());
    const msg = makeMessage({ content: 'original' });
    storeMessage(msg);
    storeMessage({ ...msg, content: 'updated' });
    // Should not throw on duplicate
    const msgs = getMessagesSince(
      'chat@test',
      '1970-01-01T00:00:00.000Z',
      'Alef',
    );
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('updated');
  });

  it('stores reply fields when provided', () => {
    storeChatMetadata('chat@test', new Date().toISOString());
    const msg = makeMessage({
      id: 'reply-msg',
      reply_to_message_id: 'orig-id',
      reply_to_message_content: 'original content',
      reply_to_sender_name: 'Bob',
    });
    storeMessage(msg);
    const msgs = getMessagesSince(
      'chat@test',
      '1970-01-01T00:00:00.000Z',
      'Alef',
    );
    expect(msgs[0].reply_to_message_id).toBe('orig-id');
    expect(msgs[0].reply_to_sender_name).toBe('Bob');
  });
});

// ---------------------------------------------------------------------------
// getMessagesSince
// ---------------------------------------------------------------------------

describe('getMessagesSince', () => {
  beforeEach(() => {
    storeChatMetadata('chat@test', new Date().toISOString());
  });

  it('returns messages after the given timestamp', () => {
    const early = '2025-01-01T00:00:00.000Z';
    const late = '2025-06-01T00:00:00.000Z';
    storeMessage(
      makeMessage({ id: 'm1', timestamp: '2025-03-01T00:00:00.000Z' }),
    );
    storeMessage(
      makeMessage({ id: 'm2', timestamp: '2025-07-01T00:00:00.000Z' }),
    );

    const results = getMessagesSince('chat@test', early, 'Alef');
    expect(results.length).toBe(2);

    const results2 = getMessagesSince('chat@test', late, 'Alef');
    expect(results2.length).toBe(1);
    expect(results2[0].id).toBe('m2');
  });

  it('excludes bot messages', () => {
    storeMessage(
      makeMessage({
        id: 'human',
        timestamp: '2025-03-01T00:00:00.000Z',
        is_bot_message: false,
      }),
    );
    storeMessage(
      makeMessage({
        id: 'bot',
        timestamp: '2025-03-02T00:00:00.000Z',
        is_bot_message: true,
      }),
    );

    const results = getMessagesSince(
      'chat@test',
      '1970-01-01T00:00:00.000Z',
      'Alef',
    );
    expect(results.map((m) => m.id)).not.toContain('bot');
    expect(results.map((m) => m.id)).toContain('human');
  });

  it('excludes messages matching botPrefix pattern', () => {
    storeMessage(
      makeMessage({
        id: 'prefixed',
        timestamp: '2025-03-01T00:00:00.000Z',
        content: 'Alef: some reply',
      }),
    );
    storeMessage(
      makeMessage({
        id: 'normal',
        timestamp: '2025-03-02T00:00:00.000Z',
        content: 'regular text',
      }),
    );

    const results = getMessagesSince(
      'chat@test',
      '1970-01-01T00:00:00.000Z',
      'Alef',
    );
    expect(results.map((m) => m.id)).not.toContain('prefixed');
  });

  it('returns empty array when no messages exist for chat', () => {
    const results = getMessagesSince(
      'empty-chat@test',
      '1970-01-01T00:00:00.000Z',
      'Alef',
    );
    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getNewMessages
// ---------------------------------------------------------------------------

describe('getNewMessages', () => {
  beforeEach(() => {
    storeChatMetadata('chat1@test', new Date().toISOString());
    storeChatMetadata('chat2@test', new Date().toISOString());
  });

  it('returns empty result when jids array is empty', () => {
    const result = getNewMessages([], '1970-01-01T00:00:00.000Z', 'Alef');
    expect(result).toEqual({ messages: [], newTimestamp: '' });
  });

  it('returns messages across multiple chats after lastTimestamp', () => {
    storeMessage(
      makeMessage({
        id: 'a1',
        chat_jid: 'chat1@test',
        timestamp: '2025-03-01T00:00:00.000Z',
      }),
    );
    storeMessage(
      makeMessage({
        id: 'a2',
        chat_jid: 'chat2@test',
        timestamp: '2025-04-01T00:00:00.000Z',
      }),
    );

    const result = getNewMessages(
      ['chat1@test', 'chat2@test'],
      '2025-02-01T00:00:00.000Z',
      'Alef',
    );
    expect(result.messages.length).toBe(2);
    // newTimestamp should be the latest timestamp
    expect(result.newTimestamp).toBe('2025-04-01T00:00:00.000Z');
  });

  it('preserves lastTimestamp when no new messages exist', () => {
    const ts = '2025-01-01T00:00:00.000Z';
    const result = getNewMessages(['chat1@test'], ts, 'Alef');
    expect(result.messages).toEqual([]);
    expect(result.newTimestamp).toBe(ts);
  });
});

// ---------------------------------------------------------------------------
// setRegisteredGroup / getAllRegisteredGroups
// ---------------------------------------------------------------------------

describe('setRegisteredGroup / getAllRegisteredGroups', () => {
  it('registers a new group', () => {
    setRegisteredGroup('jid@test', makeGroup());
    const all = getAllRegisteredGroups();
    expect(Object.keys(all)).toContain('jid@test');
    expect(all['jid@test'].name).toBe('Test Group');
  });

  it('upserts on duplicate jid', () => {
    setRegisteredGroup('jid@test', makeGroup({ name: 'Original' }));
    setRegisteredGroup('jid@test', makeGroup({ name: 'Updated' }));
    const all = getAllRegisteredGroups();
    expect(all['jid@test'].name).toBe('Updated');
  });

  it('throws for invalid folder name', () => {
    expect(() =>
      setRegisteredGroup('jid@test', makeGroup({ folder: '../evil' })),
    ).toThrow();
  });

  it('getAllRegisteredGroups returns empty object when none registered', () => {
    const all = getAllRegisteredGroups();
    expect(all).toEqual({});
  });

  it('stores and retrieves containerConfig', () => {
    const group = makeGroup({
      containerConfig: { timeout: 60000, additionalMounts: [] },
    });
    setRegisteredGroup('jid-cfg@test', group);
    const all = getAllRegisteredGroups();
    expect(all['jid-cfg@test'].containerConfig?.timeout).toBe(60000);
  });

  it('stores requiresTrigger=false correctly', () => {
    setRegisteredGroup(
      'jid-no-trigger@test',
      makeGroup({ requiresTrigger: false }),
    );
    const all = getAllRegisteredGroups();
    expect(all['jid-no-trigger@test'].requiresTrigger).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createTask / getAllTasks / getDueTasks / updateTask
// ---------------------------------------------------------------------------

describe('task CRUD', () => {
  it('createTask stores the task', () => {
    createTask(makeTask());
    const all = getAllTasks();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe('task-1');
    expect(all[0].prompt).toBe('Send a daily summary');
    expect(all[0].last_run).toBeNull();
    expect(all[0].last_result).toBeNull();
  });

  it('getAllTasks returns all tasks regardless of status', () => {
    createTask(makeTask({ id: 't1', status: 'active' }));
    createTask(makeTask({ id: 't2', status: 'paused' }));
    createTask(makeTask({ id: 't3', status: 'completed' }));
    expect(getAllTasks()).toHaveLength(3);
  });

  it('getDueTasks returns only active tasks with next_run <= now', () => {
    const past = new Date(Date.now() - 5000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();

    createTask(makeTask({ id: 'due', next_run: past, status: 'active' }));
    createTask(makeTask({ id: 'future', next_run: future, status: 'active' }));
    createTask(makeTask({ id: 'paused', next_run: past, status: 'paused' }));

    const due = getDueTasks();
    expect(due.map((t) => t.id)).toContain('due');
    expect(due.map((t) => t.id)).not.toContain('future');
    expect(due.map((t) => t.id)).not.toContain('paused');
  });

  it('getDueTasks returns empty when no tasks are due', () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    createTask(makeTask({ id: 'not-due', next_run: future }));
    expect(getDueTasks()).toHaveLength(0);
  });

  it('updateTask modifies specified fields', () => {
    createTask(makeTask({ id: 'upd-task', status: 'active' }));
    updateTask('upd-task', { status: 'paused', prompt: 'Updated prompt' });
    const all = getAllTasks();
    const task = all.find((t) => t.id === 'upd-task');
    expect(task?.status).toBe('paused');
    expect(task?.prompt).toBe('Updated prompt');
    // Other fields unchanged
    expect(task?.schedule_type).toBe('cron');
  });

  it('updateTask with empty updates is a no-op', () => {
    createTask(makeTask({ id: 'noop-task' }));
    expect(() => updateTask('noop-task', {})).not.toThrow();
    const all = getAllTasks();
    expect(all[0].prompt).toBe('Send a daily summary');
  });

  it('createTask stores script field', () => {
    createTask(makeTask({ id: 'script-task', script: 'console.log("hello")' }));
    const all = getAllTasks();
    const task = all.find((t) => t.id === 'script-task');
    expect(task?.script).toBe('console.log("hello")');
  });

  it('createTask with null script stores null', () => {
    createTask(makeTask({ id: 'null-script', script: null }));
    const all = getAllTasks();
    const task = all.find((t) => t.id === 'null-script');
    expect(task?.script).toBeNull();
  });
});
