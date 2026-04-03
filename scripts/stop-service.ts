/**
 * Stop the OpenGolem background service before running in dev mode.
 * Called automatically via the `predev` npm script.
 */
import { execFileSync, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { getServiceManager, isRoot } from '../setup/platform.js';

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const mgr = getServiceManager();

if (mgr === 'systemd') {
  const args = isRoot() ? [] : ['--user'];
  try {
    execFileSync('systemctl', [...args, 'stop', 'opengolem'], {
      stdio: 'ignore',
    });
    console.log('Stopped opengolem.service');
  } catch {
    // Already stopped — fine
  }
} else if (mgr === 'launchd') {
  const plistPath = path.join(
    process.env.HOME ?? '',
    'Library/LaunchAgents/com.opengolem.plist',
  );
  if (fs.existsSync(plistPath)) {
    try {
      execFileSync('launchctl', ['unload', plistPath], { stdio: 'ignore' });
      console.log('Unloaded com.opengolem launchd agent');
    } catch {
      // Already unloaded — fine
    }
  }
} else {
  // nohup/pid-file fallback
  const pidFile = path.join(projectRoot, 'opengolem.pid');
  if (fs.existsSync(pidFile)) {
    try {
      const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
      if (pid > 0) {
        process.kill(pid, 'SIGTERM');
        console.log(`Sent SIGTERM to pid ${pid}`);
      }
    } catch {
      // Process already gone
    }
  }
}

// Kill any leftover server processes (previous `npm run dev` or direct node invocation).
// Match only the specific entry-point patterns, not setup scripts.
for (const pattern of [
  `node.*${projectRoot}/dist/index.js`,
  `tsx.*${projectRoot}/src/index.ts`,
]) {
  try {
    execFileSync('pkill', ['-f', pattern], { stdio: 'ignore' });
  } catch {
    // No match — fine
  }
}
// Brief pause so killed processes release their ports
try { execSync('sleep 0.3', { stdio: 'ignore' }); } catch { /* ignore */ }
