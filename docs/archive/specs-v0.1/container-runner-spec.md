# Spec: Container Runner (`src/container-runner.ts`)

> Clean-room spec. Do not read the existing implementation before writing the replacement.

## Responsibility

Spawns a container for each agent run, feeds it a JSON payload on stdin, streams structured output from stdout, and resolves with a `ContainerOutput` when the container exits. Also writes per-group JSON snapshots (tasks, available groups) that containers read at startup.

---

## Public API

```typescript
// Spawn a container and run the agent
export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput>

// Write tasks visible to a group into its IPC directory
export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: TaskRow[],
): void

// Write available groups visible to a group into its IPC directory
export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  registeredJids: Set<string>,
): void

export interface ContainerInput {
  prompt: string
  sessionId?: string
  groupFolder: string
  chatJid: string
  isMain: boolean
  isScheduledTask?: boolean
  assistantName?: string
  script?: string
  soulMd?: string   // SOUL.md content with assertiveness_level already interpolated
}

export interface ContainerOutput {
  status: 'success' | 'error'
  result: string | null
  newSessionId?: string
  error?: string
}

export interface AvailableGroup {
  jid: string
  name: string
  lastActivity: string
  isRegistered: boolean
}
```

---

## Sentinel Protocol

The container writes structured results to stdout wrapped in sentinel markers:

```
---OPENGOLEM_OUTPUT_START---
{ "status": "success"|"error", "result": "...", "newSessionId": "..." }
---OPENGOLEM_OUTPUT_END---
```

The host parses these markers as they stream. Multiple marker pairs may appear in a single run (streaming mode). Both sides must use identical marker strings; they are defined as constants in both host and container code — change both or neither.

---

## `runContainerAgent`

### Preparation

1. Ensure group directory exists.
2. Interpolate SOUL.md: load `SOUL.md` from project root, replace `{{assertiveness_level}}` with `group.assertivenessLevel ?? 10`. Attach as `input.soulMd` if not already set. Gracefully skip if file absent.
3. Build volume mounts for the group (see Volume Mounts section).
4. Generate container name: `opengolem-<safe-folder>-<timestamp>` where safe-folder has non-alphanumeric/hyphen chars replaced with `-`.
5. Request a scoped broker token from the Token Broker (fire-and-forget — continue without one if broker is unavailable).
6. Build container args (see Container Args section).

### Spawn

```
spawn(CONTAINER_RUNTIME_BIN, containerArgs, { stdio: ['pipe', 'pipe', 'pipe'] })
```

1. Call `onProcess(proc, containerName)` immediately so the GroupQueue can track the process.
2. Write `JSON.stringify(input)` to container stdin, then end stdin.

### Stdout Handling

Accumulate all stdout for logging (up to `CONTAINER_MAX_OUTPUT_SIZE`; truncate and warn beyond that).

If `onOutput` is provided (streaming mode):

- Maintain a parse buffer. As data arrives, scan for complete `OUTPUT_START...OUTPUT_END` pairs.
- For each complete pair: parse JSON as `ContainerOutput`, extract `newSessionId` if present, call `onOutput(parsed)` via a chained promise (preserve ordering).
- Reset the hard timeout on each successfully parsed output pair.
- Track whether any streaming output was received (`hadStreamingOutput`).
- Track whether a stale session error was seen in any streamed result.

### Stderr Handling

Log each line at debug level. Do **not** reset the hard timeout on stderr (SDK writes continuous debug logs — only real output should extend the deadline). Accumulate up to `CONTAINER_MAX_OUTPUT_SIZE`.

### Hard Timeout

- Effective timeout = `max(group.containerConfig?.timeout ?? CONTAINER_TIMEOUT, IDLE_TIMEOUT + 30_000)`.
  - The 30s grace ensures the idle sentinel has time to fire before the hard kill.
- On timeout: call `stopContainer(containerName)`. If that fails, `SIGKILL`.
- Set `timedOut = true`.

### On Container Close

1. Clear timeout. Revoke broker token (fire-and-forget).
2. Write a log file to `<groupDir>/logs/container-<timestamp>.log`:
   - Always include: timestamp, group name, isMain, duration, exit code, truncation flags.
   - On error or verbose (`LOG_LEVEL=debug|trace`): include input summary (not full prompt unless verbose), container args, mounts, stderr, stdout.
   - Normal success: input summary (prompt length, session ID), mount list (container paths only).
3. If `timedOut`:
   - If `hadStreamingOutput`: treat as idle cleanup (success). Wait for output chain to settle, resolve `{ status: 'success', result: null, newSessionId }`.
   - Else: resolve `{ status: 'error', result: null, error: 'Container timed out after Nms' }`.
4. If `code !== 0`: resolve with `status: 'error'`. If `staleSessionDetected`, use error message `'No conversation found — stale session cleared'`; otherwise `'Container exited with code N'`. Do not expose stderr to caller.
5. If `onOutput` was provided (streaming mode): wait for output chain to settle, resolve `{ status: 'success', result: null, newSessionId }`.
6. Legacy mode (no `onOutput`): find the last `OUTPUT_START...OUTPUT_END` pair in accumulated stdout and parse it. Fallback to last non-empty line if markers absent. Resolve with parsed output or error.

### Container Spawn Error

Resolve with `{ status: 'error', result: null, error: 'Container spawn error: <message>' }`.

---

## Volume Mounts

Returns a list of `{ hostPath, containerPath, readonly }` entries. The ordering is deterministic.

### Main group (`isMain = true`)

| Host path | Container path | Readonly |
|---|---|---|
| `<projectRoot>` | `/workspace/project` | yes |
| `/dev/null` | `/workspace/project/.env` | yes (shadows .env in project mount) |
| `<groupDir>` | `/workspace/group` | no |

### Non-main groups

| Host path | Container path | Readonly |
|---|---|---|
| `<groupDir>` | `/workspace/group` | no |
| `groups/global/` | `/workspace/global` | yes (only if directory exists) |

### All groups (appended after the above)

| Host path | Container path | Readonly | Notes |
|---|---|---|---|
| `data/sessions/<folder>/.claude/` | `/home/node/.claude` | no | Created if absent; `settings.json` written if absent; skills synced from `container/skills/` |
| `data/ipc/<folder>/` | `/workspace/ipc` | no | Sub-dirs `messages/`, `tasks/`, `input/` created if absent |
| `data/sessions/<folder>/agent-runner-src/` | `/app/src` | no | Copied from `container/agent-runner/src/` when absent or stale |
| `data/extra/` | `/workspace/extra` | yes | Created if absent |
| additional mounts from `group.containerConfig.additionalMounts` | as specified | as specified | Validated via `validateAdditionalMounts` |

**`.env` shadow:** The `.env` mount to `/dev/null` only appears if `<projectRoot>/.env` exists. Its purpose is to prevent the agent from reading host secrets even if it somehow navigates to `/workspace/project`.

**`settings.json` contents:**
```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1",
    "CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD": "1",
    "CLAUDE_CODE_DISABLE_AUTO_MEMORY": "0"
  }
}
```

**Skills sync:** for each subdirectory under `container/skills/`, copy the entire directory into `data/sessions/<folder>/.claude/skills/<name>` using `fs.cpSync`.

**Agent-runner copy:** copy `container/agent-runner/src/` to `data/sessions/<folder>/agent-runner-src/` when the destination is absent, the destination index.ts is absent, or the source index.ts is newer than the destination index.ts.

---

## Container Args

```
[CONTAINER_RUNTIME_BIN] run -i --rm --name <containerName>
  -e TZ=<TIMEZONE>
  -e NO_UPDATE_NOTIFIER=1
  -e ANTHROPIC_BASE_URL=<proxyUrl>
  -e ANTHROPIC_API_KEY=proxied        (if auth mode is api-key)
    OR
  -e CLAUDE_CODE_OAUTH_TOKEN=proxied  (if auth mode is oauth)
  -e OPENGOLEM_BROKER_TOKEN=<token>   (if token was issued)
  [hostGatewayArgs...]                (runtime-specific: --add-host or nothing)
  --user <hostUid>:<hostGid>          (only if hostUid != null, != 0, != 1000)
  -e HOME=/home/node                  (only when --user is added)
  [-v or readonly mount args for each mount...]
  <CONTAINER_IMAGE>
```

Readonly mounts use the format produced by `readonlyMountArgs(hostPath, containerPath)` from `container-runtime.ts`.

---

## `writeTasksSnapshot`

Write to `data/ipc/<groupFolder>/current_tasks.json`:
- Main group sees all tasks.
- Non-main groups see only tasks where `groupFolder` matches.

---

## `writeGroupsSnapshot`

Write to `data/ipc/<groupFolder>/available_groups.json`:
```json
{
  "groups": [...],   // main: all; non-main: []
  "lastSync": "<ISO timestamp>"
}
```

---

## Security Invariants

- `.env` is never readable by containers; the mount to `/dev/null` is the mechanism.
- Credentials are injected as placeholder values (`proxied`); real credentials are never passed to containers.
- Broker token is revoked on container exit regardless of success/failure.
- Full stderr is logged server-side but never returned to callers (prevents leaking stack traces and file paths).
- Additional mounts are validated before use.
- Agent-runner source is per-group; changes in one group's agent-runner do not affect others.
