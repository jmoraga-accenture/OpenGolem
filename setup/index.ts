/**
 * Setup CLI entry point.
 *
 * Default: run all steps in order (full setup).
 * Single step: npx tsx setup/index.ts --step <name> [args...]
 */
import { execSync } from 'child_process';
import fs from 'fs';

import { MOUNT_ALLOWLIST_PATH } from '../src/config.js';
import { logger } from '../src/logger.js';
import { emitStatus } from './status.js';
import { commandExists } from './platform.js';

const STEPS: Record<
  string,
  () => Promise<{ run: (args: string[]) => Promise<void> }>
> = {
  timezone: () => import('./timezone.js'),
  environment: () => import('./environment.js'),
  container: () => import('./container.js'),
  groups: () => import('./groups.js'),
  register: () => import('./register.js'),
  mounts: () => import('./mounts.js'),
  service: () => import('./service.js'),
  verify: () => import('./verify.js'),
};

const STEP_BLURB: Record<string, string> = {
  timezone: 'Persist IANA timezone for scheduling',
  environment: 'Detect OS, Node, container runtimes, existing .env / auth',
  container: 'Build or validate agent container image',
  groups: 'Sync WhatsApp group metadata when configured; otherwise skip',
  register: 'Register agent groups in the database',
  mounts: 'Configure mount allowlists for containers',
  service: 'Install or describe systemd / launchd service',
  verify: 'End-to-end health check',
};

const STEP_ORDER = [
  'timezone',
  'environment',
  'container',
  'groups',
  'register',
  'mounts',
  'service',
  'verify',
] as const;

function mountAllowlistPath(): string {
  return MOUNT_ALLOWLIST_PATH;
}

function detectContainerRuntime(): 'docker' | 'apple-container' | null {
  if (commandExists('docker')) {
    try {
      execSync('docker info', { stdio: 'ignore' });
      return 'docker';
    } catch {
      // Docker CLI present but engine not reachable
    }
  }
  if (commandExists('container')) {
    return 'apple-container';
  }
  return null;
}

/** When set, full setup runs register with these (see printSetupHelp). */
function registerArgsFromEnv(): string[] | null {
  const jid = process.env.OPENGOLEM_REGISTER_JID?.trim();
  const name = process.env.OPENGOLEM_REGISTER_NAME?.trim();
  const trigger = process.env.OPENGOLEM_REGISTER_TRIGGER?.trim();
  const folder = process.env.OPENGOLEM_REGISTER_FOLDER?.trim();
  if (!jid || !name || !trigger || !folder) {
    return null;
  }
  const out = [
    '--jid',
    jid,
    '--name',
    name,
    '--trigger',
    trigger,
    '--folder',
    folder,
  ];
  const channel = process.env.OPENGOLEM_REGISTER_CHANNEL?.trim();
  if (channel) {
    out.push('--channel', channel);
  }
  const assistant = process.env.OPENGOLEM_REGISTER_ASSISTANT_NAME?.trim();
  if (assistant) {
    out.push('--assistant-name', assistant);
  }
  if (process.env.OPENGOLEM_REGISTER_IS_MAIN === '1') {
    out.push('--is-main');
  }
  if (process.env.OPENGOLEM_REGISTER_NO_TRIGGER_REQUIRED === '1') {
    out.push('--no-trigger-required');
  }
  return out;
}

function parseGlobalSetupArgs(args: string[]): {
  runtime?: string;
  skipped: Set<string>;
} {
  const skipped = new Set<string>();
  let runtime: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--runtime' && args[i + 1]) {
      runtime = args[++i];
      continue;
    }
    if (typeof a === 'string' && a.startsWith('--skip-')) {
      const step = a.slice('--skip-'.length);
      if (step && STEPS[step]) {
        skipped.add(step);
      }
    }
  }
  return { runtime, skipped };
}

function printSetupHelp(): void {
  const names = Object.keys(STEPS).join('|');
  console.error(`
OpenGolem setup — default is a full run of all steps in order.

  npm run setup

Optional flags (full run only):

  --runtime docker|apple-container   force container runtime (else auto-detect)
  --skip-<step>                      skip one step (${names})

Register is skipped unless these env vars are all set:

  OPENGOLEM_REGISTER_JID
  OPENGOLEM_REGISTER_NAME
  OPENGOLEM_REGISTER_TRIGGER
  OPENGOLEM_REGISTER_FOLDER

Optional: OPENGOLEM_REGISTER_CHANNEL, OPENGOLEM_REGISTER_ASSISTANT_NAME,
OPENGOLEM_REGISTER_IS_MAIN=1, OPENGOLEM_REGISTER_NO_TRIGGER_REQUIRED=1

Single step (note the "--" through npm):

  npm run setup -- --step <${names}> [args...]

Typical order:
  ${STEP_ORDER.join(' → ')}

Steps:
${STEP_ORDER.map((s) => `  ${s.padEnd(12)} — ${STEP_BLURB[s] ?? ''}`).join('\n')}
`);
  console.error(
    `Short form: npx tsx setup/index.ts --step <${names}> [args...]`,
  );
}

async function runStep(stepName: string, stepArgs: string[]): Promise<void> {
  const loader = STEPS[stepName];
  if (!loader) {
    console.error(`Unknown step: ${stepName}`);
    process.exit(1);
  }
  const mod = await loader();
  await mod.run(stepArgs);
}

async function runFullSetup(args: string[]): Promise<void> {
  const { runtime: runtimeFlag, skipped } = parseGlobalSetupArgs(args);

  console.error('\n=== OpenGolem setup (full run) ===\n');

  for (const step of STEP_ORDER) {
    if (skipped.has(step)) {
      console.error(`— Skipping ${step} (--skip-${step})\n`);
      continue;
    }

    let stepArgs: string[] = [];

    if (step === 'container') {
      const rt =
        runtimeFlag && ['docker', 'apple-container'].includes(runtimeFlag)
          ? runtimeFlag
          : detectContainerRuntime();
      if (!rt) {
        console.error(
          '— Skipping container (no running Docker and no Apple "container" CLI; install one or use --runtime docker)\n',
        );
        continue;
      }
      stepArgs = ['--runtime', rt];
    }

    if (step === 'register') {
      const ra = registerArgsFromEnv();
      if (!ra) {
        console.error(
          '— Skipping register (set OPENGOLEM_REGISTER_JID, _NAME, _TRIGGER, _FOLDER or run: npm run setup -- --step register ...)\n',
        );
        continue;
      }
      stepArgs = ra;
    }

    if (step === 'mounts') {
      if (!fs.existsSync(mountAllowlistPath())) {
        stepArgs = ['--empty'];
      }
    }

    const argHint = stepArgs.length ? ` ${stepArgs.join(' ')}` : '';
    console.error(`▶ ${step}${argHint}\n`);

    try {
      await runStep(step, stepArgs);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, step }, 'Setup step failed');
      emitStatus(step.toUpperCase(), {
        STATUS: 'failed',
        ERROR: message,
      });
      process.exit(1);
    }
  }

  console.error('\n=== Setup finished ===\n');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === '-h' || args[0] === '--help') {
    printSetupHelp();
    process.exit(0);
  }

  const stepIdx = args.indexOf('--step');

  if (stepIdx !== -1) {
    if (!args[stepIdx + 1]) {
      console.error('Error: --step requires a step name\n');
      printSetupHelp();
      process.exit(1);
    }
    const stepName = args[stepIdx + 1];
    const stepArgs = args.filter(
      (a, i) => i !== stepIdx && i !== stepIdx + 1 && a !== '--',
    );

    if (!STEPS[stepName]) {
      console.error(`Unknown step: ${stepName}`);
      console.error(`Available steps: ${Object.keys(STEPS).join(', ')}`);
      process.exit(1);
    }

    try {
      await runStep(stepName, stepArgs);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, step: stepName }, 'Setup step failed');
      emitStatus(stepName.toUpperCase(), {
        STATUS: 'failed',
        ERROR: message,
      });
      process.exit(1);
    }
    return;
  }

  try {
    await runFullSetup(args);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err }, 'Full setup failed');
    process.exit(1);
  }
}

main();
