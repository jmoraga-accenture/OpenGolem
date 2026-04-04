import fs from 'fs';
import os from 'os';
import path from 'path';

import { MOUNT_ALLOWLIST_PATH } from './config.js';
import { logger } from './logger.js';
import type { AdditionalMount, AllowedRoot, MountAllowlist } from './types.js';

export interface MountValidationResult {
  allowed: boolean;
  reason: string;
  realHostPath?: string;
  resolvedContainerPath?: string;
  effectiveReadonly?: boolean;
}

const DEFAULT_BLOCKED_PATTERNS = [
  '.ssh',
  '.gnupg',
  '.gpg',
  '.aws',
  '.azure',
  '.gcloud',
  '.kube',
  '.docker',
  'credentials',
  '.env',
  '.netrc',
  '.npmrc',
  '.pypirc',
  'id_rsa',
  'id_ed25519',
  'private_key',
  '.secret',
] as const;

let cachedAllowlist: MountAllowlist | null = null;
let allowlistLoadError: string | null = null;

function expandPath(p: string): string {
  const homeDir = process.env.HOME || os.homedir();
  if (p.startsWith('~/')) {
    return path.join(homeDir, p.slice(2));
  }
  if (p === '~') {
    return homeDir;
  }
  return path.resolve(p);
}

function getRealPath(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

function matchesBlockedPattern(
  realPath: string,
  blockedPatterns: string[],
): string | null {
  const parts = realPath.split(path.sep);
  for (const pattern of blockedPatterns) {
    for (const part of parts) {
      if (part === pattern || part.includes(pattern)) {
        return pattern;
      }
    }
    if (realPath.includes(pattern)) {
      return pattern;
    }
  }
  return null;
}

function findAllowedRoot(
  realPath: string,
  allowedRoots: AllowedRoot[],
): AllowedRoot | null {
  for (const root of allowedRoots) {
    const expandedRoot = expandPath(root.path);
    const realRoot = getRealPath(expandedRoot);
    if (realRoot === null) {
      continue;
    }
    const rel = path.relative(realRoot, realPath);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
      return root;
    }
  }
  return null;
}

function isValidContainerPath(containerPath: string): boolean {
  const t = containerPath.trim();
  if (t === '') {
    return false;
  }
  if (containerPath.includes('..')) {
    return false;
  }
  if (containerPath.startsWith('/')) {
    return false;
  }
  if (containerPath.includes(':')) {
    return false;
  }
  return true;
}

function mergeBlockedPatterns(userPatterns: string[]): string[] {
  return [...new Set([...userPatterns, ...DEFAULT_BLOCKED_PATTERNS])];
}

function parseAndValidateAllowlist(raw: string): MountAllowlist {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Invalid JSON: ${msg}`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Allowlist must be a JSON object');
  }
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.allowedRoots)) {
    throw new Error('allowedRoots must be an array');
  }
  if (!Array.isArray(obj.blockedPatterns)) {
    throw new Error('blockedPatterns must be an array');
  }
  if (typeof obj.nonMainReadOnly !== 'boolean') {
    throw new Error('nonMainReadOnly must be a boolean');
  }
  const allowlist: MountAllowlist = {
    allowedRoots: obj.allowedRoots as AllowedRoot[],
    blockedPatterns: obj.blockedPatterns as string[],
    nonMainReadOnly: obj.nonMainReadOnly,
  };
  allowlist.blockedPatterns = mergeBlockedPatterns(allowlist.blockedPatterns);
  return allowlist;
}

export function loadMountAllowlist(): MountAllowlist | null {
  if (cachedAllowlist !== null) {
    return cachedAllowlist;
  }
  if (allowlistLoadError !== null) {
    return null;
  }
  const filePath = MOUNT_ALLOWLIST_PATH;
  if (!fs.existsSync(filePath)) {
    logger.warn(
      { path: filePath },
      'Mount allowlist not found - additional mounts will be BLOCKED. Create the file to enable additional mounts.',
    );
    return null;
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const allowlist = parseAndValidateAllowlist(raw);
    cachedAllowlist = allowlist;
    logger.info(
      {
        path: filePath,
        allowedRoots: allowlist.allowedRoots.length,
        blockedPatterns: allowlist.blockedPatterns.length,
      },
      'Mount allowlist loaded successfully',
    );
    return cachedAllowlist;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    allowlistLoadError = message;
    logger.error(
      { path: filePath, error: allowlistLoadError },
      'Failed to load mount allowlist - additional mounts will be BLOCKED',
    );
    return null;
  }
}

export function validateMount(
  mount: AdditionalMount,
  isMain: boolean,
): MountValidationResult {
  const allowlist = loadMountAllowlist();
  if (allowlist === null) {
    return {
      allowed: false,
      reason: `No mount allowlist configured at ${MOUNT_ALLOWLIST_PATH}`,
    };
  }

  const containerPath =
    mount.containerPath !== undefined && mount.containerPath !== ''
      ? mount.containerPath
      : path.basename(mount.hostPath);

  if (!isValidContainerPath(containerPath)) {
    return {
      allowed: false,
      reason: `Invalid container path: "${containerPath}" - must be relative, non-empty, and not contain ".."`,
    };
  }

  const expandedPath = expandPath(mount.hostPath);
  const realPath = getRealPath(expandedPath);
  if (realPath === null) {
    return {
      allowed: false,
      reason: `Host path does not exist: "${mount.hostPath}" (expanded: "${expandedPath}")`,
    };
  }

  const blockedMatch = matchesBlockedPattern(
    realPath,
    allowlist.blockedPatterns,
  );
  if (blockedMatch !== null) {
    return {
      allowed: false,
      reason: `Path matches blocked pattern "${blockedMatch}": "${realPath}"`,
    };
  }

  const allowedRoot = findAllowedRoot(realPath, allowlist.allowedRoots);
  if (allowedRoot === null) {
    const expandedRoots = allowlist.allowedRoots
      .map((r) => expandPath(r.path))
      .join(', ');
    return {
      allowed: false,
      reason: `Path "${realPath}" is not under any allowed root. Allowed roots: ${expandedRoots}`,
    };
  }

  let effectiveReadonly = true;
  if (mount.readonly === false) {
    if (!isMain && allowlist.nonMainReadOnly) {
      logger.info(
        { mount: mount.hostPath },
        'Mount forced to read-only for non-main group',
      );
    } else if (!allowedRoot.allowReadWrite) {
      logger.info(
        { mount: mount.hostPath, root: allowedRoot.path },
        'Mount forced to read-only - root does not allow read-write',
      );
    } else {
      effectiveReadonly = false;
    }
  }

  const desc = allowedRoot.description ? ` (${allowedRoot.description})` : '';
  return {
    allowed: true,
    reason: `Allowed under root "${allowedRoot.path}"${desc}`,
    realHostPath: realPath,
    resolvedContainerPath: containerPath,
    effectiveReadonly,
  };
}

export function validateAdditionalMounts(
  mounts: AdditionalMount[],
  groupName: string,
  isMain: boolean,
): Array<{ hostPath: string; containerPath: string; readonly: boolean }> {
  const out: Array<{
    hostPath: string;
    containerPath: string;
    readonly: boolean;
  }> = [];
  for (const mount of mounts) {
    const result = validateMount(mount, isMain);
    if (result.allowed) {
      const containerFull = `/workspace/extra/${result.resolvedContainerPath}`;
      logger.debug(
        {
          group: groupName,
          hostPath: result.realHostPath,
          containerPath: containerFull,
          readonly: result.effectiveReadonly,
          reason: result.reason,
        },
        'Mount validated successfully',
      );
      out.push({
        hostPath: result.realHostPath!,
        containerPath: containerFull,
        readonly: result.effectiveReadonly!,
      });
    } else {
      logger.warn(
        {
          group: groupName,
          requestedPath: mount.hostPath,
          containerPath: mount.containerPath,
          reason: result.reason,
        },
        'Additional mount REJECTED',
      );
    }
  }
  return out;
}

export function generateAllowlistTemplate(): string {
  const template: MountAllowlist = {
    allowedRoots: [
      {
        path: '~/projects',
        allowReadWrite: true,
        description: 'Development projects',
      },
      {
        path: '~/repos',
        allowReadWrite: true,
        description: 'Git repositories',
      },
      {
        path: '~/Documents/work',
        allowReadWrite: false,
        description: 'Work documents (read-only)',
      },
    ],
    blockedPatterns: ['password', 'secret', 'token'],
    nonMainReadOnly: true,
  };
  return `${JSON.stringify(template, null, 2)}\n`;
}
