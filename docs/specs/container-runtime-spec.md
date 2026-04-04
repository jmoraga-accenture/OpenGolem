# Spec: `src/container-runtime.ts`

**Date:** 2026-04-04
**Round:** 2 (utility files clean-room pass)
**Tests:** `src/container-runtime.test.ts` — 19 tests across 4 `describe` blocks

---

## Purpose

Thin abstraction over the container runtime binary (Docker). All
runtime-specific CLI logic lives here so swapping runtimes means changing one
file. Also handles startup verification and orphan cleanup.

---

## Imports

```typescript
import { execSync } from 'child_process';
import os from 'os';
import { logger } from './logger.js';
```

No other imports.

---

## Exports

### `CONTAINER_RUNTIME_BIN: string` (exported constant)

```typescript
export const CONTAINER_RUNTIME_BIN = 'docker';
```

---

### `hostGatewayArgs(): string[]`

Returns CLI arguments needed for a container to resolve `host.docker.internal`.

**Behaviour:**
- On Linux (`os.platform() === 'linux'`):
  return `['--add-host=host.docker.internal:host-gateway']`
- On all other platforms: return `[]`

---

### `readonlyMountArgs(hostPath: string, containerPath: string): string[]`

Returns Docker CLI arguments for a readonly bind mount.

**Return value:** `['-v', `${hostPath}:${containerPath}:ro`]`

---

### `stopContainer(name: string): void`

Stops a running container by name.

**Behaviour:**
1. Validate `name` against the pattern `/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/`.
   If the name does not match, throw:
   ```
   new Error(`Invalid container name: ${name}`)
   ```
2. Run `execSync(`${CONTAINER_RUNTIME_BIN} stop -t 1 ${name}`, { stdio: 'pipe' })`.

**Note:** Use `execSync` (not `execFileSync`). The container name is validated
before interpolation — that validation is the injection guard.

---

### `ensureContainerRuntimeRunning(): void`

Checks that the container runtime is reachable and starts it if needed.

**Behaviour:**
1. Run `execSync(`${CONTAINER_RUNTIME_BIN} info`, { stdio: 'pipe', timeout: 10000 })`.
2. If successful, log at `debug` level: `'Container runtime already running'`.
3. If `execSync` throws:
   a. Log at `error` level with `{ err }` and message
      `'Failed to reach container runtime'`.
   b. Print a formatted box to `console.error` (see below).
   c. Throw:
      ```
      new Error('Container runtime is required but failed to start', { cause: err })
      ```

**Console error box (exact content):**
```
╔════════════════════════════════════════════════════════════════╗
║  FATAL: Container runtime failed to start                      ║
║                                                                ║
║  Agents cannot run without a container runtime. To fix:        ║
║  1. Ensure Docker is installed and running                     ║
║  2. Run: docker info                                           ║
║  3. Restart OpenGolem                                           ║
╚════════════════════════════════════════════════════════════════╝
```

Print each line as a separate `console.error` call with `\n` prefix on the
opening line and `\n` suffix on the closing line.

---

### `cleanupOrphans(): void`

Kills any OpenGolem containers left over from a previous process run.

**Behaviour:**
1. Run:
   ```
   execSync(
     `${CONTAINER_RUNTIME_BIN} ps --filter name=opengolem- --format '{{.Names}}'`,
     { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' }
   )
   ```
2. Parse the output: `output.trim().split('\n').filter(Boolean)`.
3. For each orphan name, call `stopContainer(name)`. Catch and swallow any
   error from `stopContainer` (container may already be stopped).
4. If any orphans were found, log at `info` level:
   `{ count: orphans.length, names: orphans }`, `'Stopped orphaned containers'`.
5. If the outer `execSync` call throws, log at `warn` level:
   `{ err }`, `'Failed to clean up orphaned containers'` — do not rethrow.

---

## What NOT to do

- Do not use `exec` (async) or `spawn` — use `execSync` only.
- Do not add a `Podman` or multi-runtime abstraction — a single binary name
  constant is sufficient.
- Do not retry or backoff on failure in any function.
- Do not import `fs`, `path`, or any other module beyond the list above.
