# Spec: IPC Watcher (`src/ipc.ts`)

> Clean-room spec. Do not read the existing implementation before writing the replacement.

## Responsibility

Polls per-group filesystem directories for JSON command files written by containers. Processes each file, routes the command, deletes the file on success, and moves it to an error directory on failure. Enforces an authorization model based on which group wrote the file.

---

## Public API

```typescript
export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>
  registeredGroups: () => Record<string, RegisteredGroup>
  registerGroup: (jid: string, group: RegisteredGroup) => void
  syncGroups: (force: boolean) => Promise<void>
  getAvailableGroups: () => AvailableGroup[]
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void
  onTasksChanged: () => void
}

// Start the IPC poll loop. Idempotent — second call is a no-op.
export function startIpcWatcher(deps: IpcDeps): void

// Process a single IPC payload. Exported for testing.
export async function processTaskIpc(
  data: IpcPayload,
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
): Promise<void>
```

---

## Directory Layout

```
data/ipc/
  <groupFolder>/
    messages/     ← outbound message requests (type: "message")
    tasks/        ← task and group management commands
    input/        ← piped stdin (managed by GroupQueue, not IPC watcher)
  errors/         ← files that failed processing are moved here
```

The IPC base directory is `data/ipc/`. The watcher only processes direct subdirectories of this directory (not `errors/`).

---

## Poll Loop (`startIpcWatcher`)

Guards against duplicate start with a module-level flag.

On each iteration:

1. List all subdirectories of `data/ipc/` (excluding `errors/`). On read error, log and reschedule.
2. Build a `folder → isMain` lookup from the current registered groups.
3. For each group folder found:
   a. Process `messages/` directory — all `.json` files.
   b. Process `tasks/` directory — all `.json` files.
4. After processing all folders, `setTimeout(processIpcFiles, IPC_POLL_INTERVAL)`.

**File processing (both directories):**
- Read and parse JSON.
- Dispatch to the appropriate handler.
- On success: `unlink` the file.
- On any error: log the error, create `data/ipc/errors/`, move the file to `errors/<sourceGroup>-<filename>`.

---

## Message Handler

For a file in `<groupFolder>/messages/` with `{ type: "message", chatJid, text }`:

**Authorization:** The sending group (`sourceGroup`) may send to `chatJid` only if:
- It is the main group (`isMain = true`), OR
- The group registered for `chatJid` has `folder === sourceGroup`

If not authorized: log warn, do not send (file is still deleted — it's been examined).

If authorized: call `deps.sendMessage(chatJid, text)`.

---

## Task/Group Handler (`processTaskIpc`)

The `sourceGroup` and `isMain` values come from the filesystem directory path, not from the payload — this prevents a container from forging its own identity.

### `schedule_task`

Required fields: `prompt`, `schedule_type`, `schedule_value`, `targetJid`

1. Resolve target group from `targetJid`. Reject if not registered.
2. **Authorization:** non-main groups may only schedule tasks for themselves (`targetFolder === sourceGroup`).
3. Reject `schedule_value` strings longer than 200 characters.
4. Compute `nextRun`:
   - `cron`: parse with `CronExpressionParser`; reject if interval between first two occurrences is under 5 minutes.
   - `interval`: parse as integer ms; reject if NaN or under 300,000 ms (5 minutes).
   - `once`: parse as ISO date; reject if invalid.
5. Task ID: use `data.taskId` if provided, else generate `task-<timestamp>-<8 random hex bytes>` (crypto.randomBytes, not Math.random).
6. `context_mode`: accept `'group'` or `'isolated'`; default to `'isolated'`.
7. Call `createTask(...)` and `deps.onTasksChanged()`.

### `pause_task` / `resume_task` / `cancel_task`

Requires `taskId`. Look up task. **Authorization:** main group or task belongs to `sourceGroup`.
- `pause_task`: `updateTask(id, { status: 'paused' })`
- `resume_task`: `updateTask(id, { status: 'active' })`
- `cancel_task`: `deleteTask(id)`
- Call `deps.onTasksChanged()` on success.

### `update_task`

Requires `taskId`. Look up task. **Authorization:** main group or task belongs to `sourceGroup`.

Accepts updates to: `prompt`, `script`, `schedule_type`, `schedule_value`. Ignores unrecognised fields.

If schedule changed: recompute `next_run` using the updated schedule type/value (same validation as `schedule_task` for cron; for interval, recompute from now).

Call `updateTask(id, updates)` and `deps.onTasksChanged()`.

### `refresh_groups`

**Authorization:** main group only.

Call `deps.syncGroups(true)`, then `deps.writeGroupsSnapshot(sourceGroup, true, availableGroups, registeredJids)`.

### `register_group`

**Authorization:** main group only.

Required fields: `jid`, `name`, `folder`, `trigger`.

1. Validate `folder` via `isValidGroupFolder`; reject with warn if invalid.
2. Validate `containerConfig` if present:
   - Must be a plain object (not null, not array).
   - If `additionalMounts` is present, it must be an array.
   - Each mount entry must be an object with non-empty string `hostPath` and `containerPath`.
   - If any validation fails: discard the entire `containerConfig` (set to undefined).
3. `isMain` is **never** set from the IPC payload. Preserve the value from the existing registration if it exists.
4. Call `deps.registerGroup(jid, { name, folder, trigger, containerConfig, requiresTrigger, isMain: existingGroup?.isMain, added_at: new Date().toISOString() })`.

### Unknown type

Log warn. Do nothing. File is still deleted.

---

## Security Invariants

- Container identity (`sourceGroup`, `isMain`) is derived from the filesystem path, never from payload content.
- Non-main groups cannot: send messages to other groups, schedule tasks for other groups, modify other groups' tasks, register new groups, or trigger group syncs.
- `isMain` cannot be set or upgraded via IPC.
- `containerConfig.additionalMounts` input is validated before being passed to `registerGroup`; malformed configs are silently discarded rather than accepted partially.
- Schedule values are length-capped and rate-floored to prevent task-flood DoS.
- Task IDs use cryptographically random bytes.
