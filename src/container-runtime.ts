import { execSync } from 'child_process';
import os from 'os';

import { logger } from './logger.js';

export const CONTAINER_RUNTIME_BIN = 'docker';

const CONTAINER_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

const FATAL_BOX_LINES = [
  '\n╔════════════════════════════════════════════════════════════════╗',
  '║  FATAL: Container runtime failed to start                      ║',
  '║                                                                ║',
  '║  Agents cannot run without a container runtime. To fix:        ║',
  '║  1. Ensure Docker is installed and running                     ║',
  '║  2. Run: docker info                                           ║',
  '║  3. Restart OpenGolem                                           ║',
  '╚════════════════════════════════════════════════════════════════╝\n',
] as const;

export function hostGatewayArgs(): string[] {
  if (os.platform() === 'linux') {
    return ['--add-host=host.docker.internal:host-gateway'];
  }
  return [];
}

export function readonlyMountArgs(
  hostPath: string,
  containerPath: string,
): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

export function stopContainer(name: string): void {
  if (!CONTAINER_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
  execSync(`${CONTAINER_RUNTIME_BIN} stop -t 1 ${name}`, {
    stdio: 'pipe',
  });
}

export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    logger.debug('Container runtime already running');
  } catch (err) {
    logger.error({ err }, 'Failed to reach container runtime');
    for (const line of FATAL_BOX_LINES) {
      console.error(line);
    }
    throw new Error('Container runtime is required but failed to start', {
      cause: err,
    });
  }
}

export function cleanupOrphans(): void {
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter name=opengolem- --format '{{.Names}}'`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    );
    const orphans = output.trim().split('\n').filter(Boolean);
    for (const name of orphans) {
      try {
        stopContainer(name);
      } catch {
        /* container may already be stopped */
      }
    }
    if (orphans.length > 0) {
      logger.info(
        { count: orphans.length, names: orphans },
        'Stopped orphaned containers',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}
