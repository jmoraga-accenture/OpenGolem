# Spec: `src/mount-security.ts`

**Date:** 2026-04-04
**Round:** 2 (utility files clean-room pass)
**Tests:** none yet — this file has no test file. The developer must write
`src/mount-security.test.ts` covering the public API. Aim for ≥ 12 tests.

---

## Purpose

Validates `additionalMounts` from group container config against an operator-
controlled allowlist stored **outside** the project root. Containers may request
extra mounts (e.g. a git repo for the agent to work on), but only paths that the
operator has explicitly allowed can be mounted, and only paths that do not match
security-sensitive patterns.

---

## Allowlist file

**Path:** imported as `MOUNT_ALLOWLIST_PATH` from `'./config.js'`.

Default: `~/.config/opengolem/mount-allowlist.json`

The file is JSON with this shape (TypeScript types from `'./types.js'`):

```typescript
interface AllowedRoot {
  path: string;          // may start with ~/
  allowReadWrite: boolean;
  description?: string;
}

interface MountAllowlist {
  allowedRoots: AllowedRoot[];
  blockedPatterns: string[];
  nonMainReadOnly: boolean;
}
```

---

## Module-level state (private)

```typescript
let cachedAllowlist: MountAllowlist | null = null;
let allowlistLoadError: string | null = null;
```

Used by `loadMountAllowlist` to cache the result across calls within a process.

---

## Default blocked patterns (private constant)

Always merged into every allowlist's `blockedPatterns`, regardless of what the
file contains:

```
'.ssh', '.gnupg', '.gpg', '.aws', '.azure', '.gcloud', '.kube', '.docker',
'credentials', '.env', '.netrc', '.npmrc', '.pypirc', 'id_rsa', 'id_ed25519',
'private_key', '.secret'
```

---

## Exports

### `loadMountAllowlist(): MountAllowlist | null`

Loads the allowlist file. Cached after first successful load; parse errors
are also cached (so the log is not spammed).

**Behaviour:**

1. If `cachedAllowlist !== null`: return it immediately.
2. If `allowlistLoadError !== null`: return `null` immediately (already failed).
3. If the file does not exist at `MOUNT_ALLOWLIST_PATH`:
   - Log `warn` with `{ path }` and message
     `'Mount allowlist not found - additional mounts will be BLOCKED. Create the file to enable additional mounts.'`
   - **Do NOT set `allowlistLoadError`** — file may appear without restart.
   - Return `null`.
4. Read and JSON-parse the file.
5. Validate structure (throw with descriptive messages if invalid):
   - `allowedRoots` must be an array.
   - `blockedPatterns` must be an array.
   - `nonMainReadOnly` must be a boolean.
6. Merge `blockedPatterns` with the default blocked patterns (deduplicate via
   `Set`). Store merged array back on the object.
7. Set `cachedAllowlist = allowlist`.
8. Log `info` with `{ path, allowedRoots: count, blockedPatterns: count }` and
   message `'Mount allowlist loaded successfully'`.
9. Return `cachedAllowlist`.

**On parse/validation error:**
- Set `allowlistLoadError` to the error message string.
- Log `error` with `{ path, error: allowlistLoadError }` and message
  `'Failed to load mount allowlist - additional mounts will be BLOCKED'`.
- Return `null`.

---

### `validateMount(mount: AdditionalMount, isMain: boolean): MountValidationResult`

Validates a single mount request.

**`AdditionalMount` shape (from `'./types.js'`):**
```typescript
interface AdditionalMount {
  hostPath: string;
  containerPath?: string;  // optional; defaults to basename of hostPath
  readonly?: boolean;       // undefined / true = readonly; false = request rw
}
```

**`MountValidationResult` shape:**
```typescript
export interface MountValidationResult {
  allowed: boolean;
  reason: string;
  realHostPath?: string;
  resolvedContainerPath?: string;
  effectiveReadonly?: boolean;
}
```

**Steps (in order):**

1. **Load allowlist.** If `null`, return:
   ```
   { allowed: false, reason: `No mount allowlist configured at ${MOUNT_ALLOWLIST_PATH}` }
   ```

2. **Resolve container path.** If `mount.containerPath` is set use it;
   otherwise use `path.basename(mount.hostPath)`.

3. **Validate container path** via `isValidContainerPath(containerPath)`.
   If invalid, return:
   ```
   { allowed: false, reason: `Invalid container path: "${containerPath}" - must be relative, non-empty, and not contain ".."` }
   ```

4. **Expand and resolve host path.** Call `expandPath(mount.hostPath)` then
   `getRealPath(expandedPath)`. If `realPath === null`, return:
   ```
   { allowed: false, reason: `Host path does not exist: "${mount.hostPath}" (expanded: "${expandedPath}")` }
   ```

5. **Check blocked patterns** via `matchesBlockedPattern(realPath, allowlist.blockedPatterns)`.
   If matched, return:
   ```
   { allowed: false, reason: `Path matches blocked pattern "${blockedMatch}": "${realPath}"` }
   ```

6. **Find allowed root** via `findAllowedRoot(realPath, allowlist.allowedRoots)`.
   If none found, return:
   ```
   { allowed: false, reason: `Path "${realPath}" is not under any allowed root. Allowed roots: ${...}` }
   ```
   The root list in the message is the expanded paths joined with `', '`.

7. **Determine effective readonly.** Default `effectiveReadonly = true`.
   If `mount.readonly === false` (explicitly requesting rw):
   - If `!isMain && allowlist.nonMainReadOnly`: force readonly, log `info`
     with `{ mount: mount.hostPath }` and
     `'Mount forced to read-only for non-main group'`.
   - Else if `!allowedRoot.allowReadWrite`: force readonly, log `info`
     with `{ mount: mount.hostPath, root: allowedRoot.path }` and
     `'Mount forced to read-only - root does not allow read-write'`.
   - Else: `effectiveReadonly = false`.

8. Return:
   ```typescript
   {
     allowed: true,
     reason: `Allowed under root "${allowedRoot.path}"${allowedRoot.description ? ` (${allowedRoot.description})` : ''}`,
     realHostPath: realPath,
     resolvedContainerPath: containerPath,
     effectiveReadonly,
   }
   ```

---

### `validateAdditionalMounts(mounts: AdditionalMount[], groupName: string, isMain: boolean): Array<{ hostPath: string; containerPath: string; readonly: boolean }>`

Validates all mounts for a group; returns only those that passed.

**Behaviour:**
- For each `mount`, call `validateMount(mount, isMain)`.
- If `result.allowed`:
  - Push `{ hostPath: result.realHostPath!, containerPath: `/workspace/extra/${result.resolvedContainerPath}`, readonly: result.effectiveReadonly! }`.
  - Log `debug` with `{ group, hostPath, containerPath, readonly, reason }` and
    `'Mount validated successfully'`.
- If `!result.allowed`:
  - Log `warn` with `{ group, requestedPath: mount.hostPath, containerPath: mount.containerPath, reason }` and
    `'Additional mount REJECTED'`.
- Return the array of valid mounts.

---

### `generateAllowlistTemplate(): string`

Returns a JSON string (pretty-printed, 2-space indent) of a template
`MountAllowlist` to help operators bootstrap the config file.

**Template content:**
```json
{
  "allowedRoots": [
    { "path": "~/projects", "allowReadWrite": true, "description": "Development projects" },
    { "path": "~/repos", "allowReadWrite": true, "description": "Git repositories" },
    { "path": "~/Documents/work", "allowReadWrite": false, "description": "Work documents (read-only)" }
  ],
  "blockedPatterns": ["password", "secret", "token"],
  "nonMainReadOnly": true
}
```

---

## Private helpers

### `expandPath(p: string): string`

Expands `~` to the home directory:
- `p.startsWith('~/')` → `path.join(homeDir, p.slice(2))`
- `p === '~'` → `homeDir`
- Otherwise → `path.resolve(p)`

Home directory: `process.env.HOME || os.homedir()`.

---

### `getRealPath(p: string): string | null`

Calls `fs.realpathSync(p)`. Returns the real path, or `null` if it throws.

---

### `matchesBlockedPattern(realPath: string, blockedPatterns: string[]): string | null`

Checks whether any path component or the full path contains a blocked pattern.

- Split `realPath` on `path.sep`.
- For each `pattern` in `blockedPatterns`:
  - For each `part` in the split array: if `part === pattern || part.includes(pattern)` → return `pattern`.
  - If `realPath.includes(pattern)` → return `pattern`.
- Return `null` if nothing matched.

---

### `findAllowedRoot(realPath: string, allowedRoots: AllowedRoot[]): AllowedRoot | null`

Returns the first `AllowedRoot` under which `realPath` falls, or `null`.

For each root:
1. `expandedRoot = expandPath(root.path)`.
2. `realRoot = getRealPath(expandedRoot)`. If `null`, skip.
3. `rel = path.relative(realRoot, realPath)`.
4. If `!rel.startsWith('..') && !path.isAbsolute(rel)`, return the root.

Return `null` if no root matches.

---

### `isValidContainerPath(containerPath: string): boolean`

Returns `false` if any of the following:
- Contains `..`
- Starts with `/` (absolute)
- Is empty or whitespace-only
- Contains `:` (prevents Docker mount option injection)

Otherwise returns `true`.

---

## Imports

```typescript
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MOUNT_ALLOWLIST_PATH } from './config.js';
import { logger } from './logger.js';
import { AdditionalMount, AllowedRoot, MountAllowlist } from './types.js';
```

---

## What NOT to do

- Do not expose private helpers as exports.
- Do not allow `cachedAllowlist` to be reset at runtime (process-lifetime cache
  is intentional so operators cannot trick the running process by swapping the
  file).
- **Exception:** file-not-found is NOT cached (operator may create the file
  without restarting).
- Do not throw from `validateAdditionalMounts` — log and skip rejected mounts.
