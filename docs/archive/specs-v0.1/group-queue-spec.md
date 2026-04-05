# Spec: `src/group-queue.ts`

**Date:** 2026-04-04
**Round:** 2 (utility files clean-room pass)
**Tests:** `src/group-queue.test.ts` — 13 tests, 1 `describe('GroupQueue')` block

---

## Purpose

Serialises per-group container executions, enforces a global concurrency limit,
manages retry-with-backoff on failure, and coordinates IPC messaging between
the host and running containers.

---

## Imports

```typescript
import { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { DATA_DIR, MAX_CONCURRENT_CONTAINERS } from './config.js';
import { stopContainer } from './container-runtime.js';
import { logger } from './logger.js';
```

---

## Types (module-private)

```typescript
interface QueuedTask {
  id: string;
  groupJid: string;
  fn: () => Promise<void>;
}

interface GroupState {
  active: boolean;          // container is currently running
  idleWaiting: boolean;     // container finished work, waiting for IPC input
  isTaskContainer: boolean; // running a scheduled task (not message processing)
  runningTaskId: string | null;
  pendingMessages: boolean;
  pendingTasks: QueuedTask[];
  process: ChildProcess | null;
  containerName: string | null;
  groupFolder: string | null;
  retryCount: number;
}
```

---

## Constants (module-private)

```typescript
const MAX_RETRIES = 5;
const BASE_RETRY_MS = 5000;
```

---

## Class: `GroupQueue`

### Private fields

```typescript
private groups = new Map<string, GroupState>();
private activeCount = 0;
private waitingGroups: string[] = [];
private processMessagesFn: ((groupJid: string) => Promise<boolean>) | null = null;
private shuttingDown = false;
private onMaxRetriesFn: ((groupJid: string) => void) | null = null;
```

### Private method: `getGroup(groupJid: string): GroupState`

Returns existing state or creates and stores a new zero-state:
```typescript
{
  active: false, idleWaiting: false, isTaskContainer: false,
  runningTaskId: null, pendingMessages: false, pendingTasks: [],
  process: null, containerName: null, groupFolder: null, retryCount: 0,
}
```

---

### Public methods

#### `setProcessMessagesFn(fn: (groupJid: string) => Promise<boolean>): void`

Stores the callback used to launch message-processing containers.

---

#### `setOnMaxRetries(fn: (groupJid: string) => void): void`

Stores the callback invoked when a group exceeds `MAX_RETRIES` consecutive
failures.

---

#### `stopCurrentContainer(groupJid: string): boolean`

Immediately stops the active container for a group (e.g. on `/new` or `/reset`).

**Behaviour:**
1. Get state for `groupJid`. If `!state?.process || state.process.killed || !state.containerName`, return `false`.
2. Log `info` with `{ groupJid, containerName: state.containerName }` and
   `'Stopping container on user request (/new or /reset)'`.
3. Call `stopContainer(state.containerName)`.
4. Return `true`.

The container's exit handler fires normally; it rolls back the cursor and the
next message starts fresh.

---

#### `enqueueMessageCheck(groupJid: string): void`

Schedules a message-processing run for `groupJid`.

**Behaviour:**
1. If `shuttingDown`, return immediately.
2. `state = getGroup(groupJid)`.
3. If `state.active`: set `state.pendingMessages = true`, log `debug`
   `'Container active, message queued'`, return.
4. If `activeCount >= MAX_CONCURRENT_CONTAINERS`: set `state.pendingMessages = true`,
   add `groupJid` to `waitingGroups` (if not already present), log `debug`
   `'At concurrency limit, message queued'`, return.
5. Call `this.runForGroup(groupJid, 'messages')` (fire-and-forget with error
   log on rejection).

---

#### `enqueueTask(groupJid: string, taskId: string, fn: () => Promise<void>): void`

Queues a scheduled task for `groupJid`.

**Behaviour:**
1. If `shuttingDown`, return immediately.
2. `state = getGroup(groupJid)`.
3. **Dedup check:** if `state.runningTaskId === taskId`, log `debug`
   `'Task already running, skipping'`, return. If `state.pendingTasks.some(t => t.id === taskId)`,
   log `debug` `'Task already queued, skipping'`, return.
4. If `state.active`:
   - Push `{ id: taskId, groupJid, fn }` to `state.pendingTasks`.
   - If `state.idleWaiting`, call `this.closeStdin(groupJid)` (preempt idle container).
   - Log `debug` `'Container active, task queued'`, return.
5. If `activeCount >= MAX_CONCURRENT_CONTAINERS`:
   - Push task to `state.pendingTasks`, add to `waitingGroups` (if absent).
   - Log `debug` `'At concurrency limit, task queued'`, return.
6. Run immediately: `this.runTask(groupJid, { id: taskId, groupJid, fn })` (fire-and-forget).

---

#### `registerProcess(groupJid: string, proc: ChildProcess, containerName: string, groupFolder?: string): void`

Associates a running process with a group's state. Called by the container
runner after it spawns the container.

```typescript
state.process = proc;
state.containerName = containerName;
if (groupFolder) state.groupFolder = groupFolder;
```

---

#### `notifyIdle(groupJid: string): void`

Marks a container as idle-waiting (finished its current work, waiting for more
IPC input). If there are pending tasks, preempts immediately by closing stdin.

```typescript
state.idleWaiting = true;
if (state.pendingTasks.length > 0) {
  this.closeStdin(groupJid);
}
```

---

#### `sendMessage(groupJid: string, text: string): boolean`

Sends a follow-up message to an active message-processing container via an IPC
file drop.

**Behaviour:**
1. `state = getGroup(groupJid)`.
2. If `!state.active || !state.groupFolder || state.isTaskContainer`, return `false`.
3. Set `state.idleWaiting = false` (agent is about to receive work).
4. Build the IPC input directory:
   `inputDir = path.join(DATA_DIR, 'ipc', state.groupFolder, 'input')`
5. `fs.mkdirSync(inputDir, { recursive: true })`
6. Generate filename: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`
7. Write atomically: write JSON `{ type: 'message', text }` to `filepath.tmp`,
   then rename to `filepath`.
8. Return `true`.
9. On any fs error, return `false` (do not throw).

---

#### `closeStdin(groupJid: string): void`

Signals the active container to wind down by writing a `_close` sentinel to
the IPC input directory.

**Behaviour:**
1. `state = getGroup(groupJid)`.
2. If `!state.active || !state.groupFolder`, return.
3. `inputDir = path.join(DATA_DIR, 'ipc', state.groupFolder, 'input')`
4. `fs.mkdirSync(inputDir, { recursive: true })`
5. `fs.writeFileSync(path.join(inputDir, '_close'), '')`
6. Swallow any fs error.

---

#### `getActiveCount(): number`

Returns `this.activeCount`.

---

#### `async shutdown(_gracePeriodMs: number): Promise<void>`

Sets `shuttingDown = true`. Logs `info` with the count and names of currently
active containers but does NOT kill them — they will exit via idle timeout or
container timeout, and the Docker `--rm` flag cleans them up.

**Log:** `{ activeCount, detachedContainers: string[] }`,
`'GroupQueue shutting down (containers detached, not killed)'`

---

### Private methods

#### `async runForGroup(groupJid: string, reason: 'messages' | 'drain'): Promise<void>`

Executes a message-processing run.

**Behaviour:**
1. Set `state.active = true`, `state.idleWaiting = false`,
   `state.isTaskContainer = false`, `state.pendingMessages = false`.
2. `activeCount++`.
3. Log `debug` `{ groupJid, reason, activeCount }`, `'Starting container for group'`.
4. Try: if `processMessagesFn` is set, call it with `groupJid`.
   - If it returns `true`: reset `state.retryCount = 0`.
   - If it returns `false`: call `scheduleRetry(groupJid, state)`.
5. On catch: log `error` `{ groupJid, err }`, `'Error processing messages for group'`;
   call `scheduleRetry(groupJid, state)`.
6. Finally: reset `state.active = false`, `state.process = null`,
   `state.containerName = null`, `state.groupFolder = null`; `activeCount--`;
   call `drainGroup(groupJid)`.

---

#### `async runTask(groupJid: string, task: QueuedTask): Promise<void>`

Executes a scheduled task.

**Behaviour:**
1. Set `state.active = true`, `state.idleWaiting = false`,
   `state.isTaskContainer = true`, `state.runningTaskId = task.id`.
2. `activeCount++`.
3. Log `debug` `{ groupJid, taskId: task.id, activeCount }`, `'Running queued task'`.
4. Try: `await task.fn()`.
5. On catch: log `error` `{ groupJid, taskId: task.id, err }`, `'Error running task'`.
6. Finally: reset `state.active = false`, `state.isTaskContainer = false`,
   `state.runningTaskId = null`, `state.process = null`,
   `state.containerName = null`, `state.groupFolder = null`; `activeCount--`;
   call `drainGroup(groupJid)`.

---

#### `scheduleRetry(groupJid: string, state: GroupState): void`

**Behaviour:**
1. `state.retryCount++`.
2. If `state.retryCount > MAX_RETRIES`:
   - Log `error` `{ groupJid, retryCount }`,
     `'Max retries exceeded, dropping messages (will retry on next incoming message)'`.
   - Reset `state.retryCount = 0`.
   - Call `onMaxRetriesFn?.(groupJid)`.
   - Return.
3. `delayMs = BASE_RETRY_MS * Math.pow(2, state.retryCount - 1)`
   (5s, 10s, 20s, 40s, 80s for attempts 1–5).
4. Log `info` `{ groupJid, retryCount: state.retryCount, delayMs }`,
   `'Scheduling retry with backoff'`.
5. `setTimeout(() => { if (!shuttingDown) enqueueMessageCheck(groupJid); }, delayMs)`.

---

#### `drainGroup(groupJid: string): void`

Called after a run completes. Restarts work if there is more to do.

**Behaviour (in order):**
1. If `shuttingDown`, return.
2. If `state.pendingTasks.length > 0`: shift the first task and call
   `runTask(groupJid, task)` (fire-and-forget with error log). Return.
3. Else if `state.pendingMessages`: call `runForGroup(groupJid, 'drain')`
   (fire-and-forget). Return.
4. Else: call `drainWaiting()`.

---

#### `drainWaiting(): void`

Promotes groups from `waitingGroups` into free active slots.

**Behaviour:**
- While `waitingGroups.length > 0 && activeCount < MAX_CONCURRENT_CONTAINERS`:
  - Shift next `groupJid` from `waitingGroups`.
  - If `state.pendingTasks.length > 0`: shift first task, `runTask(...)`.
  - Else if `state.pendingMessages`: `runForGroup(groupJid, 'drain')`.
  - (If neither, skip — group had nothing to do.)

---

## Concurrency invariants

- At most `MAX_CONCURRENT_CONTAINERS` groups run simultaneously.
- Each group runs at most one container at a time (`state.active` gate).
- Tasks are prioritised over messages for the same group (`drainGroup` checks
  `pendingTasks` first).
- Waiting groups are served FIFO by `waitingGroups`.
- Retry countdown persists across runs; it resets only on success or
  MAX_RETRIES exceeded.

---

## What NOT to do

- Do not kill containers in `shutdown` — let them finish naturally.
- Do not use `process.stdin` or any pipe-based IPC — all IPC is via files.
- Do not add any global state outside the class instance.
- Do not use `setInterval` — only `setTimeout` for retries.
