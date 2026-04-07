import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

interface RemoteControlSession {
  pid: number;
  url: string;
  startedBy: string;
  startedInChat: string;
  startedAt: string;
}

const STATE_FILE = path.join(DATA_DIR, 'remote-control.json');
const STDOUT_FILE = path.join(DATA_DIR, 'remote-control.stdout');
const STDERR_FILE = path.join(DATA_DIR, 'remote-control.stderr');

const URL_REGEX = /https:\/\/claude\.ai\/code\S+/;
const URL_WAIT_TIMEOUT_MS = 30_000;
const URL_POLL_INTERVAL_MS = 200;

let activeSession: RemoteControlSession | null = null;

export function restoreRemoteControl(): void {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const session = JSON.parse(raw) as RemoteControlSession;
    try {
      process.kill(session.pid, 0);
      activeSession = session;
      logger.info(
        { pid: session.pid, url: session.url },
        'remote-control: restored existing session',
      );
    } catch {
      fs.rmSync(STATE_FILE, { force: true });
      logger.info(
        { pid: session.pid },
        'remote-control: stale session cleared (process dead)',
      );
    }
  } catch {
    // No state file or parse error — nothing to restore
  }
}

export function getActiveSession(): RemoteControlSession | null {
  return activeSession;
}

export function _resetForTesting(): void {
  activeSession = null;
}

export function _getStateFilePath(): string {
  return STATE_FILE;
}

export async function startRemoteControl(
  sender: string,
  chatJid: string,
  cwd: string,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  // Return existing live session
  if (activeSession !== null) {
    try {
      process.kill(activeSession.pid, 0);
      return { ok: true, url: activeSession.url };
    } catch {
      // Process is dead — clear and proceed
      activeSession = null;
      fs.rmSync(STATE_FILE, { force: true });
    }
  }

  let stdoutFd: number;
  let stderrFd: number;

  try {
    stdoutFd = fs.openSync(STDOUT_FILE, 'w');
    stderrFd = fs.openSync(STDERR_FILE, 'w');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Failed to start: ${message}` };
  }

  let child;
  try {
    child = spawn('claude', ['remote-control', '--name', 'OpenGolem Remote'], {
      cwd,
      detached: true,
      stdio: ['pipe', stdoutFd, stderrFd],
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: process.env['HOME'] ?? '',
        TERM: process.env['TERM'] ?? '',
      },
    });
  } catch (err) {
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Failed to start: ${message}` };
  }

  fs.closeSync(stdoutFd);
  fs.closeSync(stderrFd);

  // Auto-accept the "Enable Remote Control?" prompt
  try {
    child.stdin?.write('y\n');
    child.stdin?.end();
  } catch {
    // Ignore — stdin may not be available
  }

  child.unref();

  const pid = child.pid!;

  // Poll stdout capture file for URL
  const url = await new Promise<string | null>((resolve) => {
    const deadline = Date.now() + URL_WAIT_TIMEOUT_MS;

    const poll = () => {
      if (Date.now() >= deadline) {
        resolve(null);
        return;
      }
      try {
        const content = fs.readFileSync(STDOUT_FILE, 'utf8');
        const match = URL_REGEX.exec(content);
        if (match) {
          resolve(match[0]);
          return;
        }
      } catch {
        // File not readable yet — keep polling
      }
      setTimeout(poll, URL_POLL_INTERVAL_MS);
    };

    setTimeout(poll, URL_POLL_INTERVAL_MS);
  });

  if (url === null) {
    // Kill the process
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // Already dead
      }
    }
    return { ok: false, error: 'Timed out waiting for Remote Control URL' };
  }

  const session: RemoteControlSession = {
    pid,
    url,
    startedBy: sender,
    startedInChat: chatJid,
    startedAt: new Date().toISOString(),
  };

  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(session, null, 2), 'utf8');
  } catch (err) {
    logger.warn({ err }, 'remote-control: failed to persist state');
  }

  activeSession = session;
  logger.info({ pid, url, sender }, 'remote-control: session started');
  return { ok: true, url };
}

export function stopRemoteControl():
  | { ok: true }
  | { ok: false; error: string } {
  if (activeSession === null) {
    return { ok: false, error: 'No active Remote Control session' };
  }

  const { pid } = activeSession;

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Already dead — that's fine
  }

  activeSession = null;
  fs.rmSync(STATE_FILE, { force: true });
  logger.info({ pid }, 'remote-control: session stopped');
  return { ok: true };
}
