# Spec: `src/group-folder.ts`

**Date:** 2026-04-04
**Round:** 2 (utility files clean-room pass)
**Tests:** `src/group-folder.test.ts` — 8 tests, 1 `describe` block

---

## Purpose

Path validation and resolution for group folder names. Prevents path-traversal
attacks when group JIDs are used to construct filesystem paths.

---

## Constants (module-private)

```
GROUP_FOLDER_PATTERN  = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
RESERVED_FOLDERS      = Set { 'global' }
```

---

## Exports

### `isValidGroupFolder(folder: string): boolean`

Returns `true` only when ALL of the following hold:

1. `folder` is a non-empty string.
2. `folder === folder.trim()` — no leading/trailing whitespace.
3. `GROUP_FOLDER_PATTERN.test(folder)` — alphanumeric start, then
   `[A-Za-z0-9_-]`, max 64 characters total.
4. Does not contain `/` or `\`.
5. Does not contain `..`.
6. `folder.toLowerCase()` is not in `RESERVED_FOLDERS` (currently `'global'`).

Returns `false` if any check fails.

---

### `assertValidGroupFolder(folder: string): void`

Calls `isValidGroupFolder(folder)`. If it returns `false`, throws:

```
new Error(`Invalid group folder "${folder}"`)
```

---

### `resolveGroupFolderPath(folder: string): string`

Returns the absolute filesystem path for a group's working directory.

**Steps:**
1. Call `assertValidGroupFolder(folder)` — throws if invalid.
2. Compute `groupPath = path.resolve(GROUPS_DIR, folder)`.
3. Verify `groupPath` is within `GROUPS_DIR` using a containment check
   (see below). Throw if it escapes.
4. Return `groupPath`.

**Import:** `GROUPS_DIR` from `'./config.js'`.

---

### `resolveGroupIpcPath(folder: string): string`

Returns the absolute filesystem path for a group's IPC directory.

**Steps:**
1. Call `assertValidGroupFolder(folder)` — throws if invalid.
2. Compute `ipcBaseDir = path.resolve(DATA_DIR, 'ipc')`.
3. Compute `ipcPath = path.resolve(ipcBaseDir, folder)`.
4. Verify `ipcPath` is within `ipcBaseDir` using a containment check
   (see below). Throw if it escapes.
5. Return `ipcPath`.

**Import:** `DATA_DIR` from `'./config.js'`.

---

## Containment check (private helper)

```
function ensureWithinBase(baseDir: string, resolvedPath: string): void
```

Computes `rel = path.relative(baseDir, resolvedPath)`. Throws if:
- `rel.startsWith('..')`, OR
- `path.isAbsolute(rel)`

Error message: `Path escapes base directory: ${resolvedPath}`

---

## Imports

```typescript
import path from 'path';
import { DATA_DIR, GROUPS_DIR } from './config.js';
```

No other imports.

---

## What NOT to do

- Do not perform any filesystem I/O (no `fs.existsSync`, `fs.mkdirSync`, etc.).
- Do not normalise or sanitise `folder` — reject it if invalid.
- Do not export the containment check helper or the constants.
