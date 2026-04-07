/**
 * Setup step: build the container image and verify with a test run.
 */
import { execSync } from 'child_process';
import path from 'path';

import { CONTAINER_IMAGE } from '../src/config.js';
import { logger } from '../src/logger.js';
import { commandExists } from './platform.js';
import { emitStatus } from './status.js';

const projectRoot = process.cwd();
const containerDir = path.join(projectRoot, 'container');

export async function run(args: string[]): Promise<void> {
  const runtimeIdx = args.indexOf('--runtime');
  const runtime =
    runtimeIdx !== -1 && args[runtimeIdx + 1]
      ? args[runtimeIdx + 1]
      : undefined;

  if (!runtime) {
    emitStatus('SETUP_CONTAINER', {
      STATUS: 'failed',
      ERROR: 'missing_runtime_flag',
    });
    process.exit(4);
  }

  // Validate runtime availability
  if (runtime === 'apple-container' && !commandExists('container')) {
    emitStatus('SETUP_CONTAINER', {
      RUNTIME: runtime,
      IMAGE: CONTAINER_IMAGE,
      BUILD_OK: false,
      STATUS: 'failed',
      ERROR: 'apple_container_not_found',
    });
    process.exit(1);
  }

  if (runtime === 'docker' && !commandExists('docker')) {
    emitStatus('SETUP_CONTAINER', {
      RUNTIME: runtime,
      IMAGE: CONTAINER_IMAGE,
      BUILD_OK: false,
      STATUS: 'failed',
      ERROR: 'docker_not_found',
    });
    process.exit(1);
  }

  // Build image
  let BUILD_OK = false;
  try {
    execSync(`${runtime} build -t ${CONTAINER_IMAGE} .`, {
      cwd: containerDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    BUILD_OK = true;
    logger.info({ runtime, image: CONTAINER_IMAGE }, 'container build succeeded');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err }, 'container build failed');
    emitStatus('SETUP_CONTAINER', {
      RUNTIME: runtime,
      IMAGE: CONTAINER_IMAGE,
      BUILD_OK: false,
      STATUS: 'failed',
      ERROR: message,
    });
    process.exit(1);
  }

  // Test run
  let TEST_OK = false;
  try {
    execSync(`${runtime} run --rm ${CONTAINER_IMAGE} echo ok`, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    TEST_OK = true;
    logger.info({ runtime, image: CONTAINER_IMAGE }, 'container test run passed');
  } catch (err) {
    logger.warn({ err }, 'container test run failed');
  }

  emitStatus('SETUP_CONTAINER', {
    RUNTIME: runtime,
    IMAGE: CONTAINER_IMAGE,
    BUILD_OK,
    TEST_OK,
    STATUS: TEST_OK ? 'success' : 'failed',
    LOG: 'logs/setup.log',
  });

  if (!TEST_OK) {
    process.exit(1);
  }
}
