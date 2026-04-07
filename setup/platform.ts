/**
 * Cross-platform OS detection utilities for the OpenGolem setup wizard.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';

export type Platform = 'macos' | 'linux' | 'unknown';
export type ServiceManager = 'launchd' | 'systemd' | 'none';

export function getPlatform(): Platform {
  const platform = os.platform();
  if (platform === 'darwin') return 'macos';
  if (platform === 'linux') return 'linux';
  return 'unknown';
}

export function isWSL(): boolean {
  if (os.platform() !== 'linux') return false;
  try {
    const content = fs.readFileSync('/proc/version', 'utf-8').toLowerCase();
    return content.includes('microsoft') || content.includes('wsl');
  } catch {
    return false;
  }
}

export function isRoot(): boolean {
  return process.getuid?.() === 0;
}

export function isHeadless(): boolean {
  if (getPlatform() === 'linux') {
    return !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
  }
  return false;
}

export function hasSystemd(): boolean {
  if (getPlatform() !== 'linux') return false;
  try {
    const comm = fs.readFileSync('/proc/1/comm', 'utf-8').trim();
    return comm === 'systemd';
  } catch {
    return false;
  }
}

export function commandExists(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function openBrowser(url: string): boolean {
  const platform = getPlatform();
  if (platform === 'macos') {
    try {
      execSync(`open ${JSON.stringify(url)}`, { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }
  if (platform === 'linux') {
    for (const browser of ['xdg-open', 'sensible-browser', 'x-www-browser']) {
      if (commandExists(browser)) {
        try {
          execSync(`${browser} ${JSON.stringify(url)}`, { stdio: 'ignore' });
          return true;
        } catch {
          // try next
        }
      }
    }
    return false;
  }
  return false;
}

export function getServiceManager(): ServiceManager {
  const platform = getPlatform();
  if (platform === 'macos') return 'launchd';
  if (platform === 'linux') {
    if (hasSystemd()) return 'systemd';
  }
  return 'none';
}

export function getNodeVersion(): string | null {
  try {
    const version = execSync('node --version', { encoding: 'utf-8' }).trim();
    return version.replace(/^v/, '');
  } catch {
    return null;
  }
}

export function getNodeMajorVersion(): number | null {
  const version = getNodeVersion();
  if (!version) return null;
  const major = parseInt(version.split('.')[0], 10);
  return isNaN(major) ? null : major;
}
