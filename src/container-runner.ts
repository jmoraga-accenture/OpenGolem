import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { issueToken, revokeContainer } from './broker/client.js';
import {
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  EXTRA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  TIMEZONE,
} from './config.js';
import {
  detectAuthMode,
  getContainerProxyUrl,
} from './credential-proxy.js';
import {
  CONTAINER_RUNTIME_BIN,
  hostGatewayArgs,
  readonlyMountArgs,
  stopContainer,
} from './container-runtime.js';
import { assertValidGroupFolder, resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { validateAdditionalMounts } from './mount-security.js';
import type { RegisteredGroup } from './types.js';

/** Verbatim — must match `container/agent-runner/src/index.ts` (see SENTINEL.md). */
export const OUTPUT_START_MARKER = '---OPENGOLEM_OUTPUT_START---';
export const OUTPUT_END_MARKER = '---OPENGOLEM_OUTPUT_END---';

const STALE_SESSION_RE =
  /no conversation found|ENOENT.*\.jsonl|session.*not found/i;

const SETTINGS_JSON = `{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1",
    "CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD": "1",
    "CLAUDE_CODE_DISABLE_AUTO_MEMORY": "0"
  }
}`;

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
  soulMd?: string;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

export type TaskRow = {
  id: string;
  groupFolder: string;
  prompt: string;
  script?: string | null;
  schedule_type: string;
  schedule_value: string;
  status: string;
  next_run: string | null;
};

interface PreparedMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

function appendCapped(
  acc: { buf: string; truncated: boolean },
  chunk: string | Buffer,
  max: number,
): void {
  const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  const nextLen = acc.buf.length + s.length;
  if (nextLen <= max) {
    acc.buf += s;
    return;
  }
  if (!acc.truncated) {
    logger.warn(
      { max },
      'Container output exceeded CONTAINER_MAX_OUTPUT_SIZE; truncating',
    );
    acc.truncated = true;
  }
  const room = max - acc.buf.length;
  if (room > 0) acc.buf += s.slice(0, room);
}

function safeContainerFolderName(folder: string): string {
  return folder.replace(/[^a-zA-Z0-9-]+/g, '-');
}

function loadSoulMd(group: RegisteredGroup, input: ContainerInput): void {
  if (input.soulMd !== undefined) return;
  const soulPath = path.join(process.cwd(), 'SOUL.md');
  try {
    if (!fs.existsSync(soulPath)) return;
    const raw = fs.readFileSync(soulPath, 'utf8');
    if (!raw.trim()) return;
    const level = String(group.assertivenessLevel ?? 10);
    input.soulMd = raw.replaceAll('{{assertiveness_level}}', level);
  } catch (err) {
    logger.debug({ err }, 'SOUL.md not loaded');
  }
}

function prepareSessionLayout(
  groupFolder: string,
  projectRoot: string,
): {
  claudeDir: string;
  ipcDir: string;
  agentRunnerDest: string;
  skillsDestRoot: string;
  agentRunnerSrc: string;
  skillsSrcRoot: string;
} {
  const baseSession = path.join(DATA_DIR, 'sessions', groupFolder);
  const claudeDir = path.join(baseSession, '.claude');
  const ipcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  const agentRunnerDest = path.join(baseSession, 'agent-runner-src');
  const skillsDestRoot = path.join(claudeDir, 'skills');
  const agentRunnerSrc = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'src',
  );
  const skillsSrcRoot = path.join(projectRoot, 'container', 'skills');

  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(path.join(ipcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(ipcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(ipcDir, 'input'), { recursive: true });
  fs.mkdirSync(skillsDestRoot, { recursive: true });
  fs.mkdirSync(EXTRA_DIR, { recursive: true });

  const settingsPath = path.join(claudeDir, 'settings.json');
  if (!fs.existsSync(settingsPath)) {
    fs.writeFileSync(settingsPath, SETTINGS_JSON, 'utf8');
  }

  if (fs.existsSync(skillsSrcRoot)) {
    const entries = fs.readdirSync(skillsSrcRoot, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const name = ent.name;
      const from = path.join(skillsSrcRoot, name);
      const to = path.join(skillsDestRoot, name);
      fs.cpSync(from, to, { recursive: true, force: true });
    }
  }

  const srcIndex = path.join(agentRunnerSrc, 'index.ts');
  const destIndex = path.join(agentRunnerDest, 'index.ts');
  let needCopy =
    !fs.existsSync(agentRunnerDest) ||
    !fs.existsSync(destIndex) ||
    !fs.existsSync(srcIndex);
  if (!needCopy && fs.existsSync(srcIndex) && fs.existsSync(destIndex)) {
    const stSrc = fs.statSync(srcIndex);
    const stDest = fs.statSync(destIndex);
    if (stSrc.mtimeMs > stDest.mtimeMs) needCopy = true;
  }
  if (needCopy && fs.existsSync(agentRunnerSrc)) {
    fs.mkdirSync(agentRunnerDest, { recursive: true });
    fs.cpSync(agentRunnerSrc, agentRunnerDest, { recursive: true, force: true });
  }

  return {
    claudeDir,
    ipcDir,
    agentRunnerDest,
    skillsDestRoot,
    agentRunnerSrc,
    skillsSrcRoot,
  };
}

function buildMounts(
  group: RegisteredGroup,
  input: ContainerInput,
  layout: ReturnType<typeof prepareSessionLayout>,
): PreparedMount[] {
  const projectRoot = process.cwd();
  const groupDir = resolveGroupFolderPath(group.folder);
  const mounts: PreparedMount[] = [];

  if (input.isMain) {
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: true,
    });
    const envFile = path.join(projectRoot, '.env');
    if (fs.existsSync(envFile)) {
      mounts.push({
        hostPath: '/dev/null',
        containerPath: '/workspace/project/.env',
        readonly: true,
      });
    }
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });
  } else {
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: true,
      });
    }
  }

  mounts.push({
    hostPath: layout.claudeDir,
    containerPath: '/home/node/.claude',
    readonly: false,
  });
  mounts.push({
    hostPath: layout.ipcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });
  mounts.push({
    hostPath: layout.agentRunnerDest,
    containerPath: '/app/src',
    readonly: false,
  });
  mounts.push({
    hostPath: EXTRA_DIR,
    containerPath: '/workspace/extra',
    readonly: true,
  });

  const extra = group.containerConfig?.additionalMounts;
  if (extra?.length) {
    const validated = validateAdditionalMounts(
      extra,
      group.name,
      input.isMain,
    );
    for (const m of validated) {
      mounts.push({
        hostPath: m.hostPath,
        containerPath: m.containerPath,
        readonly: m.readonly,
      });
    }
  }

  return mounts;
}

function mountsToArgs(mounts: PreparedMount[]): string[] {
  const args: string[] = [];
  for (const m of mounts) {
    if (m.readonly) {
      args.push(...readonlyMountArgs(m.hostPath, m.containerPath));
    } else {
      args.push('-v', `${m.hostPath}:${m.containerPath}`);
    }
  }
  return args;
}

function parseMarkerPayload(jsonStr: string): ContainerOutput | null {
  const trimmed = jsonStr.trim();
  if (!trimmed) return null;
  try {
    const o = JSON.parse(trimmed) as Record<string, unknown>;
    const status = o.status === 'error' ? 'error' : 'success';
    const result =
      o.result === undefined || o.result === null
        ? null
        : String(o.result);
    const newSessionId =
      typeof o.newSessionId === 'string' ? o.newSessionId : undefined;
    const error =
      typeof o.error === 'string' ? o.error : undefined;
    return { status, result, newSessionId, error };
  } catch {
    return null;
  }
}

/** Extracts every complete START…END segment; `rest` holds an optional trailing incomplete segment. */
function drainMarkerPairs(buffer: string): {
  outputs: ContainerOutput[];
  rest: string;
} {
  const outputs: ContainerOutput[] = [];
  let i = 0;
  while (true) {
    const start = buffer.indexOf(OUTPUT_START_MARKER, i);
    if (start === -1) {
      return { outputs, rest: buffer.slice(i) };
    }
    const afterStart = start + OUTPUT_START_MARKER.length;
    const end = buffer.indexOf(OUTPUT_END_MARKER, afterStart);
    if (end === -1) {
      return { outputs, rest: buffer.slice(start) };
    }
    const jsonStr = buffer.slice(afterStart, end).trim();
    const parsed = parseMarkerPayload(jsonStr);
    if (parsed) outputs.push(parsed);
    i = end + OUTPUT_END_MARKER.length;
  }
}

function processStdoutBuffer(
  parseBuf: { value: string },
  chunk: string,
  max: number,
  onPairs: (pairs: ContainerOutput[]) => void,
): void {
  parseBuf.value += chunk;
  if (parseBuf.value.length > max) {
    parseBuf.value = parseBuf.value.slice(-max);
  }
  const { outputs, rest } = drainMarkerPairs(parseBuf.value);
  if (outputs.length) onPairs(outputs);
  parseBuf.value = rest;
}

function lastPairFromStdout(full: string): ContainerOutput | null {
  const { outputs } = drainMarkerPairs(full);
  const last = outputs.at(-1);
  return last ?? null;
}

function legacyResolve(fullStdout: string): ContainerOutput {
  const parsed = lastPairFromStdout(fullStdout);
  if (parsed) return parsed;
  const lines = fullStdout.split(/\r?\n/).filter((l) => l.trim());
  const lastLine = lines.length ? lines[lines.length - 1].trim() : '';
  if (lastLine) {
    const tryParse = parseMarkerPayload(lastLine);
    if (tryParse) return tryParse;
    return { status: 'success', result: lastLine };
  }
  return {
    status: 'error',
    result: null,
    error: 'No container output',
  };
}

function textLooksStale(s: string | null | undefined): boolean {
  if (!s) return false;
  return STALE_SESSION_RE.test(s);
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  assertValidGroupFolder(group.folder);
  const projectRoot = process.cwd();
  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  const inputPayload = { ...input };
  loadSoulMd(group, inputPayload);

  const layout = prepareSessionLayout(group.folder, projectRoot);
  const mounts = buildMounts(group, inputPayload, layout);

  const ts = Date.now();
  const containerName = `opengolem-${safeContainerFolderName(group.folder)}-${ts}`;

  const baseTimeout = group.containerConfig?.timeout ?? CONTAINER_TIMEOUT;
  const effectiveTimeout = Math.max(baseTimeout, IDLE_TIMEOUT + 30_000);

  let brokerToken: string | undefined;
  const issueOpts = {
    containerId: containerName,
    skills: [] as string[],
    scopes: [] as string[],
    ttlSeconds: 3600,
    budget: 100,
  };
  if (process.env.VITEST) {
    void issueToken(issueOpts).catch((err) => {
      logger.warn(
        { err },
        'Token broker issueToken failed; continuing without broker token',
      );
    });
  } else {
    try {
      brokerToken = await issueToken(issueOpts);
    } catch (err) {
      logger.warn(
        { err },
        'Token broker issueToken failed; continuing without broker token',
      );
    }
  }

  const proxyUrl = getContainerProxyUrl(CREDENTIAL_PROXY_PORT);
  const authMode = detectAuthMode();

  const runArgs: string[] = [
    'run',
    '-i',
    '--rm',
    '--name',
    containerName,
    '-e',
    `TZ=${TIMEZONE}`,
    '-e',
    'NO_UPDATE_NOTIFIER=1',
    '-e',
    `ANTHROPIC_BASE_URL=${proxyUrl}`,
  ];
  if (authMode === 'api-key') {
    runArgs.push('-e', 'ANTHROPIC_API_KEY=proxied');
  } else {
    runArgs.push('-e', 'CLAUDE_CODE_OAUTH_TOKEN=proxied');
  }
  if (brokerToken) {
    runArgs.push('-e', `OPENGOLEM_BROKER_TOKEN=${brokerToken}`);
  }
  runArgs.push(...hostGatewayArgs());

  const { uid, gid } = os.userInfo();
  const hostUid = typeof uid === 'number' ? uid : null;
  if (hostUid !== null && hostUid !== 0 && hostUid !== 1000) {
    runArgs.push('--user', `${hostUid}:${gid}`);
    runArgs.push('-e', 'HOME=/home/node');
  }

  runArgs.push(...mountsToArgs(mounts));
  runArgs.push(CONTAINER_IMAGE);

  const startMs = Date.now();
  let proc: ChildProcess;
  try {
    proc = spawn(CONTAINER_RUNTIME_BIN, runArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      status: 'error',
      result: null,
      error: `Container spawn error: ${msg}`,
    };
  }

  onProcess(proc, containerName);

  const stdoutAcc = { buf: '', truncated: false };
  const stderrAcc = { buf: '', truncated: false };
  const parseBuf = { value: '' };

  let hardTimer: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  let hadStreamingOutput = false;
  let staleSessionDetected = false;
  let lastNewSessionId: string | undefined;
  let outputChain: Promise<void> = Promise.resolve();
  let exitCode: number | null = null;
  let settled = false;

  const logVerbose =
    process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

  function writeRunLog(
    code: number | null,
    errMsg?: string,
  ): void {
    const duration = Date.now() - startMs;
    const logName = `container-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
    const logPath = path.join(groupDir, 'logs', logName);
    const lines: string[] = [];
    lines.push(`timestamp=${new Date().toISOString()}`);
    lines.push(`group=${group.name}`);
    lines.push(`isMain=${inputPayload.isMain}`);
    lines.push(`durationMs=${duration}`);
    lines.push(`exitCode=${code ?? 'null'}`);
    lines.push(`stdoutTruncated=${stdoutAcc.truncated}`);
    lines.push(`stderrTruncated=${stderrAcc.truncated}`);
    lines.push(`timedOut=${timedOut}`);
    if (errMsg) lines.push(`error=${errMsg}`);

    const isErr = errMsg != null || (code !== null && code !== 0) || timedOut;
    if (isErr || logVerbose) {
      lines.push(`promptLength=${inputPayload.prompt.length}`);
      lines.push(`sessionId=${inputPayload.sessionId ?? ''}`);
      lines.push(`containerArgs=${JSON.stringify(runArgs)}`);
      lines.push(
        `mountsContainerPaths=${JSON.stringify(mounts.map((m) => m.containerPath))}`,
      );
      lines.push(`stderr=\n${stderrAcc.buf}`);
      lines.push(`stdout=\n${stdoutAcc.buf}`);
    } else {
      lines.push(`sessionId=${inputPayload.sessionId ?? ''}`);
      lines.push(
        `mountsContainerPaths=${JSON.stringify(mounts.map((m) => m.containerPath))}`,
      );
    }

    try {
      fs.writeFileSync(logPath, lines.join('\n'), 'utf8');
    } catch (err) {
      logger.warn({ err, logPath }, 'Failed to write container log file');
    }
  }

  function markStaleFromOutput(o: ContainerOutput): void {
    if (
      textLooksStale(o.error) ||
      textLooksStale(o.result)
    ) {
      staleSessionDetected = true;
    }
  }

  function applyParsedOutputs(pairs: ContainerOutput[]): void {
    for (const parsed of pairs) {
      markStaleFromOutput(parsed);
      hadStreamingOutput = true;
      if (parsed.newSessionId) lastNewSessionId = parsed.newSessionId;
      if (onOutput) {
        outputChain = outputChain.then(() => onOutput(parsed));
      }
      scheduleHardTimeout();
    }
  }

  function scheduleHardTimeout(): void {
    if (hardTimer) clearTimeout(hardTimer);
    hardTimer = setTimeout(() => {
      timedOut = true;
      try {
        stopContainer(containerName);
      } catch (err) {
        logger.debug({ err }, 'stopContainer failed; sending SIGKILL to process');
        try {
          proc.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }
    }, effectiveTimeout);
  }

  scheduleHardTimeout();

  proc.stdout?.on('data', (chunk: Buffer) => {
    appendCapped(stdoutAcc, chunk, CONTAINER_MAX_OUTPUT_SIZE);
    const s = chunk.toString('utf8');
    if (onOutput) {
      processStdoutBuffer(
        parseBuf,
        s,
        CONTAINER_MAX_OUTPUT_SIZE,
        applyParsedOutputs,
      );
    }
  });

  proc.stderr?.on('data', (chunk: Buffer) => {
    appendCapped(stderrAcc, chunk, CONTAINER_MAX_OUTPUT_SIZE);
    const text = chunk.toString('utf8');
    for (const line of text.split(/\r?\n/)) {
      if (line.length) logger.debug({ stderr: line }, 'container stderr');
    }
  });

  proc.stdin?.write(JSON.stringify(inputPayload), (err) => {
    if (err) logger.debug({ err }, 'stdin write error');
  });
  proc.stdin?.end();

  return new Promise((resolve) => {
    const finish = (out: ContainerOutput) => {
      if (settled) return;
      settled = true;
      if (hardTimer) clearTimeout(hardTimer);
      void revokeContainer(containerName).catch(() => {});
      resolve(out);
    };

    proc.on('error', (err) => {
      writeRunLog(null, err.message);
      finish({
        status: 'error',
        result: null,
        error: `Container spawn error: ${err.message}`,
      });
    });

    proc.on('close', (code) => {
      exitCode = code;
      if (hardTimer) clearTimeout(hardTimer);

      const finalize = async () => {
        if (onOutput) {
          await outputChain;
        }

        if (timedOut) {
          if (hadStreamingOutput) {
            writeRunLog(exitCode);
            finish({
              status: 'success',
              result: null,
              newSessionId: lastNewSessionId,
            });
            return;
          }
          const errText = `Container timed out after ${effectiveTimeout}ms`;
          writeRunLog(exitCode, errText);
          finish({
            status: 'error',
            result: null,
            error: errText,
          });
          return;
        }

        if (exitCode !== 0) {
          const staleFromLog =
            staleSessionDetected || textLooksStale(stdoutAcc.buf);
          const errMsg = staleFromLog
            ? 'No conversation found — stale session cleared'
            : `Container exited with code ${exitCode}`;
          writeRunLog(exitCode, errMsg);
          finish({
            status: 'error',
            result: null,
            error: errMsg,
          });
          return;
        }

        if (onOutput) {
          writeRunLog(exitCode);
          finish({
            status: 'success',
            result: null,
            newSessionId: lastNewSessionId,
          });
          return;
        }

        const legacy = legacyResolve(stdoutAcc.buf);
        markStaleFromOutput(legacy);
        if (legacy.status === 'error' && staleSessionDetected) {
          writeRunLog(exitCode, 'No conversation found — stale session cleared');
          finish({
            status: 'error',
            result: null,
            error: 'No conversation found — stale session cleared',
          });
          return;
        }
        writeRunLog(exitCode);
        finish(legacy);
      };

      void finalize().catch((err) => {
        writeRunLog(exitCode, String(err));
        finish({
          status: 'error',
          result: null,
          error: String(err),
        });
      });
    });
  });
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: TaskRow[],
): void {
  assertValidGroupFolder(groupFolder);
  const dir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(dir, { recursive: true });
  const rows = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);
  fs.writeFileSync(
    path.join(dir, 'current_tasks.json'),
    JSON.stringify(rows, null, 2),
    'utf8',
  );
}

export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  registeredJids: Set<string>,
): void {
  assertValidGroupFolder(groupFolder);
  const dir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(dir, { recursive: true });
  const list = isMain
    ? groups.map((g) => ({
        ...g,
        isRegistered: registeredJids.has(g.jid),
      }))
    : [];
  const payload = {
    groups: list,
    lastSync: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(dir, 'available_groups.json'),
    JSON.stringify(payload, null, 2),
    'utf8',
  );
}
